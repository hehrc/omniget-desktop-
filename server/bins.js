import { execFile } from "node:child_process";

const cache = new Map();

function which(bin, args = ["--version"]) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ available: false, version: null });
      else resolve({ available: true, version: String(stdout || stderr).trim().split("\n")[0] });
    });
  });
}

export async function systemTools() {
  const key = "system-tools";
  if (cache.has(key)) return cache.get(key);
  const [ffmpeg, ffprobe, ytdlp, git] = await Promise.all([
    which(process.env.OMNIGET_FFMPEG || "ffmpeg", ["-version"]),
    which(process.env.OMNIGET_FFPROBE || "ffprobe", ["-version"]),
    which(process.env.OMNIGET_YTDLP || "yt-dlp", ["--version"]),
    which("git", ["--version"]),
  ]);
  const result = { ffmpeg, ffprobe, ytdlp, git };
  cache.set(key, result);
  // Re-detect periodically in case the user installs a tool at runtime.
  setTimeout(() => cache.delete(key), 30_000).unref?.();
  return result;
}

export async function hasYtDlp() {
  return (await systemTools()).ytdlp.available;
}

export async function hasFfmpeg() {
  return (await systemTools()).ffmpeg.available;
}

export function ytdlpBin() {
  return process.env.OMNIGET_YTDLP || "yt-dlp";
}

export function ffmpegBin() {
  return process.env.OMNIGET_FFMPEG || "ffmpeg";
}
