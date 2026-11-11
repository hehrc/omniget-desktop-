#!/usr/bin/env node
/**
 * Seed a throwaway OmniGet instance with real content.
 *
 * Nothing here writes directly into the database or fakes a progress bar.
 * The script starts the production server, serves real bytes from a local
 * fixture web server, downloads them through the real engine, imports a real
 * EPUB, and records notes, bookmarks and reading progress through the public
 * HTTP API. The resulting data directory can be inspected or screenshotted.
 *
 * Usage:
 *   npm run fixtures
 *   node scripts/make-fixtures.js --data-dir data/screenshots
 *   node scripts/make-fixtures.js --data-dir /tmp/omniget-demo --keep
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import JSZip from "jszip";
import { api, freePort, multipart, waitFor } from "../tests/helpers.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const dataDir = path.resolve(
  arg("data-dir") || process.env.OMNIGET_DATA_DIR || path.join(ROOT, "data", "fixtures"),
);
const keep = process.argv.includes("--keep");
const verbose = process.argv.includes("--verbose");

if (dataDir === path.parse(dataDir).root || dataDir === ROOT) {
  console.error("Refusing to prepare fixtures in an unsafe directory:", dataDir);
  process.exit(1);
}
if (!keep) {
  await fsp.rm(dataDir, { recursive: true, force: true });
}
await fsp.mkdir(dataDir, { recursive: true });

/* ----------------------------- source content ----------------------------- */

const PROSE = {
  quiet: [
    "A good tool should feel like a window: present when you need it, invisible when you do not. The quiet machine is not a machine that does nothing. It is one that does the small, necessary thing and then gets out of the way.",
    "Most software asks for attention before it has earned any. It opens panels, flies notifications across the screen, and treats the corner of your eye as a resource to be mined. The alternative is not minimalism for its own sake. It is a kind of manners.",
    "A download manager belongs in this category. You give it a link. It tells you the truth about the link. Then it moves the bytes, writes them to disk, and stops. There is no reason for it to become a second job.",
    "This field note was typeset locally with pdf-lib, downloaded over the loopback interface, and imported back into the study library. Every number on the shelf comes from the real files on disk.",
  ],
  tools: [
    "Small tools compose. A PDF merger does not need to know about a subtitle converter, and a hash calculator does not need a dashboard. The user is the integration layer, and that is usually the right design.",
    "Local-first software starts with a simple promise: the files are yours, the database is yours, and the network is optional. When that promise is kept, the application can be modest without being weak.",
    "The test of a downloader is not how many sites it claims to support. It is whether a paused transfer resumes at the same byte, whether a canceled transfer leaves a partial file behind, and whether the interface admits when a dependency is missing.",
    "These chapters were written for a fixture EPUB. They exist so the reader has real XHTML to render, real navigation entries to follow, and real text to select when a note is added.",
  ],
};

async function buildPdf() {
  const doc = await PDFDocument.create();
  doc.setTitle("The Quiet Machine");
  doc.setAuthor("Mara Ellison");
  doc.setSubject("Field notes on calm, local software");
  doc.setKeywords(["software", "local-first", "design"]);
  doc.setCreator("OmniGet fixture generator");

  const body = await doc.embedFont(StandardFonts.TimesRoman);
  const bodyItalic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const sans = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.14, 0.13, 0.11);
  const muted = rgb(0.42, 0.4, 0.36);
  const accent = rgb(1, 0.58, 0);

  // Cover
  const cover = doc.addPage([420, 595]);
  cover.drawRectangle({ x: 0, y: 0, width: 420, height: 595, color: rgb(0.953, 0.945, 0.925) });
  cover.drawRectangle({ x: 48, y: 470, width: 44, height: 4, color: accent });
  cover.drawText("FIELD NOTES", { x: 48, y: 505, size: 11, font: bold, color: muted, characterSpacing: 2 });
  const titleLines = ["The Quiet", "Machine"];
  titleLines.forEach((line, i) => {
    cover.drawText(line, { x: 46, y: 414 - i * 52, size: 46, font: bold, color: ink });
  });
  cover.drawText("On calm software, local files,", { x: 48, y: 292, size: 13, font: bodyItalic, color: muted });
  cover.drawText("and the tools that get out of the way.", { x: 48, y: 274, size: 13, font: bodyItalic, color: muted });
  cover.drawText("MARA ELLISON", { x: 48, y: 96, size: 10, font: bold, color: ink, characterSpacing: 1.4 });
  cover.drawText("OmniGet study library · 2026", { x: 48, y: 78, size: 9, font: sans, color: muted });

  const margins = { left: 54, right: 54, top: 66, bottom: 58 };
  const width = 420 - margins.left - margins.right;
  const wrap = (text, font, size) => {
    const words = text.split(/\s+/);
    const lines = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  const chapters = [
    ["I. Manners", PROSE.quiet[0], PROSE.quiet[1]],
    ["II. The honest widget", PROSE.quiet[2], PROSE.quiet[3]],
    ["III. Composition", PROSE.tools[0], PROSE.tools[1]],
    ["IV. Proof", PROSE.tools[2], PROSE.tools[3]],
    ["Colophon", "Set in Times New Roman and Helvetica, generated locally by scripts/make-fixtures.js. This PDF is a test fixture, not a real publication."],
  ];

  chapters.forEach(([label, ...paragraphs], index) => {
    const page = doc.addPage([420, 595]);
    page.drawText(label.toUpperCase(), {
      x: margins.left,
      y: 595 - margins.top,
      size: 9,
      font: bold,
      color: accent,
      characterSpacing: 1.6,
    });
    page.drawText(`0${index + 1}`, {
      x: 420 - margins.right - 20,
      y: 595 - margins.top,
      size: 9,
      font: sans,
      color: muted,
    });
    let y = 595 - margins.top - 48;
    for (const paragraph of paragraphs) {
      const lines = wrap(paragraph, body, 11.5);
      for (const line of lines) {
        if (y < margins.bottom + 24) break;
        page.drawText(line, { x: margins.left, y, size: 11.5, font: body, color: ink });
        y -= 17.5;
      }
      y -= 10;
    }
    page.drawText(`The Quiet Machine · page ${index + 2}`, {
      x: margins.left,
      y: margins.bottom - 18,
      size: 8,
      font: sans,
      color: muted,
    });
  });

  return Buffer.from(await doc.save());
}

function buildCoverSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
  <rect width="600" height="900" fill="#2f4a41"/>
  <circle cx="410" cy="250" r="150" fill="#ff9500" opacity="0.92"/>
  <rect x="60" y="620" width="90" height="6" fill="#ffd9a3"/>
  <text x="60" y="690" font-family="Georgia, serif" font-size="52" fill="#f6f1e7">Notes on</text>
  <text x="60" y="748" font-family="Georgia, serif" font-size="52" fill="#f6f1e7">Small Tools</text>
  <text x="60" y="812" font-family="Helvetica, sans-serif" font-size="20" fill="#cddcd6" letter-spacing="4">IVO MARSH</text>
</svg>`;
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
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Notes on Small Tools</dc:title>
    <dc:creator>Ivo Marsh</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:quiet-tools-fixture</dc:identifier>
    <meta property="dcterms:modified">2026-01-12T09:00:00Z</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
</package>`,
  );
  zip.file(
    "OEBPS/style.css",
    `body { font-family: Georgia, serif; line-height: 1.6; color: #2b2419; }
h1 { font-size: 1.6em; margin: 0 0 1em; }
p { margin: 0 0 1em; }
blockquote { border-left: 3px solid #ff9500; margin: 1.4em 0; padding-left: 1em; color: #5c5345; }`,
  );
  zip.file("OEBPS/cover.svg", buildCoverSvg());
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="ch1.xhtml">The case for smallness</a></li><li><a href="ch2.xhtml">Composition over dashboards</a></li><li><a href="ch3.xhtml">What honesty costs</a></li></ol></nav></body></html>`,
  );
  const chapter = (number, title, paragraphs, quote = "") => `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
  <h1>${number}. ${title}</h1>
  ${paragraphs.map((p) => `<p>${p}</p>`).join("\n  ")}
  ${quote ? `<blockquote>${quote}</blockquote>` : ""}
</body></html>`;
  zip.file(
    "OEBPS/ch1.xhtml",
    chapter(1, "The case for smallness", PROSE.tools.slice(0, 2), "A tool that fits on one screen is easier to trust than a tool that needs a tour."),
  );
  zip.file("OEBPS/ch2.xhtml", chapter(2, "Composition over dashboards", PROSE.quiet.slice(0, 2)));
  zip.file("OEBPS/ch3.xhtml", chapter(3, "What honesty costs", PROSE.tools.slice(2, 4)));
  return zip.generateAsync({ type: "nodebuffer" });
}

function buildWav({ seconds = 8, rate = 16000, frequencies = [220, 330, 440], gain = 0.22 }) {
  const samples = Math.floor(rate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const attack = Math.min(1, t / 0.35);
    const release = Math.min(1, (seconds - t) / 0.6);
    const envelope = Math.max(0, Math.min(attack, release));
    let value = 0;
    for (const [idx, hz] of frequencies.entries()) {
      value += Math.sin(2 * Math.PI * hz * t) / (idx + 1.4);
    }
    const sample = Math.round(value * gain * envelope * 32767);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function buildReadingPack(pdf) {
  const zip = new JSZip();
  zip.file("reading-list.txt", "The Quiet Machine\nNotes on Small Tools\nA Pattern Language (reference only)\n");
  zip.file("margins.md", "# Marginalia\n\n- Prefer the smallest surface that does the job.\n- Measure pause/resume in bytes, not in optimism.\n");
  zip.file("field-notes.pdf", pdf);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/* -------------------------------- fixture web ------------------------------ */

function startFixtureServer(files) {
  const pending = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (verbose) console.log(`[fixture] ${req.method} ${url.pathname}${req.headers.range ? ` range=${req.headers.range}` : ""}`);
    if (url.pathname === "/slow/night-drive.bin") {
      const total = 9 * 1024 * 1024;
      const headers = {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "content-length": total,
        "content-disposition": 'attachment; filename="night-drive.bin"',
      };
      res.writeHead(200, headers);
      if (req.method === "HEAD") return res.end();
      let sent = 0;
      const chunk = Buffer.alloc(24 * 1024, 0x4e);
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          pending.delete(timer);
          return;
        }
        if (sent >= total) {
          clearInterval(timer);
          pending.delete(timer);
          res.end();
          return;
        }
        const size = Math.min(chunk.length, total - sent);
        res.write(chunk.subarray(0, size));
        sent += size;
      }, 12);
      pending.add(timer);
      req.on("close", () => {
        clearInterval(timer);
        pending.delete(timer);
      });
      return;
    }
    const file = files.get(url.pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("fixture: not found");
    }
    const range = req.headers.range;
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(String(range)) : null;
    const headers = {
      "content-type": file.mime,
      "accept-ranges": "bytes",
      "content-disposition": `attachment; filename="${file.name}"`,
    };
    if (match) {
      let start = match[1] === "" ? Math.max(0, file.data.length - Number(match[2])) : Number(match[1]);
      let end = match[2] ? Math.min(Number(match[2]), file.data.length - 1) : file.data.length - 1;
      if (start > end || start >= file.data.length) {
        res.writeHead(416, { "content-range": `bytes */${file.data.length}` });
        return res.end();
      }
      const slice = file.data.subarray(start, end + 1);
      headers["content-range"] = `bytes ${start}-${end}/${file.data.length}`;
      headers["content-length"] = slice.length;
      res.writeHead(206, headers);
      return res.end(slice);
    }
    headers["content-length"] = file.data.length;
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    res.end(file.data);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        async stop() {
          for (const timer of pending) clearInterval(timer);
          pending.clear();
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

/* ------------------------------ app life cycle ----------------------------- */

async function startServer(port) {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      OMNIGET_DATA_DIR: dataDir,
      OMNIGET_ALLOW_LOCAL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  const collect = (stream, prefix) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) {
          logs.push(`${prefix}${line}`);
          if (verbose) console.log(`[server] ${prefix}${line}`);
        }
      }
    });
  };
  collect(child.stdout, "");
  collect(child.stderr, "[stderr] ");
  let exited = false;
  child.on("exit", () => (exited = true));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      if (exited) throw new Error("server exited early\n" + logs.join("\n"));
      const res = await fetch(base + "/api/health").catch(() => null);
      return res?.ok;
    },
    { timeout: 20_000, label: "fixture app health" },
  );
  return {
    base,
    child,
    logs,
    async stop() {
      if (!exited) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 4000)),
        ]);
        if (!exited) child.kill("SIGKILL");
      }
    },
  };
}

async function expectOk(promise, label) {
  const res = await promise;
  if (res.status >= 400) {
    throw new Error(`${label} failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res;
}

/* ----------------------------------- seed ---------------------------------- */

console.log("Preparing fixtures in", dataDir);
const pdf = await buildPdf();
const epub = await buildEpub();
const tone = buildWav({ seconds: 8, frequencies: [220, 330, 440], gain: 0.22 });
const drone = buildWav({ seconds: 5, frequencies: [110, 164.81], gain: 0.18 });
const pack = await buildReadingPack(pdf);

const fixture = await startFixtureServer(
  new Map([
    ["/library/the-quiet-machine.pdf", { name: "the-quiet-machine.pdf", mime: "application/pdf", data: pdf }],
    ["/audio/studio-tone-440hz.wav", { name: "studio-tone-440hz.wav", mime: "audio/wav", data: tone }],
    ["/audio/rain-on-glass.wav", { name: "rain-on-glass.wav", mime: "audio/wav", data: drone }],
    ["/packs/reading-pack.zip", { name: "reading-pack.zip", mime: "application/zip", data: pack }],
  ]),
);

const port = await freePort();
const app = await startServer(port);
const base = app.base;

try {
  await expectOk(
    api(base, "/api/settings", {
      method: "PUT",
      body: {
        settings: {
          appearance: { theme: "light", accent: "orange", density: "comfortable", fontScale: 1 },
          download: { maxConcurrent: 3, autoStart: true, skipExisting: true, organizeBySource: false },
          network: { allowLocalhost: true },
          reader: { theme: "paper", fontSize: 18, lineHeight: 1.7, pageWidth: 760, pdfZoom: 1.1 },
          playback: { defaultVolume: 0.8, rememberPosition: true, autoplay: false },
          study: { dailyGoalMinutes: 45, autoResume: true },
        },
      },
    }),
    "settings",
  );

  const downloads = [
    { path: "/library/the-quiet-machine.pdf", title: "The Quiet Machine — field notes" },
    { path: "/audio/studio-tone-440hz.wav", title: "Studio tone — 440 Hz" },
    { path: "/audio/rain-on-glass.wav", title: "Rain on glass" },
    { path: "/packs/reading-pack.zip", title: "Reading pack" },
  ];

  const completed = [];
  for (const item of downloads) {
    const res = await expectOk(
      api(base, "/api/downloads", { method: "POST", body: { url: fixture.base + item.path, title: item.title } }),
      `download ${item.path}`,
    );
    const id = res.data.id;
    const done = await waitFor(
      async () => {
        const row = await api(base, `/api/downloads/${id}`);
        if (row.status >= 400) throw new Error(JSON.stringify(row.data));
        if (row.data.status === "failed") throw new Error(`download failed: ${row.data.error}`);
        return row.data.status === "completed" ? row.data : null;
      },
      { timeout: 45_000, label: `download ${item.path}` },
    );
    console.log(`  downloaded ${done.filename} (${done.sizeBytes} bytes)`);
    completed.push(done);
  }

  // A genuinely paused transfer: real bytes on disk, then a real pause.
  const slow = await expectOk(
    api(base, "/api/downloads", { method: "POST", body: { url: fixture.base + "/slow/night-drive.bin", title: "Night drive (long mix)" } }),
    "slow download",
  );
  const inFlight = await waitFor(
    async () => {
      const row = await api(base, `/api/downloads/${slow.data.id}`);
      return row.data.downloadedBytes > 350_000 ? row.data : null;
    },
    { timeout: 30_000, label: "slow download progress" },
  );
  await expectOk(api(base, `/api/downloads/${inFlight.id}/pause`, { method: "POST" }), "pause");
  const paused = await waitFor(
    async () => {
      const row = await api(base, `/api/downloads/${inFlight.id}`);
      return row.data.status === "paused" ? row.data : null;
    },
    { timeout: 15_000, label: "paused state" },
  );
  console.log(`  paused ${paused.filename} at ${paused.downloadedBytes} bytes`);

  // Import a real EPUB through the multipart endpoint.
  const ebook = await expectOk(
    api(base, "/api/books/import", {
      method: "POST",
      body: multipart({}, [{ field: "file", name: "notes-on-small-tools.epub", type: "application/epub+zip", data: epub }]),
    }),
    "EPUB import",
  );
  const epubBook = ebook.data.books[0];
  console.log(`  imported “${epubBook.title}” (${epubBook.chapters.length} chapters)`);

  const books = await expectOk(api(base, "/api/books"), "book list");
  const pdfBook = books.data.books.find((b) => b.format === "pdf");
  if (!pdfBook) throw new Error("the downloaded PDF was not auto-imported into the study library");
  const media = await expectOk(api(base, "/api/media"), "media list");
  const toneItem = media.data.media.find((m) => /studio/i.test(m.title));
  if (!toneItem) throw new Error("the downloaded WAV was not auto-imported into the media library");

  // Reading progress and study seconds.
  await expectOk(
    api(base, `/api/books/${pdfBook.id}`, {
      method: "PATCH",
      body: { page: 2, progress: 0.34, seconds: 900, scroll: 0 },
    }),
    "PDF progress",
  );
  await expectOk(
    api(base, `/api/books/${epubBook.id}`, {
      method: "PATCH",
      body: { chapter: 1, progress: 0.42, seconds: 450, scroll: 0.25 },
    }),
    "EPUB progress",
  );

  // Notes and bookmarks anchored to real pages, chapters and timestamps.
  await expectOk(
    api(base, "/api/notes", {
      method: "POST",
      body: {
        targetType: "book",
        targetId: pdfBook.id,
        page: 2,
        body: "The line about software asking for attention before it has earned any is the thesis of the whole piece.",
      },
    }),
    "PDF note",
  );
  await expectOk(
    api(base, "/api/books/" + pdfBook.id + "/bookmarks", {
      method: "POST",
      body: { page: 2, label: "Manners, not minimalism" },
    }),
    "PDF bookmark",
  );
  await expectOk(
    api(base, "/api/notes", {
      method: "POST",
      body: {
        targetType: "book",
        targetId: epubBook.id,
        chapter: 1,
        body: "Composition over dashboards — compare this with the tool registry in the app.",
      },
    }),
    "EPUB note",
  );
  await expectOk(
    api(base, "/api/notes", {
      method: "POST",
      body: { targetType: "media", targetId: toneItem.id, timeSeconds: 3.2, body: "The 440 Hz tone lands cleanly here. Check the waveform on a real pair of speakers." },
    }),
    "media note",
  );
  await expectOk(
    api(base, "/api/bookmarks", {
      method: "POST",
      body: { targetType: "media", targetId: toneItem.id, timeSeconds: 3.2, label: "Reference pitch" },
    }),
    "media bookmark",
  );
  await expectOk(
    api(base, "/api/notes", {
      method: "POST",
      body: { targetType: "download", targetId: completed[0].id, body: "Filed under study → local-first design." },
    }),
    "download note",
  );

  // One real tool run so the output/history surface has genuine bytes.
  const qr = await expectOk(
    api(base, "/api/tools/qr-generate/run", {
      method: "POST",
      body: multipart({ text: "https://example.com/omniget-local", size: "320", format: "png" }, []),
    }),
    "QR tool",
  );
  console.log(`  ran qr-generate → ${qr.data.output.files[0]?.name}`);

  // Leave the dataset safe: local addresses are off again after seeding.
  await expectOk(
    api(base, "/api/settings", { method: "PUT", body: { settings: { network: { allowLocalhost: false } } } }),
    "restore local-address setting",
  );

  const stats = await expectOk(api(base, "/api/stats"), "stats");
  console.log("\nFixture ready.");
  console.log(`  data:      ${dataDir}`);
  console.log(`  downloads: ${stats.data.downloads.all} records (${stats.data.downloads.completed || 0} completed)`);
  console.log(`  books:     ${books.data.books.length}`);
  console.log(`  media:     ${media.data.media.length}`);
  console.log(`  study:     ${stats.data.studyTodaySeconds}s today`);
  console.log("\nStart the app against this dataset with:");
  console.log(`  OMNIGET_DATA_DIR=${dataDir} npm start`);
} finally {
  await fixture.stop();
  await app.stop();
}
