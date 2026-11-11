/**
 * Backend integration tests. Every assertion runs against the real HTTP server,
 * the real SQLite database and a real fixture web server. Nothing is mocked.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { api, delay, multipart, startApp, startFixture, waitFor } from "./helpers.js";

let app;
let fixture;
let base;
let allowLocal = false;

before(async () => {
  app = await startApp();
  fixture = await startFixture();
  base = app.base;
});

after(async () => {
  try {
    await fixture?.stop();
  } finally {
    await app?.stop();
  }
});

async function setLocalAllowed(value) {
  const res = await api(base, "/api/settings", {
    method: "PUT",
    body: { settings: { network: { allowLocalhost: value } } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  allowLocal = value;
  return res.data.settings;
}

async function createDownload(url, extra = {}) {
  const res = await api(base, "/api/downloads", { method: "POST", body: { url, ...extra } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

async function getDownload(id) {
  const res = await api(base, `/api/downloads/${id}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

async function waitForStatus(id, statuses, timeout = 20_000) {
  return waitFor(
    async () => {
      const row = await getDownload(id);
      return statuses.includes(row.status) ? row : null;
    },
    { timeout, label: `download ${id} → ${statuses.join("/")}` },
  );
}

async function buildPdf(pages = 3) {
  const doc = await PDFDocument.create();
  doc.setTitle("Fixture PDF");
  doc.setAuthor("Test author");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage([420, 595]);
    page.drawText(`Page ${i} of the fixture PDF`, { x: 40, y: 540, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return Buffer.from(await doc.save());
}

async function buildEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture Book</dc:title>
    <dc:creator>Ada Fixture</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="id">urn:uuid:fixture-book</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="ch1.xhtml">First chapter</a></li><li><a href="ch2.xhtml">Second chapter</a></li></ol></nav></body></html>`,
  );
  zip.file(
    "OEBPS/ch1.xhtml",
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title><script>alert("xss")</script></head><body onload="alert(2)"><h1>First chapter</h1><p onclick="alert(3)">Sanitised <strong>body</strong> text.</p></body></html>`,
  );
  zip.file(
    "OEBPS/ch2.xhtml",
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Second chapter</h1><p>More text.</p></body></html>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

/* ------------------------------------------------------------------ */

test("health, system and settings endpoints answer with real data", async () => {
  const health = await api(base, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(typeof health.data.version, "string");

  const system = await api(base, "/api/system");
  assert.equal(system.status, 200);
  assert.ok(system.data.runtime?.node);
  assert.ok(system.data.paths?.data);
  assert.ok(system.data.paths.data.startsWith(app.dataDir));
  assert.ok(system.data.tools && "ffmpeg" in system.data.tools);
  assert.equal(typeof system.data.capabilities?.directHttp, "boolean");

  const settings = await api(base, "/api/settings");
  assert.equal(settings.status, 200);
  assert.equal(settings.data.settings.appearance.theme, "light");
  assert.equal(settings.data.settings.download.maxConcurrent, 3);
  assert.ok(settings.data.paths.downloadsDir);
  assert.ok(settings.data.paths.dataDir);

  const stats = await api(base, "/api/stats");
  assert.equal(stats.status, 200);
  assert.equal(stats.data.downloads.all, 0);
  assert.equal(typeof stats.data.studyTodaySeconds, "number");
});

test("SSRF guard blocks local hosts until explicitly enabled", async () => {
  const blocked = await api(base, "/api/probe", {
    method: "POST",
    body: { url: `${fixture.base}/file.bin` },
  });
  assert.equal(blocked.status, 400, JSON.stringify(blocked.data));
  assert.match(blocked.data.error, /local or private address/i);

  const settings = await setLocalAllowed(true);
  assert.equal(settings.network.allowLocalhost, true);

  const allowed = await api(base, "/api/probe", {
    method: "POST",
    body: { url: `${fixture.base}/file.bin` },
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  assert.equal(allowed.data.supported, true);
});

test("settings validate folders, clamp values, export, import and reset", async () => {
  const bad = await api(base, "/api/settings", {
    method: "PUT",
    body: { settings: { download: { directory: "/dev/null/not-a-folder" } } },
  });
  assert.equal(bad.status, 422);
  assert.match(bad.data.error, /download folder is not usable/i);

  const folder = path.join(app.dataDir, "custom-downloads");
  const saved = await api(base, "/api/settings", {
    method: "PUT",
    body: {
      settings: {
        appearance: { theme: "dark", accent: "blue", density: "compact", fontScale: 99 },
        download: { directory: folder, maxConcurrent: 42, filenameTemplate: "{title}.{ext}" },
        reader: { fontSize: 2 },
        playback: { defaultVolume: 4 },
      },
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const s = saved.data.settings;
  assert.equal(s.appearance.theme, "dark");
  assert.equal(s.appearance.accent, "blue");
  assert.equal(s.appearance.density, "compact");
  assert.equal(s.appearance.fontScale, 1.3);
  assert.equal(s.download.directory, folder);
  assert.equal(s.download.maxConcurrent, 8);
  assert.equal(s.reader.fontSize, 12);
  assert.equal(s.playback.defaultVolume, 1);
  const st = await fs.stat(folder);
  assert.equal(st.isDirectory(), true);

  const badCookies = await api(base, "/api/settings", {
    method: "PUT",
    body: { settings: { download: { cookiesFile: path.join(app.dataDir, "missing-cookies.txt") } } },
  });
  assert.equal(badCookies.status, 422);
  assert.match(badCookies.data.error, /cookies file is not readable/i);

  const cookiesPath = path.join(app.dataDir, "cookies.txt");
  await fs.writeFile(cookiesPath, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tTEST\t1\n");
  const savedCookies = await api(base, "/api/settings", {
    method: "PUT",
    body: { settings: { download: { cookiesFile: cookiesPath } } },
  });
  assert.equal(savedCookies.status, 200, JSON.stringify(savedCookies.data));
  assert.equal(savedCookies.data.settings.download.cookiesFile, cookiesPath);

  const exported = await api(base, "/api/settings/export");
  assert.equal(exported.status, 200);
  assert.equal(exported.data.settings.appearance.theme, "dark");
  assert.equal(exported.data.app, "OmniGet Desktop");

  const imported = await api(base, "/api/settings/import", {
    method: "POST",
    body: { settings: { appearance: { theme: "light", accent: "orange" }, study: { dailyGoalMinutes: 45 } } },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.equal(imported.data.settings.appearance.theme, "light");
  assert.equal(imported.data.settings.study.dailyGoalMinutes, 45);
  // Import merges over current settings rather than dropping unrelated values.
  assert.equal(imported.data.settings.download.maxConcurrent, 8);

  const reset = await api(base, "/api/settings/reset", { method: "POST" });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.settings.appearance.theme, "light");
  assert.equal(reset.data.settings.download.maxConcurrent, 3);
  assert.equal(reset.data.settings.download.cookiesFile, "");
  assert.equal(reset.data.settings.study.dailyGoalMinutes, 30);

  // Restore local access (reset disabled it) for the download tests.
  await setLocalAllowed(true);
});

test("probe detects direct files, redirects, HLS and errors", async () => {
  assert.equal(allowLocal, true);

  const direct = await api(base, "/api/probe", {
    method: "POST",
    body: { url: `${fixture.base}/file.bin` },
  });
  assert.equal(direct.status, 200);
  assert.equal(direct.data.engine, "http");
  assert.equal(direct.data.supported, true);
  assert.equal(direct.data.sizeBytes, fixture.bytes.length);
  assert.equal(direct.data.rangeSupported, true);
  assert.equal(direct.data.filename, "fixture file.bin");

  const redirect = await api(base, "/api/probe", {
    method: "POST",
    body: { url: `${fixture.base}/redirect` },
  });
  assert.equal(redirect.status, 200);
  assert.equal(redirect.data.supported, true);
  assert.ok(redirect.data.finalUrl.endsWith("/file.bin"));

  const hls = await api(base, "/api/probe", {
    method: "POST",
    body: { url: `${fixture.base}/hls/master.m3u8` },
  });
  assert.equal(hls.status, 200);
  assert.equal(hls.data.engine, "hls");
  assert.equal(hls.data.supported, true);
  assert.ok(hls.data.qualities.length >= 2);

  const missing = await api(base, "/api/probe", {
    method: "POST",
    body: { url: `${fixture.base}/missing` },
  });
  assert.equal(missing.status, 200);
  assert.equal(missing.data.supported, false);
  assert.match(missing.data.reason, /404/);

  const noUrl = await api(base, "/api/probe", { method: "POST", body: {} });
  assert.equal(noUrl.status, 400);

  const magnet = await api(base, "/api/probe", {
    method: "POST",
    body: { url: "magnet:?xt=urn:btih:deadbeef" },
  });
  assert.equal(magnet.status, 400);
  assert.equal(magnet.data.code, "UNSUPPORTED_SCHEME");
});

test("a direct download completes, writes the exact bytes and records history", async () => {
  const created = await createDownload(`${fixture.base}/file.bin?size=524288`, { title: "Fixture" });
  assert.equal(created.status === undefined || created.status === "queued" || created.status === "downloading" || created.status === "completed", true);
  const done = await waitForStatus(created.id, ["completed"]);
  assert.equal(done.downloadedBytes, fixture.bytes.length);
  assert.equal(done.sizeBytes, fixture.bytes.length);
  assert.equal(done.fileExists, true);
  assert.equal(done.actualSize, fixture.bytes.length);

  const file = await api(base, `/api/downloads/${created.id}/file?download=1`, { raw: true });
  assert.equal(file.status, 200);
  assert.equal(Buffer.compare(Buffer.from(file.data), fixture.bytes), 0);

  const logs = await api(base, `/api/downloads/${created.id}/logs`);
  assert.equal(logs.status, 200);
  assert.ok(logs.data.logs.length > 0);

  const outputs = await api(base, `/api/downloads/${created.id}/outputs`);
  assert.equal(outputs.status, 200);
  assert.ok(outputs.data.outputs.length >= 1);

  const history = await api(base, "/api/history");
  assert.equal(history.status, 200);
  assert.ok(history.data.downloads.some((d) => d.id === created.id));
  assert.ok(history.data.counts.completed >= 1);
});

test("pause stops real byte progress and resume finishes the same file", async () => {
  const created = await createDownload(`${fixture.base}/slow.bin`, { title: "Slow fixture" });

  const started = await waitFor(
    async () => {
      const row = await getDownload(created.id);
      return row.downloadedBytes > 0 && row.status === "downloading" ? row : null;
    },
    { label: "download progress" },
  );

  const paused = await api(base, `/api/downloads/${created.id}/pause`, { method: "POST" });
  assert.equal(paused.status, 200, JSON.stringify(paused.data));
  const pausedRow = await waitForStatus(created.id, ["paused"]);
  const frozenAt = pausedRow.downloadedBytes;
  assert.ok(frozenAt > 0, "some bytes should be on disk before pausing");
  assert.ok(frozenAt < fixture.slowBytes.length, "the file should not be complete yet");

  await delay(500);
  const stillPaused = await getDownload(created.id);
  assert.equal(stillPaused.status, "paused");
  assert.equal(stillPaused.downloadedBytes, frozenAt, "paused transfers must not keep writing");

  const resumed = await api(base, `/api/downloads/${created.id}/resume`, { method: "POST" });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  const finished = await waitForStatus(created.id, ["completed"], 25_000);
  assert.equal(finished.downloadedBytes, fixture.slowBytes.length);
  assert.equal(finished.actualSize, fixture.slowBytes.length);

  const file = await api(base, `/api/downloads/${created.id}/file`, { raw: true });
  assert.equal(Buffer.compare(Buffer.from(file.data), fixture.slowBytes), 0);
  assert.ok(
    fixture.requests.some((r) => r.path === "/slow.bin" && r.range && !r.range.startsWith("bytes=0-")),
    "resume should issue a Range request with a non-zero start",
  );
});

test("non-ASCII filenames are served with a safe content-disposition header", async () => {
  const created = await createDownload(`${fixture.base}/named.bin`, { title: "Café — notes" });
  const done = await waitForStatus(created.id, ["completed"]);
  assert.match(done.filename, /Café/);

  const file = await api(base, `/api/downloads/${created.id}/file`, { raw: true });
  assert.equal(file.status, 200);
  assert.equal(Buffer.compare(Buffer.from(file.data), fixture.bytes), 0);
  const disposition = file.headers.get("content-disposition") || "";
  assert.match(disposition, /^(?:inline|attachment); filename="[^"]+"/);
  assert.match(disposition, /filename\*=UTF-8''/);
  // The quoted legacy filename must stay printable ASCII.
  const quoted = /filename="([^"]+)"/.exec(disposition)?.[1] || "";
  assert.match(quoted, /^[\x20-\x7e]+$/, `legacy filename was not ASCII: ${quoted}`);
});

test("cancel stops a transfer and removes the partial file", async () => {
  const created = await createDownload(`${fixture.base}/slow.bin`, { title: "Cancel fixture" });
  await waitFor(
    async () => {
      const row = await getDownload(created.id);
      return row.downloadedBytes > 0 ? row : null;
    },
    { label: "bytes before cancel" },
  );

  const canceled = await api(base, `/api/downloads/${created.id}/cancel`, { method: "POST" });
  assert.equal(canceled.status, 200, JSON.stringify(canceled.data));
  const row = await waitForStatus(created.id, ["canceled"]);
  assert.equal(row.downloadedBytes, 0);
  if (row.partPath) {
    await assert.rejects(fs.stat(row.partPath));
  }
  if (row.filePath) {
    await assert.rejects(fs.stat(row.filePath));
  }
});

test("notes validate their target and support create, edit and delete", async () => {
  const list = await api(base, "/api/downloads");
  const target = list.data.downloads.find((d) => d.title === "Fixture");
  assert.ok(target, "the completed download should exist");

  const empty = await api(base, "/api/notes", {
    method: "POST",
    body: { targetType: "download", targetId: target.id, body: "   " },
  });
  assert.equal(empty.status, 400);

  const orphan = await api(base, "/api/notes", {
    method: "POST",
    body: { targetType: "download", targetId: "dl_missing", body: "hello" },
  });
  assert.equal(orphan.status, 404);

  const invalid = await api(base, "/api/notes", {
    method: "POST",
    body: { targetType: "nope", targetId: target.id, body: "hello" },
  });
  assert.equal(invalid.status, 400);

  const created = await api(base, "/api/notes", {
    method: "POST",
    body: { targetType: "download", targetId: target.id, body: "First note", page: 2 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.body, "First note");

  const edited = await api(base, `/api/notes/${created.data.id}`, {
    method: "PATCH",
    body: { body: "Edited note" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.body, "Edited note");
  assert.ok(edited.data.updatedAt >= created.data.createdAt);

  const all = await api(base, "/api/notes");
  assert.ok(all.data.notes.some((n) => n.id === created.data.id));

  const removed = await api(base, `/api/notes/${created.data.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const afterDelete = await api(base, `/api/notes/${created.data.id}`, { method: "DELETE" });
  assert.equal(afterDelete.status, 404);
});

test("PDF import, progress, bookmarks, notes and study time all persist", async () => {
  const pdf = await buildPdf(3);
  const imported = await api(base, "/api/books/import", {
    method: "POST",
    body: multipart({}, [{ field: "file", name: "fixture.pdf", type: "application/pdf", data: pdf }]),
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const book = imported.data.books[0];
  assert.equal(book.format, "pdf");
  assert.equal(book.title, "Fixture PDF");
  assert.equal(book.author, "Test author");
  assert.equal(book.metadata.numPages, 3);

  const detail = await api(base, `/api/books/${book.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.chapters.length, 0);
  assert.equal(detail.data.fileUrl, `/api/books/${book.id}/file`);

  const file = await api(base, `/api/books/${book.id}/file`, { raw: true });
  assert.equal(file.status, 200);
  assert.equal(Buffer.compare(Buffer.from(file.data), pdf), 0);

  const progress = await api(base, `/api/books/${book.id}`, {
    method: "PATCH",
    body: { page: 2, progress: 0.4, seconds: 125 },
  });
  assert.equal(progress.status, 200);
  assert.equal(progress.data.lastPage, 2);
  assert.equal(progress.data.status, "reading");

  const bookmark = await api(base, `/api/books/${book.id}/bookmarks`, {
    method: "POST",
    body: { label: "Page two", page: 2 },
  });
  assert.equal(bookmark.status, 201);
  const bookmarks = await api(base, `/api/books/${book.id}/bookmarks`);
  assert.equal(bookmarks.data.bookmarks.length, 1);

  const note = await api(base, "/api/notes", {
    method: "POST",
    body: { targetType: "book", targetId: book.id, page: 2, body: "PDF note" },
  });
  assert.equal(note.status, 201);

  const stats = await api(base, "/api/stats");
  assert.ok(stats.data.studySeconds >= 125);
  assert.ok(stats.data.studyTodaySeconds >= 125);

  const removedBookmark = await api(base, `/api/books/${book.id}/bookmarks/${bookmark.data.id}`, {
    method: "DELETE",
  });
  assert.equal(removedBookmark.status, 200);

  // Importing the same bytes again must deduplicate by hash.
  const again = await api(base, "/api/books/import", {
    method: "POST",
    body: multipart({}, [{ field: "file", name: "copy.pdf", type: "application/pdf", data: pdf }]),
  });
  assert.equal(again.status, 201);
  assert.equal(again.data.books[0].id, book.id);
});

test("EPUB import extracts chapters and sanitises active content", async () => {
  const epub = await buildEpub();
  const imported = await api(base, "/api/books/import", {
    method: "POST",
    body: multipart({}, [{ field: "file", name: "fixture.epub", type: "application/epub+zip", data: epub }]),
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const book = imported.data.books[0];
  assert.equal(book.format, "epub");
  assert.equal(book.title, "Fixture Book");
  assert.equal(book.author, "Ada Fixture");
  assert.ok(book.chapters.length >= 2);

  const chapter = await api(base, `/api/books/${book.id}/chapter/0`);
  assert.equal(chapter.status, 200);
  assert.match(chapter.data.html, /Sanitised/);
  assert.equal(chapter.data.html.includes("<script"), false);
  assert.equal(/onclick=/i.test(chapter.data.html), false);
  assert.equal(/onload=/i.test(chapter.data.html), false);

  const outOfRange = await api(base, `/api/books/${book.id}/chapter/99`);
  assert.equal(outOfRange.status, 404);

  const bad = await api(base, "/api/books/import", {
    method: "POST",
    body: multipart({}, [{ field: "file", name: "notes.txt", type: "text/plain", data: Buffer.from("hi") }]),
  });
  assert.equal(bad.status, 422);
});

test("media import, position tracking and subtitle conversion work", async () => {
  const fakeMp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(512, 3)]);
  const imported = await api(base, "/api/media/import", {
    method: "POST",
    body: multipart({}, [{ field: "file", name: "fixture.mp3", type: "audio/mpeg", data: fakeMp3 }]),
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const media = imported.data.media[0];
  assert.equal(media.kind, "audio");
  assert.equal(media.title, "fixture");
  assert.ok(media.fileUrl.endsWith("/file"));

  const list = await api(base, "/api/media");
  assert.ok(list.data.media.some((m) => m.id === media.id));

  const updated = await api(base, `/api/media/${media.id}`, {
    method: "PATCH",
    body: { position: 42.5, duration: 300, watchedDelta: 30 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.position, 42.5);
  assert.equal(updated.data.watchedSeconds, 30);

  const srt = Buffer.from("1\n00:00:01,000 --> 00:00:03,000\nHello fixture\n");
  const subtitle = await api(base, `/api/media/${media.id}/subtitles`, {
    method: "POST",
    body: multipart({ label: "English" }, [{ field: "file", name: "subs.srt", type: "text/plain", data: srt }]),
  });
  assert.equal(subtitle.status, 201, JSON.stringify(subtitle.data));

  const subtitles = await api(base, `/api/media/${media.id}/subtitles`);
  assert.equal(subtitles.data.subtitles.length, 1);

  const vtt = await api(base, `/api/media/${media.id}/subtitles/${subtitle.data.id}`);
  assert.equal(vtt.status, 200);
  assert.match(vtt.data, /^WEBVTT/);
  assert.match(vtt.data, /00:00:01\.000 --> 00:00:03\.000/);

  const note = await api(base, "/api/notes", {
    method: "POST",
    body: { targetType: "media", targetId: media.id, timeSeconds: 12.5, body: "Media note" },
  });
  assert.equal(note.status, 201);

  const deletedSub = await api(base, `/api/media/${media.id}/subtitles/${subtitle.data.id}`, { method: "DELETE" });
  assert.equal(deletedSub.status, 200);

  const deleted = await api(base, `/api/media/${media.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  const missing = await api(base, `/api/media/${media.id}`);
  assert.equal(missing.status, 404);
});

test("filesystem, storage and data export endpoints report real state", async () => {
  const folder = path.join(app.dataDir, "browse-target");
  const mkdir = await api(base, "/api/fs/mkdir", { method: "POST", body: { path: folder } });
  assert.equal(mkdir.status, 200);
  assert.equal(mkdir.data.path, folder);

  const listing = await api(base, `/api/fs/list?path=${encodeURIComponent(app.dataDir)}`);
  assert.equal(listing.status, 200);
  assert.ok(listing.data.dirs.some((d) => d.name === "browse-target"));
  assert.equal(listing.data.path, app.dataDir);

  const missing = await api(base, `/api/fs/list?path=${encodeURIComponent(path.join(app.dataDir, "nope"))}`);
  assert.equal(missing.status, 404);

  const size = await api(base, "/api/data/size");
  assert.equal(size.status, 200);
  for (const key of ["data", "downloads", "library", "outputs", "database"]) {
    assert.equal(typeof size.data[key], "number", key);
  }
  assert.ok(size.data.data > 0);

  const dataExport = await api(base, "/api/data/export");
  assert.equal(dataExport.status, 200);
  assert.equal(dataExport.data.app, "OmniGet Desktop");
  assert.ok(Array.isArray(dataExport.data.downloads));
  assert.ok(Array.isArray(dataExport.data.books));
  assert.ok(dataExport.data.settings.ai.apiKey === "" || dataExport.data.settings.ai.apiKey.includes("•"));

  const health = await api(base, "/api/health");
  assert.equal(health.status, 200);

  const unknown = await api(base, "/api/does-not-exist");
  assert.equal(unknown.status, 404);
});

test("history clear removes finished records but keeps the files", async () => {
  const beforeClear = await api(base, "/api/history");
  const completed = beforeClear.data.downloads.find((d) => d.title === "Fixture");
  assert.ok(completed?.filePath);

  const cleared = await api(base, "/api/history", { method: "DELETE", body: {} });
  assert.equal(cleared.status, 200);
  assert.ok(cleared.data.removed >= 1);

  const afterClear = await api(base, "/api/history");
  assert.equal(afterClear.data.downloads.length, 0);

  const stat = await fs.stat(completed.filePath);
  assert.ok(stat.size > 0, "clearing history must not delete files unless asked");
});
