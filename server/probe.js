import { getSettings } from "./settings.js";
import { normalizeUrl, assertPublicUrl, fetchFollowing } from "./net.js";
import { parsePlaylist, pickVariant } from "./hls.js";
import {
  detectSource,
  looksLikePageUrl,
  contentDispositionFilename,
  filenameFromUrl,
  probeWithYtDlp,
  probeWithYtDlpResult,
} from "./ytdlp.js";
import { classifyMime, extFromMime, mimeFromName } from "./util.js";
import { systemTools } from "./bins.js";

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36 OmniGet/1.0";

export function clearProbeCache() {
  cache.clear();
}

function cacheKey(url) {
  return url;
}

function remember(result) {
  cache.set(cacheKey(result.url), { at: Date.now(), result });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
    for (const [key] of oldest) cache.delete(key);
  }
  return result;
}

export function getCachedProbe(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.result;
  return null;
}

function baseResult(url, source) {
  return {
    url,
    finalUrl: url,
    source,
    kind: "other",
    mime: null,
    engine: "http",
    supported: false,
    reason: null,
    title: "",
    filename: "",
    sizeBytes: 0,
    rangeSupported: false,
    durationSeconds: null,
    thumbnail: null,
    qualities: [],
    isPage: false,
    probedAt: Date.now(),
  };
}

async function directProbe(url, settings, source) {
  const headers = {
    "user-agent": settings.network.userAgent || DEFAULT_UA,
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
  };
  let res = null;
  let finalUrl = url;
  let methodUsed = "HEAD";
  const timeoutMs = Math.max(5, settings.network.timeoutSeconds) * 1000;

  try {
    const out = await fetchFollowing(url, { method: "HEAD", headers, timeoutMs });
    res = out.res;
    finalUrl = out.finalUrl;
    if (!res.ok || !res.headers.get("content-type")) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      res = null;
    }
  } catch (err) {
    res = null;
  }

  if (!res) {
    try {
      const out = await fetchFollowing(url, {
        method: "GET",
        headers: { ...headers, range: "bytes=0-0" },
        timeoutMs,
      });
      res = out.res;
      finalUrl = out.finalUrl;
      methodUsed = "GET";
    } catch (err) {
      const result = baseResult(url, source);
      result.reason = friendlyNetworkError(err);
      result.finalUrl = finalUrl;
      return result;
    }
  }

  const status = res.status;
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const disposition = res.headers.get("content-disposition") || "";
  const acceptRanges = (res.headers.get("accept-ranges") || "").toLowerCase();
  const contentRange = res.headers.get("content-range") || "";
  let size = Number(res.headers.get("content-length")) || 0;
  if (contentRange) {
    const total = /\/(\d+)\s*$/.exec(contentRange);
    if (total) size = Number(total[1]);
  }
  let bodyText = null;
  if (contentType === "application/vnd.apple.mpegurl" || contentType === "application/x-mpegurl") {
    try {
      bodyText = await res.text();
    } catch {
      bodyText = null;
    }
  } else {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
  }

  const result = baseResult(url, source);
  result.finalUrl = finalUrl;
  result.mime = contentType || mimeFromName(filenameFromUrl(finalUrl, ""), "");
  result.rangeSupported = acceptRanges.includes("bytes") || status === 206;

  let filename = contentDispositionFilename(disposition);
  if (!filename) filename = filenameFromUrl(finalUrl, result.mime);

  if (status >= 400) {
    result.reason = `The server returned HTTP ${status}. The link may be expired, private, or rate limited.`;
    result.filename = filename;
    return result;
  }

  const kind = classifyMime(result.mime, filename);
  result.kind = kind;
  result.filename = filename;
  result.title = titleFromFilename(filename);
  result.sizeBytes = size;
  result.isPage = kind === "page";

  if (kind === "hls") {
    return probeHls(result, finalUrl, bodyText, settings);
  }
  if (kind === "dash") {
    result.engine = "unsupported";
    result.reason =
      "This is a DASH (.mpd) manifest. DASH is not implemented in this build; an HLS or direct-file link is required.";
    return result;
  }
  if (kind === "page") {
    result.engine = "unsupported";
    result.reason =
      "This link is a web page, not a direct media file. Install yt-dlp to extract streams from supported sites.";
    return result;
  }

  result.supported = true;
  result.engine = "http";
  result.qualities = [
    {
      id: "source",
      label: "Original file" + (size ? ` · ${result.mime.split("/").pop()}` : ""),
      ext: extFromMime(result.mime).replace(".", ""),
      formatId: "source",
      height: 0,
      mode: "direct",
    },
  ];
  result.probeMethod = methodUsed;
  return result;
}

function titleFromFilename(filename) {
  const base = String(filename || "")
    .replace(/\.[a-z0-9]{1,6}$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base || filename || "Download";
}

async function probeHls(result, finalUrl, bodyText, settings) {
  result.engine = "hls";
  try {
    let text = bodyText;
    if (!text) {
      const headers = { "user-agent": settings.network.userAgent || DEFAULT_UA, accept: "*/*" };
      const out = await fetchFollowing(finalUrl, { headers, timeoutMs: 20_000 });
      text = await out.res.text();
    }
    let playlist = parsePlaylist(text, finalUrl);
    if (playlist.type === "master") {
      const variants = playlist.variants.map((v) => ({
        id: String(v.height || v.bandwidth),
        label: v.height ? `${v.height}p` : `${Math.round(v.bandwidth / 1000)} kbps`,
        height: v.height,
        bandwidth: v.bandwidth,
        url: v.url,
        formatId: String(v.height || v.bandwidth),
        mode: "variant",
      }));
      result.qualities = variants.sort((a, b) => b.height - a.height);
      const best = pickVariant(playlist.variants, 0);
      if (best) {
        try {
          const out = await fetchFollowing(best.url, {
            headers: { "user-agent": settings.network.userAgent || DEFAULT_UA },
            timeoutMs: 20_000,
          });
          const media = parsePlaylist(await out.res.text(), best.url);
          if (media.encrypted) {
            result.reason = `This HLS stream is protected with ${media.encrypted.method} encryption. Encrypted streams are not supported.`;
            result.supported = false;
            return result;
          }
          result.segmentCount = media.segments.length;
          result.supported = true;
          result.mime = "application/vnd.apple.mpegurl";
          result.kind = "video";
          result.filename = titleFromFilename(result.filename || filenameFromUrl(finalUrl, "")) + ".mp4";
          result.title = titleFromFilename(result.filename);
        } catch (err) {
          result.reason = "Could not load the HLS media playlist: " + err.message;
          result.supported = false;
        }
      }
      return result;
    }
    if (playlist.encrypted) {
      result.supported = false;
      result.reason = `This HLS stream is protected with ${playlist.encrypted.method} encryption. Encrypted streams are not supported.`;
      return result;
    }
    if (!playlist.segments.length) {
      result.supported = false;
      result.reason = "The HLS playlist does not contain any media segments.";
      return result;
    }
    result.supported = true;
    result.mime = "application/vnd.apple.mpegurl";
    result.kind = "video";
    result.segmentCount = playlist.segments.length;
    result.isLive = playlist.isLive;
    result.filename = titleFromFilename(result.filename || filenameFromUrl(finalUrl, "")) + ".mp4";
    result.title = titleFromFilename(result.filename);
    result.qualities = [
      {
        id: "source",
        label: `HLS · ${playlist.segments.length} segments`,
        formatId: "source",
        height: 0,
        mode: "variant",
      },
    ];
    return result;
  } catch (err) {
    result.supported = false;
    result.reason = "Could not read the HLS playlist: " + err.message;
    return result;
  }
}

function friendlyNetworkError(err) {
  const msg = String(err?.message || err);
  if (/timeout|timed out|aborted/i.test(msg)) {
    return "The server took too long to respond. Check the link or increase the network timeout in Settings.";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return "The host could not be resolved. Check your connection and the link.";
  }
  if (/certificate|TLS|SSL/i.test(msg)) {
    return "The server's TLS certificate could not be verified.";
  }
  return "Could not reach the server: " + msg;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function redditUnavailable(url, source, reason) {
  const result = baseResult(url, source);
  result.engine = "yt-dlp";
  result.supported = false;
  result.needsExtractor = true;
  result.reason = reason;
  return remember(result);
}

/**
 * Reddit blocks anonymous extraction from many networks, but public video
 * posts still expose their media host in the post's Atom feed. Resolve that
 * feed, then hand the public v.redd.it HLS stream to yt-dlp, which can merge
 * the separate video and audio renditions. No account access is bypassed.
 */
async function resolveRedditMedia(url, settings, tools) {
  const source = detectSource(url);
  if (!tools.ytdlp.available) {
    return redditUnavailable(
      url,
      source,
      "Reddit videos need yt-dlp for extraction. Install yt-dlp and restart OmniGet.",
    );
  }
  if (!tools.ffmpeg.available) {
    return redditUnavailable(
      url,
      source,
      "Reddit serves video and audio as separate streams. Install ffmpeg so the local engine can merge them into one file.",
    );
  }

  const headers = {
    "user-agent": settings.network.userAgent || DEFAULT_UA,
    accept: "application/atom+xml,text/html;q=0.9,*/*;q=0.8",
  };
  const timeoutMs = Math.max(5, settings.network.timeoutSeconds) * 1000;
  let videoKey = null;
  let postTitle = "";
  let thumbnail = "";
  let finalUrl = url;

  try {
    if (/^v\.redd\.it$/i.test(new URL(url).hostname)) {
      videoKey = new URL(url).pathname.split("/").filter(Boolean)[0] || null;
      postTitle = "Reddit video";
    } else {
      const resolved = await fetchFollowing(url, { headers, timeoutMs });
      finalUrl = resolved.finalUrl;
      try {
        await resolved.res.body?.cancel();
      } catch {
        /* ignore */
      }
      const pathname = new URL(finalUrl).pathname;
      const match = /\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)/i.exec(pathname);
      const postId = match?.[1];
      if (!postId) return null;
      const rssOut = await fetchFollowing(`https://www.reddit.com/comments/${postId}/.rss`, {
        headers,
        timeoutMs,
      });
      const rss = await rssOut.res.text();
      const entry = /<entry>([\s\S]*?)<\/entry>/i.exec(rss)?.[1] || rss;
      videoKey = /https:\/\/v\.redd\.it\/([a-z0-9]+)/i.exec(entry)?.[1] || null;
      const rawTitle = /<title>([\s\S]*?)<\/title>/i.exec(entry)?.[1] || "";
      postTitle = decodeHtmlEntities(rawTitle)
        .replace(/\s*:\s*(?:reddit\.com|[a-z0-9_]+)$/i, "")
        .trim();
      thumbnail = decodeHtmlEntities(
        /<media:thumbnail[^>]*url="([^"]+)"/i.exec(entry)?.[1] || "",
      );
    }
  } catch {
    return null;
  }

  if (!videoKey) return null;
  const hlsUrl = `https://v.redd.it/${videoKey}/HLSPlaylist.m3u8`;
  try {
    const info = await probeWithYtDlp(hlsUrl);
    const result = await probeWithYtDlpResult(hlsUrl, info, { ffmpeg: true });
    result.url = url;
    result.finalUrl = hlsUrl;
    result.downloadUrl = hlsUrl;
    result.source = source;
    result.title = postTitle || result.title;
    result.thumbnail = thumbnail || result.thumbnail;
    result.author = null;
    result.isPage = true;
    return result;
  } catch (err) {
    return redditUnavailable(
      url,
      source,
      `Reddit's public video stream could not be read. ${err.message}`,
    );
  }
}

function authRemediation(source, message) {
  if (!/authentication is required|log ?in|sign in|private|age[- ]?restricted|sensitive|consent/i.test(String(message || ""))) {
    return "";
  }
  const hints = {
    reddit:
      " Reddit refused anonymous access. Public videos are resolved through Reddit's Atom feed; if the post still fails, it may require sign-in.",
    instagram:
      " Instagram exposes public posts without a session. Private or age-gated posts need a cookies file in Settings → Network.",
    twitter:
      " X exposes public posts without a session. Protected or sensitive posts need a cookies file in Settings → Network.",
  };
  return (
    hints[source.id] ||
    " A cookies file can be configured in Settings → Network for content you already have access to."
  );
}

export async function probeUrl(input, { settings = getSettings(), force = false } = {}) {
  const raw = normalizeUrl(input);
  const url = raw.href;
  await assertPublicUrl(raw, settings);
  if (!force) {
    const hit = getCachedProbe(url);
    if (hit) return hit;
  }
  const source = detectSource(url);
  const tools = await systemTools();

  const isKnownSource = !["web"].includes(source.id);
  const pageLike = looksLikePageUrl(url);
  let ytdlpError = null;

  if (source.id === "reddit" && (isKnownSource || pageLike)) {
    const reddit = await resolveRedditMedia(url, settings, tools);
    if (reddit) return remember(reddit);
  }

  if (tools.ytdlp.available && isKnownSource) {
    try {
      const info = await probeWithYtDlp(url);
      const result = await probeWithYtDlpResult(url, info, { ffmpeg: tools.ffmpeg.available });
      return remember(result);
    } catch (err) {
      ytdlpError = err.message;
    }
  }

  const result = await directProbe(url, settings, source);

  // Generic web pages are only handed to yt-dlp after a direct request shows
  // that the URL is a page rather than a file. This keeps ordinary file links
  // on the faster HTTP engine.
  if (tools.ytdlp.available && !isKnownSource && result.isPage && !result.supported) {
    try {
      const info = await probeWithYtDlp(url);
      return remember(await probeWithYtDlpResult(url, info, { ffmpeg: tools.ffmpeg.available }));
    } catch (err) {
      ytdlpError = err.message;
    }
  }

  if (result.isPage && !result.supported) {
    if (!tools.ytdlp.available) {
      result.reason = isKnownSource
        ? `${source.label} links need yt-dlp for stream extraction. yt-dlp is not installed in this environment, so only direct file links and HLS playlists can be downloaded.`
        : "This link is a web page. Page extraction requires yt-dlp; only direct file links and HLS playlists are supported without it.";
      result.needsExtractor = true;
      result.extractorHint = "Install yt-dlp and restart OmniGet to enable page extraction.";
    } else if (ytdlpError) {
      result.reason = `No downloadable media was found on this page. ${ytdlpError}${authRemediation(source, ytdlpError)}`;
      result.needsExtractor = true;
    }
  }
  return remember(result);
}

export function supportedSourceList({ ytdlp = false, ffmpeg = false } = {}) {
  const extractorDetail = !ytdlp
    ? "Requires yt-dlp — not detected on this host"
    : ffmpeg
      ? "Public video via yt-dlp · HD formats merged with ffmpeg"
      : "Public video via yt-dlp · single-file formats (ffmpeg missing)";
  const extractor = (id, label) => ({
    id,
    label,
    detail: extractorDetail,
    kind: "extractor",
    available: ytdlp,
  });
  return [
    { id: "direct", label: "Direct files", detail: "HTTP/HTTPS links with a direct file response", kind: "built-in", available: true },
    { id: "hls", label: "HLS streams", detail: "Unencrypted m3u8 playlists", kind: "built-in", available: true },
    extractor("youtube", "YouTube"),
    extractor("instagram", "Instagram"),
    extractor("tiktok", "TikTok"),
    extractor("twitter", "X / Twitter"),
    extractor("reddit", "Reddit"),
    extractor("vimeo", "Vimeo"),
    { id: "archive", label: "Internet Archive", detail: "Direct files and HLS", kind: "built-in", available: true },
  ];
}
