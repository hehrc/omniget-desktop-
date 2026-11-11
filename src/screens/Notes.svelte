<script>
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Modal from "../components/Modal.svelte";
  import { app, refreshNotes, reportError, toast } from "../lib/state.svelte.js";
  import { notesApi } from "../lib/api.js";
  import { formatDate, formatDuration, formatRelative, pluralize } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let filter = $state("all");
  let query = $state("");
  let editing = $state(null);
  let editBody = $state("");
  let savingEdit = $state(false);
  let editError = $state(null);
  let deleting = $state(null);
  let removing = $state(false);

  const booksById = $derived(new Map(app.books.map((book) => [book.id, book])));
  const mediaById = $derived(new Map(app.media.map((item) => [item.id, item])));

  const counts = $derived({
    all: app.notes.length,
    book: app.notes.filter((n) => n.targetType === "book").length,
    media: app.notes.filter((n) => n.targetType === "media").length,
    download: app.notes.filter((n) => n.targetType === "download").length,
  });

  const list = $derived.by(() => {
    let notes = [...app.notes];
    if (filter !== "all") notes = notes.filter((n) => n.targetType === filter);
    const q = query.trim().toLowerCase();
    if (q) {
      notes = notes.filter(
        (n) =>
          n.body.toLowerCase().includes(q) ||
          sourceTitle(n).toLowerCase().includes(q) ||
          locationLabel(n).toLowerCase().includes(q),
      );
    }
    return notes.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  });

  function sourceTitle(note) {
    if (note.targetType === "book") return booksById.get(note.targetId)?.title || "Removed book";
    if (note.targetType === "media") return mediaById.get(note.targetId)?.title || "Removed media";
    const download = app.downloads.find((d) => d.id === note.targetId);
    return download?.title || download?.filename || "Download";
  }

  function sourceKind(note) {
    if (note.targetType === "book") return "Book";
    if (note.targetType === "media") return "Media";
    return "Download";
  }

  function sourceIcon(note) {
    if (note.targetType === "book") return "book-open";
    if (note.targetType === "media") return "play-circle";
    return "download";
  }

  function locationLabel(note) {
    if (note.page) return `Page ${note.page}`;
    if (note.timeSeconds !== null && note.timeSeconds !== undefined) {
      return formatDuration(note.timeSeconds);
    }
    if (note.chapter !== null && note.chapter !== undefined) return `Chapter ${note.chapter + 1}`;
    return "Whole item";
  }

  function openSource(note) {
    if (note.targetType === "book") {
      navigate(`/study/${note.targetId}`);
    } else if (note.targetType === "media") {
      navigate(`/media/${note.targetId}`);
    } else {
      navigate("/downloads");
    }
  }

  function beginEdit(note) {
    editing = note;
    editBody = note.body;
    editError = null;
  }

  async function saveEdit() {
    const body = editBody.trim();
    if (!body || !editing) return;
    savingEdit = true;
    editError = null;
    try {
      await notesApi.update(editing.id, body);
      await refreshNotes();
      toast("success", "Note updated.");
      editing = null;
    } catch (err) {
      editError = err?.message || "The note could not be saved.";
    } finally {
      savingEdit = false;
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    removing = true;
    try {
      await notesApi.remove(deleting.id);
      await refreshNotes();
      toast("success", "Note deleted.");
      deleting = null;
    } catch (err) {
      reportError(err, "The note could not be deleted");
    } finally {
      removing = false;
    }
  }

  const filters = $derived([
    { id: "all", label: "All notes", count: counts.all },
    { id: "book", label: "Books", count: counts.book },
    { id: "media", label: "Media", count: counts.media },
    ...(counts.download ? [{ id: "download", label: "Downloads", count: counts.download }] : []),
  ]);
</script>

<div class="content-inner stack stack-5">
  <header class="row row-between wrap" style="gap: 12px; padding-top: 4px">
    <div class="stack stack-1">
      <div class="row row-2" style="gap: 7px">
        <button class="btn btn-ghost btn-icon btn-sm" onclick={() => navigate("/study")} title="Back to library" aria-label="Back to library">
          <Icon name="arrow-left" size={15} />
        </button>
        <h1 class="page-title">Notes</h1>
      </div>
      <p class="muted" style="font-size: 12px; margin-left: 33px">
        Every annotation from your books and media, newest first.
      </p>
    </div>
    <button class="btn btn-secondary btn-sm" onclick={() => navigate("/study")}>
      <Icon name="book-open" size={12} /> Study library
    </button>
  </header>

  <div class="notes-bar">
    <div class="tabs" role="tablist" aria-label="Filter notes">
      {#each filters as f}
        <button class="tab" role="tab" aria-selected={filter === f.id} onclick={() => (filter = f.id)}>
          {f.label}
          <span class="tab-count">{f.count}</span>
        </button>
      {/each}
    </div>
    <div class="search-box">
      <Icon name="search" size={13} />
      <input bind:value={query} placeholder="Search notes and sources…" aria-label="Search notes" />
      {#if query}
        <button class="clear-btn" onclick={() => (query = "")} aria-label="Clear search">
          <Icon name="x" size={11} />
        </button>
      {/if}
    </div>
  </div>

  {#if !app.notes.length}
    <div class="pane">
      <EmptyState
        icon="note"
        title="No notes yet"
        message="Select text in a book or pause a video and write a note. Everything you save appears here with a link back to the exact page or timestamp."
        actionLabel="Open the library"
        onAction={() => navigate("/study")}
        secondaryLabel="Open media"
        onSecondary={() => navigate("/media")}
      />
    </div>
  {:else if !list.length}
    <div class="pane">
      <EmptyState
        icon="search"
        compact
        title={query ? `No notes match “${query}”` : "No notes in this filter"}
        message="Try a different search or show every type of note."
        actionLabel="Reset filters"
        onAction={() => {
          query = "";
          filter = "all";
        }}
      />
    </div>
  {:else}
    <div class="note-list">
      {#each list as note (note.id)}
        <article class="note-card">
          <div class="note-rail">
            <span class="source-icon" class:media={note.targetType === "media"} class:download={note.targetType === "download"}>
              <Icon name={sourceIcon(note)} size={14} />
            </span>
          </div>
          <div class="note-main">
            <div class="note-head">
              <button class="source-title" onclick={() => openSource(note)} title={`Open ${sourceTitle(note)}`}>
                {sourceTitle(note)}
              </button>
              <span class="note-loc">
                <span class="badge badge-outline">{sourceKind(note)}</span>
                <span class="mono">{locationLabel(note)}</span>
              </span>
            </div>
            <p class="note-body">{note.body}</p>
            <div class="note-foot">
              <span class="note-date" title={formatDate(note.createdAt, { withTime: true })}>
                <Icon name="clock" size={10} />
                {formatRelative(note.updatedAt || note.createdAt)}
                {#if note.updatedAt && note.updatedAt !== note.createdAt}· edited{/if}
              </span>
              <div class="note-actions">
                <button class="btn btn-ghost btn-sm" onclick={() => openSource(note)}>
                  <Icon name="arrow-up-right" size={11} /> Open source
                </button>
                <button class="btn btn-ghost btn-sm" onclick={() => beginEdit(note)}>
                  <Icon name="edit" size={11} /> Edit
                </button>
                <button class="btn btn-ghost btn-icon btn-sm" onclick={() => (deleting = note)} title="Delete note" aria-label="Delete note">
                  <Icon name="trash" size={12} />
                </button>
              </div>
            </div>
          </div>
        </article>
      {/each}
    </div>
    <p class="list-foot">
      {pluralize(list.length, "note")} shown · {pluralize(app.notes.length, "note")} saved on this device
    </p>
  {/if}
</div>

<Modal
  open={!!editing}
  title="Edit note"
  subtitle={editing ? sourceTitle(editing) : ""}
  onClose={() => (editing = null)}
>
  <div class="stack stack-4">
    <div class="stack stack-1">
      <span class="field-label">Note</span>
      <textarea class="textarea" bind:value={editBody} aria-label="Note text" autofocus></textarea>
      {#if editing}
        <span class="field-hint">
          {locationLabel(editing)} · saved locally with the book or media item
        </span>
      {/if}
    </div>
    {#if editError}
      <div class="inline-error"><Icon name="alert-circle" size={12} /> {editError}</div>
    {/if}
    <div class="row row-end row-2">
      <button class="btn btn-secondary btn-sm" onclick={() => (editing = null)}>Cancel</button>
      <button class="btn btn-primary btn-sm" onclick={saveEdit} disabled={!editBody.trim() || savingEdit}>
        {#if savingEdit}<Icon name="loader" size={12} class="spin" />{:else}<Icon name="check" size={12} />{/if}
        Save note
      </button>
    </div>
  </div>
</Modal>

<Modal
  open={!!deleting}
  title="Delete this note?"
  subtitle={deleting ? sourceTitle(deleting) : ""}
  onClose={() => (deleting = null)}
>
  <div class="stack stack-4">
    <p class="delete-preview">{deleting?.body}</p>
    <p class="muted" style="font-size: 11px; line-height: 1.55">
      The book, media file and its other notes are not affected. This cannot be undone.
    </p>
    <div class="row row-end row-2">
      <button class="btn btn-secondary btn-sm" onclick={() => (deleting = null)}>Cancel</button>
      <button class="btn btn-danger btn-sm" onclick={confirmDelete} disabled={removing}>
        {#if removing}<Icon name="loader" size={12} class="spin" />{:else}<Icon name="trash" size={12} />{/if}
        Delete note
      </button>
    </div>
  </div>
</Modal>

<style>
  .notes-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .tab-count {
    font-family: var(--font-mono);
    font-size: 9px;
    margin-left: 5px;
    color: var(--quaternary);
  }
  .tab[aria-selected="true"] .tab-count {
    color: var(--accent-text);
    opacity: 0.75;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    width: 250px;
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

  .note-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .note-card {
    display: flex;
    gap: 12px;
    padding: 13px 14px;
    background: var(--pane);
    border: 1px solid var(--content-border);
    border-radius: var(--radius-lg);
    transition: border-color var(--duration-fast) var(--ease-out);
  }
  .note-card:hover {
    border-color: color-mix(in srgb, var(--accent) 28%, var(--content-border));
  }
  .note-rail {
    flex: 0 0 auto;
  }
  .source-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: grid;
    place-content: center;
    background: var(--blue-soft);
    color: var(--blue);
  }
  .source-icon.media {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .source-icon.download {
    background: var(--purple-soft);
    color: var(--purple);
  }

  .note-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .note-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .source-title {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 620;
    letter-spacing: -0.01em;
    text-align: left;
    min-width: 0;
  }
  .source-title:hover {
    color: var(--accent-text);
  }
  .note-loc {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 9.5px;
    color: var(--tertiary);
  }
  .note-body {
    font-size: 12px;
    line-height: 1.62;
    color: var(--secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .note-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding-top: 2px;
  }
  .note-date {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 9.5px;
    color: var(--quaternary);
  }
  .note-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .note-actions :global(.btn) {
    font-size: 10px;
  }

  .list-foot {
    text-align: center;
    font-size: 10.5px;
    color: var(--quaternary);
  }

  .delete-preview {
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--secondary);
    white-space: pre-wrap;
    word-break: break-word;
    padding: 9px 11px;
    border-radius: 7px;
    background: var(--surface-sunken);
    border: 1px solid var(--content-border);
    max-height: 160px;
    overflow-y: auto;
  }
  .inline-error {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 7px;
    background: var(--error-soft);
    color: var(--error);
    font-size: 11px;
    line-height: 1.45;
  }

  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 640px) {
    .search-box { width: 100%; }
    .note-actions :global(.btn span) { display: none; }
    .note-card { padding: 11px; }
  }
</style>
