/** Subtitle parsing and conversion shared by the player and the tools hub. */

export function parseTimestamp(value) {
  const m = String(value)
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0"));
  return h * 3600 + min * 60 + sec + ms / 1000;
}

export function formatTimestamp(seconds, { comma = true, withHours = false } = {}) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const base = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${comma ? "," : "."}${String(ms).padStart(3, "0")}`;
  if (!withHours && h === 0) return base.slice(3);
  return base;
}

export function parseSrt(text) {
  const normalized = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    const timing = lines[idx];
    if (!timing) continue;
    const m = timing.match(/^(.+?)\s*-->\s*(.+?)(?:\s+(.*))?$/);
    if (!m) continue;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (start === null || end === null) continue;
    const body = lines.slice(idx + 1).join("\n");
    cues.push({ start, end, text: body, settings: m[3] || "" });
  }
  return cues;
}

export function parseVtt(text) {
  const normalized = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const body = normalized.replace(/^WEBVTT[^\n]*\n+/, "");
  const blocks = body.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim()) || /^NOTE\b/.test(lines[0])) {
      if (/^NOTE\b/.test(lines[0])) continue;
      idx = 1;
    }
    const timing = lines[idx];
    if (!timing) continue;
    const m = timing.match(/^(.+?)\s*-->\s*(.+?)(?:\s+(.*))?$/);
    if (!m) continue;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (start === null || end === null) continue;
    cues.push({ start, end, text: lines.slice(idx + 1).join("\n"), settings: m[3] || "" });
  }
  return cues;
}

export function detectSubtitleFormat(name, text) {
  if (/\.vtt$/i.test(name || "") || /^WEBVTT/.test(String(text).trim())) return "vtt";
  return "srt";
}

export function cuesToVtt(cues, header = "OmniGet subtitles") {
  const lines = ["WEBVTT", `NOTE ${header}`, ""];
  cues.forEach((cue, i) => {
    lines.push(String(i + 1));
    lines.push(`${vttTime(cue.start)} --> ${vttTime(cue.end)}${cue.settings ? " " + cue.settings : ""}`);
    lines.push(cue.text || "");
    lines.push("");
  });
  return lines.join("\n");
}

export function cuesToSrt(cues) {
  return cues
    .map((cue, i) => {
      return `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text || ""}\n`;
    })
    .join("\n");
}

function vttTime(sec) {
  return formatTimestamp(sec, { comma: false, withHours: true });
}

function srtTime(sec) {
  return formatTimestamp(sec, { comma: true, withHours: true });
}

export function shiftCues(cues, seconds) {
  return cues.map((cue) => ({
    ...cue,
    start: Math.max(0, cue.start + seconds),
    end: Math.max(0, cue.end + seconds),
  }));
}

export function subtitleStats(cues) {
  const duration = cues.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0);
  const words = cues.reduce((sum, c) => sum + (c.text.trim() ? c.text.trim().split(/\s+/).length : 0), 0);
  const chars = cues.reduce((sum, c) => sum + c.text.length, 0);
  return {
    cues: cues.length,
    duration,
    words,
    chars,
    cps: duration > 0 ? chars / duration : 0,
    first: cues[0]?.start ?? 0,
    last: cues[cues.length - 1]?.end ?? 0,
  };
}

export function cleanCues(cues) {
  return cues
    .map((c) => ({ ...c, text: c.text.replace(/<[^>]+>/g, "").replace(/[ \t]+/g, " ").trim() }))
    .filter((c) => c.text && c.end > c.start);
}

export function mergeSubtitleCues(cues) {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const out = [];
  for (const cue of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.end - cue.start) < 0.15 && last.text === cue.text) {
      last.end = Math.max(last.end, cue.end);
    } else {
      out.push({ ...cue });
    }
  }
  return out;
}
