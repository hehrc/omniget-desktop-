<script>
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { app, refreshTools, reportError } from "../lib/state.svelte.js";
  import { toolsApi } from "../lib/api.js";
  import { formatBytes, formatRelative, statusLabel } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let query = $state("");
  let activeCategory = $state("all");
  let jobs = $state([]);
  let jobsLoading = $state(true);
  let onlyAvailable = $state(false);

  $effect(() => {
    if (!app.tools) refreshTools().catch(() => {});
    toolsApi
      .jobs()
      .then((res) => (jobs = res.jobs.slice(0, 5)))
      .catch(() => {})
      .finally(() => (jobsLoading = false));
  });

  const categories = $derived(app.tools?.categories || []);
  const allTools = $derived(app.tools?.tools || []);
  const systems = $derived(app.tools?.systems || {});
  const builtinGating = $derived(
    !systems.ffmpeg || !systems.ffprobe || !systems.ytdlp
      ? [
          !systems.ffmpeg ? "ffmpeg" : null,
          !systems.ffprobe ? "ffprobe" : null,
          !systems.ytdlp ? "yt-dlp" : null,
        ].filter(Boolean)
      : [],
  );

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    let list = allTools;
    if (activeCategory !== "all") list = list.filter((t) => t.category === activeCategory);
    if (onlyAvailable) list = list.filter((t) => t.available);
    if (q) {
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.keywords.some((k) => k.includes(q)) ||
          t.category.includes(q),
      );
    }
    return list;
  });

  const grouped = $derived.by(() => {
    if (query.trim() || activeCategory !== "all") return null;
    return categories
      .map((cat) => ({
        ...cat,
        visible: (onlyAvailable ? cat.tools.filter((t) => t.available) : cat.tools),
      }))
      .filter((cat) => cat.visible.length);
  });

  const counts = $derived({
    total: allTools.length,
    available: allTools.filter((t) => t.available && !t.requiresConfig).length,
    unavailable: allTools.filter((t) => !t.available || t.requiresConfig).length,
  });

  function catFor(id) {
    return categories.find((c) => c.id === id);
  }

  function toolCount(id) {
    return categories.find((c) => c.id === id)?.tools.length || 0;
  }

  const JOB_STATUS = { completed: "success", failed: "error", running: "accent" };
  const JOB_COLORS = { completed: "success", failed: "error", running: "accent" };
  const TOOL_ICONS = {
    pdf: "file-pdf",
    documents: "file-text",
    text: "braces",
    archives: "zip",
    subtitles: "subtitles",
    images: "image",
    study: "book-open",
    audio: "music",
    files: "file",
    utilities: "qr",
    security: "shield",
    ai: "sparkles",
    downloads: "download",
  };
  function iconFor(tool) {
    return TOOL_ICONS[tool.category] || "wrench";
  }

  function openJob(job) {
    if (job.toolId) navigate(`/tools/${job.toolId}`);
  }
</script>

<div class="content-inner stack stack-5">
  <header class="row row-between wrap" style="gap: 12px; padding-top: 4px">
    <div class="stack stack-1">
      <h1 class="page-title">Tools</h1>
      <p class="muted" style="font-size: 12px">
        Real processing that runs in the local service — files never leave this device.
      </p>
    </div>
    <div class="row row-2">
      <span class="badge badge-success">{counts.available} ready</span>
      {#if counts.unavailable}<span class="badge badge-warning">{counts.unavailable} limited</span>{/if}
      <span class="badge badge-outline">{counts.total} tools</span>
    </div>
  </header>

  {#if builtinGating.length}
    <div class="gate-banner">
      <Icon name="alert-triangle" size={14} />
      <div class="gate-text">
        <strong>Optional binaries not found:</strong>
        {builtinGating.join(", ")}. Media conversion, extract-audio and page extraction tools report
        themselves as unavailable until those programs are installed.
      </div>
      <button class="btn btn-secondary btn-sm" onclick={() => navigate("/settings")}>Details</button>
    </div>
  {/if}

  <div class="tools-bar">
    <div class="search-box">
      <Icon name="search" size={14} />
      <input
        bind:value={query}
        placeholder="Search tools by name or task…"
        aria-label="Search tools"
      />
      {#if query}
        <button class="clear-btn" onclick={() => (query = "")} aria-label="Clear search">
          <Icon name="x" size={11} />
        </button>
      {/if}
    </div>
    <label class="checkbox">
      <input type="checkbox" bind:checked={onlyAvailable} />
      Only show what can run now
    </label>
  </div>

  <div class="category-strip scroll-x" role="tablist" aria-label="Tool categories">
    <button
      class="cat-chip"
      class:active={activeCategory === "all"}
      role="tab"
      aria-selected={activeCategory === "all"}
      onclick={() => (activeCategory = "all")}
    >
      <span class="cat-dot all"></span>
      All tools
      <span class="cat-count">{allTools.length}</span>
    </button>
    {#each categories as cat}
      <button
        class="cat-chip"
        class:active={activeCategory === cat.id}
        role="tab"
        aria-selected={activeCategory === cat.id}
        onclick={() => (activeCategory = cat.id)}
        title={cat.description}
      >
        <span class="cat-dot" style="background: linear-gradient(135deg, {cat.icon.from}, {cat.icon.to})"></span>
        {cat.name}
        <span class="cat-count">{toolCount(cat.id)}</span>
      </button>
    {/each}
  </div>

  {#if !app.tools}
    <div class="tool-grid">
      {#each [1, 2, 3, 4, 5, 6] as row}
        <div class="tool-card skeleton-card">
          <div class="skeleton" style="width: 34px; height: 34px; border-radius: 9px"></div>
          <div class="stack stack-2" style="flex: 1">
            <div class="skeleton" style="height: 11px; width: 52%"></div>
            <div class="skeleton" style="height: 8px; width: 88%"></div>
            <div class="skeleton" style="height: 8px; width: 64%"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if !filtered.length}
    <div class="pane">
      <EmptyState
        icon="search"
        title={query ? `No tools match “${query}”` : "No available tools in this category"}
        message={onlyAvailable ? "Turn off “Only show what can run now” to see tools that need extra software." : "Try another search term or category."}
        actionLabel="Reset filters"
        onAction={() => {
          query = "";
          activeCategory = "all";
          onlyAvailable = false;
        }}
      />
    </div>
  {:else if grouped}
    {#each grouped as cat}
      <section class="stack stack-3">
        <div class="cat-head">
          <span class="cat-head-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <defs>
                <linearGradient id={`grad-${cat.id}`} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color={cat.icon.from} />
                  <stop offset="1" stop-color={cat.icon.to} />
                </linearGradient>
              </defs>
              <path d={cat.icon.glyph} fill={`url(#grad-${cat.id})`} />
            </svg>
          </span>
          <div class="stack stack-1" style="min-width: 0">
            <h2 class="section-title">{cat.name}</h2>
            <p class="cat-desc">{cat.description}</p>
          </div>
          <span class="cat-total">{cat.visible.length} tool{cat.visible.length === 1 ? "" : "s"}</span>
        </div>

        <div class="tool-grid">
          {#each cat.visible as tool (tool.id)}
            <button class="tool-card" onclick={() => navigate(`/tools/${tool.id}`)}>
              <span class="tool-icon">
                <Icon name={iconFor(tool)} size={17} />
              </span>
              <span class="tool-main">
                <span class="tool-head">
                  <span class="tool-name">{tool.name}</span>
                  {#if !tool.available}
                    <span class="badge badge-warning">Needs binary</span>
                  {:else if tool.requiresConfig}
                    <span class="badge badge-blue">Needs key</span>
                  {/if}
                </span>
                <span class="tool-desc">{tool.description}</span>
                <span class="tool-foot">
                  {#if tool.maxFiles > 0}
                    <span><Icon name="upload" size={9} /> {tool.maxFiles === 1 ? "1 file" : `up to ${tool.maxFiles} files`}</span>
                  {/if}
                  {#if tool.fields?.length}
                    <span><Icon name="sliders" size={9} /> {tool.fields.length} option{tool.fields.length === 1 ? "" : "s"}</span>
                  {/if}
                  <span class="tool-go">Open <Icon name="chevron-right" size={9} /></span>
                </span>
              </span>
            </button>
          {/each}
        </div>
      </section>
    {/each}
  {:else}
    <div class="stack stack-3">
      <div class="row row-between">
        <h2 class="section-title">
          {filtered.length} result{filtered.length === 1 ? "" : "s"}
          {#if activeCategory !== "all"}in {catFor(activeCategory)?.name}{/if}
        </h2>
        {#if activeCategory !== "all"}
          <button class="btn btn-ghost btn-sm" onclick={() => (activeCategory = "all")}>
            All categories
          </button>
        {/if}
      </div>
      <div class="tool-grid">
        {#each filtered as tool (tool.id)}
          <button class="tool-card" onclick={() => navigate(`/tools/${tool.id}`)}>
            <span class="tool-icon"><Icon name={iconFor(tool)} size={17} /></span>
            <span class="tool-main">
              <span class="tool-head">
                <span class="tool-name">{tool.name}</span>
                {#if !tool.available}
                  <span class="badge badge-warning">Needs binary</span>
                {:else if tool.requiresConfig}
                  <span class="badge badge-blue">Needs key</span>
                {/if}
              </span>
              <span class="tool-desc">{tool.description}</span>
              <span class="tool-foot">
                <span><Icon name="grid" size={9} /> {catFor(tool.category)?.name || tool.category}</span>
                <span class="tool-go">Open <Icon name="chevron-right" size={9} /></span>
              </span>
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <section class="stack stack-3">
    <div class="row row-between">
      <h2 class="section-title">Recent tool runs</h2>
      {#if jobs.length}
        <button class="btn btn-ghost btn-sm" onclick={() => navigate("/tools")}>Refresh</button>
      {/if}
    </div>
    {#if jobsLoading}
      <div class="pane job-row"><div class="skeleton" style="height: 12px; width: 40%"></div></div>
    {:else if !jobs.length}
      <div class="pane job-empty">
        <Icon name="wrench" size={16} />
        <span>No tool has been run yet. Results are kept under <span class="mono">data/outputs</span>.</span>
      </div>
    {:else}
      <div class="pane job-list">
        {#each jobs as job (job.id)}
          <button class="job-row" onclick={() => openJob(job)}>
            <span class="job-state">
              <span class="dot" style="color: var(--{JOB_COLORS[job.status] || 'accent'})"></span>
            </span>
            <span class="job-main">
              <span class="job-name">{job.output?.summary || app.tools?.tools?.find((t) => t.id === job.toolId)?.name || job.toolId}</span>
              <span class="job-meta">
                {statusLabel(job.status)} · {formatRelative(job.createdAt)}
                {#if job.error}· <span class="job-error">{job.error}</span>{/if}
              </span>
            </span>
            {#if job.output?.files?.length}
              <span class="badge badge-outline">{job.output.files.length} file{job.output.files.length === 1 ? "" : "s"}</span>
            {/if}
            <Icon name="chevron-right" size={12} class="faint" />
          </button>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  .gate-banner {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 11px 13px;
    border-radius: var(--radius-md);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 11px;
    line-height: 1.5;
  }
  .gate-banner :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
  }
  .gate-text {
    flex: 1;
  }
  .gate-text strong {
    font-weight: 650;
  }

  .tools-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .search-box {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    flex: 1;
    max-width: 460px;
    padding: 0 11px;
    background: var(--surface);
    border: 1px solid var(--input-border);
    border-radius: 8px;
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
    font-size: 12px;
    color: var(--secondary);
  }
  .clear-btn {
    color: var(--quaternary);
    display: grid;
    place-content: center;
  }

  .category-strip {
    display: flex;
    gap: 5px;
    padding-bottom: 2px;
  }
  .cat-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--radius-full);
    background: var(--surface);
    border: 1px solid var(--content-border);
    font-size: 11px;
    font-weight: 550;
    color: var(--tertiary);
    white-space: nowrap;
    transition: all var(--duration-fast) var(--ease-out);
  }
  .cat-chip:hover {
    color: var(--secondary);
    border-color: color-mix(in srgb, var(--accent) 35%, var(--content-border));
  }
  .cat-chip.active {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    color: var(--accent-text);
    font-weight: 600;
  }
  .cat-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ffb44d, #e07b00);
    flex: 0 0 auto;
  }
  .cat-dot.all {
    background: var(--quaternary);
  }
  .cat-count {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--quaternary);
    margin-left: 1px;
  }
  .cat-chip.active .cat-count {
    color: var(--accent-text);
    opacity: 0.75;
  }

  .cat-head {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding-bottom: 2px;
  }
  .cat-head-icon {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    display: grid;
    place-content: center;
    background: var(--surface);
    border: 1px solid var(--content-border);
    flex: 0 0 auto;
    margin-top: 1px;
  }
  .cat-desc {
    font-size: 10.5px;
    color: var(--tertiary);
    line-height: 1.45;
  }
  .cat-total {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--quaternary);
    padding-top: 4px;
    flex: 0 0 auto;
  }

  .tool-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
    gap: var(--space-3);
  }
  .tool-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
    text-align: left;
    background: var(--pane);
    border: 1px solid var(--content-border);
    border-radius: var(--radius-lg);
    transition:
      transform var(--duration-base) var(--ease-out),
      box-shadow var(--duration-base) var(--ease-out),
      border-color var(--duration-base) var(--ease-out);
  }
  .tool-card:hover {
    transform: translateY(-1px);
    box-shadow: var(--elev-2);
    border-color: color-mix(in srgb, var(--accent) 32%, var(--content-border));
  }
  .skeleton-card {
    cursor: default;
  }
  .skeleton-card:hover {
    transform: none;
    box-shadow: none;
    border-color: var(--content-border);
  }
  .tool-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: grid;
    place-content: center;
    background: var(--surface);
    border: 1px solid var(--content-border);
    color: var(--tertiary);
    flex: 0 0 auto;
  }
  .tool-card:hover .tool-icon {
    color: var(--accent-text);
    background: var(--accent-soft);
    border-color: transparent;
  }
  .tool-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }
  .tool-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .tool-name {
    font-size: 12px;
    font-weight: 620;
    letter-spacing: -0.005em;
  }
  .tool-desc {
    font-size: 10.5px;
    color: var(--tertiary);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tool-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 3px;
    font-size: 9px;
    color: var(--quaternary);
  }
  .tool-foot span {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .tool-go {
    margin-left: auto;
    color: var(--accent-text);
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease-out);
  }
  .tool-card:hover .tool-go {
    opacity: 1;
  }

  .job-list {
    overflow: hidden;
  }
  .job-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    border-bottom: 1px solid var(--content-border);
    text-align: left;
  }
  .job-row:last-child {
    border-bottom: 0;
  }
  .job-row:hover {
    background: var(--surface-hi);
  }
  .job-state {
    width: 8px;
    display: grid;
    place-content: center;
  }
  .job-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .job-name {
    font-size: 11.5px;
    font-weight: 550;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .job-meta {
    font-size: 9.5px;
    color: var(--quaternary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .job-error {
    color: var(--error);
  }
  .job-empty {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 14px;
    font-size: 11px;
    color: var(--quaternary);
  }
  .job-empty :global(svg) {
    color: var(--quaternary);
  }

  @media (max-width: 640px) {
    .tool-grid { grid-template-columns: minmax(0, 1fr); }
    .cat-total { display: none; }
  }
</style>
