/**
 * Tool suite tests. Each tool is exercised through the real HTTP API and its
 * generated outputs are downloaded and inspected — no result is trusted on
 * the strength of a status code alone.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import JSZip from "jszip";
import { api, multipart, startApp } from "./helpers.js";

let app;
let base;

before(async () => {
  app = await startApp({ allowLocal: true });
  base = app.base;
});

after(async () => {
  await app?.stop();
});

async function run(toolId, fields = {}, files = []) {
  return api(base, `/api/tools/${toolId}/run`, {
    method: "POST",
    body: multipart(fields, files),
  });
}

async function outputBytes(url) {
  const res = await api(base, url, { raw: true });
  assert.equal(res.status, 200, `output ${url}`);
  return Buffer.from(res.data);
}

async function outputText(url) {
  return (await outputBytes(url)).toString("utf8");
}

async function buildPdf(pages, title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  if (title) doc.setTitle(title);
  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage([420, 595]);
    page.drawText(`Tool fixture page ${i}`, { x: 40, y: 520, size: 15, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

test("tool catalog reports every tool with real availability", async () => {
  const res = await api(base, "/api/tools");
  assert.equal(res.status, 200);
  assert.ok(res.data.categories.length >= 10);
  const ids = new Set(res.data.tools.map((t) => t.id));
  for (const id of ["pdf-merge", "base64", "zip-create", "image-resize", "qr-generate", "media-info", "ai-text"]) {
    assert.ok(ids.has(id), `missing tool ${id}`);
  }
  const base64 = res.data.tools.find((t) => t.id === "base64");
  assert.equal(base64.available, true);
  assert.ok(base64.fields.some((f) => f.name === "mode"));
  const ai = res.data.tools.find((t) => t.id === "ai-text");
  assert.equal(ai.requiresConfig, true, "AI tools must be disabled without a key");
  assert.equal(typeof res.data.systems.ffmpeg, "boolean");
});

test("text tools produce correct content", async () => {
  const encode = await run("base64", { mode: "encode", text: "hello world", filename: "encoded.txt" });
  assert.equal(encode.status, 200, JSON.stringify(encode.data));
  assert.equal(encode.data.output.text, "aGVsbG8gd29ybGQ=");
  assert.equal(await outputText(encode.data.output.files[0].url), "aGVsbG8gd29ybGQ=");

  const decode = await run("base64", { mode: "decode", text: "aGVsbG8gd29ybGQ=", filename: "decoded.txt" });
  assert.equal(decode.status, 200, JSON.stringify(decode.data));
  assert.equal(decode.data.output.text, "hello world");

  const badBase64 = await run("base64", { mode: "decode", text: "not base64!!" });
  assert.equal(badBase64.status, 422);

  const json = await run("json-format", { text: '{"b":2,"a":[1,2]}', indent: "2", filename: "pretty.json" });
  assert.equal(json.status, 200, JSON.stringify(json.data));
  const formatted = JSON.parse(await outputText(json.data.output.files[0].url));
  assert.deepEqual(formatted, { b: 2, a: [1, 2] });
  assert.match(json.data.output.text, /\n  "b": 2/);

  const badJson = await run("json-format", { text: "{oops" });
  assert.equal(badJson.status, 422);
  assert.match(badJson.data.error, /Invalid JSON/);

  const csv = await run("csv-to-json", { text: "name,age\nAda,36\nLinus,55", filename: "people.json" });
  assert.equal(csv.status, 200, JSON.stringify(csv.data));
  assert.deepEqual(JSON.parse(await outputText(csv.data.output.files[0].url)), [
    { name: "Ada", age: "36" },
    { name: "Linus", age: "55" },
  ]);

  const regex = await run("regex-replace", {
    pattern: "\\s+",
    flags: "g",
    replacement: " ",
    text: "too   many\nspaces",
    filename: "regex.txt",
  });
  assert.equal(regex.status, 200, JSON.stringify(regex.data));
  assert.equal(await outputText(regex.data.output.files[0].url), "too many spaces");
  assert.match(regex.data.output.summary, /2 match/);

  const badRegex = await run("regex-replace", { pattern: "(", text: "x" });
  assert.equal(badRegex.status, 422);

  const stats = await run("text-stats", { text: "one two three\nfour five" });
  assert.equal(stats.status, 200);
  assert.match(stats.data.output.text, /Words: 5/);
  assert.match(stats.data.output.text, /Lines: 2/);

  const uuid = await run("uuid-generator", { count: 3, uppercase: "true" });
  assert.equal(uuid.status, 200);
  const ids = uuid.data.output.text.split("\n");
  assert.equal(ids.length, 3);
  for (const id of ids) assert.match(id, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);

  const timestamp = await run("timestamp-converter", { input: "1735689600" });
  assert.equal(timestamp.status, 200);
  assert.match(timestamp.data.output.text, /2025-01-01T00:00:00\.000Z/);

  const badTime = await run("timestamp-converter", { input: "not a date" });
  assert.equal(badTime.status, 422);

  const color = await run("color-converter", { color: "#FF9500" });
  assert.equal(color.status, 200);
  assert.match(color.data.output.text, /RGB: rgb\(255, 149, 0\)/);
  const swatch = await outputText(color.data.output.files[0].url);
  assert.match(swatch, /<svg/);
  assert.match(swatch, /#FF9500/);

  const jwtPayload = Buffer.from(JSON.stringify({ sub: "1", name: "Ada", exp: 9999999999 })).toString("base64url");
  const jwtHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const jwt = await run("jwt-decode", { token: `${jwtHeader}.${jwtPayload}.` });
  assert.equal(jwt.status, 200);
  assert.equal(jwt.data.output.json.payload.name, "Ada");
  assert.equal(jwt.data.output.json.expired, false);

  const codec = await run("url-codec", { mode: "encode", text: "a b/c?d" });
  assert.equal(codec.status, 200);
  assert.equal(codec.data.output.text, "a%20b%2Fc%3Fd");
});

test("checksum, file info and text documents are real files", async () => {
  const payload = Buffer.from("abc");
  const checksum = await run("checksum", { algorithm: "sha256", text: "abc" });
  assert.equal(checksum.status, 200);
  const expected = crypto.createHash("sha256").update(payload).digest("hex");
  assert.match(checksum.data.output.text, new RegExp(expected));

  const info = await run("file-info", {}, [{ field: "file", name: "sample.bin", type: "application/octet-stream", data: payload }]);
  assert.equal(info.status, 200, JSON.stringify(info.data));
  assert.match(info.data.output.text, /Size: 3 bytes/);
  assert.match(info.data.output.text, new RegExp(expected));
  assert.match(info.data.output.text, /Text-like: yes/);

  const md = await run("markdown-to-html", { text: "# Title\n\nA **bold** line.", title: "Doc", filename: "doc.html" });
  assert.equal(md.status, 200, JSON.stringify(md.data));
  const html = await outputText(md.data.output.files[0].url);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<!doctype html>/i);

  const pdf = await run("text-to-pdf", {
    text: "First line of the generated document.\nSecond line follows.",
    title: "Generated",
    filename: "generated.pdf",
  });
  assert.equal(pdf.status, 200, JSON.stringify(pdf.data));
  const pdfBytes = await outputBytes(pdf.data.output.files[0].url);
  assert.equal(pdfBytes.subarray(0, 5).toString(), "%PDF-");
  const parsed = await PDFDocument.load(pdfBytes);
  assert.ok(parsed.getPageCount() >= 1);
  assert.equal(parsed.getTitle(), "Generated");

  const missing = await run("text-to-pdf", {});
  assert.equal(missing.status, 422);
});

test("PDF tools merge, extract, split, rotate and extract text", async () => {
  const one = await buildPdf(2, "One");
  const two = await buildPdf(1, "Two");

  const merge = await run(
    "pdf-merge",
    { filename: "merged.pdf" },
    [
      { field: "file", name: "one.pdf", type: "application/pdf", data: one },
      { field: "file", name: "two.pdf", type: "application/pdf", data: two },
    ],
  );
  assert.equal(merge.status, 200, JSON.stringify(merge.data));
  const mergedBytes = await outputBytes(merge.data.output.files[0].url);
  const merged = await PDFDocument.load(mergedBytes);
  assert.equal(merged.getPageCount(), 3);

  const info = await run("pdf-info", {}, [{ field: "file", name: "merged.pdf", type: "application/pdf", data: mergedBytes }]);
  assert.equal(info.status, 200, JSON.stringify(info.data));
  assert.match(info.data.output.text, /pages: 3/);

  const extract = await run(
    "pdf-extract-pages",
    { pages: "2-3", filename: "selection.pdf" },
    [{ field: "file", name: "merged.pdf", type: "application/pdf", data: mergedBytes }],
  );
  assert.equal(extract.status, 200, JSON.stringify(extract.data));
  const extracted = await PDFDocument.load(await outputBytes(extract.data.output.files[0].url));
  assert.equal(extracted.getPageCount(), 2);

  const split = await run("pdf-split", { pages: "1-2", filename: "split.zip" }, [
    { field: "file", name: "merged.pdf", type: "application/pdf", data: mergedBytes },
  ]);
  assert.equal(split.status, 200, JSON.stringify(split.data));
  const splitZip = await JSZip.loadAsync(await outputBytes(split.data.output.files[0].url));
  assert.deepEqual(Object.keys(splitZip.files).sort(), ["page-001.pdf", "page-002.pdf"]);

  const rotate = await run("pdf-rotate", { angle: "90", pages: "", filename: "rotated.pdf" }, [
    { field: "file", name: "merged.pdf", type: "application/pdf", data: mergedBytes },
  ]);
  assert.equal(rotate.status, 200, JSON.stringify(rotate.data));

  const text = await run("pdf-to-text", { filename: "merged.txt" }, [
    { field: "file", name: "merged.pdf", type: "application/pdf", data: mergedBytes },
  ]);
  assert.equal(text.status, 200, JSON.stringify(text.data));
  const extractedText = await outputText(text.data.output.files[0].url);
  assert.match(extractedText, /Tool fixture page 1/);
  assert.match(extractedText, /--- Page 3 ---/);

  const badRange = await run("pdf-extract-pages", { pages: "9-12" }, [
    { field: "file", name: "merged.pdf", type: "application/pdf", data: mergedBytes },
  ]);
  assert.equal(badRange.status, 422);

  const notPdf = await run("pdf-info", {}, [
    { field: "file", name: "fake.pdf", type: "application/pdf", data: Buffer.from("not a pdf") },
  ]);
  assert.equal(notPdf.status, 422);
});

test("ZIP create, list and extract round-trip real bytes", async () => {
  const a = Buffer.from("alpha content");
  const b = crypto.randomBytes(64);

  const create = await run("zip-create", { filename: "bundle.zip" }, [
    { field: "file", name: "alpha.txt", type: "text/plain", data: a },
    { field: "file", name: "beta.bin", type: "application/octet-stream", data: b },
  ]);
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const zipBytes = await outputBytes(create.data.output.files[0].url);

  const list = await run("zip-list", {}, [
    { field: "file", name: "bundle.zip", type: "application/zip", data: zipBytes },
  ]);
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.match(list.data.output.text, /2 file\(s\)/);
  assert.match(list.data.output.text, /alpha\.txt/);

  const extract = await run("zip-extract", {}, [
    { field: "file", name: "bundle.zip", type: "application/zip", data: zipBytes },
  ]);
  assert.equal(extract.status, 200, JSON.stringify(extract.data));
  assert.equal(extract.data.output.files.length, 2);
  const names = extract.data.output.files.map((f) => f.name).sort();
  assert.deepEqual(names, ["alpha.txt", "beta.bin"]);
  const byName = new Map(extract.data.output.files.map((f) => [f.name, f]));
  assert.equal((await outputBytes(byName.get("alpha.txt").url)).toString(), "alpha content");
  assert.equal(Buffer.compare(await outputBytes(byName.get("beta.bin").url), b), 0);
});

test("subtitle tools convert and measure cues", async () => {
  const srt = Buffer.from(
    "1\n00:00:01,000 --> 00:00:03,500\nHello there\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line\n",
  );
  const vtt = await run("srt-to-vtt", { filename: "converted.vtt" }, [
    { field: "file", name: "input.srt", type: "text/plain", data: srt },
  ]);
  assert.equal(vtt.status, 200, JSON.stringify(vtt.data));
  const vttText = await outputText(vtt.data.output.files[0].url);
  assert.match(vttText, /^WEBVTT/);
  assert.match(vttText, /00:00:01\.000 --> 00:00:03\.500/);
  assert.match(vttText, /Hello there/);

  const shifted = await run("subtitle-shift", { seconds: "2.5", format: "vtt" }, [
    { field: "file", name: "input.srt", type: "text/plain", data: srt },
  ]);
  assert.equal(shifted.status, 200, JSON.stringify(shifted.data));
  const shiftedText = await outputText(shifted.data.output.files[0].url);
  assert.match(shiftedText, /00:00:03\.500 --> 00:00:06\.000/);

  const stats = await run("subtitle-stats", {}, [
    { field: "file", name: "input.srt", type: "text/plain", data: srt },
  ]);
  assert.equal(stats.status, 200, JSON.stringify(stats.data));
  assert.match(stats.data.output.text, /Cues: 2/);
  assert.match(stats.data.output.text, /Words: 4/);

  const merge = await run("subtitle-merge", { format: "srt" }, [
    { field: "file", name: "a.srt", type: "text/plain", data: srt },
    {
      field: "file",
      name: "b.srt",
      type: "text/plain",
      data: Buffer.from("1\n00:00:07,000 --> 00:00:08,000\nLater\n"),
    },
  ]);
  assert.equal(merge.status, 200, JSON.stringify(merge.data));
  const mergedText = await outputText(merge.data.output.files[0].url);
  assert.match(mergedText, /Hello there[\s\S]*Second line[\s\S]*Later/);

  const bad = await run("srt-to-vtt", {}, []);
  assert.equal(bad.status, 422);
});

test("image and QR tools process generated images", async () => {
  const qr = await run("qr-generate", { text: "https://example.com/omniget", size: "256", format: "png" });
  assert.equal(qr.status, 200, JSON.stringify(qr.data));
  const png = await outputBytes(qr.data.output.files[0].url);
  assert.equal(png.subarray(1, 4).toString(), "PNG");

  const decoded = await run("qr-decode", {}, [
    { field: "file", name: "qr.png", type: "image/png", data: png },
  ]);
  assert.equal(decoded.status, 200, JSON.stringify(decoded.data));
  assert.equal(decoded.data.output.text, "https://example.com/omniget");

  const info = await run("image-info", {}, [
    { field: "file", name: "qr.png", type: "image/png", data: png },
  ]);
  assert.equal(info.status, 200, JSON.stringify(info.data));
  assert.match(info.data.output.text, /Width: 256 px/);
  assert.match(info.data.output.text, /Height: 256 px/);

  const resized = await run("image-resize", { width: "64", height: "64", fit: "stretch", format: "png" }, [
    { field: "file", name: "qr.png", type: "image/png", data: png },
  ]);
  assert.equal(resized.status, 200, JSON.stringify(resized.data));
  const small = await outputBytes(resized.data.output.files[0].url);
  const Jimp = (await import("jimp")).Jimp;
  const image = await Jimp.read(small);
  assert.equal(image.width, 64);
  assert.equal(image.height, 64);

  const converted = await run("image-convert", { format: "jpg", quality: "80" }, [
    { field: "file", name: "qr.png", type: "image/png", data: png },
  ]);
  assert.equal(converted.status, 200, JSON.stringify(converted.data));
  const jpg = await outputBytes(converted.data.output.files[0].url);
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8);

  const badImage = await run("image-info", {}, [
    { field: "file", name: "fake.png", type: "image/png", data: Buffer.from("not an image") },
  ]);
  assert.equal(badImage.status, 422);

  const noQr = await run("qr-decode", {}, [
    { field: "file", name: "blank.png", type: "image/png", data: png.subarray(0, 0) },
  ]);
  assert.ok([422, 500].includes(noQr.status));
});

test("validation and unavailable dependencies are honest", async () => {
  const unknown = await run("nope", {});
  assert.equal(unknown.status, 404);

  const missingFile = await run("zip-list", {}, []);
  assert.equal(missingFile.status, 422);
  assert.match(missingFile.data.error, /needs at least 1 file/);

  const wrongType = await run("zip-list", {}, [
    { field: "file", name: "notes.txt", type: "text/plain", data: Buffer.from("hi") },
  ]);
  assert.equal(wrongType.status, 422);
  assert.match(wrongType.data.error, /not an accepted file type/);

  const catalog = await api(base, "/api/tools");
  const audio = catalog.data.tools.find((t) => t.id === "extract-audio");
  if (!audio.available) {
    const res = await run("extract-audio", {}, [
      { field: "file", name: "sample.mp3", type: "audio/mpeg", data: Buffer.from("ID3") },
    ]);
    assert.equal(res.status, 503);
    assert.match(res.data.error, /ffmpeg|Missing dependency/i);
  }

  const ai = await run("ai-text", { prompt: "hello" });
  assert.equal(ai.status, 409);
  assert.match(ai.data.error, /API key/);

  const jobs = await api(base, "/api/tools/jobs");
  assert.equal(jobs.status, 200);
  assert.ok(jobs.data.jobs.length >= 10);
  assert.ok(jobs.data.jobs.every((j) => ["completed", "failed", "running"].includes(j.status)));

  const failed = jobs.data.jobs.find((j) => j.status === "failed");
  assert.ok(failed, "expected at least one failed validation job");
  assert.ok(failed.error);
});
