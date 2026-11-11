import { pdfTools } from "./pdf.js";
import { docTools } from "./docs.js";
import { subtitleTools } from "./subtitles.js";
import { mediaTools } from "./media.js";
import { archiveTools } from "./archive.js";
import { aiTools } from "./ai.js";
import { systemTools } from "../bins.js";

export const TOOL_CATEGORIES = [
  {
    id: "pdf",
    name: "PDF",
    description: "Merge, split, rotate, extract and convert PDF documents.",
    icon: { from: "#FF6B6B", to: "#D62F3C", glyph: "M6 2h8l6 6v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V9h5.5L14 3.5z" },
  },
  {
    id: "documents",
    name: "Documents",
    description: "Typeset text and turn documents into portable files.",
    icon: { from: "#6EA8FF", to: "#2F6BFF", glyph: "M4 3h11l5 5v13H4V3zm10 1.8V9h4.2L14 4.8zM7 12h10v1.7H7V12zm0 4h10v1.7H7V16z" },
  },
  {
    id: "text",
    name: "Text & data",
    description: "Format, convert, count and transform text and structured data.",
    icon: { from: "#7ED9A0", to: "#1E9E4A", glyph: "M4 5h16v2H4V5zm0 4h16v2H4V9zm0 4h12v2H4v-2zm0 4h8v2H4v-2z" },
  },
  {
    id: "archives",
    name: "Archives",
    description: "Create, inspect and unpack ZIP archives.",
    icon: { from: "#D7B087", to: "#9C6B3C", glyph: "M3 7l3-4h12l3 4v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7zm2.4-2L4.5 7h15l-.9-2H5.4zM10 9h4v3h-4V9z" },
  },
  {
    id: "subtitles",
    name: "Speech & subtitles",
    description: "Convert, retime, clean and merge subtitle tracks.",
    icon: { from: "#FF8FA6", to: "#E23D64", glyph: "M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm3 8h6v2H6v-2zm8 0h4v2h-4v-2zM6 9h4v2H6V9zm6 0h6v2h-6V9z" },
  },
  {
    id: "images",
    name: "Images",
    description: "Resize, crop and convert images without uploading them anywhere.",
    icon: { from: "#FFD86B", to: "#F2A100", glyph: "M3 4h18v16H3V4zm2 2v9l4-4 3 3 3-3 4 4V6H5zm3.5 5a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5z" },
  },
  {
    id: "study",
    name: "Study",
    description: "Convert books and prepare material for the reader.",
    icon: { from: "#9AA6FF", to: "#5A5AE6", glyph: "M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22V4.5zm2.5-.5a.5.5 0 0 0-.5.5V19a4.5 4.5 0 0 1 1-.1h11V4H6.5z" },
  },
  {
    id: "audio",
    name: "Audio",
    description: "Inspect media streams and extract audio when ffmpeg is available.",
    icon: { from: "#FF7A9C", to: "#D7265C", glyph: "M9 3l12-2v14.5a3.5 3.5 0 1 1-2-3.2V6.2L11 7.5v11a3.5 3.5 0 1 1-2-3.2V3z" },
  },
  {
    id: "files",
    name: "Files",
    description: "Inspect files, fingerprints and byte-level metadata.",
    icon: { from: "#C7A27A", to: "#8A5A2B", glyph: "M3 5h6l2 2h10v13H3V5z" },
  },
  {
    id: "utilities",
    name: "Utilities",
    description: "QR codes, colors and everyday developer helpers.",
    icon: { from: "#A5A5AA", to: "#5A5A5F", glyph: "M21.7 6.3l-3 3-2.1-2.1 3-3A6 6 0 0 0 12 11.6L4.6 19a2.1 2.1 0 0 0 3 3l7.4-7.4a6 6 0 0 0 6.7-8.3z" },
  },
  {
    id: "security",
    name: "CTF & analysis",
    description: "Decode tokens and inspect untrusted input locally.",
    icon: { from: "#3A3A3E", to: "#0A0A0B", glyph: "M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3z" },
  },
  {
    id: "ai",
    name: "AI",
    description: "Use your own OpenAI-compatible endpoint. Off by default.",
    icon: { from: "#9B8CFF", to: "#5A3DFF", glyph: "M12 2l2.2 6.3L21 10l-6.8 1.7L12 18l-2.2-6.3L3 10l6.8-1.7L12 2z" },
  },
  {
    id: "downloads",
    name: "Downloads",
    description: "Send links straight to the download queue.",
    icon: { from: "#FFB44D", to: "#E07B00", glyph: "M12 3v11l4-4 1.4 1.4L12 17.8 6.6 11.4 8 10l4 4V3zM4 19h16v2H4v-2z" },
  },
];

const downloadTools = {
  "url-download": {
    category: "downloads",
    name: "Download from URL",
    description:
      "Validate a link, detect its source and add it to the real download queue. Direct files and HLS work without extra software; page extraction needs yt-dlp.",
    keywords: ["download", "url", "http", "hls", "video", "audio", "file"],
    accept: "",
    minFiles: 0,
    maxFiles: 0,
    fields: [
      { name: "url", label: "Link", type: "text", placeholder: "https://example.com/file.mp4", required: true },
      { name: "quality", label: "Quality preference", type: "text", placeholder: "best", default: "best" },
    ],
    async run(ctx) {
      if (!ctx.manager) throw Object.assign(new Error("Download manager is unavailable"), { status: 503 });
      const probe = await ctx.manager.probe(ctx.values.url);
      if (!probe.supported) throw Object.assign(new Error(probe.reason || "This link is not supported"), { status: 422 });
      const download = await ctx.manager.create({
        url: probe.url,
        options: { quality: ctx.values.quality || "best" },
      });
      return {
        text: `Queued “${download.title}”\nSource: ${download.sourceLabel || "web"}\nEngine: ${download.engine}\nStatus: ${download.status}\n\nOpen Downloads to follow progress.`,
        summary: `Queued ${download.title}`,
        downloadId: download.id,
        links: [{ label: "Open Downloads", href: "#/downloads" }],
      };
    },
  },
};

const ALL = {
  ...pdfTools,
  ...docTools,
  ...subtitleTools,
  ...mediaTools,
  ...archiveTools,
  ...aiTools,
  ...downloadTools,
};

const DEFAULT_FIELDS = [];

export const tools = Object.entries(ALL).map(([id, tool]) => ({
  id,
  category: tool.category || "utilities",
  name: tool.name,
  description: tool.description,
  keywords: tool.keywords || [],
  accept: tool.accept ?? "",
  minFiles: tool.minFiles ?? 0,
  maxFiles: tool.maxFiles ?? 1,
  fields: tool.fields || DEFAULT_FIELDS,
  requires: tool.requires || [],
  requiresConfig: tool.requiresConfig || null,
  unavailableReason: tool.unavailableReason || null,
  run: tool.run,
}));

const toolMap = new Map(tools.map((t) => [t.id, t]));

export function getTool(id) {
  return toolMap.get(id) || null;
}

export async function listTools(settings) {
  const system = await systemTools();
  const categories = TOOL_CATEGORIES.map((cat) => ({
    ...cat,
    tools: tools
      .filter((t) => t.category === cat.id)
      .map((t) => publicTool(t, settings, system)),
  }));
  return {
    categories,
    tools: tools.map((t) => publicTool(t, settings, system)),
    systems: {
      ffmpeg: system.ffmpeg.available,
      ffprobe: system.ffprobe.available,
      ytdlp: system.ytdlp.available,
    },
  };
}

export function publicTool(t, settings, system) {
  const missing = (t.requires || []).filter((req) => !system[req]?.available);
  const requiresConfig = t.requiresConfig === "ai" && !settings?.ai?.apiKey;
  return {
    id: t.id,
    category: t.category,
    name: t.name,
    description: t.description,
    keywords: t.keywords,
    accept: t.accept,
    minFiles: t.minFiles,
    maxFiles: t.maxFiles,
    fields: t.fields,
    available: missing.length === 0,
    unavailableReason: missing.length ? t.unavailableReason || `Missing dependency: ${missing.join(", ")}` : null,
    requiresConfig,
    configHint: requiresConfig ? "Add an API key in Settings → AI to enable this tool." : null,
  };
}

export function toolCatalogForSearch() {
  return tools.map((t) => ({ id: t.id, name: t.name, category: t.category, keywords: t.keywords }));
}
