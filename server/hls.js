/**
 * Minimal HLS (HTTP Live Streaming) parser used by the download engine.
 * Supports master playlists, media playlists and unencrypted segments
 * (MPEG-TS or fMP4). Encrypted playlists are reported, never bypassed.
 */

export function parseAttributes(line) {
  const out = {};
  const body = line.slice(line.indexOf(":") + 1);
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(body))) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return out;
}

export function parsePlaylist(text, baseUrl) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length || !lines[0].startsWith("#EXTM3U")) {
    throw Object.assign(new Error("The playlist is not valid HLS (missing #EXTM3U)"), {
      status: 422,
    });
  }
  const variants = [];
  const segments = [];
  let mapUri = null;
  let encrypted = null;
  let targetDuration = 0;
  let mediaSequence = 0;
  let pendingVariant = null;
  let pendingDuration = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingVariant = parseAttributes(line);
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) {
        variants.push({
          url: new URL(next, baseUrl).href,
          bandwidth: Number(pendingVariant.BANDWIDTH) || 0,
          width: Number(pendingVariant.RESOLUTION?.split("x")[0]) || 0,
          height: Number(pendingVariant.RESOLUTION?.split("x")[1]) || 0,
          codecs: pendingVariant.CODECS || "",
        });
      }
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributes(line);
      if (attrs.URI) mapUri = new URL(attrs.URI, baseUrl).href;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line);
      if (attrs.METHOD && attrs.METHOD !== "NONE") {
        encrypted = {
          method: attrs.METHOD,
          keyFormat: attrs.KEYFORMAT || "identity",
        };
      }
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#")) continue;
    segments.push({
      url: new URL(line, baseUrl).href,
      duration: pendingDuration,
      seq: mediaSequence + segments.length,
    });
    pendingDuration = 0;
  }

  const isMaster = variants.length > 0;
  return {
    type: isMaster ? "master" : "media",
    variants,
    segments,
    mapUri,
    encrypted,
    targetDuration,
    isLive: !lines.some((l) => l.startsWith("#EXT-X-ENDLIST")),
  };
}

export function pickVariant(variants, height) {
  const sorted = [...variants].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  if (!sorted.length) return null;
  if (height) {
    const fit = sorted.find((v) => v.height <= height);
    return fit || sorted[sorted.length - 1];
  }
  return sorted[0];
}
