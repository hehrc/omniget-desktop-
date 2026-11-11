<script>
  import Icon from "./Icon.svelte";
  import Logo from "./Logo.svelte";
  import { app } from "../lib/state.svelte.js";
  import { formatBytes } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let { route = "/", mobileOpen = false, onNavigate = () => {} } = $props();

  const primary = [
    { href: "/", label: "Home", icon: "home" },
    { href: "/downloads", label: "Downloads", icon: "download", badge: "active" },
    { href: "/study", label: "Study", icon: "book" },
    { href: "/tools", label: "Tools", icon: "grid" },
  ];

  const secondary = [
    { href: "/media", label: "App", icon: "layers" },
    { href: "/settings", label: "Settings", icon: "settings" },
    { href: "/about", label: "About", icon: "info" },
  ];

  function isActive(href) {
    if (href === "/") return route === "/";
    if (href === "/downloads") return route.startsWith("/downloads") || route === "/history";
    return route === href || route.startsWith(href + "/");
  }

  function go(href) {
    navigate(href);
    onNavigate();
  }

  const activeCount = $derived(app.counts.active || 0);
  const saved = $derived(app.stats?.bytesSaved || app.counts.bytesSaved || 0);
  const itemsSaved = $derived(app.counts.completed || 0);
</script>

<aside class="sidebar" class:mobile-open={mobileOpen} aria-label="Main navigation">
  <div class="brand">
    <button class="brand-btn" onclick={() => go("/")} aria-label="OmniGet home">
      <Logo size={27} wordSize={16} />
    </button>
  </div>

  <nav class="nav">
    <p class="nav-label">Library</p>
    {#each primary as item}
      <button
        class="nav-item"
        class:active={isActive(item.href)}
        onclick={() => go(item.href)}
        aria-current={isActive(item.href) ? "page" : undefined}
      >
        <Icon name={item.icon} size={16} />
        <span class="nav-text">{item.label}</span>
        {#if item.badge === "active" && activeCount > 0}
          <span class="nav-count">{activeCount}</span>
        {/if}
      </button>
    {/each}

    <p class="nav-label second">Application</p>
    {#each secondary as item}
      <button
        class="nav-item"
        class:active={isActive(item.href)}
        onclick={() => go(item.href)}
        aria-current={isActive(item.href) ? "page" : undefined}
      >
        <Icon name={item.icon} size={16} />
        <span class="nav-text">{item.label}</span>
        {#if item.href === "/media" && app.media.length}
          <span class="nav-count">{app.media.length}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="sidebar-foot">
    <div class="storage">
      <div class="row row-between" style="margin-bottom: 6px">
        <span class="storage-label">
          <Icon name="hard-drive" size={13} />
          On this device
        </span>
        <span class="storage-value mono">{formatBytes(saved)}</span>
      </div>
      <div class="storage-bar">
        <span style="width: {Math.min(100, itemsSaved ? 34 + itemsSaved * 2 : 0)}%"></span>
      </div>
      <p class="storage-hint">
        {itemsSaved === 0 ? "No downloads yet" : `${itemsSaved} file${itemsSaved === 1 ? "" : "s"} downloaded`}
      </p>
    </div>
    <button class="account" onclick={() => go("/settings")}>
      <span class="account-avatar">OG</span>
      <span class="account-text">
        <span class="account-name">Local workspace</span>
        <span class="account-sub">
          {#if app.eventsConnected}
            <span class="dot" style="color: var(--success); width: 5px; height: 5px"></span>
            Engine online
          {:else}
            <span class="dot" style="color: var(--quaternary); width: 5px; height: 5px"></span>
            Reconnecting…
          {/if}
        </span>
      </span>
      <Icon name="chevron-right" size={13} class="faint" />
    </button>
  </div>
</aside>

{#if mobileOpen}
  <button class="scrim" aria-label="Close navigation" onclick={onNavigate}></button>
{/if}

<style>
  .sidebar {
    width: var(--sidebar-w);
    flex: 0 0 var(--sidebar-w);
    height: 100%;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--content-border);
    display: flex;
    flex-direction: column;
    padding: 0 10px 12px;
    gap: 4px;
    user-select: none;
    z-index: 60;
  }

  .brand {
    height: var(--toolbar-h);
    display: flex;
    align-items: center;
    padding: 0 6px;
    flex: 0 0 auto;
  }
  .brand-btn {
    border-radius: 8px;
    padding: 3px 4px;
    margin-left: -4px;
  }
  .brand-btn:hover {
    background: var(--sidebar-highlight);
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-top: 4px;
  }

  .nav-label {
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--quaternary);
    padding: 10px 8px 5px;
  }
  .nav-label.second {
    padding-top: 18px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 30px;
    padding: 0 8px;
    border-radius: 7px;
    color: var(--secondary);
    font-size: 12.5px;
    font-weight: 500;
    letter-spacing: -0.005em;
    text-align: left;
    transition:
      background var(--duration-fast) var(--ease-out),
      color var(--duration-fast) var(--ease-out);
    position: relative;
  }
  .nav-item :global(svg) {
    color: var(--tertiary);
    flex: 0 0 auto;
  }
  .nav-item:hover {
    background: var(--sidebar-highlight);
  }
  .nav-item.active {
    background: var(--sidebar-highlight);
    font-weight: 600;
  }
  .nav-item.active :global(svg) {
    color: var(--accent-text);
  }
  .nav-item.active::before {
    content: "";
    position: absolute;
    left: -10px;
    top: 7px;
    bottom: 7px;
    width: 2.5px;
    border-radius: 0 3px 3px 0;
    background: var(--accent);
  }
  .nav-text {
    flex: 1;
    min-width: 0;
  }
  .nav-count {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    padding: 1px 5px;
    border-radius: var(--radius-full);
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .sidebar-foot {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .storage {
    padding: 10px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--surface) 55%, transparent);
    border: 1px solid var(--content-border);
  }
  .storage-label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--tertiary);
  }
  .storage-value {
    font-size: 10px;
    color: var(--quaternary);
  }
  .storage-bar {
    height: 4px;
    border-radius: 99px;
    background: var(--surface-sunken);
    overflow: hidden;
  }
  .storage-bar span {
    display: block;
    height: 100%;
    border-radius: 99px;
    background: linear-gradient(90deg, var(--accent), #ffc061);
  }
  .storage-hint {
    margin-top: 6px;
    font-size: 10px;
    color: var(--quaternary);
  }

  .account {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 7px;
    border-radius: 9px;
    text-align: left;
    transition: background var(--duration-fast) var(--ease-out);
  }
  .account:hover {
    background: var(--sidebar-highlight);
  }
  .account-avatar {
    width: 27px;
    height: 27px;
    border-radius: 8px;
    display: grid;
    place-content: center;
    background: var(--surface);
    border: 1px solid var(--content-border);
    font-family: var(--font-display);
    font-size: 10.5px;
    font-weight: 700;
    color: var(--accent-text);
    flex: 0 0 auto;
  }
  .account-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
    gap: 1px;
  }
  .account-name {
    font-size: 11.5px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .account-sub {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 9.5px;
    color: var(--quaternary);
  }

  .scrim {
    display: none;
  }

  @media (max-width: 760px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      transform: translateX(-104%);
      transition: transform var(--duration-base) var(--ease-out);
      box-shadow: var(--elev-3);
      width: 264px;
      flex-basis: 264px;
    }
    .sidebar.mobile-open {
      transform: none;
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      background: var(--scrim);
      border: 0;
      z-index: 55;
    }
  }
</style>
