import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { marked } from "marked";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  csvToJson,
  decodeJwt,
  ensureExt,
  formatBytesText,
  hashBuffer,
  hexToRgb,
  isProbablyText,
  normalizeText,
  readText,
  rgbToHsl,
} from "./helpers.js";
import { mimeFromName } from "../util.js";

async function textFromCtx(ctx) {
  if (ctx.files.length) return await readText(ctx.files[0].path);
  return normalizeText(ctx.values.text ?? ctx.values.input ?? "");
}

export const docTools = {
  checksum: {
    category: "text",
    name: "Checksums & hashes",
    description: "Compute SHA-256, SHA-1 or MD5 for a file or a piece of text, plus the file size.",
    keywords: ["hash", "sha256", "md5", "checksum", "verify", "file"],
    accept: "",
    minFiles: 0,
    maxFiles: 1,
    fields: [
      {
        name: "algorithm",
        label: "Algorithm",
        type: "select",
        options: [
          { value: "sha256", label: "SHA-256" },
          { value: "sha1", label: "SHA-1" },
          { value: "md5", label: "MD5" },
        ],
        default: "sha256",
      },
      { name: "text", label: "Text to hash (if no file)", type: "textarea", placeholder: "Paste text…" },
    ],
    async run(ctx) {
      const algorithm = ctx.values.algorithm || "sha256";
      let buf;
      let label;
      if (ctx.files.length) {
        buf = await fsp.readFile(ctx.files[0].path);
        label = ctx.files[0].name;
      } else {
        if (!ctx.values.text) throw Object.assign(new Error("Add a file or enter some text"), { status: 422 });
        buf = Buffer.from(ctx.values.text, "utf8");
        label = "text";
      }
      const digest = hashBuffer(buf, algorithm);
      const summary = `${algorithm.toUpperCase()} (${label}, ${formatBytesText(buf.length)}):\n${digest}`;
      const target = ctx.out("checksum.txt");
      await fsp.writeFile(target, summary + "\n", "utf8");
      return {
        text: summary,
        files: [{ path: target, name: "checksum.txt", mime: "text/plain", size: Buffer.byteLength(summary) }],
        summary: `${algorithm.toUpperCase()} · ${formatBytesText(buf.length)}`,
      };
    },
  },

  "base64": {
    category: "text",
    name: "Base64 encode / decode",
    description: "Convert text or files to Base64, and decode Base64 back to text or binary.",
    keywords: ["base64", "encode", "decode", "binary", "ctf"],
    accept: "",
    minFiles: 0,
    maxFiles: 1,
    fields: [
      {
        name: "mode",
        label: "Mode",
        type: "select",
        options: [
          { value: "encode", label: "Encode to Base64" },
          { value: "decode", label: "Decode from Base64" },
        ],
        default: "encode",
      },
      { name: "text", label: "Text input (if no file)", type: "textarea" },
      { name: "urlSafe", label: "URL-safe alphabet", type: "checkbox", default: false },
      { name: "filename", label: "Output filename", type: "text", placeholder: "base64.txt" },
    ],
    async run(ctx) {
      const mode = ctx.values.mode || "encode";
      let buf;
      if (ctx.files.length) buf = await fsp.readFile(ctx.files[0].path);
      else {
        const text = normalizeText(ctx.values.text ?? "");
        if (!text) throw Object.assign(new Error("Enter text or choose a file"), { status: 422 });
        buf = Buffer.from(text, "utf8");
      }
      if (mode === "encode") {
        let encoded = buf.toString("base64");
        if (ctx.values.urlSafe) encoded = encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const target = ctx.out(ensureExt(ctx.values.filename || "base64", "txt"));
        await fsp.writeFile(target, encoded, "utf8");
        return {
          text: encoded.length > 4000 ? encoded.slice(0, 4000) + "…" : encoded,
          files: [{ path: target, name: path.basename(target), mime: "text/plain", size: Buffer.byteLength(encoded) }],
          summary: `Encoded ${formatBytesText(buf.length)} to ${encoded.length.toLocaleString()} Base64 characters.`,
        };
      }
      const cleaned = String(ctx.values.text || (ctx.files.length ? buf.toString("utf8") : ""))
        .replace(/\s+/g, "")
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
        throw Object.assign(new Error("That is not valid Base64 data"), { status: 422 });
      }
      const decoded = Buffer.from(cleaned, "base64");
      const isText = isProbablyText(decoded);
      const ext = isText ? "txt" : "bin";
      const target = ctx.out(ensureExt(ctx.values.filename || "decoded", ext));
      await fsp.writeFile(target, decoded);
      return {
        text: isText ? decoded.toString("utf8").slice(0, 4000) : `${decoded.length} binary bytes decoded.`,
        files: [
          {
            path: target,
            name: path.basename(target),
            mime: isText ? "text/plain" : "application/octet-stream",
            size: decoded.length,
          },
        ],
        summary: `Decoded ${decoded.length.toLocaleString()} bytes (${isText ? "text" : "binary"}).`,
      };
    },
  },

  "json-format": {
    category: "text",
    name: "JSON formatter",
    description: "Validate JSON and pretty-print it with configurable indentation.",
    keywords: ["json", "format", "validate", "pretty", "lint"],
    accept: ".json,.txt",
    minFiles: 0,
    maxFiles: 1,
    fields: [
      { name: "text", label: "JSON input (if no file)", type: "textarea", placeholder: '{"hello":"world"}' },
      {
        name: "indent",
        label: "Indentation",
        type: "select",
        options: [
          { value: "2", label: "2 spaces" },
          { value: "4", label: "4 spaces" },
          { value: "tab", label: "Tabs" },
          { value: "0", label: "Minified" },
        ],
        default: "2",
      },
      { name: "filename", label: "Output filename", type: "text", placeholder: "formatted.json" },
    ],
    async run(ctx) {
      const raw = await textFromCtx(ctx);
      if (!raw.trim()) throw Object.assign(new Error("Paste JSON or choose a .json file"), { status: 422 });
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw Object.assign(new Error("Invalid JSON: " + err.message), { status: 422 });
      }
      const indentChoice = ctx.values.indent ?? "2";
      const indent = indentChoice === "tab" ? "\t" : Number(indentChoice) || 0;
      const output = indent ? JSON.stringify(parsed, null, indent) : JSON.stringify(parsed);
      const target = ctx.out(ensureExt(ctx.values.filename || "formatted", "json"));
      await fsp.writeFile(target, output, "utf8");
      const type = Array.isArray(parsed) ? `array (${parsed.length})` : typeof parsed;
      return {
        text: output.length > 6000 ? output.slice(0, 6000) + "\n…" : output,
        files: [{ path: target, name: path.basename(target), mime: "application/json", size: Buffer.byteLength(output) }],
        summary: `Valid JSON · root is ${type}.`,
      };
    },
  },

  "csv-to-json": {
    category: "text",
    name: "CSV → JSON",
    description: "Convert comma-separated data into an array of JSON objects using the first row as keys.",
    keywords: ["csv", "json", "convert", "table", "data"],
    accept: ".csv,.txt",
    minFiles: 0,
    maxFiles: 1,
    fields: [
      { name: "text", label: "CSV input (if no file)", type: "textarea", placeholder: "name,age\nAda,36" },
      { name: "filename", label: "Output filename", type: "text", placeholder: "data.json" },
    ],
    async run(ctx) {
      const raw = await textFromCtx(ctx);
      if (!raw.trim()) throw Object.assign(new Error("Paste CSV data or choose a .csv file"), { status: 422 });
      const json = csvToJson(raw);
      const rows = JSON.parse(json);
      const target = ctx.out(ensureExt(ctx.values.filename || "data", "json"));
      await fsp.writeFile(target, json, "utf8");
      return {
        text: json.length > 6000 ? json.slice(0, 6000) + "\n…" : json,
        files: [{ path: target, name: path.basename(target), mime: "application/json", size: Buffer.byteLength(json) }],
        summary: `Converted ${rows.length} row(s) to JSON.`,
      };
    },
  },

  "regex-replace": {
    category: "text",
    name: "Regex find & replace",
    description: "Apply a JavaScript regular expression to text or a text file and download the result.",
    keywords: ["regex", "replace", "find", "text", "transform"],
    accept: ".txt,.md,.csv,.json,.html,.xml,.log,.srt,.vtt",
    minFiles: 0,
    maxFiles: 1,
    fields: [
      { name: "pattern", label: "Pattern", type: "text", placeholder: "\\s+", required: true },
      { name: "flags", label: "Flags", type: "text", placeholder: "g", default: "g" },
      { name: "replacement", label: "Replacement", type: "text", placeholder: " " },
      { name: "text", label: "Text input (if no file)", type: "textarea" },
      { name: "filename", label: "Output filename", type: "text", placeholder: "result.txt" },
    ],
    async run(ctx) {
      const source = await textFromCtx(ctx);
      if (!source && !ctx.files.length) throw Object.assign(new Error("Enter text or choose a file"), { status: 422 });
      let re;
      try {
        re = new RegExp(ctx.values.pattern, ctx.values.flags ?? "g");
      } catch (err) {
        throw Object.assign(new Error("Invalid regular expression: " + err.message), { status: 422 });
      }
      const output = source.replace(re, ctx.values.replacement ?? "");
      const originalName = ctx.files[0]?.name || "result.txt";
      const target = ctx.out(ctx.values.filename || originalName.replace(/(\.[a-z0-9]+)?$/i, "-edited$1"));
      await fsp.writeFile(target, output, "utf8");
      const matches = source.match(new RegExp(ctx.values.pattern, (ctx.values.flags || "g").replace(/g/g, "") + "g"));
      return {
        text: output.length > 5000 ? output.slice(0, 5000) + "…" : output,
        files: [{ path: target, name: path.basename(target), mime: "text/plain", size: Buffer.byteLength(output) }],
        summary: `Replaced ${matches ? matches.length : 0} match(es).`,
      };
    },
  },

  "text-stats": {
    category: "text",
    name: "Text statistics",
    description: "Count characters, words, lines, paragraphs and estimate reading time.",
    keywords: ["count", "words", "characters", "lines", "reading"],
    accept: ".txt,.md,.csv,.json,.html",
    minFiles: 0,
    maxFiles: 1,
    fields: [{ name: "text", label: "Text (if no file)", type: "textarea" }],
    async run(ctx) {
      const text = await textFromCtx(ctx);
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const lines = text ? text.split("\n").length : 0;
      const paragraphs = text.trim() ? text.trim().split(/\n{2,}/).length : 0;
      const chars = [...text].length;
      const charsNoSpaces = [...text.replace(/\s/g, "")].length;
      const reading = words / 200;
      const summary = [
        `Characters: ${chars.toLocaleString()}`,
        `Characters (no spaces): ${charsNoSpaces.toLocaleString()}`,
        `Words: ${words.toLocaleString()}`,
        `Lines: ${lines.toLocaleString()}`,
        `Paragraphs: ${paragraphs.toLocaleString()}`,
        `Reading time: ${reading < 1 ? Math.max(1, Math.round(reading * 60)) + " seconds" : reading.toFixed(1) + " minutes"}`,
      ].join("\n");
      return { text: summary, summary: `${words.toLocaleString()} words · ${chars.toLocaleString()} characters` };
    },
  },

  "markdown-to-html": {
    category: "text",
    name: "Markdown → HTML",
    description: "Render a Markdown document to a standalone, styled HTML page.",
    keywords: ["markdown", "md", "html", "render", "convert"],
    accept: ".md,.markdown,.txt",
    minFiles: 0,
    maxFiles: 1,
    fields: [
      { name: "text", label: "Markdown (if no file)", type: "textarea" },
      { name: "title", label: "Page title", type: "text", placeholder: "Document" },
      { name: "filename", label: "Output filename", type: "text", placeholder: "document.html" },
    ],
    async run(ctx) {
      const md = await textFromCtx(ctx);
      if (!md.trim()) throw Object.assign(new Error("Enter Markdown or choose a file"), { status: 422 });
      const rendered = await marked.parse(md, { gfm: true, breaks: false });
      const title = ctx.values.title || ctx.files[0]?.name?.replace(/\.(md|markdown|txt)$/i, "") || "Document";
      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { max-width: 760px; margin: 48px auto; padding: 0 24px; font: 16px/1.7 -apple-system, "Segoe UI", sans-serif; color: #1d1d1f; background: #fbfaf7; }
  h1,h2,h3 { line-height: 1.2; letter-spacing: -0.02em; }
  pre { background: #f3f1ec; padding: 16px; border-radius: 8px; overflow: auto; }
  code { font-family: ui-monospace, monospace; font-size: 0.92em; }
  blockquote { border-left: 3px solid #ff9500; margin-left: 0; padding-left: 16px; color: #6e6a64; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #e7e3da; padding: 8px; text-align: left; }
  img { max-width: 100%; }
  a { color: #b85c00; }
</style></head><body>
${rendered}
</body></html>`;
      const target = ctx.out(ensureExt(ctx.values.filename || "document", "html"));
      await fsp.writeFile(target, html, "utf8");
      return {
        files: [{ path: target, name: path.basename(target), mime: "text/html", size: Buffer.byteLength(html) }],
        summary: `Rendered Markdown to ${formatBytesText(Buffer.byteLength(html))} of HTML.`,
        preview: md.slice(0, 700),
      };
    },
  },

  "text-to-pdf": {
    category: "documents",
    name: "Text → PDF",
    description: "Typeset plain text into a paginated PDF with Helvetica and wrapped lines.",
    keywords: ["pdf", "text", "document", "convert", "typeset"],
    accept: ".txt,.md,.csv,.log",
    minFiles: 0,
    maxFiles: 1,
    fields: [
      { name: "text", label: "Text (if no file)", type: "textarea" },
      { name: "title", label: "Document title", type: "text", placeholder: "Untitled" },
      { name: "fontSize", label: "Font size", type: "number", default: 11, min: 7, max: 24 },
      { name: "filename", label: "Output filename", type: "text", placeholder: "document.pdf" },
    ],
    async run(ctx) {
      const text = await textFromCtx(ctx);
      if (!text.trim()) throw Object.assign(new Error("Enter text or choose a text file"), { status: 422 });
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const size = Number(ctx.values.fontSize) || 11;
      const leading = size * 1.5;
      const margin = 56;
      const pageW = 595.28;
      const pageH = 841.89;
      const maxW = pageW - margin * 2;
      const title = ctx.values.title || "Untitled";
      doc.setTitle(title);
      doc.setCreator("OmniGet Desktop");

      let page = doc.addPage([pageW, pageH]);
      let y = pageH - margin;
      page.drawText(sanitizePdfText(title), { x: margin, y, size: size + 6, font: bold, color: rgb(0.11, 0.11, 0.12) });
      y -= leading * 1.8;
      const replaced = { count: 0 };
      const lines = wrapText(text, font, size, maxW);
      for (const line of lines) {
        if (y < margin + leading) {
          page = doc.addPage([pageW, pageH]);
          y = pageH - margin;
        }
        const clean = sanitizePdfText(line, replaced);
        if (clean) page.drawText(clean, { x: margin, y, size, font, color: rgb(0.13, 0.13, 0.14) });
        y -= leading;
      }
      const target = ctx.out(ensureExt(ctx.values.filename || "document", "pdf"));
      const bytes = await doc.save();
      await fsp.writeFile(target, bytes);
      const note = replaced.count ? ` ${replaced.count} unsupported character(s) were replaced with “?”.` : "";
      return {
        files: [{ path: target, name: path.basename(target), mime: "application/pdf", size: bytes.length }],
        summary: `Typeset ${lines.length} lines into ${doc.getPageCount()} page(s).${note}`,
      };
    },
  },

  "uuid-generator": {
    category: "text",
    name: "UUID generator",
    description: "Generate cryptographically random v4 UUIDs for tests, databases or fixtures.",
    keywords: ["uuid", "guid", "random", "id", "generate"],
    accept: "",
    minFiles: 0,
    maxFiles: 0,
    fields: [
      { name: "count", label: "How many", type: "number", default: 5, min: 1, max: 1000 },
      { name: "uppercase", label: "Uppercase", type: "checkbox", default: false },
      { name: "noDashes", label: "Remove dashes", type: "checkbox", default: false },
    ],
    async run(ctx) {
      const count = Math.max(1, Math.min(1000, Number(ctx.values.count) || 5));
      const out = [];
      for (let i = 0; i < count; i += 1) {
        let id = crypto.randomUUID();
        if (ctx.values.noDashes) id = id.replace(/-/g, "");
        if (ctx.values.uppercase) id = id.toUpperCase();
        out.push(id);
      }
      const text = out.join("\n");
      const target = ctx.out("uuids.txt");
      await fsp.writeFile(target, text + "\n", "utf8");
      return {
        text,
        files: [{ path: target, name: "uuids.txt", mime: "text/plain", size: Buffer.byteLength(text) }],
        summary: `Generated ${count} UUID${count === 1 ? "" : "s"}.`,
      };
    },
  },

  "timestamp-converter": {
    category: "text",
    name: "Timestamp converter",
    description: "Convert Unix seconds, milliseconds and date strings into ISO, local and relative time.",
    keywords: ["timestamp", "unix", "epoch", "date", "iso", "time"],
    accept: "",
    minFiles: 0,
    maxFiles: 0,
    fields: [
      { name: "input", label: "Timestamp or date", type: "text", placeholder: "1735689600 or 2025-01-01T00:00:00Z", required: true },
    ],
    async run(ctx) {
      const raw = String(ctx.values.input || "").trim();
      let date;
      let kind;
      if (/^-?\d+(\.\d+)?$/.test(raw)) {
        const n = Number(raw);
        date = new Date(Math.abs(n) >= 1e12 ? n : n * 1000);
        kind = Math.abs(n) >= 1e12 ? "Unix milliseconds" : "Unix seconds";
      } else {
        date = new Date(raw);
        kind = "Date string";
      }
      if (Number.isNaN(date.getTime())) throw Object.assign(new Error("Could not parse that timestamp"), { status: 422 });
      const now = Date.now();
      const diff = Math.round((date.getTime() - now) / 1000);
      const rel = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
      const abs = Math.abs(diff);
      const relative = abs < 60 ? rel.format(diff, "second") : abs < 3600 ? rel.format(Math.round(diff / 60), "minute") : abs < 86400 ? rel.format(Math.round(diff / 3600), "hour") : rel.format(Math.round(diff / 86400), "day");
      const summary = [
        `Input: ${raw} (${kind})`,
        `Unix seconds: ${Math.floor(date.getTime() / 1000)}`,
        `Unix milliseconds: ${date.getTime()}`,
        `ISO 8601 (UTC): ${date.toISOString()}`,
        `Local: ${date.toString()}`,
        `Relative: ${relative}`,
      ].join("\n");
      return { text: summary, summary: date.toISOString() };
    },
  },

  "color-converter": {
    category: "text",
    name: "Color converter",
    description: "Convert a hex color to RGB, HSL and CSS values, with a preview swatch file.",
    keywords: ["color", "hex", "rgb", "hsl", "css", "design"],
    accept: "",
    minFiles: 0,
    maxFiles: 0,
    fields: [{ name: "color", label: "Hex color", type: "text", placeholder: "#FF9500", default: "#FF9500", required: true }],
    async run(ctx) {
      const rgb = hexToRgb(ctx.values.color);
      const hsl = rgbToHsl(rgb);
      const summary = `HEX: #${[rgb.r, rgb.g, rgb.b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()}\nRGB: rgb(${rgb.r}, ${rgb.g}, ${rgb.b})\nHSL: hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)\nCSS: rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#${[rgb.r, rgb.g, rgb.b].map((n) => n.toString(16).padStart(2, "0")).join("")}"/><rect x="24" y="300" width="352" height="76" rx="12" fill="rgba(0,0,0,.45)"/><text x="48" y="348" font-family="monospace" font-size="26" fill="#fff">#${[rgb.r, rgb.g, rgb.b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase()}</text></svg>`;
      const target = ctx.out("color-swatch.svg");
      await fsp.writeFile(target, svg, "utf8");
      return {
        text: summary,
        files: [{ path: target, name: "color-swatch.svg", mime: "image/svg+xml", size: Buffer.byteLength(svg) }],
        summary,
      };
    },
  },

  "jwt-decode": {
    category: "security",
    name: "JWT decoder",
    description: "Decode a JSON Web Token's header and payload locally and check its expiry.",
    keywords: ["jwt", "token", "decode", "auth", "security"],
    accept: "",
    minFiles: 0,
    maxFiles: 0,
    fields: [{ name: "token", label: "JWT", type: "textarea", required: true }],
    async run(ctx) {
      const decoded = decodeJwt(ctx.values.token);
      const summary = `Signature present: ${decoded.signature ? "yes" : "no"}\nExpires: ${decoded.expiresAt || "no exp claim"}${decoded.expired === null ? "" : decoded.expired ? " (EXPIRED)" : " (valid)"}\nIssued: ${decoded.issuedAt || "—"}\n\nHeader:\n${JSON.stringify(decoded.header, null, 2)}\n\nPayload:\n${JSON.stringify(decoded.payload, null, 2)}`;
      return { text: summary, json: decoded, summary: decoded.expired ? "Token is expired" : "Token decoded" };
    },
  },

  "url-codec": {
    category: "security",
    name: "URL encode / decode",
    description: "Percent-encode or decode text using encodeURIComponent.",
    keywords: ["url", "percent", "encode", "decode", "query"],
    accept: "",
    minFiles: 0,
    maxFiles: 0,
    fields: [
      {
        name: "mode",
        label: "Mode",
        type: "select",
        options: [
          { value: "encode", label: "Encode" },
          { value: "decode", label: "Decode" },
        ],
        default: "encode",
      },
      { name: "text", label: "Text", type: "textarea", required: true },
    ],
    async run(ctx) {
      const mode = ctx.values.mode || "encode";
      let output;
      try {
        output = mode === "encode" ? encodeURIComponent(ctx.values.text) : decodeURIComponent(ctx.values.text);
      } catch (err) {
        throw Object.assign(new Error("Invalid percent-encoding: " + err.message), { status: 422 });
      }
      return { text: output, summary: `${output.length} characters` };
    },
  },

  "line-tools": {
    category: "text",
    name: "Clean up lines",
    description: "Trim, sort, deduplicate and remove empty lines from a list.",
    keywords: ["lines", "sort", "dedupe", "unique", "trim", "text"],
    accept: ".txt,.csv,.log",
    minFiles: 0,
    maxFiles: 1,
    fields: [
      { name: "text", label: "Text (if no file)", type: "textarea" },
      { name: "sort", label: "Sort alphabetically", type: "checkbox", default: true },
      { name: "dedupe", label: "Remove duplicates", type: "checkbox", default: true },
      { name: "trim", label: "Trim whitespace", type: "checkbox", default: true },
      { name: "removeEmpty", label: "Remove empty lines", type: "checkbox", default: true },
      { name: "filename", label: "Output filename", type: "text", placeholder: "lines.txt" },
    ],
    async run(ctx) {
      const raw = await textFromCtx(ctx);
      let lines = raw.split("\n");
      if (ctx.values.trim !== false) lines = lines.map((l) => l.trim());
      if (ctx.values.removeEmpty !== false) lines = lines.filter((l) => l !== "");
      if (ctx.values.dedupe !== false) lines = [...new Set(lines)];
      if (ctx.values.sort !== false) lines.sort((a, b) => a.localeCompare(b));
      const output = lines.join("\n");
      const target = ctx.out(ctx.values.filename || "lines.txt");
      await fsp.writeFile(target, output, "utf8");
      return {
        text: output.slice(0, 4000),
        files: [{ path: target, name: path.basename(target), mime: "text/plain", size: Buffer.byteLength(output) }],
        summary: `${lines.length} line(s) after cleanup.`,
      };
    },
  },

  "file-info": {
    category: "files",
    name: "File information",
    description: "Inspect size, type and a SHA-256 fingerprint, with a hex preview of the first bytes.",
    keywords: ["file", "info", "mime", "hash", "magic", "forensics"],
    accept: "",
    minFiles: 1,
    maxFiles: 1,
    fields: [],
    async run(ctx) {
      const file = ctx.files[0];
      const stat = await fsp.stat(file.path);
      const buf = await fsp.readFile(file.path);
      const head = buf.subarray(0, 32);
      const summary = [
        `Name: ${file.name}`,
        `Size: ${stat.size.toLocaleString()} bytes (${formatBytesText(stat.size)})`,
        `Type: ${mimeFromName(file.name)}`,
        `SHA-256: ${hashBuffer(buf)}`,
        `SHA-1: ${hashBuffer(buf, "sha1")}`,
        `MD5: ${hashBuffer(buf, "md5")}`,
        `First bytes (hex): ${head.toString("hex").replace(/(..)/g, "$1 ").trim()}`,
        `Head (ascii): ${head.toString("latin1").replace(/[^\x20-\x7e]/g, ".")}`,
        `Text-like: ${isProbablyText(buf) ? "yes" : "no"}`,
      ].join("\n");
      return { text: summary, summary: `${formatBytesText(stat.size)} · ${mimeFromName(file.name)}` };
    },
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function sanitizePdfText(text, counter = null) {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === "\t") {
      out += "    ";
    } else if (code >= 32 && code <= 255) {
      out += ch;
    } else if (code > 255) {
      if (!/\s/.test(ch)) counter && (counter.count += 1);
      out += /\s/.test(ch) ? " " : "?";
    }
  }
  return out;
}

function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const rawLine of normalizeText(text).split("\n")) {
    if (!rawLine.trim()) {
      lines.push("");
      continue;
    }
    const words = rawLine.split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? line + " " + word : word;
      let width;
      try {
        width = font.widthOfTextAtSize(sanitizePdfText(candidate), size);
      } catch {
        width = candidate.length * size * 0.5;
      }
      if (width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else if (width > maxWidth && !line) {
        // Long unbroken token: split it.
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}
