<script>
  import Icon from "./Icon.svelte";
  import { formatBytes, formatSpeed, formatEta, statusLabel, statusTone, formatRelative, extOf } from "../lib/format.js";

  let {
    download,
    onAction = () => {},
    onLogs = null,
    onOpen = null,
    onReveal = () => {},
    onRemove = null,
    compact = false,
  } = $props();

  const KIND_ICON = {
    video: "video",
    audio: "music",
    image: "image",
    pdf: "file-pdf",
    ebook: "book-open",
    archive: "zip",
    hls: "video",
    page: "globe",
    other: "file",
  };

  const progress = $derived(
    download.sizeBytes > 0
      ? Math.min(100, (download.downloadedBytes / download.sizeBytes) * 100)
      : download.segmentsTotal > 0
        ? Math.min(100, (download.segmentsDone / download.segmentsTotal) * 100)
        : null,
  );

  const isActive = $derived(["queued", "downloading", "probing"].includes(download.status));
  const isPaused = $derived(download.status === "paused");
  const canPause = $derived(download.status === "downloading" || download.status === "queued");
  const canResume = $derived(isPaused || download.status === "failed" || download.status === "canceled");
  const isCompleted = $derived(download.status === "completed");
  const indeterminate = $derived(isActive && progress === null);

  function act(name) {
    onAction(name, download);
  }
</script>

<div class="dl-row" class:compact>
  <div class="dl-icon kind-{download.kind || 'other'}" aria-hidden="true">
    <Icon name={KIND_ICON[download.kind] || "file"} size={compact ? 15 : 17} />
    {#if download.status === "downloading"}
      <span class="dl-icon-live"></span>
    {/if}
  </div>

  <div class="dl-main">
    <div class="dl-title-line">
      <button
        class="dl-title"
        title={download.title || download.filename || download.url}
        onclick={() => (isCompleted && onOpen ? onOpen(download) : onLogs?.(download))}
      >
        {download.title || download.filename || download.url}
      </button>
      <span class="badge badge-{statusTone(download.status)}">
        {#if download.status === "downloading"}<span class="dot pulse"></span>{/if}
        {statusLabel(download.status)}
      </span>
      {#if download.engine === "hls"}
        <span class="badge badge-outline" title="Segmented HLS stream">HLS</span>
      {/if}
    </div>

    <div class="dl-meta">
      <span class="dl-source">{download.sourceLabel || download.source || "Web"}</span>
      {#if download.quality}<span class="sep">·</span><span>{download.quality}</span>{/if}
      {#if download.status === "downloading"}
        <span class="sep">·</span>
        <span class="mono">{formatBytes(download.downloadedBytes)} / {download.sizeBytes ? formatBytes(download.sizeBytes) : "unknown"}</span>
        <span class="sep">·</span>
        <span class="dl-speed mono">{formatSpeed(download.speedBps)}</span>
        {#if download.etaSeconds !== null && download.etaSeconds !== undefined}
          <span class="sep">·</span>
          <span>{formatEta(download.etaSeconds)} left</span>
        {/if}
      {:else if download.status === "paused"}
        <span class="sep">·</span>
        <span class="mono">{formatBytes(download.downloadedBytes)} saved</span>
      {:else if isCompleted}
        <span class="sep">·</span>
        <span class="mono">{formatBytes(download.sizeBytes)}</span>
        {#if download.filename}<span class="sep">·</span><span class="mono dl-filename">{extOf(download.filename)}</span>{/if}
      {:else if download.status === "failed"}
        <span class="sep">·</span>
        <span class="dl-error" title={download.error}>{download.error || "Failed"}</span>
      {:else}
        <span class="sep">·</span>
        <span>{formatRelative(download.createdAt)}</span>
      {/if}
    </div>

    {#if download.status === "downloading" || download.status === "paused" || (download.status === "queued" && progress === null)}
      <div class="dl-progress">
        <div class="progress {indeterminate ? 'progress-indeterminate' : ''}" style="height: 3px">
          <div
            class="progress-fill"
            class:is-complete={isCompleted}
            class:is-error={download.status === "failed"}
            style="width: {progress === null ? 0 : progress}%"
          ></div>
        </div>
        <span class="dl-percent mono">
          {#if progress === null}
            {download.segmentsTotal ? `${download.segmentsDone}/${download.segmentsTotal} segments` : "…"}
          {:else}
            {Math.round(progress)}%
          {/if}
        </span>
      </div>
    {/if}
  </div>

  <div class="dl-actions">
    {#if isCompleted}
      <button class="btn btn-secondary btn-sm" onclick={() => onOpen?.(download)} title="Play or open">
        <Icon name={download.kind === "audio" ? "play" : download.kind === "pdf" || download.kind === "ebook" ? "book-open" : "play"} size={12} />
        <span class="action-label">Open</span>
      </button>
      <button class="btn btn-ghost btn-icon btn-sm" onclick={() => onReveal(download)} title="Show in file manager">
        <Icon name="folder-open" size={14} />
      </button>
      <a
        class="btn btn-ghost btn-icon btn-sm"
        href={`/api/downloads/${download.id}/file?download=1`}
        title="Download file again"
        download
      >
        <Icon name="download" size={14} />
      </a>
    {:else if canPause}
      <button class="btn btn-secondary btn-sm" onclick={() => act("pause")} title="Pause">
        <Icon name="pause" size={12} />
        <span class="action-label">Pause</span>
      </button>
      <button class="btn btn-ghost btn-icon btn-sm" onclick={() => act("cancel")} title="Cancel">
        <Icon name="x" size={14} />
      </button>
    {:else if canResume}
      <button class="btn btn-primary btn-sm" onclick={() => act(isPaused ? "resume" : "retry")} title="Resume">
        <Icon name="play" size={11} />
        <span class="action-label">{isPaused ? "Resume" : "Retry"}</span>
      </button>
      <button class="btn btn-ghost btn-icon btn-sm" onclick={() => act("cancel")} title="Cancel">
        <Icon name="x" size={14} />
      </button>
    {:else if download.status === "canceled"}
      <button class="btn btn-secondary btn-sm" onclick={() => act("retry")} title="Retry">
        <Icon name="refresh" size={12} />
        <span class="action-label">Retry</span>
      </button>
    {/if}

    {#if onLogs}
      <button class="btn btn-ghost btn-icon btn-sm" onclick={() => onLogs(download)} title="View log">
        <Icon name="terminal" size={14} />
      </button>
    {/if}

    {#if onRemove}
      <button class="btn btn-ghost btn-icon btn-sm remove-btn" onclick={() => onRemove(download)} title="Remove">
        <Icon name="trash" size={14} />
      </button>
    {/if}
  </div>
</div>

<style>
  .dl-row {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    padding: 11px 13px;
    border-bottom: 1px solid var(--content-border);
    transition: background var(--duration-fast) var(--ease-out);
  }
  .dl-row:last-child {
    border-bottom: 0;
  }
  .dl-row:hover {
    background: color-mix(in srgb, var(--surface) 55%, transparent);
  }

  .dl-icon {
    position: relative;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    display: grid;
    place-content: center;
    flex: 0 0 auto;
    background: var(--surface-sunken);
    color: var(--tertiary);
    margin-top: 1px;
  }
  .dl-icon.kind-video { background: rgba(175, 82, 222, 0.12); color: var(--purple); }
  .dl-icon.kind-audio { background: rgba(255, 149, 0, 0.14); color: var(--accent-text); }
  .dl-icon.kind-image { background: rgba(8, 145, 178, 0.12); color: var(--teal); }
  .dl-icon.kind-pdf { background: rgba(215, 0, 21, 0.1); color: var(--error); }
  .dl-icon.kind-ebook { background: rgba(0, 122, 255, 0.1); color: var(--blue); }
  .dl-icon.kind-archive { background: rgba(138, 90, 43, 0.14); color: #8a5a2b; }
  .dl-icon-live {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid var(--pane);
    animation: pulse 1.6s var(--ease-in-out) infinite;
  }

  .dl-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .dl-title-line {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .dl-title {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--secondary);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: -0.005em;
    min-width: 0;
  }
  .dl-title:hover {
    color: var(--accent-text);
  }

  .dl-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    color: var(--tertiary);
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .dl-source {
    font-weight: 550;
  }
  .sep {
    color: var(--quaternary);
    opacity: 0.6;
  }
  .dl-speed {
    color: var(--accent-text);
  }
  .dl-error {
    color: var(--error);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dl-filename {
    font-size: 10px;
  }

  .dl-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 3px;
    max-width: 460px;
  }
  .dl-progress .progress {
    flex: 1;
  }
  .dl-percent {
    font-size: 9.5px;
    color: var(--tertiary);
    min-width: 34px;
    text-align: right;
  }

  .dl-actions {
    display: flex;
    align-items: center;
    gap: 3px;
    flex: 0 0 auto;
    margin-left: auto;
  }
  .remove-btn:hover {
    color: var(--error);
    background: var(--error-soft);
  }

  .compact {
    padding: 8px 10px;
    gap: 9px;
  }
  .compact .dl-icon {
    width: 27px;
    height: 27px;
    border-radius: 7px;
  }
  .compact .dl-title {
    font-size: 11.5px;
  }
  .compact .dl-actions :global(.btn) {
    height: 24px;
  }

  @media (max-width: 640px) {
    .action-label {
      display: none;
    }
    .dl-actions :global(.btn-sm) {
      padding: 0 6px;
    }
    .dl-filename {
      display: none;
    }
  }
</style>
