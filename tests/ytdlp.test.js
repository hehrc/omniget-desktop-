/**
 * Unit tests for the yt-dlp bridge. These run without a network connection:
 * the format fixtures mirror real extractor output from YouTube, X/Instagram
 * progressive posts, Instagram DASH and Reddit's HLS renditions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSource, qualitiesFromInfo, probeWithYtDlpResult } from "../server/ytdlp.js";

test("detectSource recognises the platforms the downloader advertises", () => {
  const cases = [
    ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "youtube"],
    ["https://youtu.be/jNQXAC9IVRw", "youtube"],
    ["https://music.youtube.com/watch?v=abc", "youtube"],
    ["https://www.instagram.com/reel/DTz-oakCX6R/", "instagram"],
    ["https://x.com/NASA/status/2105842656429432894", "twitter"],
    ["https://mobile.twitter.com/NASA/status/1", "twitter"],
    ["https://www.reddit.com/r/oddlysatisfying/comments/1xslyxv/", "reddit"],
    ["https://v.redd.it/qfj96lhr6s0i1", "reddit"],
  ];
  for (const [url, id] of cases) assert.equal(detectSource(url).id, id, url);
  assert.equal(detectSource("https://example.com/file.mp4").id, "web");
});

const youtubeInfo = {
  title: "Separate streams",
  formats: [
    { format_id: "137", width: 1920, height: 1080, ext: "mp4", vcodec: "avc1.640028", acodec: "none", protocol: "https", filesize: 10_000_000, tbr: 4000 },
    { format_id: "140", height: 0, ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", protocol: "https", filesize: 1_000_000, tbr: 128 },
    { format_id: "18", width: 640, height: 360, ext: "mp4", vcodec: "avc1", acodec: "mp4a", protocol: "https", filesize: 2_000_000, tbr: 800 },
    { format_id: "hls-720", width: 1280, height: 720, ext: "mp4", vcodec: "avc1", acodec: "none", protocol: "m3u8_native" },
  ],
};

test("qualities offer merged HD selectors when ffmpeg is present", () => {
  const qualities = qualitiesFromInfo(youtubeInfo, { ffmpeg: true });
  const ids = qualities.map((q) => q.id);
  assert.deepEqual(ids, ["h1080", "h720", "h360", "best"]);
  const hd = qualities.find((q) => q.id === "h1080");
  assert.match(hd.selector, /bv\*\[vcodec\^=avc\]\[ext=mp4\]\[height<=1080\]\+ba\[ext=m4a\]/);
  assert.equal(hd.height, 1080);
  assert.equal(hd.filesize, 11_000_000);
  assert.equal(hd.mode, "merge");
  // The progressive 360p file is preferred over a merge because it is a
  // single, already-muxed format.
  const sd = qualities.find((q) => q.id === "h360");
  assert.equal(sd.selector, "18");
  assert.equal(sd.mode, "muxed");
  assert.match(qualities.at(-1).selector, /bv\*\[vcodec\^=avc\]\[ext=mp4\]\+ba\[ext=m4a\]/);
});

test("without ffmpeg only formats that already contain audio are offered", () => {
  const qualities = qualitiesFromInfo(youtubeInfo, { ffmpeg: false });
  assert.deepEqual(qualities.map((q) => q.id), ["h360", "best"]);
  assert.equal(qualities.at(-1).selector, "b[ext=mp4]/b/bv*");
});

test("X progressive formats with unknown codecs are treated as muxed", () => {
  const info = {
    formats: [
      { format_id: "http-288", width: 480, height: 270, ext: "mp4", vcodec: null, acodec: null, protocol: "https", filesize: 2_350_836 },
      { format_id: "http-832", width: 640, height: 360, ext: "mp4", vcodec: null, acodec: null, protocol: "https", filesize: 6_791_304 },
      { format_id: "hls-708", width: 1280, height: 720, ext: "mp4", vcodec: "avc1.64001F", acodec: "none", protocol: "m3u8_native" },
      { format_id: "hls-audio-128000-Audio", height: 0, ext: "mp4", vcodec: "none", acodec: null, protocol: "m3u8_native", tbr: 128 },
    ],
  };
  const qualities = qualitiesFromInfo(info, { ffmpeg: true });
  assert.deepEqual(qualities.map((q) => q.id), ["h720", "h360", "h270", "best"]);
  assert.equal(qualities.find((q) => q.id === "h360").selector, "http-832");
  assert.equal(qualities.find((q) => q.id === "h360").filesize, 6_791_304);
  assert.match(qualities.find((q) => q.id === "h720").selector, /height<=720/);
});

test("portrait clips are labelled by their short side but keep the real height", () => {
  const info = {
    formats: [
      { format_id: "dash-v-638", width: 360, height: 638, ext: "mp4", vcodec: "avc1.4d001e", acodec: "none", protocol: "https", filesize: 500_000 },
      { format_id: "dash-v-1278", width: 720, height: 1278, ext: "mp4", vcodec: "avc1.64001f", acodec: "none", protocol: "https", filesize: 2_000_000 },
      { format_id: "dash-a", height: 0, ext: "m4a", vcodec: "none", acodec: "mp4a.40.5", protocol: "https", filesize: 100_000 },
    ],
  };
  const qualities = qualitiesFromInfo(info, { ffmpeg: true });
  const small = qualities.find((q) => q.height === 638);
  const large = qualities.find((q) => q.height === 1278);
  assert.equal(small.label, "360p · mp4");
  assert.equal(large.label, "720p · mp4");
  assert.match(small.selector, /height<=638/);
  assert.match(large.selector, /height<=1278/);
});

test("Reddit-style HLS lists one merge choice per rendition", () => {
  const info = {
    formats: [
      { format_id: "266", width: 220, height: 392, ext: "mp4", vcodec: "avc1", acodec: "none", protocol: "m3u8_native" },
      { format_id: "763", width: 360, height: 640, ext: "mp4", vcodec: "avc1", acodec: "none", protocol: "m3u8_native" },
      { format_id: "2121", width: 720, height: 1280, ext: "mp4", vcodec: "avc1", acodec: "none", protocol: "m3u8_native" },
      { format_id: "5-audio_0", height: 0, ext: "mp4", vcodec: "none", acodec: null, protocol: "m3u8_native" },
    ],
  };
  const qualities = qualitiesFromInfo(info, { ffmpeg: true });
  assert.deepEqual(qualities.map((q) => q.height), [1280, 640, 392, 0]);
  assert.equal(qualities[0].label, "720p · mp4");
  assert.match(qualities[0].selector, /height<=1280/);
});

test("empty format lists still expose a best-effort selector", () => {
  const qualities = qualitiesFromInfo({}, { ffmpeg: true });
  assert.equal(qualities.length, 1);
  assert.equal(qualities[0].id, "best");
  assert.match(qualities[0].selector, /bv\*/);
});

test("probe results describe extracted media with mp4 metadata", async () => {
  const info = {
    ...youtubeInfo,
    title: "Me at the zoo",
    duration: 19,
    uploader: "jawed",
    webpage_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    extractor_key: "Youtube",
  };
  const result = await probeWithYtDlpResult(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    info,
    { ffmpeg: true },
  );
  assert.equal(result.supported, true);
  assert.equal(result.engine, "yt-dlp");
  assert.equal(result.source.id, "youtube");
  assert.equal(result.kind, "video");
  assert.equal(result.mime, "video/mp4");
  assert.equal(result.title, "Me at the zoo");
  assert.equal(result.durationSeconds, 19);
  assert.equal(result.author, "jawed");
  assert.equal(result.qualities[0].id, "h1080");
});
