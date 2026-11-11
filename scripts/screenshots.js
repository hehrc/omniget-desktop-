#!/usr/bin/env node
/**
 * Capture screenshots of the production build against a freshly seeded dataset.
 *
 * The screenshots are not mocked: the script runs scripts/make-fixtures.js,
 * starts the production server on that data directory, and drives Chromium the
 * way a person would. Real downloads, books, audio, notes and tool output are
 * visible in the captures.
 *
 * Usage:
 *   npm run screenshots
 *   node scripts/screenshots.js --out-dir docs/shots
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { api, freePort, waitFor } from "../tests/helpers.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const outDir = path.resolve(arg("out-dir") || path.join(ROOT, "screenshots"));
const dataDir = path.resolve(arg("data-dir") || path.join(ROOT, "data", "screenshots"));
const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };

await fsp.rm(outDir, { recursive: true, force: true });
await fsp.mkdir(path.join(outDir, "desktop"), { recursive: true });
await fsp.mkdir(path.join(outDir, "mobile"), { recursive: true });

/* ------------------------------- seed data -------------------------------- */

console.log("Seeding fixtures…");
const seed = spawn(process.execPath, ["scripts/make-fixtures.js", "--data-dir", dataDir], {
  cwd: ROOT,
  env: { ...process.env, OMNIGET_ALLOW_LOCAL: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let seedLog = "";
seed.stdout.setEncoding("utf8");
seed.stderr.setEncoding("utf8");
seed.stdout.on("data", (chunk) => (seedLog += chunk));
seed.stderr.on("data", (chunk) => (seedLog += chunk));
const seedExit = await new Promise((resolve) => seed.once("exit", resolve));
if (seedExit !== 0) {
  console.error(seedLog);
  throw new Error(`fixture seeding failed with exit code ${seedExit}`);
}
if (process.argv.includes("--verbose")) console.log(seedLog);

/* ------------------------------- app server ------------------------------- */

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", OMNIGET_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => (serverLog += chunk));
child.stderr.on("data", (chunk) => (serverLog += chunk));
let exited = false;
child.on("exit", () => (exited = true));

async function stopServer() {
  if (!exited) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    if (!exited) child.kill("SIGKILL");
  }
}

let browser;
try {
  await waitFor(
    async () => {
      if (exited) throw new Error("server exited early\n" + serverLog);
      const res = await fetch(base + "/api/health").catch(() => null);
      return res?.ok;
    },
    { timeout: 20_000, label: "screenshot server health" },
  );

  const books = (await api(base, "/api/books")).data.books;
  const media = (await api(base, "/api/media")).data.media;
  const pdfBook = books.find((b) => b.format === "pdf");
  const epubBook = books.find((b) => b.format === "epub");
  const audio = media.find((m) => /studio/i.test(m.title)) || media[0];
  if (!pdfBook || !audio) throw new Error("fixtures did not produce a PDF book and an audio item");

  browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--force-color-profile=srgb"],
  });
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const shot = async (name, { fullPage = true } = {}) => {
    await page.waitForTimeout(450);
    const file = path.join(outDir, "desktop", name);
    await page.screenshot({ path: file, fullPage });
    console.log("  captured", path.relative(ROOT, file));
  };

  const goto = async (hash, ready) => {
    await page.goto(`${base}/#${hash}`, { waitUntil: "domcontentloaded" });
    if (ready) await page.locator(ready).first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(500);
  };

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByText("Engine online").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(700);
  await shot("01-home.png");

  await goto("/downloads", "h1.page-title");
  await shot("02-downloads.png");

  await goto("/history", "h1.page-title");
  await shot("03-history.png");

  await goto("/study", "h1.page-title");
  await page.locator(".book-card").first().waitFor({ timeout: 15_000 });
  await shot("04-study.png");

  await goto(`/study/${pdfBook.id}`, ".reader-title");
  await page.locator(".pdf-stage canvas").first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector(".pdf-stage canvas");
    return el && el.dataset.rendered === "true" && el.width > 100;
  });
  await shot("05-reader-pdf.png", { fullPage: false });

  await goto(`/study/${epubBook.id}`, ".reader-title");
  await page.locator(".epub-host").first().waitFor({ timeout: 20_000 });
  await shot("06-reader-epub.png", { fullPage: false });

  await goto("/media", "h1.page-title");
  await page.locator(".media-card").first().waitFor({ timeout: 15_000 });
  await shot("07-media.png");

  await goto(`/media/${audio.id}`, ".player-title");
  await shot("08-player.png", { fullPage: false });

  await goto("/tools", "h1.page-title");
  await page.locator(".tool-card").first().waitFor({ timeout: 15_000 });
  await shot("09-tools.png");

  await goto("/tools/base64", "h1");
  await page.getByLabel("Text input (if no file)").fill("OmniGet keeps the bytes honest.\n");
  await page.getByRole("button", { name: "Run tool" }).click();
  await page.locator(".result-pre").filter({ hasText: Buffer.from("OmniGet keeps the bytes honest.\n").toString("base64") }).waitFor({ timeout: 20_000 });
  await shot("10-tool-base64.png");

  await goto("/settings", "h1.page-title");
  await shot("11-settings.png");

  await goto("/settings", "h1.page-title");
  await page.locator(".settings-tab").filter({ hasText: "Downloads" }).click();
  await shot("12-settings-downloads.png");

  await goto("/about", "h1.about-title");
  await shot("13-about.png");

  await goto("/", "h1.page-title");
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Search and jump" });
  await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "Search" }).fill("quiet");
  await page.waitForTimeout(500);
  await shot("14-command-palette.png", { fullPage: false });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Search and jump" }).waitFor({ state: "detached" });

  /* -------------------------------- mobile -------------------------------- */
  await page.setViewportSize(MOBILE);
  const mobile = async (hash, ready, name) => {
    await goto(hash, ready);
    await page.waitForTimeout(500);
    const file = path.join(outDir, "mobile", name);
    await page.screenshot({ path: file, fullPage: false });
    console.log("  captured", path.relative(ROOT, file));
  };

  await mobile("/", "h1.page-title", "01-home.png");
  await mobile("/downloads", "h1.page-title", "02-downloads.png");
  await mobile("/study", "h1.page-title", "03-study.png");
  await mobile("/tools", "h1.page-title", "04-tools.png");
  await mobile("/media", "h1.page-title", "05-media.png");
  await mobile("/settings", "h1.page-title", "06-settings.png");
  await mobile("/", "h1.page-title", "07-home-drawer.png");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.locator("aside.sidebar.mobile-open").waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "mobile", "07-home-drawer.png"), fullPage: false });

  await context.close();

  if (pageErrors.length) {
    throw new Error("Uncaught page errors:\n" + pageErrors.join("\n"));
  }
  const meaningful = consoleErrors.filter((text) => !/favicon|net::ERR_ABORTED|Failed to load resource/i.test(text));
  if (meaningful.length) {
    throw new Error("Console errors:\n" + meaningful.join("\n"));
  }

  console.log("\nScreenshots written to", path.relative(ROOT, outDir));
} finally {
  try {
    await browser?.close();
  } finally {
    await stopServer();
  }
}
