<script>
  import Icon from "../components/Icon.svelte";
  import DownloadRow from "../components/DownloadRow.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Modal from "../components/Modal.svelte";
  import { app, refreshDownloads, reportError, toast, upsertDownload } from "../lib/state.svelte.js";
  import { downloadApi } from "../lib/api.js";
  import { formatBytes, formatDate, formatDuration, formatSpeed, statusLabel } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let tab = $state("all");
  let query = $state("");
  let sort = $state("recent");
  let loading = $state(true);
  let busy = $state({});
  let logTarget = $state(null);
  let logs = $state([]);
  let logsLoading = $state(false);
  let removeTarget = $state(null);
  let deleteFile = $state(false);
  let removing = $state(false);
  let detail = $state(null);

  const tabs = $derived([
    { id: "all", label: "All", count: app.counts.all || 0 },
    { id: "active", label: "Active", count: app.counts.active || 0 },
    { id: "completed", label: "Completed", count: app.counts.completed || 0 },
    { id: "failed", label: "Failed", count: (app.counts.failed || 0) + (app.counts.canceled || 0) },
  ]);

  $effect(() => {
    loading = true;
    refreshDownloads()
      .catch((err) => reportError(err, "Could not load downloads"))
      .finally(() => {
        loading = false;
      });
  });

  const filtered = $derived.by(() => {
    let list = [...app.downloads];
    if (tab === "active") list = list.filter((d) => ["queued", "downloading", "probing", "paused"].includes(d.status));
    else if (tab === "completed") list = list.filter((d) => d.status === "completed");
    else if (tab === "failed") list = list.filter((d) => ["failed", "canceled"].includes(d.status));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (d) =>
          (d.title || "").toLowerCase().includes(q) ||
          (d.filename || "").toLowerCase().includes(q) ||
          d.url.toLowerCase().includes(q) ||
          (d.sourceLabel || "").toLowerCase().includes(q),
      );
    }
    if (sort === "size") list.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
    else if (sort === "name") list.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    else if (sort === "oldest") list.sort((a, b) => a.createdAt - b.createdAt);
    else list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  });

  const activeList = $derived(app.downloads.filter((d) => ["queued", "downloading"].includes(d.status)));
  const pausedList = $derived(app.downloads.filter((d) => d.status === "paused"));

  async function withBusy(id, name, fn) {
    busy = { ...busy, [id]: name };
    try {
      await fn();
    } catch (err) {
      reportError(err, `Could not ${name} the download`);
    } finally {
      const next = { ...busy };
      delete next[id];
      busy = next;
    }
  }

  function action(name, download) {
    withBusy(download.id, name, async () => {
      const call = { pause: downloadApi.pause, resume: downloadApi.resume, cancel: downloadApi.cancel, retry: downloadApi.retry }[name];
      if (!call) return;
      const updated = await call(download.id);
      upsertDownload(updated);
      await refreshDownloads();
    });
  }

  async function openLogs(download) {
    logTarget = download;
    logs = [];
    logsLoading = true;
    try {
      const res = await downloadApi.logs(download.id);
      logs = res.logs;
    } catch (err) {
      reportError(err, "Could not load the download log");
    } finally {
      logsLoading = false;
    }
  }

  async function openDetail(download) {
    detail = { ...download, loadingInfo: true };
    try {
      const info = await downloadApi.detail(download.id);
      detail = { ...info, loadingInfo: false };
    } catch (err) {
      detail = { ...download, loadingInfo: false, fileExists: false };
      reportError(err, "Could not read file details");
    }
  }

  function requestRemove(download) {
    removeTarget = download;
    deleteFile = download.status === "completed";
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    removing = true;
    try {
      await downloadApi.remove(removeTarget.id, deleteFile);
      removeTarget = null;
      await refreshDownloads();
      toast("success", deleteFile ? "Download and file removed." : "Download removed from the queue.");
    } catch (err) {
      reportError(err, "Could not remove the download");
    } finally {
      removing = false;
    }
  }

  async function reveal(download) {
    try {
      const res = await downloadApi.reveal(download.id);
      if (!res.opened) toast("warning", `No file manager available. Path: ${res.path}`);
    } catch (err) {
      reportError(err, "Could not open the file location");
    }
  }

  function openFile(download) {
    if (download.kind === "video" || download.kind === "audio" || download.kind === "hls") {
      const media = app.media.find((m) => m.downloadId === download.id);
      navigate(media ? `/media/${media.id}` : "/media");
      return;
    }
    if (download.kind === "pdf" || download.kind === "ebook") {
      const book = app.books.find((b) => b.metadata?.downloadId === download.id);
      navigate(book ? `/study/${book.id}` : "/study");
      return;
    }
    window.open(`/api/downloads/${download.id}/file`, "_blank", "noopener");
  }

  async function pauseAll() {
    for (const d of activeList) {
      try {
        await downloadApi.pause(d.id);
      } catch {
        /* reported by list refresh */
      }
    }
    await refreshDownloads();
    toast("info", "Paused all active downloads.");
  }

  async function resumeAll() {
    for (const d of pausedList) {
      try {
        await downloadApi.resume(d.id);
      } catch {
        /* ignore */
      }
    }
    await refreshDownloads();
    toast("info", "Resumed paused downloads.");
  }
</script>

<div class="content-inner stack stack-5">
  <header class="row row-between wrap" style="gap: 12px; padding-top: 4px">
    <div class="stack stack-1">
      <h1 class="page-title">Downloads</h1>
      <p class="muted" style="font-size: 12px">
        Real progress from the local engine — pause, resume, retry and inspect every request.
      </p>
    </div>
    <div class="row row-2">
      {#if activeList.length}
        <button class="btn btn-secondary btn-sm" onclick={pauseAll}>
          <Icon name="pause" size={12} /> Pause all
        </button>
      {/if}
      {#if pausedList.length}
        <button class="btn btn-secondary btn-sm" onclick={resumeAll}>
          <Icon name="play" size={11} /> Resume all
        </button>
      {/if}
      <button class="btn btn-primary btn-sm" onclick={() => navigate("/")}>
        <Icon name="plus" size={12} /> New download
      </button>
    </div>
  </header>

  <div class="toolbar-row">
    <div class="tabs" role="tablist" aria-label="Filter downloads">
      {#each tabs as t}
        <button class="tab" role="tab" aria-selected={tab === t.id} onclick={() => (tab = t.id)}>
          {t.label}
          <span class="tab-count">{t.count}</span>
        </button>
      {/each}
    </div>
    <div class="row row-2 filter-row">
      <div class="search-box">
        <Icon name="search" size={13} />
        <input bind:value={query} placeholder="Filter downloads…" aria-label="Filter downloads" />
        {#if query}
          <button class="clear-btn" onclick={() => (query = "")} aria-label="Clear filter">
            <Icon name="x" size={11} />
          </button>
        {/if}
      </div>
      <select class="select sort-select" bind:value={sort} aria-label="Sort downloads">
        <option value="recent">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="size">Largest first</option>
        <option value="name">Name A–Z</option>
      </select>
    </div>
  </div>

  {#if loading && !app.downloads.length}
    <div class="pane">
      {#each [1, 2, 3] as row}
        <div class="loading-row">
          <div class="skeleton" style="width: 34px; height: 34px; border-radius: 9px"></div>
          <div class="stack stack-2" style="flex: 1">
            <div class="skeleton" style="height: 10px; width: 38%"></div>
            <div class="skeleton" style="height: 8px; width: 22%"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if !filtered.length}
    <div class="pane">
      {#if query}
        <EmptyState
          icon="search"
          title="No downloads match “{query}”"
          message="Try a different title, source or file name."
          actionLabel="Clear filter"
          onAction={() => (query = "")}
        />
      {:else if tab === "active"}
        <EmptyState
          icon="download"
          title="Nothing in the queue"
          message="Active downloads appear here while they transfer. Add a link to get started."
          actionLabel="Add a download"
          onAction={() => navigate("/")}
        />
      {:else if tab === "failed"}
        <EmptyState
          icon="alert-circle"
          title="No failures"
          message="Failed and canceled transfers will be listed here so you can retry them."
          actionLabel="Back to all"
          onAction={() => (tab = "all")}
        />
      {:else if tab === "completed"}
        <EmptyState
          icon="check-circle"
          title="No completed downloads yet"
          message="When a transfer finishes, the file stays on this device and appears here."
          actionLabel="Add a download"
          onAction={() => navigate("/")}
        />
      {:else}
        <EmptyState
          title="Your queue is empty"
          message="Paste a direct file, PDF, EPUB or HLS playlist link on Home. Books and media are added to your library automatically."
          actionLabel="Open Home"
          onAction={() => navigate("/")}
        />
      {/if}
    </div>
  {:else}
    <div class="pane list-pane">
      {#each filtered as download (download.id)}
        <div class="row-wrap" class:is-busy={!!busy[download.id]}>
          <DownloadRow
            {download}
            onAction={action}
            onLogs={(d) => (detail = { ...d })}
            onReveal={reveal}
            onRemove={requestRemove}
            onOpen={openFile}
          />
          {#if busy[download.id]}
            <span class="busy-overlay"><Icon name="loader" size={12} class="spin" /> {busy[download.id]}…</span>
          {/if}
        </div>
      {/each}
    </div>
    <p class="list-foot">
      {filtered.length} item{filtered.length === 1 ? "" : "s"} · {formatBytes(filtered.reduce((sum, d) => sum + (d.downloadedBytes || 0), 0))} transferred
    </p>
  {/if}
</div>

<!-- Detail / logs modal -->
<Modal
  open={!!detail}
  title={detail?.title || "Download"}
  subtitle="{detail?.sourceLabel || 'Web'} · {detail?.engine || 'http'}"
  size="lg"
  onClose={() => (detail = null)}
>
  {#if detail}
    <div class="stack stack-4">
      <div class="row row-2 wrap" style="gap: 6px">
        <span class="badge badge-{detail.status === 'completed' ? 'success' : detail.status === 'failed' ? 'error' : 'accent'}">
          {statusLabel(detail.status)}
        </span>
        {#if detail.quality}<span class="badge badge-outline">{detail.quality}</span>{/if}
        {#if detail.rangeSupported}<span class="badge badge-outline">Range supported</span>{/if}
        {#if detail.segmentsTotal}<span class="badge badge-outline">{detail.segmentsDone}/{detail.segmentsTotal} segments</span>{/if}
      </div>

      <div class="detail-grid">
        <div><span class="detail-key">Size</span><span class="detail-val mono">{formatBytes(detail.sizeBytes)}</span></div>
        <div><span class="detail-key">Downloaded</span><span class="detail-val mono">{formatBytes(detail.downloadedBytes)}</span></div>
        <div><span class="detail-key">Speed</span><span class="detail-val mono">{formatSpeed(detail.speedBps)}</span></div>
        <div><span class="detail-key">Created</span><span class="detail-val">{formatDate(detail.createdAt, { withTime: true })}</span></div>
        <div><span class="detail-key">Completed</span><span class="detail-val">{detail.completedAt ? formatDate(detail.completedAt, { withTime: true }) : "—"}</span></div>
        <div><span class="detail-key">Duration</span><span class="detail-val">{detail.durationSeconds ? formatDuration(detail.durationSeconds) : "—"}</span></div>
      </div>

      {#if detail.error}
        <div class="probe-error">
          <Icon name="alert-circle" size={14} />
          <span>{detail.error}</span>
        </div>
      {/if}

      <div class="stack stack-2">
        <p class="field-label">Source link</p>
        <div class="url-box mono">{detail.url}</div>
      </div>

      {#if detail.filePath}
        <div class="stack stack-2">
          <p class="field-label">Saved file</p>
          <div class="url-box mono">
            {detail.filePath}
            {#if detail.fileExists === false}<span class="badge badge-error">missing</span>{/if}
          </div>
        </div>
      {/if}

      <div class="stack stack-2">
        <div class="row row-between">
          <p class="field-label">Request log</p>
          <button class="btn btn-ghost btn-sm" onclick={() => openLogs(detail)}>
            <Icon name="refresh" size={11} /> Reload
          </button>
        </div>
        {#if logsLoading}
          <div class="stack stack-2">
            <div class="skeleton" style="height: 10px; width: 70%"></div>
            <div class="skeleton" style="height: 10px; width: 52%"></div>
          </div>
        {:else if !logs.length}
          <p class="muted" style="font-size: 11px">No log entries yet for this download.</p>
        {:else}
          <pre class="code log-pre">{#each logs as line}<span class="log-line level-{line.level}">{new Date(line.ts).toLocaleTimeString()} <span class="log-level">{line.level}</span> {line.message}
</span>{/each}</pre>
        {/if}
      </div>

      <div class="row row-2 wrap">
        {#if detail.status === "completed"}
          <a class="btn btn-secondary btn-sm" href={`/api/downloads/${detail.id}/file?download=1`} download>
            <Icon name="download" size={12} /> Save a copy
          </a>
          <button class="btn btn-secondary btn-sm" onclick={() => reveal(detail)}>
            <Icon name="folder-open" size={12} /> Show in folder
          </button>
        {:else if detail.status === "downloading"}
          <button class="btn btn-secondary btn-sm" onclick={() => action("pause", detail)}>
            <Icon name="pause" size={12} /> Pause
          </button>
        {:else if ["paused", "failed", "canceled"].includes(detail.status)}
          <button class="btn btn-primary btn-sm" onclick={() => action(detail.status === "paused" ? "resume" : "retry", detail)}>
            <Icon name="play" size={11} /> {detail.status === "paused" ? "Resume" : "Retry"}
          </button>
        {/if}
        <button class="btn btn-danger btn-sm" onclick={() => { const d = detail; detail = null; requestRemove(d); }}>
          <Icon name="trash" size={12} /> Remove…
        </button>
      </div>
    </div>
  {/if}
</Modal>

<!-- Remove confirmation -->
<Modal
  open={!!removeTarget}
  title="Remove download?"
  subtitle={removeTarget?.title || ""}
  onClose={() => (removeTarget = null)}
>
  <div class="stack stack-4">
    <p style="font-size: 12px; line-height: 1.6; color: var(--tertiary)">
      The queue entry will be deleted. {deleteFile ? "The file will also be deleted from disk." : "The downloaded file (if any) will be kept."}
    </p>
    {#if removeTarget?.status === "completed"}
      <label class="checkbox">
        <input type="checkbox" bind:checked={deleteFile} />
        Also delete the file from disk
      </label>
    {/if}
    <div class="row row-end row-2">
      <button class="btn btn-secondary btn-sm" onclick={() => (removeTarget = null)}>Cancel</button>
      <button class="btn btn-danger btn-sm" onclick={confirmRemove} disabled={removing}>
        {#if removing}<Icon name="loader" size={12} class="spin" />{:else}<Icon name="trash" size={12} />{/if}
        Remove
      </button>
    </div>
  </div>
</Modal>

<style>
  .toolbar-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .filter-row {
    flex-wrap: wrap;
  }
  .search-box {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    width: 210px;
    padding: 0 8px;
    background: var(--surface);
    border: 1px solid var(--input-border);
    border-radius: 7px;
    color: var(--quaternary);
    font-size: 11.5px;
  }
  .search-box:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .search-box input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: 11.5px;
    color: var(--secondary);
  }
  .clear-btn {
    color: var(--quaternary);
    display: grid;
    place-content: center;
  }
  .sort-select {
    width: 132px;
    height: 28px;
    font-size: 11px;
  }

  .list-pane {
    overflow: hidden;
  }
  .row-wrap {
    position: relative;
  }
  .row-wrap.is-busy {
    opacity: 0.7;
  }
  .busy-overlay {
    position: absolute;
    right: 14px;
    top: 8px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--tertiary);
    background: var(--pane);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .list-foot {
    font-size: 10.5px;
    color: var(--quaternary);
    text-align: center;
    padding-top: 2px;
  }

  .loading-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px;
    border-bottom: 1px solid var(--content-border);
  }
  .loading-row:last-child {
    border-bottom: 0;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--pane-alt);
    border-radius: 9px;
    border: 1px solid var(--content-border);
  }
  .detail-grid > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .detail-key {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--quaternary);
    font-weight: 600;
  }
  .detail-val {
    font-size: 11.5px;
    color: var(--secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .url-box {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 9px;
    background: var(--surface-sunken);
    border-radius: 6px;
    font-size: 10.5px;
    color: var(--tertiary);
    word-break: break-all;
    line-height: 1.5;
  }

  .log-pre {
    max-height: 220px;
    white-space: pre-wrap;
    font-size: 10px;
    line-height: 1.7;
  }
  .log-line {
    display: block;
    color: var(--tertiary);
  }
  .log-level {
    text-transform: uppercase;
    font-size: 8.5px;
    letter-spacing: 0.03em;
    color: var(--quaternary);
  }
  .log-line.level-error { color: var(--error); }
  .log-line.level-warn { color: var(--warning); }
  .log-line.level-info { color: var(--tertiary); }

  .probe-error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 9px 11px;
    border-radius: 8px;
    background: var(--error-soft);
    color: var(--error);
    font-size: 11px;
    line-height: 1.5;
  }

  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 640px) {
    .search-box { width: 100%; }
    .filter-row { width: 100%; }
    .detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
