<script>
  import Icon from "./Icon.svelte";
  import { app, closePalette, refreshDownloads } from "../lib/state.svelte.js";
  import { navigate } from "../lib/router.js";
  import { formatBytes, formatDate } from "../lib/format.js";

  let query = $state("");
  let activeIndex = $state(0);
  let inputEl = $state(null);
  let listEl = $state(null);

  const navActions = [
    { id: "nav-home", label: "Go to Home", detail: "Paste a link and download", icon: "home", href: "/" },
    { id: "nav-downloads", label: "Go to Downloads", detail: "Queue, progress and files", icon: "download", href: "/downloads" },
    { id: "nav-history", label: "Go to History", detail: "Finished and failed downloads", icon: "history", href: "/history" },
    { id: "nav-study", label: "Go to Study", detail: "Books, notes and reading", icon: "book", href: "/study" },
    { id: "nav-notes", label: "Open all notes", detail: "Everything you wrote", icon: "note", href: "/study/notes" },
    { id: "nav-tools", label: "Go to Tools", detail: "PDF, text, image and media utilities", icon: "grid", href: "/tools" },
    { id: "nav-media", label: "Open media library", detail: "Player and audio", icon: "play", href: "/media" },
    { id: "nav-settings", label: "Open Settings", detail: "Downloads, theme, network, AI", icon: "settings", href: "/settings" },
    { id: "nav-about", label: "About OmniGet", detail: "Build info and limitations", icon: "info", href: "/about" },
  ];

  const tools = $derived(app.tools?.tools || []);
  const q = $derived(query.trim().toLowerCase());

  const toolResults = $derived(
    q
      ? tools
          .filter(
            (t) =>
              t.name.toLowerCase().includes(q) ||
              t.id.includes(q) ||
              (t.keywords || []).some((k) => k.includes(q)) ||
              t.category.includes(q),
          )
          .slice(0, 7)
          .map((t) => ({
            id: `tool-${t.id}`,
            label: t.name,
            detail: t.description,
            icon: "wrench",
            href: `/tools/${t.id}`,
            tag: t.available === false ? "Unavailable" : null,
          }))
      : [],
  );

  const downloadResults = $derived(
    q
      ? app.downloads
          .filter((d) => (d.title || d.filename || "").toLowerCase().includes(q) || d.url.toLowerCase().includes(q))
          .slice(0, 6)
          .map((d) => ({
            id: `dl-${d.id}`,
            label: d.title || d.filename || d.url,
            detail: `${d.status} · ${formatBytes(d.sizeBytes)} · ${formatDate(d.createdAt)}`,
            icon: "download",
            href: "/downloads",
          }))
      : [],
  );

  const bookResults = $derived(
    q
      ? app.books
          .filter(
            (b) =>
              b.title.toLowerCase().includes(q) ||
              (b.author || "").toLowerCase().includes(q),
          )
          .slice(0, 5)
          .map((b) => ({
            id: `book-${b.id}`,
            label: b.title,
            detail: `${b.author || "Unknown author"} · ${b.format.toUpperCase()}`,
            icon: "book-open",
            href: `/study/${b.id}`,
          }))
      : [],
  );

  const mediaResults = $derived(
    q
      ? app.media
          .filter((m) => m.title.toLowerCase().includes(q))
          .slice(0, 4)
          .map((m) => ({
            id: `media-${m.id}`,
            label: m.title,
            detail: m.kind === "audio" ? "Audio" : "Video",
            icon: m.kind === "audio" ? "music" : "video",
            href: `/media/${m.id}`,
          }))
      : [],
  );

  const navResults = $derived(
    navActions.filter(
      (a) => !q || a.label.toLowerCase().includes(q) || a.detail.toLowerCase().includes(q) || a.id.includes(q),
    ),
  );

  const groups = $derived(
    [
      { label: q ? "Tools" : "Quick actions", items: q ? toolResults : navResults.slice(0, 5) },
      ...(q
        ? [
            { label: "Downloads", items: downloadResults },
            { label: "Study library", items: bookResults },
            { label: "Media", items: mediaResults },
            { label: "Navigation", items: navResults.slice(0, 4) },
          ]
        : []),
    ].filter((g) => g.items.length),
  );

  const flat = $derived(groups.flatMap((g) => g.items));

  const indexedGroups = $derived.by(() => {
    let index = 0;
    return groups.map((group) => ({
      ...group,
      items: group.items.map((item) => ({ ...item, index: index++ })),
    }));
  });

  $effect(() => {
    if (app.paletteOpen) {
      query = "";
      activeIndex = 0;
      setTimeout(() => inputEl?.focus(), 40);
    }
  });

  $effect(() => {
    if (!app.paletteOpen) return;
    refreshDownloads().catch(() => {});
  });

  $effect(() => {
    activeIndex = Math.min(activeIndex, Math.max(0, flat.length - 1));
  });

  function choose(item) {
    if (!item) return;
    closePalette();
    navigate(item.href);
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = flat.length ? (activeIndex + 1) % flat.length : 0;
      scrollActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = flat.length ? (activeIndex - 1 + flat.length) % flat.length : 0;
      scrollActive();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(flat[activeIndex]);
    }
  }

  function scrollActive() {
    setTimeout(() => {
      listEl?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
    }, 0);
  }
</script>

{#if app.paletteOpen}
  <div
    class="palette-backdrop"
    role="presentation"
    onmousedown={(e) => {
      if (e.target === e.currentTarget) closePalette();
    }}
  >
    <div class="palette" role="dialog" aria-modal="true" aria-label="Search and jump">
      <div class="palette-input-wrap">
        <Icon name="search" size={16} class="palette-search-icon" />
        <input
          bind:this={inputEl}
          bind:value={query}
          class="palette-input"
          placeholder="Search downloads, books, tools…"
          aria-label="Search"
          onkeydown={onKeydown}
          autocomplete="off"
          spellcheck="false"
        />
        <kbd>Esc</kbd>
      </div>

      <div class="palette-list" bind:this={listEl}>
        {#if !flat.length}
          <div class="palette-empty">
            <Icon name="search" size={20} />
            <p>No results for “{query}”</p>
            <span class="faint">Try a tool name, a book title, or a download.</span>
          </div>
        {/if}
        {#each indexedGroups as group}
          <div class="palette-group">
            <p class="palette-group-label">{group.label}</p>
            {#each group.items as item (item.id)}
              <button
                class="palette-row"
                class:active={item.index === activeIndex}
                data-index={item.index}
                onmouseenter={() => (activeIndex = item.index)}
                onclick={() => choose(item)}
              >
                <span class="palette-row-icon"><Icon name={item.icon} size={15} /></span>
                <span class="palette-row-text">
                  <span class="palette-row-label">{item.label}</span>
                  {#if item.detail}<span class="palette-row-detail">{item.detail}</span>{/if}
                </span>
                {#if item.tag}<span class="badge badge-warning">{item.tag}</span>{/if}
                <Icon name="arrow-up-right" size={13} class="palette-go" />
              </button>
            {/each}
          </div>
        {/each}
      </div>

      <div class="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>Esc</kbd> close</span>
        <span class="palette-brand"><Icon name="sparkles" size={11} /> Local search</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    z-index: 280;
    background: var(--dialog-backdrop);
    backdrop-filter: blur(3px);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 12vh var(--space-4) var(--space-4);
    animation: fade-in var(--duration-fast) var(--ease-out);
  }
  .palette {
    width: 100%;
    max-width: 620px;
    background: var(--popup-bg);
    border: 1px solid var(--content-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--elev-3);
    overflow: hidden;
    animation: dialog-in var(--duration-base) var(--ease-spring);
    display: flex;
    flex-direction: column;
    max-height: 72vh;
  }
  .palette-input-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 var(--space-4);
    height: 52px;
    border-bottom: 1px solid var(--content-border);
    flex: 0 0 auto;
  }
  .palette-search-icon {
    color: var(--tertiary);
    flex: 0 0 auto;
  }
  .palette-input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: var(--text-md);
    height: 100%;
    color: var(--secondary);
    min-width: 0;
  }
  .palette-input::placeholder {
    color: var(--quaternary);
  }

  .palette-list {
    overflow-y: auto;
    padding: 6px;
    flex: 1;
    min-height: 0;
  }

  .palette-group-label {
    font-size: 9.5px;
    font-weight: 650;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--quaternary);
    padding: 10px 10px 4px;
  }

  .palette-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 8px;
    text-align: left;
    transition: background var(--duration-fast) var(--ease-out);
  }
  .palette-row.active {
    background: var(--accent-soft);
  }
  .palette-row-icon {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: grid;
    place-content: center;
    background: var(--surface-sunken);
    color: var(--tertiary);
    flex: 0 0 auto;
  }
  .palette-row.active .palette-row-icon {
    background: var(--surface);
    color: var(--accent-text);
  }
  .palette-row-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .palette-row-label {
    font-size: 12.5px;
    font-weight: 550;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .palette-row-detail {
    font-size: 10.5px;
    color: var(--tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .palette-go {
    color: var(--quaternary);
    opacity: 0;
    flex: 0 0 auto;
  }
  .palette-row.active .palette-go {
    opacity: 1;
  }

  .palette-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: var(--space-7) var(--space-4);
    color: var(--quaternary);
    text-align: center;
  }
  .palette-empty p {
    color: var(--secondary);
    font-weight: 600;
    font-size: var(--text-sm);
  }
  .palette-empty span {
    font-size: var(--text-xs);
  }

  .palette-foot {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 8px var(--space-4);
    border-top: 1px solid var(--content-border);
    background: var(--pane-alt);
    font-size: 10px;
    color: var(--quaternary);
  }
  .palette-foot kbd {
    margin-right: 2px;
  }
  .palette-brand {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
</style>
