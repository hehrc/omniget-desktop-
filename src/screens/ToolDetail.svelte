<script>
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import { app, refreshTools, reportError, toast } from "../lib/state.svelte.js";
  import { toolsApi } from "../lib/api.js";
  import { formatBytes, formatRelative, pluralize, statusLabel } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let { id } = $props();

  let values = $state({});
  let files = $state([]);
  let running = $state(false);
  let result = $state(null);
  let runError = $state(null);
  let formError = $state(null);
  let jobError = $state(null);
  let jobs = $state([]);
  let dropActive = $state(false);
  let fileInput = $state(null);
  let initializedFor = null;
  let elapsed = $state(0);
  let elapsedTimer = null;

  const tool = $derived(app.tools?.tools?.find((t) => t.id === id) || null);
  const category = $derived(app.tools?.categories?.find((c) => c.id === tool?.category) || null);
  const loading = $derived(!app.tools);

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

  $effect(() => {
    if (!app.tools) refreshTools().catch((err) => reportError(err, "Could not load the tool catalog"));
  });

  $effect(() => {
    const t = tool;
    if (!t || initializedFor === t.id) return;
    initializedFor = t.id;
    const next = {};
    for (const field of t.fields || []) {
      if (field.type === "checkbox") next[field.name] = field.default === true;
      else next[field.name] = field.default ?? "";
    }
    values = next;
    files = [];
    result = null;
    runError = null;
    formError = null;
    loadJobs(t.id);
  });

  async function loadJobs(toolId) {
    try {
      const res = await toolsApi.jobs();
      jobs = res.jobs.filter((j) => j.toolId === toolId).slice(0, 6);
    } catch {
      jobs = [];
    }
  }

  function addFiles(list) {
    if (!tool) return;
    const incoming = [...list];
    const max = tool.maxFiles === 0 ? 0 : tool.maxFiles;
    const merged = [...files, ...incoming];
    if (max > 0 && merged.length > max) {
      toast("warning", `“${tool.name}” accepts at most ${pluralize(max, "file")}.`);
    }
    files = merged.slice(0, max || 0);
    formError = null;
  }

  function removeFile(index) {
    files = files.filter((_, i) => i !== index);
  }

  function onDrop(event) {
    event.preventDefault();
    dropActive = false;
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
  }

  function validate() {
    if (!tool) return "This tool is not in the catalog.";
    if (!tool.available) return tool.unavailableReason || "Required software is missing.";
    if (tool.requiresConfig) return tool.configHint || "This tool needs configuration first.";
    if (files.length < (tool.minFiles || 0)) {
      return `This tool needs at least ${pluralize(tool.minFiles, "file")}.`;
    }
    if (tool.maxFiles >= 0 && files.length > tool.maxFiles) {
      return `This tool accepts at most ${pluralize(tool.maxFiles, "file")}.`;
    }
    for (const field of tool.fields || []) {
      if (!field.required) continue;
      const value = values[field.name];
      if (value === undefined || value === null || value === "" || value === false) {
        return `“${field.label}” is required.`;
      }
    }
    return null;
  }

  async function run() {
    formError = validate();
    if (formError) return;
    running = true;
    runError = null;
    result = null;
    elapsed = 0;
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => (elapsed += 1), 1000);
    try {
      const fd = new FormData();
      for (const field of tool.fields || []) {
        const value = values[field.name];
        if (value === undefined || value === null) continue;
        if (field.type === "checkbox") fd.append(field.name, value ? "true" : "false");
        else fd.append(field.name, String(value));
      }
      for (const file of files) fd.append("files", file, file.name);
      const res = await toolsApi.run(tool.id, fd);
      result = res;
      loadJobs(tool.id);
      toast("success", res.output?.summary || "Tool finished.");
    } catch (err) {
      runError = err?.message || "The tool could not finish.";
      if (err?.payload?.jobId) loadJobs(tool.id);
    } finally {
      running = false;
      clearInterval(elapsedTimer);
    }
  }

  function resetForm() {
    if (!tool) return;
    const next = {};
    for (const field of tool.fields || []) {
      next[field.name] = field.type === "checkbox" ? field.default === true : field.default ?? "";
    }
    values = next;
    files = [];
    runError = null;
    formError = null;
    result = null;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("success", "Copied to clipboard.");
    } catch {
      toast("warning", "Clipboard access was blocked by the browser.");
    }
  }

  function followLink(href) {
    if (!href) return;
    if (href.startsWith("#")) navigate(href.slice(1));
    else window.open(href, "_blank", "noopener");
  }

  async function removeJobHistory() {
    try {
      await toolsApi.clearJobs();
      jobs = [];
      toast("success", "Tool job history cleared. Output folders older than the retention window were removed.");
    } catch (err) {
      reportError(err, "Could not clear the tool history");
    }
  }

  function outputText() {
    if (!result?.output) return "";
    const out = result.output;
    if (out.json) return JSON.stringify(out.json, null, 2);
    return out.text || out.preview || "";
  }

  const isAiTool = $derived(tool?.requiresConfig === "ai");
</script>

{#if loading}
  <div class="content-inner stack stack-4">
    <div class="skeleton" style="height: 24px; width: 32%"></div>
    <div class="grid-2">
      <div class="skeleton" style="height: 360px; border-radius: 14px"></div>
      <div class="skeleton" style="height: 360px; border-radius: 14px"></div>
    </div>
  </div>
{:else if !tool}
  <div class="content-inner">
    <div class="pane" style="max-width: 520px; margin: 6vh auto">
      <EmptyState
        icon="wrench"
        title="This tool does not exist"
        message={`“${id}” is not part of the catalog in this build.`}
        actionLabel="All tools"
        onAction={() => navigate("/tools")}
      />
    </div>
  </div>
{:else}
  <div class="content-inner stack stack-5">
    <header class="tool-head">
      <button class="btn btn-ghost btn-icon btn-sm" onclick={() => navigate("/tools")} title="All tools">
        <Icon name="arrow-left" size={15} />
      </button>
      <span class="tool-icon">
        <Icon name={TOOL_ICONS[tool.category] || "wrench"} size={19} />
      </span>
      <div class="tool-heading">
        <div class="row row-2 wrap" style="gap: 6px">
          <h1 class="page-title">{tool.name}</h1>
          {#if !tool.available}
            <span class="badge badge-warning">Unavailable</span>
          {:else if tool.requiresConfig}
            <span class="badge badge-blue">Needs configuration</span>
          {:else}
            <span class="badge badge-success">Ready</span>
          {/if}
        </div>
        <p class="tool-sub">{tool.description}</p>
        <p class="tool-cat">
          <button onclick={() => navigate("/tools")}>{category?.name || tool.category}</button>
          · {tool.id}
        </p>
      </div>
    </header>

    {#if !tool.available}
      <div class="warn-banner">
        <Icon name="alert-triangle" size={15} />
        <div>
          <p class="warn-title">This tool needs a program that is not installed</p>
          <p class="warn-text">{tool.unavailableReason}</p>
        </div>
        <button class="btn btn-secondary btn-sm" onclick={() => navigate("/settings")}>Check environment</button>
      </div>
    {:else if tool.requiresConfig}
      <div class="warn-banner info">
        <Icon name="info" size={15} />
        <div>
          <p class="warn-title">Configuration required</p>
          <p class="warn-text">{tool.configHint}</p>
        </div>
        <button class="btn btn-secondary btn-sm" onclick={() => navigate("/settings")}>Open settings</button>
      </div>
    {/if}

    <div class="runner-grid">
      <section class="pane run-pane">
        <div class="pane-head">
          <p class="eyebrow">Input</p>
          <button class="btn btn-ghost btn-sm" onclick={resetForm} disabled={running}>
            <Icon name="refresh" size={11} /> Reset
          </button>
        </div>

        {#if tool.maxFiles > 0}
          <div class="form-section">
            <div class="row row-between" style="margin-bottom: 6px">
              <span class="field-label">Files</span>
              <span class="field-hint">
                {tool.minFiles > 0 ? `at least ${pluralize(tool.minFiles, "file")}` : "optional"}
                {#if tool.maxFiles > 1} · up to {tool.maxFiles}{/if}
              </span>
            </div>

            <div
              class="drop"
              class:active={dropActive}
              role="button"
              tabindex="0"
              onclick={() => fileInput?.click()}
              onkeydown={(e) => (e.key === "Enter" || e.key === " ") && fileInput?.click()}
              ondrop={onDrop}
              ondragover={(e) => {
                e.preventDefault();
                dropActive = true;
              }}
              ondragleave={() => (dropActive = false)}
            >
              <Icon name="upload" size={17} />
              <div class="drop-text">
                <span class="drop-title">Drop files here or click to choose</span>
                <span class="drop-accept">{tool.accept ? tool.accept.split(",").join(" · ") : "Any file type"}</span>
              </div>
            </div>
            <input
              bind:this={fileInput}
              type="file"
              accept={tool.accept || undefined}
              multiple={tool.maxFiles !== 1}
              class="hidden-input"
              onchange={(e) => {
                addFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />

            {#if files.length}
              <ul class="file-list">
                {#each files as file, index (file.name + index)}
                  <li class="file-row">
                    <span class="file-icon"><Icon name="file" size={12} /></span>
                    <span class="file-name" title={file.name}>{file.name}</span>
                    <span class="file-size mono">{formatBytes(file.size)}</span>
                    <button class="file-remove" onclick={() => removeFile(index)} aria-label={`Remove ${file.name}`}>
                      <Icon name="x" size={11} />
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}

        {#if tool.fields.length}
          <div class="form-grid">
            {#each tool.fields as field (field.name)}
              {#if field.type === "textarea"}
                <label class="field span-2">
                  <span class="field-label">{field.label}{#if field.required}<span class="req">*</span>{/if}</span>
                  <textarea
                    class="textarea"
                    bind:value={values[field.name]}
                    placeholder={field.placeholder || ""}
                    disabled={running}
                  ></textarea>
                </label>
              {:else if field.type === "select"}
                <label class="field">
                  <span class="field-label">{field.label}{#if field.required}<span class="req">*</span>{/if}</span>
                  <select class="select" bind:value={values[field.name]} disabled={running}>
                    {#each field.options || [] as option}
                      <option value={option.value}>{option.label ?? option.value}</option>
                    {/each}
                  </select>
                </label>
              {:else if field.type === "checkbox"}
                <label class="checkbox field-check span-2">
                  <input type="checkbox" bind:checked={values[field.name]} disabled={running} />
                  <span>
                    <span class="field-label" style="color: var(--secondary)">{field.label}</span>
                    {#if field.placeholder}<span class="field-hint" style="display: block">{field.placeholder}</span>{/if}
                  </span>
                </label>
              {:else if field.type === "number"}
                <label class="field">
                  <span class="field-label">{field.label}{#if field.required}<span class="req">*</span>{/if}</span>
                  <input
                    class="input"
                    type="number"
                    bind:value={values[field.name]}
                    min={field.min}
                    max={field.max}
                    step={field.step || 1}
                    placeholder={field.placeholder || ""}
                    disabled={running}
                  />
                </label>
              {:else}
                <label class="field" class:span-2={field.type === "text" && (field.placeholder?.length || 0) > 42}>
                  <span class="field-label">{field.label}{#if field.required}<span class="req">*</span>{/if}</span>
                  <input
                    class="input"
                    type="text"
                    bind:value={values[field.name]}
                    placeholder={field.placeholder || ""}
                    disabled={running}
                  />
                </label>
              {/if}
            {/each}
          </div>
        {/if}

        {#if !tool.fields.length && tool.maxFiles === 0}
          <div class="no-input">
            <Icon name="info" size={14} />
            This tool runs with no input and produces a result directly.
          </div>
        {/if}

        {#if formError}
          <div class="form-error"><Icon name="alert-circle" size={13} /> {formError}</div>
        {/if}

        <div class="run-foot">
          <p class="run-hint">
            {#if isAiTool && app.settings?.ai?.apiKey}
              Uses your configured endpoint · {app.settings.ai.model || "no model set"}
            {:else}
              Runs locally in the OmniGet service
            {/if}
          </p>
          <button class="btn btn-primary" onclick={run} disabled={running || !tool.available || tool.requiresConfig}>
            {#if running}
              <Icon name="loader" size={13} class="spin" /> Running…
            {:else}
              <Icon name="play" size={12} filled /> Run tool
            {/if}
          </button>
        </div>
      </section>

      <section class="pane result-pane">
        <div class="pane-head">
          <p class="eyebrow">Output</p>
          {#if result?.jobId}<span class="badge badge-outline mono">{result.jobId}</span>{/if}
        </div>

        {#if running}
          <div class="result-loading">
            <span class="running-art"><Icon name="loader" size={22} class="spin" /></span>
            <p class="result-title">Working…</p>
            <p class="result-sub">Elapsed {elapsed}s. Large files are processed on the local service.</p>
            <div class="stack stack-2" style="width: 100%; margin-top: 8px">
              <div class="skeleton" style="height: 9px; width: 80%"></div>
              <div class="skeleton" style="height: 9px; width: 62%"></div>
              <div class="skeleton" style="height: 9px; width: 71%"></div>
            </div>
          </div>
        {:else if runError}
          <div class="result-error">
            <span class="result-error-art"><Icon name="alert-triangle" size={22} /></span>
            <p class="result-title">The tool could not finish</p>
            <p class="result-sub">{runError}</p>
            {#if jobError}<p class="field-hint">{jobError}</p>{/if}
            <button class="btn btn-secondary btn-sm" onclick={run}>Try again</button>
          </div>
        {:else if result}
          <div class="result-body">
            {#if result.output?.summary}
              <div class="success-note">
                <Icon name="check-circle" size={14} />
                <span>{result.output.summary}</span>
              </div>
            {/if}

            {#if result.output?.files?.length}
              <div class="stack stack-2">
                <p class="field-label">Generated files</p>
                <ul class="output-list">
                  {#each result.output.files as file (file.url)}
                    <li class="output-row">
                      <span class="file-icon output"><Icon name={file.mime?.startsWith("image/") ? "image" : file.mime?.includes("pdf") ? "file-pdf" : "file"} size={12} /></span>
                      <span class="file-name" title={file.name}>{file.name}</span>
                      <span class="file-size mono">{formatBytes(file.size)}</span>
                      <a class="btn btn-secondary btn-sm" href={file.url} download={file.name}>
                        <Icon name="download" size={11} /> Save
                      </a>
                    </li>
                  {/each}
                </ul>
                {#each result.output.files.filter((f) => f.mime?.startsWith("image/")).slice(0, 2) as file (file.url)}
                  <img class="output-image" src={file.url} alt={file.name} />
                {/each}
              </div>
            {/if}

            {#if outputText()}
              <div class="stack stack-2">
                <div class="row row-between">
                  <p class="field-label">Result</p>
                  <button class="btn btn-ghost btn-sm" onclick={() => copyText(outputText())}>
                    <Icon name="copy" size={11} /> Copy
                  </button>
                </div>
                <pre class="code result-pre">{outputText()}</pre>
              </div>
            {/if}

            {#if result.output?.downloadId}
              <button class="btn btn-primary btn-sm" onclick={() => navigate("/downloads")}>
                <Icon name="download" size={12} /> Follow in Downloads
              </button>
            {/if}

            {#if result.output?.links?.length}
              <div class="row row-2 wrap">
                {#each result.output.links as link}
                  <button class="btn btn-secondary btn-sm" onclick={() => followLink(link.href)}>
                    {link.label} <Icon name="arrow-up-right" size={11} />
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <div class="result-idle">
            <span class="idle-art"><Icon name={TOOL_ICONS[tool.category] || "wrench"} size={22} /></span>
            <p class="result-title">Nothing run yet</p>
            <p class="result-sub">
              Fill in the input and run the tool. Output files are written under
              <span class="mono">data/outputs</span> and stay on this device.
            </p>
          </div>
        {/if}
      </section>
    </div>

    <section class="stack stack-3">
      <div class="row row-between">
        <h2 class="section-title">Recent runs of this tool</h2>
        {#if jobs.length}
          <button class="btn btn-ghost btn-sm" onclick={removeJobHistory}>
            <Icon name="trash" size={11} /> Clear job history
          </button>
        {/if}
      </div>
      {#if !jobs.length}
        <div class="pane job-empty">
          <Icon name="history" size={15} />
          <span>No runs recorded yet.</span>
        </div>
      {:else}
        <div class="pane job-list">
          {#each jobs as job (job.id)}
            <div class="job-row">
              <span class="dot" style="color: var(--{job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'accent'})"></span>
              <span class="job-main">
                <span class="job-name">{job.output?.summary || job.toolId}</span>
                <span class="job-meta">
                  {statusLabel(job.status)} · {formatRelative(job.createdAt)}
                  {#if job.error}· <span style="color: var(--error)">{job.error}</span>{/if}
                </span>
              </span>
              {#if job.output?.files?.length}
                <a class="btn btn-ghost btn-sm" href={job.output.files[0].url} download={job.output.files[0].name}>
                  <Icon name="download" size={11} /> Latest output
                </a>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>
{/if}

<style>
  .tool-head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding-top: 4px;
  }
  .tool-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: grid;
    place-content: center;
    background: var(--surface);
    border: 1px solid var(--content-border);
    color: var(--accent-text);
    flex: 0 0 auto;
  }
  .tool-heading {
    min-width: 0;
    flex: 1;
  }
  .tool-sub {
    font-size: 11.5px;
    color: var(--tertiary);
    line-height: 1.5;
    margin-top: 3px;
    max-width: 720px;
  }
  .tool-cat {
    font-size: 9.5px;
    color: var(--quaternary);
    margin-top: 4px;
    font-family: var(--font-mono);
  }
  .tool-cat button:hover {
    color: var(--accent-text);
    text-decoration: underline;
  }

  .warn-banner {
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
  .warn-banner.info {
    background: var(--blue-soft);
    color: var(--blue);
  }
  .warn-banner > :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
  }
  .warn-banner > div {
    flex: 1;
  }
  .warn-title {
    font-weight: 650;
  }
  .warn-text {
    opacity: 0.9;
  }

  .runner-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
    gap: var(--space-4);
    align-items: start;
  }
  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--content-border);
    min-height: 42px;
  }
  .run-pane,
  .result-pane {
    overflow: hidden;
  }

  .form-section {
    padding: 13px 14px 0;
  }
  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 11px;
    padding: 13px 14px;
  }
  .span-2 {
    grid-column: span 2;
  }
  .req {
    color: var(--error);
    margin-left: 2px;
  }
  .field-check {
    align-items: flex-start;
    padding-top: 3px;
  }
  .field-check input {
    margin-top: 2px;
  }

  .drop {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px;
    border-radius: 9px;
    border: 1.5px dashed var(--input-border);
    background: var(--surface-sunken);
    color: var(--tertiary);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease-out);
    text-align: left;
  }
  .drop:hover,
  .drop.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .drop :global(svg) {
    flex: 0 0 auto;
    color: var(--quaternary);
  }
  .drop-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .drop-title {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--secondary);
  }
  .drop-accept {
    font-size: 9.5px;
    color: var(--quaternary);
    font-family: var(--font-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hidden-input {
    display: none;
  }

  .file-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }
  .file-row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 7px;
    border-radius: 6px;
    background: var(--surface);
    border: 1px solid var(--content-border);
    font-size: 10.5px;
  }
  .file-icon {
    width: 21px;
    height: 21px;
    border-radius: 5px;
    display: grid;
    place-content: center;
    background: var(--surface-sunken);
    color: var(--tertiary);
    flex: 0 0 auto;
  }
  .file-icon.output {
    background: var(--success-soft);
    color: var(--success);
  }
  .file-name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-size {
    color: var(--quaternary);
    font-size: 9.5px;
    flex: 0 0 auto;
  }
  .file-remove {
    color: var(--quaternary);
    width: 18px;
    height: 18px;
    display: grid;
    place-content: center;
    border-radius: 4px;
    flex: 0 0 auto;
  }
  .file-remove:hover {
    color: var(--error);
    background: var(--error-soft);
  }

  .form-error {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0 14px 12px;
    padding: 8px 10px;
    border-radius: 7px;
    background: var(--error-soft);
    color: var(--error);
    font-size: 11px;
    line-height: 1.45;
  }
  .form-error :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
  }

  .run-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 11px 14px;
    border-top: 1px solid var(--content-border);
    background: var(--pane-alt);
    flex-wrap: wrap;
  }
  .run-hint {
    font-size: 9.5px;
    color: var(--quaternary);
  }

  .no-input {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 14px;
    padding: 10px;
    border-radius: 7px;
    background: var(--surface-sunken);
    color: var(--tertiary);
    font-size: 11px;
  }

  .result-body {
    padding: 13px 14px;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-height: 560px;
    overflow-y: auto;
  }
  .success-note {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    padding: 9px 11px;
    border-radius: 7px;
    background: var(--success-soft);
    color: var(--success);
    font-size: 11.5px;
    line-height: 1.45;
  }
  .success-note :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
  }
  .output-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .output-row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px;
    border-radius: 7px;
    border: 1px solid var(--content-border);
    background: var(--surface);
    font-size: 10.5px;
  }
  .output-image {
    border-radius: 8px;
    border: 1px solid var(--content-border);
    max-height: 170px;
    object-fit: contain;
    background: var(--surface-sunken);
    width: 100%;
  }
  .result-pre {
    max-height: 300px;
    font-size: 10px;
  }

  .result-idle,
  .result-loading,
  .result-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 6px;
    padding: var(--space-7) var(--space-5);
  }
  .idle-art,
  .running-art,
  .result-error-art {
    width: 54px;
    height: 54px;
    border-radius: 14px;
    display: grid;
    place-content: center;
    background: var(--surface-sunken);
    color: var(--quaternary);
    margin-bottom: 3px;
  }
  .running-art {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .result-error-art {
    background: var(--error-soft);
    color: var(--error);
  }
  .result-title {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 620;
    letter-spacing: -0.01em;
  }
  .result-sub {
    font-size: 11px;
    color: var(--tertiary);
    line-height: 1.5;
    max-width: 300px;
  }
  .result-error .result-sub {
    color: var(--error);
  }

  .job-list {
    overflow: hidden;
  }
  .job-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--content-border);
  }
  .job-row:last-child {
    border-bottom: 0;
  }
  .job-main {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
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
  }
  .job-empty {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 13px;
    font-size: 11px;
    color: var(--quaternary);
  }

  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 1000px) {
    .runner-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .result-body {
      max-height: none;
    }
  }
  @media (max-width: 640px) {
    .form-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .span-2 {
      grid-column: auto;
    }
    .tool-icon {
      display: none;
    }
  }
</style>
