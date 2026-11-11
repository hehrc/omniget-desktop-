import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { safeName } from "../util.js";

export function normalizeText(input) {
  return String(input ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export async function readText(filePath, limit = 30 * 1024 * 1024) {
  const stat = await fsp.stat(filePath);
  if (stat.size > limit) {
    const err = new Error(`Text file is too large (${stat.size} bytes; limit ${limit})`);
    err.status = 413;
    throw err;
  }
  const buf = await fsp.readFile(filePath);
  return normalizeText(buf.toString("utf8"));
}

export function parsePageRange(value, totalPages) {
  const text = String(value || "").trim();
  if (!text) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set();
  for (const part of text.split(",")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const m = chunk.match(/^(\d+)\s*(?:-\s*(\d+)?)?$/);
    if (!m) {
      const err = new Error(`Invalid page selection: “${chunk}”`);
      err.status = 422;
      throw err;
    }
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (start < 1 || end < start) {
      const err = new Error(`Invalid page range: “${chunk}”`);
      err.status = 422;
      throw err;
    }
    for (let p = start; p <= Math.min(end, totalPages); p += 1) pages.add(p);
  }
  if (!pages.size) {
    const err = new Error("No pages matched the selection");
    err.status = 422;
    throw err;
  }
  return [...pages].sort((a, b) => a - b);
}

export function hashBuffer(buf, algorithm = "sha256") {
  return crypto.createHash(algorithm).update(buf).digest("hex");
}

export function formatBytesText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function htmlToText(html) {
  const $ = cheerio.load(String(html || ""), { xmlMode: false });
  $("script, style, noscript").remove();
  $("br").replaceWith("\n");
  $("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, section, article").each((_, el) => {
    $(el).append("\n");
  });
  const text = $("body").length ? $("body").text() : $.root().text();
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function safeOutputName(name, fallback = "output.txt") {
  const base = safeName(name || fallback, fallback);
  return base || fallback;
}

export function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseCsv(text) {
  const lines = normalizeText(text).split("\n").filter((l, i, arr) => l.trim() !== "" || i < arr.length - 1);
  const rows = [];
  let buffer = "";
  let quoted = false;
  for (const line of lines) {
    buffer += (buffer ? "\n" : "") + line;
    const quotes = (buffer.match(/"/g) || []).length;
    quoted = quotes % 2 !== 0;
    if (quoted) continue;
    rows.push(splitCsvLine(buffer));
    buffer = "";
  }
  if (buffer) rows.push(splitCsvLine(buffer));
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h || `column_${i + 1}`] = cells[i] ?? "";
    });
    return obj;
  });
}

export function csvToJson(text) {
  const rows = parseCsv(text);
  return JSON.stringify(rows, null, 2);
}

export function hexToRgb(hex) {
  let h = String(hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) {
    throw Object.assign(new Error("Expected a hex color such as #FF9500"), { status: 422 });
  }
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function rgbToHsl({ r, g, b }) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function decodeJwt(token) {
  const parts = String(token || "").trim().split(".");
  if (parts.length < 2) {
    throw Object.assign(new Error("That does not look like a JWT (expected header.payload.signature)"), {
      status: 422,
    });
  }
  const decode = (part) => {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  };
  const header = decode(parts[0]);
  const payload = decode(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  const expires = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  return {
    header,
    payload,
    signature: parts[2] || null,
    expired: payload.exp ? payload.exp < now : null,
    expiresAt: expires,
    issuedAt: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
  };
}

export async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export function ensureExt(name, ext) {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, "");
  return `${base}.${ext.replace(/^\./, "")}`;
}

export function isProbablyText(buf) {
  const sample = buf.subarray(0, 4096);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}
