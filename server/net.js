import dns from "node:dns/promises";
import { isPrivateHostname } from "./util.js";
import { getSettings } from "./settings.js";

let cachedDispatcher = null;
let cachedProxy = null;
const dnsCache = new Map();

export function normalizeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) {
    const err = new Error("Enter a link to continue");
    err.status = 400;
    throw err;
  }
  if (/^(magnet|torrent):/i.test(raw)) {
    const err = new Error("Magnet and torrent links are not supported by this build");
    err.status = 400;
    err.code = "UNSUPPORTED_SCHEME";
    throw err;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = "https://" + raw;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    const err = new Error("That does not look like a valid link");
    err.status = 400;
    throw err;
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    const err = new Error("Only http and https links can be downloaded");
    err.status = 400;
    err.code = "UNSUPPORTED_SCHEME";
    throw err;
  }
  if (url.username || url.password) {
    const err = new Error("Links with embedded credentials are not supported");
    err.status = 400;
    throw err;
  }
  return url;
}

export async function assertPublicUrl(url, settings = getSettings()) {
  const host = (url instanceof URL ? url : new URL(String(url))).hostname;
  const allowLocal =
    settings.network.allowLocalhost || process.env.OMNIGET_ALLOW_LOCAL === "1";
  if (allowLocal) return;
  if (isPrivateHostname(host)) {
    const err = new Error(
      "This link points to a local or private address. Enable “Allow local network addresses” in Settings → Network to use it.",
    );
    err.status = 400;
    err.code = "PRIVATE_ADDRESS";
    throw err;
  }
  try {
    let addresses = dnsCache.get(host);
    if (!addresses || addresses.expires < Date.now()) {
      addresses = { list: await dns.lookup(host, { all: true, verbatim: true }), expires: Date.now() + 60_000 };
      dnsCache.set(host, addresses);
      if (dnsCache.size > 500) dnsCache.delete(dnsCache.keys().next().value);
    }
    for (const entry of addresses.list) {
      if (isPrivateHostname(entry.address)) {
        const err = new Error(
          "This hostname resolves to a private address. Enable “Allow local network addresses” in Settings → Network to use it.",
        );
        err.status = 400;
        err.code = "PRIVATE_ADDRESS";
        throw err;
      }
    }
  } catch (err) {
    if (err.code === "PRIVATE_ADDRESS") throw err;
    // DNS failures are surfaced by the actual request with a clearer message.
  }
}

async function getDispatcher() {
  const s = getSettings();
  const proxy = s.network.proxy;
  const verifyTls = s.network.verifyTls !== false;
  // Default fetch behavior already validates TLS and uses no proxy.
  if (!proxy && verifyTls) {
    cachedDispatcher = null;
    cachedProxy = null;
    return null;
  }
  const key = `${proxy}|${verifyTls}`;
  if (cachedDispatcher && cachedProxy === key) return cachedDispatcher;
  try {
    const undici = await import("undici");
    const options = {};
    if (!verifyTls) options.connect = { rejectUnauthorized: false };
    cachedDispatcher = proxy
      ? new undici.ProxyAgent({ uri: proxy, ...options })
      : new undici.Agent(options);
    cachedProxy = key;
    return cachedDispatcher;
  } catch (err) {
    const error = new Error(
      "A proxy or custom TLS transport was requested but is unavailable: " + err.message,
    );
    error.status = 502;
    throw error;
  }
}

export async function request(url, options = {}) {
  const settings = getSettings();
  const dispatcher = await getDispatcher();
  const timeoutMs =
    options.timeoutMs ?? Math.max(5, settings.network.timeoutSeconds) * 1000;
  const fetchOptions = {
    ...options,
    signal: options.signal || AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  };
  if (dispatcher) fetchOptions.dispatcher = dispatcher;
  // Node's global fetch is undici; a separate undici fetch is only needed for proxy.
  if (dispatcher) {
    const undici = await import("undici");
    return undici.fetch(url, fetchOptions);
  }
  return fetch(url, fetchOptions);
}

export async function fetchFollowing(
  url,
  options = {},
  { validate = true, maxRedirects = 6 } = {},
) {
  const settings = getSettings();
  if (validate) await assertPublicUrl(url, settings);
  let current = url;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const res = await request(current, options);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        const err = new Error(`Redirect response without a Location header from ${current}`);
        err.status = 502;
        throw err;
      }
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      const next = new URL(location, current);
      if (!["http:", "https:"].includes(next.protocol)) {
        const err = new Error("Redirected to an unsupported protocol");
        err.status = 400;
        throw err;
      }
      if (validate) await assertPublicUrl(next, settings);
      current = next.href;
      continue;
    }
    return { res, finalUrl: current };
  }
  const err = new Error("Too many redirects");
  err.status = 502;
  throw err;
}
