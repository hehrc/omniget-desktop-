<script>
  import Icon from "./Icon.svelte";
  import { app, openPalette } from "../lib/state.svelte.js";
  import { navigate } from "../lib/router.js";

  let { route = "/", onMenu = () => {} } = $props();

  const pills = [
    { href: "/downloads", label: "Downloads", icon: "download" },
    { href: "/history", label: "History", icon: "history" },
    { href: "/tools", label: "Tools", icon: "grid" },
  ];

  function active(href) {
    if (href === "/downloads") return route === "/downloads";
    if (href === "/tools") return route === "/tools" || route.startsWith("/tools/");
    return route === href;
  }

  const activeDownloads = $derived(app.counts.downloading || 0);

  function newDownload() {
    navigate("/");
    setTimeout(() => {
      const input = document.querySelector("[data-url-input]");
      if (input) {
        input.focus();
        input.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 120);
  }
</script>

<header class="toolbar">
  <div class="toolbar-left">
    <button class="menu-btn" onclick={onMenu} aria-label="Open navigation">
      <Icon name="menu" size={17} />
    </button>

    <div class="pills" role="tablist" aria-label="Sections">
      {#each pills as pill}
        <button
          class="pill"
          class:active={active(pill.href)}
          role="tab"
          aria-selected={active(pill.href)}
          onclick={() => navigate(pill.href)}
        >
          <Icon name={pill.icon} size={13} />
          <span>{pill.label}</span>
          {#if pill.href === "/downloads" && activeDownloads > 0}
            <span class="pill-live">
              <span class="dot pulse"></span>
              {activeDownloads}
            </span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="toolbar-right">
    <button class="search-trigger" onclick={openPalette} aria-label="Search OmniGet">
      <Icon name="search" size={14} />
      <span class="search-text">Search downloads, books, tools…</span>
      <kbd>Ctrl K</kbd>
    </button>

    <button class="btn btn-primary btn-sm new-btn" onclick={newDownload}>
      <Icon name="plus" size={13} />
      <span class="new-label">New download</span>
    </button>
  </div>
</header>

<style>
  .toolbar {
    height: var(--toolbar-h);
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 0 var(--space-5);
    border-bottom: 1px solid var(--content-border);
    background: color-mix(in srgb, var(--primary) 86%, transparent);
    backdrop-filter: blur(12px);
    z-index: 40;
    user-select: none;
  }

  .toolbar-left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .menu-btn {
    display: none;
    width: 30px;
    height: 30px;
    place-content: center;
    border-radius: 7px;
    color: var(--secondary);
  }
  .menu-btn:hover {
    background: var(--sidebar-highlight);
  }

  .pills {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .pill {
    height: 27px;
    padding: 0 11px;
    border-radius: var(--radius-full);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-weight: 550;
    color: var(--tertiary);
    transition:
      background var(--duration-fast) var(--ease-out),
      color var(--duration-fast) var(--ease-out);
    white-space: nowrap;
  }
  .pill :global(svg) {
    opacity: 0.8;
  }
  .pill:hover {
    background: var(--sidebar-highlight);
    color: var(--secondary);
  }
  .pill.active {
    background: var(--surface);
    color: var(--secondary);
    box-shadow: var(--elev-1);
    font-weight: 600;
  }
  .pill-live {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 2px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--accent-text);
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 0 1 auto;
    min-width: 0;
  }

  .search-trigger {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    width: 258px;
    max-width: 32vw;
    padding: 0 8px 0 9px;
    border-radius: 7px;
    background: var(--surface);
    border: 1px solid var(--input-border);
    color: var(--quaternary);
    font-size: 11.5px;
    transition:
      border-color var(--duration-fast) var(--ease-out),
      box-shadow var(--duration-fast) var(--ease-out);
  }
  .search-trigger:hover {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--input-border));
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .search-text {
    flex: 1;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .search-trigger kbd {
    font-size: 9px;
    padding: 1px 4px;
    flex: 0 0 auto;
  }

  .new-btn {
    flex: 0 0 auto;
  }

  @media (max-width: 900px) {
    .search-trigger {
      width: 34px;
      justify-content: center;
      padding: 0;
    }
    .search-text,
    .search-trigger kbd {
      display: none;
    }
  }

  @media (max-width: 760px) {
    .toolbar {
      padding: 0 var(--space-3);
      gap: var(--space-2);
    }
    .menu-btn {
      display: grid;
    }
    .pill span:not(.pill-live) {
      display: none;
    }
    .pill {
      padding: 0 9px;
    }
    .new-label {
      display: none;
    }
  }
</style>
