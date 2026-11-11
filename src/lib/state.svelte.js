import {
  ApiError,
  bookApi,
  downloadApi,
  mediaApi,
  notesApi,
  settingsApi,
  systemApi,
  toolsApi,
} from "./api.js";

export const app = $state({
  ready: false,
  bootError: null,
  settings: null,
  paths: null,
  system: null,
  stats: null,
  counts: {
    all: 0,
    queued: 0,
    downloading: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    active: 0,
    bytesSaved: 0,
  },
  downloads: [],
  media: [],
  books: [],
  notes: [],
  tools: null,
  toasts: [],
  eventsConnected: false,
  paletteOpen: false,
});

let toastSeq = 0;
let eventSource = null;
let reconnectTimer = null;
let booted = false;

/* ------------------------------- bootstrapping ----------------------------- */

export async function boot() {
  if (booted) return;
  booted = true;
  try {
    const [settingsRes, system, stats] = await Promise.all([
      settingsApi.get(),
      systemApi.info(),
      systemApi.stats(),
    ]);
    app.settings = settingsRes.settings;
    app.paths = settingsRes.paths;
    app.system = system;
    app.stats = stats;
    if (stats?.downloads) app.counts = { ...app.counts, ...stats.downloads };
    applyAppearance(app.settings);
    app.ready = true;
    await Promise.all([refreshDownloads(), refreshMedia(), refreshBooks(), refreshTools(), refreshNotes()]);
    connectEvents();
  } catch (err) {
    app.bootError = err instanceof ApiError ? err.message : String(err?.message || err);
  }
}

export function applyAppearance(settings) {
  if (!settings) return;
  const root = document.documentElement;
  const theme = settings.appearance?.theme || "light";
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  root.dataset.theme = resolved;
  root.dataset.accent = settings.appearance?.accent || "orange";
  root.dataset.reduceMotion = String(!!settings.appearance?.reduceMotion);
  root.dataset.reduceTransparency = String(!!settings.appearance?.reduceTransparency);
  root.dataset.density = settings.appearance?.density || "comfortable";
  const scale = Math.min(1.3, Math.max(0.85, Number(settings.appearance?.fontScale) || 1));
  const sizes = {
    "--text-caption": 10,
    "--text-xs": 11,
    "--text-sm": 12,
    "--text-base": 13,
    "--text-md": 15,
    "--text-lg": 17,
    "--text-xl": 22,
    "--text-2xl": 26,
    "--text-3xl": 32,
    "--text-display": 40,
  };
  for (const [token, px] of Object.entries(sizes)) {
    root.style.setProperty(token, `${Math.round(px * scale * 10) / 10}px`);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === "dark" ? "#171716" : "#F3F1EC";
}

/* --------------------------------- settings -------------------------------- */

export async function saveSettings(patchValue) {
  const res = await settingsApi.update(patchValue);
  app.settings = res.settings;
  app.paths = res.paths;
  applyAppearance(res.settings);
  return res.settings;
}

export async function resetSettings() {
  const res = await settingsApi.reset();
  app.settings = res.settings;
  applyAppearance(res.settings);
  return res.settings;
}

/** Apply a settings payload returned by import/save endpoints. */
export function acceptSettings(res) {
  if (!res?.settings) return app.settings;
  app.settings = res.settings;
  if (res.paths) app.paths = res.paths;
  applyAppearance(res.settings);
  return res.settings;
}

/* ------------------------------- notifications ----------------------------- */

export function toast(type, message, { timeout = 4800 } = {}) {
  const id = ++toastSeq;
  app.toasts.push({ id, type, message });
  if (app.toasts.length > 4) app.toasts.shift();
  if (timeout > 0) {
    setTimeout(() => dismissToast(id), timeout);
  }
  return id;
}

export function dismissToast(id) {
  const index = app.toasts.findIndex((t) => t.id === id);
  if (index !== -1) app.toasts.splice(index, 1);
}

/* -------------------------------- downloads -------------------------------- */

export function upsertDownload(download) {
  if (!download?.id) return;
  const index = app.downloads.findIndex((d) => d.id === download.id);
  if (index === -1) {
    app.downloads.unshift(download);
  } else {
    app.downloads[index] = { ...app.downloads[index], ...download };
  }
}

export async function refreshDownloads() {
  const res = await downloadApi.list("all", 300);
  app.downloads = res.downloads;
  if (res.counts) app.counts = { ...app.counts, ...res.counts };
  return res;
}

export async function refreshStats() {
  try {
    const stats = await systemApi.stats();
    app.stats = stats;
    if (stats?.downloads) app.counts = { ...app.counts, ...stats.downloads };
  } catch {
    /* non fatal */
  }
}

/* ---------------------------------- media ---------------------------------- */

export async function refreshMedia() {
  try {
    const res = await mediaApi.list();
    app.media = res.media;
  } catch {
    app.media = [];
  }
}

/* ---------------------------------- books ---------------------------------- */

export async function refreshBooks() {
  try {
    const res = await bookApi.list();
    app.books = res.books;
  } catch {
    app.books = [];
  }
}

/* ---------------------------------- notes ---------------------------------- */

export async function refreshNotes() {
  try {
    const res = await notesApi.list({ limit: 500 });
    app.notes = res.notes;
  } catch {
    app.notes = [];
  }
}

/* ---------------------------------- tools ---------------------------------- */

export async function refreshTools() {
  try {
    const res = await toolsApi.list();
    app.tools = res;
  } catch {
    app.tools = null;
  }
}

/* ----------------------------------- SSE ----------------------------------- */

function connectEvents() {
  if (eventSource) {
    try {
      eventSource.close();
    } catch {
      /* ignore */
    }
  }
  const source = new EventSource("/api/events");
  eventSource = source;

  source.addEventListener("open", () => {
    app.eventsConnected = true;
  });

  source.addEventListener("snapshot", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.counts) app.counts = { ...app.counts, ...data.counts };
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("stats", (event) => {
    try {
      const data = JSON.parse(event.data);
      app.counts = { ...app.counts, ...data };
      if (app.stats?.downloads) app.stats.downloads = { ...app.stats.downloads, ...data };
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("download", (event) => {
    try {
      upsertDownload(JSON.parse(event.data));
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("download-added", (event) => {
    try {
      upsertDownload(JSON.parse(event.data));
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("download-completed", (event) => {
    try {
      upsertDownload(JSON.parse(event.data));
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("download-removed", (event) => {
    try {
      const data = JSON.parse(event.data);
      app.downloads = app.downloads.filter((d) => d.id !== data.id);
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("download-failed", (event) => {
    try {
      const data = JSON.parse(event.data);
      toast("error", `Download failed: ${data.error || "unknown error"}`, { timeout: 9000 });
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("download-log", (event) => {
    try {
      window.dispatchEvent(new CustomEvent("omniget:log", { detail: JSON.parse(event.data) }));
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("media-added", () => refreshMedia());
  source.addEventListener("media-updated", () => refreshMedia());
  source.addEventListener("book-added", () => refreshBooks());
  source.addEventListener("book-updated", () => refreshBooks());
  source.addEventListener("note-added", () => refreshNotes());
  source.addEventListener("note-updated", () => refreshNotes());
  source.addEventListener("settings", (event) => {
    try {
      const settings = JSON.parse(event.data);
      app.settings = settings;
      applyAppearance(settings);
    } catch {
      /* ignore */
    }
  });
  source.addEventListener("toast", (event) => {
    try {
      const data = JSON.parse(event.data);
      toast(data.type || "info", data.message);
    } catch {
      /* ignore */
    }
  });

  source.addEventListener("error", () => {
    app.eventsConnected = false;
    if (source.readyState === EventSource.CLOSED) {
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectEvents();
  }, 3000);
}

/* --------------------------------- palette --------------------------------- */

export function openPalette() {
  app.paletteOpen = true;
}

export function closePalette() {
  app.paletteOpen = false;
}

/* -------------------------------- bootstrap -------------------------------- */

export function reportError(err, fallback = "Something went wrong") {
  const message = err instanceof ApiError ? err.message : err?.message || fallback;
  toast("error", message, { timeout: 7000 });
  return message;
}
