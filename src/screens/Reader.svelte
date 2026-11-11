<script>
  import { onDestroy, tick } from "svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Modal from "../components/Modal.svelte";
  import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
  import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
  import { app, saveSettings, refreshBooks, refreshNotes, reportError, toast } from "../lib/state.svelte.js";
  import { bookApi, bookmarkApi, notesApi } from "../lib/api.js";
  import { formatBytes, formatDuration, formatRelative, pluralize } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  let { id } = $props();

  let book = $state(null);
  let loading = $state(true);
  let loadError = $state(null);
  let chapterIndex = $state(0);
  let chapter = $state(null);
  let chapterLoading = $state(false);
  let chapterError = $state(null);
  let notes = $state([]);
  let bookmarks = $state([]);
  let notesOpen = $state(false);
  let tocOpen = $state(false);
  let settingsOpen = $state(false);
  let noteDraft = $state("");
  let savingNote = $state(false);
  let quote = $state("");
  let scrollEl = $state(null);
  let epubHost = $state(null);
  let pdfCanvas = $state(null);
  let pdfDoc = $state(null);
  let pdfLoading = $state(false);
  let pdfError = $state(null);
  let page = $state(1);
  let pageCount = $state(0);
  let pageInput = $state("1");
  let zoom = $state(1);
  let renderToken = 0;
  let restoreScroll = false;
  let lastScrollSave = 0;
  let removeOpen = $state(false);
  let deleteFiles = $state(true);

  const readerSettings = $derived(
    app.settings?.reader || {
      theme: "paper",
      fontFamily: "serif",
      fontSize: 18,
      lineHeight: 1.7,
      pageWidth: 760,
      justify: false,
      pdfZoom: 1.15,
    },
  );

  const themes = {
    paper: { bg: "#f6f1e7", fg: "#2b2419", muted: "#7c715f" },
    light: { bg: "#ffffff", fg: "#1f1f22", muted: "#75736f" },
    sepia: { bg: "#efe3c8", fg: "#40331d", muted: "#857252" },
    dark: { bg: "#191817", fg: "#e8e4dc", muted: "#9a948a" },
  };
  const theme = $derived(themes[readerSettings.theme] || themes.paper);

  const fontStack = $derived(
    readerSettings.fontFamily === "sans"
      ? "var(--font-ui)"
      : readerSettings.fontFamily === "mono"
        ? "var(--font-mono)"
        : "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  );

  const chapterList = $derived(book?.chapters || []);
  const progress = $derived.by(() => {
    if (!book) return 0;
    if (book.format === "pdf") return pageCount ? page / pageCount : book.progress || 0;
    if (chapterList.length) return (chapterIndex + 1) / chapterList.length;
    return book.progress || 0;
  });
  const progressPercent = $derived(Math.round(progress * 100));

  const currentNoteMatches = $derived(
    bookmarks.filter((b) =>
      book?.format === "pdf" ? b.page === page : b.chapter === chapterIndex,
    ),
  );

  $effect(() => {
    const bookId = id;
    loadBook(bookId);
  });

  // The canvas only exists once the document has loaded and the loading branch
  // has been replaced. Rendering from an effect means the bind:this target is
  // always present when the paint starts (and page/zoom changes repaint).
  $effect(() => {
    if (!pdfDoc || !pdfCanvas) return;
    void zoom;
    void theme;
    void renderPdfPage();
  });

  let sessionStart = Date.now();

  $effect(() => {
    return () => {
      const seconds = Math.round((Date.now() - sessionStart) / 1000);
      if (book && seconds > 5) {
        bookApi
          .update(book.id, { seconds, chapter: chapterIndex, page, scroll: currentScrollFraction() })
          .catch(() => {});
      }
    };
  });

  async function loadBook(bookId) {
    loading = true;
    loadError = null;
    book = null;
    chapter = null;
    pdfDoc = null;
    pageCount = 0;
    try {
      const detail = await bookApi.get(bookId);
      book = detail;
      notes = detail.notes || [];
      bookmarks = detail.bookmarks || [];
      const resume = app.settings?.study?.autoResume !== false;
      chapterIndex = resume ? detail.lastChapter || 0 : 0;
      page = resume ? detail.lastPage || 1 : 1;
      pageInput = String(page);
      sessionStart = Date.now();
      if (detail.format === "epub") {
        await loadChapter(chapterIndex, resume);
      } else {
        await loadPdf(detail, resume);
      }
    } catch (err) {
      loadError = err?.message || "This book could not be opened.";
    } finally {
      loading = false;
    }
  }

  async function loadChapter(index, restore = false) {
    if (!book || book.format !== "epub") return;
    chapterLoading = true;
    chapterError = null;
    try {
      const res = await bookApi.chapter(book.id, index);
      chapter = res;
      chapterIndex = index;
      restoreScroll = restore;
      await tick();
      if (restore && scrollEl && book.lastScroll) {
        scrollEl.scrollTop = book.lastScroll * scrollEl.scrollHeight;
      }
      if (!chapter.title && chapterList[index]) {
        chapter = { ...chapter, title: chapterList[index].title };
      }
    } catch (err) {
      chapterError = err?.message || "This chapter could not be loaded.";
    } finally {
      chapterLoading = false;
    }
  }

  function goChapter(index) {
    if (index < 0 || index >= chapterList.length || index === chapterIndex) return;
    saveProgress({ chapter: chapterIndex });
    loadChapter(index);
    if (window.innerWidth <= 900) tocOpen = false;
  }

  async function loadPdf(detail, resume = true) {
    pdfLoading = true;
    pdfError = null;
    try {
      const task = pdfjs.getDocument({ url: `/api/books/${detail.id}/file`, withCredentials: false });
      pdfDoc = await task.promise;
      pageCount = pdfDoc.numPages;
      page = resume ? Math.min(Math.max(1, detail.lastPage || 1), pageCount) : 1;
      pageInput = String(page);
      await tick();
    } catch (err) {
      pdfError =
        err?.name === "PasswordException"
          ? "This PDF is password-protected. OmniGet cannot open encrypted PDFs."
          : err?.message || "The PDF could not be rendered.";
    } finally {
      pdfLoading = false;
    }
  }

  async function renderPdfPage() {
    if (!pdfDoc || !pdfCanvas) return;
    const token = ++renderToken;
    delete pdfCanvas.dataset.rendered;
    try {
      const pdfPage = await pdfDoc.getPage(page);
      if (token !== renderToken) return;
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const available = Math.max(280, (pdfCanvas.parentElement?.clientWidth || 700) - 40);
      const fit = available / baseViewport.width;
      const cssScale = fit * zoom;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const viewport = pdfPage.getViewport({ scale: cssScale });
      const context = pdfCanvas.getContext("2d", { alpha: false });
      pdfCanvas.width = Math.floor(viewport.width * dpr);
      pdfCanvas.height = Math.floor(viewport.height * dpr);
      pdfCanvas.style.width = `${Math.floor(viewport.width)}px`;
      pdfCanvas.style.height = `${Math.floor(viewport.height)}px`;
      context.fillStyle = theme.bg;
      context.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);
      await pdfPage.render({
        canvasContext: context,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise;
      if (token === renderToken) pdfCanvas.dataset.rendered = "true";
    } catch (err) {
      if (token === renderToken) {
        pdfCanvas.dataset.rendered = "error";
        pdfError = err?.message || "This page could not be rendered.";
      }
    }
  }

  function nextPage() {
    if (page >= pageCount) return;
    page += 1;
    pageInput = String(page);
    saveProgress({ page });
    scrollEl?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function prevPage() {
    if (page <= 1) return;
    page -= 1;
    pageInput = String(page);
    saveProgress({ page });
    scrollEl?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function jumpPage() {
    const next = Math.min(pageCount, Math.max(1, Number(pageInput) || 1));
    page = next;
    pageInput = String(next);
    saveProgress({ page });
  }

  function setZoom(next) {
    zoom = Math.min(3, Math.max(0.5, next));
  }

  async function saveProgress(extra = {}) {
    if (!book) return;
    try {
      const payload = {
        chapter: chapterIndex,
        page,
        scroll: currentScrollFraction(),
        ...extra,
      };
      if (book.format === "epub") payload.progress = progress;
      else payload.progress = pageCount ? page / pageCount : book.progress;
      const updated = await bookApi.update(book.id, payload);
      book = { ...book, ...updated };
    } catch {
      /* progress saves are best effort; failures surface on explicit actions */
    }
  }

  function currentScrollFraction() {
    if (!scrollEl || book?.format === "pdf") return 0;
    const max = scrollEl.scrollHeight - scrollEl.clientHeight;
    return max > 0 ? Math.min(1, Math.max(0, scrollEl.scrollTop / max)) : 0;
  }

  let scrollTimer = null;
  function onScroll() {
    if (book?.format !== "epub") return;
    const nowTs = Date.now();
    if (nowTs - lastScrollSave < 5000) return;
    lastScrollSave = nowTs;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => saveProgress(), 1200);
  }

  function captureSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (text) quote = text.slice(0, 500);
  }

  async function addNote() {
    const body = noteDraft.trim();
    if (!body) return;
    savingNote = true;
    try {
      const payload = {
        targetType: "book",
        targetId: book.id,
        body,
      };
      if (book.format === "pdf") {
        payload.page = page;
      } else {
        payload.chapter = chapterIndex;
        payload.position = currentScrollFraction();
      }
      if (quote) payload.body = `“${quote}”\n\n${body}`;
      const note = await notesApi.add(payload);
      notes = [note, ...notes];
      noteDraft = "";
      quote = "";
      await refreshNotes();
      toast("success", "Note saved beside this book.");
    } catch (err) {
      reportError(err, "The note could not be saved");
    } finally {
      savingNote = false;
    }
  }

  async function removeNote(note) {
    try {
      await notesApi.remove(note.id);
      notes = notes.filter((n) => n.id !== note.id);
      await refreshNotes();
    } catch (err) {
      reportError(err, "The note could not be deleted");
    }
  }

  async function addBookmark() {
    const label =
      book.format === "pdf"
        ? `Page ${page}`
        : chapter?.title || chapterList[chapterIndex]?.title || `Chapter ${chapterIndex + 1}`;
    try {
      const bookmark = await bookmarkApi.add({
        targetType: "book",
        targetId: book.id,
        label,
        chapter: book.format === "epub" ? chapterIndex : null,
        page: book.format === "pdf" ? page : null,
        position: currentScrollFraction(),
      });
      bookmarks = [...bookmarks, bookmark];
      toast("success", `Bookmark added: ${label}`);
    } catch (err) {
      reportError(err, "Could not add the bookmark");
    }
  }

  async function removeBookmark(bookmark) {
    try {
      await bookmarkApi.remove(bookmark.id);
      bookmarks = bookmarks.filter((b) => b.id !== bookmark.id);
    } catch (err) {
      reportError(err, "Could not remove the bookmark");
    }
  }

  function goBookmark(bookmark) {
    if (book.format === "pdf" && bookmark.page) {
      page = bookmark.page;
      pageInput = String(page);
      saveProgress({ page });
    } else if (bookmark.chapter !== null && bookmark.chapter !== undefined) {
      loadChapter(bookmark.chapter, true);
    }
  }

  async function updateReader(patchValue) {
    try {
      const next = { reader: { ...readerSettings, ...patchValue } };
      await saveSettings(next);
      if (book?.format === "pdf") {
        if (patchValue.pdfZoom) zoom = patchValue.pdfZoom;
      }
    } catch (err) {
      reportError(err, "The reader preference could not be saved");
    }
  }

  let savedFontTimer = null;
  function setFontSize(value) {
    const size = Math.min(34, Math.max(12, value));
    updateReader({ fontSize: size });
  }

  function onChapterClick(event) {
    const anchor = event.target.closest?.("a[data-chapter-index]");
    if (!anchor) return;
    event.preventDefault();
    goChapter(Number(anchor.dataset.chapterIndex));
  }

  $effect(() => {
    if (!epubHost || !chapter) return;
    const shadow = epubHost.shadowRoot || epubHost.attachShadow({ mode: "open" });
    const css = (chapter.css || [])
      .map((href) => `<link rel="stylesheet" href="${href}">`)
      .join("");
    shadow.innerHTML = `
      <style>
        :host { display: block; }
        * { max-width: 100%; }
        body { margin: 0; }
        .epub-body {
          font-family: ${fontStack};
          font-size: ${readerSettings.fontSize}px;
          line-height: ${readerSettings.lineHeight};
          color: ${theme.fg};
          background: transparent;
          text-align: ${readerSettings.justify ? "justify" : "left"};
          overflow-wrap: break-word;
        }
        .epub-body p { margin: 0 0 1em; }
        .epub-body h1, .epub-body h2, .epub-body h3 {
          font-family: ${readerSettings.fontFamily === "sans" ? "var(--font-display)" : "inherit"};
          line-height: 1.2;
          margin: 1.6em 0 0.7em;
          letter-spacing: -0.015em;
        }
        .epub-body img, .epub-body svg { max-width: 100%; height: auto; }
        .epub-body a { color: var(--accent-text); }
        .epub-body blockquote {
          margin: 1.2em 0; padding: 0.2em 0 0.2em 1em;
          border-left: 3px solid var(--accent);
          color: ${theme.muted};
        }
        .epub-body pre, .epub-body code { font-family: var(--font-mono); font-size: 0.85em; }
        .epub-body table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
        .epub-body td, .epub-body th { border: 1px solid ${theme.muted}44; padding: 4px 6px; }
        .epub-body hr { border: 0; border-top: 1px solid ${theme.muted}55; margin: 2em 0; }
      </style>
      ${css}
      <div class="epub-body">${chapter.html || ""}</div>
    `;
    shadow.onclick = onChapterClick;
    chapterError = null;
  });

  async function confirmRemove() {
    try {
      await bookApi.remove(book.id, deleteFiles);
      await refreshBooks();
      removeOpen = false;
      toast("success", "Book removed.");
      navigate("/study");
    } catch (err) {
      reportError(err, "Could not remove the book");
    }
  }

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pdfDoc) renderPdfPage();
    }, 220);
  }

  onDestroy(() => {
    clearTimeout(scrollTimer);
    clearTimeout(resizeTimer);
  });
</script>

<svelte:window onresize={onResize} onmouseup={captureSelection} />

{#if loading}
  <div class="content-inner reader-loading">
    <div class="skeleton" style="height: 26px; width: 34%"></div>
    <div class="skeleton" style="height: 12px; width: 20%"></div>
    <div class="skeleton" style="height: 60vh; width: 100%; border-radius: 14px"></div>
  </div>
{:else if loadError}
  <div class="content-inner">
    <div class="pane reader-error">
      <EmptyState
        icon="alert-circle"
        title="This book could not be opened"
        message={loadError}
        actionLabel="Back to library"
        onAction={() => navigate("/study")}
        secondaryLabel="Retry"
        onSecondary={() => loadBook(id)}
      />
    </div>
  </div>
{:else if book}
  <div class="reader" style="--reader-bg: {theme.bg}; --reader-fg: {theme.fg}; --reader-muted: {theme.muted}">
    <header class="reader-head">
      <div class="reader-head-left">
        <button class="btn btn-ghost btn-icon btn-sm" onclick={() => navigate("/study")} title="Back to library">
          <Icon name="arrow-left" size={15} />
        </button>
        <button class="btn btn-ghost btn-icon btn-sm toc-toggle" onclick={() => (tocOpen = !tocOpen)} title="Contents">
          <Icon name="list-view" size={15} />
        </button>
        <div class="reader-title-wrap">
          <p class="reader-title" title={book.title}>{book.title}</p>
          <p class="reader-sub">
            {book.author || "Unknown author"} · {book.format.toUpperCase()}
            {#if book.format === "epub" && chapterList.length}
              · Chapter {chapterIndex + 1} of {chapterList.length}
            {:else if book.format === "pdf" && pageCount}
              · Page {page} of {pageCount}
            {/if}
          </p>
        </div>
      </div>

      <div class="reader-head-right">
        <div class="reader-progress" title="{progressPercent}% through the book">
          <div class="progress" style="height: 4px; width: 84px">
            <div class="progress-fill" style="width: {progressPercent}%"></div>
          </div>
          <span class="mono">{progressPercent}%</span>
        </div>
        <button class="btn btn-ghost btn-icon btn-sm" onclick={addBookmark} title="Bookmark this spot">
          <Icon name={currentNoteMatches.length ? "bookmark-filled" : "bookmark"} size={15} />
        </button>
        <button class="btn btn-ghost btn-icon btn-sm" class:active={notesOpen} onclick={() => (notesOpen = !notesOpen)} title="Notes and bookmarks">
          <Icon name="note" size={15} />
          {#if notes.length}<span class="mini-count">{notes.length}</span>{/if}
        </button>
        <button class="btn btn-ghost btn-icon btn-sm" class:active={settingsOpen} onclick={() => (settingsOpen = !settingsOpen)} title="Reading settings">
          <Icon name="sliders" size={15} />
        </button>
        <button class="btn btn-ghost btn-icon btn-sm" onclick={() => (removeOpen = true)} title="Remove book">
          <Icon name="trash" size={15} />
        </button>
      </div>
    </header>

    {#if settingsOpen}
      <div class="settings-pop">
        <div class="pop-row">
          <span class="pop-label">Theme</span>
          <div class="swatches">
            {#each [["paper", "#f6f1e7"], ["light", "#ffffff"], ["sepia", "#efe3c8"], ["dark", "#191817"]] as [value, color]}
              <button
                class="swatch"
                class:active={readerSettings.theme === value}
                style="background: {color}"
                onclick={() => updateReader({ theme: value })}
                title={value}
                aria-label={`${value} theme`}
              ></button>
            {/each}
          </div>
        </div>
        <div class="pop-row">
          <span class="pop-label">Typeface</span>
          <div class="tabs">
            {#each [["serif", "Serif"], ["sans", "Sans"], ["mono", "Mono"]] as [value, label]}
              <button class="tab" aria-selected={readerSettings.fontFamily === value} onclick={() => updateReader({ fontFamily: value })}>
                {label}
              </button>
            {/each}
          </div>
        </div>
        {#if book.format === "epub"}
          <div class="pop-row">
            <span class="pop-label">Text size</span>
            <div class="row row-2">
              <button class="btn btn-secondary btn-icon btn-sm" onclick={() => setFontSize(readerSettings.fontSize - 1)}>
                <Icon name="minus" size={11} />
              </button>
              <span class="pop-value mono">{Math.round(readerSettings.fontSize)}px</span>
              <button class="btn btn-secondary btn-icon btn-sm" onclick={() => setFontSize(readerSettings.fontSize + 1)}>
                <Icon name="plus" size={11} />
              </button>
            </div>
          </div>
          <div class="pop-row">
            <span class="pop-label">Line height</span>
            <input
              type="range"
              min="1.2"
              max="2.4"
              step="0.05"
              value={readerSettings.lineHeight}
              oninput={(e) => (savedFontTimer = setTimeout(() => updateReader({ lineHeight: Number(e.currentTarget.value) }), 250))}
            />
          </div>
          <div class="pop-row">
            <span class="pop-label">Page width</span>
            <input
              type="range"
              min="480"
              max="1100"
              step="20"
              value={readerSettings.pageWidth}
              oninput={(e) => (savedFontTimer = setTimeout(() => updateReader({ pageWidth: Number(e.currentTarget.value) }), 250))}
            />
          </div>
          <label class="checkbox pop-check">
            <input
              type="checkbox"
              checked={readerSettings.justify}
              onchange={(e) => updateReader({ justify: e.currentTarget.checked })}
            />
            Justify text
          </label>
        {:else}
          <div class="pop-row">
            <span class="pop-label">Zoom</span>
            <div class="row row-2">
              <button class="btn btn-secondary btn-icon btn-sm" onclick={() => setZoom(zoom - 0.15)}>
                <Icon name="zoom-out" size={12} />
              </button>
              <span class="pop-value mono">{Math.round(zoom * 100)}%</span>
              <button class="btn btn-secondary btn-icon btn-sm" onclick={() => setZoom(zoom + 0.15)}>
                <Icon name="zoom-in" size={12} />
              </button>
            </div>
          </div>
        {/if}
        <p class="pop-hint">Preferences are saved to Settings and apply to every book.</p>
      </div>
    {/if}

    <div class="reader-layout" class:with-notes={notesOpen} class:with-toc={tocOpen}>
      {#if tocOpen}
        <aside class="toc">
          <div class="toc-head">
            <p class="eyebrow">{book.format === "pdf" ? "Document" : "Contents"}</p>
            <button class="btn btn-ghost btn-icon btn-sm toc-close" onclick={() => (tocOpen = false)}>
              <Icon name="x" size={13} />
            </button>
          </div>
          {#if book.format === "epub"}
            {#if chapterError}
              <p class="toc-error">{chapterError}</p>
            {/if}
            <nav class="toc-list">
              {#each chapterList as ch (ch.idx)}
                <button
                  class="toc-item"
                  class:active={ch.idx === chapterIndex}
                  onclick={() => goChapter(ch.idx)}
                  title={ch.title}
                >
                  <span class="toc-num mono">{String(ch.idx + 1).padStart(2, "0")}</span>
                  <span class="toc-name">{ch.title}</span>
                </button>
              {/each}
              {#if !chapterList.length}
                <p class="toc-empty">This EPUB has no detected chapters.</p>
              {/if}
            </nav>
          {:else}
            <div class="toc-pdf">
              <label class="field">
                <span class="field-label">Jump to page</span>
                <div class="row row-2">
                  <input
                    class="input"
                    bind:value={pageInput}
                    onkeydown={(e) => e.key === "Enter" && jumpPage()}
                    inputmode="numeric"
                    aria-label="Page number"
                  />
                  <button class="btn btn-secondary btn-sm" onclick={jumpPage}>Go</button>
                </div>
              </label>
              <div class="pdf-facts">
                <div><span>Pages</span><span class="mono">{pageCount || "—"}</span></div>
                <div><span>Size</span><span class="mono">{formatBytes(book.metadata?.size || 0)}</span></div>
                <div><span>Format</span><span class="mono">PDF</span></div>
              </div>
              <p class="toc-note">
                Pages render locally with PDF.js. Text stays inside this device and is never uploaded.
              </p>
            </div>
          {/if}

          {#if bookmarks.length}
            <div class="toc-bookmarks">
              <p class="eyebrow">Bookmarks</p>
              {#each bookmarks as mark (mark.id)}
                <div class="toc-bookmark">
                  <button onclick={() => goBookmark(mark)} title={mark.label}>
                    <Icon name="bookmark" size={11} />
                    <span>{mark.label}</span>
                  </button>
                  <button class="mark-remove" onclick={() => removeBookmark(mark)} aria-label="Remove bookmark">
                    <Icon name="x" size={10} />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </aside>
      {/if}

      <section class="reader-scroll" bind:this={scrollEl} onscroll={onScroll}>
        {#if book.format === "epub"}
          {#if chapterLoading && !chapter}
            <div class="chapter-skeletons">
              <div class="skeleton" style="height: 20px; width: 42%"></div>
              {#each [92, 88, 96, 74, 90, 60] as width}
                <div class="skeleton" style="height: 11px; width: {width}%"></div>
              {/each}
            </div>
          {:else if chapterError && !chapter}
            <div class="chapter-error">
              <Icon name="alert-circle" size={20} />
              <p>{chapterError}</p>
              <button class="btn btn-secondary btn-sm" onclick={() => loadChapter(chapterIndex)}>Try again</button>
            </div>
          {:else}
            {#if chapter?.title}
              <p class="chapter-eyebrow">{chapter.title}</p>
            {/if}
            <div class="epub-host" bind:this={epubHost} style="max-width: {readerSettings.pageWidth}px"></div>
            {#if chapterLoading}<div class="chapter-loading"><Icon name="loader" size={13} class="spin" /> Loading chapter…</div>{/if}
          {/if}
        {:else}
          {#if pdfLoading && !pdfDoc}
            <div class="pdf-skeleton">
              <Icon name="loader" size={22} class="spin" />
              <p>Rendering the PDF locally…</p>
            </div>
          {:else if pdfError}
            <div class="chapter-error">
              <Icon name="alert-circle" size={20} />
              <p>{pdfError}</p>
              <button class="btn btn-secondary btn-sm" onclick={() => loadPdf(book)}>Try again</button>
            </div>
          {:else}
            <div class="pdf-stage">
              <canvas bind:this={pdfCanvas} aria-label={`Page ${page}`}></canvas>
            </div>
          {/if}
        {/if}
      </section>

      {#if notesOpen}
        <aside class="notes-panel">
          <div class="notes-head">
            <div>
              <p class="eyebrow">Marginalia</p>
              <p class="notes-count">{pluralize(notes.length, "note")} · {pluralize(bookmarks.length, "bookmark")}</p>
            </div>
            <button class="btn btn-ghost btn-icon btn-sm" onclick={() => (notesOpen = false)} aria-label="Close notes">
              <Icon name="x" size={13} />
            </button>
          </div>

          <div class="note-form">
            {#if quote}
              <div class="quote-box">
                <span class="quote-text">“{quote}”</span>
                <button class="quote-clear" onclick={() => (quote = "")} aria-label="Clear quote">
                  <Icon name="x" size={10} />
                </button>
              </div>
            {/if}
            <textarea
              class="textarea note-input"
              bind:value={noteDraft}
              placeholder={book.format === "pdf" ? `A note about page ${page}…` : "A note about this chapter…"}
              aria-label="New note"
            ></textarea>
            <div class="row row-between">
              <span class="field-hint">
                {book.format === "pdf" ? `Page ${page}` : chapterList[chapterIndex]?.title || `Chapter ${chapterIndex + 1}`}
              </span>
              <button class="btn btn-primary btn-sm" onclick={addNote} disabled={!noteDraft.trim() || savingNote}>
                {#if savingNote}<Icon name="loader" size={11} class="spin" />{:else}<Icon name="plus" size={11} />{/if}
                Save note
              </button>
            </div>
            <p class="field-hint">Select text in the book first to quote it in the note.</p>
          </div>

          <div class="notes-list">
            {#if !notes.length}
              <p class="notes-empty">No notes yet. Your annotations stay on this device.</p>
            {/if}
            {#each notes as note (note.id)}
              <div class="note-item">
                <div class="note-item-head">
                  <span class="note-loc">
                    <Icon name="bookmark" size={10} />
                    {note.page ? `Page ${note.page}` : note.chapter !== null ? `Chapter ${note.chapter + 1}` : "Book"}
                    · {formatRelative(note.createdAt)}
                  </span>
                  <button class="mark-remove" onclick={() => removeNote(note)} aria-label="Delete note">
                    <Icon name="trash" size={11} />
                  </button>
                </div>
                <p class="note-body">{note.body}</p>
              </div>
            {/each}
          </div>
        </aside>
      {/if}
    </div>

    <footer class="reader-foot">
      {#if book.format === "epub"}
        <button class="btn btn-secondary btn-sm" onclick={() => goChapter(chapterIndex - 1)} disabled={chapterIndex <= 0}>
          <Icon name="chevron-left" size={12} /> Previous
        </button>
        <span class="foot-center mono">
          {chapterList[chapterIndex]?.title || `Chapter ${chapterIndex + 1}`}
        </span>
        <button
          class="btn btn-secondary btn-sm"
          onclick={() => goChapter(chapterIndex + 1)}
          disabled={chapterIndex >= chapterList.length - 1}
        >
          Next <Icon name="chevron-right" size={12} />
        </button>
      {:else}
        <button class="btn btn-secondary btn-sm" onclick={prevPage} disabled={page <= 1}>
          <Icon name="chevron-left" size={12} /> Previous page
        </button>
        <div class="page-jump">
          <input
            class="input page-input"
            bind:value={pageInput}
            onkeydown={(e) => e.key === "Enter" && jumpPage()}
            aria-label="Page number"
            inputmode="numeric"
          />
          <span class="mono faint">/ {pageCount}</span>
        </div>
        <button class="btn btn-secondary btn-sm" onclick={nextPage} disabled={page >= pageCount}>
          Next page <Icon name="chevron-right" size={12} />
        </button>
      {/if}
    </footer>
  </div>

  <Modal open={removeOpen} title="Remove book?" subtitle={book.title} onClose={() => (removeOpen = false)}>
    <div class="stack stack-4">
      <p style="font-size: 12px; line-height: 1.6; color: var(--tertiary)">
        Reading progress, notes and bookmarks for this book will be deleted.
      </p>
      <label class="checkbox">
        <input type="checkbox" bind:checked={deleteFiles} />
        Delete the book file from disk
      </label>
      <div class="row row-end row-2">
        <button class="btn btn-secondary btn-sm" onclick={() => (removeOpen = false)}>Cancel</button>
        <button class="btn btn-danger btn-sm" onclick={confirmRemove}>
          <Icon name="trash" size={12} /> Remove book
        </button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .reader-loading {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .reader {
    height: calc(100vh - var(--toolbar-h) - var(--space-9) - 8px);
    min-height: 520px;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--content-border);
    border-radius: var(--radius-lg);
    background: var(--reader-bg);
    overflow: hidden;
    box-shadow: var(--elev-1);
    margin: 0 auto;
    max-width: 1400px;
  }

  .reader-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 8px 12px;
    border-bottom: 1px solid var(--content-border);
    background: color-mix(in srgb, var(--reader-bg) 92%, var(--surface));
    flex: 0 0 auto;
    flex-wrap: wrap;
  }
  .reader-head-left {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .reader-title-wrap {
    min-width: 0;
    margin-left: 4px;
  }
  .reader-title {
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 640;
    letter-spacing: -0.015em;
    color: var(--reader-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 44vw;
  }
  .reader-sub {
    font-size: 10px;
    color: var(--reader-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .reader-head-right {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .reader-progress {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-right: 6px;
    font-size: 10px;
    color: var(--reader-muted);
  }
  .reader-head-right :global(.btn) {
    color: var(--reader-muted);
  }
  .reader-head-right :global(.btn:hover),
  .reader-head-right :global(.btn.active) {
    color: var(--reader-fg);
    background: color-mix(in srgb, var(--reader-fg) 8%, transparent);
  }
  .mini-count {
    position: absolute;
    top: -1px;
    right: 0;
    font-family: var(--font-mono);
    font-size: 8px;
    color: var(--accent-text);
  }

  .settings-pop {
    position: relative;
    z-index: 20;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 10px 22px;
    padding: 12px 16px;
    background: var(--popup-bg);
    border-bottom: 1px solid var(--content-border);
    box-shadow: var(--elev-1);
  }
  .pop-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .pop-label {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--tertiary);
  }
  .pop-value {
    font-size: 10.5px;
    color: var(--tertiary);
    min-width: 38px;
    text-align: center;
  }
  .pop-row :global(input[type="range"]) {
    max-width: 130px;
  }
  .pop-check {
    font-size: 11px;
  }
  .pop-hint {
    grid-column: 1 / -1;
    font-size: 9.5px;
    color: var(--quaternary);
  }
  .swatches {
    display: flex;
    gap: 5px;
  }
  .swatch {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--input-border);
    transition: box-shadow var(--duration-fast) var(--ease-out);
  }
  .swatch.active {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .reader-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    transition: grid-template-columns var(--duration-base) var(--ease-out);
  }
  .reader-layout.with-toc {
    grid-template-columns: 236px minmax(0, 1fr);
  }
  .reader-layout.with-notes {
    grid-template-columns: minmax(0, 1fr) 288px;
  }
  .reader-layout.with-toc.with-notes {
    grid-template-columns: 236px minmax(0, 1fr) 288px;
  }

  .toc {
    border-right: 1px solid color-mix(in srgb, var(--reader-fg) 12%, transparent);
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: color-mix(in srgb, var(--reader-bg) 70%, var(--surface-sunken));
  }
  .toc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 12px 6px;
    flex: 0 0 auto;
  }
  .toc-close {
    display: none;
  }
  .toc-list {
    overflow-y: auto;
    padding: 4px 6px 12px;
    flex: 1;
    min-height: 0;
  }
  .toc-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    border-radius: 6px;
    text-align: left;
    font-size: 11px;
    line-height: 1.4;
    color: var(--reader-fg);
    opacity: 0.78;
  }
  .toc-item:hover {
    background: color-mix(in srgb, var(--reader-fg) 6%, transparent);
    opacity: 1;
  }
  .toc-item.active {
    background: var(--accent-soft);
    color: var(--accent-text);
    opacity: 1;
    font-weight: 600;
  }
  .toc-num {
    font-size: 9px;
    color: var(--reader-muted);
    padding-top: 2px;
    flex: 0 0 auto;
  }
  .toc-name {
    flex: 1;
    min-width: 0;
  }
  .toc-empty,
  .toc-note,
  .toc-error {
    padding: 10px 12px;
    font-size: 10.5px;
    color: var(--reader-muted);
    line-height: 1.5;
  }
  .toc-error {
    color: var(--error);
  }

  .toc-pdf {
    padding: 4px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .pdf-facts {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 10.5px;
    color: var(--reader-muted);
  }
  .pdf-facts > div {
    display: flex;
    justify-content: space-between;
  }

  .toc-bookmarks {
    border-top: 1px solid color-mix(in srgb, var(--reader-fg) 10%, transparent);
    padding: 8px 6px 12px;
    max-height: 40%;
    overflow-y: auto;
    flex: 0 0 auto;
  }
  .toc-bookmark {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .toc-bookmark > button:first-child {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 5px;
    font-size: 10.5px;
    color: var(--reader-fg);
    text-align: left;
    min-width: 0;
  }
  .toc-bookmark > button:first-child span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .toc-bookmark > button:hover {
    background: color-mix(in srgb, var(--reader-fg) 7%, transparent);
  }
  .mark-remove {
    color: var(--reader-muted);
    padding: 3px;
    border-radius: 4px;
    flex: 0 0 auto;
  }
  .mark-remove:hover {
    color: var(--error);
  }

  .reader-scroll {
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--space-5) var(--space-6) var(--space-8);
    scroll-behavior: smooth;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .chapter-eyebrow {
    width: 100%;
    max-width: 760px;
    font-size: 10px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--reader-muted);
    margin-bottom: var(--space-4);
    font-weight: 600;
  }
  .epub-host {
    width: 100%;
    color: var(--reader-fg);
  }
  .chapter-loading {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: var(--space-4);
    font-size: 10.5px;
    color: var(--reader-muted);
  }
  .chapter-skeletons {
    width: 100%;
    max-width: 680px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: var(--space-4);
  }
  .chapter-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    padding: var(--space-7) var(--space-4);
    color: var(--error);
    font-size: 12px;
    max-width: 420px;
  }
  .chapter-error p {
    line-height: 1.55;
  }

  .pdf-stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
  }
  .pdf-stage canvas {
    border-radius: 3px;
    box-shadow: var(--elev-2);
    background: #fff;
  }
  .pdf-skeleton {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: var(--space-8);
    color: var(--reader-muted);
    font-size: 11.5px;
  }

  .notes-panel {
    border-left: 1px solid color-mix(in srgb, var(--reader-fg) 12%, transparent);
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: color-mix(in srgb, var(--reader-bg) 88%, var(--surface));
  }
  .notes-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 12px 12px 8px;
    flex: 0 0 auto;
  }
  .notes-count {
    font-size: 9.5px;
    color: var(--reader-muted);
    margin-top: 1px;
  }
  .note-form {
    padding: 0 12px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--reader-fg) 10%, transparent);
    display: flex;
    flex-direction: column;
    gap: 7px;
    flex: 0 0 auto;
  }
  .note-input {
    min-height: 74px;
    font-size: 11.5px;
    background: color-mix(in srgb, var(--reader-bg) 60%, var(--surface));
    border-color: color-mix(in srgb, var(--reader-fg) 16%, transparent);
    color: var(--reader-fg);
  }
  .quote-box {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: 10px;
    line-height: 1.45;
  }
  .quote-text {
    flex: 1;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-style: italic;
  }
  .quote-clear {
    color: inherit;
    flex: 0 0 auto;
  }
  .note-form :global(.field-hint) {
    color: var(--reader-muted);
  }

  .notes-list {
    overflow-y: auto;
    padding: 8px 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-height: 0;
  }
  .notes-empty {
    font-size: 10.5px;
    color: var(--reader-muted);
    line-height: 1.5;
    padding: 8px 2px;
  }
  .note-item {
    padding: 8px 9px;
    border-radius: 7px;
    background: color-mix(in srgb, var(--reader-bg) 55%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--reader-fg) 10%, transparent);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .note-item-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }
  .note-loc {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 8.5px;
    color: var(--reader-muted);
  }
  .note-loc :global(svg) {
    color: var(--accent-text);
  }
  .note-body {
    font-size: 11px;
    line-height: 1.55;
    color: var(--reader-fg);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .reader-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 8px 12px;
    border-top: 1px solid color-mix(in srgb, var(--reader-fg) 12%, transparent);
    background: color-mix(in srgb, var(--reader-bg) 92%, var(--surface));
    flex: 0 0 auto;
  }
  .foot-center {
    font-size: 9.5px;
    color: var(--reader-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40%;
  }
  .page-jump {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
  }
  .page-input {
    width: 52px;
    height: 26px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .reader-error {
    max-width: 520px;
    margin: 6vh auto;
  }

  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 1100px) {
    .reader-layout.with-toc.with-notes {
      grid-template-columns: 210px minmax(0, 1fr);
    }
    .reader-layout.with-toc.with-notes .notes-panel {
      display: none;
    }
  }

  @media (max-width: 900px) {
    .reader-layout.with-toc,
    .reader-layout.with-toc.with-notes {
      grid-template-columns: minmax(0, 1fr);
    }
    .toc {
      position: absolute;
      z-index: 30;
      inset: 0 auto 0 0;
      width: 270px;
      box-shadow: var(--elev-3);
    }
    .reader {
      position: relative;
    }
    .reader-layout {
      position: relative;
    }
    .toc-close {
      display: grid;
    }
    .reader-progress {
      display: none;
    }
  }

  @media (max-width: 700px) {
    .reader {
      height: calc(100vh - var(--toolbar-h) - 108px);
      border-radius: var(--radius-md);
    }
    .reader-scroll {
      padding: var(--space-4) var(--space-4) var(--space-6);
    }
    .reader-layout.with-notes {
      grid-template-columns: minmax(0, 1fr);
    }
    .notes-panel {
      position: absolute;
      z-index: 25;
      inset: 0 0 0 auto;
      width: 290px;
      box-shadow: var(--elev-3);
    }
    .reader-title {
      max-width: 38vw;
    }
    .foot-center {
      display: none;
    }
  }
</style>
