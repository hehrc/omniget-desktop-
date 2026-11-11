import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import JSZip from "jszip";
import { BookRepo, BookmarkRepo, NoteRepo, addStudySeconds } from "./db.js";
import { LIBRARY_DIR, assertInside, mimeFromName, safeName, uid, now } from "./util.js";

const BOOKS_DIR = path.join(LIBRARY_DIR, "books");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function decodeHref(href) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function safeRelPath(input) {
  const raw = decodeHref(String(input || "").replace(/^\/+/, "")).split("#")[0].split("?")[0];
  const norm = path.posix.normalize(raw);
  if (norm.startsWith("../") || norm === ".." || path.isAbsolute(norm)) {
    throw Object.assign(new Error("Unsafe archive path: " + input), { status: 400 });
  }
  return norm.replace(/^\.\//, "");
}

function findExisting(hash) {
  const rows = BookRepo.list();
  return rows.find((b) => b.metadata?.hash === hash) || null;
}

export async function importBookFile(filePath, { downloadId = null, originalName = null } = {}) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  if (![".pdf", ".epub"].includes(ext)) {
    const err = new Error("Only PDF and EPUB files can be added to the study library");
    err.status = 422;
    throw err;
  }
  const buf = await fsp.readFile(filePath);
  const hash = sha256(buf);
  const existing = findExisting(hash);
  if (existing) return existing;

  const id = uid("bk_");
  const dir = path.join(BOOKS_DIR, id);
  ensureDir(dir);
  const displayName = safeName(originalName || path.basename(filePath), "book" + ext);
  const sourceCopy = path.join(dir, displayName);
  await fsp.writeFile(sourceCopy, buf);

  let book;
  if (ext === ".epub") {
    book = await importEpub({ id, dir, buf, sourceCopy, hash });
  } else {
    book = await importPdf({ id, dir, buf, sourceCopy, hash });
  }
  if (downloadId) book.metadata.downloadId = downloadId;
  const inserted = BookRepo.insert(book);
  if (book.chapters) BookRepo.setChapters(id, book.chapters);
  return BookRepo.get(inserted.id);
}

async function importEpub({ id, dir, buf, sourceCopy, hash }) {
  const zip = await JSZip.loadAsync(buf);
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) {
    const err = new Error("This EPUB is missing META-INF/container.xml");
    err.status = 422;
    throw err;
  }
  const containerXml = await containerFile.async("string");
  const $c = cheerio.load(containerXml, { xmlMode: true });
  const rootPath = $c("rootfile").attr("full-path");
  if (!rootPath) {
    const err = new Error("This EPUB does not declare a package document");
    err.status = 422;
    throw err;
  }
  const opfPath = safeRelPath(rootPath);
  const opfFile = zip.file(opfPath);
  if (!opfFile) {
    const err = new Error("The EPUB package document is missing");
    err.status = 422;
    throw err;
  }
  const opf = await opfFile.async("string");
  const $ = cheerio.load(opf, { xmlMode: true });
  const opfDir = path.posix.dirname(opfPath);

  const title = textOf($, ["dc:title", "title"]) || path.basename(sourceCopy, ".epub");
  const author = textOf($, ["dc:creator", "creator"]) || "Unknown author";
  const language = textOf($, ["dc:language", "language"]);
  const publisher = textOf($, ["dc:publisher", "publisher"]);
  const description = textOf($, ["dc:description", "description"]);
  const date = textOf($, ["dc:date", "date"]);
  const identifiers = [];
  $("identifier, dc\\:identifier").each((_, el) => {
    const v = $(el).text().trim();
    if (v) identifiers.push(v);
  });

  const manifest = new Map();
  $("manifest item, item").each((_, el) => {
    const $el = $(el);
    const itemId = $el.attr("id");
    const href = $el.attr("href");
    if (!itemId || !href) return;
    const rel = safeRelPath(path.posix.join(opfDir, href));
    manifest.set(itemId, {
      id: itemId,
      href: rel,
      mediaType: $el.attr("media-type") || "",
      properties: $el.attr("properties") || "",
    });
  });

  let coverPath = null;
  let coverMime = null;
  const coverMeta = $('meta[name="cover"]').attr("content");
  let coverItem = coverMeta ? manifest.get(coverMeta) : null;
  if (!coverItem) {
    coverItem = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes("cover-image"));
  }
  if (coverItem) {
    const zf = zip.file(coverItem.href);
    if (zf) {
      const ext = path.extname(coverItem.href) || ".jpg";
      coverPath = path.join(dir, "cover" + ext);
      await fsp.writeFile(coverPath, await zf.async("nodebuffer"));
      coverMime = coverItem.mediaType || mimeFromName(coverPath, "image/jpeg");
    }
  }

  // Table of contents from EPUB3 nav or EPUB2 NCX.
  const tocTitles = new Map();
  const navItem = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes("nav"));
  if (navItem) {
    const navFile = zip.file(navItem.href);
    if (navFile) {
      const navHtml = await navFile.async("string");
      const $n = cheerio.load(navHtml, { xmlMode: false });
      const navs = $n("nav").toArray();
      const tocNav =
        navs.find((el) => {
          const attrs = el.attribs || {};
          return Object.entries(attrs).some(([k, v]) => /type$/i.test(k) && /toc/i.test(v));
        }) || navs[0];
      $n(tocNav || "body")
        .find("a[href]")
        .each((_, el) => {
          const href = $n(el).attr("href");
          const text = $n(el).text().replace(/\s+/g, " ").trim();
          if (!href || !text) return;
          const rel = safeRelPath(path.posix.join(path.posix.dirname(navItem.href), href));
          if (!tocTitles.has(rel)) tocTitles.set(rel, text);
        });
    }
  }
  let ncxItem = [...manifest.values()].find((m) => m.mediaType === "application/x-dtbncx+xml");
  const spineToc = $("spine").attr("toc");
  if (spineToc && manifest.has(spineToc)) ncxItem = manifest.get(spineToc);
  if (ncxItem) {
    const ncxFile = zip.file(ncxItem.href);
    if (ncxFile) {
      const ncx = await ncxFile.async("string");
      const $x = cheerio.load(ncx, { xmlMode: true });
      $x("navPoint, navpoint").each((_, el) => {
        const $el = $x(el);
        const src = $el.find("content").attr("src");
        const label = $el.find("navLabel text, navlabel text").first().text().replace(/\s+/g, " ").trim();
        if (!src) return;
        const rel = safeRelPath(path.posix.join(path.posix.dirname(ncxItem.href), src));
        if (label && !tocTitles.has(rel)) tocTitles.set(rel, label);
      });
    }
  }

  const chapters = [];
  $("spine itemref, itemref").each((_, el) => {
    const idref = $(el).attr("idref");
    if (!idref) return;
    const item = manifest.get(idref);
    if (!item) return;
    const idx = chapters.length;
    const guess = tocTitles.get(item.href) || guessTitleFromHref(item.href) || `Section ${idx + 1}`;
    chapters.push({ idx, title: guess, href: item.href });
  });
  if (!chapters.length) {
    // Some EPUBs omit the spine; fall back to HTML manifest items.
    let idx = 0;
    for (const item of manifest.values()) {
      if (!/html|xhtml/.test(item.mediaType)) continue;
      chapters.push({
        idx,
        title: tocTitles.get(item.href) || guessTitleFromHref(item.href) || `Section ${idx + 1}`,
        href: item.href,
      });
      idx += 1;
    }
  }
  if (!chapters.length) {
    const err = new Error("This EPUB has no readable chapters");
    err.status = 422;
    throw err;
  }

  // Extract every entry (bounded), guarding against traversal and zip bombs.
  let total = 0;
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    if (entry.dir) continue;
    if (/^__MACOSX\//.test(entry.name)) continue;
    let rel;
    try {
      rel = safeRelPath(entry.name);
    } catch {
      continue;
    }
    if (!rel) continue;
    total += entry._data?.uncompressedSize || 0;
    if (total > 600 * 1024 * 1024) {
      const err = new Error("This EPUB is too large to extract safely (over 600 MB)");
      err.status = 413;
      throw err;
    }
    const out = path.join(dir, rel);
    assertInside(dir, out);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, await entry.async("nodebuffer"));
  }

  return {
    id,
    title,
    author,
    format: "epub",
    path: sourceCopy,
    rootDir: dir,
    coverPath,
    coverMime,
    chapterCount: chapters.length,
    metadata: {
      hash,
      language: language || null,
      publisher: publisher || null,
      description: description || null,
      date: date || null,
      identifiers,
      opfPath,
    },
    chapters,
  };
}

function guessTitleFromHref(href) {
  const base = path.basename(href).replace(/\.(x?html?)$/i, "").replace(/[-_]+/g, " ").trim();
  if (!base || /^(chapter|part|section|ch)\s*\d+$/i.test(base)) return "";
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

function textOf($, names) {
  for (const name of names) {
    // XML namespaced tags such as dc:title must have the colon escaped,
    // otherwise css-select reads the prefix as a pseudo-class.
    const el = $(name.replace(/:/g, "\\:")).first();
    const text = el.text().replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

async function importPdf({ id, dir, buf, sourceCopy, hash }) {
  let numPages = 0;
  let info = {};
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    });
    const doc = await task.promise;
    numPages = doc.numPages;
    try {
      const meta = await doc.getMetadata();
      info = meta.info || {};
    } catch {
      info = {};
    }
    await doc.destroy();
  } catch (err) {
    const error = new Error("This PDF could not be parsed: " + err.message);
    error.status = 422;
    throw error;
  }
  const title = info.Title || path.basename(sourceCopy, ".pdf");
  return {
    id,
    title: String(title).replace(/\s+/g, " ").trim().slice(0, 300) || "Untitled PDF",
    author: info.Author || "Unknown author",
    format: "pdf",
    path: sourceCopy,
    rootDir: dir,
    coverPath: null,
    coverMime: null,
    chapterCount: 0,
    metadata: {
      hash,
      numPages,
      subject: info.Subject || null,
      keywords: info.Keywords || null,
      creator: info.Creator || null,
      producer: info.Producer || null,
      creationDate: info.CreationDate || null,
    },
  };
}

export function getBookDetail(id) {
  const book = BookRepo.get(id);
  if (!book) {
    const err = new Error("Book not found");
    err.status = 404;
    throw err;
  }
  return {
    ...book,
    chapters: BookRepo.chapters(id),
    bookmarks: BookmarkRepo.list("book", id),
    notes: NoteRepo.list("book", id),
    coverUrl: book.coverPath ? `/api/books/${id}/cover` : null,
    fileUrl: `/api/books/${id}/file`,
  };
}

export async function readChapter(id, index) {
  const book = BookRepo.get(id);
  if (!book) throw Object.assign(new Error("Book not found"), { status: 404 });
  if (book.format !== "epub") throw Object.assign(new Error("This book is not an EPUB"), { status: 400 });
  const chapters = BookRepo.chapters(id);
  const chapter = chapters.find((c) => c.idx === Number(index));
  if (!chapter) throw Object.assign(new Error("Chapter not found"), { status: 404 });
  const rootDir = book.rootDir;
  const chapterPath = assertInside(rootDir, path.join(rootDir, chapter.href));
  let raw;
  try {
    raw = await fsp.readFile(chapterPath, "utf8");
  } catch (err) {
    throw Object.assign(new Error("Chapter file is missing from the extracted book: " + err.message), { status: 404 });
  }
  return extractChapterHtml(raw, {
    bookId: id,
    chapterHref: chapter.href,
    chapterIndex: chapter.idx,
    chapters,
  });
}

export function extractChapterHtml(raw, { bookId, chapterHref, chapterIndex, chapters }) {
  const $ = cheerio.load(raw, { xmlMode: false });
  $("script, iframe, object, embed, form, base, meta[http-equiv]").remove();
  $("*").each((_, el) => {
    const attribs = el.attribs || {};
    for (const key of Object.keys(attribs)) {
      if (/^on/i.test(key)) delete attribs[key];
      if (key === "style" && /url\s*\(/i.test(attribs[key] || "")) {
        attribs[key] = attribs[key].replace(/url\((['"]?)([^)'"]+)\1\)/gi, (m, q, url) => {
          if (/^(data:|https?:|#)/i.test(url)) return m;
          return `url('${assetUrl(bookId, path.posix.join(path.posix.dirname(chapterHref), decodeHref(url)))}')`;
        });
      }
    }
  });

  const css = [];
  $('link[rel~="stylesheet"], link[type="text/css"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(chapterHref), decodeHref(href.split("#")[0])));
      css.push(assetUrl(bookId, rel));
    }
    $(el).remove();
  });
  $("style").each((_, el) => {
    const text = $(el).html() || "";
    const rewritten = rewriteCssUrls(text, bookId, chapterHref);
    $(el).text(rewritten);
  });

  $("img, source, video, audio").each((_, el) => {
    const $el = $(el);
    for (const attr of ["src", "poster"]) {
      const val = $el.attr(attr);
      if (!val || /^(data:|https?:|blob:|#)/i.test(val)) continue;
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(chapterHref), decodeHref(val.split("#")[0])));
      $el.attr(attr, assetUrl(bookId, rel));
    }
    const srcset = $el.attr("srcset");
    if (srcset) {
      const next = srcset
        .split(",")
        .map((part) => {
          const [url, ...rest] = part.trim().split(/\s+/);
          if (!url || /^(data:|https?:)/i.test(url)) return part.trim();
          const rel = path.posix.normalize(path.posix.join(path.posix.dirname(chapterHref), decodeHref(url)));
          return [assetUrl(bookId, rel), ...rest].join(" ");
        })
        .join(", ");
      $el.attr("srcset", next);
    }
  });

  $("image, use").each((_, el) => {
    const $el = $(el);
    for (const attr of ["href", "xlink:href"]) {
      const val = $el.attr(attr);
      if (!val || /^(data:|https?:|#)/i.test(val)) continue;
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(chapterHref), decodeHref(val)));
      $el.attr(attr, assetUrl(bookId, rel));
    }
  });

  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (!href || /^(https?:|mailto:|tel:)/i.test(href)) return;
    if (href.startsWith("#")) return;
    const [rawPath, frag] = href.split("#");
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(chapterHref), decodeHref(rawPath)));
    const target = chapters.find((c) => c.href === rel);
    if (target) {
      $el.attr("href", "#");
      $el.attr("data-chapter-index", String(target.idx));
    } else {
      $el.attr("href", "#");
    }
  });

  const title =
    $("h1").first().text().replace(/\s+/g, " ").trim() ||
    $("h2").first().text().replace(/\s+/g, " ").trim() ||
    $("title").text().trim() ||
    "";
  const body = $("body").length ? $("body").html() : $.root().html();
  return { html: body || "", css, title, chapterIndex };
}

function rewriteCssUrls(cssText, bookId, baseHref) {
  return String(cssText).replace(/url\((['"]?)([^)'"]+)\1\)/gi, (m, q, url) => {
    if (/^(data:|https?:|#)/i.test(url)) return m;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(baseHref), decodeHref(url)));
    return `url('${assetUrl(bookId, rel)}')`;
  });
}

function assetUrl(bookId, rel) {
  return `/api/books/${bookId}/asset?path=${encodeURIComponent(rel)}`;
}

export async function readBookAsset(id, relPath) {
  const book = BookRepo.get(id);
  if (!book || !book.rootDir) throw Object.assign(new Error("Book not found"), { status: 404 });
  const target = assertInside(book.rootDir, path.join(book.rootDir, safeRelPath(relPath)));
  let data;
  try {
    data = await fsp.readFile(target);
  } catch {
    throw Object.assign(new Error("Book asset not found"), { status: 404 });
  }
  const mime = mimeFromName(target, "application/octet-stream");
  if (mime.startsWith("text/css")) {
    const text = rewriteCssUrls(data.toString("utf8"), id, safeRelPath(relPath));
    return { data: Buffer.from(text, "utf8"), mime: "text/css; charset=utf-8" };
  }
  return { data, mime };
}

export async function deleteBook(id, { deleteFiles = true } = {}) {
  const book = BookRepo.get(id);
  if (!book) throw Object.assign(new Error("Book not found"), { status: 404 });
  if (deleteFiles && book.rootDir) {
    const target = path.resolve(book.rootDir);
    if (target.startsWith(path.resolve(BOOKS_DIR) + path.sep)) {
      await fsp.rm(target, { recursive: true, force: true });
    }
  }
  BookRepo.remove(id);
  return { ok: true };
}

export function updateProgress(id, { progress, chapter, page, scroll, seconds, finished }) {
  const book = BookRepo.get(id);
  if (!book) throw Object.assign(new Error("Book not found"), { status: 404 });
  const patch = { openedAt: now() };
  if (typeof progress === "number") patch.progress = Math.max(0, Math.min(1, progress));
  if (typeof chapter === "number") patch.lastChapter = Math.max(0, Math.round(chapter));
  if (typeof page === "number") patch.lastPage = Math.max(1, Math.round(page));
  if (typeof scroll === "number") patch.lastScroll = Math.max(0, Math.min(1, scroll));
  if (finished) {
    patch.progress = 1;
    patch.status = "finished";
  } else if (patch.progress !== undefined) {
    patch.status = patch.progress >= 0.995 ? "finished" : patch.progress > 0.001 ? "reading" : "unread";
  } else if (book.status === "unread") {
    patch.status = "reading";
  }
  const updated = BookRepo.update(id, patch);
  if (seconds) addStudySeconds("book", id, seconds);
  return updated;
}
