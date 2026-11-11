import path from "node:path";
import fs from "node:fs";
import { db, tx } from "./db.js";
import { DATA_DIR, DOWNLOADS_DIR, LIBRARY_DIR, now } from "./util.js";

export function defaultSettings() {
  return {
    schemaVersion: 1,
    onboardingCompleted: false,
    legalAcknowledged: true,
    appearance: {
      theme: "light",
      accent: "orange",
      density: "comfortable",
      reduceMotion: false,
      reduceTransparency: false,
      fontScale: 1,
    },
    typography: {
      uiFont: "Inter",
      displayFont: "Bricolage Grotesque",
      monoFont: "IBM Plex Mono",
      size: "default",
    },
    download: {
      directory: DOWNLOADS_DIR,
      maxConcurrent: 3,
      speedLimitKbps: 0,
      organizeBySource: false,
      skipExisting: true,
      filenameTemplate: "{title} [{id}].{ext}",
      autoStart: true,
      retries: 2,
      chunkConcurrency: 4,
      askQuality: true,
      cookiesFile: "",
    },
    network: {
      proxy: "",
      timeoutSeconds: 30,
      userAgent: "",
      allowLocalhost: false,
      verifyTls: true,
    },
    playback: {
      autoplay: false,
      defaultVolume: 0.9,
      defaultRate: 1,
      rememberPosition: true,
      subtitleSize: 1,
      subtitleColor: "#ffffff",
      subtitleBackground: 0.65,
      seekStep: 5,
      loop: false,
    },
    reader: {
      theme: "paper",
      fontFamily: "serif",
      fontSize: 18,
      lineHeight: 1.7,
      pageWidth: 760,
      justify: false,
      pdfZoom: 1.15,
    },
    study: {
      dailyGoalMinutes: 30,
      autoResume: true,
    },
    ai: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
    },
    advanced: {
      keepLogs: true,
      logLevel: "info",
      allowRemoteThumbnails: true,
    },
  };
}

const KEY = "app";
let cache = null;

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function sanitize(settings) {
  const d = defaultSettings();
  const merged = deepMerge(d, settings);
  const s = merged;

  // Appearance
  if (!["light", "dark", "system"].includes(s.appearance.theme)) s.appearance.theme = "light";
  if (!["orange", "blue", "green", "purple", "pink"].includes(s.appearance.accent)) s.appearance.accent = "orange";
  if (!["compact", "comfortable"].includes(s.appearance.density)) s.appearance.density = "comfortable";
  s.appearance.fontScale = clampNumber(s.appearance.fontScale, 0.85, 1.3, 1);

  // Download
  s.download.maxConcurrent = Math.round(clampNumber(s.download.maxConcurrent, 1, 8, 3));
  s.download.speedLimitKbps = Math.round(clampNumber(s.download.speedLimitKbps, 0, 1_000_000, 0));
  s.download.retries = Math.round(clampNumber(s.download.retries, 0, 10, 2));
  s.download.chunkConcurrency = Math.round(clampNumber(s.download.chunkConcurrency, 1, 12, 4));
  s.download.filenameTemplate = String(s.download.filenameTemplate || "{title} [{id}].{ext}").slice(0, 200);
  s.download.cookiesFile = String(s.download.cookiesFile || "").trim().slice(0, 1000);
  if (!s.download.directory || typeof s.download.directory !== "string") {
    s.download.directory = d.download.directory;
  }

  // Network
  s.network.timeoutSeconds = Math.round(clampNumber(s.network.timeoutSeconds, 5, 300, 30));
  s.network.proxy = String(s.network.proxy || "").trim();
  s.network.userAgent = String(s.network.userAgent || "").trim().slice(0, 400);

  // Playback
  s.playback.defaultVolume = clampNumber(s.playback.defaultVolume, 0, 1, 0.9);
  s.playback.defaultRate = clampNumber(s.playback.defaultRate, 0.25, 4, 1);
  s.playback.subtitleSize = clampNumber(s.playback.subtitleSize, 0.6, 2.2, 1);
  s.playback.seekStep = Math.round(clampNumber(s.playback.seekStep, 2, 60, 5));
  s.playback.subtitleColor = /^#[0-9a-f]{6}$/i.test(s.playback.subtitleColor || "")
    ? s.playback.subtitleColor
    : "#ffffff";
  s.playback.subtitleBackground = clampNumber(s.playback.subtitleBackground, 0, 1, 0.65);

  // Reader
  if (!["paper", "light", "sepia", "dark"].includes(s.reader.theme)) s.reader.theme = "paper";
  if (!["serif", "sans", "mono"].includes(s.reader.fontFamily)) s.reader.fontFamily = "serif";
  s.reader.fontSize = clampNumber(s.reader.fontSize, 12, 34, 18);
  s.reader.lineHeight = clampNumber(s.reader.lineHeight, 1.2, 2.4, 1.7);
  s.reader.pageWidth = Math.round(clampNumber(s.reader.pageWidth, 480, 1100, 760));
  s.reader.pdfZoom = clampNumber(s.reader.pdfZoom, 0.5, 3, 1.15);

  // Study
  s.study.dailyGoalMinutes = Math.round(clampNumber(s.study.dailyGoalMinutes, 5, 600, 30));

  // AI
  s.ai.baseUrl = String(s.ai.baseUrl || "").trim();
  s.ai.model = String(s.ai.model || "").trim();
  s.ai.apiKey = String(s.ai.apiKey || "").trim();

  // Advanced
  if (!["debug", "info", "warn", "error"].includes(s.advanced.logLevel)) s.advanced.logLevel = "info";

  return s;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function getSettings() {
  if (cache) return cache;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY);
    if (row) {
      const parsed = JSON.parse(row.value);
      cache = sanitize(parsed);
    } else {
      cache = defaultSettings();
      persist(cache);
    }
  } catch {
    cache = defaultSettings();
  }
  return cache;
}

function persist(settings) {
  const value = JSON.stringify(settings);
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(KEY, value, now());
}

export function updateSettings(patch) {
  const current = getSettings();
  const next = sanitize(deepMerge(current, patch));
  persist(next);
  cache = next;
  return next;
}

export function resetSettings() {
  const next = defaultSettings();
  persist(next);
  cache = next;
  return next;
}

export function exportSettings({ includeSecrets = false } = {}) {
  const s = structuredClone(getSettings());
  if (!includeSecrets) {
    s.ai.apiKey = s.ai.apiKey ? "••••••••" : "";
  }
  return {
    exportedAt: new Date().toISOString(),
    app: "OmniGet Desktop",
    schemaVersion: s.schemaVersion,
    settings: s,
  };
}

export function importSettings(payload, { keepSecrets = true } = {}) {
  const source = payload && payload.settings ? payload.settings : payload;
  if (!source || typeof source !== "object") {
    const err = new Error("Invalid settings file");
    err.status = 400;
    throw err;
  }
  const patch = structuredClone(source);
  if (keepSecrets && (!patch.ai?.apiKey || patch.ai.apiKey === "••••••••")) {
    if (patch.ai) delete patch.ai.apiKey;
  }
  return updateSettings(patch);
}

export function ensureDownloadDir() {
  const s = getSettings();
  const dir = path.resolve(s.download.directory || DOWNLOADS_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    updateSettings({ download: { directory: DOWNLOADS_DIR } });
    return DOWNLOADS_DIR;
  }
}

export function dataPaths() {
  const s = getSettings();
  return {
    dataDir: DATA_DIR,
    downloadsDir: s.download.directory,
    libraryDir: LIBRARY_DIR,
    settingsFile: path.join(DATA_DIR, "omniget.db"),
  };
}

export function clearSettingsCache() {
  cache = null;
}

export { tx };
