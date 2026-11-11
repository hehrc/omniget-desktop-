export function formatBytes(bytes, { decimals } = {}) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const places = decimals ?? (value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return `${trimZeros(value.toFixed(places))} ${units[i]}`;
}

function trimZeros(text) {
  return text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function formatSpeed(bps) {
  if (!bps || bps <= 0) return "—";
  return `${formatBytes(bps)}/s`;
}

export function formatDuration(seconds, { forceHours = false } = {}) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h || forceHours) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatEta(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function formatDate(ts, { withTime = false } = {}) {
  if (!ts) return "—";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "—";
  const options = { month: "short", day: "numeric", year: "numeric" };
  if (withTime) {
    options.hour = "numeric";
    options.minute = "2-digit";
  }
  return date.toLocaleString(undefined, options);
}

export function formatRelative(ts) {
  if (!ts) return "—";
  const diff = Date.now() - Number(ts);
  const abs = Math.abs(diff);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60_000) return formatter.format(Math.round(-diff / 1000), "second");
  if (abs < 3_600_000) return formatter.format(Math.round(-diff / 60_000), "minute");
  if (abs < 86_400_000) return formatter.format(Math.round(-diff / 3_600_000), "hour");
  if (abs < 2_592_000_000) return formatter.format(Math.round(-diff / 86_400_000), "day");
  return formatDate(ts);
}

export function initials(text, count = 1) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .slice(0, count)
    .map((word) => word[0]?.toUpperCase() || "")
    .join("");
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function percent(done, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

export function statusLabel(status) {
  return (
    {
      queued: "Queued",
      probing: "Inspecting",
      downloading: "Downloading",
      paused: "Paused",
      completed: "Completed",
      failed: "Failed",
      canceled: "Canceled",
      running: "Running",
    }[status] || status
  );
}

export function statusTone(status) {
  return (
    {
      queued: "neutral",
      probing: "info",
      downloading: "accent",
      paused: "warning",
      completed: "success",
      failed: "error",
      canceled: "neutral",
      running: "accent",
    }[status] || "neutral"
  );
}

export function extOf(name = "") {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1].toUpperCase() : "";
}

export function readingTime(words) {
  const w = Number(words) || 0;
  if (w < 200) return "under a minute";
  const minutes = Math.round(w / 200);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
