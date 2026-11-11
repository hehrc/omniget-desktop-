<script>
  import Icon from "../components/Icon.svelte";
  import Logo from "../components/Logo.svelte";
  import Mascot from "../components/Mascot.svelte";
  import { app, reportError, toast } from "../lib/state.svelte.js";
  import { formatBytes, formatDate } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  const FEATURES = [
    {
      icon: "download",
      title: "Honest download engine",
      text: "Direct HTTP(S) and unencrypted HLS transfers with resumable ranges, a real queue, live progress and per-file logs. Page extraction appears only when yt-dlp is installed.",
    },
    {
      icon: "book-open",
      title: "Study library",
      text: "PDFs render with PDF.js and EPUBs are unpacked by the local service into sanitised chapters. Notes, bookmarks and reading positions persist in SQLite.",
    },
    {
      icon: "play-circle",
      title: "Local media player",
      text: "Custom video and audio controls, resume positions, SRT/VTT subtitles and timestamped notes. Playback uses the codecs your browser can actually decode.",
    },
    {
      icon: "wrench",
      title: "Document toolbox",
      text: "PDF, image, text, archive, QR and hash tools run on the local service. Tools that need missing binaries say so instead of pretending to work.",
    },
    {
      icon: "shield",
      title: "Local by default",
      text: "No accounts, telemetry or cloud storage. The database, downloads, library and tool outputs all live under the data folder on this device.",
    },
    {
      icon: "sliders",
      title: "Yours to tune",
      text: "Theme, accent, density, download concurrency, network access, playback defaults and reader typography are stored in the local database.",
    },
  ];

  const CAPABILITIES = [
    { key: "directHttp", label: "Direct HTTP(S) downloads" },
    { key: "hls", label: "Unencrypted HLS" },
    { key: "rangeRequests", label: "Resumable ranges" },
    { key: "proxy", label: "Proxy transport" },
    { key: "pageExtraction", label: "Page extraction (yt-dlp)" },
    { key: "mediaTranscode", label: "Media transcode (ffmpeg)" },
    { key: "dash", label: "DASH streams" },
    { key: "encryptedStreams", label: "DRM / encrypted streams" },
  ];

  const LIMITATIONS = [
    "This is a local web application served by Node.js, not a signed native desktop bundle. It runs in your browser against 127.0.0.1.",
    "Only direct URLs and unencrypted HLS are downloaded natively. DRM, paywalls, logins and access controls are never bypassed.",
    "Media conversion, extract-audio and page extraction depend on ffmpeg, ffprobe and yt-dlp being installed on the host.",
    "Playback support follows the browser: MKV, HEVC and AC-3 files may not decode even though they can be stored and downloaded.",
    "Remote thumbnails are not generated; the media grid uses local artwork or a typographic fallback.",
  ];

  const SHORTCUTS = [
    ["Ctrl / ⌘ + K", "Open the command palette"],
    ["Space", "Play or pause media"],
    ["J / L", "Seek backwards or forwards"],
    ["M", "Mute the player"],
    ["F", "Fullscreen"],
    ["N", "Toggle notes"],
    ["C", "Toggle subtitles"],
    ["Esc", "Close dialogs and overlays"],
  ];

  let copied = $state(false);

  const version = $derived(app.system?.version || "1.0.0");
  const runtime = $derived(app.system?.runtime || null);
  const tools = $derived(app.system?.tools || {});
  const capabilities = $derived(app.system?.capabilities || {});
  const systemPaths = $derived(app.system?.paths || {});
  const storage = $derived(app.system?.storage || null);

  function toolState(bin) {
    const info = tools[bin];
    if (!info) return { label: "Unknown", tone: "muted" };
    return info.available
      ? { label: info.version || "Installed", tone: "ok" }
      : { label: "Not installed", tone: "warn" };
  }

  async function copyDiagnostics() {
    const payload = {
      app: "OmniGet Desktop",
      version,
      runtime,
      tools,
      capabilities,
      paths: systemPaths,
      generatedAt: new Date().toISOString(),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      copied = true;
      setTimeout(() => (copied = false), 2500);
      toast("success", "Diagnostics copied to the clipboard.");
    } catch (err) {
      reportError(err, "The clipboard was blocked by the browser");
    }
  }
</script>

<div class="content-inner stack stack-6 about">
  <section class="about-hero">
    <div class="hero-art">
      <Mascot size={124} mood="happy" />
    </div>
    <div class="hero-copy">
      <div class="row row-2 wrap" style="gap: 7px">
        <Logo size={30} wordSize={21} />
        <span class="badge badge-outline mono">v{version}</span>
        <span class="badge badge-success">GPL-3.0</span>
      </div>
      <h1 class="about-title">A calm, local home for everything you download, read and watch.</h1>
      <p class="about-lead">
        OmniGet is a download manager, study library, media player and document toolbox that runs
        entirely on this machine. No accounts, no cloud sync, no invented progress bars.
      </p>
      <div class="row row-2 wrap" style="margin-top: 4px">
        <button class="btn btn-primary btn-sm" onclick={() => navigate("/")}>
          <Icon name="download" size={12} /> Add a download
        </button>
        <button class="btn btn-secondary btn-sm" onclick={() => navigate("/settings")}>
          <Icon name="sliders" size={12} /> Open settings
        </button>
        <button class="btn btn-ghost btn-sm" onclick={copyDiagnostics}>
          <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy diagnostics"}
        </button>
      </div>
    </div>
  </section>

  <section class="stack stack-3">
    <div class="row row-between">
      <h2 class="section-title">What is inside</h2>
      <span class="faint" style="font-size: 10px">Everything runs through the local service</span>
    </div>
    <div class="feature-grid">
      {#each FEATURES as feature}
        <article class="feature-card">
          <span class="feature-icon"><Icon name={feature.icon} size={16} /></span>
          <div class="stack stack-1">
            <h3 class="feature-title">{feature.title}</h3>
            <p class="feature-text">{feature.text}</p>
          </div>
        </article>
      {/each}
    </div>
  </section>

  <div class="about-columns">
    <section class="pane info-pane">
      <div class="pane-head">
        <p class="eyebrow">Environment</p>
        <button class="btn btn-ghost btn-icon btn-sm" onclick={copyDiagnostics} title="Copy diagnostics" aria-label="Copy diagnostics">
          <Icon name="copy" size={12} />
        </button>
      </div>
      <div class="info-body">
        {#if runtime}
          <div class="fact"><span>Node.js</span><span class="mono">{runtime.node}</span></div>
          <div class="fact"><span>Platform</span><span class="mono">{runtime.platform} · {runtime.arch}</span></div>
          <div class="fact"><span>Host</span><span class="mono">{runtime.host}</span></div>
          <div class="fact"><span>Process</span><span class="mono">PID {runtime.pid}</span></div>
        {:else}
          <p class="muted" style="font-size: 11px">Runtime information is unavailable.</p>
        {/if}
        <div class="fact"><span>Started</span><span class="mono">{app.system?.startedAt ? formatDate(app.system.startedAt, { withTime: true }) : "—"}</span></div>
        <div class="fact"><span>Data on disk</span><span class="mono">{storage ? formatBytes((storage.data || 0) + (storage.downloads || 0) + (storage.library || 0)) : "—"}</span></div>

        <div class="fact-group">
          <p class="eyebrow">Optional binaries</p>
          {#each [["ffmpeg", "Media conversion"], ["ffprobe", "Media metadata"], ["yt-dlp", "Page extraction"]] as [bin, purpose]}
            {@const state = toolState(bin)}
            <div class="fact">
              <span>{purpose} <span class="mono faint">({bin})</span></span>
              <span class="tool-state {state.tone}">{state.label}</span>
            </div>
          {/each}
        </div>

        <div class="fact-group">
          <p class="eyebrow">Capabilities</p>
          <div class="cap-grid">
            {#each CAPABILITIES as cap}
              {@const enabled = !!capabilities[cap.key]}
              <span class="cap" class:on={enabled}>
                <Icon name={enabled ? "check-circle" : "x"} size={11} />
                {cap.label}
              </span>
            {/each}
          </div>
        </div>
      </div>
    </section>

    <section class="pane info-pane">
      <div class="pane-head">
        <p class="eyebrow">Where things live</p>
      </div>
      <div class="info-body">
        <div class="path-fact">
          <span>Downloads</span>
          <span class="mono">{systemPaths.downloads || app.paths?.downloadsDir || "—"}</span>
        </div>
        <div class="path-fact">
          <span>Library</span>
          <span class="mono">{systemPaths.library || app.paths?.libraryDir || "—"}</span>
        </div>
        <div class="path-fact">
          <span>Data</span>
          <span class="mono">{systemPaths.data || app.paths?.dataDir || "—"}</span>
        </div>
        <div class="path-fact">
          <span>Database</span>
          <span class="mono">{systemPaths.database || app.paths?.settingsFile || "—"}</span>
        </div>

        <div class="fact-group">
          <p class="eyebrow">Privacy</p>
          <p class="privacy">
            OmniGet sends no telemetry and makes no background requests. The only outbound traffic
            is the download or tool run you start. The AI tool is optional and disabled until you
            configure an endpoint and key.
          </p>
        </div>

        <div class="fact-group">
          <p class="eyebrow">Keyboard</p>
          <div class="shortcut-grid">
            {#each SHORTCUTS as [keys, label]}
              <span><kbd>{keys}</kbd> {label}</span>
            {/each}
          </div>
        </div>
      </div>
    </section>
  </div>

  <section class="pane limits-pane">
    <div class="pane-head">
      <p class="eyebrow">Known limitations</p>
      <span class="badge badge-warning">{LIMITATIONS.length} honest notes</span>
    </div>
    <ul class="limit-list">
      {#each LIMITATIONS as limitation}
        <li>
          <Icon name="info" size={13} />
          <span>{limitation}</span>
        </li>
      {/each}
    </ul>
  </section>

  <section class="pane legal-pane">
    <div class="legal-mark">
      <Icon name="shield" size={18} />
    </div>
    <div class="stack stack-2 legal-copy">
      <h2 class="section-title">Source, licence and attribution</h2>
      <p>
        This build is an independent, local-first implementation inspired by the interface and
        scope of <strong>OmniGet</strong> by OpenSelena. The original project is free software
        released under the <strong>GNU General Public License v3.0</strong>; this application is
        distributed under the same licence and keeps the attribution in <span class="mono">NOTICE</span>.
      </p>
      <p>
        The mascot, logo, copy and code in this build are original work created for this
        implementation. No proprietary assets, DRM keys or access-control bypasses are included.
      </p>
      <div class="row row-2 wrap">
        <a class="btn btn-secondary btn-sm" href="https://github.com/OpenSelena/omniget" target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={12} /> Original project
        </a>
        <a class="btn btn-secondary btn-sm" href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={12} /> GPL-3.0 text
        </a>
        <a class="btn btn-secondary btn-sm" href="/api/health" target="_blank" rel="noopener noreferrer">
          <Icon name="activity" size={12} /> Service health
        </a>
      </div>
    </div>
  </section>

  <footer class="about-foot">
    <span>OmniGet Desktop · local build</span>
    <span class="dot">·</span>
    <span>Made for files you already own</span>
    <span class="dot">·</span>
    <span class="mono">GPL-3.0-or-later</span>
  </footer>
</div>

<style>
  .about {
    max-width: 1080px;
  }

  .about-hero {
    display: grid;
    grid-template-columns: 168px minmax(0, 1fr);
    gap: var(--space-5);
    align-items: center;
    padding: var(--space-5);
    border-radius: var(--radius-xl);
    background:
      radial-gradient(circle at 12% 20%, var(--accent-soft), transparent 48%),
      linear-gradient(140deg, var(--pane), color-mix(in srgb, var(--pane) 82%, var(--accent) 18%));
    border: 1px solid var(--content-border);
    overflow: hidden;
    position: relative;
  }
  .hero-art {
    display: grid;
    place-content: center;
    min-height: 150px;
  }
  .hero-copy {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .about-title {
    font-family: var(--font-display);
    font-size: clamp(20px, 3vw, 28px);
    font-weight: 650;
    letter-spacing: -0.025em;
    line-height: 1.15;
    max-width: 620px;
  }
  .about-lead {
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--tertiary);
    max-width: 640px;
  }

  .feature-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(276px, 1fr));
    gap: var(--space-3);
  }
  .feature-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 13px;
    border-radius: var(--radius-lg);
    background: var(--pane);
    border: 1px solid var(--content-border);
  }
  .feature-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: grid;
    place-content: center;
    background: var(--accent-soft);
    color: var(--accent-text);
    flex: 0 0 auto;
  }
  .feature-title {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 620;
    letter-spacing: -0.01em;
  }
  .feature-text {
    font-size: 10.5px;
    line-height: 1.55;
    color: var(--tertiary);
  }

  .about-columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
    align-items: start;
  }
  .info-pane {
    overflow: hidden;
  }
  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--content-border);
    min-height: 42px;
  }
  .info-body {
    padding: 11px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .fact {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 10.5px;
    color: var(--tertiary);
  }
  .fact .mono {
    color: var(--secondary);
    text-align: right;
    word-break: break-all;
  }
  .fact-group {
    margin-top: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--content-border);
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .fact-group .eyebrow {
    margin-bottom: 1px;
  }
  .tool-state {
    font-family: var(--font-mono);
    font-size: 9.5px;
    text-align: right;
  }
  .tool-state.ok {
    color: var(--success);
  }
  .tool-state.warn {
    color: var(--warning);
  }
  .tool-state.muted {
    color: var(--quaternary);
  }

  .cap-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .cap {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 7px;
    border-radius: 99px;
    font-size: 9.5px;
    background: var(--surface-sunken);
    color: var(--quaternary);
  }
  .cap.on {
    background: var(--success-soft);
    color: var(--success);
  }

  .path-fact {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-bottom: 7px;
    border-bottom: 1px dashed var(--content-border);
  }
  .path-fact > span:first-child {
    font-size: 9.5px;
    color: var(--quaternary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .path-fact .mono {
    font-size: 10px;
    color: var(--secondary);
    word-break: break-all;
    line-height: 1.45;
  }

  .privacy {
    font-size: 10.5px;
    line-height: 1.6;
    color: var(--tertiary);
  }

  .shortcut-grid {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 10px;
    color: var(--tertiary);
  }
  .shortcut-grid span {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .limits-pane {
    overflow: hidden;
  }
  .limit-list {
    display: flex;
    flex-direction: column;
  }
  .limit-list li {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--content-border);
    font-size: 11px;
    line-height: 1.55;
    color: var(--tertiary);
  }
  .limit-list li:last-child {
    border-bottom: 0;
  }
  .limit-list :global(svg) {
    flex: 0 0 auto;
    margin-top: 2px;
    color: var(--warning);
  }

  .legal-pane {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
    padding: var(--space-5);
  }
  .legal-mark {
    width: 42px;
    height: 42px;
    border-radius: 11px;
    display: grid;
    place-content: center;
    background: var(--accent-soft);
    color: var(--accent-text);
    flex: 0 0 auto;
  }
  .legal-copy {
    min-width: 0;
  }
  .legal-copy p {
    font-size: 11px;
    line-height: 1.65;
    color: var(--tertiary);
    max-width: 760px;
  }
  .legal-copy strong {
    color: var(--secondary);
    font-weight: 600;
  }

  .about-foot {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 7px;
    font-size: 9.5px;
    color: var(--quaternary);
    padding-bottom: var(--space-4);
  }
  .about-foot .dot {
    opacity: 0.5;
  }

  @media (max-width: 900px) {
    .about-columns {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 700px) {
    .about-hero {
      grid-template-columns: minmax(0, 1fr);
      text-align: left;
    }
    .hero-art {
      display: none;
    }
    .legal-pane {
      padding: var(--space-4);
    }
    .legal-mark {
      display: none;
    }
  }
</style>
