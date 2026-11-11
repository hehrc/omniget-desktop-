<script>
  import Icon from "../components/Icon.svelte";
  import DownloadRow from "../components/DownloadRow.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Modal from "../components/Modal.svelte";
  import { app, refreshDownloads, reportError, toast } from "../lib/state.svelte.js";
  import { downloadApi } from "../lib/api.js";
  import { formatBytes, formatDate, formatRelative } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let items = $state([]);
  let loading = $state(true);
  let filter = $state("all");
  let query = $state("");
  let clearOpen = $state(false);
  let deleteFiles = $state(false);
  let clearing = $state(false);

  const filters = [
    { id: "all", label: "Everything" },
    { id: "completed", label: "Completed" },
    { id: "failed", label: "Failed" },
    { id: "canceled", label: "Canceled" },
  ];

  async function load() {
    loading = true;
    try {
      const res = await downloadApi.history();
      items = res.downloads;
    } catch (err) {
      reportError(err, "Could not load download history");
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load();
  });

  const filtered = $derived.by(() => {
    let list = items;
    if (filter !== "all") list = list.filter((d) => d.status === filter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (d) =>
          (d.title || "").toLowerCase().includes(q) ||
          (d.filename || "").toLowerCase().includes(q) ||
          d.url.toLowerCase().includes(q),
      );
    }
    return list;
  });

  const grouped = $derived.by(() => {
    const groups = new Map();
    for (const item of filtered) {
      const ts = item.completedAt || item.updatedAt || item.createdAt;
      const date = new Date(ts);
      const key = date.toDateString();
      if (!groups.has(key)) groups.set(key, { label: dayLabel(date), items: [] });
      groups.get(key).items.push(item);
    }
    return [...groups.values()];
  });

  function dayLabel(date) {
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (date.toDateString() === today.toDateString()) return "Today";
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }

  const totals = $derived({
    count: filtered.length,
    bytes: filtered.reduce((sum, d) => sum + (d.sizeBytes || d.downloadedBytes || 0), 0),
  });

  function openFile(download) {
    if (["video", "audio", "hls"].includes(download.kind)) {
      const media = app.media.find((m) => m.downloadId === download.id);
      navigate(media ? `/media/${media.id}` : "/media");
      return;
    }
    if (["pdf", "ebook"].includes(download.kind)) {
      const book = app.books.find((b) => b.metadata?.downloadId === download.id);
      navigate(book ? `/study/${book.id}` : "/study");
      return;
    }
    window.open(`/api/downloads/${download.id}/file`, "_blank", "noopener");
  }

  async function reveal(download) {
    try {
      const res = await downloadApi.reveal(download.id);
      if (!res.opened) toast("warning", `No file manager available. Path: ${res.path}`);
    } catch (err) {
      reportError(err, "Could not open the file location");
    }
  }

  async function retry(download) {
    try {
      await downloadApi.retry(download.id);
      toast("info", `Retrying “${download.title || download.filename || "download"}”.`);
      await refreshDownloads();
      navigate("/downloads");
    } catch (err) {
      reportError(err, "Could not retry this download");
    }
  }

  async function remove(download) {
    try {
      await downloadApi.remove(download.id, false);
      items = items.filter((d) => d.id !== download.id);
      await refreshDownloads();
      toast("success", "Removed from history. The file was kept.");
    } catch (err) {
      reportError(err, "Could not remove the history entry");
    }
  }

  async function confirmClear() {
    clearing = true;
    try {
      const res = await downloadApi.clearHistory(deleteFiles);
      items = [];
      await refreshDownloads();
      clearOpen = false;
      toast("success", `Cleared ${res.removed} history entr${res.removed === 1 ? "y" : "ies"}${deleteFiles ? " and deleted their files" : ""}.`);
    } catch (err) {
      reportError(err, "Could not clear the history");
    } finally {
      clearing = false;
    }
  }
</script>

<div class="content-inner stack stack-5">
  <header class="row row-between wrap" style="gap: 12px; padding-top: 4px">
    <div class="stack stack-1">
      <h1 class="page-title">History</h1>
      <p class="muted" style="font-size: 12px">
        Everything that finished, failed or was canceled — newest first.
      </p>
    </div>
    <div class="row row-2">
      <button class="btn btn-secondary btn-sm" onclick={load} disabled={loading}>
        <Icon name="refresh" size={12} /> Refresh
      </button>
      <button class="btn btn-danger btn-sm" onclick={() => (clearOpen = true)} disabled={!items.length}>
        <Icon name="trash" size={12} /> Clear history
      </button>
    </div>
  </header>

  <div class="history-bar">
    <div class="tabs" role="tablist" aria-label="Filter history">
      {#each filters as f}
        <button class="tab" role="tab" aria-selected={filter === f.id} onclick={() => (filter = f.id)}>
          {f.label}
        </button>
      {/each}
    </div>
    <div class="search-box">
      <Icon name="search" size={13} />
      <input bind:value={query} placeholder="Search history…" aria-label="Search history" />
      {#if query}
        <button class="clear-btn" onclick={() => (query = "")} aria-label="Clear search">
          <Icon name="x" size={11} />
        </button>
      {/if}
    </div>
  </div>

  {#if loading && !items.length}
    <div class="pane">
      {#each [1, 2, 3, 4] as row}
        <div class="loading-row">
          <div class="skeleton" style="width: 34px; height: 34px; border-radius: 9px"></div>
          <div class="stack stack-2" style="flex: 1">
            <div class="skeleton" style="height: 10px; width: 34%"></div>
            <div class="skeleton" style="height: 8px; width: 20%"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if !filtered.length}
    <div class="pane">
      {#if query || filter !== "all"}
        <EmptyState
          icon="history"
          title="Nothing matches"
          message={query ? `No history entries contain “${query}”.` : `There are no ${filter} entries.`}
          actionLabel="Show everything"
          onAction={() => {
            query = "";
            filter = "all";
          }}
        />
      {:else}
        <EmptyState
          icon="history"
          title="History is empty"
          message="Completed and failed transfers are archived here. Downloads stay on disk until you remove them."
          actionLabel="Add a download"
          onAction={() => navigate("/")}
          secondaryLabel="Open downloads"
          onSecondary={() => navigate("/downloads")}
        />
      {/if}
    </div>
  {:else}
    {#each grouped as group}
      <section class="stack stack-2">
        <div class="row row-between">
          <h2 class="day-label">{group.label}</h2>
          <span class="day-count">{group.items.length}</span>
        </div>
        <div class="pane list-pane">
          {#each group.items as download (download.id)}
            <DownloadRow
              {download}
              onAction={(name, d) => (name === "retry" ? retry(d) : null)}
              onOpen={openFile}
              onReveal={reveal}
              onRemove={remove}
            />
          {/each}
        </div>
      </section>
    {/each}

    <p class="list-foot">
      {totals.count} entr{totals.count === 1 ? "y" : "ies"} · {formatBytes(totals.bytes)} archived on this device
    </p>
  {/if}
</div>

<Modal
  open={clearOpen}
  title="Clear all history?"
  subtitle="This cannot be undone."
  onClose={() => (clearOpen = false)}
>
  <div class="stack stack-4">
    <p style="font-size: 12px; line-height: 1.6; color: var(--tertiary)">
      {items.length} history entr{items.length === 1 ? "y" : "ies"} will be removed from the app.
      {deleteFiles
        ? "The downloaded files will also be deleted from disk."
        : "Files will stay on disk; only the list is cleared."}
    </p>
    <label class="checkbox">
      <input type="checkbox" bind:checked={deleteFiles} />
      Also delete the downloaded files from disk
    </label>
    <div class="row row-end row-2">
      <button class="btn btn-secondary btn-sm" onclick={() => (clearOpen = false)}>Cancel</button>
      <button class="btn btn-danger btn-sm" onclick={confirmClear} disabled={clearing}>
        {#if clearing}<Icon name="loader" size={12} class="spin" />{:else}<Icon name="trash" size={12} />{/if}
        Clear history
      </button>
    </div>
  </div>
</Modal>

<style>
  .history-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .search-box {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    width: 220px;
    padding: 0 8px;
    background: var(--surface);
    border: 1px solid var(--input-border);
    border-radius: 7px;
    color: var(--quaternary);
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

  .day-label {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 620;
    letter-spacing: -0.01em;
  }
  .day-count {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--quaternary);
  }
  .list-pane {
    overflow: hidden;
  }
  .list-foot {
    text-align: center;
    font-size: 10.5px;
    color: var(--quaternary);
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

  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 640px) {
    .search-box { width: 100%; }
  }
</style>
