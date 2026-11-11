import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MediaRepo, addStudySeconds } from "./db.js";
import { LIBRARY_DIR, classifyMime, mimeFromName, safeName, uid, now } from "./util.js";
import {
  cuesToVtt,
  detectSubtitleFormat,
  parseSrt,
  parseVtt,
  subtitleStats,
} from "./subtitles.js";

const MEDIA_DIR = path.join(LIBRARY_DIR, "media");
const SUBS_DIR = path.join(LIBRARY_DIR, "subtitles");

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(SUBS_DIR, { recursive: true });

export async function importMediaFile(filePath, { originalName = null } = {}) {
  const name = safeName(originalName || path.basename(filePath), "media");
  const mime = mimeFromName(name, "application/octet-stream");
  const kind = classifyMime(mime, name);
  if (!["video", "audio"].includes(kind)) {
    const err = new Error("Only audio and video files can be added to the media library");
    err.status = 422;
    throw err;
  }
  const id = uid("md_");
  const dest = path.join(MEDIA_DIR, `${id}-${name}`);
  await fsp.copyFile(filePath, dest);
  const stat = await fsp.stat(dest);
  return MediaRepo.insert({
    id,
    title: path.basename(name, path.extname(name)).replace(/[_]+/g, " "),
    path: dest,
    mime,
    kind,
    size: stat.size,
  });
}

export function mediaForClient(media) {
  if (!media) return null;
  return {
    ...media,
    fileUrl: `/api/media/${media.id}/file`,
    subtitles: MediaRepo.subtitles(media.id).map((s) => ({
      id: s.id,
      label: s.label,
      lang: s.lang,
      url: `/api/media/${media.id}/subtitles/${s.id}`,
    })),
  };
}

export function listMedia() {
  return MediaRepo.list().map(mediaForClient);
}

export function getMedia(id) {
  const media = MediaRepo.get(id);
  if (!media) {
    const err = new Error("Media item not found");
    err.status = 404;
    throw err;
  }
  return mediaForClient(media);
}

export async function updateMediaPosition(id, { position, watchedDelta, duration }) {
  const media = MediaRepo.get(id);
  if (!media) throw Object.assign(new Error("Media item not found"), { status: 404 });
  const patch = {};
  if (typeof position === "number") patch.position = Math.max(0, position);
  if (typeof duration === "number" && duration > 0) patch.duration = duration;
  if (typeof watchedDelta === "number" && watchedDelta > 0) {
    patch.watchedSeconds = Math.min(86400, media.watchedSeconds + Math.min(watchedDelta, 600));
    addStudySeconds("media", id, Math.min(watchedDelta, 600));
  }
  return mediaForClient(MediaRepo.update(id, patch));
}

export async function deleteMedia(id, { deleteFile = true } = {}) {
  const media = MediaRepo.get(id);
  if (!media) throw Object.assign(new Error("Media item not found"), { status: 404 });
  const subs = MediaRepo.subtitles(id);
  for (const sub of subs) {
    try {
      await fsp.rm(sub.path, { force: true });
    } catch {
      /* ignore */
    }
  }
  if (deleteFile && media.path) {
    const target = path.resolve(media.path);
    if (target.startsWith(path.resolve(LIBRARY_DIR) + path.sep)) {
      await fsp.rm(target, { force: true });
    }
  }
  MediaRepo.remove(id);
  return { ok: true };
}

export async function addSubtitle(mediaId, filePath, { label = null, lang = null, originalName = null } = {}) {
  const media = MediaRepo.get(mediaId);
  if (!media) throw Object.assign(new Error("Media item not found"), { status: 404 });
  const name = originalName || path.basename(filePath);
  const text = await fsp.readFile(filePath, "utf8");
  if (text.length > 5 * 1024 * 1024) {
    const err = new Error("Subtitle files larger than 5 MB are not supported");
    err.status = 413;
    throw err;
  }
  const format = detectSubtitleFormat(name, text);
  const cues = format === "vtt" ? parseVtt(text) : parseSrt(text);
  if (!cues.length) {
    const err = new Error("No subtitle cues could be parsed from that file");
    err.status = 422;
    throw err;
  }
  const id = uid("sub_");
  const dest = path.join(SUBS_DIR, `${id}.vtt`);
  await fsp.writeFile(dest, cuesToVtt(cues, media.title), "utf8");
  const cleanLabel = safeName(label || name.replace(/\.(srt|vtt)$/i, ""), "Subtitles");
  MediaRepo.addSubtitle({
    id,
    mediaId,
    label: cleanLabel,
    lang: lang || guessLang(name),
    path: dest,
    mime: "text/vtt",
  });
  return {
    id,
    label: cleanLabel,
    lang: lang || guessLang(name),
    url: `/api/media/${mediaId}/subtitles/${id}`,
    stats: subtitleStats(cues),
  };
}

function guessLang(name) {
  const m = /\.([a-z]{2,3})(?:\.(?:srt|vtt))?$/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}

export function getSubtitle(mediaId, subtitleId) {
  const row = MediaRepo.getSubtitle(subtitleId);
  if (!row || row.media_id !== mediaId) {
    throw Object.assign(new Error("Subtitle not found"), { status: 404 });
  }
  return row;
}

export async function deleteSubtitle(mediaId, subtitleId) {
  const row = getSubtitle(mediaId, subtitleId);
  MediaRepo.removeSubtitle(subtitleId);
  try {
    await fsp.rm(row.path, { force: true });
  } catch {
    /* ignore */
  }
  return { ok: true };
}

export function mediaStats() {
  return { count: MediaRepo.list().length };
}

export function nowTs() {
  return now();
}
