import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "jszip";
import * as cheerio from "cheerio";
import { Jimp } from "jimp";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { ensureExt } from "./helpers.js";
import { htmlToText } from "./helpers.js";
import { ffmpegBin } from "../bins.js";

const execFileAsync = promisify(execFile);
const RASTER = ".jpg,.jpeg,.png,.gif,.bmp";

async function openImage(file) {
  try {
    return await Jimp.read(file.path);
  } catch (err) {
    throw Object.assign(new Error(`Could not decode “${file.name}”. Supported inputs are JPG, PNG, GIF and BMP.`), {
      status: 422,
    });
  }
}

function outputForImage(ctx, image, nameBase, format, quality) {
  const ext = format === "jpg" ? "jpg" : "png";
  const target = ctx.out(ensureExt(nameBase, ext));
  return { target, ext };
}

async function writeImage(ctx, image, nameBase, format, quality = 85) {
  const { target } = outputForImage(ctx, image, nameBase, format);
  if (format === "jpg") {
    const buf = await image.getBuffer("image/jpeg", { quality: Number(quality) || 85 });
    await fsp.writeFile(target, buf);
    return { path: target, name: path.basename(target), mime: "image/jpeg", size: buf.length };
  }
  const buf = await image.getBuffer("image/png");
  await fsp.writeFile(target, buf);
  return { path: target, name: path.basename(target), mime: "image/png", size: buf.length };
}

export const mediaTools = {
  "image-resize": {
    category: "images",
    name: "Resize image",
    description: "Resize a JPG or PNG by exact dimensions with contain, cover or stretch fitting.",
    keywords: ["image", "resize", "scale", "dimensions", "png", "jpg"],
    accept: RASTER,
    minFiles: 1,
    maxFiles: 1,
    fields: [
      { name: "width", label: "Width (px)", type: "number", default: 1280, min: 1, max: 20000, required: true },
      { name: "height", label: "Height (px)", type: "number", default: 720, min: 1, max: 20000, required: true },
      {
        name: "fit",
        label: "Fit",
        type: "select",
        options: [
          { value: "contain", label: "Contain (keep aspect, add padding color)" },
          { value: "cover", label: "Cover (crop to fill)" },
          { value: "stretch", label: "Stretch" },
        ],
        default: "contain",
      },
      { name: "format", label: "Output format", type: "select", options: [{ value: "png", label: "PNG" }, { value: "jpg", label: "JPEG" }], default: "png" },
      { name: "quality", label: "JPEG quality", type: "number", default: 85, min: 1, max: 100 },
    ],
    async run(ctx) {
      const image = await openImage(ctx.files[0]);
      const targetW = Math.max(1, Number(ctx.values.width) || 1280);
      const targetH = Math.max(1, Number(ctx.values.height) || 720);
      const fit = ctx.values.fit || "contain";
      if (fit === "stretch") {
        image.resize({ w: targetW, h: targetH });
      } else {
        const scale = fit === "cover" ? Math.max(targetW / image.width, targetH / image.height) : Math.min(targetW / image.width, targetH / image.height);
        const w = Math.max(1, Math.round(image.width * scale));
        const h = Math.max(1, Math.round(image.height * scale));
        image.resize({ w, h });
        if (fit === "cover") {
          const x = Math.max(0, Math.round((image.width - targetW) / 2));
          const y = Math.max(0, Math.round((image.height - targetH) / 2));
          image.crop({ x, y, w: Math.min(targetW, image.width), h: Math.min(targetH, image.height) });
        }
      }
      const out = await writeImage(ctx, image, ctx.files[0].name.replace(/\.[a-z0-9]+$/i, "") + `-${targetW}x${targetH}`, ctx.values.format || "png", ctx.values.quality);
      return {
        files: [out],
        summary: `Resized to ${image.width}×${image.height} (${fit}).`,
      };
    },
  },

  "image-convert": {
    category: "images",
    name: "Convert image",
    description: "Convert JPG, PNG, GIF or BMP images to PNG or JPEG.",
    keywords: ["image", "convert", "png", "jpg", "format"],
    accept: RASTER,
    minFiles: 1,
    maxFiles: 1,
    fields: [
      { name: "format", label: "Output format", type: "select", options: [{ value: "png", label: "PNG" }, { value: "jpg", label: "JPEG" }], default: "png" },
      { name: "quality", label: "JPEG quality", type: "number", default: 90, min: 1, max: 100 },
    ],
    async run(ctx) {
      const image = await openImage(ctx.files[0]);
      const out = await writeImage(ctx, image, ctx.files[0].name.replace(/\.[a-z0-9]+$/i, ""), ctx.values.format || "png", ctx.values.quality);
      return { files: [out], summary: `Converted ${image.width}×${image.height} image.` };
    },
  },

  "image-crop": {
    category: "images",
    name: "Crop image",
    description: "Crop a rectangle from an image using pixel coordinates.",
    keywords: ["image", "crop", "cut", "rectangle"],
    accept: RASTER,
    minFiles: 1,
    maxFiles: 1,
    fields: [
      { name: "x", label: "X", type: "number", default: 0, min: 0, required: true },
      { name: "y", label: "Y", type: "number", default: 0, min: 0, required: true },
      { name: "width", label: "Width", type: "number", default: 512, min: 1, required: true },
      { name: "height", label: "Height", type: "number", default: 512, min: 1, required: true },
      { name: "format", label: "Output format", type: "select", options: [{ value: "png", label: "PNG" }, { value: "jpg", label: "JPEG" }], default: "png" },
    ],
    async run(ctx) {
      const image = await openImage(ctx.files[0]);
      const x = Math.max(0, Math.min(image.width - 1, Number(ctx.values.x) || 0));
      const y = Math.max(0, Math.min(image.height - 1, Number(ctx.values.y) || 0));
      const w = Math.max(1, Math.min(image.width - x, Number(ctx.values.width) || 512));
      const h = Math.max(1, Math.min(image.height - y, Number(ctx.values.height) || 512));
      image.crop({ x, y, w, h });
      const out = await writeImage(ctx, image, ctx.files[0].name.replace(/\.[a-z0-9]+$/i, "") + "-crop", ctx.values.format || "png");
      return { files: [out], summary: `Cropped ${w}×${h} at (${x}, ${y}).` };
    },
  },

  "image-info": {
    category: "images",
    name: "Image information",
    description: "Read pixel dimensions, aspect ratio and file size of an image.",
    keywords: ["image", "info", "dimensions", "size", "aspect"],
    accept: RASTER,
    minFiles: 1,
    maxFiles: 1,
    fields: [],
    async run(ctx) {
      const image = await openImage(ctx.files[0]);
      const stat = await fsp.stat(ctx.files[0].path);
      const ratio = image.width / image.height;
      const text = `Width: ${image.width} px\nHeight: ${image.height} px\nAspect ratio: ${ratio.toFixed(3)} (${simplifyRatio(image.width, image.height)})\nFile size: ${stat.size.toLocaleString()} bytes\nMegapixels: ${((image.width * image.height) / 1e6).toFixed(2)} MP`;
      return { text, summary: `${image.width}×${image.height} · ${simplifyRatio(image.width, image.height)}` };
    },
  },

  "qr-generate": {
    category: "utilities",
    name: "QR code generator",
    description: "Generate a PNG or SVG QR code for a URL, text or Wi-Fi payload.",
    keywords: ["qr", "barcode", "url", "share", "generate"],
    accept: "",
    minFiles: 0,
    maxFiles: 0,
    fields: [
      { name: "text", label: "Content", type: "textarea", placeholder: "https://example.com", required: true },
      { name: "size", label: "Size (px)", type: "number", default: 512, min: 64, max: 2048 },
      { name: "format", label: "Format", type: "select", options: [{ value: "png", label: "PNG" }, { value: "svg", label: "SVG" }], default: "png" },
      { name: "margin", label: "Quiet zone", type: "number", default: 2, min: 0, max: 10 },
      { name: "dark", label: "Foreground", type: "text", default: "#1D1D1F" },
      { name: "light", label: "Background", type: "text", default: "#FFFFFF" },
    ],
    async run(ctx) {
      const text = String(ctx.values.text || "");
      if (!text) throw Object.assign(new Error("Enter the content to encode"), { status: 422 });
      const format = ctx.values.format === "svg" ? "svg" : "png";
      const options = {
        width: Math.min(2048, Math.max(64, Number(ctx.values.size) || 512)),
        margin: Math.min(10, Math.max(0, Number(ctx.values.margin) || 0)),
        color: { dark: ctx.values.dark || "#1D1D1F", light: ctx.values.light || "#FFFFFF" },
        errorCorrectionLevel: "M",
      };
      const target = ctx.out("qr-code." + format);
      if (format === "svg") {
        const svg = await QRCode.toString(text, { ...options, type: "svg" });
        await fsp.writeFile(target, svg, "utf8");
        const size = Buffer.byteLength(svg);
        return { files: [{ path: target, name: path.basename(target), mime: "image/svg+xml", size }], summary: `SVG QR code (${options.width}px target) generated.` };
      }
      const buf = await QRCode.toBuffer(text, { ...options, type: "png" });
      await fsp.writeFile(target, buf);
      return { files: [{ path: target, name: path.basename(target), mime: "image/png", size: buf.length }], summary: `PNG QR code (${options.width}px) generated.` };
    },
  },

  "qr-decode": {
    category: "utilities",
    name: "Read QR code",
    description: "Decode a QR code from a PNG, JPG or GIF image entirely on this device.",
    keywords: ["qr", "decode", "scan", "read", "barcode"],
    accept: RASTER,
    minFiles: 1,
    maxFiles: 1,
    fields: [],
    async run(ctx) {
      const image = await openImage(ctx.files[0]);
      const data = new Uint8ClampedArray(image.bitmap.data);
      const result = jsQR(data, image.width, image.height);
      if (!result) throw Object.assign(new Error("No QR code was found in that image"), { status: 422 });
      return {
        text: result.data,
        summary: `Decoded ${result.data.length} characters.`,
        json: { data: result.data, location: result.location },
      };
    },
  },

  "epub-to-text": {
    category: "study",
    name: "EPUB → text",
    description: "Extract the reading order of an EPUB into a plain-text manuscript.",
    keywords: ["epub", "ebook", "text", "extract", "book"],
    accept: ".epub",
    minFiles: 1,
    maxFiles: 1,
    fields: [{ name: "filename", label: "Output filename", type: "text", placeholder: "book.txt" }],
    async run(ctx) {
      const buf = await fsp.readFile(ctx.files[0].path);
      const zip = await JSZip.loadAsync(buf);
      const container = zip.file("META-INF/container.xml");
      if (!container) throw Object.assign(new Error("Invalid EPUB: missing container.xml"), { status: 422 });
      const $c = cheerio.load(await container.async("string"), { xmlMode: true });
      const opfPath = $c("rootfile").attr("full-path");
      const opfFile = opfPath && zip.file(opfPath);
      if (!opfFile) throw Object.assign(new Error("Invalid EPUB: missing package document"), { status: 422 });
      const opfDir = path.posix.dirname(opfPath);
      const $ = cheerio.load(await opfFile.async("string"), { xmlMode: true });
      const manifest = new Map();
      $("item").each((_, el) => {
        const id = $(el).attr("id");
        const href = $(el).attr("href");
        if (id && href) manifest.set(id, path.posix.normalize(path.posix.join(opfDir, decodeURIComponent(href))));
      });
      const spine = [];
      $("itemref").each((_, el) => {
        const idref = $(el).attr("idref");
        if (idref && manifest.has(idref)) spine.push(manifest.get(idref));
      });
      const chunks = [];
      let chars = 0;
      for (const href of spine.slice(0, 400)) {
        const file = zip.file(href);
        if (!file) continue;
        const html = await file.async("string");
        const text = htmlToText(html);
        if (!text) continue;
        chars += text.length;
        chunks.push(text);
        if (chars > 4_000_000) break;
      }
      const output = chunks.join("\n\n" + "—".repeat(20) + "\n\n");
      if (!output.trim()) throw Object.assign(new Error("No text could be extracted from this EPUB"), { status: 422 });
      const base = ctx.values.filename || path.basename(ctx.files[0].name, ".epub");
      const target = ctx.out(ensureExt(base, "txt"));
      await fsp.writeFile(target, output, "utf8");
      return {
        files: [{ path: target, name: path.basename(target), mime: "text/plain", size: Buffer.byteLength(output) }],
        summary: `Extracted ${output.length.toLocaleString()} characters from ${chunks.length} section(s).`,
        preview: output.slice(0, 900),
      };
    },
  },

  "media-info": {
    category: "audio",
    name: "Media information",
    description: "Inspect duration, bitrate, codecs and stream details with ffprobe.",
    keywords: ["media", "video", "audio", "ffprobe", "codec", "duration"],
    accept: "",
    minFiles: 1,
    maxFiles: 1,
    requires: ["ffprobe"],
    unavailableReason: "ffprobe is not installed. Install ffmpeg/ffprobe to enable media inspection.",
    fields: [],
    async run(ctx) {
      const bin = process.env.OMNIGET_FFPROBE || "ffprobe";
      let stdout;
      try {
        ({ stdout } = await execFileAsync(
          bin,
          ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", ctx.files[0].path],
          { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
        ));
      } catch (err) {
        throw Object.assign(new Error("ffprobe failed: " + (err.stderr || err.message)), { status: 500 });
      }
      const json = JSON.parse(stdout);
      const format = json.format || {};
      const streams = (json.streams || []).map((s) => `${s.codec_type}: ${s.codec_name}${s.width ? ` ${s.width}×${s.height}` : ""}${s.channels ? ` ${s.channels}ch` : ""}`);
      const text = [
        `File: ${ctx.files[0].name}`,
        `Duration: ${Number(format.duration || 0).toFixed(2)}s`,
        `Size: ${Number(format.size || 0).toLocaleString()} bytes`,
        `Bitrate: ${Math.round(Number(format.bit_rate || 0) / 1000)} kbps`,
        `Container: ${format.format_name || "—"}`,
        `Streams:`,
        ...streams.map((s) => `  ${s}`),
      ].join("\n");
      return { text, json, summary: `${streams.length} stream(s) · ${Number(format.duration || 0).toFixed(1)}s` };
    },
  },

  "extract-audio": {
    category: "audio",
    name: "Extract audio",
    description: "Export the audio track of a video to MP3 using ffmpeg.",
    keywords: ["audio", "extract", "mp3", "ffmpeg", "video"],
    accept: ".mp4,.mkv,.webm,.mov,.avi,.m4v,.ts",
    minFiles: 1,
    maxFiles: 1,
    requires: ["ffmpeg"],
    unavailableReason: "ffmpeg is not installed, so audio extraction is unavailable.",
    fields: [
      { name: "bitrate", label: "MP3 bitrate (kbps)", type: "select", options: [{ value: "128", label: "128" }, { value: "192", label: "192" }, { value: "256", label: "256" }, { value: "320", label: "320" }], default: "192" },
    ],
    async run(ctx) {
      const target = ctx.out(ctx.files[0].name.replace(/\.[a-z0-9]+$/i, "") + ".mp3");
      const args = ["-y", "-i", ctx.files[0].path, "-vn", "-c:a", "libmp3lame", "-b:a", `${ctx.values.bitrate || 192}k`, target];
      try {
        await execFileAsync(ffmpegBin(), args, { timeout: 15 * 60_000, maxBuffer: 20 * 1024 * 1024 });
      } catch (err) {
        throw Object.assign(new Error("ffmpeg failed: " + String(err.stderr || err.message).slice(-500)), { status: 500 });
      }
      const stat = await fsp.stat(target);
      return {
        files: [{ path: target, name: path.basename(target), mime: "audio/mpeg", size: stat.size }],
        summary: `Extracted MP3 audio (${(stat.size / 1024 / 1024).toFixed(1)} MB).`,
      };
    },
  },
};

function simplifyRatio(w, h) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h) || 1;
  return `${w / d}:${h / d}`;
}
