import fsp from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { ensureExt, formatBytesText } from "./helpers.js";

function uniqueEntryName(name, used) {
  const base = path.basename(name).replace(/[/\\]/g, "_") || "file";
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const ext = path.extname(base);
    candidate = `${path.basename(base, ext)} (${i})${ext}`;
    i += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export const archiveTools = {
  "zip-create": {
    category: "archives",
    name: "Create ZIP archive",
    description: "Package one or more files into a compressed ZIP archive.",
    keywords: ["zip", "archive", "compress", "package", "files"],
    accept: "",
    minFiles: 1,
    maxFiles: 200,
    fields: [{ name: "filename", label: "Archive name", type: "text", placeholder: "archive.zip" }],
    async run(ctx) {
      const zip = new JSZip();
      const used = new Set();
      let total = 0;
      for (const file of ctx.files) {
        const name = uniqueEntryName(file.name, used);
        const buf = await fsp.readFile(file.path);
        total += buf.length;
        zip.file(name, buf);
      }
      const target = ctx.out(ensureExt(ctx.values.filename || "archive", "zip"));
      const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
      await fsp.writeFile(target, buf);
      return {
        files: [{ path: target, name: path.basename(target), mime: "application/zip", size: buf.length }],
        summary: `Archived ${ctx.files.length} file(s) (${formatBytesText(total)}) into ${formatBytesText(buf.length)}.`,
      };
    },
  },

  "zip-list": {
    category: "archives",
    name: "List ZIP contents",
    description: "Inspect an archive without extracting it, including paths and uncompressed sizes.",
    keywords: ["zip", "list", "contents", "inspect", "archive"],
    accept: ".zip",
    minFiles: 1,
    maxFiles: 1,
    fields: [],
    async run(ctx) {
      const zip = await JSZip.loadAsync(await fsp.readFile(ctx.files[0].path));
      const entries = Object.values(zip.files);
      const files = entries.filter((e) => !e.dir);
      const dirs = entries.filter((e) => e.dir);
      const lines = files
        .slice(0, 1000)
        .map((f) => `${formatBytesText(f._data?.uncompressedSize || 0).padStart(10)}  ${f.name}`)
        .join("\n");
      const text = `${files.length} file(s), ${dirs.length} folder(s)\n\n${lines}${files.length > 1000 ? "\n… more entries omitted" : ""}`;
      return { text, summary: `${files.length} file(s) in archive` };
    },
  },

  "zip-extract": {
    category: "archives",
    name: "Extract ZIP files",
    description: "Extract all or selected entries from a ZIP archive as downloadable files.",
    keywords: ["zip", "extract", "unzip", "archive", "files"],
    accept: ".zip",
    minFiles: 1,
    maxFiles: 1,
    fields: [
      { name: "entries", label: "Entries (comma separated)", type: "text", placeholder: "blank = all files" },
    ],
    async run(ctx) {
      const zip = await JSZip.loadAsync(await fsp.readFile(ctx.files[0].path));
      const all = Object.values(zip.files).filter((entry) => !entry.dir);
      let selected = all;
      const query = String(ctx.values.entries || "").trim();
      if (query) {
        const wanted = query.split(",").map((s) => s.trim()).filter(Boolean);
        selected = all.filter((entry) => wanted.some((w) => entry.name === w || entry.name.endsWith("/" + w) || entry.name.includes(w)));
      }
      if (!selected.length) throw Object.assign(new Error("No matching entries were found in the archive"), { status: 422 });
      if (selected.length > 200) throw Object.assign(new Error("Too many entries selected (limit 200)"), { status: 422 });
      let bytes = 0;
      const outputs = [];
      for (const entry of selected) {
        const normalized = path.posix.normalize(entry.name).replace(/^(\.\.\/)+/, "");
        const safeRel = normalized.split("/").filter((s) => s && s !== "..").join("/");
        const target = ctx.out(path.join("extracted", safeRel || path.basename(entry.name)));
        const buf = await entry.async("nodebuffer");
        if (buf.length > 100 * 1024 * 1024) {
          throw Object.assign(new Error(`Entry “${entry.name}” is larger than the 100 MB per-file limit`), { status: 413 });
        }
        bytes += buf.length;
        if (bytes > 500 * 1024 * 1024) {
          throw Object.assign(new Error("Selected archive entries exceed the 500 MB extraction limit"), { status: 413 });
        }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, buf);
        outputs.push({
          path: target,
          name: path.basename(entry.name),
          mime: guessMime(entry.name),
          size: buf.length,
          rel: path.join("extracted", safeRel),
        });
      }
      return {
        files: outputs,
        summary: `Extracted ${outputs.length} file(s) (${formatBytesText(bytes)}).`,
      };
    },
  },
};

function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    ".txt": "text/plain",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".srt": "application/x-subrip",
    ".vtt": "text/vtt",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
  };
  return map[ext] || "application/octet-stream";
}
