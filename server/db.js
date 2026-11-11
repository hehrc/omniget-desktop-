import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH, ensureDirs, now } from "./util.js";

ensureDirs();

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  final_url TEXT,
  source TEXT,
  source_label TEXT,
  kind TEXT,
  title TEXT,
  filename TEXT,
  file_path TEXT,
  part_path TEXT,
  mime TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  quality TEXT,
  thumbnail TEXT,
  duration_seconds REAL,
  range_supported INTEGER NOT NULL DEFAULT 0,
  speed_bps INTEGER NOT NULL DEFAULT 0,
  eta_seconds INTEGER,
  segments_total INTEGER NOT NULL DEFAULT 0,
  segments_done INTEGER NOT NULL DEFAULT 0,
  engine TEXT NOT NULL DEFAULT 'http',
  options_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);

CREATE TABLE IF NOT EXISTS download_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  download_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_download ON download_logs(download_id, ts);

CREATE TABLE IF NOT EXISTS download_outputs (
  id TEXT PRIMARY KEY,
  download_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  label TEXT
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  download_id TEXT,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  kind TEXT NOT NULL DEFAULT 'video',
  size INTEGER NOT NULL DEFAULT 0,
  duration REAL,
  thumbnail TEXT,
  position REAL NOT NULL DEFAULT 0,
  watched_seconds REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subtitles (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  label TEXT NOT NULL,
  lang TEXT,
  path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'text/vtt',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  format TEXT NOT NULL,
  path TEXT NOT NULL,
  root_dir TEXT,
  cover_path TEXT,
  cover_mime TEXT,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  last_chapter INTEGER NOT NULL DEFAULT 0,
  last_page INTEGER NOT NULL DEFAULT 1,
  last_scroll REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unread',
  added_at INTEGER NOT NULL,
  opened_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS book_chapters (
  book_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  href TEXT NOT NULL,
  PRIMARY KEY (book_id, idx)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  chapter INTEGER,
  page INTEGER,
  position REAL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_target ON bookmarks(target_type, target_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  chapter INTEGER,
  page INTEGER,
  position REAL,
  time_seconds REAL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_target ON notes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);

CREATE TABLE IF NOT EXISTS tool_jobs (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`);

export function tx(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/* ------------------------------- downloads ------------------------------- */

export function rowToDownload(row) {
  if (!row) return null;
  return {
    id: row.id,
    url: row.url,
    finalUrl: row.final_url,
    source: row.source,
    sourceLabel: row.source_label,
    kind: row.kind,
    title: row.title,
    filename: row.filename,
    filePath: row.file_path,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes) || 0,
    downloadedBytes: Number(row.downloaded_bytes) || 0,
    status: row.status,
    error: row.error,
    quality: row.quality,
    thumbnail: row.thumbnail,
    durationSeconds: row.duration_seconds,
    rangeSupported: !!row.range_supported,
    speedBps: Number(row.speed_bps) || 0,
    etaSeconds: row.eta_seconds,
    segmentsTotal: Number(row.segments_total) || 0,
    segmentsDone: Number(row.segments_done) || 0,
    engine: row.engine,
    options: safeJson(row.options_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export const DownloadRepo = {
  insert(data) {
    const ts = now();
    db.prepare(
      `INSERT INTO downloads (id,url,final_url,source,source_label,kind,title,filename,file_path,part_path,mime,
        size_bytes,downloaded_bytes,status,error,quality,thumbnail,duration_seconds,range_supported,engine,
        options_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      data.id,
      data.url,
      data.finalUrl || null,
      data.source || null,
      data.sourceLabel || null,
      data.kind || "other",
      data.title || null,
      data.filename || null,
      data.filePath || null,
      data.partPath || null,
      data.mime || null,
      data.sizeBytes || 0,
      data.downloadedBytes || 0,
      data.status || "queued",
      data.error || null,
      data.quality || null,
      data.thumbnail || null,
      data.durationSeconds || null,
      data.rangeSupported ? 1 : 0,
      data.engine || "http",
      JSON.stringify(data.options || {}),
      ts,
      ts,
    );
    return this.get(data.id);
  },
  get(id) {
    return rowToDownload(db.prepare("SELECT * FROM downloads WHERE id = ?").get(id));
  },
  list({ status, limit = 200 } = {}) {
    let sql = "SELECT * FROM downloads";
    const params = [];
    if (status && status !== "all") {
      if (status === "active") {
        sql += " WHERE status IN ('queued','probing','downloading','paused')";
      } else if (status === "finished") {
        sql += " WHERE status IN ('completed','failed','canceled')";
      } else {
        sql += " WHERE status = ?";
        params.push(status);
      }
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    return db.prepare(sql).all(...params).map(rowToDownload);
  },
  update(id, fields) {
    const allowed = {
      finalUrl: "final_url",
      source: "source",
      sourceLabel: "source_label",
      kind: "kind",
      title: "title",
      filename: "filename",
      filePath: "file_path",
      partPath: "part_path",
      mime: "mime",
      sizeBytes: "size_bytes",
      downloadedBytes: "downloaded_bytes",
      status: "status",
      error: "error",
      quality: "quality",
      thumbnail: "thumbnail",
      durationSeconds: "duration_seconds",
      rangeSupported: "range_supported",
      speedBps: "speed_bps",
      etaSeconds: "eta_seconds",
      segmentsTotal: "segments_total",
      segmentsDone: "segments_done",
      engine: "engine",
      startedAt: "started_at",
      completedAt: "completed_at",
    };
    const sets = [];
    const params = [];
    for (const [key, col] of Object.entries(allowed)) {
      if (fields[key] !== undefined) {
        let value = fields[key];
        if (typeof value === "boolean") value = value ? 1 : 0;
        sets.push(`${col} = ?`);
        params.push(value);
      }
    }
    if (!sets.length) return this.get(id);
    sets.push("updated_at = ?");
    params.push(now(), id);
    db.prepare(`UPDATE downloads SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id);
  },
  remove(id) {
    db.prepare("DELETE FROM download_outputs WHERE download_id = ?").run(id);
    db.prepare("DELETE FROM download_logs WHERE download_id = ?").run(id);
    db.prepare("DELETE FROM downloads WHERE id = ?").run(id);
  },
  logs(id, limit = 100) {
    return db
      .prepare("SELECT * FROM download_logs WHERE download_id = ? ORDER BY ts ASC, id ASC LIMIT ?")
      .all(id, limit)
      .map((r) => ({ id: r.id, ts: r.ts, level: r.level, message: r.message }));
  },
  addLog(id, level, message) {
    db.prepare("INSERT INTO download_logs (download_id, ts, level, message) VALUES (?,?,?,?)").run(
      id,
      now(),
      level,
      String(message).slice(0, 4000),
    );
    db.prepare("DELETE FROM download_logs WHERE download_id = ? AND id NOT IN (SELECT id FROM download_logs WHERE download_id = ? ORDER BY id DESC LIMIT 300)").run(id, id);
  },
  counts() {
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM downloads GROUP BY status").all();
    const out = { all: 0, queued: 0, downloading: 0, paused: 0, completed: 0, failed: 0, canceled: 0, active: 0 };
    for (const r of rows) {
      out[r.status] = Number(r.n);
      out.all += Number(r.n);
    }
    out.active = out.queued + out.downloading + out.paused;
    const bytes = db
      .prepare("SELECT COALESCE(SUM(CASE WHEN status='completed' THEN size_bytes ELSE 0 END),0) AS b FROM downloads")
      .get();
    out.bytesSaved = Number(bytes.b) || 0;
    return out;
  },
  recover() {
    db.prepare(
      "UPDATE downloads SET status = 'paused', speed_bps = 0, eta_seconds = NULL, updated_at = ? WHERE status IN ('downloading','probing')",
    ).run(now());
    db.prepare("UPDATE downloads SET status = 'queued', updated_at = ? WHERE status = 'queued'").run(now());
  },
};

/* --------------------------------- media --------------------------------- */

export function rowToMedia(row) {
  if (!row) return null;
  return {
    id: row.id,
    downloadId: row.download_id,
    title: row.title,
    path: row.path,
    mime: row.mime,
    kind: row.kind,
    size: Number(row.size) || 0,
    duration: row.duration,
    thumbnail: row.thumbnail,
    position: Number(row.position) || 0,
    watchedSeconds: Number(row.watched_seconds) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const MediaRepo = {
  insert(data) {
    const ts = now();
    db.prepare(
      `INSERT INTO media (id,download_id,title,path,mime,kind,size,duration,thumbnail,position,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      data.id,
      data.downloadId || null,
      data.title,
      data.path,
      data.mime || null,
      data.kind || "video",
      data.size || 0,
      data.duration || null,
      data.thumbnail || null,
      data.position || 0,
      ts,
      ts,
    );
    return this.get(data.id);
  },
  get(id) {
    return rowToMedia(db.prepare("SELECT * FROM media WHERE id = ?").get(id));
  },
  byDownload(downloadId) {
    return rowToMedia(db.prepare("SELECT * FROM media WHERE download_id = ?").get(downloadId));
  },
  list() {
    return db.prepare("SELECT * FROM media ORDER BY updated_at DESC").all().map(rowToMedia);
  },
  update(id, fields) {
    const map = {
      title: "title",
      position: "position",
      watchedSeconds: "watched_seconds",
      duration: "duration",
      thumbnail: "thumbnail",
      path: "path",
      mime: "mime",
    };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) {
      if (fields[k] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(fields[k]);
      }
    }
    if (!sets.length) return this.get(id);
    sets.push("updated_at = ?");
    params.push(now(), id);
    db.prepare(`UPDATE media SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id);
  },
  remove(id) {
    db.prepare("DELETE FROM subtitles WHERE media_id = ?").run(id);
    db.prepare("DELETE FROM notes WHERE target_type = 'media' AND target_id = ?").run(id);
    db.prepare("DELETE FROM media WHERE id = ?").run(id);
  },
  subtitles(mediaId) {
    return db
      .prepare("SELECT id, media_id AS mediaId, label, lang, path, mime, created_at AS createdAt FROM subtitles WHERE media_id = ? ORDER BY created_at ASC")
      .all(mediaId);
  },
  addSubtitle(data) {
    db.prepare("INSERT INTO subtitles (id,media_id,label,lang,path,mime,created_at) VALUES (?,?,?,?,?,?,?)").run(
      data.id,
      data.mediaId,
      data.label,
      data.lang || null,
      data.path,
      data.mime || "text/vtt",
      now(),
    );
  },
  getSubtitle(id) {
    return db.prepare("SELECT * FROM subtitles WHERE id = ?").get(id);
  },
  removeSubtitle(id) {
    const row = db.prepare("SELECT * FROM subtitles WHERE id = ?").get(id);
    db.prepare("DELETE FROM subtitles WHERE id = ?").run(id);
    return row;
  },
};

/* --------------------------------- books --------------------------------- */

export function rowToBook(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    format: row.format,
    path: row.path,
    rootDir: row.root_dir,
    coverPath: row.cover_path,
    coverMime: row.cover_mime,
    chapterCount: row.chapter_count,
    progress: Number(row.progress) || 0,
    lastChapter: row.last_chapter,
    lastPage: row.last_page,
    lastScroll: Number(row.last_scroll) || 0,
    status: row.status,
    addedAt: row.added_at,
    openedAt: row.opened_at,
    metadata: safeJson(row.metadata_json),
  };
}

export const BookRepo = {
  insert(data) {
    const ts = now();
    db.prepare(
      `INSERT INTO books (id,title,author,format,path,root_dir,cover_path,cover_mime,chapter_count,
        progress,last_chapter,last_page,last_scroll,status,added_at,opened_at,metadata_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      data.id,
      data.title,
      data.author || null,
      data.format,
      data.path,
      data.rootDir || null,
      data.coverPath || null,
      data.coverMime || null,
      data.chapterCount || 0,
      data.progress || 0,
      data.lastChapter || 0,
      data.lastPage || 1,
      data.lastScroll || 0,
      data.status || "unread",
      ts,
      null,
      JSON.stringify(data.metadata || {}),
    );
    return this.get(data.id);
  },
  get(id) {
    return rowToBook(db.prepare("SELECT * FROM books WHERE id = ?").get(id));
  },
  list() {
    return db.prepare("SELECT * FROM books ORDER BY COALESCE(opened_at, added_at) DESC").all().map(rowToBook);
  },
  update(id, fields) {
    const map = {
      title: "title",
      author: "author",
      progress: "progress",
      lastChapter: "last_chapter",
      lastPage: "last_page",
      lastScroll: "last_scroll",
      status: "status",
      openedAt: "opened_at",
      coverPath: "cover_path",
      coverMime: "cover_mime",
      chapterCount: "chapter_count",
      metadata: "metadata_json",
    };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) {
      if (fields[k] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(k === "metadata" ? JSON.stringify(fields[k]) : fields[k]);
      }
    }
    if (!sets.length) return this.get(id);
    db.prepare(`UPDATE books SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    return this.get(id);
  },
  remove(id) {
    db.prepare("DELETE FROM book_chapters WHERE book_id = ?").run(id);
    db.prepare("DELETE FROM bookmarks WHERE target_type = 'book' AND target_id = ?").run(id);
    db.prepare("DELETE FROM notes WHERE target_type = 'book' AND target_id = ?").run(id);
    db.prepare("DELETE FROM books WHERE id = ?").run(id);
  },
  chapters(bookId) {
    return db
      .prepare("SELECT idx, title, href FROM book_chapters WHERE book_id = ? ORDER BY idx")
      .all(bookId);
  },
  setChapters(bookId, chapters) {
    db.prepare("DELETE FROM book_chapters WHERE book_id = ?").run(bookId);
    const stmt = db.prepare("INSERT INTO book_chapters (book_id, idx, title, href) VALUES (?,?,?,?)");
    for (const c of chapters) stmt.run(bookId, c.idx, c.title, c.href);
  },
};

/* ------------------------------ bookmarks -------------------------------- */

export const BookmarkRepo = {
  list(targetType, targetId) {
    return db
      .prepare("SELECT * FROM bookmarks WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC")
      .all(targetType, targetId)
      .map((r) => ({
        id: r.id,
        targetType: r.target_type,
        targetId: r.target_id,
        chapter: r.chapter,
        page: r.page,
        position: r.position,
        label: r.label,
        createdAt: r.created_at,
      }));
  },
  add(data) {
    db.prepare(
      "INSERT INTO bookmarks (id,target_type,target_id,chapter,page,position,label,created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      data.id,
      data.targetType,
      data.targetId,
      data.chapter ?? null,
      data.page ?? null,
      data.position ?? null,
      data.label,
      now(),
    );
    return { ...data, createdAt: now() };
  },
  remove(id) {
    db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
  },
};

/* --------------------------------- notes --------------------------------- */

export const NoteRepo = {
  list(targetType, targetId) {
    return db
      .prepare("SELECT * FROM notes WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC")
      .all(targetType, targetId)
      .map(rowToNote);
  },
  all(limit = 500) {
    return db.prepare("SELECT * FROM notes ORDER BY created_at DESC LIMIT ?").all(limit).map(rowToNote);
  },
  get(id) {
    return rowToNote(db.prepare("SELECT * FROM notes WHERE id = ?").get(id));
  },
  add(data) {
    const ts = now();
    db.prepare(
      `INSERT INTO notes (id,target_type,target_id,chapter,page,position,time_seconds,body,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      data.id,
      data.targetType,
      data.targetId,
      data.chapter ?? null,
      data.page ?? null,
      data.position ?? null,
      data.timeSeconds ?? null,
      data.body,
      ts,
      ts,
    );
    return this.get(data.id);
  },
  update(id, body) {
    db.prepare("UPDATE notes SET body = ?, updated_at = ? WHERE id = ?").run(body, now(), id);
    return this.get(id);
  },
  remove(id) {
    db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  },
  counts() {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n) || 0;
  },
};

function rowToNote(r) {
  if (!r) return null;
  return {
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    chapter: r.chapter,
    page: r.page,
    position: r.position,
    timeSeconds: r.time_seconds,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ------------------------------- tool jobs ------------------------------- */

export const ToolJobRepo = {
  insert(data) {
    db.prepare(
      "INSERT INTO tool_jobs (id,tool_id,status,input_json,output_json,error,created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
      data.id,
      data.toolId,
      data.status || "running",
      JSON.stringify(data.input || {}),
      JSON.stringify(data.output || {}),
      data.error || null,
      now(),
    );
  },
  update(id, fields) {
    const sets = [];
    const params = [];
    if (fields.status) {
      sets.push("status = ?");
      params.push(fields.status);
    }
    if (fields.output) {
      sets.push("output_json = ?");
      params.push(JSON.stringify(fields.output));
    }
    if (fields.error !== undefined) {
      sets.push("error = ?");
      params.push(fields.error);
    }
    if (fields.completedAt) {
      sets.push("completed_at = ?");
      params.push(fields.completedAt);
    }
    if (!sets.length) return;
    db.prepare(`UPDATE tool_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  },
  get(id) {
    const r = db.prepare("SELECT * FROM tool_jobs WHERE id = ?").get(id);
    if (!r) return null;
    return {
      id: r.id,
      toolId: r.tool_id,
      status: r.status,
      input: safeJson(r.input_json),
      output: safeJson(r.output_json),
      error: r.error,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    };
  },
  list(limit = 50) {
    return db
      .prepare("SELECT * FROM tool_jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((r) => ({
        id: r.id,
        toolId: r.tool_id,
        status: r.status,
        output: safeJson(r.output_json),
        error: r.error,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      }));
  },
};

/* --------------------------------- stats --------------------------------- */

export function getStats() {
  const downloads = DownloadRepo.counts();
  const books = db.prepare("SELECT COUNT(*) AS n FROM books").get();
  const reading = db.prepare("SELECT COUNT(*) AS n FROM books WHERE status = 'reading'").get();
  const media = db.prepare("SELECT COUNT(*) AS n FROM media").get();
  const notes = db.prepare("SELECT COUNT(*) AS n FROM notes").get();
  const page = db
    .prepare("SELECT COALESCE(SUM(seconds),0) AS s FROM study_sessions")
    .get();
  const day = new Date().toISOString().slice(0, 10);
  const today = db
    .prepare("SELECT COALESCE(SUM(seconds),0) AS s FROM study_sessions WHERE day = ?")
    .get(day);
  const saved = downloads.bytesSaved;
  return {
    downloads,
    books: Number(books.n) || 0,
    reading: Number(reading.n) || 0,
    media: Number(media.n) || 0,
    notes: Number(notes.n) || 0,
    studySeconds: Number(page.s) || 0,
    studyTodaySeconds: Number(today.s) || 0,
    bytesSaved: saved,
  };
}

export function addStudySeconds(targetType, targetId, seconds) {
  if (!seconds || seconds < 1) return;
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    "INSERT INTO study_sessions (target_type,target_id,seconds,day,created_at) VALUES (?,?,?,?,?)",
  ).run(targetType, targetId, Math.round(seconds), day, now());
}
