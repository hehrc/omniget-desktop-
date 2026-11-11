import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ToolJobRepo } from "../db.js";
import { OUTPUTS_DIR, assertInside, mimeFromName, safeName, uid, uniquePath } from "../util.js";
import { getTool } from "./registry.js";
import { systemTools } from "../bins.js";

export async function runTool({ toolId, values = {}, files = [], manager = null, settings }) {
  const tool = getTool(toolId);
  if (!tool) throw Object.assign(new Error("Unknown tool: " + toolId), { status: 404 });

  const system = await systemTools();
  const missing = (tool.requires || []).filter((req) => !system[req]?.available);
  if (missing.length) {
    throw Object.assign(new Error(tool.unavailableReason || `Missing dependency: ${missing.join(", ")}`), {
      status: 503,
    });
  }
  if (tool.requiresConfig === "ai" && !settings?.ai?.apiKey) {
    throw Object.assign(new Error("Configure an API key in Settings → AI before using this tool."), {
      status: 409,
    });
  }

  if (files.length < (tool.minFiles || 0)) {
    throw Object.assign(
      new Error(`This tool needs at least ${tool.minFiles} file${tool.minFiles === 1 ? "" : "s"}`),
      { status: 422 },
    );
  }
  if (tool.maxFiles >= 0 && files.length > tool.maxFiles) {
    throw Object.assign(new Error(`This tool accepts at most ${tool.maxFiles} file(s)`), { status: 422 });
  }
  if (tool.accept) {
    const allowed = tool.accept.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const file of files) {
      const ext = path.extname(file.name).toLowerCase();
      if (allowed.length && !allowed.includes(ext)) {
        throw Object.assign(new Error(`“${file.name}” is not an accepted file type (${tool.accept})`), {
          status: 422,
        });
      }
    }
  }

  const parsed = validateValues(tool, values);
  const jobId = uid("job_");
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  ToolJobRepo.insert({
    id: jobId,
    toolId,
    status: "running",
    input: { values: redact(parsed), files: files.map((f) => ({ name: f.name, size: f.size })) },
  });

  const ctx = {
    jobId,
    jobDir,
    values: parsed,
    files,
    manager,
    settings,
    log: () => {},
    out(name) {
      const rel = safeRel(name);
      const target = assertInside(jobDir, path.join(jobDir, rel));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return uniquePath(path.dirname(target), path.basename(target));
    },
  };

  try {
    const result = (await tool.run(ctx)) || {};
    const outputFiles = [];
    for (const file of result.files || []) {
      const rel = file.rel ? safeRel(file.rel) : path.relative(jobDir, file.path);
      const abs = assertInside(jobDir, file.path);
      let size = file.size;
      if (size === undefined) {
        try {
          size = (await fsp.stat(abs)).size;
        } catch {
          size = 0;
        }
      }
      outputFiles.push({
        name: file.name || path.basename(abs),
        rel: rel.split(path.sep).join("/"),
        url: `/api/outputs/${jobId}/${rel.split(path.sep).map(encodeURIComponent).join("/")}`,
        mime: file.mime || mimeFromName(abs),
        size,
      });
    }
    const output = {
      files: outputFiles,
      text: result.text || null,
      preview: result.preview || null,
      summary: result.summary || null,
      json: result.json || null,
      downloadId: result.downloadId || null,
      links: result.links || [],
    };
    ToolJobRepo.update(jobId, { status: "completed", output, completedAt: Date.now() });
    return { jobId, toolId, status: "completed", output };
  } catch (err) {
    ToolJobRepo.update(jobId, { status: "failed", error: String(err.message || err), completedAt: Date.now() });
    err.jobId = jobId;
    throw err;
  }
}

function validateValues(tool, input) {
  const out = {};
  for (const field of tool.fields || []) {
    let value = input[field.name];
    if (value === undefined || value === null || value === "") {
      if (field.default !== undefined) value = field.default;
    }
    if (field.type === "checkbox") {
      value = value === true || value === "true" || value === "on" || value === "1";
    }
    if (field.type === "number" && value !== undefined && value !== "") {
      value = Number(value);
      if (!Number.isFinite(value)) {
        throw Object.assign(new Error(`“${field.label}” must be a number`), { status: 422 });
      }
      const min = field.min !== undefined ? Number(field.min) : -Infinity;
      const max = field.max !== undefined ? Number(field.max) : Infinity;
      if (value < min || value > max) {
        throw Object.assign(new Error(`“${field.label}” must be between ${min} and ${max}`), { status: 422 });
      }
    }
    if (field.type === "select" && value !== undefined && value !== "") {
      const allowed = (field.options || []).map((o) => String(o.value));
      if (allowed.length && !allowed.includes(String(value))) {
        throw Object.assign(new Error(`“${field.label}” has an invalid choice`), { status: 422 });
      }
    }
    if (field.required && (value === undefined || value === "" || value === null)) {
      throw Object.assign(new Error(`“${field.label}” is required`), { status: 422 });
    }
    if (typeof value === "string" && value.length > 500_000) {
      throw Object.assign(new Error(`“${field.label}” is too long`), { status: 413 });
    }
    out[field.name] = value;
  }
  // Preserve any extra values the tool may rely on.
  for (const [key, value] of Object.entries(input)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

function safeRel(name) {
  const normalized = path.posix.normalize(String(name || "output").replace(/^[/\\]+/, ""));
  if (normalized.startsWith("../") || normalized === "..") {
    throw Object.assign(new Error("Invalid output path"), { status: 400 });
  }
  return normalized.split("/").filter((p) => p && p !== "." && p !== "..").map(safeName).join(path.sep) || "output";
}

function redact(values) {
  const copy = { ...values };
  for (const key of Object.keys(copy)) {
    if (/token|key|secret|password/i.test(key)) copy[key] = "••••••";
  }
  return copy;
}

export function outputPath(jobId, rel) {
  if (!/^job_[a-zA-Z0-9-]+$/.test(jobId)) {
    throw Object.assign(new Error("Invalid job id"), { status: 400 });
  }
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  const decoded = rel
    .split("/")
    .map((s) => decodeURIComponent(s))
    .join(path.sep);
  const target = path.resolve(jobDir, decoded);
  if (!target.startsWith(path.resolve(jobDir) + path.sep) && target !== path.resolve(jobDir)) {
    throw Object.assign(new Error("Invalid output path"), { status: 400 });
  }
  return target;
}

export async function cleanupJobs({ olderThanMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(OUTPUTS_DIR);
  } catch {
    return { removed };
  }
  for (const entry of entries) {
    const dir = path.join(OUTPUTS_DIR, entry);
    try {
      const stat = await fsp.stat(dir);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        await fsp.rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return { removed };
}
