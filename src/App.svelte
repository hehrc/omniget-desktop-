<script>
  import Sidebar from "./components/Sidebar.svelte";
  import Toolbar from "./components/Toolbar.svelte";
  import Toasts from "./components/Toasts.svelte";
  import CommandPalette from "./components/CommandPalette.svelte";
  import Icon from "./components/Icon.svelte";
  import Logo from "./components/Logo.svelte";
  import Mascot from "./components/Mascot.svelte";

  import Home from "./screens/Home.svelte";
  import Downloads from "./screens/Downloads.svelte";
  import History from "./screens/History.svelte";
  import Study from "./screens/Study.svelte";
  import Reader from "./screens/Reader.svelte";
  import Notes from "./screens/Notes.svelte";
  import Media from "./screens/Media.svelte";
  import Player from "./screens/Player.svelte";
  import Tools from "./screens/Tools.svelte";
  import ToolDetail from "./screens/ToolDetail.svelte";
  import Settings from "./screens/Settings.svelte";
  import About from "./screens/About.svelte";

  import { app, boot, openPalette } from "./lib/state.svelte.js";
  import { currentRoute, initRouter, listen, matchBook, matchPlayer, matchTool, navigate } from "./lib/router.js";

  let route = $state("/");
  let drawerOpen = $state(false);
  let contentEl = $state(null);

  $effect(() => {
    initRouter();
    const off = listen((next) => {
      route = next;
      drawerOpen = false;
    });
    route = currentRoute();
    boot();
    return off;
  });

  $effect(() => {
    const r = route;
    if (!contentEl) return;
    contentEl.scrollTop = 0;
    void r;
  });

  $effect(() => {
    document.title = titleFor(route);
  });

  function titleFor(path) {
    if (path === "/") return "OmniGet";
    if (path.startsWith("/downloads")) return "Downloads · OmniGet";
    if (path.startsWith("/history")) return "History · OmniGet";
    if (path === "/study/notes") return "Notes · OmniGet";
    if (path.startsWith("/study/")) return "Reader · OmniGet";
    if (path === "/study") return "Study · OmniGet";
    if (path.startsWith("/media/")) return "Player · OmniGet";
    if (path === "/media") return "Media · OmniGet";
    if (path.startsWith("/tools/")) return "Tool · OmniGet";
    if (path === "/tools") return "Tools · OmniGet";
    if (path === "/settings") return "Settings · OmniGet";
    if (path === "/about") return "About · OmniGet";
    return "OmniGet";
  }

  function onKeydown(event) {
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
      return;
    }
    if (event.key === "Escape" && drawerOpen) {
      drawerOpen = false;
    }
  }

  const bookId = $derived(matchBook(route));
  const mediaId = $derived(matchPlayer(route));
  const toolId = $derived(matchTool(route));

  const mobileTabs = [
    { href: "/", label: "Home", icon: "home" },
    { href: "/downloads", label: "Downloads", icon: "download" },
    { href: "/study", label: "Study", icon: "book" },
    { href: "/tools", label: "Tools", icon: "grid" },
  ];

  function mobileActive(href) {
    if (href === "/") return route === "/";
    if (href === "/downloads") return route.startsWith("/downloads") || route === "/history";
    return route === href || route.startsWith(href + "/");
  }

  const unknownRoute = $derived(
    ![
      "/",
      "/downloads",
      "/history",
      "/study",
      "/media",
      "/tools",
      "/settings",
      "/about",
    ].includes(route) && !bookId && !mediaId && !toolId && route !== "/study/notes",
  );
</script>

<svelte:window onkeydown={onKeydown} />

{#if !app.ready && !app.bootError}
  <div class="boot">
    <div class="boot-inner">
      <Logo size={46} wordSize={24} />
      <Mascot size={112} mood="thinking" />
      <div class="boot-text">
        <p class="boot-title">Warming up the local engine</p>
        <p class="boot-sub">Connecting to your downloads, library and settings…</p>
      </div>
      <div class="boot-bar"><span></span></div>
    </div>
  </div>
{:else if app.bootError}
  <div class="boot">
    <div class="boot-inner boot-error">
      <Logo size={40} wordSize={21} />
      <span class="boot-error-icon"><Icon name="alert-triangle" size={26} /></span>
      <div class="boot-text">
        <p class="boot-title">The local service is not reachable</p>
        <p class="boot-sub">{app.bootError}</p>
      </div>
      <pre class="code boot-code">Start it with:  npm start
Then open:      http://127.0.0.1:4173</pre>
      <div class="row row-2">
        <button class="btn btn-primary btn-sm" onclick={() => window.location.reload()}>
          <Icon name="refresh" size={12} /> Try again
        </button>
        <button class="btn btn-secondary btn-sm" onclick={() => navigate("/about")}>About this build</button>
      </div>
    </div>
  </div>
{:else}
  <div class="app-shell">
    <Sidebar {route} mobileOpen={drawerOpen} onNavigate={() => (drawerOpen = false)} />

    <div class="main-column">
      <Toolbar {route} onMenu={() => (drawerOpen = true)} />

      <main class="content" id="main" bind:this={contentEl} tabindex="-1">
        {#if app.paths?.data && !app.settings?.download?.directory}
          <div class="banner">
            <Icon name="alert-triangle" size={14} />
            No download folder is configured. Choose one in Settings before downloading.
            <button class="btn btn-secondary btn-sm" onclick={() => navigate("/settings")}>Open settings</button>
          </div>
        {/if}

        {#if route === "/study/notes"}
          <Notes />
        {:else if bookId}
          <Reader id={bookId} />
        {:else if route === "/study"}
          <Study />
        {:else if mediaId}
          <Player id={mediaId} />
        {:else if route === "/media"}
          <Media />
        {:else if toolId}
          <ToolDetail id={toolId} />
        {:else if route === "/tools"}
          <Tools />
        {:else if route === "/downloads"}
          <Downloads />
        {:else if route === "/history"}
          <History />
        {:else if route === "/settings"}
          <Settings />
        {:else if route === "/about"}
          <About />
        {:else if route === "/" || unknownRoute}
          {#if unknownRoute}
            <div class="content-inner">
              <div class="pane unknown">
                <Mascot size={96} mood="thinking" />
                <h1 class="page-title">That page does not exist</h1>
                <p class="muted">The link “{route}” is not part of this build.</p>
                <button class="btn btn-primary btn-sm" onclick={() => navigate("/")}>Go home</button>
              </div>
            </div>
          {:else}
            <Home />
          {/if}
        {/if}
      </main>
    </div>

    <nav class="mobile-nav" aria-label="Mobile navigation">
      {#each mobileTabs as tab}
        <button
          class="mobile-tab"
          class:active={mobileActive(tab.href)}
          onclick={() => navigate(tab.href)}
          aria-current={mobileActive(tab.href) ? "page" : undefined}
        >
          <Icon name={tab.icon} size={19} />
          <span>{tab.label}</span>
          {#if tab.href === "/downloads" && app.counts.active > 0}
            <span class="mobile-badge">{app.counts.active}</span>
          {/if}
        </button>
      {/each}
      <button class="mobile-tab" onclick={() => (drawerOpen = true)}>
        <Icon name="menu" size={19} />
        <span>More</span>
      </button>
    </nav>
  </div>

  <Toasts />
  <CommandPalette />
{/if}

<style>
  .boot {
    height: 100%;
    display: grid;
    place-content: center;
    padding: var(--space-5);
    background: var(--primary);
  }
  .boot-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    text-align: center;
    max-width: 440px;
  }
  .boot-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .boot-title {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: 640;
    letter-spacing: -0.02em;
  }
  .boot-sub {
    font-size: var(--text-sm);
    color: var(--tertiary);
    line-height: 1.55;
  }
  .boot-bar {
    width: 180px;
    height: 4px;
    border-radius: 99px;
    background: var(--surface-sunken);
    overflow: hidden;
  }
  .boot-bar span {
    display: block;
    width: 40%;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    animation: indeterminate 1.3s var(--ease-in-out) infinite;
  }
  .boot-error {
    max-width: 500px;
  }
  .boot-error-icon {
    width: 58px;
    height: 58px;
    border-radius: 50%;
    display: grid;
    place-content: center;
    background: var(--error-soft);
    color: var(--error);
  }
  .boot-code {
    width: 100%;
    text-align: left;
    font-size: var(--text-xs);
    line-height: 1.8;
  }

  .banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    max-width: var(--content-max);
    margin: 0 auto var(--space-4);
    padding: 9px 12px;
    border-radius: var(--radius-md);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: var(--text-sm);
  }
  .banner :global(svg) {
    flex: 0 0 auto;
  }
  .banner :global(.btn) {
    margin-left: auto;
  }

  .unknown {
    max-width: 480px;
    margin: 8vh auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--space-3);
    padding: var(--space-7) var(--space-5);
  }

  .mobile-nav {
    display: none;
  }

  @keyframes indeterminate {
    0% { transform: translateX(-120%); }
    100% { transform: translateX(340%); }
  }

  @media (max-width: 760px) {
    .mobile-nav {
      display: flex;
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      height: 60px;
      padding-bottom: env(safe-area-inset-bottom, 0);
      background: color-mix(in srgb, var(--sidebar-bg) 94%, transparent);
      backdrop-filter: blur(12px);
      border-top: 1px solid var(--content-border);
      z-index: 50;
    }
    .mobile-tab {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      font-size: 9.5px;
      font-weight: 550;
      color: var(--quaternary);
      position: relative;
    }
    .mobile-tab.active {
      color: var(--accent-text);
    }
    .mobile-tab.active::before {
      content: "";
      position: absolute;
      top: 0;
      width: 22px;
      height: 2px;
      border-radius: 0 0 2px 2px;
      background: var(--accent);
    }
    .mobile-badge {
      position: absolute;
      top: 8px;
      right: calc(50% - 20px);
      min-width: 14px;
      height: 14px;
      padding: 0 3px;
      border-radius: 99px;
      background: var(--accent);
      color: var(--on-accent);
      font-family: var(--font-mono);
      font-size: 8.5px;
      display: grid;
      place-content: center;
    }
  }
</style>
