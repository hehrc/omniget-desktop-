<script>
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Modal from "../components/Modal.svelte";
  import { app, refreshBooks, refreshNotes, refreshStats, reportError, toast } from "../lib/state.svelte.js";
  import { bookApi } from "../lib/api.js";
  import { formatBytes, formatDuration, formatRelative, pluralize, readingTime } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let filter = $state("all");
  let query = $state("");
  let view = $state("grid");
  let importing = $state(false);
  let dropActive = $state(false);
  let removeTarget = $state(null);
  let deleteFiles = $state(true);
  let removing = $state(false);
  let fileInput = $state(null);

  const filters = [
    { id: "all", label: "All books" },
    { id: "reading", label: "Reading" },
    { id: "unread", label: "Unread" },
    { id: "finished", label: "Finished" },
  ];

  const list = $derived.by(() => {
    let books = [...app.books];
    if (filter === "reading") books = books.filter((b) => b.status === "reading");
    else if (filter === "unread") books = books.filter((b) => b.status === "unread");
    else if (filter === "finished") books = books.filter((b) => b.status === "finished");
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      books = books.filter(
        (b) => b.title.toLowerCase().includes(q) || (b.author || "").toLowerCase().includes(q),
      );
    }
    return books;
  });

  const stats = $derived([
    { label: "Books", value: String(app.books.length), icon: "book" },
    { label: "In progress", value: String(app.books.filter((b) => b.status === "reading").length), icon: "book-open" },
    { label: "Notes", value: String(app.notes.length), icon: "note" },
    { label: "Study time", value: formatDuration(app.stats?.studySeconds || 0), icon: "clock" },
  ]);

  const goalMinutes = $derived(Math.max(5, Number(app.settings?.study?.dailyGoalMinutes) || 30));
  const todaySeconds = $derived(Number(app.stats?.studyTodaySeconds) || 0);
  const goalPercent = $derived(Math.min(100, Math.round((todaySeconds / 60 / goalMinutes) * 100)));
  const goalReached = $derived(todaySeconds >= goalMinutes * 60);

  $effect(() => {
    refreshStats();
  });

  async function importBooks(files) {
    const arr = [...files].filter((f) => /\.(pdf|epub)$/i.test(f.name));
    if (!arr.length) {
      toast("warning", "Choose PDF or EPUB files to add to the library.");
      return;
    }
    importing = true;
    try {
      const res = await bookApi.import(arr);
      await refreshBooks();
      refreshStats();
      toast("success", `Imported ${pluralize(res.books.length, "book")}.`);
      if (res.books.length === 1) navigate(`/study/${res.books[0].id}`);
    } catch (err) {
      reportError(err, "The book could not be imported");
    } finally {
      importing = false;
      if (fileInput) fileInput.value = "";
    }
  }

  function onDrop(event) {
    event.preventDefault();
    dropActive = false;
    if (event.dataTransfer?.files?.length) importBooks(event.dataTransfer.files);
  }

  function askRemove(book) {
    removeTarget = book;
    deleteFiles = true;
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    removing = true;
    try {
      await bookApi.remove(removeTarget.id, deleteFiles);
      removeTarget = null;
      await refreshBooks();
      refreshStats();
      toast("success", deleteFiles ? "Book and its files were deleted." : "Book removed from the library.");
    } catch (err) {
      reportError(err, "Could not remove the book");
    } finally {
      removing = false;
    }
  }

  function progressLabel(book) {
    const pct = Math.round((book.progress || 0) * 100);
    if (book.status === "finished") return "Finished";
    if (book.format === "pdf") return `Page ${book.lastPage || 1} · ${pct}%`;
    return `${pct}% read`;
  }

  const totalBytes = $derived(app.books.reduce((sum, b) => sum + (b.metadata?.size || 0), 0));
</script>

<div class="content-inner stack stack-5">
  <header class="row row-between wrap" style="gap: 12px; padding-top: 4px">
    <div class="stack stack-1">
      <h1 class="page-title">Study</h1>
      <p class="muted" style="font-size: 12px">
        Your local library of PDF and EPUB books, with notes, bookmarks and reading progress.
      </p>
    </div>
    <div class="row row-2">
      <button class="btn btn-secondary btn-sm" onclick={() => navigate("/study/notes")}>
        <Icon name="note" size={12} /> All notes
      </button>
      <button class="btn btn-primary btn-sm" onclick={() => fileInput?.click()} disabled={importing}>
        {#if importing}
          <Icon name="loader" size={12} class="spin" /> Importing…
        {:else}
          <Icon name="plus" size={12} /> Add books
        {/if}
      </button>
      <input
        bind:this={fileInput}
        class="hidden-input"
        type="file"
        accept=".pdf,.epub,application/pdf,application/epub+zip"
        multiple
        onchange={(e) => importBooks(e.currentTarget.files)}
      />
    </div>
  </header>

  <section class="study-stats">
    {#each stats as stat}
      <div class="study-stat">
        <span class="stat-icon"><Icon name={stat.icon} size={14} /></span>
        <div class="stack stack-1">
          <span class="stat-value">{stat.value}</span>
          <span class="stat-label">{stat.label}</span>
        </div>
      </div>
    {/each}
  </section>

  <section class="goal-card" aria-label="Daily study goal">
    <div class="goal-head">
      <span class="goal-title"><Icon name="clock" size={12} /> Daily goal</span>
      <span class="goal-value" class:reached={goalReached}>
        {formatDuration(todaySeconds)} / {goalMinutes} min
      </span>
    </div>
    <div
      class="goal-bar"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax={goalMinutes * 60}
      aria-valuenow={Math.min(todaySeconds, goalMinutes * 60)}
      aria-label="Study time toward today's goal"
    >
      <span class="goal-fill" class:reached={goalReached} style={`width: ${goalPercent}%`}></span>
    </div>
    <p class="goal-note">
      {#if goalReached}
        Goal reached for today — anything more is a bonus.
      {:else}
        {Math.max(1, goalMinutes - Math.floor(todaySeconds / 60))} min to go today · change the goal in Settings, under Study.
      {/if}
    </p>
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
    <span>Drop PDF or EPUB files here to add them to your library</span>
    <span class="drop-hint">Files are copied locally; nothing leaves this device.</span>
  </section>

  <div class="library-bar">
    <div class="tabs" role="tablist" aria-label="Filter books">
      {#each filters as f}
        <button class="tab" role="tab" aria-selected={filter === f.id} onclick={() => (filter = f.id)}>
          {f.label}
        </button>
      {/each}
    </div>
    <div class="row row-2">
      <div class="search-box">
        <Icon name="search" size={13} />
        <input bind:value={query} placeholder="Search title or author…" aria-label="Search books" />
        {#if query}
          <button class="clear-btn" onclick={() => (query = "")} aria-label="Clear search">
            <Icon name="x" size={11} />
          </button>
        {/if}
      </div>
      <div class="tabs" role="tablist" aria-label="View mode">
        <button class="tab" role="tab" aria-selected={view === "grid"} onclick={() => (view = "grid")} title="Grid view">
          <Icon name="grid-view" size={12} />
        </button>
        <button class="tab" role="tab" aria-selected={view === "list"} onclick={() => (view = "list")} title="List view">
          <Icon name="list-view" size={12} />
        </button>
      </div>
    </div>
  </div>

  {#if !app.books.length}
    <div class="pane">
      <EmptyState
        title="Your study library is empty"
        message="Add a PDF or EPUB you already own. OmniGet extracts the book locally, remembers your page and keeps your notes beside the text."
        actionLabel="Choose files"
        onAction={() => fileInput?.click()}
        secondaryLabel="Browse tools"
        onSecondary={() => navigate("/tools")}
      />
    </div>
  {:else if !list.length}
    <div class="pane">
      <EmptyState
        icon="search"
        title={query ? `No books match “${query}”` : "No books in this filter"}
        message="Try a different search or filter."
        actionLabel="Reset"
        onAction={() => {
          query = "";
          filter = "all";
        }}
      />
    </div>
  {:else if view === "grid"}
    <div class="book-grid">
      {#each list as book (book.id)}
        <article class="book-card">
          <button class="book-open" onclick={() => navigate(`/study/${book.id}`)} aria-label={`Open ${book.title}`}>
            <span class="book-cover">
              {#if book.coverPath}
                <img src={`/api/books/${book.id}/cover`} alt="" loading="lazy" />
              {:else}
                <span class="cover-fallback">
                  <Icon name={book.format === "pdf" ? "file-pdf" : "book-open"} size={22} />
                  <span class="cover-title">{book.title}</span>
                  <span class="cover-author">{book.author || "Unknown author"}</span>
                </span>
              {/if}
              <span class="format-badge">{book.format.toUpperCase()}</span>
            </span>
          </button>

          <div class="book-body">
            <div class="book-heading">
              <button class="book-title" onclick={() => navigate(`/study/${book.id}`)} title={book.title}>
                {book.title}
              </button>
              <button class="btn btn-ghost btn-icon btn-sm" onclick={() => askRemove(book)} title="Remove book">
                <Icon name="more-horizontal" size={13} />
              </button>
            </div>
            <p class="book-author">{book.author || "Unknown author"}</p>

            {#if book.format === "epub"}
              <p class="book-meta">{pluralize(book.chapterCount || 0, "chapter")}</p>
            {:else}
              <p class="book-meta">{formatBytes(book.metadata?.size || 0)}</p>
            {/if}

            <div class="book-progress">
              <div class="progress" style="height: 4px">
                <div
                  class="progress-fill"
                  class:is-complete={book.status === "finished"}
                  style="width: {Math.round((book.progress || 0) * 100)}%"
                ></div>
              </div>
              <span class="book-progress-label">{progressLabel(book)}</span>
            </div>

            <div class="row row-between book-foot">
              <span class="faint" style="font-size: 9.5px">
                {book.openedAt ? `Opened ${formatRelative(book.openedAt)}` : `Added ${formatRelative(book.addedAt)}`}
              </span>
              <button class="btn btn-ghost btn-sm" onclick={() => navigate(`/study/${book.id}`)}>
                {book.status === "unread" ? "Start" : "Continue"} <Icon name="chevron-right" size={11} />
              </button>
            </div>
          </div>
        </article>
      {/each}
    </div>
  {:else}
    <div class="pane list-pane">
      {#each list as book (book.id)}
        <button class="book-row" onclick={() => navigate(`/study/${book.id}`)}>
          <span class="row-cover">
            {#if book.coverPath}
              <img src={`/api/books/${book.id}/cover`} alt="" loading="lazy" />
            {:else}
              <Icon name={book.format === "pdf" ? "file-pdf" : "book-open"} size={16} />
            {/if}
          </span>
          <span class="row-main">
            <span class="row-title">{book.title}</span>
            <span class="row-sub">{book.author || "Unknown author"}</span>
          </span>
          <span class="row-meta">
            <span class="badge badge-outline">{book.format.toUpperCase()}</span>
            <span class="row-progress">{progressLabel(book)}</span>
          </span>
          <span class="row-bar">
            <span style="width: {Math.round((book.progress || 0) * 100)}%"></span>
          </span>
          <Icon name="chevron-right" size={13} class="faint" />
        </button>
      {/each}
    </div>
    <p class="list-foot">{list.length} books · {formatBytes(totalBytes)} of book files on this device</p>
  {/if}

  {#if app.notes.length}
    <section class="stack stack-3">
      <div class="row row-between">
        <h2 class="section-title">Recent notes</h2>
        <button class="btn btn-ghost btn-sm" onclick={() => navigate("/study/notes")}>
          All notes <Icon name="chevron-right" size={12} />
        </button>
      </div>
      <div class="pane notes-strip">
        {#each app.notes.slice(0, 4) as note (note.id)}
          <button
            class="note-chip"
            onclick={() => {
              if (note.targetType === "book") navigate(`/study/${note.targetId}`);
              else if (note.targetType === "media") navigate(`/media/${note.targetId}`);
            }}
          >
            <Icon name={note.targetType === "book" ? "book" : "play"} size={12} />
            <span class="note-chip-body">{note.body}</span>
            <span class="faint note-chip-time">{formatRelative(note.createdAt)}</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}
</div>

<Modal open={!!removeTarget} title="Remove book?" subtitle={removeTarget?.title || ""} onClose={() => (removeTarget = null)}>
  <div class="stack stack-4">
    <p style="font-size: 12px; line-height: 1.6; color: var(--tertiary)">
      The book and its reading progress will be removed from OmniGet.
      {deleteFiles ? "The copied book files will be deleted from disk." : "The files on disk will be kept."}
    </p>
    <label class="checkbox">
      <input type="checkbox" bind:checked={deleteFiles} />
      Delete the book files from disk
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
  .hidden-input {
    display: none;
  }

  .study-stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .study-stat {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    background: var(--pane);
    border: 1px solid var(--content-border);
  }
  .stat-icon {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    display: grid;
    place-content: center;
    background: var(--blue-soft);
    color: var(--blue);
    flex: 0 0 auto;
  }
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

  .goal-card {
    display: grid;
    gap: 6px;
    padding: 11px 14px 10px;
    border-radius: var(--radius-lg);
    background: var(--pane);
    border: 1px solid var(--content-border);
  }
  .goal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .goal-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--tertiary);
  }
  .goal-value {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--secondary);
  }
  .goal-value.reached {
    color: var(--success);
    font-weight: 600;
  }
  .goal-bar {
    height: 4px;
    border-radius: 99px;
    background: var(--content-border);
    overflow: hidden;
  }
  .goal-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.35s ease;
  }
  .goal-fill.reached {
    background: var(--success);
  }
  .goal-note {
    font-size: 10px;
    color: var(--tertiary);
    line-height: 1.4;
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
    transition: all var(--duration-fast) var(--ease-out);
  }
  .drop-zone :global(svg) {
    color: var(--quaternary);
  }
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
    width: 210px;
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

  .book-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
    gap: var(--space-4);
  }
  .book-card {
    display: flex;
    flex-direction: column;
    background: var(--pane);
    border: 1px solid var(--content-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    transition:
      transform var(--duration-base) var(--ease-out),
      box-shadow var(--duration-base) var(--ease-out);
  }
  .book-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--elev-2);
  }
  .book-open {
    display: block;
    width: 100%;
    text-align: left;
  }
  .book-cover {
    display: block;
    position: relative;
    aspect-ratio: 3 / 4;
    background: linear-gradient(145deg, #e6e2d8, #d8d3c6);
    overflow: hidden;
  }
  .book-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .cover-fallback {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 14px;
    text-align: center;
    color: #6b6255;
    background:
      repeating-linear-gradient(90deg, transparent 0 22px, rgba(255, 255, 255, 0.24) 22px 23px),
      linear-gradient(150deg, #f2ede2, #ddd6c7);
  }
  .cover-title {
    font-family: var(--font-display);
    font-size: 12.5px;
    font-weight: 640;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    letter-spacing: -0.01em;
  }
  .cover-author {
    font-size: 9.5px;
    color: #8a8172;
  }
  .format-badge {
    position: absolute;
    top: 7px;
    right: 7px;
    padding: 2px 5px;
    border-radius: 4px;
    background: rgba(20, 16, 8, 0.62);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 8.5px;
    letter-spacing: 0.03em;
    backdrop-filter: blur(4px);
  }

  .book-body {
    padding: 10px 11px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  .book-heading {
    display: flex;
    align-items: flex-start;
    gap: 2px;
  }
  .book-title {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.35;
    letter-spacing: -0.005em;
    text-align: left;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .book-title:hover {
    color: var(--accent-text);
  }
  .book-author {
    font-size: 10px;
    color: var(--tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .book-meta {
    font-size: 9.5px;
    color: var(--quaternary);
  }

  .book-progress {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 7px;
  }
  .book-progress-label {
    font-size: 9.5px;
    color: var(--quaternary);
    font-family: var(--font-mono);
  }
  .book-foot {
    margin-top: 4px;
  }

  .list-pane {
    overflow: hidden;
  }
  .book-row {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    padding: 10px 12px;
    border-bottom: 1px solid var(--content-border);
    text-align: left;
    position: relative;
  }
  .book-row:last-child {
    border-bottom: 0;
  }
  .book-row:hover {
    background: var(--surface-hi);
  }
  .row-cover {
    width: 32px;
    height: 42px;
    border-radius: 5px;
    overflow: hidden;
    display: grid;
    place-content: center;
    background: var(--surface-sunken);
    color: var(--tertiary);
    flex: 0 0 auto;
  }
  .row-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
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
  .row-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }
  .row-progress {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--tertiary);
    min-width: 78px;
    text-align: right;
  }
  .row-bar {
    width: 70px;
    height: 3px;
    border-radius: 99px;
    background: var(--surface-sunken);
    overflow: hidden;
    flex: 0 0 auto;
  }
  .row-bar span {
    display: block;
    height: 100%;
    background: var(--blue);
  }
  .list-foot {
    text-align: center;
    font-size: 10.5px;
    color: var(--quaternary);
  }

  .notes-strip {
    overflow: hidden;
  }
  .note-chip {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 9px 12px;
    border-bottom: 1px solid var(--content-border);
    text-align: left;
    font-size: 11.5px;
  }
  .note-chip:last-child {
    border-bottom: 0;
  }
  .note-chip:hover {
    background: var(--surface-hi);
  }
  .note-chip :global(svg) {
    color: var(--quaternary);
    flex: 0 0 auto;
  }
  .note-chip-body {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--secondary);
  }
  .note-chip-time {
    font-size: 9.5px;
    flex: 0 0 auto;
  }

  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 1000px) {
    .study-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .search-box { width: 100%; }
    .drop-hint { display: none; }
    .row-progress { display: none; }
    .row-bar { display: none; }
  }
</style>
