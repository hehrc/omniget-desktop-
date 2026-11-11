/**
 * Tiny API client. Every request surfaces real server errors — nothing is
 * swallowed or replaced with fabricated success.
 */

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload || null;
  }
}

async function parse(res) {
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return await res.text();
}

export async function api(path, { method = "GET", body, headers = {}, signal } = {}) {
  const options = { method, headers: { ...headers }, signal };
  if (body !== undefined) {
    if (body instanceof FormData) {
      options.body = body;
    } else {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError("Could not reach the local OmniGet service. Is the server running?", 0, null);
  }
  const data = await parse(res);
  if (!res.ok) {
    const message =
      (data && typeof data === "object" && (data.error || data.message)) ||
      (typeof data === "string" && data) ||
      `Request failed with HTTP ${res.status}`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

export const get = (path, opts) => api(path, { ...opts, method: "GET" });
export const post = (path, body, opts) => api(path, { ...opts, method: "POST", body });
export const put = (path, body, opts) => api(path, { ...opts, method: "PUT", body });
export const patch = (path, body, opts) => api(path, { ...opts, method: "PATCH", body });
export const del = (path, opts) => api(path, { ...opts, method: "DELETE" });

/* ------------------------------- resources -------------------------------- */

export const systemApi = {
  health: () => get("/api/health"),
  info: () => get("/api/system"),
  stats: () => get("/api/stats"),
  sources: () => get("/api/sources"),
};

export const settingsApi = {
  get: () => get("/api/settings"),
  update: (patchValue) => put("/api/settings", { settings: patchValue }),
  reset: () => post("/api/settings/reset"),
  import: (payload) => post("/api/settings/import", payload),
  testAi: () => post("/api/settings/test-ai"),
  exportUrl: (includeSecrets = false) =>
    `/api/settings/export${includeSecrets ? "?secrets=1" : ""}`,
};

export const downloadApi = {
  list: (status = "all", limit = 200) =>
    get(`/api/downloads?status=${encodeURIComponent(status)}&limit=${limit}`),
  create: (payload) => post("/api/downloads", payload),
  bulk: (urls, options = {}) => post("/api/downloads/bulk", { urls, options }),
  probe: (url, signal) => post("/api/probe", { url }, { signal }),
  logs: (id) => get(`/api/downloads/${id}/logs`),
  outputs: (id) => get(`/api/downloads/${id}/outputs`),
  detail: (id) => get(`/api/downloads/${id}`),
  pause: (id) => post(`/api/downloads/${id}/pause`),
  resume: (id) => post(`/api/downloads/${id}/resume`),
  cancel: (id) => post(`/api/downloads/${id}/cancel`),
  retry: (id) => post(`/api/downloads/${id}/retry`),
  remove: (id, deleteFile = false) =>
    del(`/api/downloads/${id}${deleteFile ? "?deleteFile=1" : ""}`),
  reveal: (id) => post(`/api/downloads/${id}/reveal`),
  history: () => get("/api/history"),
  clearHistory: (deleteFiles = false) => del("/api/history", { body: { deleteFiles } }),
  fileUrl: (id, download = false) =>
    `/api/downloads/${id}/file${download ? "?download=1" : ""}`,
};

export const mediaApi = {
  list: () => get("/api/media"),
  get: (id) => get(`/api/media/${id}`),
  import: (files) => {
    const fd = new FormData();
    for (const file of files) fd.append("files", file, file.name);
    return post("/api/media/import", fd);
  },
  update: (id, payload) => patch(`/api/media/${id}`, payload),
  remove: (id, deleteFile = true) =>
    del(`/api/media/${id}${deleteFile ? "" : "?deleteFile=0"}`),
  addSubtitle: (id, file, { label, lang } = {}) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    if (label) fd.append("label", label);
    if (lang) fd.append("lang", lang);
    return post(`/api/media/${id}/subtitles`, fd);
  },
  removeSubtitle: (id, subId) => del(`/api/media/${id}/subtitles/${subId}`),
  fileUrl: (id) => `/api/media/${id}/file`,
};

export const bookApi = {
  list: () => get("/api/books"),
  get: (id) => get(`/api/books/${id}`),
  import: (files) => {
    const fd = new FormData();
    for (const file of files) fd.append("files", file, file.name);
    return post("/api/books/import", fd);
  },
  chapter: (id, index) => get(`/api/books/${id}/chapter/${index}`),
  update: (id, payload) => patch(`/api/books/${id}`, payload),
  remove: (id, deleteFiles = true) =>
    del(`/api/books/${id}${deleteFiles ? "" : "?deleteFiles=0"}`),
  addBookmark: (id, payload) => post(`/api/books/${id}/bookmarks`, payload),
  removeBookmark: (id, bookmarkId) => del(`/api/books/${id}/bookmarks/${bookmarkId}`),
  coverUrl: (id) => `/api/books/${id}/cover`,
  fileUrl: (id) => `/api/books/${id}/file`,
};

export const notesApi = {
  list: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.targetType) qs.set("targetType", params.targetType);
    if (params.targetId) qs.set("targetId", params.targetId);
    if (params.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    return get(`/api/notes${suffix}`);
  },
  add: (payload) => post("/api/notes", payload),
  update: (id, body) => patch(`/api/notes/${id}`, { body }),
  remove: (id) => del(`/api/notes/${id}`),
};

export const bookmarkApi = {
  list: (targetType, targetId) =>
    get(`/api/bookmarks?targetType=${encodeURIComponent(targetType)}&targetId=${encodeURIComponent(targetId)}`),
  add: (payload) => post("/api/bookmarks", payload),
  remove: (id) => del(`/api/bookmarks/${id}`),
};

export const toolsApi = {
  list: () => get("/api/tools"),
  run: (id, formData) => post(`/api/tools/${id}/run`, formData),
  jobs: () => get("/api/tools/jobs"),
  job: (id) => get(`/api/tools/jobs/${id}`),
  clearJobs: () => del("/api/tools/jobs"),
};

export const fsApi = {
  list: (path) => get(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  mkdir: (path) => post("/api/fs/mkdir", { path }),
  reveal: (path) => post("/api/fs/reveal", { path }),
};

export const dataApi = {
  exportUrl: "/api/data/export",
  size: () => get("/api/data/size"),
  clearHistory: (deleteFiles = false) => post("/api/data/clear-history", { deleteFiles }),
};
