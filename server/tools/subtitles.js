import fsp from "node:fs/promises";
import path from "node:path";
import {
  cleanCues,
  cuesToSrt,
  cuesToVtt,
  detectSubtitleFormat,
  formatTimestamp,
  mergeSubtitleCues,
  parseSrt,
  parseVtt,
  shiftCues,
  subtitleStats,
} from "../subtitles.js";
import { ensureExt, normalizeText, readText, safeOutputName } from "./helpers.js";

async function loadCues(ctx, fileIndex = 0) {
  const file = ctx.files[fileIndex];
  if (!file) throw Object.assign(new Error("Choose a subtitle file"), { status: 422 });
  const text = await readText(file.path, 10 * 1024 * 1024);
  const format = detectSubtitleFormat(file.name, text);
  const cues = format === "vtt" ? parseVtt(text) : parseSrt(text);
  if (!cues.length) {
    throw Object.assign(new Error("No cues were found in " + file.name), { status: 422 });
  }
  return { cues, format, text };
}

export const subtitleTools = {
  "srt-to-vtt": {
    category: "subtitles",
    name: "SRT → VTT",
    description: "Convert SubRip subtitles to WebVTT for HTML5 video playback.",
    keywords: ["srt", "vtt", "subtitle", "convert", "webvtt"],
    accept: ".srt",
    minFiles: 1,
    maxFiles: 1,
    fields: [{ name: "filename", label: "Output filename", type: "text", placeholder: "subtitles.vtt" }],
    async run(ctx) {
      const { cues } = await loadCues(ctx);
      const output = cuesToVtt(cues);
      const target = ctx.out(ensureExt(ctx.values.filename || ctx.files[0].name.replace(/\.srt$/i, ""), "vtt"));
      await fsp.writeFile(target, output, "utf8");
      return {
        files: [{ path: target, name: path.basename(target), mime: "text/vtt", size: Buffer.byteLength(output) }],
        summary: `Converted ${cues.length} cue(s) to WebVTT.`,
      };
    },
  },

  "vtt-to-srt": {
    category: "subtitles",
    name: "VTT → SRT",
    description: "Convert WebVTT subtitles back to the widely supported SubRip format.",
    keywords: ["vtt", "srt", "subtitle", "convert", "subrip"],
    accept: ".vtt",
    minFiles: 1,
    maxFiles: 1,
    fields: [{ name: "filename", label: "Output filename", type: "text", placeholder: "subtitles.srt" }],
    async run(ctx) {
      const { cues } = await loadCues(ctx);
      const output = cuesToSrt(cues);
      const target = ctx.out(ensureExt(ctx.values.filename || ctx.files[0].name.replace(/\.vtt$/i, ""), "srt"));
      await fsp.writeFile(target, output, "utf8");
      return {
        files: [{ path: target, name: path.basename(target), mime: "application/x-subrip", size: Buffer.byteLength(output) }],
        summary: `Converted ${cues.length} cue(s) to SubRip.`,
      };
    },
  },

  "subtitle-shift": {
    category: "subtitles",
    name: "Shift subtitle timing",
    description: "Move every cue earlier or later by a number of seconds to fix sync.",
    keywords: ["subtitle", "shift", "sync", "offset", "timing", "srt", "vtt"],
    accept: ".srt,.vtt",
    minFiles: 1,
    maxFiles: 1,
    fields: [
      { name: "seconds", label: "Offset in seconds", type: "number", default: 0, step: 0.1, required: true },
      { name: "format", label: "Output format", type: "select", options: [{ value: "same", label: "Same as input" }, { value: "srt", label: "SRT" }, { value: "vtt", label: "VTT" }], default: "same" },
      { name: "filename", label: "Output filename", type: "text" },
    ],
    async run(ctx) {
      const { cues, format } = await loadCues(ctx);
      const offset = Number(ctx.values.seconds) || 0;
      const shifted = shiftCues(cues, offset);
      const outFormat = ctx.values.format && ctx.values.format !== "same" ? ctx.values.format : format;
      const output = outFormat === "vtt" ? cuesToVtt(shifted) : cuesToSrt(shifted);
      const base = ctx.values.filename || ctx.files[0].name.replace(/\.(srt|vtt)$/i, "") + "-shifted";
      const target = ctx.out(ensureExt(base, outFormat));
      await fsp.writeFile(target, output, "utf8");
      return {
        files: [{ path: target, name: path.basename(target), mime: outFormat === "vtt" ? "text/vtt" : "application/x-subrip", size: Buffer.byteLength(output) }],
        summary: `Shifted ${shifted.length} cue(s) by ${offset > 0 ? "+" : ""}${offset}s.`,
      };
    },
  },

  "subtitle-clean": {
    category: "subtitles",
    name: "Clean & deduplicate subtitles",
    description: "Strip markup, trim whitespace, remove empty cues and merge identical neighbours.",
    keywords: ["subtitle", "clean", "dedupe", "markup", "srt", "vtt"],
    accept: ".srt,.vtt",
    minFiles: 1,
    maxFiles: 1,
    fields: [{ name: "format", label: "Output format", type: "select", options: [{ value: "vtt", label: "VTT" }, { value: "srt", label: "SRT" }], default: "vtt" }],
    async run(ctx) {
      const { cues } = await loadCues(ctx);
      const cleaned = mergeSubtitleCues(cleanCues(cues));
      const format = ctx.values.format || "vtt";
      const output = format === "srt" ? cuesToSrt(cleaned) : cuesToVtt(cleaned);
      const target = ctx.out(ctx.files[0].name.replace(/\.(srt|vtt)$/i, "") + "-clean." + format);
      await fsp.writeFile(target, output, "utf8");
      return {
        files: [{ path: target, name: path.basename(target), mime: format === "vtt" ? "text/vtt" : "application/x-subrip", size: Buffer.byteLength(output) }],
        summary: `${cues.length} → ${cleaned.length} cue(s) after cleaning.`,
      };
    },
  },

  "subtitle-merge": {
    category: "subtitles",
    name: "Merge subtitle files",
    description: "Combine multiple subtitle tracks into one timeline, sorted by start time.",
    keywords: ["subtitle", "merge", "combine", "srt", "vtt"],
    accept: ".srt,.vtt",
    minFiles: 2,
    maxFiles: 20,
    fields: [{ name: "format", label: "Output format", type: "select", options: [{ value: "vtt", label: "VTT" }, { value: "srt", label: "SRT" }], default: "vtt" }],
    async run(ctx) {
      let all = [];
      for (let i = 0; i < ctx.files.length; i += 1) {
        const { cues } = await loadCues(ctx, i);
        all = all.concat(cues);
      }
      all.sort((a, b) => a.start - b.start);
      const format = ctx.values.format || "vtt";
      const output = format === "srt" ? cuesToSrt(all) : cuesToVtt(all);
      const target = ctx.out("merged-subtitles." + format);
      await fsp.writeFile(target, output, "utf8");
      return {
        files: [{ path: target, name: path.basename(target), mime: format === "vtt" ? "text/vtt" : "application/x-subrip", size: Buffer.byteLength(output) }],
        summary: `Merged ${ctx.files.length} files into ${all.length} cues.`,
      };
    },
  },

  "subtitle-stats": {
    category: "subtitles",
    name: "Subtitle statistics",
    description: "Measure cue count, duration, words and characters per second (CPS).",
    keywords: ["subtitle", "stats", "cps", "reading", "srt", "vtt"],
    accept: ".srt,.vtt",
    minFiles: 1,
    maxFiles: 1,
    fields: [],
    async run(ctx) {
      const { cues, format } = await loadCues(ctx);
      const stats = subtitleStats(cues);
      const text = [
        `File: ${ctx.files[0].name}`,
        `Format: ${format.toUpperCase()}`,
        `Cues: ${stats.cues}`,
        `Timed duration: ${stats.duration.toFixed(1)}s (${formatTimestamp(stats.duration)})`,
        `First cue: ${formatTimestamp(stats.first)}`,
        `Last cue end: ${formatTimestamp(stats.last)}`,
        `Words: ${stats.words}`,
        `Characters: ${stats.chars}`,
        `Characters per second: ${stats.cps.toFixed(2)}`,
        `Reading load: ${stats.cps > 20 ? "high" : stats.cps > 15 ? "moderate" : "comfortable"}`,
      ].join("\n");
      return { text, summary: `${stats.cues} cues · ${stats.cps.toFixed(1)} CPS` };
    },
  },
};

export { normalizeText, safeOutputName };
