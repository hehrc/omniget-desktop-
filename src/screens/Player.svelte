<script>
  import { onDestroy } from "svelte";
  import Icon from "../components/Icon.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Modal from "../components/Modal.svelte";
  import {
    app,
    refreshMedia,
    refreshNotes,
    reportError,
    toast,
  } from "../lib/state.svelte.js";
  import { bookmarkApi, mediaApi, notesApi } from "../lib/api.js";
  import { clamp, formatBytes, formatDuration, formatRelative, pluralize } from "../lib/format.js";
  import { navigate } from "../lib/router.js";

  let { id } = $props();

  let media = $state(null);
  let loading = $state(true);
  let loadError = $state(null);
  let videoEl = $state(null);
  let stageEl = $state(null);
  let playing = $state(false);
  let ready = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);
  let buffered = $state(0);
  let volume = $state(0.9);
  let muted = $state(false);
  let rate = $state(1);
  let loop = $state(false);
  let waiting = $state(false);
  let mediaError = $state(null);
  let notes = $state([]);
  let bookmarks = $state([]);
  let notesOpen = $state(false);
  let noteDraft = $state("");
  let savingNote = $state(false);
  let showSubs = $state(true);
  let activeSub = $state("");
  let subMenu = $state(false);
  let removeOpen = $state(false);
  let deleteFile = $state(true);
  let subInput = $state(null);
  let uploadingSub = $state(false);

  let lastSaved = 0;
  let watchedBuffer = 0;
  let lastTick = 0;
  let resumeApplied = false;
  let sessionStart = Date.now();

  const playback = $derived(
    app.settings?.playback || {
      autoplay: false,
      defaultVolume: 0.9,
      defaultRate: 1,
      rememberPosition: true,
      subtitleSize: 1,
      subtitleColor: "#ffffff",
      subtitleBackground: 0.65,
      seekStep: 5,
      loop: false,
    },
  );

  const seekStep = $derived(Number(playback.seekStep) || 5);

  $effect(() => {
    const mediaId = id;
    load(mediaId);
  });

  async function load(mediaId) {
    loading = true;
    loadError = null;
    media = null;
    ready = false;
    playing = false;
    mediaError = null;
    duration = 0;
    currentTime = 0;
    resumeApplied = false;
    lastSaved = 0;
    watchedBuffer = 0;
    try {
      const detail = await mediaApi.get(mediaId);
      media = detail.media || detail;
      duration = media.duration || 0;
      volume = playback.defaultVolume ?? 0.9;
      rate = playback.defaultRate ?? 1;
      loop = !!playback.loop;
      const [notesRes, marksRes] = await Promise.all([
        notesApi.list({ targetType: "media", targetId: mediaId }),
        bookmarkApi.list("media", mediaId),
      ]);
      notes = notesRes.notes;
      bookmarks = marksRes.bookmarks;
      sessionStart = Date.now();
    } catch (err) {
      loadError = err?.message || "This media item could not be opened.";
    } finally {
      loading = false;
    }
  }

  function onLoadedMetadata() {
    if (!videoEl) return;
    duration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
    videoEl.volume = clamp(volume, 0, 1);
    videoEl.playbackRate = rate;
    videoEl.loop = loop;
    if (!resumeApplied && playback.rememberPosition && media?.position > 5 && duration && media.position < duration - 3) {
      videoEl.currentTime = media.position;
      currentTime = media.position;
    }
    resumeApplied = true;
    ready = true;
    syncTextTracks();
    if (playback.autoplay) videoEl.play().catch(() => {});
  }

  function onTimeUpdate() {
    if (!videoEl) return;
    currentTime = videoEl.currentTime;
    if (videoEl.buffered.length) {
      buffered = videoEl.buffered.end(videoEl.buffered.length - 1);
    }
    if (playing) {
      const diff = currentTime - lastTick;
      if (diff > 0 && diff < 3) watchedBuffer += diff;
      lastTick = currentTime;
    }
    const nowTs = Date.now();
    if (nowTs - lastSaved > 10000) saveProgress(false);
  }

  async function saveProgress(force = true) {
    if (!media || !videoEl) return;
    const nowTs = Date.now();
    if (!force && nowTs - lastSaved < 8000) return;
    lastSaved = nowTs;
    try {
      const updated = await mediaApi.update(media.id, {
        position: videoEl.currentTime,
        duration: Number.isFinite(videoEl.duration) ? videoEl.duration : duration,
        watchedDelta: Math.round(watchedBuffer * 10) / 10,
      });
      watchedBuffer = 0;
      media = { ...media, ...updated };
      const index = app.media.findIndex((m) => m.id === media.id);
      if (index !== -1) app.media[index] = { ...app.media[index], ...updated };
    } catch {
      /* playback should never be interrupted by a progress-save failure */
    }
  }

  function togglePlay() {
    if (!videoEl || mediaError) return;
    if (videoEl.paused) {
      videoEl.play().catch((err) => {
        mediaError = err?.message || "The browser could not start playback.";
      });
    } else {
      videoEl.pause();
    }
  }

  function seekBy(seconds) {
    if (!videoEl) return;
    videoEl.currentTime = clamp(videoEl.currentTime + seconds, 0, duration || videoEl.duration || 0);
    currentTime = videoEl.currentTime;
  }

  function seekTo(seconds) {
    if (!videoEl) return;
    videoEl.currentTime = clamp(seconds, 0, duration || 0);
    currentTime = videoEl.currentTime;
  }

  function onSeekInput(event) {
    seekTo(Number(event.currentTarget.value));
  }

  function onVolume(event) {
    volume = clamp(Number(event.currentTarget.value), 0, 1);
    if (videoEl) {
      videoEl.volume = volume;
      videoEl.muted = volume === 0;
      muted = videoEl.muted;
    }
  }

  function toggleMute() {
    if (!videoEl) return;
    videoEl.muted = !videoEl.muted;
    muted = videoEl.muted;
  }

  function setRate(value) {
    rate = Number(value);
    if (videoEl) videoEl.playbackRate = rate;
    if (app.settings?.playback) app.settings.playback.defaultRate = rate;
  }

  function toggleLoop() {
    loop = !loop;
    if (videoEl) videoEl.loop = loop;
  }

  async function toggleFullscreen() {
    if (!stageEl) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stageEl.requestFullscreen();
    } catch {
      toast("warning", "Fullscreen is not available in this browser.");
    }
  }

  function syncTextTracks() {
    if (!videoEl) return;
    const tracks = videoEl.textTracks;
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      const match = media?.subtitles?.[i];
      const shouldShow = showSubs && activeSub && match && activeSub === match.id;
      track.mode = shouldShow ? "showing" : "disabled";
    }
  }

  function chooseSub(idValue) {
    activeSub = idValue;
    showSubs = !!idValue;
    subMenu = false;
    syncTextTracks();
  }

  function toggleSubs() {
    if (!media?.subtitles?.length) {
      toast("info", "No subtitle tracks attached. Add an SRT or VTT file below.");
      return;
    }
    if (!activeSub) {
      chooseSub(media.subtitles[0].id);
      return;
    }
    showSubs = !showSubs;
    syncTextTracks();
  }

  async function addSubtitle(files) {
    const file = files?.[0];
    if (!file) return;
    uploadingSub = true;
    try {
      await mediaApi.addSubtitle(media.id, file, { label: file.name.replace(/\.[^.]+$/, "") });
      const fresh = await mediaApi.get(media.id);
      media = fresh;
      await refreshMedia();
      if (fresh.subtitles?.length) chooseSub(fresh.subtitles[fresh.subtitles.length - 1].id);
      toast("success", "Subtitle track converted to WebVTT and attached.");
    } catch (err) {
      reportError(err, "The subtitle file could not be added");
    } finally {
      uploadingSub = false;
      if (subInput) subInput.value = "";
    }
  }

  async function removeSubtitle(sub) {
    try {
      await mediaApi.removeSubtitle(media.id, sub.id);
      const fresh = await mediaApi.get(media.id);
      media = fresh;
      if (activeSub === sub.id) activeSub = "";
      await refreshMedia();
      syncTextTracks();
    } catch (err) {
      reportError(err, "Could not remove the subtitle track");
    }
  }

  async function addNote() {
    const body = noteDraft.trim();
    if (!body) return;
    savingNote = true;
    try {
      const note = await notesApi.add({
        targetType: "media",
        targetId: media.id,
        body,
        timeSeconds: Math.round(currentTime * 10) / 10,
      });
      notes = [...notes, note].sort((a, b) => (b.timeSeconds || 0) - (a.timeSeconds || 0));
      noteDraft = "";
      await refreshNotes();
      toast("success", `Note saved at ${formatDuration(currentTime, { forceHours: duration >= 3600 })}.`);
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
    const label = `${formatDuration(currentTime, { forceHours: duration >= 3600 })} in ${media.title}`;
    try {
      const mark = await bookmarkApi.add({
        targetType: "media",
        targetId: media.id,
        label,
        position: currentTime,
      });
      bookmarks = [...bookmarks, mark];
      toast("success", `Bookmarked ${formatDuration(currentTime)}.`);
    } catch (err) {
      reportError(err, "Could not add the bookmark");
    }
  }

  async function removeBookmark(mark) {
    try {
      await bookmarkApi.remove(mark.id);
      bookmarks = bookmarks.filter((b) => b.id !== mark.id);
    } catch (err) {
      reportError(err, "Could not remove the bookmark");
    }
  }

  async function confirmRemove() {
    try {
      await mediaApi.remove(media.id, deleteFile);
      await refreshMedia();
      toast("success", deleteFile ? "Media file deleted." : "Removed from the player.");
      navigate("/media");
    } catch (err) {
      reportError(err, "Could not remove the media item");
    }
  }

  function onKeydown(event) {
    const tag = document.activeElement?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!media) return;
    const key = event.key.toLowerCase();
    if (event.code === "Space" || key === "k") {
      event.preventDefault();
      togglePlay();
    } else if (key === "arrowright" || key === "l") {
      event.preventDefault();
      seekBy(seekStep);
    } else if (key === "arrowleft" || key === "j") {
      event.preventDefault();
      seekBy(-seekStep);
    } else if (key === "arrowup") {
      event.preventDefault();
      if (videoEl) {
        videoEl.volume = clamp(videoEl.volume + 0.1, 0, 1);
        volume = videoEl.volume;
        videoEl.muted = false;
        muted = false;
      }
    } else if (key === "arrowdown") {
      event.preventDefault();
      if (videoEl) {
        videoEl.volume = clamp(videoEl.volume - 0.1, 0, 1);
        volume = videoEl.volume;
      }
    } else if (key === "m") {
      toggleMute();
    } else if (key === "f") {
      toggleFullscreen();
    } else if (key === "n") {
      notesOpen = !notesOpen;
    } else if (key === "c") {
      toggleSubs();
    }
  }

  let cueStyle = $derived(
    `--cue-color: ${playback.subtitleColor || "#ffffff"}; --cue-size: ${playback.subtitleSize || 1}; --cue-bg: ${hexToRgba("#000000", playback.subtitleBackground ?? 0.65)};`,
  );

  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
    if (!m) return `rgba(0,0,0,${alpha})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
  }

  let tickInterval = setInterval(() => {
    if (media && videoEl && !videoEl.paused) {
      saveProgress(false);
    }
  }, 12000);

  onDestroy(() => {
    clearInterval(tickInterval);
    if (media && videoEl) {
      mediaApi
        .update(media.id, {
          position: videoEl.currentTime,
          duration: Number.isFinite(videoEl.duration) ? videoEl.duration : duration,
          watchedDelta: Math.round(watchedBuffer * 10) / 10,
        })
        .catch(() => {});
    }
  });

  const timeLabel = $derived(formatDuration(currentTime, { forceHours: duration >= 3600 }));
  const durationLabel = $derived(formatDuration(duration, { forceHours: duration >= 3600 }));
  const subtitleCues = $derived(media?.subtitles || []);
</script>

<svelte:window onkeydown={onKeydown} />

{#if loading}
  <div class="content-inner player-loading">
    <div class="skeleton" style="height: 20px; width: 30%"></div>
    <div class="skeleton" style="height: 52vh; width: 100%; border-radius: 14px"></div>
  </div>
{:else if loadError}
  <div class="content-inner">
    <div class="pane" style="max-width: 540px; margin: 6vh auto">
      <EmptyState
        icon="alert-circle"
        title="This media item could not be opened"
        message={loadError}
        actionLabel="Back to media"
        onAction={() => navigate("/media")}
        secondaryLabel="Retry"
        onSecondary={() => load(id)}
      />
    </div>
  </div>
{:else if media}
  <div class="content-inner player-page">
    <header class="player-head">
      <button class="btn btn-ghost btn-icon btn-sm" onclick={() => navigate("/media")} title="Back to media">
        <Icon name="arrow-left" size={15} />
      </button>
      <div class="player-head-text">
        <h1 class="player-title" title={media.title}>{media.title}</h1>
        <p class="player-sub">
          {media.kind === "audio" ? "Audio" : "Video"} · {formatBytes(media.size)}
          {#if media.mime}· <span class="mono">{media.mime}</span>{/if}
          {#if media.duration}· {formatDuration(media.duration)}{/if}
        </p>
      </div>
      <div class="player-head-actions">
        <button class="btn btn-secondary btn-sm" class:active={notesOpen} onclick={() => (notesOpen = !notesOpen)}>
          <Icon name="note" size={12} /> Notes
          {#if notes.length}<span class="note-count">{notes.length}</span>{/if}
        </button>
        <button class="btn btn-ghost btn-icon btn-sm" onclick={addBookmark} title="Bookmark this moment">
          <Icon name="bookmark" size={15} />
        </button>
        <a class="btn btn-ghost btn-icon btn-sm" href={`/api/media/${media.id}/file`} download title="Download original file">
          <Icon name="download" size={15} />
        </a>
        <button class="btn btn-ghost btn-icon btn-sm" onclick={() => (removeOpen = true)} title="Remove from library">
          <Icon name="trash" size={15} />
        </button>
      </div>
    </header>

    <div class="player-layout" class:with-notes={notesOpen}>
      <div class="player-main">
        <div class="stage" bind:this={stageEl} class:audio-stage={media.kind === "audio"}>
          {#if mediaError}
            <div class="media-error">
              <Icon name="alert-triangle" size={24} />
              <p class="media-error-title">This file could not be played</p>
              <p class="media-error-text">{mediaError}</p>
              <p class="media-error-hint">
                The browser may not support this codec. Download the original file to play it in a
                dedicated app.
              </p>
              <a class="btn btn-secondary btn-sm" href={`/api/media/${media.id}/file`} download>
                <Icon name="download" size={12} /> Download original
              </a>
            </div>
          {:else if media.kind === "video"}
            <video
              bind:this={videoEl}
              src={`/api/media/${media.id}/file`}
              class="video-el"
              preload="metadata"
              style={cueStyle}
              onclick={togglePlay}
              ondblclick={toggleFullscreen}
              onloadedmetadata={onLoadedMetadata}
              ontimeupdate={onTimeUpdate}
              onplay={() => (playing = true)}
              onpause={() => {
                playing = false;
                saveProgress(true);
              }}
              onended={() => {
                playing = false;
                saveProgress(true);
              }}
              onwaiting={() => (waiting = true)}
              onplaying={() => {
                waiting = false;
                lastTick = videoEl?.currentTime || lastTick;
              }}
              onvolumechange={() => {
                if (videoEl) {
                  volume = videoEl.volume;
                  muted = videoEl.muted;
                }
              }}
              onerror={() =>
                (mediaError =
                  "The browser refused to decode this file. MKV and some HEVC/AC3 files are not supported natively.")}
              placeholder="Video"
            >
              {#each subtitleCues as sub, index (sub.id)}
                <track
                  kind="subtitles"
                  src={sub.url}
                  label={sub.label}
                  srclang={sub.lang || "und"}
                  default={index === 0}
                />
              {/each}
            </video>
            {#if !playing && ready}
              <button class="center-play" onclick={togglePlay} aria-label="Play">
                <Icon name="play" size={26} filled />
              </button>
            {/if}
            {#if waiting}
              <span class="buffering"><Icon name="loader" size={20} class="spin" /></span>
            {/if}
          {:else}
            <audio
              bind:this={videoEl}
              src={`/api/media/${media.id}/file`}
              preload="metadata"
              onloadedmetadata={onLoadedMetadata}
              ontimeupdate={onTimeUpdate}
              onplay={() => (playing = true)}
              onpause={() => {
                playing = false;
                saveProgress(true);
              }}
              onended={() => {
                playing = false;
                saveProgress(true);
              }}
              onvolumechange={() => {
                if (videoEl) {
                  volume = videoEl.volume;
                  muted = videoEl.muted;
                }
              }}
              onerror={() => (mediaError = "The browser could not decode this audio file.")}
            >
              {#each subtitleCues as sub (sub.id)}
                <track kind="subtitles" src={sub.url} label={sub.label} srclang={sub.lang || "und"} />
              {/each}
            </audio>
            <div class="audio-visual">
              <span class="audio-art" class:playing>
                <Icon name="music" size={30} />
                {#if playing}<span class="equalizer"><i></i><i></i><i></i><i></i></span>{/if}
              </span>
              <p class="audio-title">{media.title}</p>
              <p class="audio-sub">{subtitleCues.length ? `${pluralize(subtitleCues.length, "subtitle track")} attached` : "Local audio"}</p>
              <button class="btn btn-primary btn-sm" onclick={togglePlay}>
                <Icon name={playing ? "pause" : "play"} size={12} filled={!playing} />
                {playing ? "Pause" : "Play"}
              </button>
            </div>
          {/if}
        </div>

        {#if !mediaError}
          <div class="controls">
            <div class="seek-row">
              <span class="time mono">{timeLabel}</span>
              <div class="seek-wrap">
                <div class="seek-buffered" style="width: {duration ? (buffered / duration) * 100 : 0}%"></div>
                <input
                  type="range"
                  class="seek"
                  min="0"
                  max={duration || 0}
                  step="0.1"
                  value={currentTime}
                  oninput={onSeekInput}
                  aria-label="Seek"
                  style="--seek-pct: {duration ? (currentTime / duration) * 100 : 0}%"
                />
              </div>
              <span class="time mono">{durationLabel}</span>
            </div>

            <div class="control-row">
              <div class="control-group">
                <button class="ctl" onclick={() => seekBy(-seekStep)} title={`Back ${seekStep}s (J)`}>
                  <Icon name="skip-back" size={15} />
                </button>
                <button class="ctl ctl-play" onclick={togglePlay} title="Play / pause (Space)">
                  <Icon name={playing ? "pause" : "play"} size={17} filled={!playing} />
                </button>
                <button class="ctl" onclick={() => seekBy(seekStep)} title={`Forward ${seekStep}s (L)`}>
                  <Icon name="skip-forward" size={15} />
                </button>

                <div class="volume-group">
                  <button class="ctl" onclick={toggleMute} title="Mute (M)">
                    <Icon name={muted || volume === 0 ? "volume-x" : "volume"} size={15} />
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={muted ? 0 : volume}
                    oninput={onVolume}
                    aria-label="Volume"
                    class="volume"
                  />
                </div>

                <select class="rate-select" value={String(rate)} onchange={(e) => setRate(e.currentTarget.value)} aria-label="Playback speed">
                  {#each [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as value}
                    <option value={String(value)}>{value}×</option>
                  {/each}
                </select>
              </div>

              <div class="control-group right">
                <div class="sub-wrap">
                  <button class="ctl" class:on={showSubs && activeSub} onclick={() => (subMenu = !subMenu)} title="Subtitles (C)">
                    <Icon name="subtitles" size={15} />
                    {#if subtitleCues.length}<span class="ctl-dot"></span>{/if}
                  </button>
                  {#if subMenu}
                    <div class="sub-menu">
                      <p class="sub-menu-label">Subtitle track</p>
                      <button class="sub-item" class:active={!activeSub} onclick={() => chooseSub("")}>
                        Off
                        {#if !activeSub}<Icon name="check" size={11} />{/if}
                      </button>
                      {#each subtitleCues as sub (sub.id)}
                        <div class="sub-item-row">
                          <button class="sub-item" class:active={activeSub === sub.id} onclick={() => chooseSub(sub.id)}>
                            {sub.label} {sub.lang ? `(${sub.lang})` : ""}
                            {#if activeSub === sub.id}<Icon name="check" size={11} />{/if}
                          </button>
                          <button class="sub-delete" onclick={() => removeSubtitle(sub)} title="Remove track">
                            <Icon name="x" size={10} />
                          </button>
                        </div>
                      {/each}
                      <button class="sub-item upload" onclick={() => subInput?.click()} disabled={uploadingSub}>
                        <Icon name={uploadingSub ? "loader" : "plus"} size={11} class={uploadingSub ? "spin" : ""} />
                        {uploadingSub ? "Converting…" : "Add SRT or VTT"}
                      </button>
                    </div>
                  {/if}
                </div>

                <button class="ctl" class:on={loop} onclick={toggleLoop} title="Loop">
                  <Icon name="repeat" size={15} />
                </button>
                <button class="ctl" onclick={() => (notesOpen = !notesOpen)} title="Notes (N)">
                  <Icon name="note" size={15} />
                </button>
                <button class="ctl" onclick={toggleFullscreen} title="Fullscreen (F)">
                  <Icon name="maximize" size={15} />
                </button>
              </div>
            </div>
          </div>
        {/if}

        <input
          bind:this={subInput}
          type="file"
          accept=".srt,.vtt,text/vtt,application/x-subrip"
          class="hidden-input"
          onchange={(e) => addSubtitle(e.currentTarget.files)}
        />

        <div class="player-info">
          <div class="info-block">
            <p class="eyebrow">Playback</p>
            <div class="info-grid">
              <div><span>Resume position</span><span class="mono">{media.position ? formatDuration(media.position) : "Start"}</span></div>
              <div><span>Time played</span><span class="mono">{formatDuration(media.watchedSeconds || 0)}</span></div>
              <div><span>Added</span><span>{formatRelative(media.createdAt)}</span></div>
              <div><span>Size</span><span class="mono">{formatBytes(media.size)}</span></div>
            </div>
          </div>
          <div class="info-block">
            <p class="eyebrow">Keyboard</p>
            <div class="key-grid">
              <span><kbd>Space</kbd> play / pause</span>
              <span><kbd>J</kbd><kbd>L</kbd> seek {seekStep}s</span>
              <span><kbd>M</kbd> mute</span>
              <span><kbd>F</kbd> fullscreen</span>
              <span><kbd>N</kbd> notes</span>
              <span><kbd>C</kbd> subtitles</span>
            </div>
          </div>
        </div>
      </div>

      {#if notesOpen}
        <aside class="media-notes">
          <div class="media-notes-head">
            <div>
              <p class="eyebrow">Timestamped notes</p>
              <p class="media-notes-count">{pluralize(notes.length, "note")} · {pluralize(bookmarks.length, "bookmark")}</p>
            </div>
            <button class="btn btn-ghost btn-icon btn-sm" onclick={() => (notesOpen = false)} aria-label="Close notes">
              <Icon name="x" size={13} />
            </button>
          </div>

          <div class="note-form">
            <div class="note-time-row">
              <span class="time-chip mono" onclick={() => seekTo(currentTime)} title="Current playback position">
                <Icon name="clock" size={10} /> {timeLabel}
              </span>
              <button class="btn btn-ghost btn-sm" onclick={addBookmark}>
                <Icon name="bookmark" size={11} /> Bookmark
              </button>
            </div>
            <textarea
              class="textarea note-input"
              bind:value={noteDraft}
              placeholder={`A note at ${timeLabel}…`}
              aria-label="New timestamped note"
            ></textarea>
            <button class="btn btn-primary btn-sm btn-block" onclick={addNote} disabled={!noteDraft.trim() || savingNote}>
              {#if savingNote}<Icon name="loader" size={11} class="spin" />{:else}<Icon name="plus" size={11} />{/if}
              Save at {timeLabel}
            </button>
          </div>

          <div class="media-notes-list">
            {#if bookmarks.length}
              <p class="eyebrow" style="padding: 4px 2px">Bookmarks</p>
              {#each bookmarks as mark (mark.id)}
                <div class="note-item bookmark-item">
                  <button class="note-jump" onclick={() => seekTo(mark.position || 0)}>
                    <Icon name="bookmark" size={11} />
                    <span class="mono">{formatDuration(mark.position || 0)}</span>
                  </button>
                  <button class="mark-remove" onclick={() => removeBookmark(mark)} aria-label="Remove bookmark">
                    <Icon name="x" size={10} />
                  </button>
                </div>
              {/each}
            {/if}

            {#if !notes.length}
              <p class="notes-empty">No notes yet. Pause and write what you noticed — the timestamp is captured automatically.</p>
            {/if}
            {#each notes as note (note.id)}
              <div class="note-item">
                <div class="note-item-head">
                  <button class="note-jump" onclick={() => seekTo(note.timeSeconds || 0)} title="Jump to this moment">
                    <Icon name="play-circle" size={11} />
                    <span class="mono">{formatDuration(note.timeSeconds || 0)}</span>
                  </button>
                  <button class="mark-remove" onclick={() => removeNote(note)} aria-label="Delete note">
                    <Icon name="trash" size={11} />
                  </button>
                </div>
                <p class="note-body">{note.body}</p>
                <p class="note-time faint">{formatRelative(note.createdAt)}</p>
              </div>
            {/each}
          </div>
        </aside>
      {/if}
    </div>
  </div>

  <Modal open={removeOpen} title="Remove media?" subtitle={media.title} onClose={() => (removeOpen = false)}>
    <div class="stack stack-4">
      <p style="font-size: 12px; line-height: 1.6; color: var(--tertiary)">
        Playback position, attached subtitles, bookmarks and notes will be deleted.
      </p>
      <label class="checkbox">
        <input type="checkbox" bind:checked={deleteFile} />
        Delete the media file from disk
      </label>
      <div class="row row-end row-2">
        <button class="btn btn-secondary btn-sm" onclick={() => (removeOpen = false)}>Cancel</button>
        <button class="btn btn-danger btn-sm" onclick={confirmRemove}>
          <Icon name="trash" size={12} /> Remove
        </button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .player-loading {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .player-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 1400px;
  }
  .player-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .player-head-text {
    flex: 1;
    min-width: 0;
  }
  .player-title {
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.02em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .player-sub {
    font-size: 10.5px;
    color: var(--tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .player-head-actions {
    display: flex;
    align-items: center;
    gap: 3px;
    flex: 0 0 auto;
  }
  .note-count {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--accent-text);
  }

  .player-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }
  .player-layout.with-notes {
    grid-template-columns: minmax(0, 1fr) 306px;
  }
  .player-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .stage {
    position: relative;
    background: #0d0c0b;
    border-radius: var(--radius-xl);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 260px;
    aspect-ratio: 16 / 9;
  }
  .stage:fullscreen {
    border-radius: 0;
    aspect-ratio: auto;
    width: 100vw;
    height: 100vh;
  }
  .stage.audio-stage {
    aspect-ratio: auto;
    min-height: 320px;
    background:
      radial-gradient(ellipse at 50% 0%, rgba(255, 149, 0, 0.18), transparent 65%),
      #14130f;
  }
  .video-el {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
    cursor: pointer;
    display: block;
  }
  .stage :global(video::cue) {
    color: var(--cue-color, #fff);
    background: var(--cue-bg, rgba(0, 0, 0, 0.65));
    font-family: var(--font-ui);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }
  .center-play {
    position: absolute;
    width: 62px;
    height: 62px;
    border-radius: 50%;
    display: grid;
    place-content: center;
    background: rgba(255, 149, 0, 0.94);
    color: #1e1200;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
    transition: transform var(--duration-base) var(--ease-spring);
    padding-left: 3px;
  }
  .center-play:hover {
    transform: scale(1.06);
  }
  .buffering {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    color: #fff;
    background: rgba(0, 0, 0, 0.25);
    pointer-events: none;
  }

  .audio-visual {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 9px;
    padding: var(--space-6);
    text-align: center;
    z-index: 1;
  }
  .audio-art {
    width: 92px;
    height: 92px;
    border-radius: 22px;
    display: grid;
    place-content: center;
    background: linear-gradient(145deg, rgba(255, 180, 77, 0.24), rgba(255, 149, 0, 0.08));
    border: 1px solid rgba(255, 190, 100, 0.28);
    color: #ffb44d;
    position: relative;
    overflow: hidden;
  }
  .audio-art.playing :global(svg) {
    opacity: 0.3;
  }
  .equalizer {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
  }
  .equalizer i {
    width: 4px;
    border-radius: 99px;
    background: #ffb44d;
    animation: eq 1.1s ease-in-out infinite;
    height: 18px;
  }
  .equalizer i:nth-child(2) { animation-delay: 0.18s; height: 30px; }
  .equalizer i:nth-child(3) { animation-delay: 0.36s; height: 24px; }
  .equalizer i:nth-child(4) { animation-delay: 0.54s; height: 14px; }
  @keyframes eq {
    0%, 100% { transform: scaleY(0.4); }
    50% { transform: scaleY(1); }
  }
  .audio-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 620;
    color: #f4efe4;
    letter-spacing: -0.015em;
    max-width: 460px;
  }
  .audio-sub {
    font-size: 10.5px;
    color: #9c9487;
    margin-bottom: 5px;
  }

  .media-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    text-align: center;
    padding: var(--space-6);
    color: #f0b9b9;
    max-width: 420px;
  }
  .media-error-title {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 620;
    color: #fff;
  }
  .media-error-text {
    font-size: 11px;
    line-height: 1.5;
    color: #e7a9a9;
  }
  .media-error-hint {
    font-size: 10px;
    color: #a89c8c;
    line-height: 1.55;
    margin-bottom: 5px;
  }
  .media-error :global(.btn) {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.2);
    color: #fff;
  }

  .controls {
    background: var(--pane);
    border: 1px solid var(--content-border);
    border-radius: var(--radius-lg);
    padding: 9px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .seek-row {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .time {
    font-size: 10px;
    color: var(--tertiary);
    min-width: 42px;
    text-align: center;
  }
  .seek-wrap {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
    height: 16px;
  }
  .seek-buffered {
    position: absolute;
    left: 0;
    top: 6px;
    height: 4px;
    border-radius: 99px;
    background: var(--surface-sunken);
    pointer-events: none;
  }
  .seek {
    appearance: none;
    height: 4px;
    border-radius: 99px;
    background: linear-gradient(
      to right,
      var(--accent) 0%,
      var(--accent) var(--seek-pct),
      var(--surface-sunken) var(--seek-pct),
      var(--surface-sunken) 100%
    );
    position: relative;
    z-index: 1;
    cursor: pointer;
    margin: 0;
  }
  .seek::-webkit-slider-thumb {
    appearance: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--surface);
  }

  .control-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .control-group {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .control-group.right {
    margin-left: auto;
  }
  .ctl {
    width: 30px;
    height: 28px;
    border-radius: 6px;
    display: grid;
    place-content: center;
    color: var(--tertiary);
    position: relative;
    transition: all var(--duration-fast) var(--ease-out);
  }
  .ctl:hover {
    background: var(--surface-hi);
    color: var(--secondary);
  }
  .ctl.on {
    color: var(--accent-text);
    background: var(--accent-soft);
  }
  .ctl-play {
    width: 34px;
    height: 30px;
    color: var(--secondary);
  }
  .ctl-dot {
    position: absolute;
    right: 6px;
    bottom: 4px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
  }
  .volume-group {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-left: 4px;
  }
  .volume {
    width: 62px;
    height: 3px;
  }
  .volume::-webkit-slider-thumb {
    width: 10px;
    height: 10px;
  }
  .rate-select {
    height: 24px;
    width: 64px;
    font-size: 10px;
    font-family: var(--font-mono);
    background: var(--surface);
    border: 1px solid var(--input-border);
    border-radius: 5px;
    color: var(--tertiary);
    margin-left: 4px;
    appearance: none;
    padding: 0 4px;
    text-align: center;
  }

  .sub-wrap {
    position: relative;
  }
  .sub-menu {
    position: absolute;
    bottom: 36px;
    right: 0;
    width: 218px;
    background: var(--popup-bg);
    border: 1px solid var(--content-border);
    border-radius: var(--radius-md);
    box-shadow: var(--elev-2);
    padding: 6px;
    z-index: 60;
  }
  .sub-menu-label {
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--quaternary);
    padding: 4px 7px 5px;
    font-weight: 650;
  }
  .sub-item-row {
    display: flex;
    align-items: center;
  }
  .sub-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    width: 100%;
    padding: 5px 7px;
    border-radius: 5px;
    font-size: 11px;
    text-align: left;
    color: var(--secondary);
  }
  .sub-item:hover {
    background: var(--surface-hi);
  }
  .sub-item.active {
    color: var(--accent-text);
    font-weight: 600;
  }
  .sub-item.upload {
    border-top: 1px solid var(--content-border);
    margin-top: 4px;
    padding-top: 7px;
    color: var(--tertiary);
    justify-content: flex-start;
  }
  .sub-delete {
    width: 20px;
    height: 20px;
    display: grid;
    place-content: center;
    border-radius: 4px;
    color: var(--quaternary);
    flex: 0 0 auto;
  }
  .sub-delete:hover {
    color: var(--error);
    background: var(--error-soft);
  }

  .player-info {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .info-block {
    padding: 11px 13px;
    border-radius: var(--radius-lg);
    background: var(--pane);
    border: 1px solid var(--content-border);
  }
  .info-block :global(.eyebrow) {
    margin-bottom: 7px;
  }
  .info-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px 12px;
  }
  .info-grid > div {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: 10px;
    color: var(--tertiary);
  }
  .key-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-size: 10px;
    color: var(--tertiary);
  }
  .key-grid span {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  .media-notes {
    border: 1px solid var(--content-border);
    border-radius: var(--radius-lg);
    background: var(--pane);
    display: flex;
    flex-direction: column;
    max-height: 640px;
    position: sticky;
    top: 0;
  }
  .media-notes-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 11px 12px 8px;
    flex: 0 0 auto;
  }
  .media-notes-count {
    font-size: 9.5px;
    color: var(--quaternary);
  }
  .note-form {
    padding: 0 12px 11px;
    border-bottom: 1px solid var(--content-border);
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .note-time-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .time-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 7px;
    border-radius: 5px;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: 10.5px;
    cursor: pointer;
  }
  .note-input {
    min-height: 70px;
    font-size: 11.5px;
  }

  .media-notes-list {
    overflow-y: auto;
    padding: 7px 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    flex: 1;
    min-height: 0;
  }
  .notes-empty {
    font-size: 10.5px;
    color: var(--quaternary);
    line-height: 1.5;
    padding: 6px 2px;
  }
  .note-item {
    padding: 8px 9px;
    border-radius: 7px;
    background: var(--surface);
    border: 1px solid var(--content-border);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .bookmark-item {
    flex-direction: row;
    align-items: center;
    padding: 5px 6px;
    background: transparent;
  }
  .note-item-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }
  .note-jump {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--accent-text);
    padding: 2px 4px;
    margin-left: -4px;
    border-radius: 4px;
  }
  .note-jump:hover {
    background: var(--accent-soft);
  }
  .note-body {
    font-size: 11px;
    line-height: 1.55;
    color: var(--secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .note-time {
    font-size: 8.5px;
  }
  .mark-remove {
    color: var(--quaternary);
    padding: 3px;
    border-radius: 4px;
  }
  .mark-remove:hover {
    color: var(--error);
    background: var(--error-soft);
  }

  .hidden-input {
    display: none;
  }

  .spin {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 1100px) {
    .player-layout.with-notes { grid-template-columns: minmax(0, 1fr); }
    .media-notes { position: relative; max-height: 460px; }
  }
  @media (max-width: 640px) {
    .player-head-actions :global(.btn span) { display: none; }
    .player-info { grid-template-columns: minmax(0, 1fr); }
    .stage { aspect-ratio: 4 / 3; }
    .volume-group { display: none; }
    .rate-select { display: none; }
    .controls { padding: 7px 9px; }
  }
</style>
