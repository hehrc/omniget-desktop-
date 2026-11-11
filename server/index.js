import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import {
  CLIENT_DIR,
  DATA_DIR,
  DOWNLOADS_DIR,
  LIBRARY_DIR,
  TMP_DIR,
  DB_PATH,
  ensureDirs,
  error,
  json,
  mimeFromName,
  now,
  readJson,
  safeName,
  sseWrite,
  uid,
} from "./util.js";
import {
  BookRepo,
  BookmarkRepo,
  DownloadRepo,
  MediaRepo,
  NoteRepo,
  ToolJobRepo,
  addStudySeconds,
  db,
  getStats,
} from "./db.js";
import { getSettings, updateSettings, resetSettings, exportSettings, importSettings, dataPaths, ensureDownloadDir } from "./settings.js";
import { DownloadManager } from "./downloader.js";
import { probeUrl, supportedSourceList } from "./probe.js";
import { systemTools } from "./bins.js";
import { listTools } from "./tools/registry.js";
import { runTool, outputPath, cleanupJobs } from "./tools/runner.js";
import {
  deleteBook,
  getBookDetail,
  importBookFile,
  readBookAsset,
  readChapter,
  updateProgress,
} from "./books.js";
import {
  addSubtitle,
  deleteMedia,
  deleteSubtitle,
  getMedia,
  getSubtitle,
  importMediaFile,
  listMedia,
  updateMediaPosition,
} from "./library.js";

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "127.0.0.1";
const APP_VERSION = "1.0.0";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

ensureDirs();

/* ------------------------------- SSE hub -------------------------------- */

const clients = new Set();

function broadcast(event, data) {
  for (const res of clients) {
    try {
      sseWrite(res, event, data);
    } catch {
      clients.delete(res);
    }
  }
}

/* ------------------------------- helpers -------------------------------- */

function apiError(res, err, context = "") {
  const status = Number(err?.status) || 500;
  if (status >= 500) console.error(`[api] ${context}:`, err);
  if (!res.headersSent) {
    json(res, status, {
      error: err?.message || "Unexpected server error",
      code: err?.code || undefined,
      ...(err?.probe ? { probe: err.probe } : {}),
      ...(err?.jobId ? { jobId: err.jobId } : {}),
    });
  } else {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseMultipart(req, { maxFiles = 60, maxFileSize = 300 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: maxFiles, fileSize: maxFileSize, fields: 100, fieldSize: 4 * 1024 * 1024 } });
    } catch (err) {
      reject(httpError(400, "Expected a multipart/form-data request"));
      return;
    }
    const fields = {};
    const files = [];
    const writes = [];
    let aborted = false;
    bb.on("field", (name, value) => {
      if (fields[name] !== undefined) {
        if (Array.isArray(fields[name])) fields[name].push(value);
        else fields[name] = [fields[name], value];
      } else {
        fields[name] = value;
      }
    });
    bb.on("file", (name, stream, info) => {
      if (!info || !info.filename) {
        stream.resume();
        return;
      }
      const original = safeName(path.basename(info.filename), "upload");
      const tmp = path.join(TMP_DIR, "uploads", `${uid("up_")}-${original}`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      const ws = fs.createWriteStream(tmp);
      const promise = new Promise((resolveWrite, rejectWrite) => {
        let size = 0;
        stream.on("data", (chunk) => {
          size += chunk.length;
        });
        stream.on("limit", () => {
          aborted = true;
          ws.destroy();
          rejectWrite(httpError(413, `“${original}” exceeds the ${Math.round(maxFileSize / 1024 / 1024)} MB upload limit`));
        });
        stream.on("error", rejectWrite);
        ws.on("error", rejectWrite);
        ws.on("finish", () => {
          resolveWrite({
            field: name,
            path: tmp,
            name: original,
            mime: info.mimeType || mimeFromName(original),
            size,
          });
        });
        stream.pipe(ws);
      });
      writes.push(promise);
    });
    bb.on("close", async () => {
      try {
        const uploaded = await Promise.all(writes);
        if (aborted) throw httpError(413, "Upload limit exceeded");
        files.push(...uploaded);
        resolve({ fields, files });
      } catch (err) {
        reject(err);
      }
    });
    bb.on("error", (err) => reject(httpError(400, "Could not parse the upload: " + err.message)));
    req.pipe(bb);
  });
}

async function parseBody(req) {
  const type = String(req.headers["content-type"] || "");
  if (type.includes("multipart/form-data")) {
    return { ...(await parseMultipart(req)), isMultipart: true };
  }
  const data = await readJson(req);
  return { fields: data, files: [], isMultipart: false };
}

function serveFile(req, res, filePath, { mime, downloadName, inline = false, cache = "no-store" } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    error(res, 404, "File not found on disk");
    return;
  }
  if (!stat.isFile()) {
    error(res, 404, "Not a file");
    return;
  }
  const contentType = mime || mimeFromName(filePath);
  const name = downloadName || path.basename(filePath);
  // HTTP header values are byte strings. Keep a printable ASCII fallback for
  // legacy clients and send the real UTF-8 name in filename*.
  const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const headers = {
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": cache,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
  };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (m[1] === "" && m[2] === "")) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    let start;
    let end;
    if (m[1] === "") {
      const suffix = Number(m[2]);
      start = Math.max(0, stat.size - suffix);
      end = stat.size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
    headers["content-length"] = end - start + 1;
    res.writeHead(206, headers);
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return;
  }
  headers["content-length"] = stat.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function revealInFileManager(target) {
  return new Promise((resolve) => {
    let command;
    let args;
    if (process.platform === "darwin") {
      command = "open";
      args = ["-R", target];
    } else if (process.platform === "win32") {
      command = "explorer.exe";
      args = ["/select,", target];
    } else {
      command = "xdg-open";
      args = [fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target)];
    }
    let settled = false;
    const done = (opened, detail) => {
      if (settled) return;
      settled = true;
      resolve({ opened, path: target, detail });
    };
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.on("error", (err) => done(false, err.message));
      child.unref();
      setTimeout(() => done(true, null), 400);
    } catch (err) {
      done(false, err.message);
    }
  });
}

/* ------------------------------- server --------------------------------- */

const manager = new DownloadManager({ broadcast });
const startedAt = Date.now();

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return error(res, 400, "Bad request URL");
  }
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || "GET";

  try {
    if (!pathname.startsWith("/api/")) {
      return serveStatic(req, res, pathname);
    }

    /* ---------------------------- system ---------------------------- */
    if (pathname === "/api/health" && method === "GET") {
      return json(res, 200, { ok: true, version: APP_VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
    }

    if (pathname === "/api/system" && method === "GET") {
      const tools = await systemTools();
      const settings = getSettings();
      const storage = await dataSize();
      return json(res, 200, {
        version: APP_VERSION,
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          host: os.hostname(),
          pid: process.pid,
        },
        paths: { data: DATA_DIR, downloads: settings.download.directory || DOWNLOADS_DIR, library: LIBRARY_DIR, database: DB_PATH },
        tools: {
          ffmpeg: tools.ffmpeg,
          ffprobe: tools.ffprobe,
          ytdlp: tools.ytdlp,
          proxyTransport: true,
        },
        capabilities: {
          directHttp: true,
          hls: true,
          dash: false,
          pageExtraction: tools.ytdlp.available,
          encryptedStreams: false,
          mediaTranscode: tools.ffmpeg.available,
          proxy: true,
          rangeRequests: true,
        },
        storage,
        startedAt,
      });
    }

    if (pathname === "/api/stats" && method === "GET") {
      return json(res, 200, getStats());
    }

    /* ---------------------------- events ---------------------------- */
    if (pathname === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      clients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(heartbeat);
          clients.delete(res);
        }
      }, 25_000);
      sseWrite(res, "snapshot", { counts: DownloadRepo.counts(), at: Date.now() });
      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    /* --------------------------- settings --------------------------- */
    if (pathname === "/api/settings" && method === "GET") {
      return json(res, 200, { settings: getSettings(), paths: dataPaths() });
    }
    if (pathname === "/api/settings" && method === "PUT") {
      const body = await readJson(req);
      const patch = body.settings || body;
      if (patch.download?.directory) {
        const dir = path.resolve(String(patch.download.directory));
        try {
          fs.mkdirSync(dir, { recursive: true });
          const st = fs.statSync(dir);
          if (!st.isDirectory()) throw new Error("not a directory");
          fs.accessSync(dir, fs.constants.W_OK);
          patch.download.directory = dir;
        } catch (err) {
          throw httpError(422, `The download folder is not usable: ${err.message}`);
        }
      }
      if (patch.download?.cookiesFile) {
        const file = path.resolve(String(patch.download.cookiesFile));
        try {
          const st = fs.statSync(file);
          if (!st.isFile()) throw new Error("not a file");
          fs.accessSync(file, fs.constants.R_OK);
          patch.download.cookiesFile = file;
        } catch (err) {
          throw httpError(422, `The cookies file is not readable: ${err.message}`);
        }
      }
      if (patch.download?.cookiesFile === "") {
        patch.download.cookiesFile = "";
      }
      const settings = updateSettings(patch);
      if (settings.download?.directory) {
        try {
          fs.mkdirSync(settings.download.directory, { recursive: true });
        } catch {
          /* reported above */
        }
      }
      broadcast("settings", settings);
      manager.pump();
      return json(res, 200, { settings, paths: dataPaths() });
    }
    if (pathname === "/api/settings/reset" && method === "POST") {
      const settings = resetSettings();
      broadcast("settings", settings);
      return json(res, 200, { settings, paths: dataPaths() });
    }
    if (pathname === "/api/settings/export" && method === "GET") {
      const includeSecrets = url.searchParams.get("secrets") === "1";
      return json(res, 200, exportSettings({ includeSecrets }), {
        "content-disposition": 'attachment; filename="omniget-settings.json"',
      });
    }
    if (pathname === "/api/settings/import" && method === "POST") {
      const body = await readJson(req);
      const settings = importSettings(body);
      broadcast("settings", settings);
      return json(res, 200, { settings, paths: dataPaths() });
    }
    if (pathname === "/api/settings/test-ai" && method === "POST") {
      const settings = getSettings();
      if (!settings.ai.apiKey) throw httpError(409, "Add an API key first");
      const base = settings.ai.baseUrl.replace(/\/+$/, "");
      const endpoint = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
      let res2;
      try {
        res2 = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${settings.ai.apiKey}` },
          body: JSON.stringify({
            model: settings.ai.model,
            messages: [{ role: "user", content: "Reply with exactly: OK" }],
            max_tokens: 5,
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw httpError(502, "Could not reach the AI endpoint: " + err.message);
      }
      const text = await res2.text();
      if (!res2.ok) throw httpError(502, `AI endpoint returned HTTP ${res2.status}: ${text.slice(0, 300)}`);
      let reply = text;
      try {
        reply = JSON.parse(text)?.choices?.[0]?.message?.content || text;
      } catch {
        /* keep raw */
      }
      return json(res, 200, { ok: true, reply: String(reply).slice(0, 200) });
    }

    /* --------------------------- sources ---------------------------- */
    if (pathname === "/api/sources" && method === "GET") {
      const tools = await systemTools();
      return json(res, 200, {
        sources: supportedSourceList({
          ytdlp: tools.ytdlp.available,
          ffmpeg: tools.ffmpeg.available,
        }),
        extractor: { available: tools.ytdlp.available, version: tools.ytdlp.version },
        ffmpeg: { available: tools.ffmpeg.available, version: tools.ffmpeg.version },
      });
    }

    /* ---------------------------- probe ----------------------------- */
    if (pathname === "/api/probe" && method === "POST") {
      const body = await readJson(req);
      if (!body.url) throw httpError(400, "A link is required");
      const result = await probeUrl(body.url);
      return json(res, 200, result);
    }

    /* -------------------------- downloads --------------------------- */
    if (pathname === "/api/downloads" && method === "GET") {
      const status = url.searchParams.get("status") || "all";
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      return json(res, 200, {
        downloads: DownloadRepo.list({ status, limit }),
        counts: DownloadRepo.counts(),
      });
    }

    if (pathname === "/api/downloads" && method === "POST") {
      const body = await readJson(req);
      if (!body.url) throw httpError(400, "A link is required");
      const download = await manager.create({
        url: body.url,
        options: {
          quality: body.quality,
          title: body.title,
          formatId: body.formatId,
          selector: body.selector,
          height: body.height,
        },
      });
      return json(res, 201, download);
    }

    if (pathname === "/api/downloads/bulk" && method === "POST") {
      const body = await readJson(req);
      const urls = Array.isArray(body.urls) ? body.urls.slice(0, 50) : [];
      if (!urls.length) throw httpError(400, "No links were provided");
      const results = [];
      for (const link of urls) {
        try {
          const download = await manager.create({ url: link, options: body.options || {} });
          results.push({ url: link, ok: true, download });
        } catch (err) {
          results.push({ url: link, ok: false, error: err.message });
        }
      }
      return json(res, 200, { results });
    }

    if (pathname === "/api/history" && method === "GET") {
      const downloads = DownloadRepo.list({ status: "finished", limit: 500 });
      return json(res, 200, { downloads, counts: DownloadRepo.counts() });
    }
    if (pathname === "/api/history" && method === "DELETE") {
      const body = await readJson(req).catch(() => ({}));
      const rows = DownloadRepo.list({ status: "finished", limit: 1000 });
      for (const row of rows) {
        if (body.deleteFiles && row.filePath) {
          try {
            fs.rmSync(row.filePath, { force: true });
          } catch {
            /* ignore */
          }
        }
        DownloadRepo.remove(row.id);
      }
      broadcast("history-cleared", { count: rows.length });
      broadcast("stats", DownloadRepo.counts());
      return json(res, 200, { removed: rows.length });
    }

    const dlMatch = pathname.match(/^\/api\/downloads\/([^/]+)(?:\/(file|logs|pause|resume|cancel|retry|reveal|outputs))?$/);
    if (dlMatch) {
      const [, id, action] = dlMatch;
      if (!action && method === "GET") {
        const info = await manager.fileInfo(id);
        return json(res, 200, info);
      }
      if (!action && method === "DELETE") {
        const deleteFile = url.searchParams.get("deleteFile") === "1";
        return json(res, 200, await manager.remove(id, { deleteFile }));
      }
      if (action === "file" && method === "GET") {
        const row = DownloadRepo.get(id);
        if (!row) throw httpError(404, "Download not found");
        if (!row.filePath || !fs.existsSync(row.filePath)) {
          throw httpError(410, "The file is no longer on disk. Retry the download or remove the record.");
        }
        return serveFile(req, res, row.filePath, {
          mime: row.mime,
          downloadName: row.filename,
          inline: url.searchParams.get("download") !== "1",
          cache: "private, max-age=0",
        });
      }
      if (action === "logs" && method === "GET") {
        if (!DownloadRepo.get(id)) throw httpError(404, "Download not found");
        return json(res, 200, { logs: DownloadRepo.logs(id) });
      }
      if (action === "outputs" && method === "GET") {
        const rows = db.prepare("SELECT * FROM download_outputs WHERE download_id = ?").all(id);
        return json(res, 200, { outputs: rows.map((r) => ({ id: r.id, path: r.path, mime: r.mime, size: r.size, label: r.label })) });
      }
      if (action === "pause" && method === "POST") return json(res, 200, manager.pause(id));
      if (action === "resume" && method === "POST") return json(res, 200, manager.resume(id));
      if (action === "cancel" && method === "POST") return json(res, 200, await manager.cancel(id));
      if (action === "retry" && method === "POST") return json(res, 200, await manager.retry(id));
      if (action === "reveal" && method === "POST") {
        const row = DownloadRepo.get(id);
        if (!row) throw httpError(404, "Download not found");
        const result = await revealInFileManager(row.filePath || row.partPath || DATA_DIR);
        return json(res, 200, result);
      }
    }

    /* ----------------------------- media ---------------------------- */
    if (pathname === "/api/media" && method === "GET") {
      return json(res, 200, { media: listMedia() });
    }
    if (pathname === "/api/media/import" && method === "POST") {
      const { files } = await parseMultipart(req, { maxFiles: 20 });
      if (!files.length) throw httpError(400, "Choose at least one audio or video file");
      const imported = [];
      for (const file of files) {
        const media = await importMediaFile(file.path, { originalName: file.name });
        imported.push(media);
        broadcast("media-added", media);
      }
      return json(res, 201, { media: imported.map((m) => getMedia(m.id)) });
    }

    const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)(?:\/(file|subtitles)(?:\/([^/]+))?)?$/);
    if (mediaMatch) {
      const [, id, action, subId] = mediaMatch;
      if (!action && method === "GET") return json(res, 200, { media: getMedia(id) });
      if (!action && method === "PATCH") {
        const body = await readJson(req);
        const media = await updateMediaPosition(id, body);
        broadcast("media-updated", media);
        return json(res, 200, media);
      }
      if (!action && method === "DELETE") {
        return json(res, 200, await deleteMedia(id, { deleteFile: url.searchParams.get("deleteFile") !== "0" }));
      }
      if (action === "file" && method === "GET") {
        const media = MediaRepo.get(id);
        if (!media) throw httpError(404, "Media item not found");
        if (!fs.existsSync(media.path)) throw httpError(410, "The media file is missing from disk");
        return serveFile(req, res, media.path, { mime: media.mime, downloadName: path.basename(media.path), inline: true, cache: "private, max-age=0" });
      }
      if (action === "subtitles" && !subId && method === "GET") {
        return json(res, 200, { subtitles: MediaRepo.subtitles(id) });
      }
      if (action === "subtitles" && !subId && method === "POST") {
        const { fields, files } = await parseMultipart(req, { maxFiles: 1, maxFileSize: 8 * 1024 * 1024 });
        if (!files.length) throw httpError(400, "Choose an SRT or VTT file");
        const sub = await addSubtitle(id, files[0].path, {
          label: fields.label || null,
          lang: fields.lang || null,
          originalName: files[0].name,
        });
        return json(res, 201, sub);
      }
      if (action === "subtitles" && subId && method === "GET") {
        const sub = getSubtitle(id, subId);
        if (!fs.existsSync(sub.path)) throw httpError(404, "Subtitle file missing");
        return serveFile(req, res, sub.path, { mime: "text/vtt; charset=utf-8", downloadName: sub.label + ".vtt", inline: true });
      }
      if (action === "subtitles" && subId && method === "DELETE") {
        return json(res, 200, await deleteSubtitle(id, subId));
      }
    }

    /* ----------------------------- books ---------------------------- */
    if (pathname === "/api/books" && method === "GET") {
      return json(res, 200, { books: BookRepo.list() });
    }
    if (pathname === "/api/books/import" && method === "POST") {
      const { files } = await parseMultipart(req, { maxFiles: 10, maxFileSize: 300 * 1024 * 1024 });
      if (!files.length) throw httpError(400, "Choose a PDF or EPUB file");
      const imported = [];
      for (const file of files) {
        const book = await importBookFile(file.path, { originalName: file.name });
        imported.push(getBookDetail(book.id));
        broadcast("book-added", book);
      }
      return json(res, 201, { books: imported });
    }

    const bookMatch = pathname.match(/^\/api\/books\/([^/]+)(?:\/(chapter|asset|cover|file|bookmarks)(?:\/([^/]+))?)?$/);
    if (bookMatch) {
      const [, id, action, extra] = bookMatch;
      if (!action && method === "GET") return json(res, 200, getBookDetail(id));
      if (!action && method === "PATCH") {
        const body = await readJson(req);
        const book = updateProgress(id, body);
        broadcast("book-updated", book);
        return json(res, 200, book);
      }
      if (!action && method === "DELETE") {
        return json(res, 200, await deleteBook(id, { deleteFiles: url.searchParams.get("deleteFiles") !== "0" }));
      }
      if (action === "chapter" && method === "GET") {
        return json(res, 200, await readChapter(id, Number(extra)));
      }
      if (action === "asset" && method === "GET") {
        const asset = await readBookAsset(id, url.searchParams.get("path"));
        res.writeHead(200, { "content-type": asset.mime, "cache-control": "private, max-age=3600" });
        return res.end(asset.data);
      }
      if (action === "cover" && method === "GET") {
        const book = BookRepo.get(id);
        if (!book?.coverPath || !fs.existsSync(book.coverPath)) throw httpError(404, "No cover available");
        return serveFile(req, res, book.coverPath, { mime: book.coverMime || undefined, downloadName: "cover", inline: true, cache: "private, max-age=86400" });
      }
      if (action === "file" && method === "GET") {
        const book = BookRepo.get(id);
        if (!book || !fs.existsSync(book.path)) throw httpError(404, "Book file not found");
        return serveFile(req, res, book.path, { mime: book.format === "pdf" ? "application/pdf" : "application/epub+zip", downloadName: path.basename(book.path), inline: true });
      }
      if (action === "bookmarks" && method === "GET") {
        return json(res, 200, { bookmarks: BookmarkRepo.list("book", id) });
      }
      if (action === "bookmarks" && method === "POST") {
        const body = await readJson(req);
        if (!body.label) throw httpError(400, "A bookmark label is required");
        const bookmark = BookmarkRepo.add({
          id: uid("bm_"),
          targetType: "book",
          targetId: id,
          chapter: body.chapter ?? null,
          page: body.page ?? null,
          position: body.position ?? null,
          label: body.label,
        });
        return json(res, 201, bookmark);
      }
      if (action === "bookmarks" && extra && method === "DELETE") {
        BookmarkRepo.remove(extra);
        return json(res, 200, { ok: true });
      }
    }

    /* ---------------------- notes & bookmarks ------------------------ */
    if (pathname === "/api/notes" && method === "GET") {
      const targetType = url.searchParams.get("targetType");
      const targetId = url.searchParams.get("targetId");
      const notes = targetType && targetId ? NoteRepo.list(targetType, targetId) : NoteRepo.all(Number(url.searchParams.get("limit")) || 500);
      return json(res, 200, { notes });
    }
    if (pathname === "/api/notes" && method === "POST") {
      const body = await readJson(req);
      if (!body.body || !String(body.body).trim()) throw httpError(400, "Write something in the note first");
      if (!["book", "media", "download"].includes(body.targetType)) throw httpError(400, "Invalid note target");
      const targetExists =
        (body.targetType === "book" && BookRepo.get(body.targetId)) ||
        (body.targetType === "media" && MediaRepo.get(body.targetId)) ||
        (body.targetType === "download" && DownloadRepo.get(body.targetId));
      if (!targetExists) throw httpError(404, "The note target no longer exists");
      const note = NoteRepo.add({
        id: uid("nt_"),
        targetType: body.targetType,
        targetId: body.targetId,
        chapter: body.chapter ?? null,
        page: body.page ?? null,
        position: body.position ?? null,
        timeSeconds: body.timeSeconds ?? null,
        body: String(body.body).slice(0, 20000),
      });
      if (body.targetType === "book") {
        BookRepo.update(body.targetId, { openedAt: now() });
      }
      broadcast("note-added", note);
      return json(res, 201, note);
    }
    if (pathname === "/api/bookmarks" && method === "GET") {
      const targetType = url.searchParams.get("targetType");
      const targetId = url.searchParams.get("targetId");
      if (!targetType || !targetId) throw httpError(400, "targetType and targetId are required");
      return json(res, 200, { bookmarks: BookmarkRepo.list(targetType, targetId) });
    }
    if (pathname === "/api/bookmarks" && method === "POST") {
      const body = await readJson(req);
      if (!body.label) throw httpError(400, "A bookmark label is required");
      if (!["book", "media"].includes(body.targetType)) throw httpError(400, "Invalid bookmark target");
      const bookmark = BookmarkRepo.add({
        id: uid("bm_"),
        targetType: body.targetType,
        targetId: body.targetId,
        chapter: body.chapter ?? null,
        page: body.page ?? null,
        position: body.position ?? null,
        label: body.label,
      });
      return json(res, 201, bookmark);
    }
    const noteMatch = pathname.match(/^\/api\/notes\/([^/]+)$/);
    if (noteMatch) {
      if (method === "PATCH") {
        const body = await readJson(req);
        if (!body.body || !String(body.body).trim()) throw httpError(400, "The note cannot be empty");
        const note = NoteRepo.update(noteMatch[1], String(body.body).slice(0, 20000));
        if (!note) throw httpError(404, "Note not found");
        broadcast("note-updated", note);
        return json(res, 200, note);
      }
      if (method === "DELETE") {
        const note = NoteRepo.get(noteMatch[1]);
        if (!note) throw httpError(404, "Note not found");
        NoteRepo.remove(noteMatch[1]);
        return json(res, 200, { ok: true });
      }
    }
    const bookmarkMatch = pathname.match(/^\/api\/bookmarks\/([^/]+)$/);
    if (bookmarkMatch && method === "DELETE") {
      BookmarkRepo.remove(bookmarkMatch[1]);
      return json(res, 200, { ok: true });
    }

    /* ----------------------------- tools ---------------------------- */
    if (pathname === "/api/tools" && method === "GET") {
      return json(res, 200, await listTools(getSettings()));
    }
    if (pathname === "/api/tools/jobs" && method === "GET") {
      return json(res, 200, { jobs: ToolJobRepo.list(50) });
    }
    if (pathname === "/api/tools/jobs" && method === "DELETE") {
      return json(res, 200, await cleanupJobs({ olderThanMs: 0 }));
    }
    const jobMatch = pathname.match(/^\/api\/tools\/jobs\/([^/]+)$/);
    if (jobMatch && method === "GET") {
      const job = ToolJobRepo.get(jobMatch[1]);
      if (!job) throw httpError(404, "Job not found");
      return json(res, 200, job);
    }
    const toolRunMatch = pathname.match(/^\/api\/tools\/([^/]+)\/run$/);
    if (toolRunMatch && method === "POST") {
      const toolId = toolRunMatch[1];
      const parity = await parseBody(req);
      const result = await runTool({
        toolId,
        values: parity.fields || {},
        files: parity.files || [],
        settings: getSettings(),
        manager,
      });
      return json(res, 200, result);
    }

    const outputMatch = pathname.match(/^\/api\/outputs\/([^/]+)\/(.+)$/);
    if (outputMatch && method === "GET") {
      const [, jobId, rel] = outputMatch;
      const target = outputPath(jobId, rel);
      if (!fs.existsSync(target)) throw httpError(404, "Output file not found");
      return serveFile(req, res, target, { downloadName: path.basename(target) });
    }

    /* ---------------------------- filesystem ------------------------ */
    if (pathname === "/api/fs/list" && method === "GET") {
      const requested = url.searchParams.get("path") || getSettings().download.directory || os.homedir();
      const target = path.resolve(requested);
      let entries;
      try {
        entries = await fsp.readdir(target, { withFileTypes: true });
      } catch (err) {
        throw httpError(404, "Cannot read that folder: " + err.message);
      }
      const dirs = [];
      const files = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          dirs.push({ name: entry.name, path: path.join(target, entry.name) });
        } else if (entry.isFile()) {
          const full = path.join(target, entry.name);
          try {
            const st = await fsp.stat(full);
            files.push({ name: entry.name, path: full, size: st.size });
          } catch {
            /* ignore */
          }
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, {
        path: target,
        parent: path.dirname(target) !== target ? path.dirname(target) : null,
        home: os.homedir(),
        dirs,
        files: files.slice(0, 300),
      });
    }
    if (pathname === "/api/fs/mkdir" && method === "POST") {
      const body = await readJson(req);
      if (!body.path) throw httpError(400, "A folder path is required");
      const target = path.resolve(body.path);
      await fsp.mkdir(target, { recursive: true });
      return json(res, 200, { path: target });
    }
    if (pathname === "/api/fs/reveal" && method === "POST") {
      const body = await readJson(req);
      if (!body.path) throw httpError(400, "A path is required");
      return json(res, 200, await revealInFileManager(body.path));
    }

    /* ------------------------------ data ---------------------------- */
    if (pathname === "/api/data/export" && method === "GET") {
      const payload = {
        app: "OmniGet Desktop",
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        settings: exportSettings({ includeSecrets: false }).settings,
        downloads: DownloadRepo.list({ status: "all", limit: 1000 }),
        media: listMedia(),
        books: BookRepo.list(),
        notes: NoteRepo.all(2000),
        bookmarks: db.prepare("SELECT * FROM bookmarks").all(),
      };
      return json(res, 200, payload, {
        "content-disposition": 'attachment; filename="omniget-export.json"',
      });
    }
    if (pathname === "/api/data/size" && method === "GET") {
      return json(res, 200, await dataSize());
    }
    if (pathname === "/api/data/clear-history" && method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      const rows = DownloadRepo.list({ status: "finished", limit: 1000 });
      for (const row of rows) {
        if (body.deleteFiles && row.filePath) {
          try {
            fs.rmSync(row.filePath, { force: true });
          } catch {
            /* ignore */
          }
        }
        DownloadRepo.remove(row.id);
      }
      broadcast("stats", DownloadRepo.counts());
      return json(res, 200, { removed: rows.length });
    }

    return error(res, 404, "Unknown API endpoint");
  } catch (err) {
    return apiError(res, err, `${method} ${pathname}`);
  } finally {
    if (process.env.OMNIGET_ACCESS_LOG === "1" && pathname.startsWith("/api/")) {
      console.log(`${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

/* --------------------------- static hosting ----------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method || "GET")) {
    res.writeHead(405);
    return res.end();
  }
  if (!fs.existsSync(CLIENT_DIR)) {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      `<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#F3F1EC;color:#1D1D1F">
      <h1>OmniGet is not built yet</h1>
      <p>Run <code>npm run build</code>, then reload this page.</p>
      </body></html>`,
    );
  }
  const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  let target = path.join(CLIENT_DIR, safePath);
  if (pathname === "/" || !path.extname(target)) target = path.join(CLIENT_DIR, "index.html");
  if (!target.startsWith(CLIENT_DIR + path.sep) && target !== path.join(CLIENT_DIR, "index.html")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    target = path.join(CLIENT_DIR, "index.html");
  }
  const ext = path.extname(target).toLowerCase();
  const isHtml = ext === ".html";
  const headers = {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": isHtml ? "no-cache" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(target).pipe(res);
}

/* ------------------------------ utilities ------------------------------- */

async function dataSize() {
  const result = { data: 0, downloads: 0, library: 0, outputs: 0, database: 0 };
  async function walk(dir, key) {
    let total = 0;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await walk(full, null);
      else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* ignore */
        }
      }
    }
    if (key) result[key] += total;
    return total;
  }
  result.data = await walk(DATA_DIR, null);
  result.downloads = await walk(getSettings().download.directory || DOWNLOADS_DIR, "downloads");
  result.library = await walk(LIBRARY_DIR, "library");
  result.outputs = await walk(path.join(DATA_DIR, "outputs"), "outputs");
  try {
    result.database = (await fsp.stat(DB_PATH)).size;
  } catch {
    result.database = 0;
  }
  return result;
}

/* -------------------------------- startup ------------------------------- */

cleanupJobs({ olderThanMs: 7 * 24 * 60 * 60 * 1000 }).catch(() => {});
cleanupUploads().catch(() => {});
manager.init();

async function cleanupUploads() {
  const dir = path.join(TMP_DIR, "uploads");
  let entries = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      if ((await fsp.stat(full)).mtimeMs < cutoff) await fsp.rm(full, { force: true });
    } catch {
      /* ignore */
    }
  }
}

server.listen(PORT, HOST, () => {
  console.log(`OmniGet listening on http://${HOST}:${PORT}`);
  console.log(`Data: ${DATA_DIR}`);
});

function shutdown() {
  console.log("\nShutting down…");
  for (const res of clients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
