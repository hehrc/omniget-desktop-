/**
 * Test helpers: a temporary instance of the real local service, a fixture HTTP
 * server that speaks real HTTP (including Range), and multipart builders.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function waitFor(fn, { timeout = 15_000, interval = 60, label = "condition" } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

/** Start the real server against a throwaway data directory. */
export async function startApp({ env = {}, allowLocal = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omniget-test-"));
  const port = await freePort();
  const childEnv = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    OMNIGET_DATA_DIR: dataDir,
    ...env,
  };
  if (allowLocal) childEnv.OMNIGET_ALLOW_LOCAL = "1";
  else delete childEnv.OMNIGET_ALLOW_LOCAL;

  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  const collect = (stream, prefix) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) logs.push(`${prefix}${line}`);
      }
    });
  };
  collect(child.stdout, "");
  collect(child.stderr, "[stderr] ");

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(
      async () => {
        if (exited) throw new Error("server exited early:\n" + logs.join("\n"));
        const res = await fetch(base + "/api/health");
        return res.ok;
      },
      { timeout: 20_000, label: "server health" },
    );
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  }

  async function stop() {
    if (!exited) {
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        new Promise((resolve) => child.once("exit", () => resolve(true))),
        delay(4000).then(() => false),
      ]);
      if (!stopped) child.kill("SIGKILL");
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  return { base, port, dataDir, child, logs, stop };
}

/** HTTP client that never hides a server error. */
export async function api(base, pathName, { method = "GET", body, headers, raw = false } = {}) {
  const options = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof FormData) {
      options.body = body;
    } else {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
  }
  const res = await fetch(base + pathName, options);
  const type = res.headers.get("content-type") || "";
  let data = null;
  if (raw) data = await res.arrayBuffer();
  else if (type.includes("application/json")) data = await res.json();
  else data = await res.text();
  return { status: res.status, headers: res.headers, data };
}

export function multipart(fields = {}, files = []) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) fd.append(key, String(item));
    } else {
      fd.append(key, String(value));
    }
  }
  for (const file of files) {
    const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    fd.append(file.field || "file", new Blob([bytes], { type: file.type || "application/octet-stream" }), file.name);
  }
  return fd;
}

export function makeBytes(size, seed = 7) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = (i * 31 + seed) % 251;
  return buf;
}

function rangeOf(req, size) {
  const header = req.headers.range;
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { invalid: true };
  let start;
  let end;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

/**
 * Fixture web server. Slow endpoints stream with Range support so pause/resume
 * exercises the real resumable code path.
 */
export async function startFixture() {
  const bytes = makeBytes(512 * 1024, 11);
  const slowBytes = makeBytes(1_400_000, 29);
  const requests = [];
  let slowTimers = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    requests.push({ method: req.method, path: url.pathname, range: req.headers.range || null });

    if (url.pathname === "/file.bin" || url.pathname === "/named.bin") {
      const body = bytes;
      const range = rangeOf(req, body.length);
      if (range?.invalid) {
        res.writeHead(416, { "content-range": `bytes */${body.length}` });
        return res.end();
      }
      const headers = {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "content-disposition": `attachment; filename="fixture file.bin"`,
      };
      const slice = range ? body.subarray(range.start, range.end + 1) : body;
      if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${body.length}`;
      headers["content-length"] = slice.length;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === "HEAD") return res.end();
      return res.end(slice);
    }

    if (url.pathname === "/slow.bin") {
      const body = slowBytes;
      const range = rangeOf(req, body.length);
      if (range?.invalid) {
        res.writeHead(416, { "content-range": `bytes */${body.length}` });
        return res.end();
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : body.length - 1;
      const headers = {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "content-disposition": 'attachment; filename="slow-fixture.bin"',
        "content-length": end - start + 1,
      };
      if (range) headers["content-range"] = `bytes ${start}-${end}/${body.length}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === "HEAD") return res.end();
      let offset = start;
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer);
          slowTimers.delete(timer);
          return;
        }
        if (offset > end) {
          clearInterval(timer);
          slowTimers.delete(timer);
          res.end();
          return;
        }
        const next = Math.min(offset + 14_000, end + 1);
        res.write(body.subarray(offset, next));
        offset = next;
      }, 14);
      slowTimers.add(timer);
      req.on("close", () => {
        clearInterval(timer);
        slowTimers.delete(timer);
      });
      return;
    }

    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/file.bin" });
      return res.end();
    }

    if (url.pathname === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not here");
    }

    if (url.pathname === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<!doctype html><html><head><title>Fixture page</title></head><body><video src=\"/file.bin\"></video></body></html>");
    }

    if (url.pathname === "/hls/master.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      return res.end(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\nhigh/index.m3u8\n",
      );
    }
    if (url.pathname === "/hls/low/index.m3u8" || url.pathname === "/hls/high/index.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      return res.end("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment-1.ts\n#EXT-X-ENDLIST\n");
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("fixture: unknown route");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    requests,
    bytes,
    slowBytes,
    async stop() {
      for (const timer of slowTimers) clearInterval(timer);
      slowTimers = new Set();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
