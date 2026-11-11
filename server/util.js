import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DATA_DIR = path.resolve(
  process.env.OMNIGET_DATA_DIR || path.join(ROOT, "data"),
);
export const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");
export const LIBRARY_DIR = path.join(DATA_DIR, "library");
export const OUTPUTS_DIR = path.join(DATA_DIR, "outputs");
export const TMP_DIR = path.join(DATA_DIR, "tmp");
export const DB_PATH = path.join(DATA_DIR, "omniget.db");
export const CLIENT_DIR = path.join(ROOT, "dist");

export function ensureDirs() {
  for (const dir of [DATA_DIR, DOWNLOADS_DIR, LIBRARY_DIR, OUTPUTS_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const now = () => Date.now();
export const uid = (prefix = "") => prefix + crypto.randomUUID();

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function safeName(input, fallback = "file") {
  let name = String(input || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 180);
  if (!name) name = fallback;
  return name;
}

export function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

export function assertInside(parent, child) {
  const rel = path.relative(parent, path.resolve(child));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw Object.assign(new Error("Path escapes the application data directory"), {
      status: 400,
    });
  }
  return path.resolve(child);
}

export function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function error(res, status, message, extra = {}) {
  json(res, status, { error: message, ...extra });
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error("Request body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("Invalid JSON body");
    err.status = 400;
    throw err;
  }
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

const MIME_BY_EXT = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".ts": "video/mp2t",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".zip": "application/zip",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
};

export function mimeFromName(name, fallback = "application/octet-stream") {
  return MIME_BY_EXT[path.extname(String(name || "")).toLowerCase()] || fallback;
}

export function extFromMime(mime) {
  const found = Object.entries(MIME_BY_EXT).find(([, m]) => m.split(";")[0] === mime);
  return found ? found[0] : "";
}

const EXT_KIND = {
  ".mp4": "video",
  ".m4v": "video",
  ".webm": "video",
  ".mkv": "video",
  ".mov": "video",
  ".avi": "video",
  ".ts": "video",
  ".mp3": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".flac": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".opus": "audio",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
  ".gif": "image",
  ".avif": "image",
  ".svg": "image",
};

export function classifyMime(mime, name = "") {
  const m = String(mime || "").split(";")[0].toLowerCase();
  const ext = path.extname(String(name || "")).toLowerCase();
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("image/")) return "image";
  if ((!m || m === "application/octet-stream" || m === "binary/octet-stream") && EXT_KIND[ext]) {
    return EXT_KIND[ext];
  }
  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (m === "application/epub+zip" || ext === ".epub") return "ebook";
  if (m === "application/vnd.apple.mpegurl" || m === "application/x-mpegurl" || ext === ".m3u8") return "hls";
  if (m === "application/dash+xml" || ext === ".mpd") return "dash";
  if (/zip|tar|rar|7z|gzip|bzip/.test(m) || /\.(zip|rar|7z|tar|gz|bz2|xz)$/.test(ext)) return "archive";
  if (m === "text/html" || ext === ".html" || ext === ".htm") return "page";
  return "other";
}

export function humanDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export async function pathExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host.startsWith("fe80:")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^0\./.test(host)) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  return false;
}

export function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
