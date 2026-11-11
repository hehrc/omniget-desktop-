<script>
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import {
    acceptSettings,
    app,
    applyAppearance,
    reportError,
    saveSettings,
    toast,
  } from "../lib/state.svelte.js";
  import { dataApi, fsApi, settingsApi } from "../lib/api.js";
  import { formatBytes, formatDate } from "../lib/format.js";

  const TABS = [
    { id: "appearance", label: "Appearance", icon: "palette", desc: "Theme, accent and density" },
    { id: "downloads", label: "Downloads", icon: "download", desc: "Folder, queue and naming" },
    { id: "network", label: "Network", icon: "wifi", desc: "Proxy, timeouts and access" },
    { id: "playback", label: "Playback", icon: "play-circle", desc: "Video and audio defaults" },
    { id: "reader", label: "Reader", icon: "book-open", desc: "Typography for books" },
    { id: "study", label: "Study", icon: "graduation", desc: "Goals and resume behaviour" },
    { id: "ai", label: "AI", icon: "sparkles", desc: "Optional assistant endpoint" },
    { id: "data", label: "Data", icon: "database", desc: "Backup, import and storage" },
  ];

  const ACCENTS = [
    { id: "orange", label: "Orange", color: "#FF9500" },
    { id: "blue", label: "Blue", color: "#0A84FF" },
    { id: "green", label: "Green", color: "#28A745" },
    { id: "purple", label: "Purple", color: "#8E5CF7" },
    { id: "pink", label: "Pink", color: "#E8478F" },
  ];

  const READER_THEMES = [
    { id: "paper", label: "Paper", color: "#f6f1e7" },
    { id: "light", label: "White", color: "#ffffff" },
    { id: "sepia", label: "Sepia", color: "#efe3c8" },
    { id: "dark", label: "Night", color: "#191817" },
  ];

  let tab = $state("appearance");
  let draft = $state(null);
  let savedJson = $state("");
  let saving = $state(false);
  let saveError = $state(null);
  let savedAt = $state(null);

  let browseOpen = $state(false);
  let browse = $state(null);
  let browseCurrent = $state("");
  let browseError = $state(null);
  let browseLoading = $state(false);
  let newFolderName = $state("");
  let creatingFolder = $state(false);

  let revealOpen = $state(false);
  let resetOpen = $state(false);
  let resetting = $state(false);
  let importInput = $state(null);
  let importing = $state(false);

  const clone = (value) => JSON.parse(JSON.stringify(value));

  let showKey = $state(false);
  let aiTesting = $state(false);
  let aiResult = $state(null);

  let dataSize = $state(null);
  let dataLoading = $state(false);
  let dataError = $state(null);

  $effect(() => {
    if (app.settings && !draft) {
      draft = clone(app.settings);
      savedJson = JSON.stringify(app.settings);
    }
  });

  // Live preview of appearance without persisting until Save.
  $effect(() => {
    if (!draft) return;
    const key = JSON.stringify(draft.appearance || {});
    applyAppearance(draft);
    void key;
  });

  const dirty = $derived(draft ? JSON.stringify(draft) !== savedJson : false);
  const activeTab = $derived(TABS.find((t) => t.id === tab) || TABS[0]);

  $effect(() => {
    if (tab === "data" && draft) loadDataSize();
  });

  function setTheme(theme) {
    draft.appearance.theme = theme;
  }

  function setAccent(accent) {
    draft.appearance.accent = accent;
  }

  function setDensity(density) {
    draft.appearance.density = density;
  }

  async function save() {
    if (!draft || saving) return;
    saving = true;
    saveError = null;
    try {
      const saved = await saveSettings(draft);
      draft = clone(saved);
      savedJson = JSON.stringify(saved);
      savedAt = Date.now();
      toast("success", "Settings saved.");
    } catch (err) {
      saveError = reportError(err, "Settings could not be saved");
    } finally {
      saving = false;
    }
  }

  function discard() {
    if (!app.settings) return;
    draft = clone(app.settings);
    savedJson = JSON.stringify(app.settings);
    saveError = null;
    applyAppearance(app.settings);
  }

  async function confirmReset() {
    resetting = true;
    try {
      const res = await settingsApi.reset();
      acceptSettings(res);
      draft = clone(res.settings);
      savedJson = JSON.stringify(res.settings);
      resetOpen = false;
      saveError = null;
      toast("success", "Settings restored to their defaults.");
    } catch (err) {
      reportError(err, "Settings could not be reset");
    } finally {
      resetting = false;
    }
  }

  async function openBrowser() {
    browseOpen = true;
    browseError = null;
    browseCurrent = draft.download.directory || app.paths?.downloads || app.system?.paths?.downloads || "";
    await loadFolder(browseCurrent);
  }

  async function loadFolder(target) {
    if (!target) return;
    browseLoading = true;
    browseError = null;
    try {
      const res = await fsApi.list(target);
      browse = res;
      browseCurrent = res.path;
    } catch (err) {
      browseError = err?.message || "That folder could not be read.";
    } finally {
      browseLoading = false;
    }
  }

  function chooseFolder() {
    if (!browse?.path) return;
    draft.download.directory = browse.path;
    browseOpen = false;
    toast("info", "Download folder selected. Save to apply it.");
  }

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name || !browseCurrent) return;
    creatingFolder = true;
    try {
      const base = browseCurrent.endsWith("/") ? browseCurrent.slice(0, -1) : browseCurrent;
      const res = await fsApi.mkdir(`${base}/${name}`);
      newFolderName = "";
      await loadFolder(res.path);
      toast("success", "Folder created.");
    } catch (err) {
      reportError(err, "The folder could not be created");
    } finally {
      creatingFolder = false;
    }
  }

  async function revealDownloads() {
    await revealPath(draft.download.directory);
  }

  async function revealPath(target) {
    if (!target) return;
    try {
      const res = await fsApi.reveal(target);
      if (!res.opened) toast("warning", `No file manager available in this environment. Path: ${res.path}`);
    } catch (err) {
      reportError(err, "The folder could not be opened");
    }
  }

  async function testAi() {
    aiTesting = true;
    aiResult = null;
    try {
      if (dirty) {
        const saved = await saveSettings(draft);
        draft = clone(saved);
        savedJson = JSON.stringify(saved);
      }
      const res = await settingsApi.testAi();
      aiResult = { ok: true, message: `Endpoint replied: ${res.reply || "OK"}` };
      toast("success", "The AI endpoint answered.");
    } catch (err) {
      aiResult = { ok: false, message: err?.message || "The endpoint did not answer." };
    } finally {
      aiTesting = false;
    }
  }

  async function loadDataSize() {
    dataLoading = true;
    dataError = null;
    try {
      dataSize = await dataApi.size();
    } catch (err) {
      dataError = err?.message || "Storage usage could not be read.";
    } finally {
      dataLoading = false;
    }
  }

  async function importSettingsFile(files) {
    const file = files?.[0];
    if (!file) return;
    importing = true;
    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("That file is not valid JSON.");
      }
      const res = await settingsApi.import(parsed);
      acceptSettings(res);
      draft = clone(res.settings);
      savedJson = JSON.stringify(res.settings);
      toast("success", "Settings imported from the file.");
    } catch (err) {
      reportError(err, "The settings file could not be imported");
    } finally {
      importing = false;
      if (importInput) importInput.value = "";
    }
  }

  const totalStorage = $derived(
    dataSize ? (dataSize.data || 0) + (dataSize.downloads || 0) + (dataSize.library || 0) : 0,
  );
</script>

<div class="content-inner stack stack-5">
  <header class="row row-between wrap" style="gap: 12px; padding-top: 4px">
    <div class="stack stack-1">
      <h1 class="page-title">Settings</h1>
      <p class="muted" style="font-size: 12px">
        Everything is stored in the local database and applied by the local service.
      </p>
    </div>
    <div class="row row-2">
      {#if dirty}
        <span class="dirty-chip"><span></span> Unsaved changes</span>
      {/if}
      <button class="btn btn-secondary btn-sm" onclick={discard} disabled={!dirty || saving}>
        <Icon name="refresh" size={12} /> Discard
      </button>
      <button class="btn btn-primary btn-sm" onclick={save} disabled={!dirty || saving}>
        {#if saving}
          <Icon name="loader" size={12} class="spin" /> Saving…
        {:else}
          <Icon name="check" size={12} /> Save changes
        {/if}
      </button>
    </div>
  </header>

  {#if !draft}
    <div class="pane settings-loading">
      {#each [1, 2, 3] as row}
        <div class="skeleton" style="height: 54px; border-radius: 10px"></div>
      {/each}
    </div>
  {:else}
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        {#each TABS as item}
          <button
            class="settings-tab"
            class:active={tab === item.id}
            onclick={() => (tab = item.id)}
            aria-current={tab === item.id ? "page" : undefined}
          >
            <Icon name={item.icon} size={14} />
            <span class="tab-copy">
              <span class="tab-label">{item.label}</span>
              <span class="tab-desc">{item.desc}</span>
            </span>
          </button>
        {/each}
      </nav>

      <section class="settings-body stack stack-4">
        <div class="settings-section-head">
          <div>
            <h2 class="section-title">{activeTab.label}</h2>
            <p class="muted" style="font-size: 11px">{activeTab.desc}</p>
          </div>
          {#if savedAt && !dirty}
            <span class="saved-note"><Icon name="check-circle" size={12} /> Saved {formatDate(savedAt, { withTime: true })}</span>
          {/if}
        </div>

        {#if saveError}
          <div class="form-error"><Icon name="alert-circle" size={13} /> {saveError}</div>
        {/if}

        {#if tab === "appearance"}
          <div class="pane set-pane">
            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Theme</span>
                <span class="set-desc">Light, dark, or follow the system preference.</span>
              </div>
              <div class="segmented">
                {#each [["light", "Light", "sun"], ["dark", "Dark", "moon"], ["system", "System", "monitor"]] as [value, label, icon]}
                  <button class:active={draft.appearance.theme === value} onclick={() => setTheme(value)} aria-pressed={draft.appearance.theme === value}>
                    <Icon name={icon} size={12} /> {label}
                  </button>
                {/each}
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Accent colour</span>
                <span class="set-desc">Used for buttons, links and active states.</span>
              </div>
              <div class="accent-row">
                {#each ACCENTS as accent}
                  <button
                    class="accent-swatch"
                    class:active={draft.appearance.accent === accent.id}
                    style="--swatch: {accent.color}"
                    onclick={() => setAccent(accent.id)}
                    aria-label={accent.label}
                    aria-pressed={draft.appearance.accent === accent.id}
                    title={accent.label}
                  ></button>
                {/each}
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Density</span>
                <span class="set-desc">Compact fits more rows on screen at once.</span>
              </div>
              <div class="segmented">
                {#each [["comfortable", "Comfortable"], ["compact", "Compact"]] as [value, label]}
                  <button class:active={draft.appearance.density === value} onclick={() => setDensity(value)} aria-pressed={draft.appearance.density === value}>
                    {label}
                  </button>
                {/each}
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Text size</span>
                <span class="set-desc">Scales interface text from 85% to 130%.</span>
              </div>
              <div class="range-control">
                <input type="range" min="0.85" max="1.3" step="0.05" bind:value={draft.appearance.fontScale} aria-label="Interface text size" />
                <span class="range-value mono">{Math.round(draft.appearance.fontScale * 100)}%</span>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Reduce motion</span>
                <span class="set-desc">Disables interface animations and transitions.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.appearance.reduceMotion} aria-label="Reduce motion" />
              </label>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Reduce transparency</span>
                <span class="set-desc">Removes blur behind the toolbar, menus and overlays.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.appearance.reduceTransparency} aria-label="Reduce transparency" />
              </label>
            </div>
          </div>
          <p class="settings-foot">
            Appearance changes preview immediately. Save to keep them after a reload.
          </p>
        {:else if tab === "downloads"}
          <div class="pane set-pane">
            <div class="set-block">
              <span class="field-label">Download folder</span>
              <div class="path-row">
                <span class="path-box mono" title={draft.download.directory}>{draft.download.directory || "Not configured"}</span>
                <button class="btn btn-secondary btn-sm" onclick={openBrowser}>
                  <Icon name="folder-open" size={12} /> Browse…
                </button>
                <button class="btn btn-ghost btn-icon btn-sm" onclick={revealDownloads} title="Open folder" aria-label="Open download folder">
                  <Icon name="external" size={12} />
                </button>
              </div>
              <span class="field-hint">Files are written here as soon as a transfer finishes. The server validates write access before saving.</span>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Parallel downloads</span>
                <span class="set-desc">How many transfers may run at the same time (1–8).</span>
              </div>
              <div class="range-control">
                <input type="range" min="1" max="8" step="1" bind:value={draft.download.maxConcurrent} aria-label="Parallel downloads" />
                <span class="range-value mono">{draft.download.maxConcurrent}</span>
              </div>
            </div>

            <div class="set-block">
              <span class="field-label">Speed limit</span>
              <div class="inline-field">
                <input class="input" type="number" min="0" max="1000000" step="50" bind:value={draft.download.speedLimitKbps} style="width: 140px" aria-label="Speed limit in KB per second" />
                <span class="field-hint">KB/s · 0 means unlimited. Applies to each transfer.</span>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Start automatically</span>
                <span class="set-desc">New downloads leave the queue immediately when this is on.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.download.autoStart} aria-label="Start downloads automatically" />
              </label>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Skip existing files</span>
                <span class="set-desc">Reuse a finished file with the same name and size instead of downloading it again.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.download.skipExisting} aria-label="Skip existing files" />
              </label>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Organise by source</span>
                <span class="set-desc">Put files into a subfolder named after the detected source.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.download.organizeBySource} aria-label="Organise downloads by source" />
              </label>
            </div>

            <div class="set-block">
              <span class="field-label">Filename template</span>
              <input class="input mono" bind:value={draft.download.filenameTemplate} aria-label="Filename template" />
              <span class="field-hint">Tokens: <span class="mono">{"{title}"}</span>, <span class="mono">{"{id}"}</span>, <span class="mono">{"{ext}"}</span>. The extension is always preserved.</span>
            </div>
          </div>
        {:else if tab === "network"}
          <div class="pane set-pane">
            <div class="set-block">
              <span class="field-label">HTTP proxy</span>
              <input class="input mono" bind:value={draft.network.proxy} placeholder="http://127.0.0.1:8080" aria-label="HTTP proxy" />
              <span class="field-hint">Leave empty for a direct connection. The optional proxy transport is bundled with this build.</span>
            </div>

            <div class="set-block">
              <span class="field-label">Request timeout</span>
              <div class="inline-field">
                <input class="input" type="number" min="5" max="300" step="5" bind:value={draft.network.timeoutSeconds} style="width: 110px" aria-label="Request timeout in seconds" />
                <span class="field-hint">seconds · applies to each HTTP request.</span>
              </div>
            </div>

            <div class="set-block">
              <span class="field-label">Custom user agent</span>
              <input class="input mono" bind:value={draft.network.userAgent} placeholder="Use the built-in OmniGet user agent" aria-label="Custom user agent" />
              <span class="field-hint">Some hosts reject unknown agents. Leave empty unless a site requires one.</span>
            </div>

            <div class="set-block">
              <span class="field-label">Site cookies file</span>
              <input class="input mono" bind:value={draft.download.cookiesFile} placeholder="Leave empty, or /path/to/cookies.txt" aria-label="Cookies file path" />
              <span class="field-hint">
                Optional Netscape-format cookies exported from your browser. Used only by yt-dlp
                when a site asks for a signed-in session — Reddit, private Instagram posts,
                protected X posts. It cannot unlock content you do not already have access to.
              </span>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Allow local network addresses</span>
                <span class="set-desc">
                  Permits links to localhost and private IP ranges. Useful for testing, but it weakens
                  the SSRF guard, so leave it off unless you need it.
                </span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.network.allowLocalhost} aria-label="Allow local network addresses" />
              </label>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Verify TLS certificates</span>
                <span class="set-desc">Turning this off accepts invalid certificates for direct and proxied requests.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.network.verifyTls} aria-label="Verify TLS certificates" />
              </label>
            </div>
          </div>
          {#if !draft.network.verifyTls}
            <div class="inline-warn">
              <Icon name="alert-triangle" size={13} />
              Certificate checks are disabled. Only use this on a trusted network.
            </div>
          {/if}
        {:else if tab === "playback"}
          <div class="pane set-pane">
            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Autoplay</span>
                <span class="set-desc">Start playing as soon as a media file opens.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.playback.autoplay} aria-label="Autoplay" />
              </label>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Remember position</span>
                <span class="set-desc">Resume where you stopped the next time a file is opened.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.playback.rememberPosition} aria-label="Remember playback position" />
              </label>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Loop by default</span>
                <span class="set-desc">Repeat the current file when it reaches the end.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.playback.loop} aria-label="Loop by default" />
              </label>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Default volume</span>
                <span class="set-desc">Starting level for the player.</span>
              </div>
              <div class="range-control">
                <input type="range" min="0" max="1" step="0.01" bind:value={draft.playback.defaultVolume} aria-label="Default volume" />
                <span class="range-value mono">{Math.round(draft.playback.defaultVolume * 100)}%</span>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Default speed</span>
                <span class="set-desc">Playback rate used when a file opens.</span>
              </div>
              <select class="select" bind:value={draft.playback.defaultRate} style="width: 96px" aria-label="Default playback speed">
                {#each [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as value}
                  <option value={value}>{value}×</option>
                {/each}
              </select>
            </div>

            <div class="set-block">
              <span class="field-label">Seek step</span>
              <div class="inline-field">
                <input class="input" type="number" min="2" max="60" step="1" bind:value={draft.playback.seekStep} style="width: 100px" aria-label="Seek step in seconds" />
                <span class="field-hint">seconds · used by the J / L keys and the skip buttons.</span>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Subtitle size</span>
                <span class="set-desc">Scales WebVTT cues drawn over the video.</span>
              </div>
              <div class="range-control">
                <input type="range" min="0.6" max="2.2" step="0.05" bind:value={draft.playback.subtitleSize} aria-label="Subtitle size" />
                <span class="range-value mono">{Math.round(draft.playback.subtitleSize * 100)}%</span>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Subtitle appearance</span>
                <span class="set-desc">Text colour and background opacity.</span>
              </div>
              <div class="row row-2">
                <input type="color" class="color-input" bind:value={draft.playback.subtitleColor} aria-label="Subtitle colour" />
                <input type="range" min="0" max="1" step="0.05" bind:value={draft.playback.subtitleBackground} style="width: 120px" aria-label="Subtitle background opacity" />
                <span class="range-value mono">{Math.round(draft.playback.subtitleBackground * 100)}%</span>
              </div>
            </div>
          </div>
          <p class="settings-foot">
            Native browser caption rendering may ignore some appearance values. Subtitle files are
            converted to WebVTT by the local service.
          </p>
        {:else if tab === "reader"}
          <div class="pane set-pane">
            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Page theme</span>
                <span class="set-desc">Background and ink colour for EPUB chapters and PDF pages.</span>
              </div>
              <div class="theme-row">
                {#each READER_THEMES as theme}
                  <button
                    class="theme-swatch"
                    class:active={draft.reader.theme === theme.id}
                    style="--swatch: {theme.color}"
                    onclick={() => (draft.reader.theme = theme.id)}
                    aria-label={theme.label}
                    aria-pressed={draft.reader.theme === theme.id}
                    title={theme.label}
                  ></button>
                {/each}
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Typeface</span>
                <span class="set-desc">Applied to EPUB text. PDFs keep their embedded fonts.</span>
              </div>
              <div class="segmented">
                {#each [["serif", "Serif"], ["sans", "Sans"], ["mono", "Mono"]] as [value, label]}
                  <button class:active={draft.reader.fontFamily === value} onclick={() => (draft.reader.fontFamily = value)} aria-pressed={draft.reader.fontFamily === value}>
                    {label}
                  </button>
                {/each}
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Text size</span>
                <span class="set-desc">EPUB body size in pixels.</span>
              </div>
              <div class="range-control">
                <input type="range" min="12" max="34" step="1" bind:value={draft.reader.fontSize} aria-label="Reader text size" />
                <span class="range-value mono">{draft.reader.fontSize}px</span>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Line height</span>
                <span class="set-desc">Spacing between lines of book text.</span>
              </div>
              <div class="range-control">
                <input type="range" min="1.2" max="2.4" step="0.05" bind:value={draft.reader.lineHeight} aria-label="Reader line height" />
                <span class="range-value mono">{draft.reader.lineHeight.toFixed(2)}</span>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Page width</span>
                <span class="set-desc">Maximum width of the reading column.</span>
              </div>
              <div class="range-control">
                <input type="range" min="480" max="1100" step="20" bind:value={draft.reader.pageWidth} aria-label="Reader page width" />
                <span class="range-value mono">{draft.reader.pageWidth}px</span>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Justify text</span>
                <span class="set-desc">Align both edges of paragraphs in EPUB chapters.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.reader.justify} aria-label="Justify reader text" />
              </label>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">PDF zoom</span>
                <span class="set-desc">Starting zoom level for PDF pages.</span>
              </div>
              <div class="range-control">
                <input type="range" min="0.5" max="3" step="0.05" bind:value={draft.reader.pdfZoom} aria-label="PDF zoom" />
                <span class="range-value mono">{Math.round(draft.reader.pdfZoom * 100)}%</span>
              </div>
            </div>
          </div>
          <p class="settings-foot">
            Per-book overrides set inside the reader are written back to these preferences.
          </p>
        {:else if tab === "study"}
          <div class="pane set-pane">
            <div class="set-block">
              <span class="field-label">Daily study goal</span>
              <div class="inline-field">
                <input class="input" type="number" min="5" max="600" step="5" bind:value={draft.study.dailyGoalMinutes} style="width: 110px" aria-label="Daily study goal in minutes" />
                <span class="field-hint">minutes · progress appears on the Study page.</span>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Resume books automatically</span>
                <span class="set-desc">Reopen EPUB and PDF books at the last chapter or page. Turn off to always start at the beginning.</span>
              </div>
              <label class="switch">
                <input type="checkbox" bind:checked={draft.study.autoResume} aria-label="Resume books automatically" />
              </label>
            </div>
          </div>
          <p class="settings-foot">
            Reading time is recorded while a book or media item is open. It is stored locally in the
            study sessions table, one row per day.
          </p>
        {:else if tab === "ai"}
          <div class="pane set-pane">
            <div class="set-block">
              <span class="field-label">API base URL</span>
              <input class="input mono" bind:value={draft.ai.baseUrl} placeholder="https://api.openai.com/v1" aria-label="AI API base URL" />
              <span class="field-hint">
                Any OpenAI-compatible chat completions endpoint. OmniGet appends
                <span class="mono">/chat/completions</span> unless the URL already ends with it.
              </span>
            </div>

            <div class="set-block">
              <span class="field-label">Model</span>
              <input class="input mono" bind:value={draft.ai.model} placeholder="gpt-4o-mini" aria-label="AI model name" />
            </div>

            <div class="set-block">
              <span class="field-label">API key</span>
              <div class="key-row">
                <input
                  class="input mono"
                  type={showKey ? "text" : "password"}
                  bind:value={draft.ai.apiKey}
                  placeholder="Stored locally in omniget.db"
                  autocomplete="off"
                  aria-label="AI API key"
                />
                <button class="btn btn-secondary btn-icon btn-sm" onclick={() => (showKey = !showKey)} aria-label={showKey ? "Hide API key" : "Show API key"}>
                  <Icon name={showKey ? "eye-off" : "eye"} size={13} />
                </button>
              </div>
              <span class="field-hint">
                The key is sent only to the endpoint above. Exports mask it unless you explicitly
                request secrets.
              </span>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Test the connection</span>
                <span class="set-desc">Saves the settings, then sends a single short request to the endpoint.</span>
              </div>
              <button class="btn btn-secondary btn-sm" onclick={testAi} disabled={aiTesting || !draft.ai.apiKey}>
                {#if aiTesting}
                  <Icon name="loader" size={12} class="spin" /> Testing…
                {:else}
                  <Icon name="wifi" size={12} /> Test endpoint
                {/if}
              </button>
            </div>

            {#if aiResult}
              <div class="inline-result" class:error={!aiResult.ok}>
                <Icon name={aiResult.ok ? "check-circle" : "alert-circle"} size={13} />
                <span>{aiResult.message}</span>
              </div>
            {/if}
          </div>
          <p class="settings-foot">
            The AI tool is optional and disabled until a key is configured. No content is sent
            anywhere unless you run that tool.
          </p>
        {:else if tab === "data"}
          <div class="pane set-pane">
            <div class="data-grid">
              <div class="data-cell">
                <span class="data-value mono">{formatBytes(dataSize?.downloads || 0)}</span>
                <span class="data-label">Downloaded files</span>
              </div>
              <div class="data-cell">
                <span class="data-value mono">{formatBytes(dataSize?.library || 0)}</span>
                <span class="data-label">Books &amp; media</span>
              </div>
              <div class="data-cell">
                <span class="data-value mono">{formatBytes(dataSize?.outputs || 0)}</span>
                <span class="data-label">Tool outputs</span>
              </div>
              <div class="data-cell">
                <span class="data-value mono">{formatBytes(dataSize?.database || 0)}</span>
                <span class="data-label">Database</span>
              </div>
              <div class="data-cell">
                <span class="data-value mono">{formatBytes(totalStorage)}</span>
                <span class="data-label">Tracked total</span>
              </div>
            </div>

            {#if dataLoading}
              <p class="field-hint"><Icon name="loader" size={11} class="spin" /> Measuring storage…</p>
            {:else if dataError}
              <div class="inline-result error">
                <Icon name="alert-circle" size={13} /> {dataError}
                <button class="btn btn-ghost btn-sm" onclick={loadDataSize}>Retry</button>
              </div>
            {/if}

            <div class="set-block">
              <span class="field-label">Where the data lives</span>
              <div class="path-list">
                <div><span>Data</span><span class="mono">{app.paths?.dataDir || "—"}</span></div>
                <div><span>Downloads</span><span class="mono">{app.paths?.downloadsDir || "—"}</span></div>
                <div><span>Library</span><span class="mono">{app.paths?.libraryDir || "—"}</span></div>
                <div><span>Database</span><span class="mono">{app.paths?.settingsFile || "—"}</span></div>
              </div>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Export a full backup</span>
                <span class="set-desc">JSON with settings, download records, library entries, notes and bookmarks. Files on disk are not included.</span>
              </div>
              <a class="btn btn-secondary btn-sm" href={dataApi.exportUrl}>
                <Icon name="download" size={12} /> Export data
              </a>
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Settings file</span>
                <span class="set-desc">Export or import just the preferences. API keys are masked on export.</span>
              </div>
              <div class="row row-2">
                <a class="btn btn-secondary btn-sm" href={settingsApi.exportUrl(false)}>
                  <Icon name="download" size={12} /> Export
                </a>
                <button class="btn btn-secondary btn-sm" onclick={() => importInput?.click()} disabled={importing}>
                  {#if importing}
                    <Icon name="loader" size={12} class="spin" /> Importing…
                  {:else}
                    <Icon name="upload" size={12} /> Import
                  {/if}
                </button>
              </div>
              <input
                bind:this={importInput}
                type="file"
                accept="application/json,.json"
                class="hidden-input"
                onchange={(e) => importSettingsFile(e.currentTarget.files)}
              />
            </div>

            <div class="set-row">
              <div class="set-copy">
                <span class="set-title">Open the data folder</span>
                <span class="set-desc">Useful for copying the database or outputs into a backup.</span>
              </div>
              <button class="btn btn-secondary btn-sm" onclick={revealOpen = true}>
                <Icon name="folder" size={12} /> Reveal
              </button>
            </div>

            <div class="set-row danger-row">
              <div class="set-copy">
                <span class="set-title">Reset all settings</span>
                <span class="set-desc">Restores every preference to its default. Library, notes and downloads are kept.</span>
              </div>
              <button class="btn btn-danger btn-sm" onclick={() => (resetOpen = true)}>
                <Icon name="refresh" size={12} /> Reset
              </button>
            </div>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<Modal
  open={browseOpen}
  size="lg"
  title="Choose a download folder"
  subtitle="The local service validates that the folder exists and is writable."
  onClose={() => (browseOpen = false)}
>
  <div class="stack stack-3">
    <div class="browse-bar">
      <button class="btn btn-secondary btn-icon btn-sm" onclick={() => loadFolder(browse?.parent)} disabled={!browse?.parent || browseLoading} title="Parent folder" aria-label="Parent folder">
        <Icon name="arrow-up" size={12} />
      </button>
      <input
        class="input mono browse-path"
        bind:value={browseCurrent}
        onkeydown={(e) => e.key === "Enter" && loadFolder(browseCurrent)}
        aria-label="Folder path"
      />
      <button class="btn btn-secondary btn-sm" onclick={() => loadFolder(browseCurrent)} disabled={browseLoading}>Go</button>
      <button class="btn btn-ghost btn-sm" onclick={() => loadFolder(browse?.home)} disabled={!browse?.home}>Home</button>
    </div>

    {#if browseLoading}
      <div class="stack stack-2">
        {#each [1, 2, 3, 4, 5] as row}
          <div class="skeleton" style="height: 30px; border-radius: 7px"></div>
        {/each}
      </div>
    {:else if browseError}
      <div class="inline-result error"><Icon name="alert-circle" size={13} /> {browseError}</div>
    {:else}
      <div class="browse-list">
        {#each browse?.dirs || [] as dir}
          <button class="browse-item" onclick={() => loadFolder(dir.path)}>
            <Icon name="folder" size={14} />
            <span class="browse-name">{dir.name}</span>
            <Icon name="chevron-right" size={11} class="faint" />
          </button>
        {/each}
        {#if !browse?.dirs?.length}
          <p class="browse-empty">No subfolders here.</p>
        {/if}
      </div>
    {/if}

    <div class="new-folder-row">
      <input
        class="input"
        bind:value={newFolderName}
        placeholder="New folder name"
        aria-label="New folder name"
        onkeydown={(e) => e.key === "Enter" && createFolder()}
      />
      <button class="btn btn-secondary btn-sm" onclick={createFolder} disabled={!newFolderName.trim() || creatingFolder}>
        {#if creatingFolder}<Icon name="loader" size={12} class="spin" />{:else}<Icon name="plus" size={12} />{/if}
        Create
      </button>
    </div>

    <div class="browse-foot">
      <span class="field-hint">Selected: <span class="mono">{browse?.path || "—"}</span></span>
      <div class="row row-2">
        <button class="btn btn-secondary btn-sm" onclick={() => (browseOpen = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={chooseFolder} disabled={!browse?.path}>
          Use this folder
        </button>
      </div>
    </div>
  </div>
</Modal>

<Modal
  open={revealOpen}
  title="Open the data folder?"
  subtitle={app.paths?.dataDir || ""}
  onClose={() => (revealOpen = false)}
>
  <div class="stack stack-4">
    <p class="muted" style="font-size: 12px; line-height: 1.6">
      OmniGet will ask the operating system to open the data folder. In a headless or container
      environment this may not be possible, and the path will be reported instead.
    </p>
    <div class="row row-end row-2">
      <button class="btn btn-secondary btn-sm" onclick={() => (revealOpen = false)}>Cancel</button>
      <button
        class="btn btn-primary btn-sm"
        onclick={async () => {
          revealOpen = false;
          await revealPath(app.paths?.dataDir);
        }}
      >
        <Icon name="folder-open" size={12} /> Try to open
      </button>
    </div>
  </div>
</Modal>

<Modal
  open={resetOpen}
  title="Reset all settings?"
  subtitle="Library, notes, downloads and tool outputs are not touched."
  onClose={() => (resetOpen = false)}
>
  <div class="stack stack-4">
    <p class="muted" style="font-size: 12px; line-height: 1.6">
      This restores the theme, download folder, network, playback, reader and AI preferences to
      their defaults. The download folder returns to the service default, which is validated again
      when you save.
    </p>
    <div class="row row-end row-2">
      <button class="btn btn-secondary btn-sm" onclick={() => (resetOpen = false)}>Cancel</button>
      <button class="btn btn-danger btn-sm" onclick={confirmReset} disabled={resetting}>
        {#if resetting}<Icon name="loader" size={12} class="spin" />{:else}<Icon name="refresh" size={12} />{/if}
        Reset settings
      </button>
    </div>
  </div>
</Modal>

<style>
  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .dirty-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--warning);
    background: var(--warning-soft);
    padding: 3px 8px;
    border-radius: 99px;
  }
  .dirty-chip span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--warning);
  }

  .settings-loading {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .settings-layout {
    display: grid;
    grid-template-columns: 232px minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }

  .settings-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: sticky;
    top: 0;
    padding: 6px;
    border-radius: var(--radius-lg);
    background: var(--pane);
    border: 1px solid var(--content-border);
  }
  .settings-tab {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 8px 9px;
    border-radius: 7px;
    color: var(--tertiary);
    text-align: left;
    transition: all var(--duration-fast) var(--ease-out);
  }
  .settings-tab :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
  }
  .settings-tab:hover {
    background: var(--surface-hi);
    color: var(--secondary);
  }
  .settings-tab.active {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .tab-copy {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .tab-label {
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .tab-desc {
    font-size: 9.5px;
    color: var(--quaternary);
    line-height: 1.35;
  }
  .settings-tab.active .tab-desc {
    color: var(--accent-text);
    opacity: 0.72;
  }

  .settings-body {
    min-width: 0;
  }
  .settings-section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .saved-note {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--success);
  }

  .set-pane {
    padding: 4px 16px;
    display: flex;
    flex-direction: column;
  }
  .set-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 12px 0;
    border-bottom: 1px solid var(--content-border);
  }
  .set-row:last-child {
    border-bottom: 0;
  }
  .set-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
    max-width: 560px;
  }
  .set-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .set-desc {
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--tertiary);
  }
  .set-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 0;
    border-bottom: 1px solid var(--content-border);
  }
  .set-block:last-child {
    border-bottom: 0;
  }
  .set-block > .field-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--secondary);
  }
  .danger-row .set-title {
    color: var(--error);
  }

  .segmented {
    display: inline-flex;
    padding: 2px;
    border-radius: 7px;
    background: var(--surface-sunken);
    border: 1px solid var(--content-border);
    flex: 0 0 auto;
  }
  .segmented button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 9px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 550;
    color: var(--tertiary);
  }
  .segmented button.active {
    background: var(--surface);
    color: var(--secondary);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
    font-weight: 600;
  }

  .accent-row,
  .theme-row {
    display: flex;
    gap: 7px;
    flex: 0 0 auto;
  }
  .accent-swatch,
  .theme-swatch {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--swatch);
    border: 1px solid color-mix(in srgb, var(--swatch) 60%, #000 12%);
    transition: box-shadow var(--duration-fast) var(--ease-out);
  }
  .theme-swatch {
    border-radius: 7px;
  }
  .accent-swatch.active,
  .theme-swatch.active {
    box-shadow:
      0 0 0 2px var(--pane),
      0 0 0 4px var(--accent);
  }

  .range-control {
    display: flex;
    align-items: center;
    gap: 9px;
    flex: 0 0 auto;
  }
  .range-control input[type="range"] {
    width: 150px;
  }
  .range-value {
    font-size: 10.5px;
    color: var(--tertiary);
    min-width: 42px;
    text-align: right;
  }

  .inline-field {
    display: flex;
    align-items: center;
    gap: 9px;
    flex-wrap: wrap;
  }
  .inline-warn {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 12px;
    border-radius: var(--radius-md);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 11px;
    line-height: 1.5;
  }
  .inline-result {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 11px;
    border-radius: 7px;
    background: var(--success-soft);
    color: var(--success);
    font-size: 11px;
    line-height: 1.5;
    word-break: break-word;
  }
  .inline-result.error {
    background: var(--error-soft);
    color: var(--error);
  }
  .inline-result :global(button) {
    margin-left: auto;
  }

  .path-row {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .path-box {
    flex: 1;
    min-width: 0;
    height: 30px;
    display: flex;
    align-items: center;
    padding: 0 9px;
    border-radius: 6px;
    background: var(--surface-sunken);
    border: 1px solid var(--content-border);
    font-size: 10.5px;
    color: var(--secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .key-row {
    display: flex;
    gap: 6px;
  }
  .key-row .input {
    flex: 1;
  }

  .color-input {
    width: 34px;
    height: 28px;
    padding: 2px;
    border-radius: 6px;
    border: 1px solid var(--input-border);
    background: var(--surface);
    cursor: pointer;
  }

  .data-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
    gap: 8px;
    padding: 12px 0;
    border-bottom: 1px solid var(--content-border);
  }
  .data-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 11px;
    border-radius: 8px;
    background: var(--surface-sunken);
  }
  .data-value {
    font-size: 13px;
    font-weight: 600;
    color: var(--secondary);
  }
  .data-label {
    font-size: 9.5px;
    color: var(--quaternary);
  }

  .path-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 10.5px;
  }
  .path-list > div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 0;
  }
  .path-list > div > span:first-child {
    color: var(--tertiary);
    flex: 0 0 auto;
  }
  .path-list .mono {
    min-width: 0;
    text-align: right;
    word-break: break-all;
    color: var(--secondary);
  }

  .settings-foot {
    font-size: 10px;
    color: var(--quaternary);
    line-height: 1.6;
    padding: 0 4px;
  }

  .hidden-input {
    display: none;
  }

  .browse-bar {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .browse-path {
    flex: 1;
    min-width: 0;
    font-size: 11px;
  }
  .browse-list {
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid var(--content-border);
    border-radius: 8px;
    background: var(--surface);
  }
  .browse-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border-bottom: 1px solid var(--content-border);
    text-align: left;
    font-size: 11.5px;
  }
  .browse-item:last-child {
    border-bottom: 0;
  }
  .browse-item:hover {
    background: var(--surface-hi);
  }
  .browse-item :global(svg) {
    color: var(--accent-text);
    flex: 0 0 auto;
  }
  .browse-item :global(svg.faint) {
    color: var(--quaternary);
    margin-left: auto;
  }
  .browse-name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .browse-empty {
    padding: 16px;
    text-align: center;
    font-size: 11px;
    color: var(--quaternary);
  }
  .new-folder-row {
    display: flex;
    gap: 6px;
  }
  .new-folder-row .input {
    flex: 1;
  }
  .browse-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  @media (max-width: 900px) {
    .settings-layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .settings-nav {
      position: relative;
      flex-direction: row;
      overflow-x: auto;
      scrollbar-width: none;
      padding: 4px;
    }
    .settings-nav::-webkit-scrollbar {
      display: none;
    }
    .settings-tab {
      flex: 0 0 auto;
      align-items: center;
      padding: 7px 10px;
    }
    .tab-desc {
      display: none;
    }
  }

  @media (max-width: 640px) {
    .set-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
    .range-control {
      width: 100%;
    }
    .range-control input[type="range"] {
      flex: 1;
      width: auto;
    }
    .path-row {
      flex-wrap: wrap;
    }
    .path-box {
      flex-basis: 100%;
    }
  }
</style>
