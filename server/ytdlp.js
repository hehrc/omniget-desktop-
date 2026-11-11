import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { ytdlpBin, systemTools } from "./bins.js";
import { getSettings } from "./settings.js";
import { mimeFromName } from "./util.js";

const SOURCE_MAP = [
  { id: "youtube", label: "YouTube", hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com", "music.youtube.com"] },
  { id: "instagram", label: "Instagram", hosts: ["instagram.com", "instagr.am"] },
  { id: "tiktok", label: "TikTok", hosts: ["tiktok.com"] },
  { id: "twitter", label: "X / Twitter", hosts: ["twitter.com", "x.com"] },
  { id: "facebook", label: "Facebook", hosts: ["facebook.com", "fb.watch", "fb.com"] },
  { id: "reddit", label: "Reddit", hosts: ["reddit.com", "redd.it"] },
  { id: "vimeo", label: "Vimeo", hosts: ["vimeo.com"] },
  { id: "pinterest", label: "Pinterest", hosts: ["pinterest.com", "pin.it"] },
  { id: "spotify", label: "Spotify", hosts: ["spotify.com", "open.spotify.com"] },
  { id: "soundcloud", label: "SoundCloud", hosts: ["soundcloud.com"] },
  { id: "bilibili", label: "Bilibili", hosts: ["bilibili.com", "b23.tv"] },
  { id: "twitch", label: "Twitch", hosts: ["twitch.tv"] },
  { id: "linkedin", label: "LinkedIn", hosts: ["linkedin.com"] },
  { id: "dailymotion", label: "Dailymotion", hosts: ["dailymotion.com", "dai.ly"] },
  { id: "archive", label: "Internet Archive", hosts: ["archive.org"] },
  { id: "wikipedia", label: "Wikimedia", hosts: ["wikipedia.org", "wikimedia.org"] },
];

export function detectSource(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { id: "web", label: "Web", host: "" };
  }
  for (const source of SOURCE_MAP) {
    if (source.hosts.some((h) => host === h || host.endsWith("." + h))) {
      return { id: source.id, label: source.label, host };
    }
  }
  return { id: "web", label: host.replace(/^www\./, ""), host };
}

export function looksLikePageUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const pathname = u.pathname.toLowerCase();
  if (/\.(mp4|webm|mkv|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|jpg|jpeg|png|webp|gif|pdf|epub|zip|srt|vtt|m3u8)$/.test(pathname)) {
    return false;
  }
  return true;
}

export function contentDispositionFilename(header) {
  if (!header) return "";
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* ignore */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : "";
}

export function filenameFromUrl(url, mime) {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(path.basename(u.pathname));
    if (base && /\./.test(base)) return base;
    if (base) return base;
  } catch {
    /* ignore */
  }
  return "download" + (extFromMime(mime) || "");
}

export function ytdlpExtraArgs(settings = getSettings()) {
  const args = [];
  if (settings.download?.cookiesFile) args.push("--cookies", settings.download.cookiesFile);
  if (settings.network?.verifyTls === false) args.push("--no-check-certificates");
  if (settings.network?.proxy) args.push("--proxy", settings.network.proxy);
  if (settings.network?.userAgent) args.push("--user-agent", settings.network.userAgent);
  return args;
}

export async function probeWithYtDlp(url, { timeoutMs = 45_000 } = {}) {
  const bin = ytdlpBin();
  return new Promise((resolve, reject) => {
    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--socket-timeout",
      "15",
      ...ytdlpExtraArgs(),
      url,
    ];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error("The extractor timed out while inspecting this link"), { status: 504 }));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > 12 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Could not run yt-dlp: " + err.message), { status: 500 }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          Object.assign(new Error(cleanYtDlpError(stderr) || `Extractor exited with code ${code}`), {
            status: 422,
          }),
        );
        return;
      }
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch {
        reject(Object.assign(new Error("The extractor returned unreadable metadata"), { status: 502 }));
      }
    });
  });
}

function cleanYtDlpError(stderr) {
  return String(stderr)
    .split("\n")
    .filter((l) => l.trim() && !/^WARNING:/.test(l))
    .slice(-4)
    .join(" ")
    .replace(/ERROR:\s*/g, "")
    .slice(0, 500);
}

function formatScore(format) {
  const protocol = String(format.protocol || "");
  const direct = /^https?:/i.test(protocol) ? 1 : 0;
  const size = Number(format.filesize) || Number(format.filesize_approx) || 0;
  return direct * 1e12 + (Number(format.tbr) || 0) * 1e6 + size;
}

function displayPixels(format) {
  const width = Number(format.width) || 0;
  const height = Number(format.height) || 0;
  if (width && height) return Math.min(width, height);
  return height || width || 0;
}

/**
 * Build quality choices that the download engine can actually fulfil.
 *
 * - A single muxed format is offered as-is (no ffmpeg needed).
 * - Separate video-only + audio formats are offered as merge selectors when
 *   ffmpeg is available. Without ffmpeg they are omitted instead of silently
 *   downloading a mute video.
 * - Portrait clips (Instagram, Reddit) are labelled by their short side, which
 *   is what people mean by "720p", while the selector keeps the real height.
 */
export function qualitiesFromInfo(info, { ffmpeg = false } = {}) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const muxedByHeight = new Map();
  const videoByHeight = new Map();
  let bestAudioSize = 0;

  for (const format of formats) {
    if (!format.format_id) continue;
    const height = Number(format.height) || 0;
    const hasVideo = !!format.vcodec && format.vcodec !== "none";
    const hasAudio = !!format.acodec && format.acodec !== "none";
    const unknownCodecs = !format.vcodec && !format.acodec;
    // Progressive formats from X/Instagram report neither codec but do carry a
    // height. They are single, already-muxed files.
    const muxed = (hasVideo && hasAudio) || (unknownCodecs && height > 0);
    const audioOnly = hasAudio && !hasVideo && height === 0;

    if (audioOnly) {
      const size = Number(format.filesize) || Number(format.filesize_approx) || 0;
      bestAudioSize = Math.max(bestAudioSize, size);
      continue;
    }
    if (!height) continue;

    if (muxed) {
      const current = muxedByHeight.get(height);
      if (!current || formatScore(format) > formatScore(current)) {
        muxedByHeight.set(height, format);
      }
    } else if (hasVideo && !hasAudio) {
      const current = videoByHeight.get(height);
      if (!current || formatScore(format) > formatScore(current)) {
        videoByHeight.set(height, format);
      }
    }
  }

  const heights = new Set([...muxedByHeight.keys()]);
  if (ffmpeg) {
    for (const height of videoByHeight.keys()) heights.add(height);
  }

  const qualities = [];
  for (const height of [...heights].sort((a, b) => b - a)) {
    const muxed = muxedByHeight.get(height);
    const video = videoByHeight.get(height);
    if (muxed) {
      const pixels = displayPixels(muxed) || height;
      qualities.push({
        id: `h${height}`,
        label: `${pixels}p${muxed.ext ? " · " + muxed.ext : ""}`,
        height,
        ext: muxed.ext || "mp4",
        formatId: muxed.format_id,
        selector: muxed.format_id,
        filesize: Number(muxed.filesize) || Number(muxed.filesize_approx) || 0,
        mode: "muxed",
      });
      continue;
    }
    if (!ffmpeg || !video) continue;
    const pixels = displayPixels(video) || height;
    const videoSize = Number(video.filesize) || Number(video.filesize_approx) || 0;
    const ext = video.ext || "mp4";
    qualities.push({
      id: `h${height}`,
      label: `${pixels}p${ext ? " · " + ext : ""}`,
      height,
      ext,
      formatId: `bv*[height<=${height}]+ba`,
      selector: [
        `bv*[vcodec^=avc][ext=mp4][height<=${height}]+ba[ext=m4a]`,
        `b[vcodec^=avc][ext=mp4][height<=${height}]`,
        `bv*[ext=mp4][height<=${height}]+ba[ext=m4a]`,
        `b[ext=mp4][height<=${height}]`,
        `bv*[height<=${height}]+ba`,
        `b[height<=${height}]`,
      ].join("/"),
      filesize: videoSize && bestAudioSize ? videoSize + bestAudioSize : videoSize,
      mode: "merge",
    });
  }

  qualities.push({
    id: "best",
    label: ffmpeg ? "Best available · merged" : "Best available",
    height: 0,
    ext: "mp4",
    formatId: "best",
    selector: ffmpeg
      ? "bv*[vcodec^=avc][ext=mp4]+ba[ext=m4a]/b[vcodec^=avc][ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"
      : "b[ext=mp4]/b/bv*",
    mode: "best",
  });
  return qualities;
}

export async function probeWithYtDlpResult(url, info, { ffmpeg = false } = {}) {
  const source = detectSource(url);
  const isAudioOnly =
    info.vcodec === "none" || (!info.vcodec && info.acodec && info.acodec !== "none");
  const mime = isAudioOnly
    ? mimeFromName("file." + (info.ext || "m4a"), "audio/mpeg")
    : mimeFromName("file.mp4", "video/mp4");
  const kind = isAudioOnly ? "audio" : "video";
  const qualities = qualitiesFromInfo(info, { ffmpeg });
  const bestSize =
    Number(info.filesize) ||
    Number(info.filesize_approx) ||
    Math.max(0, ...qualities.map((q) => Number(q.filesize) || 0));
  return {
    url,
    finalUrl: info.webpage_url || url,
    source,
    kind,
    mime,
    engine: "yt-dlp",
    supported: true,
    reason: null,
    title: info.title || filenameFromUrl(url, mime),
    filename: filenameFromUrl(url, mime),
    sizeBytes: bestSize,
    rangeSupported: true,
    durationSeconds: Number(info.duration) || null,
    thumbnail: info.thumbnail || null,
    isLive: !!info.is_live,
    qualities,
    author: info.uploader || info.channel || null,
    description: info.description ? String(info.description).slice(0, 500) : null,
    extractor: info.extractor_key || info.extractor || "yt-dlp",
    isPage: true,
  };
}

export async function ytdlpStatus() {
  const tools = await systemTools();
  return tools.ytdlp;
}

export function availableYtdlpDirectory() {
  return fs.existsSync(path.dirname(ytdlpBin())) ? path.dirname(ytdlpBin()) : null;
}
