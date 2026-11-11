<script>
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Modal from "../components/Modal.svelte";
  import { app, refreshMedia, refreshStats, reportError, toast } from "../lib/state.svelte.js";
  import { mediaApi } from "../lib/api.js";
  import { formatBytes, formatDuration, formatRelative, pluralize } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let filter = $state("all");
  let query = $state("");
  let sort = $state("recent");
  let view = $state("grid");
  let importing = $state(false);
  let dropActive = $state(false);
  let fileInput = $state(null);
  let removeTarget = $state(null);
  let deleteFile = $state(true);
  let removing = $state(false);

  const filters = [
    { id: "all", label: "All media" },
    { id: "video", label: "Video" },
    { id: "audio", label: "Audio" },
    { id: "unfinished", label: "Continue" },
  ];

  const list = $derived.by(() => {
    let items = [...app.media];
    if (filter === "video") items = items.filter((m) => m.kind === "video");
    else if (filter === "audio") items = items.filter((m) => m.kind === "audio");
    else if (filter === "unfinished") items = items.filter((m) => m.position > 5 && (!m.duration || m.position < m.duration - 5));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      items = items.filter((m) => m.title.toLowerCase().includes(q));
    }
    if (sort === "name") items.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "oldest") items.sort((a, b) => a.createdAt - b.createdAt);
    else if (sort === "size") items.sort((a, b) => (b.size || 0) - (a.size || 0));
    else items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items;
  });

  const totals = $derived({
    video: app.media.filter((m) => m.kind === "video").length,
    audio: app.media.filter((m) => m.kind === "audio").length,
    bytes: app.media.reduce((sum, m) => sum + (m.size || 0), 0),
    watched: app.media.reduce((sum, m) => sum + (m.watchedSeconds || 0), 0),
  });

  async function importFiles(files) {
    const arr = [...files];
    if (!arr.length) return;
    importing = true;
    try {
      const res = await mediaApi.import(arr);
      await refreshMedia();
      refreshStats();
      toast("success", `Added ${pluralize(res.media.length, "media file")} to the player.`);
      if (res.media.length === 1) navigate(`/media/${res.media[0].id}`);
    } catch (err) {
      reportError(err, "The media file could not be imported");
    } finally {
      importing = false;
      if (fileInput) fileInput.value = "";
    }
  }

  function onDrop(event) {
    event.preventDefault();
    dropActive = false;
    if (event.dataTransfer?.files?.length) importFiles(event.dataTransfer.files);
  }

  function askRemove(media) {
    removeTarget = media;
    deleteFile = true;
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    removing = true;
    try {
      await mediaApi.remove(removeTarget.id, deleteFile);
      removeTarget = null;
      await refreshMedia();
      refreshStats();
      toast("success", deleteFile ? "Media file deleted." : "Removed from the player library.");
    } catch (err) {
      reportError(err, "Could not remove the media file");
    } finally {
      removing = false;
    }
  }

  function pct(media) {
    if (!media.duration) return 0;
    return Math.min(100, Math.max(0, (media.position / media.duration) * 100));
  }

  function remaining(media) {
    if (!media.duration) return null;
    return Math.max(0, media.duration - media.position);
  }
</script>

<div class="content-inner stack stack-5">
  <header class="row row-between wrap" style="gap: 12px; padding-top: 4px">
    <div class="stack stack-1">
      <h1 class="page-title">Media</h1>
      <p class="muted" style="font-size: 12px">
        A local player for the audio and video you already have. No streaming service, no accounts.
      </p>
    </div>
    <div class="row row-2">
      <button class="btn btn-secondary btn-sm" onclick={() => navigate("/downloads")}>
        <Icon name="download" size={12} /> From downloads
      </button>
      <button class="btn btn-primary btn-sm" onclick={() => fileInput?.click()} disabled={importing}>
        {#if importing}
          <Icon name="loader" size={12} class="spin" /> Importing…
        {:else}
          <Icon name="plus" size={12} /> Add media
        {/if}
      </button>
      <input
        bind:this={fileInput}
        class="hidden-input"
        type="file"
        accept="video/*,audio/*,.mkv,.m4v,.opus,.flac"
        multiple
        onchange={(e) => importFiles(e.currentTarget.files)}
      />
    </div>
  </header>

  <section class="media-stats">
    <div class="media-stat">
      <span class="stat-icon video"><Icon name="video" size={14} /></span>
      <div><span class="stat-value">{totals.video}</span><span class="stat-label">Videos</span></div>
    </div>
    <div class="media-stat">
      <span class="stat-icon audio"><Icon name="music" size={14} /></span>
      <div><span class="stat-value">{totals.audio}</span><span class="stat-label">Audio tracks</span></div>
    </div>
    <div class="media-stat">
      <span class="stat-icon storage"><Icon name="hard-drive" size={14} /></span>
      <div><span class="stat-value">{formatBytes(totals.bytes)}</span><span class="stat-label">On this device</span></div>
    </div>
    <div class="media-stat">
      <span class="stat-icon time"><Icon name="clock" size={14} /></span>
      <div><span class="stat-value">{formatDuration(totals.watched)}</span><span class="stat-label">Time played</span></div>
    </div>
  </section>

  <section
    class="drop-zone"
    class:active={dropActive}
    ondrop={onDrop}
    ondragover={(e) => {
      e.preventDefault();
      dropActive = true;
    }}
    ondragleave={() => (dropActive = false)}
  >
    <Icon name="upload" size={16} />
    <span>Drop MP4, WebM, MKV, MP3, FLAC or M4A files here</span>
    <span class="drop-hint">Playback support depends on the formats your browser can decode.</span>
  </section>

  <div class="library-bar">
    <div class="tabs" role="tablist" aria-label="Filter media">
      {#each filters as f}
        <button class="tab" role="tab" aria-selected={filter === f.id} onclick={() => (filter = f.id)}>
          {f.label}
        </button>
      {/each}
    </div>
    <div class="row row-2">
      <div class="search-box">
        <Icon name="search" size={13} />
        <input bind:value={query} placeholder="Search media…" aria-label="Search media" />
        {#if query}
          <button class="clear-btn" onclick={() => (query = "")} aria-label="Clear search">
            <Icon name="x" size={11} />
          </button>
        {/if}
      </div>
      <select class="select sort-select" bind:value={sort} aria-label="Sort media">
        <option value="recent">Recently played</option>
        <option value="oldest">Oldest first</option>
        <option value="name">Name A–Z</option>
        <option value="size">Largest first</option>
      </select>
      <div class="tabs" role="tablist" aria-label="View mode">
        <button class="tab" role="tab" aria-selected={view === "grid"} onclick={() => (view = "grid")} title="Grid">
          <Icon name="grid-view" size={12} />
        </button>
        <button class="tab" role="tab" aria-selected={view === "list"} onclick={() => (view = "list")} title="List">
          <Icon name="list-view" size={12} />
        </button>
      </div>
    </div>
  </div>

  {#if !app.media.length}
    <div class="pane">
      <EmptyState
        title="No media in the player yet"
        message="Add a video or audio file, or download one from Home. OmniGet remembers where you stopped and keeps timestamped notes."
        actionLabel="Choose files"
        onAction={() => fileInput?.click()}
        secondaryLabel="Open downloads"
        onSecondary={() => navigate("/downloads")}
      />
    </div>
  {:else if !list.length}
    <div class="pane">
      <EmptyState
        icon="search"
        title={query ? `No media matches “${query}”` : "Nothing in this filter"}
        message="Try another search or filter."
        actionLabel="Reset"
        onAction={() => {
          query = "";
          filter = "all";
        }}
      />
    </div>
  {:else if view === "grid"}
    <div class="media-grid">
      {#each list as media (media.id)}
        <article class="media-card">
          <button class="media-art" onclick={() => navigate(`/media/${media.id}`)} aria-label={`Play ${media.title}`}>
            <span class="art-fallback kind-{media.kind}">
              <Icon name={media.kind === "audio" ? "music" : "video"} size={26} />
            </span>
            {#if media.thumbnail}
              <img src={media.thumbnail} alt="" loading="lazy" />
            {/if}
            <span class="play-overlay"><Icon name="play" size={18} filled /></span>
            <span class="kind-badge">
              <Icon name={media.kind === "audio" ? "music" : "video"} size={9} />
              {media.kind === "audio" ? "Audio" : "Video"}
            </span>
            {#if media.duration}
              <span class="duration-badge mono">{formatDuration(remaining(media) ?? media.duration)}</span>
            {/if}
            {#if pct(media) > 1}
              <span class="art-progress"><span style="width: {pct(media)}%"></span></span>
            {/if}
          </button>

          <div class="media-body">
            <div class="media-heading">
              <button class="media-title" onclick={() => navigate(`/media/${media.id}`)} title={media.title}>
                {media.title}
              </button>
              <button class="btn btn-ghost btn-icon btn-sm" onclick={() => askRemove(media)} title="Remove">
                <Icon name="more-horizontal" size={13} />
              </button>
            </div>
            <p class="media-meta">
              {#if media.duration}{formatDuration(media.duration)}{:else}Duration unknown{/if}
              · {formatBytes(media.size)}
              {#if media.subtitles?.length}· {pluralize(media.subtitles.length, "subtitle")}{/if}
            </p>
            <div class="media-foot">
              <span class="faint" style="font-size: 9.5px">
                {media.position > 5 && remaining(media) ? `${formatDuration(remaining(media))} left` : `Added ${formatRelative(media.createdAt)}`}
              </span>
              <button class="btn btn-ghost btn-sm" onclick={() => navigate(`/media/${media.id}`)}>
                <Icon name="play" size={10} /> Play
              </button>
            </div>
          </div>
        </article>
      {/each}
    </div>
  {:else}
    <div class="pane list-pane">
      {#each list as media (media.id)}
        <button class="media-row" onclick={() => navigate(`/media/${media.id}`)}>
          <span class="row-art kind-{media.kind}">
            <Icon name={media.kind === "audio" ? "music" : "video"} size={15} />
          </span>
          <span class="row-main">
            <span class="row-title">{media.title}</span>
            <span class="row-sub">
              {media.kind === "audio" ? "Audio" : "Video"} · {formatBytes(media.size)}
              {#if media.duration}· {formatDuration(media.duration)}{/if}
            </span>
          </span>
          <span class="row-played">{pct(media) > 1 ? `${Math.round(pct(media))}%` : "New"}</span>
          <span class="row-bar"><span style="width: {pct(media)}%"></span></span>
          <Icon name="play" size={13} class="faint" />
        </button>
      {/each}
    </div>
    <p class="list-foot">{list.length} files · {formatBytes(totals.bytes)} stored locally</p>
  {/if}
</div>

<Modal open={!!removeTarget} title="Remove media?" subtitle={removeTarget?.title || ""} onClose={() => (removeTarget = null)}>
  <div class="stack stack-4">
    <p style="font-size: 12px; line-height: 1.6; color: var(--tertiary)">
      Playback position, subtitles and notes for this item will be removed.
      {deleteFile ? "The media file will be deleted from disk." : "The file on disk will be kept."}
    </p>
    <label class="checkbox">
      <input type="checkbox" bind:checked={deleteFile} />
      Delete the media file from disk
    </label>
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
  .hidden-input { display: none; }

  .media-stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .media-stat {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    background: var(--pane);
    border: 1px solid var(--content-border);
  }
  .media-stat > div {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .stat-icon {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    display: grid;
    place-content: center;
    flex: 0 0 auto;
    background: var(--surface-sunken);
    color: var(--tertiary);
  }
  .stat-icon.video { background: var(--purple-soft); color: var(--purple); }
  .stat-icon.audio { background: var(--accent-soft); color: var(--accent-text); }
  .stat-icon.storage { background: var(--blue-soft); color: var(--blue); }
  .stat-icon.time { background: var(--teal-soft); color: var(--teal); }
  .stat-value {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .stat-label {
    font-size: 9.5px;
    color: var(--tertiary);
  }

  .drop-zone {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px 14px;
    border-radius: var(--radius-lg);
    border: 1.5px dashed color-mix(in srgb, var(--input-border) 80%, transparent);
    background: color-mix(in srgb, var(--pane) 60%, transparent);
    font-size: 11.5px;
    color: var(--tertiary);
  }
  .drop-zone :global(svg) { color: var(--quaternary); }
  .drop-zone.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .drop-hint {
    margin-left: auto;
    font-size: 10px;
    color: var(--quaternary);
  }

  .library-bar {
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
    width: 190px;
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
  .clear-btn { color: var(--quaternary); display: grid; place-content: center; }
  .sort-select {
    width: 146px;
    height: 28px;
    font-size: 11px;
  }

  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(216px, 1fr));
    gap: var(--space-4);
  }
  .media-card {
    background: var(--pane);
    border: 1px solid var(--content-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    transition:
      transform var(--duration-base) var(--ease-out),
      box-shadow var(--duration-base) var(--ease-out);
  }
  .media-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--elev-2);
  }
  .media-art {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background: var(--surface-sunken);
  }
  .media-art img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .art-fallback {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    color: var(--quaternary);
  }
  .art-fallback.kind-video {
    background: linear-gradient(140deg, rgba(175, 82, 222, 0.18), rgba(175, 82, 222, 0.06));
    color: var(--purple);
  }
  .art-fallback.kind-audio {
    background: linear-gradient(140deg, rgba(255, 149, 0, 0.2), rgba(255, 149, 0, 0.06));
    color: var(--accent-text);
  }
  .play-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    background: rgba(20, 16, 8, 0.18);
    color: #fff;
    opacity: 0;
    transition: opacity var(--duration-base) var(--ease-out);
  }
  .media-art:hover .play-overlay { opacity: 1; }
  .play-overlay :global(svg) {
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.4));
  }
  .kind-badge,
  .duration-badge {
    position: absolute;
    bottom: 7px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 5px;
    border-radius: 4px;
    background: rgba(20, 16, 8, 0.66);
    color: #fff;
    font-size: 8.5px;
    letter-spacing: 0.02em;
    backdrop-filter: blur(4px);
  }
  .kind-badge { left: 7px; }
  .duration-badge { right: 7px; font-size: 9px; }
  .art-progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(255, 255, 255, 0.28);
  }
  .art-progress span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .media-body {
    padding: 9px 11px 7px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .media-heading {
    display: flex;
    align-items: flex-start;
    gap: 2px;
  }
  .media-title {
    flex: 1;
    min-width: 0;
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .media-title:hover { color: var(--accent-text); }
  .media-meta {
    font-size: 9.5px;
    color: var(--quaternary);
  }
  .media-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    margin-top: 3px;
  }

  .list-pane { overflow: hidden; }
  .media-row {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    padding: 10px 12px;
    border-bottom: 1px solid var(--content-border);
    text-align: left;
  }
  .media-row:last-child { border-bottom: 0; }
  .media-row:hover { background: var(--surface-hi); }
  .row-art {
    width: 42px;
    height: 30px;
    border-radius: 6px;
    display: grid;
    place-content: center;
    background: var(--surface-sunken);
    color: var(--tertiary);
    flex: 0 0 auto;
  }
  .row-art.kind-video { background: var(--purple-soft); color: var(--purple); }
  .row-art.kind-audio { background: var(--accent-soft); color: var(--accent-text); }
  .row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .row-title {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-sub {
    font-size: 10px;
    color: var(--tertiary);
  }
  .row-played {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--tertiary);
    flex: 0 0 auto;
  }
  .row-bar {
    width: 80px;
    height: 3px;
    border-radius: 99px;
    background: var(--surface-sunken);
    overflow: hidden;
    flex: 0 0 auto;
  }
  .row-bar span { display: block; height: 100%; background: var(--accent); }
  .list-foot {
    text-align: center;
    font-size: 10.5px;
    color: var(--quaternary);
  }

  .spin { animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 1000px) {
    .media-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .search-box { width: 100%; }
    .drop-hint { display: none; }
    .row-bar { display: none; }
  }
</style>
