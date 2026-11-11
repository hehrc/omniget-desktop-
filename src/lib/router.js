/**
 * Hash router. Routes are plain strings the UI can match. Hash routing keeps
 * deep links working when the built app is opened directly from disk or a
 * static server.
 */

const listeners = new Set();

export function currentPath() {
  const hash = window.location.hash || "#/";
  return hash.startsWith("#") ? hash.slice(1) || "/" : hash;
}

export function currentQuery() {
  const path = currentPath();
  const index = path.indexOf("?");
  if (index === -1) return new URLSearchParams();
  return new URLSearchParams(path.slice(index + 1));
}

export function currentRoute() {
  const path = currentPath().split("?")[0];
  return path.replace(/\/+$/, "") || "/";
}

export function navigate(to, { replace = false } = {}) {
  const target = to.startsWith("#") ? to : `#${to.startsWith("/") ? to : `/${to}`}`;
  if (replace) {
    window.location.replace(target);
  } else {
    window.location.hash = target;
  }
}

export function listen(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function emit() {
  const route = currentRoute();
  for (const callback of listeners) callback(route);
}

window.addEventListener("hashchange", emit);

export function initRouter() {
  if (!window.location.hash) {
    window.location.replace("#/");
  }
  emit();
}

/* Route helpers ----------------------------------------------------------- */

export function matchBook(route) {
  const m = /^\/study\/([^/]+)$/.exec(route);
  return m ? decodeURIComponent(m[1]) : null;
}

export function matchPlayer(route) {
  const m = /^\/media\/([^/]+)$/.exec(route);
  return m ? decodeURIComponent(m[1]) : null;
}

export function matchTool(route) {
  const m = /^\/tools\/([^/]+)$/.exec(route);
  return m ? decodeURIComponent(m[1]) : null;
}
