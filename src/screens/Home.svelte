<script>
  import Icon from "../components/Icon.svelte";
  import Mascot from "../components/Mascot.svelte";
  import DownloadRow from "../components/DownloadRow.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { app, refreshMedia, refreshBooks, refreshDownloads, reportError, toast, upsertDownload } from "../lib/state.svelte.js";
  import { bookApi, downloadApi, mediaApi, systemApi } from "../lib/api.js";
  import { formatBytes, formatDuration, formatRelative, formatSpeed, pluralize } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let url = $state("");
  let probing = $state(false);
  let probe = $state(null);
  let probeError = $state(null);
  let selectedQuality = $state("");
  let starting = $state(false);
  let dragging = $state(false);
  let inputEl = $state(null);
  let importing = $state(false);

  const sources = $state({ list: [], extractor: null });

  $effect(() => {
    systemApi
      .sources()
      .then((res) => {
        sources.list = res.sources || [];
        sources.extractor = res.extractor;
      })
      .catch(() => {});
  });

  const greeting = $derived.by(() => {
    const hour = new Date().getHours();
    if (hour < 5) return "Working late";
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  });

  const activeDownloads = $derived(
    app.downloads.filter((d) => ["downloading", "queued", "paused"].includes(d.status)).slice(0, 3),
  );
  const recent = $derived(
    app.downloads.filter((d) => d.status === "completed").slice(0, 3),
  );
  const continueReading = $derived(
    app.books.filter((b) => b.status === "reading").slice(0, 3),
  );
  const continueWatching = $derived(
    app.media.filter((m) => m.position > 5).slice(0, 3),
  );
  const stats = $derived([
    {
      label: "Downloads",
      value: String(app.counts.completed || 0),
      detail: app.counts.active ? `${app.counts.active} in queue` : "All clear",
      icon: "download",
      tone: "accent",
    },
    {
      label: "Saved locally",
      value: formatBytes(app.stats?.bytesSaved || app.counts.bytesSaved || 0),
      detail: "on this device",
      icon: "hard-drive",
      tone: "blue",
    },
    {
      label: "Study library",
      value: String(app.books.length),
      detail: `${app.stats?.reading || 0} in progress`,
      icon: "book",
      tone: "purple",
    },
    {
      label: "Notes",
      value: String(app.notes.length),
      detail: "across books & media",
      icon: "note",
      tone: "teal",
    },
  ]);

  const qualityOptions = $derived(probe?.qualities || []);

  async function inspect() {
    const value = url.trim();
    if (!value) {
      probeError = "Paste a link first — for example a direct MP4, PDF or HLS playlist.";
      inputEl?.focus();
      return;
    }
    probing = true;
    probeError = null;
    probe = null;
    try {
      const result = await downloadApi.probe(value);
      probe = result;
      selectedQuality = result.qualities?.[0]?.id || "source";
      if (!result.supported) {
        probeError = result.reason || "This link cannot be downloaded by the current build.";
      }
    } catch (err) {
      probeError = err?.message || "Could not inspect that link.";
    } finally {
      probing = false;
    }
  }

  async function startDownload() {
    if (!probe?.supported) return;
    starting = true;
    try {
      const quality = qualityOptions.find((q) => String(q.id) === String(selectedQuality));
      const created = await downloadApi.create({
        url: probe.url,
        quality: selectedQuality,
        height: quality?.height || 0,
        formatId: quality?.formatId || selectedQuality,
        selector: quality?.selector || quality?.formatId || selectedQuality,
      });
      upsertDownload(created);
      toast("success", `Added “${created.title}” to the download queue.`);
      reset();
      await refreshDownloads();
    } catch (err) {
      reportError(err, "The download could not be started");
    } finally {
      starting = false;
    }
  }

  function reset() {
    url = "";
    probe = null;
    probeError = null;
    selectedQuality = "";
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        url = text.trim();
        await inspect();
      } else {
        probeError = "Your clipboard is empty.";
      }
    } catch {
      probeError = "Clipboard access was blocked. Paste the link with Ctrl+V instead.";
      inputEl?.focus();
    }
  }

  async function importFiles(files) {
    const list = [...files];
    if (!list.length) return;
    importing = true;
    const books = [];
    const media = [];
    const rejected = [];
    for (const file of list) {
      const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
      if ([".pdf", ".epub"].includes(ext)) books.push(file);
      else if ([".mp4", ".mkv", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus"].includes(ext)) {
        media.push(file);
      } else rejected.push(file.name);
    }
    try {
      if (books.length) {
        const res = await bookApi.import(books);
        toast("success", `Added ${pluralize(res.books.length, "book")} to your study library.`);
        await refreshBooks();
      }
      if (media.length) {
        const res = await mediaApi.import(media);
        toast("success", `Added ${pluralize(res.media.length, "media file")} to the player.`);
        await refreshMedia();
      }
      if (rejected.length) {
        toast("warning", `Skipped unsupported file${rejected.length === 1 ? "" : "s"}: ${rejected.join(", ")}`);
      }
    } catch (err) {
      reportError(err, "The file could not be imported");
    } finally {
      importing = false;
    }
  }

  function onDrop(event) {
    event.preventDefault();
    dragging = false;
    if (event.dataTransfer?.files?.length) {
      importFiles(event.dataTransfer.files);
      return;
    }
    const text = event.dataTransfer?.getData("text/plain");
    if (text) {
      url = text.trim();
      inspect();
    }
  }

  function onPaste(event) {
    const text = event.clipboardData?.getData("text/plain");
    if (text && !url) {
      setTimeout(() => inspect(), 30);
    }
  }

  function onAction(action, download) {
    const call = downloadApi[action];
    if (!call) return;
    call(download.id)
      .then(() => refreshDownloads())
      .catch((err) => reportError(err, `Could not ${action} the download`));
  }

  function openDownload(download) {
    if (download.kind === "video" || download.kind === "audio" || download.kind === "hls") {
      const media = app.media.find((m) => m.downloadId === download.id);
      if (media) {
        navigate(`/media/${media.id}`);
        return;
      }
      navigate("/media");
      return;
    }
    if (["pdf", "ebook"].includes(download.kind)) {
      const book = app.books.find((b) => b.metadata?.downloadId === download.id);
      if (book) {
        navigate(`/study/${book.id}`);
        return;
      }
      navigate("/study");
      return;
    }
    window.open(`/api/downloads/${download.id}/file`, "_blank");
  }

  async function reveal(download) {
    try {
      const res = await downloadApi.reveal(download.id);
      if (!res.opened) toast("warning", `Could not open a file manager here. File: ${res.path}`);
    } catch (err) {
      reportError(err, "Could not reveal the file");
    }
  }

  const extractorAvailable = $derived(sources.extractor?.available ?? app.system?.tools?.ytdlp?.available ?? false);
</script>

<div class="content-inner stack stack-6">
  <header class="home-head">
    <div class="stack stack-1">
      <p class="eyebrow">{greeting}</p>
      <h1 class="page-title">Bring anything home.</h1>
      <p class="home-sub">
        Paste a direct file or HLS link, or drop a book or video into your local library.
        Everything stays on this device.
      </p>
    </div>
    <div class="engine-chip" class:tone-warn={!extractorAvailable}>
      <span class="dot" class:pulse={app.eventsConnected} style="color: {app.eventsConnected ? 'var(--success)' : 'var(--quaternary)'}"></span>
      <span>{app.eventsConnected ? "Download engine ready" : "Reconnecting to engine…"}</span>
    </div>
  </header>

  <section
    class="hero-card"
    class:dragging
    ondrop={onDrop}
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    aria-label="New download"
  >
    <div class="hero-body">
      <div class="hero-form">
        <div class="url-field" class:invalid={!!probeError && !probe}>
          <Icon name="link" size={17} class="url-icon" />
          <input
            bind:this={inputEl}
            bind:value={url}
            data-url-input
            class="url-input"
            type="url"
            inputmode="url"
            placeholder="https://youtube.com/watch?v=… or a direct file link"
            aria-label="Link to download"
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                inspect();
              }
            }}
            onpaste={onPaste}
            disabled={probing}
          />
          {#if url}
            <button class="url-clear" onclick={reset} aria-label="Clear link">
              <Icon name="x" size={13} />
            </button>
          {/if}
        </div>
        <button class="btn btn-primary btn-lg download-cta" onclick={() => (probe?.supported ? startDownload() : inspect())} disabled={probing || starting}>
          {#if probing}
            <Icon name="loader" size={14} class="spin" />
            Inspecting…
          {:else if probe?.supported}
            <Icon name="download" size={14} />
            Download
          {:else}
            <Icon name="search" size={14} />
            Inspect link
          {/if}
        </button>
      </div>

      {#if !probe && !probeError}
        <div class="hero-hints">
          <button class="hint-chip" onclick={pasteFromClipboard} type="button">
            <Icon name="copy" size={11} /> Paste from clipboard
          </button>
          <span class="hint-chip static">
            <Icon name="upload" size={11} /> Drop PDF, EPUB, MP4 or MP3 to import
          </span>
          <span class="hint-chip static">
            <Icon name="shield" size={11} /> No uploads, no telemetry
          </span>
          {#if extractorAvailable}
            <span class="hint-chip static">
              <Icon name="globe" size={11} /> YouTube · Instagram · X · Reddit
            </span>
          {/if}
        </div>
      {/if}

      {#if probeError}
        <div class="probe-error" role="alert">
          <Icon name="alert-circle" size={15} />
          <div class="stack stack-1">
            <p>{probeError}</p>
            {#if probe?.extractorHint}
              <p class="field-hint">{probe.extractorHint}</p>
            {/if}
          </div>
          {#if probe && !probe.supported}
            <span class="badge badge-error">Not supported</span>
          {/if}
        </div>
      {/if}

      {#if probing}
        <div class="probe-loading">
          <div class="skeleton" style="width: 46px; height: 46px; border-radius: 10px"></div>
          <div class="stack stack-2" style="flex: 1">
            <div class="skeleton" style="height: 11px; width: 45%"></div>
            <div class="skeleton" style="height: 9px; width: 28%"></div>
          </div>
        </div>
      {/if}

      {#if probe?.supported}
        <div class="probe-card">
          {#if probe.thumbnail}
            <img class="probe-thumb" src={probe.thumbnail} alt="" referrerpolicy="no-referrer" />
          {:else}
            <div class="probe-thumb placeholder">
              <Icon
                name={probe.kind === "video" ? "video" : probe.kind === "audio" ? "music" : probe.kind === "pdf" ? "file-pdf" : "file"}
                size={20}
              />
            </div>
          {/if}
          <div class="probe-info">
            <div class="row row-2 wrap" style="gap: 6px">
              <span class="badge badge-accent">{probe.source?.label || "Web"}</span>
              <span class="badge badge-outline">{probe.engine === "hls" ? "HLS" : probe.engine === "yt-dlp" ? "Extractor" : "Direct file"}</span>
              {#if probe.rangeSupported}<span class="badge badge-outline">Resumable</span>{/if}
              {#if probe.isLive}<span class="badge badge-warning">Live</span>{/if}
            </div>
            <p class="probe-title" title={probe.title}>{probe.title || probe.filename}</p>
            <p class="probe-meta">
              {#if probe.sizeBytes}{formatBytes(probe.sizeBytes)}{:else}Size unknown{/if}
              {#if probe.durationSeconds} · {formatDuration(probe.durationSeconds)}{/if}
              {#if probe.segmentCount} · {probe.segmentCount} segments{/if}
              {#if probe.author} · {probe.author}{/if}
            </p>
            {#if probe.description}
              <p class="probe-desc clamp-2">{probe.description}</p>
            {/if}
          </div>
          <div class="probe-controls">
            <label class="field quality-field">
              <span class="field-label">Quality</span>
              <select class="select" bind:value={selectedQuality}>
                {#each qualityOptions as q}
                  <option value={q.id}>{q.label}{q.filesize ? ` · ${formatBytes(q.filesize)}` : ""}</option>
                {/each}
              </select>
            </label>
            <button class="btn btn-primary btn-sm" onclick={startDownload} disabled={starting}>
              {#if starting}
                <Icon name="loader" size={12} class="spin" /> Starting…
              {:else}
                <Icon name="download" size={12} /> Add to queue
              {/if}
            </button>
            <button class="btn btn-ghost btn-sm" onclick={reset}>Dismiss</button>
          </div>
        </div>
      {/if}
    </div>

    {#if dragging}
      <div class="drop-overlay">
        <Icon name="upload" size={22} />
        <span>Drop to import into your library</span>
      </div>
    {/if}
  </section>

  <section class="source-strip" aria-label="Supported sources">
    <div class="row row-between" style="margin-bottom: 9px">
      <p class="eyebrow">What works right now</p>
      {#if !extractorAvailable}
        <button class="extractor-note" onclick={() => navigate("/settings")}>
          <Icon name="info" size={11} /> Page extraction needs yt-dlp
        </button>
      {/if}
    </div>
    <div class="chips">
      {#each sources.list as source}
        <span
          class="source-chip"
          class:is-off={source.kind === "extractor" && !extractorAvailable}
          title={source.detail}
        >
          <Icon
            name={source.id === "direct" ? "file" : source.id === "hls" ? "layers" : "globe"}
            size={11}
          />
          {source.label}
          {#if source.kind === "extractor" && !extractorAvailable}
            <span class="chip-off">off</span>
          {/if}
        </span>
      {/each}
      {#if !sources.list.length}
        <span class="source-chip"><span class="skeleton" style="width: 60px; height: 10px"></span></span>
      {/if}
    </div>
  </section>

  <section class="stats-grid">
    {#each stats as stat}
      <div class="stat-tile">
        <span class="stat-icon tone-{stat.tone}"><Icon name={stat.icon} size={15} /></span>
        <div class="stack stack-1" style="min-width: 0">
          <span class="stat-value">{stat.value}</span>
          <span class="stat-label">{stat.label}</span>
        </div>
        <span class="stat-detail">{stat.detail}</span>
      </div>
    {/each}
  </section>

  {#if activeDownloads.length}
    <section class="stack stack-3">
      <div class="row row-between">
        <h2 class="section-title">In progress</h2>
        <button class="btn btn-ghost btn-sm" onclick={() => navigate("/downloads")}>
          All downloads <Icon name="chevron-right" size={12} />
        </button>
      </div>
      <div class="pane list-pane">
        {#each activeDownloads as download (download.id)}
          <DownloadRow {download} onAction={onAction} onReveal={reveal} onOpen={openDownload} />
        {/each}
      </div>
    </section>
  {:else if recent.length}
    <section class="stack stack-3">
      <div class="row row-between">
        <h2 class="section-title">Recently finished</h2>
        <button class="btn btn-ghost btn-sm" onclick={() => navigate("/history")}>
          History <Icon name="chevron-right" size={12} />
        </button>
      </div>
      <div class="pane list-pane">
        {#each recent as download (download.id)}
          <DownloadRow {download} onAction={onAction} onReveal={reveal} onOpen={openDownload} />
        {/each}
      </div>
    </section>
  {/if}

  {#if continueReading.length || continueWatching.length}
    <div class="continue-grid">
      {#if continueReading.length}
        <section class="stack stack-3">
          <div class="row row-between">
            <h2 class="section-title">Continue reading</h2>
            <button class="btn btn-ghost btn-sm" onclick={() => navigate("/study")}>
              Library <Icon name="chevron-right" size={12} />
            </button>
          </div>
          <div class="pane list-pane">
            {#each continueReading as book (book.id)}
              <button class="continue-row" onclick={() => navigate(`/study/${book.id}`)}>
                <span class="continue-art book-art">
                  {#if book.coverPath}
                    <img src={`/api/books/${book.id}/cover`} alt="" />
                  {:else}
                    <Icon name="book-open" size={16} />
                  {/if}
                </span>
                <span class="continue-text">
                  <span class="continue-title">{book.title}</span>
                  <span class="continue-sub">{book.author || "Unknown author"}</span>
                  <span class="mini-progress"><span style="width: {Math.round((book.progress || 0) * 100)}%"></span></span>
                </span>
                <span class="mono faint" style="font-size: 10px">{Math.round((book.progress || 0) * 100)}%</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if continueWatching.length}
        <section class="stack stack-3">
          <div class="row row-between">
            <h2 class="section-title">Continue watching</h2>
            <button class="btn btn-ghost btn-sm" onclick={() => navigate("/media")}>
              Player <Icon name="chevron-right" size={12} />
            </button>
          </div>
          <div class="pane list-pane">
            {#each continueWatching as item (item.id)}
              <button class="continue-row" onclick={() => navigate(`/media/${item.id}`)}>
                <span class="continue-art media-art">
                  <Icon name={item.kind === "audio" ? "music" : "video"} size={16} />
                </span>
                <span class="continue-text">
                  <span class="continue-title">{item.title}</span>
                  <span class="continue-sub">
                    {formatDuration(item.position)} / {item.duration ? formatDuration(item.duration) : "—"}
                  </span>
                  <span class="mini-progress media">
                    <span style="width: {item.duration ? Math.min(100, (item.position / item.duration) * 100) : 0}%"></span>
                  </span>
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  {/if}

  {#if !app.downloads.length && !app.books.length}
    <section class="pane first-run">
      <Mascot size={92} mood="happy" />
      <div class="stack stack-2" style="max-width: 420px">
        <h2 class="section-title">A clean slate, on purpose</h2>
        <p class="muted" style="font-size: 12px">
          Nothing has been downloaded yet. Start with a direct MP4 or PDF link above,
          or drop a book you already own to begin building your study library.
        </p>
        <div class="row row-2">
          <button class="btn btn-secondary btn-sm" onclick={() => navigate("/tools")}>
            <Icon name="grid" size={12} /> Browse tools
          </button>
          <button class="btn btn-ghost btn-sm" onclick={() => navigate("/about")}>
            What OmniGet can do
          </button>
        </div>
      </div>
    </section>
  {/if}

  {#if importing}
    <div class="import-bar">
      <Icon name="loader" size={14} class="spin" /> Importing files into your library…
    </div>
  {/if}
</div>

<style>
  .home-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding-top: var(--space-2);
  }
  .home-sub {
    font-size: 12.5px;
    color: var(--tertiary);
    max-width: 560px;
    line-height: 1.55;
    margin-top: 3px;
  }
  .engine-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: var(--radius-full);
    background: var(--surface);
    border: 1px solid var(--content-border);
    font-size: 10.5px;
    color: var(--tertiary);
    white-space: nowrap;
  }
  .engine-chip.tone-warn {
    color: var(--warning);
    background: var(--warning-soft);
    border-color: transparent;
  }

  .hero-card {
    position: relative;
    background: var(--pane);
    border: 1px solid var(--content-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--elev-1);
    overflow: hidden;
    transition: border-color var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out);
  }
  .hero-card.dragging {
    border-color: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  .hero-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .hero-form {
    display: flex;
    gap: var(--space-2);
    align-items: stretch;
  }
  .url-field {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 46px;
    padding: 0 var(--space-3);
    background: var(--surface);
    border: 1px solid var(--input-border);
    border-radius: 10px;
    transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
  }
  .url-field:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .url-field.invalid {
    border-color: color-mix(in srgb, var(--error) 55%, var(--input-border));
  }
  .url-icon {
    color: var(--quaternary);
    flex: 0 0 auto;
  }
  .url-input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: var(--text-md);
    letter-spacing: -0.01em;
  }
  .url-input::placeholder {
    color: var(--quaternary);
    font-size: var(--text-base);
  }
  .url-clear {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-content: center;
    color: var(--tertiary);
    background: var(--surface-sunken);
    flex: 0 0 auto;
  }
  .url-clear:hover {
    background: var(--surface-hi);
    color: var(--secondary);
  }
  .download-cta {
    height: 46px;
    padding: 0 var(--space-5);
    border-radius: 10px;
    font-size: 13px;
    min-width: 122px;
  }

  .hero-hints {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .hint-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 23px;
    padding: 0 8px;
    border-radius: 6px;
    font-size: 10.5px;
    color: var(--tertiary);
    background: var(--surface-sunken);
    border: 1px solid transparent;
    transition: all var(--duration-fast) var(--ease-out);
  }
  .hint-chip.static {
    background: transparent;
    border-color: var(--content-border);
  }
  button.hint-chip:hover {
    color: var(--accent-text);
    background: var(--accent-soft);
  }

  .probe-error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 9px;
    background: var(--error-soft);
    color: var(--error);
    font-size: 11.5px;
    line-height: 1.5;
  }
  .probe-error .field-hint {
    color: color-mix(in srgb, var(--error) 70%, var(--tertiary));
  }
  .probe-error :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
  }
  .probe-error > :global(.badge) {
    margin-left: auto;
  }

  .probe-loading {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 3px 0;
  }

  .probe-card {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3);
    border-radius: 10px;
    background: var(--surface);
    border: 1px solid var(--content-border);
    flex-wrap: wrap;
  }
  .probe-thumb {
    width: 62px;
    height: 46px;
    border-radius: 7px;
    object-fit: cover;
    background: var(--surface-sunken);
    flex: 0 0 auto;
  }
  .probe-thumb.placeholder {
    display: grid;
    place-content: center;
    color: var(--quaternary);
  }
  .probe-info {
    flex: 1;
    min-width: 180px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .probe-title {
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: -0.005em;
    line-height: 1.35;
  }
  .probe-meta {
    font-size: 10.5px;
    color: var(--tertiary);
  }
  .probe-desc {
    font-size: 10.5px;
    color: var(--quaternary);
    line-height: 1.45;
  }
  .probe-controls {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    flex: 0 0 auto;
    flex-wrap: wrap;
  }
  .quality-field {
    min-width: 132px;
  }
  .quality-field :global(.select) {
    height: 26px;
    font-size: 11px;
  }

  .drop-overlay {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--pane) 82%, transparent);
    backdrop-filter: blur(2px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--accent-text);
    font-size: 12px;
    font-weight: 600;
    pointer-events: none;
  }

  .source-strip {
    display: flex;
    flex-direction: column;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .source-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 9px;
    border-radius: var(--radius-full);
    background: var(--surface);
    border: 1px solid var(--content-border);
    font-size: 10.5px;
    color: var(--tertiary);
  }
  .source-chip.is-off {
    opacity: 0.62;
    border-style: dashed;
  }
  .chip-off {
    font-size: 8.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--quaternary);
  }
  .extractor-note {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--warning);
  }
  .extractor-note:hover {
    text-decoration: underline;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .stat-tile {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 12px;
    background: var(--pane);
    border: 1px solid var(--content-border);
    border-radius: var(--radius-lg);
    position: relative;
    min-width: 0;
  }
  .stat-icon {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    display: grid;
    place-content: center;
    flex: 0 0 auto;
    background: var(--surface-sunken);
    color: var(--tertiary);
  }
  .stat-icon.tone-accent { background: var(--accent-soft); color: var(--accent-text); }
  .stat-icon.tone-blue { background: var(--blue-soft); color: var(--blue); }
  .stat-icon.tone-purple { background: var(--purple-soft); color: var(--purple); }
  .stat-icon.tone-teal { background: var(--teal-soft); color: var(--teal); }
  .stat-value {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stat-label {
    font-size: 9.5px;
    color: var(--tertiary);
    white-space: nowrap;
  }
  .stat-detail {
    position: absolute;
    right: 10px;
    top: 10px;
    font-size: 8.5px;
    color: var(--quaternary);
    text-align: right;
  }

  .list-pane {
    overflow: hidden;
  }

  .continue-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
  }
  .continue-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--content-border);
    text-align: left;
  }
  .continue-row:last-child {
    border-bottom: 0;
  }
  .continue-row:hover {
    background: var(--surface-hi);
  }
  .continue-art {
    width: 30px;
    height: 38px;
    border-radius: 5px;
    display: grid;
    place-content: center;
    flex: 0 0 auto;
    overflow: hidden;
    background: var(--surface-sunken);
    color: var(--tertiary);
  }
  .continue-art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .book-art { background: var(--blue-soft); color: var(--blue); }
  .media-art { background: var(--purple-soft); color: var(--purple); }
  .continue-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .continue-title {
    font-size: 11.5px;
    font-weight: 550;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .continue-sub {
    font-size: 9.5px;
    color: var(--quaternary);
  }
  .mini-progress {
    height: 3px;
    border-radius: 99px;
    background: var(--surface-sunken);
    overflow: hidden;
    margin-top: 2px;
    width: 100%;
  }
  .mini-progress span {
    display: block;
    height: 100%;
    background: var(--blue);
    border-radius: 99px;
  }
  .mini-progress.media span {
    background: var(--accent);
  }

  .first-run {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    padding: var(--space-5);
    flex-wrap: wrap;
  }

  .import-bar {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: var(--radius-full);
    background: var(--popup-bg);
    box-shadow: var(--elev-2);
    border: 1px solid var(--content-border);
    font-size: 11.5px;
    z-index: 100;
  }

  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 1000px) {
    .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .continue-grid { grid-template-columns: minmax(0, 1fr); }
  }

  @media (max-width: 700px) {
    .hero-form { flex-direction: column; }
    .download-cta { width: 100%; }
    .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat-detail { display: none; }
    .probe-controls { width: 100%; }
    .quality-field { flex: 1; }
  }
</style>
