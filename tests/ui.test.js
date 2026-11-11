/**
 * Browser tests against the production build with headless Chromium.
 * The UI is driven the way a person would use it: clicks, typing, shortcuts.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { api, multipart, startApp, startFixture } from "./helpers.js";

const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

let app;
let fixture;
let browser;
let page;
const consoleErrors = [];
const pageErrors = [];
const serverErrors = [];

before(async () => {
  app = await startApp({ allowLocal: true });
  fixture = await startFixture();
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("response", (res) => {
    if (res.status() >= 500) serverErrors.push(`${res.status()} ${res.url()}`);
  });
  await page.goto(app.base + "/", { waitUntil: "domcontentloaded" });
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      await fixture?.stop();
    } finally {
      await app?.stop();
    }
  }
});

async function heading(text, selector = "h1.page-title") {
  await page.locator(selector).filter({ hasText: text }).first().waitFor({ timeout: 15_000 });
}

async function go(hash) {
  await page.evaluate((target) => {
    window.location.hash = target;
  }, hash);
}

async function waitForEngine() {
  await page.getByText("Engine online").waitFor({ timeout: 15_000 });
}

async function assertNoHorizontalOverflow(label) {
  const sizes = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    win: window.innerWidth,
  }));
  assert.ok(
    sizes.doc <= sizes.win + 1 && sizes.body <= sizes.win + 1,
    `${label} overflows horizontally: doc=${sizes.doc} body=${sizes.body} window=${sizes.win}`,
  );
}

async function buildPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle("UI Fixture PDF");
  doc.setAuthor("Browser test");
  for (let i = 1; i <= 3; i += 1) {
    const p = doc.addPage([420, 595]);
    p.drawText(`Browser fixture page ${i}`, { x: 40, y: 520, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return Buffer.from(await doc.save());
}

function buildWav(seconds = 1, rate = 8000) {
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 3000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("shell boots with navigation, toolbar and every screen reachable", async () => {
  await heading("Bring anything home.");
  await waitForEngine();

  const sidebar = page.locator("aside.sidebar");
  for (const label of ["Home", "Downloads", "Study", "Tools", "App", "Settings", "About"]) {
    await assert.doesNotReject(
      sidebar.getByRole("button", { name: label, exact: true }).waitFor({ timeout: 5000 }),
      `sidebar is missing ${label}`,
    );
  }

  await page.getByRole("button", { name: "Search OmniGet" }).waitFor();
  await page.getByRole("button", { name: "New download" }).waitFor();

  await sidebar.getByRole("button", { name: "Downloads", exact: true }).click();
  await heading("Downloads");
  assert.equal(await page.evaluate(() => location.hash), "#/downloads");

  await sidebar.getByRole("button", { name: "Study", exact: true }).click();
  await heading("Study");

  await sidebar.getByRole("button", { name: "Tools", exact: true }).click();
  await heading("Tools");
  assert.ok((await page.locator(".tool-card").count()) > 20, "tool grid should list the catalog");

  await sidebar.getByRole("button", { name: "App", exact: true }).click();
  await heading("Media");

  await page.locator("header.toolbar").getByRole("tab", { name: "History" }).click();
  await heading("History");

  await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await heading("Settings");

  await sidebar.getByRole("button", { name: "About", exact: true }).click();
  await heading("A calm, local home", "h1.about-title");

  await go("/");
  await heading("Bring anything home.");
  await assertNoHorizontalOverflow("Home");
});

test("invalid links surface the real error and a real download completes in the UI", async () => {
  await go("/");
  await heading("Bring anything home.");
  const input = page.locator("[data-url-input]");

  await input.fill("ftp://example.com/file.bin");
  await page.getByRole("button", { name: "Inspect link" }).click();
  const alert = page.getByRole("alert");
  await alert.waitFor();
  assert.match(await alert.innerText(), /Only http and https links can be downloaded/i);

  await input.fill(`${fixture.base}/file.bin`);
  await input.press("Enter");
  await page.getByRole("button", { name: "Download", exact: true }).waitFor({ timeout: 15_000 });
  assert.match(await page.locator(".probe-card").innerText(), /Direct file/);
  await page.getByRole("button", { name: "Download", exact: true }).click();

  await page.getByText("Added “fixture file” to the download queue.").waitFor({ timeout: 10_000 });

  await page.locator("header.toolbar").getByRole("tab", { name: "Downloads" }).click();
  await heading("Downloads");
  const row = page.locator(".dl-row").filter({ hasText: "fixture file" }).first();
  await row.waitFor({ timeout: 15_000 });
  await row.getByText("Completed", { exact: true }).waitFor({ timeout: 25_000 });
  assert.match(await row.innerText(), /524 KB|512 KB|524,288|512\.0 KB/);
  await assertNoHorizontalOverflow("Downloads");
});

test("social video probe shows quality choices and stays responsive", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await go("/");
  await heading("Bring anything home.");

  const probePayload = {
    url: "https://www.youtube.com/watch?v=fixture",
    finalUrl: "https://www.youtube.com/watch?v=fixture",
    source: { id: "youtube", label: "YouTube", host: "www.youtube.com" },
    kind: "video",
    mime: "video/mp4",
    engine: "yt-dlp",
    supported: true,
    reason: null,
    title: "A deliberately long fixture title that has to wrap on a narrow phone screen without pushing the page sideways",
    filename: "fixture.mp4",
    sizeBytes: 96_000_000,
    rangeSupported: true,
    durationSeconds: 65,
    thumbnail: null,
    isLive: false,
    author: "Fixture channel",
    description: "Extracted with yt-dlp and merged with ffmpeg.",
    qualities: [
      { id: "h1080", label: "1080p · mp4", height: 1080, selector: "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]", formatId: "bv*[height<=1080]+ba", filesize: 96_000_000, mode: "merge" },
      { id: "h720", label: "720p · mp4", height: 720, selector: "bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]", formatId: "bv*[height<=720]+ba", filesize: 42_000_000, mode: "merge" },
      { id: "h360", label: "360p · mp4", height: 360, selector: "fixture-360", formatId: "fixture-360", filesize: 12_000_000, mode: "muxed" },
    ],
  };

  let resolvePosted;
  const postedPromise = new Promise((resolve) => (resolvePosted = resolve));
  let posted = null;

  await page.route("**/api/probe", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(probePayload),
    }),
  );
  await page.route("**/api/downloads", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posted = route.request().postDataJSON();
    resolvePosted();
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "dl_fixture_social",
        url: probePayload.url,
        source: "youtube",
        sourceLabel: "YouTube",
        kind: "video",
        title: probePayload.title,
        filename: "fixture.mp4",
        filePath: "/tmp/fixture.mp4",
        mime: "video/mp4",
        sizeBytes: 0,
        downloadedBytes: 0,
        status: "queued",
        quality: "360p",
        thumbnail: null,
        durationSeconds: 65,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    });
  });

  try {
    const input = page.locator("[data-url-input]");
    await input.fill("https://www.youtube.com/watch?v=fixture");
    await input.press("Enter");
    await page.locator(".probe-card").waitFor({ timeout: 10_000 });
    const card = await page.locator(".probe-card").innerText();
    assert.match(card, /YouTube/);
    assert.match(card, /1080p/);
    assert.match(card, /Fixture channel/);
    assert.equal(await page.locator(".quality-field select option").count(), 3);
    await assertNoHorizontalOverflow("Home social probe mobile");

    await page.locator(".quality-field select").selectOption("h360");
    await page.getByRole("button", { name: "Add to queue" }).click();
    await postedPromise;
    assert.equal(posted.height, 360);
    assert.equal(posted.formatId, "fixture-360");
    assert.equal(posted.selector, "fixture-360");
  } finally {
    await page.unroute("**/api/probe");
    await page.unroute("**/api/downloads");
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});

test("command palette finds tools and Base64 output is real", async () => {
  await go("/");
  await heading("Bring anything home.");
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Search and jump" });
  await dialog.waitFor();
  const search = dialog.getByRole("textbox", { name: "Search" });
  await search.fill("base64");
  const result = dialog.locator(".palette-row").filter({ hasText: "Base64 encode / decode" }).first();
  await result.waitFor();
  await result.click();

  await page.locator("h1", { hasText: "Base64 encode / decode" }).first().waitFor();
  assert.equal(await page.evaluate(() => location.hash), "#/tools/base64");

  await page.getByLabel("Text input (if no file)").fill("hello ui");
  await page.getByRole("button", { name: "Run tool" }).click();
  await page.locator(".result-pre").filter({ hasText: "aGVsbG8gdWk=" }).waitFor({ timeout: 15_000 });
  await page.locator(".output-row").first().waitFor();
  const href = await page.locator(".output-row a").first().getAttribute("href");
  assert.match(href, /^\/api\/outputs\/job_/);
  const res = await api(app.base, href, { raw: true });
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(res.data).toString(), "aGVsbG8gdWk=");

  await page.getByRole("button", { name: "Run tool" }).click();
  await page.locator(".result-pre").filter({ hasText: "aGVsbG8gdWk=" }).waitFor();
  await assertNoHorizontalOverflow("Tool detail");
});

test("settings preview immediately, persist after reload and reset cleanly", async () => {
  await go("/settings");
  await heading("Settings");

  await page.locator(".segmented button", { hasText: "Dark" }).click();
  await page.getByRole("button", { name: "Green" }).click();
  await page.locator(".segmented button", { hasText: "Compact" }).click();

  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.accent), "green");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.density), "compact");

  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Settings saved.").waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await heading("Settings");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.accent), "green");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.density), "compact");

  await page.locator(".settings-tab").filter({ hasText: "Data" }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("dialog", { name: "Reset all settings?" }).waitFor();
  await page.getByRole("button", { name: "Reset settings" }).click();
  await page.getByText("Settings restored to their defaults.").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.accent), "orange");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.density), "comfortable");
});

test("study library opens a real PDF and notes can be edited and deleted", async () => {
  const pdf = await buildPdf();
  const imported = await api(app.base, "/api/books/import", {
    method: "POST",
    body: multipart({}, [{ field: "file", name: "ui-fixture.pdf", type: "application/pdf", data: pdf }]),
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const book = imported.data.books[0];

  const note = await api(app.base, "/api/notes", {
    method: "POST",
    body: { targetType: "book", targetId: book.id, page: 2, body: "Seeded note for the browser test" },
  });
  assert.equal(note.status, 201);

  await go("/study");
  await heading("Study");
  const goal = page.locator(".goal-card");
  await goal.waitFor();
  const goalText = await goal.innerText();
  assert.match(goalText, /Daily goal/i);
  assert.match(goalText, /\/ 30 min/);
  const card = page.locator(".book-card").filter({ hasText: "UI Fixture PDF" }).first();
  await card.waitFor({ timeout: 15_000 });
  await card.getByRole("button", { name: "Open UI Fixture PDF" }).click();

  await page.locator(".reader-title").filter({ hasText: "UI Fixture PDF" }).waitFor({ timeout: 15_000 });
  const canvas = page.locator(".pdf-stage canvas").first();
  await canvas.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector(".pdf-stage canvas");
    return el && el.dataset.rendered === "true" && el.width > 100 && el.height > 100;
  });
  assert.match(await page.locator(".reader-sub").innerText(), /PDF/i);

  await go("/study/notes");
  await heading("Notes");
  const noteCard = page.locator(".note-card").filter({ hasText: "Seeded note for the browser test" }).first();
  await noteCard.waitFor();
  assert.match(await noteCard.innerText(), /UI Fixture PDF/);
  assert.match(await noteCard.innerText(), /Page 2/);

  await noteCard.getByRole("button", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit note" });
  await editDialog.waitFor();
  const textarea = editDialog.getByRole("textbox", { name: "Note text" });
  await textarea.fill("Edited from the browser test");
  await editDialog.getByRole("button", { name: "Save note" }).click();
  await page.getByText("Note updated.").waitFor();
  await page.locator(".note-card").filter({ hasText: "Edited from the browser test" }).waitFor();

  await page.getByRole("button", { name: "Delete note" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete this note?" });
  await deleteDialog.waitFor();
  await deleteDialog.getByRole("button", { name: "Delete note" }).click();
  await page.getByText("Note deleted.").waitFor();
  await page.getByText("No notes yet").waitFor();
});

test("media library opens the custom player and loads real audio metadata", async () => {
  const wav = buildWav(2);
  const imported = await api(app.base, "/api/media/import", {
    method: "POST",
    body: multipart({}, [{ field: "file", name: "ui-tone.wav", type: "audio/wav", data: wav }]),
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const media = imported.data.media[0];

  await go("/media");
  await heading("Media");
  const card = page.locator(".media-card").filter({ hasText: "ui-tone" }).first();
  await card.waitFor({ timeout: 15_000 });
  await card.getByRole("button", { name: "Play ui-tone" }).click();

  await page.locator(".player-title").filter({ hasText: "ui-tone" }).waitFor({ timeout: 15_000 });
  await page.locator("audio").waitFor({ state: "attached" });
  await page.waitForFunction(() => {
    const el = document.querySelector("audio");
    return el && Number.isFinite(el.duration) && el.duration > 1;
  }, null, { timeout: 10_000 });
  const duration = await page.evaluate(() => document.querySelector("audio").duration);
  assert.ok(duration >= 1.9 && duration <= 2.2, `expected a two-second track, got ${duration}`);

  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await page.waitForFunction(() => {
    const el = document.querySelector("audio");
    return el && !el.paused;
  }, null, { timeout: 10_000 });
  await page.getByTitle("Play / pause (Space)").click();
  await page.waitForFunction(() => document.querySelector("audio")?.paused === true);

  await page.getByRole("button", { name: /^Notes/ }).first().click();
  await page.getByLabel("New timestamped note").fill("Playback observation");
  await page.getByRole("button", { name: /^Save at/ }).click();
  await page.getByText("Playback observation").waitFor({ timeout: 10_000 });
});

test("mobile layout uses the drawer and never scrolls sideways", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await go("/settings");
  await heading("Settings");
  await assertNoHorizontalOverflow("Settings mobile");

  const menu = page.getByRole("button", { name: "Open navigation" });
  await menu.waitFor();
  await assert.equal(await menu.isVisible(), true);
  await menu.click();
  const sidebar = page.locator("aside.sidebar");
  await sidebar.waitFor();
  assert.ok(await sidebar.evaluate((el) => el.classList.contains("mobile-open")));
  await sidebar.getByRole("button", { name: "Tools", exact: true }).click();
  await heading("Tools");
  await assertNoHorizontalOverflow("Tools mobile");

  const mobileNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await mobileNav.waitFor();
  await assert.equal(await mobileNav.isVisible(), true);
  await mobileNav.getByRole("button", { name: "Study" }).click();
  await heading("Study");
  await assertNoHorizontalOverflow("Study mobile");

  await go("/");
  await heading("Bring anything home.");
  await assertNoHorizontalOverflow("Home mobile");
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("about page documents the build and no browser errors were logged", async () => {
  await go("/about");
  await heading("A calm, local home", "h1.about-title");
  const body = await page.locator("body").innerText();
  assert.match(body, /GPL-3\.0/);
  assert.match(body, /Known limitations/i);
  assert.match(body, /OpenSelena/);
  await assertNoHorizontalOverflow("About");

  assert.deepEqual(pageErrors, [], "uncaught page errors: " + pageErrors.join("\n"));
  const meaningfulConsoleErrors = consoleErrors.filter(
    (text) => !/favicon|net::ERR_ABORTED|Failed to load resource/i.test(text),
  );
  assert.deepEqual(meaningfulConsoleErrors, [], "console errors: " + meaningfulConsoleErrors.join("\n"));
  assert.deepEqual(serverErrors, [], "server errors: " + serverErrors.join("\n"));
});
