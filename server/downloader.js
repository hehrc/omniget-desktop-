import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db, DownloadRepo, MediaRepo, DownloadRepo as _DR } from "./db.js";
import {
  DATA_DIR,
  DOWNLOADS_DIR,
  LIBRARY_DIR,
  TMP_DIR,
  classifyMime,
  ensureDirs,
  error,
  extFromMime,
  mimeFromName,
  now,
  safeName,
  uid,
  uniquePath,
} from "./util.js";
import { getSettings, ensureDownloadDir } from "./settings.js";
import { getCachedProbe, probeUrl } from "./probe.js";
import { fetchFollowing, normalizeUrl } from "./net.js";
import { parsePlaylist, pickVariant } from "./hls.js";
import { ytdlpBin, hasFfmpeg, ffmpegBin } from "./bins.js";
import { ytdlpExtraArgs } from "./ytdlp.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36 OmniGet/1.0";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DownloadManager {
  constructor({ broadcast }) {
    this.broadcast = broadcast;
    this.active = new Map();
    this.pumping = false;
    this.stopped = false;
  }

  init() {
    DownloadRepo.recover();
    ensureDirs();
    setTimeout(() => {
      this.pump();
      this.broadcastStats();
    }, 400).unref?.();
  }

  broadcastStats() {
    try {
      this.broadcast("stats", DownloadRepo.counts());
    } catch {
      /* ignore */
    }
  }

  emit(id, extra = {}) {
    const row = DownloadRepo.get(id);
    if (!row) return;
    this.broadcast("download", { ...row, ...extra });
  }

  log(id, level, message) {
    DownloadRepo.addLog(id, level, message);
    this.broadcast("download-log", { id, level, message, ts: now() });
  }

  async probe(url) {
    return probeUrl(url);
  }

  /** Create a download record from a validated URL. */
  async create({ url, options = {} }) {
    const settings = getSettings();
    const normalized = normalizeUrl(url).href;
    let probe = getCachedProbe(normalized);
    if (!probe) probe = await probeUrl(normalized, { settings });
    url = probe.url || normalized;
    if (!probe.supported) {
      const err = new Error(probe.reason || "This link is not supported");
      err.status = 422;
      err.probe = probe;
      throw err;
    }

    const id = uid("dl_");
    const quality = options.quality || probe.qualities?.[0]?.id || "source";
    const qualityInfo = (probe.qualities || []).find((q) => String(q.id) === String(quality));
    const selector = qualityInfo?.selector || qualityInfo?.formatId || quality;
    const title = String(options.title || probe.title || "Download").trim();
    const baseDirRoot = ensureDownloadDir();
    let targetDir = baseDirRoot;
    if (settings.download.organizeBySource && probe.source?.id) {
      targetDir = path.join(baseDirRoot, safeName(probe.source.id));
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const ext =
      probe.mime === "application/vnd.apple.mpegurl"
        ? "mp4"
        : extFromMime(probe.mime).replace(".", "") ||
          path.extname(probe.filename || "").replace(".", "") ||
          "bin";
    const filename = this.buildFilename({
      template: settings.download.filenameTemplate,
      title,
      id,
      ext,
      source: probe.source?.id || "web",
    });
    let finalPath = path.join(targetDir, filename);

    // Never overwrite an existing file. If skipExisting is enabled and the
    // already-present file matches the known size, mark the job as skipped.
    if (fs.existsSync(finalPath)) {
      const existing = fs.statSync(finalPath);
      if (settings.download.skipExisting && (!probe.sizeBytes || existing.size === probe.sizeBytes)) {
        const row = DownloadRepo.insert({
          id,
          url,
          finalUrl: probe.finalUrl,
          source: probe.source?.id,
          sourceLabel: probe.source?.label,
          kind: probe.kind,
          title,
          filename,
          filePath: finalPath,
          mime: probe.mime,
          sizeBytes: existing.size,
          downloadedBytes: existing.size,
          status: "completed",
          quality: qualityInfo?.label || quality,
          thumbnail: probe.thumbnail,
          durationSeconds: probe.durationSeconds,
          rangeSupported: probe.rangeSupported,
          engine: probe.engine,
          options: { ...options, skipped: true, qualityId: quality },
        });
        DownloadRepo.update(id, { completedAt: now() });
        this.log(id, "warn", `Skipped — an existing file was found at ${finalPath}`);
        this.addOutput(row, finalPath, probe.mime, existing.size, title);
        this.broadcast("download-added", DownloadRepo.get(id));
        this.broadcastStats();
        return DownloadRepo.get(id);
      }
      finalPath = uniquePath(targetDir, filename);
    }

    const partPath = finalPath + ".part";
    const row = DownloadRepo.insert({
      id,
      url,
      finalUrl: probe.finalUrl,
      source: probe.source?.id,
      sourceLabel: probe.source?.label,
      kind: probe.kind,
      title,
      filename: path.basename(finalPath),
      filePath: finalPath,
      partPath,
      mime: probe.mime,
      sizeBytes: qualityInfo?.filesize || probe.sizeBytes || 0,
      status: settings.download.autoStart === false ? "paused" : "queued",
      quality: qualityInfo?.label || quality,
      thumbnail: probe.thumbnail,
      durationSeconds: probe.durationSeconds,
      rangeSupported: probe.rangeSupported,
      engine: probe.engine,
      options: {
        ...options,
        qualityId: quality,
        selector,
        variantUrl: qualityInfo?.url || null,
        height: qualityInfo?.height || 0,
        formatId: qualityInfo?.formatId || quality,
        downloadUrl: probe.downloadUrl || null,
        isLive: probe.isLive || false,
        segmentCount: probe.segmentCount || 0,
      },
    });
    DownloadRepo.update(id, { segmentsTotal: probe.segmentCount || 0 });
    this.log(id, "info", `Starting download — engine=${probe.engine} source=${probe.source?.id || "web"} url=${url}`);
    if (probe.sizeBytes) this.log(id, "info", `Reported size: ${probe.sizeBytes} bytes`);
    this.broadcast("download-added", DownloadRepo.get(id));
    this.pump();
    return DownloadRepo.get(id);
  }

  buildFilename({ template, title, id, ext, source }) {
    const date = new Date().toISOString().slice(0, 10);
    const shortId = String(id).replace(/^dl_/, "").slice(0, 8);
    let tpl = String(template || "{title} [{id}].{ext}");
    let out = tpl
      .replaceAll("{title}", safeName(title, "download").replace(/\.[a-z0-9]{1,6}$/i, ""))
      .replaceAll("{id}", shortId)
      .replaceAll("{ext}", ext)
      .replaceAll("{source}", source || "web")
      .replaceAll("{date}", date);
    out = safeName(out, `download.${ext}`);
    if (!out.toLowerCase().endsWith("." + ext.toLowerCase())) out += "." + ext;
    return out;
  }

  pump() {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      const settings = getSettings();
      const max = Math.max(1, settings.download.maxConcurrent);
      while (this.active.size < max) {
        const next = db
          .prepare("SELECT * FROM downloads WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
          .get();
        if (!next) break;
        this.start(next.id).catch((err) => {
          console.error("download start failed", err);
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  async start(id) {
    const row = DownloadRepo.get(id);
    if (!row) return;
    if (this.active.has(id)) return;
    const ac = new AbortController();
    const record = {
      id,
      abort: ac,
      stopReason: null,
      bytes: row.downloadedBytes || 0,
      lastEmit: 0,
      lastDb: 0,
      startedAt: Date.now(),
      baseBytes: row.downloadedBytes || 0,
      proc: null,
      res: null,
    };
    this.active.set(id, record);
    DownloadRepo.update(id, {
      status: "downloading",
      error: null,
      startedAt: row.startedAt || now(),
      speedBps: 0,
      etaSeconds: null,
    });
    this.emit(id, { progress: 0 });
    this.broadcastStats();

    try {
      if (row.engine === "hls") await this.runHls(row, record);
      else if (row.engine === "yt-dlp") await this.runYtDlp(row, record);
      else await this.runHttp(row, record);
    } catch (err) {
      await this.handleFailure(id, record, err);
    } finally {
      this.active.delete(id);
      this.broadcastStats();
      this.pump();
    }
  }

  progress(id, record, { downloaded, total, force = false, segmentsDone, segmentsTotal, speedBps }) {
    const t = Date.now();
    const elapsed = Math.max(0.2, (t - record.startedAt) / 1000);
    const deltaBytes = Math.max(0, downloaded - record.baseBytes);
    const measured = deltaBytes / elapsed;
    const speed = Number.isFinite(speedBps) && speedBps > 0 ? speedBps : measured;
    const eta = total > 0 && speed > 1 ? Math.max(0, Math.round((total - downloaded) / speed)) : null;
    record.bytes = downloaded;
    const payload = {
      downloadedBytes: downloaded,
      sizeBytes: total || 0,
      speedBps: Math.round(speed),
      etaSeconds: eta,
    };
    if (force || t - record.lastEmit > 350) {
      record.lastEmit = t;
      this.emit(id, {
        ...payload,
        segmentsDone: segmentsDone ?? undefined,
        segmentsTotal: segmentsTotal ?? undefined,
        progress:
          total > 0
            ? Math.min(100, (downloaded / total) * 100)
            : segmentsTotal
              ? Math.min(100, (segmentsDone / segmentsTotal) * 100)
              : null,
      });
    }
    if (force || t - record.lastDb > 900) {
      record.lastDb = t;
      DownloadRepo.update(id, {
        downloadedBytes: downloaded,
        sizeBytes: total || undefined,
        speedBps: Math.round(speed),
        etaSeconds: eta,
        segmentsDone: segmentsDone ?? undefined,
        segmentsTotal: segmentsTotal ?? undefined,
      });
    }
  }

  async throttle(record, chunkBytes) {
    const settings = getSettings();
    const kbps = Number(settings.download.speedLimitKbps) || 0;
    if (kbps <= 0) return;
    record.throttleStart ??= Date.now();
    record.throttleBytes = (record.throttleBytes || 0) + chunkBytes;
    const targetMs = (record.throttleBytes / (kbps * 1024)) * 1000;
    const elapsed = Date.now() - record.throttleStart;
    if (targetMs > elapsed) await sleep(Math.min(1000, targetMs - elapsed));
  }

  async runHttp(row, record) {
    const settings = getSettings();
    const target = row.filePath;
    const partPath = row.partPath || target + ".part";
    const dir = path.dirname(target);
    await fsp.mkdir(dir, { recursive: true });

    let resumeFrom = 0;
    try {
      const stat = await fsp.stat(partPath);
      if (stat.size > 0 && row.rangeSupported) resumeFrom = stat.size;
    } catch {
      /* no part */
    }

    const headers = {
      "user-agent": settings.network.userAgent || UA,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
    };
    if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;
    this.log(row.id, "info", resumeFrom > 0 ? `Resuming at byte ${resumeFrom}` : "Connecting to server");

    const { res, finalUrl } = await fetchFollowing(
      row.url,
      { headers, signal: record.abort.signal },
      { validate: true },
    );
    record.res = res;
    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }
    const contentType = (res.headers.get("content-type") || "").split(";")[0];
    const contentRange = res.headers.get("content-range") || "";
    let total = 0;
    if (contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (m) total = Number(m[1]);
    } else {
      total = Number(res.headers.get("content-length")) || row.sizeBytes || 0;
    }
    if (res.status === 200 && resumeFrom > 0) {
      this.log(row.id, "warn", "Server ignored the range request; restarting from byte 0");
      resumeFrom = 0;
    }
    const append = resumeFrom > 0 && res.status === 206;
    const mime = contentType || row.mime || mimeFromName(row.filename);
    DownloadRepo.update(row.id, {
      finalUrl,
      mime,
      sizeBytes: total || row.sizeBytes || 0,
      rangeSupported: res.status === 206 || /bytes/i.test(res.headers.get("accept-ranges") || ""),
      downloadedBytes: append ? resumeFrom : 0,
    });
    record.baseBytes = append ? resumeFrom : 0;
    record.startedAt = Date.now();

    const file = await fsp.open(partPath, append ? "a" : "w");
    let downloaded = append ? resumeFrom : 0;
    this.progress(row.id, record, { downloaded, total, force: true });
    try {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await this.throttle(record, value.length);
        await file.write(value);
        downloaded += value.length;
        this.progress(row.id, record, { downloaded, total });
        if (record.stopReason) break;
      }
    } finally {
      await file.close();
    }

    if (record.stopReason === "pause") {
      DownloadRepo.update(row.id, {
        status: "paused",
        downloadedBytes: downloaded,
        speedBps: 0,
        etaSeconds: null,
        sizeBytes: total || undefined,
      });
      this.log(row.id, "info", `Paused at ${downloaded} bytes`);
      this.emit(row.id);
      return;
    }
    if (record.stopReason === "cancel") {
      await fsp.rm(partPath, { force: true });
      DownloadRepo.update(row.id, {
        status: "canceled",
        downloadedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
      });
      this.log(row.id, "warn", "Download canceled");
      this.emit(row.id);
      return;
    }
    if (total > 0 && downloaded < total) {
      throw new Error(`Transfer ended early (${downloaded} of ${total} bytes). Retry to resume from the partial file.`);
    }

    await this.finalizeHttp(row, record, { partPath, downloaded, total, mime, finalUrl });
  }

  async finalizeHttp(row, record, { partPath, downloaded, total, mime, finalUrl }) {
    const target = row.filePath;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (await fs.promises.access(partPath).then(() => true, () => false)) {
      await fsp.rename(partPath, target);
    }
    const stat = await fsp.stat(target);
    const finalDownloaded = stat.size;
    const updated = DownloadRepo.update(row.id, {
      status: "completed",
      downloadedBytes: finalDownloaded,
      sizeBytes: finalDownloaded,
      speedBps: 0,
      etaSeconds: null,
      completedAt: now(),
      mime,
      finalUrl,
      filePath: target,
      filename: path.basename(target),
    });
    this.log(row.id, "info", `Saved ${finalDownloaded} bytes to ${target}`);
    this.addOutput(updated, target, mime, finalDownloaded, updated.title);
    if (total && finalDownloaded !== total) {
      this.log(row.id, "warn", `Expected ${total} bytes but the server delivered ${finalDownloaded}`);
    }
    this.emit(row.id, { progress: 100 });
    this.afterComplete(updated);
  }

  addOutput(row, filePath, mime, size, label) {
    try {
      db.prepare(
        "INSERT INTO download_outputs (id,download_id,path,mime,size,label) VALUES (?,?,?,?,?,?)",
      ).run(uid("out_"), row.id, filePath, mime || mimeFromName(filePath), size, label || path.basename(filePath));
    } catch {
      /* duplicate output is not fatal */
    }
  }

  afterComplete(row) {
    const kind = row.kind || classifyMime(row.mime, row.filename);
    this.broadcast("download-completed", row);
    this.broadcastStats();
    if (["video", "audio"].includes(kind)) {
      try {
        if (!MediaRepo.byDownload(row.id)) {
          const media = MediaRepo.insert({
            id: uid("md_"),
            downloadId: row.id,
            title: row.title || row.filename,
            path: row.filePath,
            mime: row.mime,
            kind,
            size: row.sizeBytes,
            duration: row.durationSeconds,
            thumbnail: row.thumbnail,
          });
          this.broadcast("media-added", media);
        }
      } catch (err) {
        console.error("media import failed", err);
      }
    }
    if (["pdf", "ebook"].includes(kind)) {
      import("./books.js")
        .then((mod) => mod.importBookFile(row.filePath, { downloadId: row.id }))
        .then((book) => {
          this.broadcast("book-added", book);
          this.broadcast("toast", { type: "success", message: `Added “${book.title}” to your study library` });
        })
        .catch((err) => console.error("book import failed", err));
    }
  }

  async runHls(row, record) {
    const settings = getSettings();
    const options = row.options || {};
    const startUrl = options.variantUrl || row.finalUrl || row.url;
    this.log(row.id, "info", `Fetching HLS playlist ${startUrl}`);
    const headers = { "user-agent": settings.network.userAgent || UA, accept: "*/*" };

    const masterOut = await fetchFollowing(startUrl, { headers, signal: record.abort.signal });
    const masterText = await masterOut.res.text();
    let playlist = parsePlaylist(masterText, masterOut.finalUrl);
    let mediaBase = masterOut.finalUrl;
    if (playlist.type === "master") {
      const chosen = pickVariant(playlist.variants, options.height || 0);
      if (!chosen) throw new Error("The HLS master playlist has no playable variants");
      this.log(row.id, "info", `Selected ${chosen.height ? chosen.height + "p" : chosen.bandwidth + " bps"} variant`);
      const mediaOut = await fetchFollowing(chosen.url, { headers, signal: record.abort.signal });
      playlist = parsePlaylist(await mediaOut.res.text(), chosen.url);
      mediaBase = chosen.url;
      DownloadRepo.update(row.id, { finalUrl: chosen.url });
    }
    if (playlist.encrypted) {
      throw new Error(
        `This HLS stream uses ${playlist.encrypted.method} encryption. Encrypted streams are not supported by this build.`,
      );
    }
    if (!playlist.segments.length) throw new Error("The HLS playlist has no segments");
    if (playlist.isLive) this.log(row.id, "warn", "This is a live playlist; only the segments listed at start are downloaded");

    const segmentExt = path.extname(new URL(playlist.segments[0].url).pathname).toLowerCase();
    let outExt = playlist.mapUri || segmentExt === ".m4s" || segmentExt === ".mp4" ? "mp4" : "ts";
    const ffmpegAvailable = await hasFfmpeg();
    const baseTarget = row.filePath.replace(/\.[a-z0-9]{1,6}$/i, "");
    let finalTarget = `${baseTarget}.${outExt}`;
    if (fs.existsSync(finalTarget)) finalTarget = uniquePath(path.dirname(finalTarget), path.basename(finalTarget));
    const partPath = finalTarget + ".part";
    await fsp.mkdir(path.dirname(finalTarget), { recursive: true });
    await fsp.writeFile(partPath, Buffer.alloc(0));

    const total = playlist.segments.length;
    let done = 0;
    DownloadRepo.update(row.id, { segmentsTotal: total, segmentsDone: 0, sizeBytes: 0, downloadedBytes: 0 });
    const file = await fsp.open(partPath, "a");
    let bytes = 0;
    record.startedAt = Date.now();
    try {
      const writeSegment = async (uri) => {
        const res = await fetchFollowing(uri, { headers, signal: record.abort.signal });
        if (!res.res.ok) throw new Error(`Segment request failed with HTTP ${res.res.status}`);
        const buf = Buffer.from(await res.res.arrayBuffer());
        await file.write(buf);
        bytes += buf.length;
        this.progress(row.id, record, {
          downloaded: bytes,
          total: 0,
          segmentsDone: done,
          segmentsTotal: total,
        });
      };
      if (playlist.mapUri) {
        this.log(row.id, "info", "Downloading fMP4 initialization segment");
        await writeSegment(playlist.mapUri);
      }
      for (const segment of playlist.segments) {
        if (record.stopReason) break;
        await writeSegment(segment.url);
        done += 1;
        this.progress(row.id, record, {
          downloaded: bytes,
          total: 0,
          force: done === total,
          segmentsDone: done,
          segmentsTotal: total,
        });
        if (done % 10 === 0) this.log(row.id, "debug", `Downloaded ${done}/${total} segments`);
      }
    } finally {
      await file.close();
    }

    if (record.stopReason === "pause") {
      DownloadRepo.update(row.id, {
        status: "paused",
        downloadedBytes: bytes,
        segmentsDone: done,
        segmentsTotal: total,
        speedBps: 0,
        etaSeconds: null,
      });
      this.log(row.id, "info", `Paused after ${done}/${total} segments`);
      this.emit(row.id);
      return;
    }
    if (record.stopReason === "cancel") {
      await fsp.rm(partPath, { force: true });
      DownloadRepo.update(row.id, { status: "canceled", downloadedBytes: 0, segmentsDone: 0, speedBps: 0 });
      this.log(row.id, "warn", "Download canceled");
      this.emit(row.id);
      return;
    }

    // Direct HLS downloads are only resumable from the start; a paused job
    // restarts segments because the partial segment index is not persisted.
    if (downloadedSegmentsForRow(row) > 0 && done < total) {
      await fsp.rm(partPath, { force: true });
      DownloadRepo.update(row.id, { downloadedBytes: 0, segmentsDone: 0, status: "queued" });
      this.log(row.id, "warn", "Partial HLS download discarded; it will restart");
      return;
    }

    let mime = outExt === "mp4" ? "video/mp4" : "video/mp2t";
    if (ffmpegAvailable && outExt === "ts") {
      const remuxed = `${baseTarget}.mp4`;
      try {
        this.log(row.id, "info", "Remuxing MPEG-TS to MP4 with ffmpeg");
        await this.remux(partPath, remuxed);
        await fsp.rm(partPath, { force: true });
        finalTarget = remuxed;
        outExt = "mp4";
        mime = "video/mp4";
      } catch (err) {
        this.log(row.id, "warn", "ffmpeg remux failed, keeping the TS file: " + err.message);
      }
    } else if (outExt === "ts") {
      this.log(row.id, "warn", "Saved as MPEG-TS. Install ffmpeg to remux to MP4 automatically.");
    }
    await fsp.rename(partPath, finalTarget);
    const stat = await fsp.stat(finalTarget);
    const updated = DownloadRepo.update(row.id, {
      status: "completed",
      filePath: finalTarget,
      filename: path.basename(finalTarget),
      mime,
      sizeBytes: stat.size,
      downloadedBytes: stat.size,
      segmentsDone: total,
      segmentsTotal: total,
      speedBps: 0,
      etaSeconds: null,
      completedAt: now(),
    });
    this.log(row.id, "info", `Saved ${stat.size} bytes to ${finalTarget}`);
    this.addOutput(updated, finalTarget, mime, stat.size, updated.title);
    this.emit(row.id, { progress: 100 });
    this.afterComplete(updated);
  }

  remux(input, output) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegBin(), ["-y", "-i", input, "-c", "copy", "-bsf:a", "aac_adtstoasc", output], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-3000)));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.split("\n").slice(-3).join(" ") || `ffmpeg exited ${code}`));
      });
    });
  }

  async runYtDlp(row, record) {
    const settings = getSettings();
    const options = row.options || {};
    const targetUrl = options.downloadUrl || row.url;
    const ffmpeg = await hasFfmpeg();
    const baseTarget = row.filePath.replace(/\.[a-z0-9]{1,6}$/i, "");
    const outTemplate = `${baseTarget}.%(ext)s`;
    const args = [
      "--newline",
      "--no-playlist",
      "--no-warnings",
      "--continue",
      ...ytdlpExtraArgs(settings),
      "--progress-template",
      "download:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
      "-o",
      outTemplate,
    ];
    const selector = String(options.selector || "").trim();
    const height = Number(options.height) || 0;
    if (selector) {
      args.push("-f", selector);
    } else if (height > 0) {
      args.push("-f", ffmpeg ? `bv*[height<=${height}]+ba/b[height<=${height}]` : `b[height<=${height}]/b`);
    } else {
      args.push("-f", ffmpeg ? "bv*+ba/b" : "b/bv*");
    }
    args.push(targetUrl);
    this.log(row.id, "info", "Starting yt-dlp extraction");
    this.log(row.id, "debug", "yt-dlp " + args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" "));

    const child = spawn(ytdlpBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    record.proc = child;
    record.startedAt = Date.now();
    let stderr = "";
    let lastBytes = 0;
    let completedFilesBytes = 0;
    let currentFileBytes = 0;
    let currentFileTotal = 0;
    let lastCurrentFileBytes = 0;

    const onAbort = () => {
      try {
        child.kill("SIGINT");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 3000).unref?.();
      } catch {
        /* ignore */
      }
    };
    record.abort.signal.addEventListener("abort", onAbort, { once: true });

    const num = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const parseLine = (line) => {
      line = line.trim();
      // --progress-template emits raw "downloaded|total|estimate|speed|eta"
      // lines. yt-dlp downloads the video and audio as separate files when it
      // merges, so keep the bytes already finished before showing progress.
      if (/^(?:download:)?\d+\|/.test(line)) {
        const parts = line.replace(/^download:/, "").split("|");
        if (parts.length >= 4) {
          const hasEstimate = parts.length >= 5;
          const downloaded = num(parts[0]);
          const total = num(parts[1]) || num(parts[2]);
          const speed = num(hasEstimate ? parts[3] : parts[2]);
          const eta = num(hasEstimate ? parts[4] : parts[3]);
          if (downloaded + 1 < lastCurrentFileBytes) {
            completedFilesBytes += currentFileTotal || lastCurrentFileBytes;
            currentFileTotal = 0;
          }
          lastCurrentFileBytes = downloaded;
          if (total) currentFileTotal = total;
          const overallDownloaded = completedFilesBytes + downloaded;
          const overallTotal = completedFilesBytes + (total || 0);
          if (overallDownloaded > 0) {
            lastBytes = overallDownloaded;
            this.progress(row.id, record, {
              downloaded: overallDownloaded,
              total: overallTotal,
              speedBps: speed > 0 ? speed : undefined,
            });
            if (eta > 0) {
              DownloadRepo.update(row.id, { etaSeconds: Math.round(eta) });
            }
          }
          return;
        }
      }
      if (
        /^\[download\]\s+Destination/i.test(line) ||
        /^\[info\]/i.test(line) ||
        /^\[Merger\]/i.test(line) ||
        /^\[FixupM3u8\]/i.test(line)
      ) {
        this.log(row.id, "info", line.replace(/^\[[^\]]+\]\s*/, ""));
      }
    };

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) parseLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(-3)) {
        if (/ERROR/i.test(line)) this.log(row.id, "error", line.slice(0, 500));
      }
    });

    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    if (record.stopReason === "pause") {
      DownloadRepo.update(row.id, { status: "paused", speedBps: 0, etaSeconds: null });
      this.log(row.id, "info", "Paused extractor; resume continues with yt-dlp --continue");
      this.emit(row.id);
      return;
    }
    if (record.stopReason === "cancel") {
      await this.cleanupYtDlp(baseTarget);
      DownloadRepo.update(row.id, {
        status: "canceled",
        downloadedBytes: 0,
        speedBps: 0,
        etaSeconds: null,
      });
      this.log(row.id, "warn", "Download canceled and partial files removed");
      this.emit(row.id);
      return;
    }
    if (code !== 0) {
      const message = stderr
        .split(/\r?\n/)
        .filter((l) => l.trim() && !/^WARNING/.test(l))
        .slice(-4)
        .join(" ")
        .replace(/ERROR:\s*/g, "")
        .slice(0, 600);
      throw new Error(message || `yt-dlp exited with code ${code}`);
    }

    const produced = await this.findProducedFile(baseTarget);
    if (!produced) throw new Error("yt-dlp finished but no output file was found");
    const stat = await fsp.stat(produced);
    const mime = mimeFromName(produced, "video/mp4");
    const updated = DownloadRepo.update(row.id, {
      status: "completed",
      filePath: produced,
      filename: path.basename(produced),
      mime,
      kind: classifyMime(mime, produced),
      sizeBytes: stat.size,
      downloadedBytes: stat.size,
      speedBps: 0,
      etaSeconds: null,
      completedAt: now(),
    });
    this.log(row.id, "info", `Saved ${stat.size} bytes to ${produced}`);
    this.addOutput(updated, produced, mime, stat.size, updated.title);
    this.emit(row.id, { progress: 100 });
    this.afterComplete(updated);
  }

  async findProducedFile(baseTarget) {
    const dir = path.dirname(baseTarget);
    const base = path.basename(baseTarget);
    let entries = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return null;
    }
    const matches = entries.filter((f) => f.startsWith(base + ".") && !f.endsWith(".part"));
    const withStats = await Promise.all(
      matches.map(async (f) => {
        const p = path.join(dir, f);
        try {
          const st = await fsp.stat(p);
          return { path: p, mtime: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      }),
    );
    const valid = withStats.filter((v) => v && v.size > 0).sort((a, b) => b.mtime - a.mtime);
    return valid[0]?.path || null;
  }

  async cleanupYtDlp(baseTarget) {
    const dir = path.dirname(baseTarget);
    const base = path.basename(baseTarget);
    try {
      const entries = await fsp.readdir(dir);
      await Promise.all(
        entries
          .filter((f) => f.startsWith(base + "."))
          .map((f) => fsp.rm(path.join(dir, f), { force: true })),
      );
    } catch {
      /* ignore */
    }
  }

  async handleFailure(id, record, err) {
    if (record.stopReason === "pause") {
      DownloadRepo.update(id, { status: "paused", speedBps: 0, etaSeconds: null });
      this.log(id, "info", "Download paused");
      this.emit(id);
      return;
    }
    if (record.stopReason === "cancel") {
      DownloadRepo.update(id, { status: "canceled", speedBps: 0, etaSeconds: null });
      this.log(id, "warn", "Download canceled");
      this.emit(id);
      return;
    }
    const message = String(err?.message || err).slice(0, 800);
    DownloadRepo.update(id, {
      status: "failed",
      error: message,
      speedBps: 0,
      etaSeconds: null,
    });
    this.log(id, "error", "Download failed: " + message);
    this.emit(id);
    this.broadcast("download-failed", { id, error: message });
  }

  pause(id) {
    const row = DownloadRepo.get(id);
    if (!row) throw httpError(404, "Download not found");
    const record = this.active.get(id);
    if (record) {
      record.stopReason = "pause";
      record.abort.abort();
    }
    DownloadRepo.update(id, { status: "paused", speedBps: 0, etaSeconds: null });
    this.emit(id);
    this.broadcastStats();
    return DownloadRepo.get(id);
  }

  resume(id) {
    const row = DownloadRepo.get(id);
    if (!row) throw httpError(404, "Download not found");
    if (row.status === "completed") return row;
    if (row.status === "canceled" || row.status === "failed") {
      // keep partial file for retry/resume; if the request restarts, runHttp truncates.
    }
    DownloadRepo.update(id, { status: "queued", error: null, speedBps: 0, etaSeconds: null });
    this.emit(id);
    this.pump();
    return DownloadRepo.get(id);
  }

  async cancel(id) {
    const row = DownloadRepo.get(id);
    if (!row) throw httpError(404, "Download not found");
    const record = this.active.get(id);
    if (record) {
      record.stopReason = "cancel";
      record.abort.abort();
      // Wait briefly for the stream loop to exit so the part file is removed.
      await sleep(250);
    }
    if (row.partPath) await fsp.rm(row.partPath, { force: true });
    DownloadRepo.update(id, {
      status: "canceled",
      downloadedBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
    });
    this.log(id, "warn", "Download canceled");
    this.emit(id);
    this.broadcastStats();
    return DownloadRepo.get(id);
  }

  async retry(id) {
    const row = DownloadRepo.get(id);
    if (!row) throw httpError(404, "Download not found");
    if (row.partPath) await fsp.rm(row.partPath, { force: true });
    DownloadRepo.update(id, {
      status: "queued",
      downloadedBytes: 0,
      segmentsDone: 0,
      speedBps: 0,
      etaSeconds: null,
      error: null,
      completedAt: null,
    });
    this.log(id, "info", "Retrying download from the beginning");
    this.emit(id);
    this.pump();
    return DownloadRepo.get(id);
  }

  async remove(id, { deleteFile = false } = {}) {
    const row = DownloadRepo.get(id);
    if (!row) throw httpError(404, "Download not found");
    const record = this.active.get(id);
    if (record) {
      record.stopReason = "cancel";
      record.abort.abort();
    }
    if (deleteFile) {
      try {
        if (row.partPath) await fsp.rm(row.partPath, { force: true });
        if (row.filePath && isManagedPath(row.filePath)) await fsp.rm(row.filePath, { force: true });
      } catch (err) {
        // Report the failure rather than pretending the file is gone.
        throw httpError(500, "Could not delete the file: " + err.message);
      }
    }
    DownloadRepo.remove(id);
    this.broadcast("download-removed", { id });
    this.broadcastStats();
    return { ok: true };
  }

  async fileInfo(id) {
    const row = DownloadRepo.get(id);
    if (!row) throw httpError(404, "Download not found");
    let exists = false;
    let size = 0;
    try {
      const st = await fsp.stat(row.filePath);
      exists = true;
      size = st.size;
    } catch {
      /* missing */
    }
    return { ...row, fileExists: exists, actualSize: size };
  }
}

function downloadedSegmentsForRow(row) {
  return Number(row.segmentsDone) || 0;
}

function isManagedPath(p) {
  const abs = path.resolve(p);
  const roots = [
    path.resolve(DATA_DIR),
    path.resolve(DOWNLOADS_DIR),
    path.resolve(LIBRARY_DIR),
    path.resolve(getSettings().download.directory || DOWNLOADS_DIR),
  ].map((r) => (r.endsWith(path.sep) ? r : r + path.sep));
  return roots.some((r) => abs.startsWith(r));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
