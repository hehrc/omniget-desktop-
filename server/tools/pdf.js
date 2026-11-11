import fsp from "node:fs/promises";
import path from "node:path";
import { PDFDocument, degrees } from "pdf-lib";
import JSZip from "jszip";
import { Jimp } from "jimp";
import { ensureExt, parsePageRange } from "./helpers.js";

async function loadPdf(filePath) {
  const bytes = await fsp.readFile(filePath);
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    if (/encrypt|password/i.test(err.message)) {
      throw Object.assign(new Error("This PDF is encrypted or password-protected, which is not supported."), {
        status: 422,
      });
    }
    throw Object.assign(new Error("Could not read “" + path.basename(filePath) + "”: " + err.message), {
      status: 422,
    });
  }
}

async function savePdf(doc, target) {
  const bytes = await doc.save({ useObjectStreams: true });
  await fsp.writeFile(target, bytes);
  return { path: target, name: path.basename(target), mime: "application/pdf", size: bytes.length };
}

export const pdfTools = {
  "pdf-merge": {
    category: "pdf",
    name: "Merge PDFs",
    description: "Combine several PDF files into one document, in the order you select them.",
    keywords: ["combine", "join", "append", "pdf"],
    accept: ".pdf",
    minFiles: 2,
    maxFiles: 20,
    fields: [{ name: "filename", label: "Output filename", type: "text", placeholder: "merged.pdf" }],
    async run(ctx) {
      const out = await PDFDocument.create();
      let pages = 0;
      for (const file of ctx.files) {
        const src = await loadPdf(file.path);
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((p) => out.addPage(p));
        pages += copied.length;
      }
      const target = ctx.out(ensureExt(ctx.values.filename || "merged", "pdf"));
      const result = await savePdf(out, target);
      return { files: [result], summary: `Merged ${ctx.files.length} PDFs into ${pages} pages.` };
    },
  },

  "pdf-split": {
    category: "pdf",
    name: "Split PDF",
    description: "Split a PDF into one file per page and download the result as a ZIP archive.",
    keywords: ["split", "separate", "pages", "pdf"],
    accept: ".pdf",
    minFiles: 1,
    maxFiles: 1,
    fields: [
      { name: "pages", label: "Pages to split", type: "text", placeholder: "1-3,5 (blank = all)" },
      { name: "filename", label: "Archive name", type: "text", placeholder: "split-pages.zip" },
    ],
    async run(ctx) {
      const src = await loadPdf(ctx.files[0].path);
      const ranges = parsePageRange(ctx.values.pages, src.getPageCount());
      const zip = new JSZip();
      for (const pageNum of ranges) {
        const doc = await PDFDocument.create();
        const [copied] = await doc.copyPages(src, [pageNum - 1]);
        doc.addPage(copied);
        zip.file(`page-${String(pageNum).padStart(3, "0")}.pdf`, await doc.save());
      }
      const target = ctx.out(ensureExt(ctx.values.filename || "split-pages", "zip"));
      const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      await fsp.writeFile(target, buf);
      return {
        files: [{ path: target, name: path.basename(target), mime: "application/zip", size: buf.length }],
        summary: `Split ${ranges.length} page${ranges.length === 1 ? "" : "s"} from a ${src.getPageCount()}-page PDF.`,
      };
    },
  },

  "pdf-extract-pages": {
    category: "pdf",
    name: "Extract pages",
    description: "Copy a page selection into a new PDF, preserving the original page content.",
    keywords: ["extract", "pages", "select", "pdf"],
    accept: ".pdf",
    minFiles: 1,
    maxFiles: 1,
    fields: [
      { name: "pages", label: "Pages", type: "text", placeholder: "1-3,7", required: true },
      { name: "filename", label: "Output filename", type: "text", placeholder: "extracted.pdf" },
    ],
    async run(ctx) {
      const src = await loadPdf(ctx.files[0].path);
      const ranges = parsePageRange(ctx.values.pages, src.getPageCount());
      const doc = await PDFDocument.create();
      const copied = await doc.copyPages(
        src,
        ranges.map((p) => p - 1),
      );
      copied.forEach((p) => doc.addPage(p));
      const target = ctx.out(ensureExt(ctx.values.filename || "extracted", "pdf"));
      const result = await savePdf(doc, target);
      return { files: [result], summary: `Extracted ${ranges.length} page(s): ${ranges.join(", ")}.` };
    },
  },

  "pdf-rotate": {
    category: "pdf",
    name: "Rotate PDF",
    description: "Rotate all or selected pages by 90, 180 or 270 degrees.",
    keywords: ["rotate", "orientation", "landscape", "pdf"],
    accept: ".pdf",
    minFiles: 1,
    maxFiles: 1,
    fields: [
      {
        name: "angle",
        label: "Rotation",
        type: "select",
        options: [
          { value: "90", label: "90° clockwise" },
          { value: "180", label: "180°" },
          { value: "270", label: "270° clockwise" },
        ],
        default: "90",
        required: true,
      },
      { name: "pages", label: "Pages", type: "text", placeholder: "blank = all pages" },
      { name: "filename", label: "Output filename", type: "text", placeholder: "rotated.pdf" },
    ],
    async run(ctx) {
      const doc = await loadPdf(ctx.files[0].path);
      const ranges = parsePageRange(ctx.values.pages, doc.getPageCount());
      const angle = Number(ctx.values.angle) || 90;
      for (const pageNum of ranges) {
        const page = doc.getPage(pageNum - 1);
        page.setRotation(degrees(((page.getRotation().angle || 0) + angle) % 360));
      }
      const target = ctx.out(ensureExt(ctx.values.filename || "rotated", "pdf"));
      const result = await savePdf(doc, target);
      return {
        files: [result],
        summary: `Rotated ${ranges.length === doc.getPageCount() ? "all" : ranges.length} page(s) by ${angle}°.`,
      };
    },
  },

  "pdf-metadata": {
    category: "pdf",
    name: "Edit PDF metadata",
    description: "Set the title, author, subject and keywords stored in a PDF document.",
    keywords: ["metadata", "title", "author", "properties", "pdf"],
    accept: ".pdf",
    minFiles: 1,
    maxFiles: 1,
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "author", label: "Author", type: "text" },
      { name: "subject", label: "Subject", type: "text" },
      { name: "keywords", label: "Keywords", type: "text", placeholder: "comma, separated" },
      { name: "filename", label: "Output filename", type: "text", placeholder: "document.pdf" },
    ],
    async run(ctx) {
      const doc = await loadPdf(ctx.files[0].path);
      if (ctx.values.title !== undefined) doc.setTitle(ctx.values.title);
      if (ctx.values.author !== undefined) doc.setAuthor(ctx.values.author);
      if (ctx.values.subject !== undefined) doc.setSubject(ctx.values.subject);
      if (ctx.values.keywords !== undefined) doc.setKeywords(String(ctx.values.keywords).split(",").map((s) => s.trim()).filter(Boolean));
      doc.setModificationDate(new Date());
      const base = ctx.values.filename || path.basename(ctx.files[0].name);
      const target = ctx.out(ensureExt(base, "pdf"));
      const result = await savePdf(doc, target);
      return { files: [result], summary: "Updated PDF metadata." };
    },
  },

  "pdf-info": {
    category: "pdf",
    name: "PDF information",
    description: "Inspect page count, size and embedded document properties.",
    keywords: ["info", "properties", "pages", "pdf"],
    accept: ".pdf",
    minFiles: 1,
    maxFiles: 1,
    fields: [],
    async run(ctx) {
      const file = ctx.files[0];
      const doc = await loadPdf(file.path);
      const stat = await fsp.stat(file.path);
      const info = {
        file: file.name,
        size: stat.size,
        pages: doc.getPageCount(),
        title: doc.getTitle() || null,
        author: doc.getAuthor() || null,
        subject: doc.getSubject() || null,
        keywords: doc.getKeywords() || null,
        creator: doc.getCreator() || null,
        producer: doc.getProducer() || null,
        createdAt: safeDate(doc.getCreationDate()),
        modifiedAt: safeDate(doc.getModificationDate()),
      };
      return {
        text: Object.entries(info)
          .map(([k, v]) => `${k}: ${v ?? "—"}`)
          .join("\n"),
        summary: `${info.pages} page(s) · ${formatSize(stat.size)}`,
        json: info,
      };
    },
  },

  "pdf-to-text": {
    category: "pdf",
    name: "PDF → text",
    description: "Extract selectable text from every page into a UTF-8 text file.",
    keywords: ["text", "extract", "copy", "pdf"],
    accept: ".pdf",
    minFiles: 1,
    maxFiles: 1,
    fields: [
      { name: "filename", label: "Output filename", type: "text", placeholder: "document.txt" },
      { name: "pageBreaks", label: "Insert page markers", type: "checkbox", default: true },
    ],
    async run(ctx) {
      const data = new Uint8Array(await fsp.readFile(ctx.files[0].path));
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
      const doc = await task.promise;
      if (doc.numPages > 2000) throw Object.assign(new Error("PDF has too many pages (limit 2000)"), { status: 422 });
      const chapters = [];
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        let pageText = "";
        for (const item of content.items) {
          if (typeof item.str !== "string") continue;
          pageText += item.str;
          pageText += item.hasEOL ? "\n" : " ";
        }
        pageText = pageText.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
        if (ctx.values.pageBreaks !== false && ctx.values.pageBreaks !== "false") {
          chapters.push(`--- Page ${i} ---\n${pageText}`);
        } else {
          chapters.push(pageText);
        }
      }
      const pageCount = doc.numPages;
      await doc.destroy();
      const text = chapters.join("\n\n");
      const target = ctx.out(ensureExt(ctx.values.filename || path.basename(ctx.files[0].name, ".pdf"), "txt"));
      await fsp.writeFile(target, text, "utf8");
      return {
        files: [{ path: target, name: path.basename(target), mime: "text/plain", size: Buffer.byteLength(text) }],
        summary: `Extracted ${text.length.toLocaleString()} characters from ${pageCount} page(s).`,
        preview: text.slice(0, 1200),
      };
    },
  },

  "images-to-pdf": {
    category: "pdf",
    name: "Images → PDF",
    description: "Place JPG, PNG, GIF or WebP images onto A4 pages and export a PDF.",
    keywords: ["image", "jpg", "png", "photo", "pdf"],
    accept: ".jpg,.jpeg,.png,.gif,.webp",
    minFiles: 1,
    maxFiles: 50,
    fields: [
      { name: "filename", label: "Output filename", type: "text", placeholder: "images.pdf" },
      { name: "margin", label: "Margin (points)", type: "number", default: 36, min: 0, max: 144 },
    ],
    async run(ctx) {
      const doc = await PDFDocument.create();
      const A4 = [595.28, 841.89];
      let count = 0;
      for (const file of ctx.files) {
        const image = await Jimp.read(file.path);
        const png = await image.getBuffer("image/png");
        const embedded = await doc.embedPng(png);
        const margin = Number(ctx.values.margin ?? 36);
        const maxW = A4[0] - margin * 2;
        const maxH = A4[1] - margin * 2;
        const scale = Math.min(maxW / embedded.width, maxH / embedded.height, 1);
        const w = embedded.width * scale;
        const h = embedded.height * scale;
        const page = doc.addPage(A4);
        page.drawImage(embedded, {
          x: (A4[0] - w) / 2,
          y: (A4[1] - h) / 2,
          width: w,
          height: h,
        });
        count += 1;
      }
      const target = ctx.out(ensureExt(ctx.values.filename || "images", "pdf"));
      const result = await savePdf(doc, target);
      return { files: [result], summary: `Created a ${count}-page PDF from ${ctx.files.length} image(s).` };
    },
  },
};

function safeDate(date) {
  try {
    return date ? date.toISOString() : null;
  } catch {
    return null;
  }
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
