import { createRequire as codexCreateRequire } from "node:module"; const require = codexCreateRequire(import.meta.url);
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// source/scripts/bridge-core.mjs
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error2) {
    if (error2.code === "ENOENT") return fallback;
    throw new BridgeError("INVALID_BRIDGE_STATE", `Cannot read ${file}: ${error2.message}`);
  }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error2) {
    return error2.code === "EPERM";
  }
}
function canonicalPath(given) {
  const absolute = path.resolve(given);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}
function samePath(first, second) {
  if (typeof first !== "string" || typeof second !== "string") return false;
  const a = canonicalPath(first), b = canonicalPath(second);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function reapDeadReaper(directory, initializationGraceMs) {
  const stat = fs.statSync(directory, { throwIfNoEntry: false });
  if (!stat) return;
  const names = fs.readdirSync(directory);
  const markers = names.filter((name) => name === "owner.json" || /^owner-[A-Za-z0-9-]+\.json$/.test(name));
  if (names.length !== markers.length || markers.length > 1) return;
  const marker = markers[0];
  let owner;
  if (marker) {
    try {
      owner = readJson(path.join(directory, marker));
    } catch (error2) {
      if (error2.code !== "INVALID_BRIDGE_STATE") throw error2;
    }
  }
  const valid = owner && Number.isInteger(owner.pid) && typeof owner.token === "string" && Number.isFinite(owner.at);
  if (valid ? alive(owner.pid) : Date.now() - stat.mtimeMs <= initializationGraceMs) return;
  if (marker) fs.rmSync(path.join(directory, marker), { force: true });
  try {
    fs.rmdirSync(directory);
  } catch (error2) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error2.code)) throw error2;
  }
}
function tryReaper(directory, initializationGraceMs) {
  const token = randomUUID();
  const marker = `owner-${token}.json`;
  const staging = `${directory}.${process.pid}.${token}.initializing`;
  fs.mkdirSync(staging);
  let published = false;
  try {
    fs.writeFileSync(path.join(staging, marker), JSON.stringify({ pid: process.pid, token, at: Date.now() }), { mode: 384 });
    if (fs.existsSync(directory)) reapDeadReaper(directory, initializationGraceMs);
    if (fs.existsSync(directory)) return null;
    try {
      fs.renameSync(staging, directory);
      published = true;
    } catch (error2) {
      if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error2.code)) return null;
      throw error2;
    }
    return () => {
      fs.rmSync(path.join(directory, marker), { force: true });
      try {
        fs.rmdirSync(directory);
      } catch (error2) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error2.code)) throw error2;
      }
    };
  } finally {
    if (!published) {
      fs.rmSync(path.join(staging, marker), { force: true });
      try {
        fs.rmdirSync(staging);
      } catch (error2) {
        if (error2.code !== "ENOENT") throw error2;
      }
    }
  }
}
async function withLock(lockPath, action, { timeoutMs = 45e3, staleMs = 12e4, initializationGraceMs = 1e4 } = {}) {
  const token = randomUUID();
  const ownerFile = path.join(lockPath, "owner.json");
  const initializing = `${lockPath}.${process.pid}.${token}.initializing`;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(initializing);
  fs.writeFileSync(path.join(initializing, "owner.json"), JSON.stringify({ pid: process.pid, token, at: Date.now() }), { mode: 384 });
  let acquired = false;
  const removeInitializing = () => {
    fs.rmSync(path.join(initializing, "owner.json"), { force: true });
    try {
      fs.rmdirSync(initializing);
    } catch (error2) {
      if (error2.code !== "ENOENT") throw error2;
    }
  };
  try {
    for (; ; ) {
      try {
        if (!fs.existsSync(lockPath)) {
          await fsp.rename(initializing, lockPath);
          acquired = true;
          break;
        }
      } catch (error2) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error2.code)) throw error2;
      }
      const reaper = `${lockPath}.reaper`;
      let releaseReaper;
      try {
        releaseReaper = tryReaper(reaper, initializationGraceMs);
        if (!releaseReaper) {
          if (Date.now() >= deadline) throw new BridgeError("BRIDGE_BUSY", "Another lock owner or recovery process is still running; try again.");
          await sleep(25);
          continue;
        }
        let owner;
        try {
          owner = readJson(ownerFile);
        } catch (error2) {
          if (error2.code !== "INVALID_BRIDGE_STATE") throw error2;
        }
        const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
        const valid = owner && Number.isInteger(owner.pid) && typeof owner.token === "string" && Number.isFinite(owner.at);
        const expired = stat && (valid ? Date.now() - owner.at > staleMs && !alive(owner.pid) : Date.now() - stat.mtimeMs > initializationGraceMs);
        if (expired) {
          fs.rmSync(ownerFile, { force: true });
          fs.rmdirSync(lockPath);
        }
      } catch (error2) {
        if (!["EEXIST", "ENOENT", "ENOTEMPTY"].includes(error2.code)) throw error2;
      } finally {
        releaseReaper?.();
      }
      if (Date.now() >= deadline) throw new BridgeError("BRIDGE_BUSY", "Another comment delivery or editor operation is still running; try again.");
      await sleep(25);
    }
    return await action();
  } finally {
    if (acquired && readJson(ownerFile)?.token === token) {
      fs.rmSync(ownerFile, { force: true });
      try {
        fs.rmdirSync(lockPath);
      } catch (error2) {
        if (error2.code !== "ENOTEMPTY") throw error2;
      }
    }
    if (!acquired) removeInitializing();
  }
}
var BINDING_FILE, BridgeError, sleep;
var init_bridge_core = __esm({
  "source/scripts/bridge-core.mjs"() {
    BINDING_FILE = ".codex-design-bridge.json";
    BridgeError = class extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    };
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  }
});

// source/scripts/worker-core.mjs
import path5 from "node:path";
function loadJobs(root) {
  const state = readJson(path5.join(root, WORKER_JOBS_FILE), { version: 1, jobs: {}, order: [] });
  if (state.version !== 1 || !state.jobs || typeof state.jobs !== "object" || Array.isArray(state.jobs) || !Array.isArray(state.order)) {
    throw new BridgeError("INVALID_WORKER_JOBS", "The design worker job journal is invalid; preserve it and inspect it before retrying.");
  }
  return state;
}
function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    kind: job.event.kind,
    commentId: job.event.data.id,
    queuedAt: job.queuedAt,
    ...job.startedAt ? { startedAt: job.startedAt } : {},
    ...job.completedAt ? { completedAt: job.completedAt } : {},
    ...job.repliedAt ? { repliedAt: job.repliedAt } : {},
    ...job.error ? { error: job.error } : {},
    ...job.ownerThreadId ? { ownerThreadId: job.ownerThreadId } : {}
  };
}
var WORKER_FILE, WORKER_JOBS_FILE, WORKER_LOG_FILE;
var init_worker_core = __esm({
  "source/scripts/worker-core.mjs"() {
    init_bridge_core();
    WORKER_FILE = ".codex-design-worker.json";
    WORKER_JOBS_FILE = ".codex-design-worker-jobs.json";
    WORKER_LOG_FILE = ".codex-design-worker.log";
  }
});

// source/scripts/worker-client.mjs
import path6 from "node:path";
function readRegistry(root) {
  const registry = readJson(registryFile(root));
  if (registry?.url || registry?.token) throw new BridgeError("LEGACY_WORKER_STATE", "A legacy process-backed worker record remains. Preserve and inspect it before registering a native worker.");
  if (registry && (registry.version !== 1 || !samePath(registry.root, root))) throw new BridgeError("INVALID_WORKER_REGISTRY", "The native worker registry is invalid.");
  return registry;
}
async function getWorkerStatus(root) {
  const registry = readRegistry(root);
  const binding = readJson(path6.join(root, BINDING_FILE));
  const state = loadJobs(root);
  const jobs = state.order.map((id) => state.jobs[id]).filter(Boolean).map(publicJob);
  const counts = Object.fromEntries(["pending", "active", "completed", "failed", "superseded"].map((status) => [status, jobs.filter((job) => job.status === status).length]));
  const listening = Boolean(registry?.listener && registry.listener.expiresAt > Date.now() && alive(registry.listener.pid));
  return {
    mode: "native",
    running: listening,
    listening,
    nativeThreadId: registry?.nativeThreadId ?? null,
    name: registry?.name ?? null,
    status: registry?.status ?? "unregistered",
    originThreadId: binding?.threadId ?? null,
    needsResume: (counts.pending > 0 || counts.active > 0) && !listening,
    counts,
    jobs,
    note: "Local listener presence is not native agent liveness. The parent checks the real native agent before deciding to resume or replace it.",
    ...registry?.lastSeenAt ? { lastSeenAt: registry.lastSeenAt } : {},
    log: path6.join(root, WORKER_LOG_FILE)
  };
}
var registryFile;
var init_worker_client = __esm({
  "source/scripts/worker-client.mjs"() {
    init_bridge_core();
    init_worker_core();
    registryFile = (root) => path6.join(root, WORKER_FILE);
  }
});

// source/scripts/artifact-command.mjs
async function verifyEditorInstance(state, root, kind) {
  const fail = () => new BridgeError("EDITOR_IDENTITY_UNVERIFIED", "The recorded PID was not confirmed by this plugin editor’s live session endpoint. No process was stopped and its records were preserved; inspect the existing editor/process manually.");
  if (!state || !alive(state.pid) || state.kind !== kind || !samePath(state.root, root)) throw fail();
  try {
    const url = new URL("__codex/editor-session", state.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw fail();
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2e3), headers: { Accept: "application/json" } });
    if (!response.ok) throw fail();
    const session = await response.json();
    if (session.pid !== state.pid || session.kind !== kind || !samePath(session.root, root) || !alive(state.pid)) throw fail();
    return session;
  } catch {
    throw fail();
  }
}
var init_artifact_command = __esm({
  "source/scripts/artifact-command.mjs"() {
    init_bridge_core();
    init_worker_client();
  }
});

// source/scripts/library-preview.mjs
import fs6 from "node:fs";
import path10 from "node:path";
import { spawn as spawn2 } from "node:child_process";
import { fileURLToPath as fileURLToPath3, pathToFileURL } from "node:url";

// source/library/index.mjs
import fs4 from "node:fs/promises";
import os from "node:os";
import path4 from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";

// source/library/safety.mjs
init_bridge_core();
import fs2 from "node:fs/promises";
import { constants } from "node:fs";
import path2 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var LibraryError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
    if (details !== void 0) this.details = details;
  }
};
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var KINDS = Object.freeze(["slides", "design", "design-system", "dashboard"]);
function artifactId(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new LibraryError("INVALID_ID", "Expected a persistent artifact UUID.");
  return id.toLowerCase();
}
function artifactKind(kind) {
  if (!KINDS.includes(kind)) throw new LibraryError("INVALID_KIND", "Unknown artifact kind.");
  return kind;
}
function titleText(title) {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(title)) throw new LibraryError("INVALID_TITLE", "A title must be one nonempty line of at most 200 characters.");
  return title.trim();
}
function relativePath(relative) {
  if (typeof relative !== "string" || !relative || relative.length > 1024 || relative.includes("\\") || path2.isAbsolute(relative) || /[\u0000-\u001f\u007f:%]/.test(relative)) throw new LibraryError("INVALID_PATH", "Expected a package-relative path.");
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.trimEnd() !== part || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new LibraryError("INVALID_PATH", "Unsafe path segment.");
  return parts.join("/");
}
function within(root, target) {
  const relative = path2.relative(path2.resolve(root), path2.resolve(target));
  if (relative === ".." || relative.startsWith(".." + path2.sep) || path2.isAbsolute(relative)) throw new LibraryError("INVALID_PATH", "The path leaves its authorized root.");
  return target;
}
async function statOrNull(file) {
  try {
    return await fs2.lstat(file);
  } catch (error2) {
    if (error2.code === "ENOENT") return null;
    throw error2;
  }
}
async function safePath(root, relative, { mustExist = true, type } = {}) {
  relativePath(relative);
  const rootStat = await statOrNull(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new LibraryError("SYMLINK_REFUSED", "The authorized root must be a real directory.");
  const realRoot = await fs2.realpath(root);
  let cursor = root;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    cursor = within(root, path2.join(cursor, parts[i]));
    const info = await statOrNull(cursor);
    if (!info) {
      if (mustExist) throw new LibraryError("NOT_FOUND", "The requested path is missing.", { path: relative });
      return cursorFor(root, parts);
    }
    if (info.isSymbolicLink()) throw new LibraryError("SYMLINK_REFUSED", "Symbolic links are not accepted in library paths.", { path: relative });
    if (i < parts.length - 1 && !info.isDirectory()) throw new LibraryError("INVALID_PATH", "A parent path is not a directory.");
    within(realRoot, await fs2.realpath(cursor));
    if (i === parts.length - 1 && type === "file" && !info.isFile()) throw new LibraryError("INVALID_PATH", "The requested path is not a regular file.");
    if (i === parts.length - 1 && type === "directory" && !info.isDirectory()) throw new LibraryError("INVALID_PATH", "The requested path is not a directory.");
  }
  return cursor;
}
var cursorFor = (root, parts) => within(root, path2.join(root, ...parts));
async function readJson2(root, relative, fallback) {
  const file = await safePath(root, relative, { mustExist: false });
  try {
    return JSON.parse(await fs2.readFile(file, "utf8"));
  } catch (error2) {
    if (error2.code === "ENOENT") {
      if (fallback !== void 0) return structuredClone(fallback);
      throw new LibraryError("NOT_FOUND", "The requested JSON file is missing.", { path: relative });
    }
    if (error2 instanceof LibraryError) throw error2;
    throw new LibraryError("INVALID_STATE", "A library JSON file is malformed.", { path: relative });
  }
}
async function atomicJson(root, relative, value) {
  const file = await safePath(root, relative, { mustExist: false });
  await fs2.mkdir(path2.dirname(file), { recursive: true });
  await safePath(root, relative, { mustExist: false });
  const temporary = `${file}.${randomUUID2()}.tmp`;
  within(root, temporary);
  try {
    await fs2.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 384 });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs2.rename(temporary, file);
        break;
      } catch (error2) {
        if (!["EACCES", "EBUSY", "EPERM"].includes(error2.code) || attempt >= 12) throw error2;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } finally {
    await fs2.rm(temporary, { force: true });
  }
}
async function readBytes(root, relative, maximum) {
  const file = await safePath(root, relative, { type: "file" });
  const handle = await fs2.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new LibraryError("LIMIT_EXCEEDED", "The file exceeds the allowed size.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function locked(root, action, timeoutMs = 1e4) {
  const state = await safePath(root, "_state", { type: "directory" });
  const lock = within(root, path2.join(state, "library.lock"));
  if ((await statOrNull(lock))?.isSymbolicLink()) throw new LibraryError("SYMLINK_REFUSED", "The library lock must be a real directory.");
  try {
    return await withLock(lock, action, { timeoutMs, staleMs: 1e4 });
  } catch (cause) {
    if (cause.code === "BRIDGE_BUSY") throw new LibraryError("LIBRARY_BUSY", "Another library operation is still in progress.");
    throw cause;
  }
}

// source/library/content.mjs
import fs3 from "node:fs/promises";
import path3 from "node:path";
var INDEX_FILES = Object.freeze({ slides: "project/deck.json", design: "project/canvas.json", "design-system": "project/design-system.json", dashboard: "db/dash/meta.json" });
var DEFAULT_LIMITS = Object.freeze({ maxFiles: 2048, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024, maxBundleBytes: 180 * 1024 * 1024 });
var forbidden = (part) => ["comments.json", "node_modules", "_state", "_trash"].includes(part) || part.startsWith(".") && part !== ".image-slots.state.json";
function contentPath(kind, relative) {
  relativePath(relative);
  artifactKind(kind);
  const parts = relative.split("/");
  if (parts.some(forbidden)) return false;
  if (kind !== "dashboard") return parts[0] === "project" && parts.length > 1;
  return parts[0] === "_blobs" && parts.length === 2 || parts[0] === "db" && parts.length >= 3 && ["files", "datasets"].includes(parts[1]) || /^db\/dash\/(?:meta|params|look)\.json$/.test(relative);
}
function contentType(relative) {
  const ext = path3.extname(relative).toLowerCase();
  return { ".html": "text/html", ".md": "text/markdown", ".json": "application/json", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".txt": "text/plain", ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".pdf": "application/pdf" }[ext] || "application/octet-stream";
}
async function collectContent(root, kind, limits = DEFAULT_LIMITS, { includeBytes = true } = {}) {
  const found = [];
  let total = 0;
  const walk = async (relative) => {
    const absolute = await safePath(root, relative, { mustExist: false });
    const info = await statOrNull(absolute);
    if (!info) return;
    if (info.isSymbolicLink()) throw new LibraryError("SYMLINK_REFUSED", "A content path is a symbolic link.");
    if (info.isDirectory()) {
      for (const entry2 of (await fs3.readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (forbidden(entry2.name)) continue;
        const child = relative + "/" + entry2.name;
        relativePath(child);
        if (entry2.isSymbolicLink()) throw new LibraryError("SYMLINK_REFUSED", "A content path is a symbolic link.", { path: child });
        await walk(child);
      }
    } else if (info.isFile() && contentPath(kind, relative)) {
      if (info.size > limits.maxFileBytes || total + info.size > limits.maxTotalBytes || found.length >= limits.maxFiles) throw new LibraryError("LIMIT_EXCEEDED", "The artifact exceeds the configured content limits.");
      total += info.size;
      found.push({ path: relative, bytes: info.size, contentType: contentType(relative), ...includeBytes ? { data: (await readBytes(root, relative, limits.maxFileBytes)).toString("base64"), encoding: "base64" } : {} });
    } else if (!info.isFile()) throw new LibraryError("INVALID_CONTENT", "Only regular files are accepted as content.");
  };
  for (const start of kind === "dashboard" ? ["db/files", "db/datasets", "db/dash/meta.json", "db/dash/params.json", "db/dash/look.json", "_blobs"] : ["project"]) await walk(start);
  return found;
}
function validateFiles(kind, files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const json = (relative) => {
    const file = byPath.get(relative);
    if (!file) throw new LibraryError("MISSING_CONTENT", "A required native content file is missing.", { path: relative });
    try {
      const value = JSON.parse(Buffer.from(file.data, "base64").toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw new LibraryError("INVALID_CONTENT", "A native index is not a JSON object.", { path: relative });
    }
  };
  const index = json(INDEX_FILES[kind]);
  if (typeof index.title !== "string" || !index.title.trim()) throw new LibraryError("INVALID_CONTENT", "The native index needs a title.");
  const blobExists = (id) => kind === "dashboard" ? byPath.has("_blobs/" + id) : [...byPath.keys()].some((name) => name.startsWith((kind === "design-system" ? "project/_blobs/" : "project/assets/") + id + "."));
  for (const file of files) if (/\.(?:html|css|js|mjs|json|md|svg)$/i.test(file.path)) {
    const text = Buffer.from(file.data, "base64").toString("utf8");
    for (const match of text.matchAll(/\/_blob\/([a-f0-9]{32})\b/g)) if (!blobExists(match[1])) throw new LibraryError("MISSING_CONTENT", "An artwork material referenced by the content is missing.", { path: file.path, blobId: match[1] });
  }
  if (kind === "slides") {
    if (!Array.isArray(index.order)) throw new LibraryError("INVALID_CONTENT", "A deck needs an order array.");
    for (const id of index.order) {
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !byPath.has("project/slides/" + id + ".html")) throw new LibraryError("MISSING_CONTENT", "A slide named by the index is missing or invalid.");
    }
  } else if (kind === "design") {
    if (!index.boards || typeof index.boards !== "object" || Array.isArray(index.boards) || !Array.isArray(index.order)) throw new LibraryError("INVALID_CONTENT", "A canvas needs boards and order.");
    for (const name of Object.keys(index.boards)) {
      relativePath(name);
      if (!name.endsWith(".dc.html") || !byPath.has("project/" + name)) throw new LibraryError("MISSING_CONTENT", "An indexed artboard is missing.");
    }
  } else if (kind === "design-system") {
    if (index.v < 3 || index.layout !== "files" || !(index.createdOnFiles || index.convertedFrom)) throw new LibraryError("INVALID_CONTENT", "The design-system index is not in the editable files format.");
    const tokens = json("project/tokens.json");
    for (const font of tokens.type?.fonts || []) if (typeof font.file === "string") {
      const name = "project/" + relativePath(font.file);
      if (!byPath.has(name)) throw new LibraryError("MISSING_CONTENT", "A design-system font file is missing.", { path: name });
    }
  } else {
    const page = json("db/files/index.html.json");
    if (typeof page.text !== "string") throw new LibraryError("INVALID_CONTENT", "A dashboard needs files/index.html text.");
    for (const file of files.filter((file2) => /^db\/datasets\/.+\.json$/.test(file2.path))) {
      const dataset = json(file.path);
      const id = /^\/_blob\/([a-f0-9]{32})$/.exec(dataset.source?.url || "")?.[1];
      if (id && !byPath.has("_blobs/" + id)) throw new LibraryError("MISSING_CONTENT", "A dashboard dataset attachment is missing.");
    }
  }
  return index;
}
async function writeContent(root, files) {
  for (const file of files) {
    const absolute = await safePath(root, file.path, { mustExist: false });
    await fs3.mkdir(path3.dirname(absolute), { recursive: true });
    await safePath(root, file.path, { mustExist: false });
    await fs3.writeFile(within(root, absolute), Buffer.from(file.data, "base64"), { flag: "wx" });
  }
}
var entry = (file, value) => ({ path: file, encoding: "base64", data: Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n").toString("base64") });
var escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function blankContent(kind, title, at2) {
  const marker = { v: 1, at: at2 };
  if (kind === "slides") return [entry("project/deck.json", { v: 4, createdOnFiles: marker, lists: "css", title, order: ["cover"], cover: "cover", sections: {}, faces: {}, designSystems: [] }), entry("project/slides/cover.html", '<section id="cover" style="background:#ffffff;color:#20211f;font-family:Arial,sans-serif;padding:128px;display:flex;flex-direction:column;gap:32px"></section>\n')];
  if (kind === "design") return [entry("project/canvas.json", { v: 3, createdOnFiles: marker, title, launch: { view: "canvas" }, pages: [], boards: {}, order: [], notes: {}, designSystems: [] })];
  if (kind === "design-system") return [
    entry("project/design-system.json", { v: 3, layout: "files", createdOnFiles: marker, title, namespace: "DesignSystem", libraries: [], sections: {}, groups: [], assetGroups: {}, blobs: {}, docs: { readme: "project/README.md", sections: [] } }),
    entry("project/tokens.json", { name: title, version: 1, color: { themes: [{ id: "light", name: "Light" }], tokens: [] }, type: { fonts: [], families: { sans: "Arial, sans-serif" }, groups: [] }, spacing: { tokens: [] }, radius: { tokens: [] } }),
    entry("project/README.md", "# " + title + "\n"),
    entry("project/components/Cover/preview.html", '<!-- @dsCard group="Overview" height=160 -->\n<div style="min-height:120px"></div>\n')
  ];
  return [entry("db/dash/meta.json", { title }), entry("db/dash/params.json", {}), entry("db/files/index.html.json", { text: '<meta name="dash-one-writer"><style>#dash-root{color:#20211f;background:#fafaf8;font-family:Arial,sans-serif}#dash-root .library-blank-title{color:#20211f;font-size:28px;font-weight:500}</style><h1 class="library-blank-title">' + escape(title) + "</h1>" })];
}

// source/library/index.mjs
var BUNDLE_FORMAT = "codex-design-artifact";
var catalogFile = "_state/catalog.json";
var viewFile = "_state/view.json";
var bindingsFile = "_state/bindings.json";
var emptyCatalog = () => ({ version: 1, artifacts: {} });
var libraryTab = () => ({ id: "library", type: "library" });
var emptyView = () => ({ version: 1, tabs: [libraryTab()], activeTabId: "library" });
var at = () => (/* @__PURE__ */ new Date()).toISOString();
var metadata = (value) => {
  if (value.formatVersion !== void 0 && value.formatVersion !== 1) throw new LibraryError("UNSUPPORTED_FORMAT", "This artifact manifest needs a supported format version.");
  return {
    id: artifactId(value.id),
    kind: artifactKind(value.kind),
    title: titleText(value.title),
    formatVersion: 1,
    createdAt: typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : at(),
    updatedAt: typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : at(),
    favorite: value.favorite === true,
    ...value.sourceArtifactId && UUID.test(value.sourceArtifactId) ? { sourceArtifactId: value.sourceArtifactId } : {},
    ...typeof value.deletedAt === "string" ? { deletedAt: value.deletedAt } : {}
  };
};
var LibraryStore = class {
  constructor({ root = path4.join(os.homedir(), ".codex", "CodexDesignLibrary"), isBusy = async () => false, limits = {} } = {}) {
    if (typeof root !== "string" || !root.trim()) throw new LibraryError("INVALID_PATH", "A library root is required.");
    if (typeof isBusy !== "function") throw new LibraryError("INVALID_OPTION", "isBusy must be a function.");
    this.root = path4.resolve(root);
    this.isBusy = isBusy;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new LibraryError("INVALID_OPTION", "Content limits must be positive integers.");
  }
  async initialize() {
    if (!this.ready) this.ready = this._initialize().catch((error2) => {
      this.ready = null;
      throw error2;
    });
    await this.ready;
    return this;
  }
  async _initialize() {
    const existing = await statOrNull(this.root);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new LibraryError("SYMLINK_REFUSED", "The library root must be a real directory.");
    await fs4.mkdir(this.root, { recursive: true });
    this.realRoot = await fs4.realpath(this.root);
    for (const relative of [...KINDS, "_state", "_trash"]) {
      const directory = await safePath(this.root, relative, { mustExist: false });
      await fs4.mkdir(directory, { recursive: true });
      await safePath(this.root, relative, { type: "directory" });
    }
    await locked(this.root, async () => {
      let identity = await readJson2(this.root, "_state/library.json", null);
      if (!identity) {
        identity = { version: 1, id: randomUUID3(), createdAt: at() };
        await atomicJson(this.root, "_state/library.json", identity);
      }
      if (identity.version !== 1 || !UUID.test(identity.id)) throw new LibraryError("INVALID_STATE", "The library identity is invalid.");
      this.libraryId = identity.id;
      const catalog = await this._catalog();
      for (const kind of KINDS) {
        for (const entry2 of await fs4.readdir(await safePath(this.root, kind, { type: "directory" }), { withFileTypes: true })) {
          if (!UUID.test(entry2.name) || entry2.isSymbolicLink() || !entry2.isDirectory()) continue;
          const relative = `${kind}/${entry2.name}/artifact.json`;
          if (!await statOrNull(await safePath(this.root, relative, { mustExist: false }))) continue;
          const manifest = metadata(await readJson2(this.root, relative));
          if (manifest.id !== entry2.name.toLowerCase() || manifest.kind !== kind) throw new LibraryError("INVALID_MANIFEST", "Artifact directory and identity disagree.");
          const previous = catalog.artifacts[manifest.id];
          if (previous && (previous.location === "trash" || previous.kind !== kind) && await statOrNull(await safePath(this.root, this._relative(previous), { mustExist: false }))) throw new LibraryError("ID_CONFLICT", "An artifact id exists in more than one physical location.");
          catalog.artifacts[manifest.id] = { ...manifest, location: "active" };
        }
      }
      for (const entry2 of await fs4.readdir(await safePath(this.root, "_trash", { type: "directory" }), { withFileTypes: true })) {
        if (!UUID.test(entry2.name) || entry2.isSymbolicLink() || !entry2.isDirectory()) continue;
        const relative = `_trash/${entry2.name}/artifact.json`;
        if (!await statOrNull(await safePath(this.root, relative, { mustExist: false }))) continue;
        const manifest = metadata(await readJson2(this.root, relative));
        if (manifest.id !== entry2.name.toLowerCase()) throw new LibraryError("INVALID_MANIFEST", "A recycled artifact has a different directory identity.");
        const previous = catalog.artifacts[manifest.id];
        if (previous && previous.location === "active" && await statOrNull(await safePath(this.root, `${previous.kind}/${manifest.id}`, { mustExist: false }))) throw new LibraryError("ID_CONFLICT", "An artifact id exists in both active storage and trash.");
        catalog.artifacts[manifest.id] = { ...manifest, location: "trash" };
      }
      await this._saveCatalog(catalog);
      if (!await statOrNull(await safePath(this.root, viewFile, { mustExist: false }))) await atomicJson(this.root, viewFile, emptyView());
      if (!await statOrNull(await safePath(this.root, bindingsFile, { mustExist: false }))) await atomicJson(this.root, bindingsFile, { version: 1, artifacts: {} });
    });
  }
  async _checkRoot() {
    await this.initialize();
    if ((await fs4.lstat(this.root)).isSymbolicLink() || await fs4.realpath(this.root) !== this.realRoot) throw new LibraryError("ROOT_CHANGED", "The library root changed after initialization.");
  }
  async _catalog() {
    const value = await readJson2(this.root, catalogFile, emptyCatalog());
    if (value.version !== 1 || !value.artifacts || typeof value.artifacts !== "object" || Array.isArray(value.artifacts)) throw new LibraryError("INVALID_STATE", "The library catalog is invalid.");
    for (const [id, record] of Object.entries(value.artifacts)) {
      if (artifactId(id) !== record.id || !["active", "trash"].includes(record.location)) throw new LibraryError("INVALID_STATE", "A catalog identity is invalid.");
      metadata(record);
    }
    return value;
  }
  _saveCatalog(catalog) {
    return atomicJson(this.root, catalogFile, catalog);
  }
  _relative(record) {
    return record.location === "trash" ? `_trash/${record.id}` : `${artifactKind(record.kind)}/${artifactId(record.id)}`;
  }
  async _artifactPath(record, mustExist = true) {
    return safePath(this.root, this._relative(record), { mustExist, type: "directory" });
  }
  async _raw(id, { includeDeleted = false } = {}) {
    id = artifactId(id);
    const catalog = await this._catalog();
    const record = catalog.artifacts[id];
    if (!record || !includeDeleted && record.location === "trash") throw new LibraryError("NOT_FOUND", "No such artifact.");
    return { record, catalog };
  }
  async _inspect(record) {
    const result = { ...metadata(record), path: path4.join(this.root, ...this._relative(record).split("/")), contentStatus: "ok", deleted: record.location === "trash" };
    try {
      const root = await this._artifactPath(record);
      const manifest = metadata(await readJson2(root, "artifact.json"));
      if (manifest.id !== record.id || manifest.kind !== record.kind) throw new LibraryError("INVALID_MANIFEST", "The artifact identity changed.");
      const listed = await collectContent(root, record.kind, this.limits, { includeBytes: false });
      const needed = /* @__PURE__ */ new Set([INDEX_FILES[record.kind], "project/tokens.json", "db/files/index.html.json"]);
      const files = [];
      for (const file of listed) files.push({ ...file, data: needed.has(file.path) || /\.(?:html|css|js|mjs|json|md|svg)$/i.test(file.path) ? (await readBytes(root, file.path, this.limits.maxFileBytes)).toString("base64") : "" });
      const native = validateFiles(record.kind, files);
      Object.assign(result, manifest, { title: native.title });
    } catch (error2) {
      result.contentStatus = ["NOT_FOUND", "MISSING_CONTENT"].includes(error2.code) ? "missing" : "invalid";
      result.contentError = { code: error2.code || "INVALID_CONTENT", message: error2.message };
    }
    return result;
  }
  async _busy(record) {
    const result = await this.isBusy(await this._inspect(record));
    if (result === true || result?.busy) throw new LibraryError("ARTIFACT_BUSY", result?.reason || "This artifact still has an active editor task. No agent was stopped.");
  }
  async list({ kind, query = "", favoritesOnly = false, includeDeleted = false } = {}) {
    await this._checkRoot();
    if (kind) artifactKind(kind);
    if (typeof query !== "string" || query.length > 500) throw new LibraryError("INVALID_QUERY", "Search text is too long.");
    const needle = query.trim().toLocaleLowerCase();
    const catalog = await this._catalog();
    const records = [];
    for (const entry2 of Object.values(catalog.artifacts)) {
      if (kind && entry2.kind !== kind || !includeDeleted && entry2.location === "trash" || favoritesOnly && !entry2.favorite) continue;
      const record = await this._inspect(entry2);
      if (!needle || `${record.title} ${record.kind}`.toLocaleLowerCase().includes(needle)) records.push(record);
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
  }
  async get(id, options = {}) {
    await this._checkRoot();
    return this._inspect((await this._raw(id, options)).record);
  }
  async _stage() {
    const relative = `_state/staging/${randomUUID3()}`;
    const absolute = await safePath(this.root, relative, { mustExist: false });
    await fs4.mkdir(absolute, { recursive: true });
    await safePath(this.root, relative, { type: "directory" });
    return { relative, absolute };
  }
  async _removeStage(stage) {
    const absolute = await safePath(this.root, stage.relative, { mustExist: false });
    within(path4.join(this.root, "_state/staging"), absolute);
    await fs4.rm(absolute, { recursive: true, force: true });
  }
  _retitle(kind, files, title) {
    return files.map((file) => {
      if (file.path !== INDEX_FILES[kind]) return file;
      const value = JSON.parse(Buffer.from(file.data, "base64").toString("utf8"));
      value.title = title;
      return { ...file, data: Buffer.from(JSON.stringify(value, null, 2) + "\n").toString("base64") };
    });
  }
  async _create(kind, title, files, extra = {}) {
    artifactKind(kind);
    title = titleText(title);
    files = this._retitle(kind, files, title);
    validateFiles(kind, files);
    const manifest = metadata({ id: randomUUID3(), kind, title, createdAt: at(), updatedAt: at(), favorite: false, ...extra });
    const stage = await this._stage();
    try {
      await writeContent(stage.absolute, files);
      await atomicJson(stage.absolute, "artifact.json", manifest);
      const destination = await safePath(this.root, `${kind}/${manifest.id}`, { mustExist: false });
      if (await statOrNull(destination)) throw new LibraryError("ID_CONFLICT", "The new identity already exists.");
      await fs4.rename(stage.absolute, destination);
      const catalog = await this._catalog();
      catalog.artifacts[manifest.id] = { ...manifest, location: "active" };
      await this._saveCatalog(catalog);
      return this._inspect(catalog.artifacts[manifest.id]);
    } finally {
      await this._removeStage(stage);
    }
  }
  async create({ kind, title = `Untitled ${kind}` } = {}) {
    await this._checkRoot();
    artifactKind(kind);
    title = titleText(title);
    return locked(this.root, () => this._create(kind, title, blankContent(kind, title, at())));
  }
  async _updateMetadata(id, update, { touchContentTitle = false } = {}) {
    const { record, catalog } = await this._raw(id);
    if (touchContentTitle) await this._busy(record);
    const root = await this._artifactPath(record);
    const manifest = metadata(await readJson2(root, "artifact.json"));
    const next = metadata({ ...manifest, ...update, updatedAt: at() });
    if (touchContentTitle) {
      const index = await readJson2(root, INDEX_FILES[record.kind]);
      index.title = next.title;
      await atomicJson(root, INDEX_FILES[record.kind], index);
    }
    await atomicJson(root, "artifact.json", next);
    catalog.artifacts[id] = { ...next, location: "active" };
    await this._saveCatalog(catalog);
    return this._inspect(catalog.artifacts[id]);
  }
  async rename(id, title) {
    id = artifactId(id);
    title = titleText(title);
    await this._checkRoot();
    return locked(this.root, () => this._updateMetadata(id, { title }, { touchContentTitle: true }));
  }
  async setFavorite(id, favorite = true) {
    id = artifactId(id);
    if (typeof favorite !== "boolean") throw new LibraryError("INVALID_OPTION", "favorite must be boolean.");
    await this._checkRoot();
    return locked(this.root, () => this._updateMetadata(id, { favorite }));
  }
  async _export(record) {
    await this._busy(record);
    const root = await this._artifactPath(record);
    const files = await collectContent(root, record.kind, this.limits);
    const native = validateFiles(record.kind, files);
    const bundle = { format: BUNDLE_FORMAT, version: 1, kind: record.kind, title: native.title, files: files.map(({ path: path11, encoding, data }) => ({ path: path11, encoding, data })) };
    if (Buffer.byteLength(JSON.stringify(bundle)) > this.limits.maxBundleBytes) throw new LibraryError("LIMIT_EXCEEDED", "The native bundle exceeds the configured export limit.");
    return bundle;
  }
  async exportArtifact(id) {
    await this._checkRoot();
    return locked(this.root, async () => this._export((await this._raw(id)).record));
  }
  async duplicate(id, { title } = {}) {
    await this._checkRoot();
    return locked(this.root, async () => {
      const { record } = await this._raw(id);
      const bundle = await this._export(record);
      return this._create(record.kind, title || bundle.title + " copy", bundle.files, { sourceArtifactId: record.id });
    });
  }
  _bundle(input, kind) {
    let bundle = input;
    if (typeof bundle === "string" || Buffer.isBuffer(bundle)) {
      if (Buffer.byteLength(bundle) > this.limits.maxBundleBytes) throw new LibraryError("LIMIT_EXCEEDED", "The native bundle is too large.");
      try {
        bundle = JSON.parse(String(bundle));
      } catch {
        throw new LibraryError("INVALID_BUNDLE", "Expected a native library JSON bundle.");
      }
    }
    if (!bundle || bundle.format !== BUNDLE_FORMAT || bundle.version !== 1 || !Array.isArray(bundle.files)) throw new LibraryError("INVALID_BUNDLE", "Unsupported native artifact bundle.");
    artifactKind(bundle.kind);
    if (kind && kind !== bundle.kind) throw new LibraryError("INVALID_KIND", "Bundle and selected kind disagree.");
    if (bundle.files.length > this.limits.maxFiles) throw new LibraryError("LIMIT_EXCEEDED", "Too many files in the native bundle.");
    const files = [], keys = /* @__PURE__ */ new Set();
    let total = 0, encoded = 0;
    for (const file of bundle.files) {
      const relative = relativePath(file?.path);
      const key = relative.normalize("NFC").toLowerCase();
      if (keys.has(key)) throw new LibraryError("INVALID_BUNDLE", "Duplicate or case-colliding bundle path.");
      keys.add(key);
      if (!contentPath(bundle.kind, relative)) continue;
      if (file.encoding !== "base64" || typeof file.data !== "string" || file.data.length > Math.ceil(this.limits.maxFileBytes / 3) * 4 || file.data.length % 4 || /[^A-Za-z0-9+/=]/.test(file.data)) throw new LibraryError("INVALID_BUNDLE", "Invalid or oversized base64 file.");
      const padding = file.data.indexOf("=");
      if (padding >= 0 && (padding < file.data.length - 2 || !/^={1,2}$/.test(file.data.slice(padding)))) throw new LibraryError("INVALID_BUNDLE", "Invalid base64 padding.");
      const bytes = Buffer.from(file.data, "base64");
      encoded += file.data.length;
      total += bytes.length;
      if (bytes.toString("base64") !== file.data || bytes.length > this.limits.maxFileBytes || total > this.limits.maxTotalBytes || encoded > this.limits.maxBundleBytes) throw new LibraryError("LIMIT_EXCEEDED", "The native bundle exceeds content limits.");
      files.push({ path: relative, encoding: "base64", data: file.data });
    }
    const native = validateFiles(bundle.kind, files);
    return { kind: bundle.kind, title: native.title, files };
  }
  async _source(sourcePath, kind) {
    if (typeof sourcePath !== "string" || !path4.isAbsolute(sourcePath)) throw new LibraryError("INVALID_PATH", "Choose an absolute source path explicitly.");
    const info = await fs4.lstat(sourcePath).catch((error2) => {
      if (error2.code === "ENOENT") throw new LibraryError("NOT_FOUND", "The import source is missing.");
      throw error2;
    });
    if (info.isSymbolicLink()) throw new LibraryError("SYMLINK_REFUSED", "The import source cannot be a symbolic link.");
    if (info.isFile()) return this._bundle(await readBytes(path4.dirname(sourcePath), path4.basename(sourcePath), this.limits.maxBundleBytes), kind);
    if (!info.isDirectory()) throw new LibraryError("INVALID_CONTENT", "The import source is not a native folder or bundle.");
    const matches = [];
    for (const candidate of KINDS) if (await statOrNull(await safePath(sourcePath, INDEX_FILES[candidate], { mustExist: false }))) matches.push(candidate);
    if (!kind) {
      if (matches.length !== 1) throw new LibraryError(matches.length ? "AMBIGUOUS_KIND" : "MISSING_CONTENT", "Select one native artifact kind with an existing index.");
      kind = matches[0];
    }
    artifactKind(kind);
    if (!matches.includes(kind)) throw new LibraryError("MISSING_CONTENT", "The chosen source has no native index for this kind.");
    const busy = await this.isBusy({ id: null, kind, path: sourcePath });
    if (busy === true || busy?.busy) throw new LibraryError("ARTIFACT_BUSY", "The import source has an active task.");
    const files = await collectContent(sourcePath, kind, this.limits);
    const native = validateFiles(kind, files);
    return { kind, title: native.title, files };
  }
  async importArtifact({ bundle, sourcePath, kind, title } = {}) {
    await this._checkRoot();
    if (bundle === void 0 === (sourcePath === void 0)) throw new LibraryError("INVALID_OPTION", "Provide exactly one native bundle or explicitly chosen source path.");
    if (kind) artifactKind(kind);
    if (title !== void 0) titleText(title);
    return locked(this.root, async () => {
      const source = bundle === void 0 ? await this._source(sourcePath, kind) : this._bundle(bundle, kind);
      return this._create(source.kind, title || source.title, source.files);
    });
  }
  async listFiles(id) {
    await this._checkRoot();
    const { record } = await this._raw(id);
    const root = await this._artifactPath(record);
    return collectContent(root, record.kind, this.limits, { includeBytes: false });
  }
  async readFile(id, relative, { encoding = "utf8" } = {}) {
    await this._checkRoot();
    const { record } = await this._raw(id);
    relativePath(relative);
    if (!contentPath(record.kind, relative)) throw new LibraryError("CONTENT_ONLY", "This route exposes only artwork and material files, not comments, chats, tasks, or runtime bindings.");
    if (!["utf8", "base64"].includes(encoding)) throw new LibraryError("INVALID_OPTION", "Unsupported file encoding.");
    const root = await this._artifactPath(record), bytes = await readBytes(root, relative, this.limits.maxFileBytes), type = contentType(relative);
    if (encoding === "utf8" && !/^(?:text\/|application\/json|image\/svg)/.test(type)) throw new LibraryError("BINARY_ENCODING_REQUIRED", "Read binary material using base64.");
    return { path: relative, contentType: type, bytes: bytes.length, ...encoding === "base64" ? { encoding, data: bytes.toString("base64") } : { text: bytes.toString("utf8") } };
  }
  async trash(id) {
    await this._checkRoot();
    return locked(this.root, async () => {
      const { record, catalog } = await this._raw(id);
      await this._busy(record);
      const source = await this._artifactPath(record), destination = await safePath(this.root, `_trash/${record.id}`, { mustExist: false });
      if (await statOrNull(destination)) throw new LibraryError("ID_CONFLICT", "The recycle location already exists.");
      await fs4.rename(source, destination);
      const next = metadata({ ...record, deletedAt: at(), updatedAt: at() });
      await atomicJson(destination, "artifact.json", next);
      catalog.artifacts[record.id] = { ...next, location: "trash" };
      await this._saveCatalog(catalog);
      const view = await this._view(catalog);
      view.tabs = view.tabs.filter((tab) => tab.id !== record.id);
      if (view.activeTabId === record.id) view.activeTabId = "library";
      await atomicJson(this.root, viewFile, view);
      return this._inspect(catalog.artifacts[record.id]);
    });
  }
  async restore(id) {
    await this._checkRoot();
    return locked(this.root, async () => {
      const { record, catalog } = await this._raw(id, { includeDeleted: true });
      if (record.location !== "trash") return this._inspect(record);
      await this._busy(record);
      const source = await this._artifactPath(record), destination = await safePath(this.root, `${record.kind}/${record.id}`, { mustExist: false });
      if (await statOrNull(destination)) throw new LibraryError("ID_CONFLICT", "An active directory already occupies this identity.");
      await fs4.rename(source, destination);
      const { deletedAt, ...old } = record;
      const next = metadata({ ...old, updatedAt: at() });
      await atomicJson(destination, "artifact.json", next);
      catalog.artifacts[record.id] = { ...next, location: "active" };
      await this._saveCatalog(catalog);
      return this._inspect(catalog.artifacts[record.id]);
    });
  }
  async snapshot(id, { label = "Snapshot" } = {}) {
    label = titleText(label);
    await this._checkRoot();
    return locked(this.root, async () => {
      const { record } = await this._raw(id), bundle = await this._export(record);
      const snapshot = { id: randomUUID3(), artifactId: record.id, label, createdAt: at(), bundle };
      await atomicJson(this.root, `_state/snapshots/${record.id}/${snapshot.id}.json`, snapshot);
      return this._snapshotSummary(snapshot);
    });
  }
  _snapshotSummary(snapshot) {
    return { id: snapshot.id, artifactId: snapshot.artifactId, label: snapshot.label, createdAt: snapshot.createdAt, files: snapshot.bundle.files.length, bytes: snapshot.bundle.files.reduce((sum, file) => sum + Buffer.byteLength(file.data, "base64"), 0) };
  }
  async listSnapshots(id) {
    id = artifactId(id);
    await this._checkRoot();
    await this._raw(id, { includeDeleted: true });
    const relative = `_state/snapshots/${id}`, directory = await safePath(this.root, relative, { mustExist: false });
    if (!await statOrNull(directory)) return [];
    const result = [];
    for (const name of await fs4.readdir(directory)) if (/^[0-9a-f-]+\.json$/i.test(name) && UUID.test(name.slice(0, -5))) {
      const snapshot = await readJson2(this.root, relative + "/" + name);
      if (snapshot.artifactId !== id) throw new LibraryError("INVALID_STATE", "Snapshot identity disagrees.");
      this._bundle(snapshot.bundle);
      result.push(this._snapshotSummary(snapshot));
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async restoreSnapshot(id, snapshotId) {
    id = artifactId(id);
    snapshotId = artifactId(snapshotId);
    await this._checkRoot();
    return locked(this.root, async () => {
      const { record, catalog } = await this._raw(id);
      await this._busy(record);
      const saved = await readJson2(this.root, `_state/snapshots/${id}/${snapshotId}.json`);
      if (saved.artifactId !== id) throw new LibraryError("INVALID_STATE", "Snapshot identity disagrees.");
      const bundle = this._bundle(saved.bundle, record.kind);
      const root = await this._artifactPath(record), current = await collectContent(root, record.kind, this.limits, { includeBytes: false }), stage = await this._stage();
      const originalManifest = await readJson2(root, "artifact.json");
      let manifestWritten = false;
      const before = path4.join(stage.absolute, "before"), after = path4.join(stage.absolute, "after");
      await fs4.mkdir(before);
      await fs4.mkdir(after);
      await writeContent(after, bundle.files);
      const moved = [], added = [];
      try {
        for (const file of current) {
          const from = await safePath(root, file.path, { type: "file" }), to = await safePath(before, file.path, { mustExist: false });
          await fs4.mkdir(path4.dirname(to), { recursive: true });
          await fs4.rename(from, to);
          moved.push(file.path);
        }
        for (const file of bundle.files) {
          const from = await safePath(after, file.path, { type: "file" }), to = await safePath(root, file.path, { mustExist: false });
          if (await statOrNull(to)) throw new LibraryError("CONTENT_CHANGED", "A file changed while restoring a snapshot.");
          await fs4.mkdir(path4.dirname(to), { recursive: true });
          await fs4.rename(from, to);
          added.push(file.path);
        }
        const next = metadata({ ...record, title: bundle.title, updatedAt: at() });
        await atomicJson(root, "artifact.json", next);
        manifestWritten = true;
        catalog.artifacts[id] = { ...next, location: "active" };
        await this._saveCatalog(catalog);
        return this._inspect(catalog.artifacts[id]);
      } catch (error2) {
        for (const relative of added) await fs4.unlink(await safePath(root, relative, { type: "file" }));
        for (const relative of moved) {
          const from = await safePath(before, relative, { type: "file" }), to = await safePath(root, relative, { mustExist: false });
          await fs4.mkdir(path4.dirname(to), { recursive: true });
          await fs4.rename(from, to);
        }
        if (manifestWritten) await atomicJson(root, "artifact.json", originalManifest);
        throw error2;
      } finally {
        await this._removeStage(stage);
      }
    });
  }
  async scanLegacy() {
    await this._checkRoot();
    return locked(this.root, async () => {
      const state = await readJson2(this.root, "_state/legacy-imports.json", { version: 1, sources: {} });
      if (state.version !== 1 || !state.sources) throw new LibraryError("INVALID_STATE", "The legacy registration state is invalid.");
      const results = [];
      for (const kind of KINDS) for (const entry2 of await fs4.readdir(await safePath(this.root, kind, { type: "directory" }), { withFileTypes: true })) {
        if (entry2.name.startsWith(".")) continue;
        const relative = `${kind}/${entry2.name}`;
        if (entry2.isSymbolicLink()) {
          results.push({ kind, path: path4.join(this.root, relative), status: "invalid", code: "SYMLINK_REFUSED" });
          continue;
        }
        if (!entry2.isDirectory()) continue;
        const source = await safePath(this.root, relative, { type: "directory" });
        if (await statOrNull(await safePath(source, "artifact.json", { mustExist: false }))) continue;
        if (state.sources[relative]) {
          const registered = (await this._catalog()).artifacts[state.sources[relative]];
          const status = registered ? (await this._inspect(registered)).contentStatus : "missing";
          results.push({ kind, path: source, status: status === "ok" ? "registered" : status, artifactId: state.sources[relative] });
          continue;
        }
        try {
          const content = await this._source(source, kind);
          const imported = await this._create(kind, content.title, content.files);
          state.sources[relative] = imported.id;
          await atomicJson(this.root, "_state/legacy-imports.json", state);
          results.push({ kind, path: source, status: "imported", artifactId: imported.id });
        } catch (error2) {
          results.push({ kind, path: source, status: ["MISSING_CONTENT", "NOT_FOUND"].includes(error2.code) ? "missing" : "invalid", code: error2.code || "INVALID_CONTENT", message: error2.message });
        }
      }
      return results;
    });
  }
  async _bindings() {
    const value = await readJson2(this.root, bindingsFile, { version: 1, artifacts: {} });
    if (value.version !== 1 || !value.artifacts || typeof value.artifacts !== "object" || Array.isArray(value.artifacts)) throw new LibraryError("INVALID_STATE", "Chat bindings are invalid.");
    return value;
  }
  async getBinding(id) {
    id = artifactId(id);
    await this._checkRoot();
    await this._raw(id);
    return structuredClone((await this._bindings()).artifacts[id] || null);
  }
  async bindChat(id, { threadId, projectId } = {}) {
    id = artifactId(id);
    for (const value of [threadId, ...projectId === void 0 ? [] : [projectId]]) if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) throw new LibraryError("INVALID_BINDING", "Use an actual nonempty host identifier.");
    await this._checkRoot();
    return locked(this.root, async () => {
      await this._raw(id);
      const state = await this._bindings(), previous = state.artifacts[id];
      if (previous && previous.threadId !== threadId) throw new LibraryError("BINDING_CONFLICT", "This artifact already has a different editing conversation; unlink it explicitly first.");
      const binding = { artifactId: id, threadId, ...projectId ? { projectId } : {}, boundAt: previous?.boundAt || at(), updatedAt: at() };
      state.artifacts[id] = binding;
      await atomicJson(this.root, bindingsFile, state);
      return binding;
    });
  }
  async unbindChat(id) {
    id = artifactId(id);
    await this._checkRoot();
    return locked(this.root, async () => {
      await this._raw(id);
      const state = await this._bindings();
      delete state.artifacts[id];
      await atomicJson(this.root, bindingsFile, state);
      return null;
    });
  }
  async _view(catalog) {
    const value = await readJson2(this.root, viewFile, emptyView());
    if (value.version !== 1 || !Array.isArray(value.tabs)) throw new LibraryError("INVALID_STATE", "The saved library view is invalid.");
    const tabs = [libraryTab()], seen = /* @__PURE__ */ new Set(["library"]);
    for (const tab of value.tabs) if (tab?.type === "artifact" && typeof tab.artifactId === "string" && UUID.test(tab.artifactId)) {
      const id = tab.artifactId.toLowerCase();
      if (!seen.has(id) && catalog.artifacts[id]?.location === "active") {
        tabs.push({ id, type: "artifact", artifactId: id });
        seen.add(id);
      }
    }
    return { version: 1, tabs, activeTabId: seen.has(value.activeTabId) ? value.activeTabId : "library" };
  }
  async getViewState() {
    await this._checkRoot();
    return this._view(await this._catalog());
  }
  async _viewUpdate(fn) {
    await this._checkRoot();
    return locked(this.root, async () => {
      const catalog = await this._catalog(), view = await this._view(catalog);
      await fn(view, catalog);
      await atomicJson(this.root, viewFile, view);
      return view;
    });
  }
  async openTab(id) {
    id = artifactId(id);
    return this._viewUpdate((view, catalog) => {
      if (catalog.artifacts[id]?.location !== "active") throw new LibraryError("NOT_FOUND", "No active artifact has this id.");
      if (!view.tabs.some((tab) => tab.id === id)) view.tabs.push({ id, type: "artifact", artifactId: id });
      view.activeTabId = id;
    });
  }
  async activateTab(id) {
    if (id !== "library") id = artifactId(id);
    return this._viewUpdate((view) => {
      if (!view.tabs.some((tab) => tab.id === id)) throw new LibraryError("NOT_FOUND", "This tab is not open.");
      view.activeTabId = id;
    });
  }
  async closeTab(id) {
    if (id !== "library") id = artifactId(id);
    return this._viewUpdate((view) => {
      if (id === "library") return;
      view.tabs = view.tabs.filter((tab) => tab.id !== id);
      if (view.activeTabId === id) view.activeTabId = view.tabs.at(-1).id;
    });
  }
  async reorderTabs(ids) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new LibraryError("INVALID_VIEW", "Expected an ordered list of tab ids.");
    return this._viewUpdate((view) => {
      const requested = ids.filter((id) => id !== "library");
      const current = view.tabs.filter((tab) => tab.type === "artifact");
      if (new Set(requested).size !== requested.length || requested.length !== current.length || requested.some((id) => !current.some((tab) => tab.id === id))) throw new LibraryError("INVALID_VIEW", "Tab order must contain each open artifact once.");
      view.tabs = [libraryTab(), ...requested.map((id) => current.find((tab) => tab.id === id))];
    });
  }
};
function createLibraryStore(options) {
  return new LibraryStore(options);
}

// source/server/http-preview.mjs
import http from "node:http";
import fs5 from "node:fs/promises";
import path9 from "node:path";
import { randomBytes, randomUUID as randomUUID4 } from "node:crypto";
import { fileURLToPath as fileURLToPath2 } from "node:url";
init_worker_client();

// source/server/service.mjs
init_bridge_core();
init_artifact_command();
import { spawn } from "node:child_process";
import path8 from "node:path";
import { fileURLToPath } from "node:url";

// source/library/thumbnail.mjs
import path7 from "node:path";
import { createHash as createHash2 } from "node:crypto";
var LIMITS = { maxSourceBytes: 512 * 1024, maxAssetBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxDocumentBytes: 6 * 1024 * 1024 };
var escape2 = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
var decode = (value) => String(value).replace(/&(?:#(x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos);/gi, (match, number) => {
  if (number) {
    const point = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : Number(number);
    return point > 0 && point <= 1114111 ? String.fromCodePoint(point) : "";
  }
  return { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[match.toLowerCase()] || "";
});
var textOf = (html) => decode(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
var dimension = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 40 && Number(value) <= 8e3 ? Math.round(Number(value)) : fallback;
function attributes(source) {
  const result = /* @__PURE__ */ new Map();
  for (const match of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (!result.has(name)) result.set(name, decode(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return result;
}
async function replaceAsync(text, expression, fn) {
  let result = "", cursor = 0;
  for (const match of text.matchAll(expression)) {
    result += text.slice(cursor, match.index) + await fn(match);
    cursor = match.index + match[0].length;
  }
  return result + text.slice(cursor);
}
var ALLOWED = new Set("section article main header nav footer div p span h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr th td caption colgroup col hr br figure figcaption pre code b strong em i u s small sup sub blockquote a img button label input select option svg g defs path rect circle ellipse line polyline polygon text tspan lineargradient radialgradient stop clippath mask pattern use image title desc".split(" "));
var VOID = /* @__PURE__ */ new Set(["img", "input", "hr", "br", "col"]);
var BLOCKED = /* @__PURE__ */ new Set(["script", "iframe", "object", "embed", "foreignobject", "math", "noscript", "canvas", "video", "audio", "applet", "template"]);
var SVG_NAMES = { lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath" };
var ATTR_NAMES = { viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio", gradientunits: "gradientUnits", gradienttransform: "gradientTransform", patternunits: "patternUnits", patterntransform: "patternTransform", clippathunits: "clipPathUnits", textlength: "textLength", lengthadjust: "lengthAdjust" };
var ATTRS = new Set("id class style title lang dir role aria-label aria-hidden width height viewbox preserveaspectratio x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity transform offset stop-color stop-opacity gradientunits gradienttransform patternunits patterntransform clippathunits clip-path mask filter text-anchor dominant-baseline font-family font-size font-weight letter-spacing textlength lengthadjust colspan rowspan alt type value placeholder checked selected".split(" "));
function skipElement(html, from, name) {
  const expression = new RegExp("<\\/?" + name + `\\b(?:[^"'<>]|"[^"]*"|'[^']*')*>`, "gi");
  expression.lastIndex = from;
  let depth = 1, match;
  while (match = expression.exec(html)) {
    if (/^<\//.test(match[0])) depth--;
    else if (!/\/\s*>$/.test(match[0])) depth++;
    if (!depth) return expression.lastIndex;
  }
  return html.length;
}
async function sanitizedCss(css, base, context) {
  if (Buffer.byteLength(css) > context.limits.maxSourceBytes) {
    context.note("A large stylesheet was omitted.");
    return "";
  }
  css = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import\b[^;]*;?/gi, "").replace(/<|>|\u0000/g, "");
  if (/\\[0-9a-f]{1,6}\s?/i.test(css)) {
    context.note("Escaped CSS was omitted from this static preview.");
    return "";
  }
  css = css.replace(/(?:expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding\s*:)[^;}]*[;}]?/gi, "");
  return replaceAsync(css, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, async (match) => {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (/^#[A-Za-z_][\w:.-]*$/.test(value)) return 'url("' + value + '")';
    const asset = await context.asset(value, base, "style");
    return asset ? 'url("' + asset + '")' : "none";
  });
}
async function sanitize(html, base, context, defaults = {}) {
  html = html.replace(/<!doctype\b[^>]*>|<\?[\s\S]*?\?>/gi, "");
  html = html.replace(/{{\s*([A-Za-z_$][\w.$-]*|true|false)\s*}}/g, (_, key) => {
    if (key === "true" || key === "false") return key;
    const value = defaults[key];
    if (["string", "number", "boolean"].includes(typeof value)) return escape2(value);
    context.dynamic = true;
    return "";
  });
  let result = "", cursor = 0;
  const stack = [];
  const closeTo = (name) => {
    const index = stack.map((item) => item.source).lastIndexOf(name);
    if (index < 0) return;
    while (stack.length > index) result += "</" + stack.pop().output + ">";
  };
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) {
      result += escape2(decode(html.slice(cursor)));
      break;
    }
    result += escape2(decode(html.slice(cursor, start)));
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    const token = /^<\s*(\/?)\s*([A-Za-z][\w:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/.exec(html.slice(start));
    if (!token) {
      result += "&lt;";
      cursor = start + 1;
      continue;
    }
    cursor = start + token[0].length;
    const closing = !!token[1], name = token[2].toLowerCase();
    if (closing) {
      closeTo(name);
      continue;
    }
    const attrs = attributes(token[3]);
    if (BLOCKED.has(name) || name === "aside" || name === "title" && !stack.some((item) => item.source === "svg")) {
      context.dynamic ||= name === "script" || name === "canvas";
      cursor = skipElement(html, cursor, name);
      continue;
    }
    if (name === "style") {
      const end = /<\/style\s*>/gi;
      end.lastIndex = cursor;
      const match = end.exec(html);
      const css = await sanitizedCss(html.slice(cursor, match ? match.index : html.length), base, context);
      result += "<style>" + css + "</style>";
      cursor = match ? end.lastIndex : html.length;
      continue;
    }
    if (name === "link") {
      if ((attrs.get("rel") || "").toLowerCase().split(/\s+/).includes("stylesheet")) {
        const file = context.resolve(attrs.get("href") || "", base);
        if (file && context.files.has(file) && file.endsWith(".css")) result += "<style>" + await sanitizedCss(await context.text(file), file, context) + "</style>";
        else context.note("An external or missing stylesheet was omitted.");
      }
      continue;
    }
    if (name === "sc-if") {
      const value = attrs.get("value");
      const hint = attrs.get("hint-placeholder-val");
      if (value === "false" || value !== "true" && hint === "false") cursor = skipElement(html, cursor, name);
      continue;
    }
    if (["html", "head", "body", "x-dc", "helmet", "sc-for"].includes(name)) {
      if (name === "sc-for") context.dynamic = true;
      continue;
    }
    let output = SVG_NAMES[name] || name;
    if (name === "x-shape") output = "div";
    else if (!ALLOWED.has(name)) {
      if (name.includes("-")) {
        context.dynamic = true;
        context.note("A custom component is not executed in the static cover.");
      }
      continue;
    }
    const rendered = [];
    for (let [attribute, value] of attrs) {
      if (attribute.startsWith("sc-camel-")) attribute = attribute.slice(9);
      if (attribute.startsWith("on") || attribute.startsWith("data-") || ["nonce", "srcset", "formaction", "action", "autofocus", "contenteditable"].includes(attribute)) continue;
      if (["src", "href", "xlink:href", "poster", "background"].includes(attribute)) {
        if (name === "use" && /^#[A-Za-z_][\w:.-]*$/.test(value)) rendered.push('href="' + escape2(value) + '"');
        else if (["img", "image"].includes(name)) {
          const uri = await context.asset(value, base, "image");
          if (uri) rendered.push((name === "image" ? "href" : "src") + '="' + escape2(uri) + '"');
        }
        continue;
      }
      if (!ATTRS.has(attribute) || value.length > 65536) continue;
      if (name === "x-shape" && attribute === "style") continue;
      if (attribute === "style") value = await sanitizedCss(value, base, context);
      else if (/url\s*\(/i.test(value)) value = await sanitizedCss(value, base, context);
      if (attribute === "type" && name === "input" && !["text", "email", "number", "date", "range", "checkbox", "radio", "button"].includes(value)) value = "text";
      rendered.push((ATTR_NAMES[attribute] || attribute) + '="' + escape2(value) + '"');
    }
    if (name === "x-shape") {
      const kind = attrs.get("kind");
      const shape = kind === "arrow-right" ? "clip-path:polygon(0 25%,65% 25%,65% 0,100% 50%,65% 100%,65% 75%,0 75%);" : kind === "ellipse" ? "border-radius:50%;" : kind === "rounded" ? "border-radius:8px;" : "";
      rendered.push('style="' + escape2("display:block;" + await sanitizedCss(attrs.get("style") || "", base, context) + ";" + shape) + '"');
    }
    if (["button", "input", "select"].includes(name)) rendered.push('disabled=""');
    if (name === "a") rendered.push('aria-disabled="true"');
    result += "<" + output + (rendered.length ? " " + rendered.join(" ") : "") + ">";
    if (!VOID.has(name) && !/\/\s*>$/.test(token[0])) stack.push({ source: name, output });
    else if (!VOID.has(name)) result += "</" + output + ">";
  }
  while (stack.length) result += "</" + stack.pop().output + ">";
  return result;
}
function defaultsOf(html) {
  const values = {};
  for (const match of html.matchAll(/<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const raw = attributes(match[1]).get("data-props");
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      for (const [key, spec] of Object.entries(parsed)) if (spec && ["string", "number", "boolean"].includes(typeof spec.default)) values[key] = spec.default;
    } catch {
    }
  }
  return values;
}
function tokenCss(tokens) {
  const declarations = [], values = /* @__PURE__ */ new Map(), theme = tokens.color?.themes?.[0]?.id || "light";
  for (const family of Object.values(tokens)) if (Array.isArray(family?.tokens)) {
    for (const token of family.tokens) if (/^[A-Za-z_][\w-]*$/.test(token.name || "")) values.set(token.name, typeof token.value === "object" && token.value ? token.value[theme] ?? Object.values(token.value)[0] : token.value);
  }
  const resolve = (value, depth = 0) => depth > 8 ? "" : typeof value === "string" && /^\{[^{}]+\}$/.test(value) ? resolve(values.get(value.slice(1, -1)), depth + 1) : value;
  const safeValue = (value) => ["string", "number"].includes(typeof value) && !/[;{}<>]/.test(String(value)) ? String(value) : "";
  for (const [name, value] of values) {
    const resolved = safeValue(resolve(value));
    if (resolved) declarations.push("--" + name + ":" + resolved);
  }
  for (const [name, value] of Object.entries(tokens.type?.families || {})) if (/^[A-Za-z_][\w-]*$/.test(name) && safeValue(value)) declarations.push("--font-" + name + ":" + value);
  let css = ":root{" + declarations.join(";") + "}";
  for (const group of tokens.type?.groups || []) for (const style of group.styles || []) if (/^[A-Za-z_][\w-]*$/.test(style.name || "")) {
    const properties = [];
    for (const [key, attribute] of Object.entries({ fontSize: "font-size", lineHeight: "line-height", fontWeight: "font-weight", letterSpacing: "letter-spacing", textTransform: "text-transform" })) if (safeValue(style[key])) properties.push(attribute + ":" + style[key]);
    if (/^[A-Za-z_][\w-]*$/.test(group.family || "")) properties.push("font-family:var(--font-" + group.family + ")");
    css += "." + style.name + "{" + properties.join(";") + "}";
  }
  return css;
}
async function createArtifactThumbnail(store, id, options = {}) {
  const limits = { ...LIMITS, ...options };
  for (const key of Object.keys(LIMITS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new LibraryError("INVALID_THUMBNAIL_OPTION", "Thumbnail limits must be positive integers.");
  const record = await store.get(id);
  if (record.contentStatus !== "ok") throw new LibraryError(record.contentError?.code || "ARTIFACT_CONTENT_UNAVAILABLE", "Artwork content is unavailable for a real preview.");
  const listed = await store.listFiles(id), files = new Map(listed.map((file) => [file.path, file]));
  const hash = createHash2("sha256");
  hash.update(JSON.stringify({ artifactId: record.id, kind: record.kind, title: record.title, files: listed.map((file) => ({ path: file.path, bytes: file.bytes })).sort((a, b) => a.path < b.path ? -1 : 1) }));
  const read = /* @__PURE__ */ new Map(), assets = /* @__PURE__ */ new Map(), visiting = /* @__PURE__ */ new Set(), notes = [];
  let total = 0;
  const context = {
    files,
    limits,
    dynamic: false,
    note(message) {
      if (!notes.includes(message) && notes.length < 20) notes.push(message);
    },
    async text(file) {
      if (!files.has(file)) throw new LibraryError("MISSING_CONTENT", "A preview source file is missing.");
      if (!read.has(file)) {
        if (files.get(file).bytes > limits.maxSourceBytes || total + files.get(file).bytes > limits.maxTotalBytes) throw new LibraryError("THUMBNAIL_LIMIT", "The static preview source exceeds its limit.");
        const result = await store.readFile(id, file, { encoding: "utf8" });
        total += result.bytes;
        read.set(file, result.text);
        hash.update(file + "\0" + result.text);
      }
      return read.get(file);
    },
    resolve(value, base) {
      value = decode(value).trim();
      if (files.has(value)) return value;
      const blob = /^\/_blob\/([a-f0-9]{32})$/.exec(value)?.[1];
      if (blob) {
        if (record.kind === "dashboard") return files.has("_blobs/" + blob) ? "_blobs/" + blob : null;
        return [...files.keys()].find((file) => file.startsWith((record.kind === "design-system" ? "project/_blobs/" : "project/assets/") + blob + ".")) || null;
      }
      if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(value) || /[\\\u0000-\u001f]/.test(value)) return null;
      const relative = path7.posix.normalize(path7.posix.join(path7.posix.dirname(base), value.split(/[?#]/)[0]));
      return files.has(relative) ? relative : null;
    },
    async asset(value, base, purpose) {
      value = decode(value).trim();
      if (/^data:/i.test(value)) {
        const parsed = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml)|font\/(?:woff2?|ttf|otf));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
        if (!parsed || value.length > Math.ceil(limits.maxAssetBytes / 3) * 4 + 100 || purpose === "image" && !parsed[1].startsWith("image/")) {
          context.note("An unsupported embedded resource was omitted.");
          return null;
        }
        if (parsed[1].toLowerCase() === "image/svg+xml") return "data:image/svg+xml;base64," + Buffer.from(await sanitize(Buffer.from(parsed[2], "base64").toString("utf8"), base, context)).toString("base64");
        return value;
      }
      const file = context.resolve(value, base);
      if (!file) {
        if (value) context.note("An external or missing resource was omitted.");
        return null;
      }
      if (assets.has(file)) return assets.get(file);
      if (visiting.has(file)) {
        context.note("A recursive image reference was omitted.");
        return null;
      }
      const info = files.get(file), mime = info.contentType || "application/octet-stream";
      if (!(mime.startsWith("image/") || purpose === "style" && mime.startsWith("font/")) || info.bytes > limits.maxAssetBytes || total + info.bytes > limits.maxTotalBytes) {
        context.note("An unsupported or large material was omitted.");
        return null;
      }
      visiting.add(file);
      try {
        const resource = await store.readFile(id, file, { encoding: "base64" });
        total += resource.bytes;
        hash.update(file + "\0" + resource.data);
        let data = resource.data;
        if (mime === "image/svg+xml") data = Buffer.from(await sanitize(Buffer.from(data, "base64").toString("utf8"), file, context)).toString("base64");
        const uri = "data:" + mime + ";base64," + data;
        assets.set(file, uri);
        return uri;
      } finally {
        visiting.delete(file);
      }
    }
  };
  const json = async (file) => {
    try {
      return JSON.parse(await context.text(file));
    } catch (cause) {
      if (cause instanceof LibraryError) throw cause;
      throw new LibraryError("INVALID_CONTENT", "A thumbnail index is invalid.");
    }
  };
  let sourceFile, width = 1200, height = 720, raw, extraCss = "", fidelity = "native-static", normalizer = "";
  if (record.kind === "slides") {
    const index = await json("project/deck.json");
    const first = index.order?.[0];
    if (typeof first !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(first)) throw new LibraryError("NO_STATIC_COVER", "This deck has no first slide to preview.");
    sourceFile = "project/slides/" + first + ".html";
    raw = await context.text(sourceFile);
    width = 1920;
    height = 1080;
    normalizer = `.codex-cover-surface>section{position:relative;width:${width}px;height:${height}px;box-sizing:border-box;overflow:hidden}.codex-cover-surface :is(h1,h2,h3,h4,p,ul,ol){margin:0}`;
  } else if (record.kind === "design") {
    const index = await json("project/canvas.json");
    const first = (index.order || []).find((name) => index.boards?.[name]) || Object.keys(index.boards || {})[0];
    if (!first || !files.has("project/" + first)) throw new LibraryError("NO_STATIC_COVER", "This canvas has no first artboard to preview.");
    sourceFile = "project/" + first;
    raw = await context.text(sourceFile);
    width = dimension(index.boards[first].w, 1440);
    height = dimension(index.boards[first].h, 900);
  } else if (record.kind === "design-system") {
    await json("project/design-system.json");
    sourceFile = "project/components/Cover/preview.html";
    if (!files.has(sourceFile)) sourceFile = files.has("project/README.md") ? "project/README.md" : "project/tokens.json";
    if (sourceFile.endsWith(".html")) {
      raw = await context.text(sourceFile);
      width = dimension(/width\s*:\s*(\d+)px/i.exec(raw)?.[1], 960);
      height = dimension(/@dsCard\b[^>]*\bheight\s*=\s*(\d+)/i.exec(raw)?.[1], 540);
      extraCss = await sanitizedCss(tokenCss(await json("project/tokens.json")), "project/tokens.json", context);
    } else {
      const text = await context.text(sourceFile);
      raw = '<div style="padding:64px;font:28px/1.6 system-ui;color:#20211f;background:#fafaf8"><h1>' + escape2(record.title) + "</h1><p>" + escape2(text.slice(0, 700)) + "</p></div>";
      fidelity = "content-reference";
      context.note("The design system has no static Cover HTML; this preview quotes actual content.");
    }
  } else {
    const page = await json("db/files/index.html.json");
    sourceFile = "db/files/index.html.json";
    if (typeof page.text !== "string") throw new LibraryError("INVALID_CONTENT", "The dashboard page is missing.");
    const headings = [...page.text.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((match) => textOf(match[2])).filter(Boolean);
    const firstImage = /<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(page.text)?.[0] || "";
    raw = '<div style="width:1200px;height:720px;box-sizing:border-box;padding:62px;color:#20211f;background:#fafaf8;font-family:system-ui"><p style="margin:0 0 18px;font-size:17px;color:#66705d">Static content reference · 动态页面内容参考</p><h1 style="margin:0 0 30px;font-size:46px;font-weight:500;line-height:1.3">' + escape2(headings[0] || record.title) + "</h1>" + firstImage + '<div style="font-size:26px;line-height:1.8;color:#4d5944">' + headings.slice(1, 6).map((heading) => '<p style="margin:10px 0">' + escape2(heading) + "</p>").join("") + "</div></div>";
    fidelity = "content-reference";
    context.note("Dashboard scripts and chart calculations were not executed. This is actual page text/material, not a rendered chart screenshot.");
    for (const file of [...files.keys()].filter((file2) => /^db\/files\/[^/]+\.(?:js|css)\.json$/.test(file2)).sort()) await context.text(file);
  }
  const clean = await sanitize(raw, sourceFile, context, defaultsOf(raw));
  if (context.dynamic && record.kind !== "dashboard") context.note("Interactive code was not executed; the cover uses static markup and literal preview defaults.");
  const revision = hash.digest("hex");
  const csp = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  const srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escape2(csp) + '"><meta name="referrer" content="no-referrer"><title>' + escape2(record.title) + "</title><style>" + extraCss + normalizer + '</style></head><body><svg class="codex-cover-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="xMidYMid meet"><foreignObject width="' + width + '" height="' + height + '"><div xmlns="http://www.w3.org/1999/xhtml" class="codex-cover-surface" style="width:' + width + "px;height:" + height + 'px;overflow:hidden">' + clean + "</div></foreignObject></svg><style>html,body{margin:0!important;width:100%;height:100%;overflow:hidden!important}body>.codex-cover-svg{display:block;width:100vw;height:100vh}.codex-cover-surface *{animation:none!important;transition:none!important;pointer-events:none!important}</style></body></html>";
  if (Buffer.byteLength(srcdoc) > limits.maxDocumentBytes) throw new LibraryError("THUMBNAIL_LIMIT", "The static cover exceeds its output limit.");
  return { artifactId: record.id, id: record.id, kind: record.kind, title: record.title, revision, cacheKey: record.id + ":" + revision, srcdoc, previewWidth: width, previewHeight: height, fidelity, sourceFile, notes };
}

// source/server/contract.mjs
var KINDS2 = Object.freeze(["slides", "design", "design-system", "dashboard"]);
var READ_ACTIONS = Object.freeze(["library.list", "library.get", "view.get", "conversation.get", "reference.get", "reference.readFile"]);
var ACTIONS = Object.freeze([
  ...READ_ACTIONS,
  "library.create",
  "library.rename",
  "library.setFavorite",
  "library.duplicate",
  "library.trash",
  "library.restore",
  "library.snapshot",
  "library.listSnapshots",
  "library.restoreSnapshot",
  "library.exportArtifact",
  "library.importArtifact",
  "thumbnail.get",
  "view.openTab",
  "view.activateTab",
  "view.closeTab",
  "view.reorderTabs",
  "editor.open"
]);
var UNSUPPORTED_CHAT_CODE = "NATIVE_EDIT_CHAT_UNAVAILABLE";
var referenceUri = (id) => `codex-design://artifacts/${encodeURIComponent(id)}/reference`;
var fileUri = (id, relative) => `codex-design://artifacts/${encodeURIComponent(id)}/files/${encodeURIComponent(relative)}`;

// source/server/service.mjs
var failure = (code, message) => Object.assign(new Error(message), { code });
var UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idOf(value) {
  if (typeof value !== "string" || !UUID2.test(value)) throw failure("INVALID_ID", "An artifact UUID is required.");
  return value.toLowerCase();
}
function titleOf(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw failure("INVALID_TITLE", "Provide a title of at most 200 characters.");
  return value.trim();
}
function kindOf(value) {
  if (!KINDS2.includes(value)) throw failure("INVALID_KIND", "Unsupported artifact kind.");
  return value;
}
function relativeOf(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\\") || value.includes("%") || path8.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) || /[\u0000-\u001f:]/.test(value)) throw failure("INVALID_PATH", "Only a safe artifact-relative content path is accepted.");
  return value;
}
var capabilityState = () => ({
  actions: [...ACTIONS],
  nativeEditConversation: false,
  selectNativeProject: false,
  arbitraryThreadTarget: false,
  reasonCode: UNSUPPORTED_CHAT_CODE
});
async function openLocalEditor(record, { pluginRoot, env = process.env, timeoutMs = 3e4 } = {}) {
  const current = readJson(path8.join(record.path, ".artifact-server.json"));
  if (current && alive(current.pid)) {
    await verifyEditorInstance(current, record.path, record.kind);
    const binding = readJson(path8.join(record.path, ".codex-design-bridge.json"));
    return {
      url: current.url,
      artifactId: record.id,
      kind: record.kind,
      reused: true,
      delivery: binding?.deliveryMode || "manual",
      nativeConversationBound: false
    };
  }
  const skill = `codex-${record.kind}`;
  const cli = path8.join(pluginRoot, "skills", skill, "scripts", "codex-artifact.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "open", record.path, "--delivery", "native"], {
      cwd: record.path,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", settled = false, timedOut = false;
    const finish = (error2, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      error2 ? reject(error2) : resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-65536);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8e3);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const hardTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(failure("EDITOR_TIMEOUT", "The local editor did not finish starting."));
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }, timeoutMs + 1e3);
    child.once("error", (error2) => finish(failure("EDITOR_START_FAILED", error2.message)));
    child.once("close", (code) => {
      if (timedOut) return finish(failure("EDITOR_TIMEOUT", "The local editor did not finish starting."));
      if (code !== 0) return finish(failure("EDITOR_START_FAILED", stderr.trim().slice(-2e3) || `Editor command exited ${code}.`));
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        return finish(failure("EDITOR_INVALID_RESPONSE", "The local editor returned invalid startup data."));
      }
      let url;
      try {
        url = new URL(result.url);
      } catch {
        return finish(failure("EDITOR_INVALID_RESPONSE", "The local editor did not return a URL."));
      }
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
        return finish(failure("EDITOR_INVALID_RESPONSE", "Only a local editor URL is accepted."));
      }
      finish(null, { url: url.href, artifactId: record.id, kind: record.kind, delivery: "native", nativeConversationBound: false });
    });
  });
}
function createDesignService({ store, pluginRoot = fileURLToPath(new URL("../", import.meta.url)), editorOpen = openLocalEditor } = {}) {
  if (!store) throw new TypeError("A LibraryStore is required.");
  const opening = /* @__PURE__ */ new Map();
  const requireRecord = async (id) => {
    const record = await store.get(idOf(id));
    if (!record || record.deletedAt) throw failure("ARTIFACT_UNAVAILABLE", "The artifact is missing or in the trash.");
    return record;
  };
  const initialize = async () => {
    await store.initialize();
    return store;
  };
  const reference = async (id) => {
    await initialize();
    const artifact = await requireRecord(id);
    const files = await store.listFiles(artifact.id);
    return {
      version: 1,
      artifact: { id: artifact.id, kind: artifact.kind, title: artifact.title },
      readOnly: true,
      editPolicy: "Reference only. Make source edits from the artwork tab; this resource does not grant write access.",
      files: files.map((file) => ({ ...file, uri: fileUri(artifact.id, file.path) }))
    };
  };
  const resourceLink = (artifact) => ({
    type: "resource_link",
    uri: referenceUri(artifact.id),
    name: artifact.title,
    description: `${artifact.kind}; read-only design reference. Open its artwork tab to edit the source.`,
    mimeType: "application/json"
  });
  return {
    async initialState() {
      await initialize();
      return { schemaVersion: 1, artifacts: await store.list({ includeDeleted: true }), viewState: await store.getViewState(), capabilities: capabilityState() };
    },
    async mentions(query = "") {
      await initialize();
      return { items: (await store.list({ query: String(query).slice(0, 200) })).filter((record) => !record.deletedAt && record.contentStatus === "ok").slice(0, 50).map(resourceLink) };
    },
    reference,
    async readReferenceFile(id, relative, encoding = "utf8") {
      await initialize();
      await requireRecord(id);
      if (!["utf8", "base64"].includes(encoding)) throw failure("INVALID_ENCODING", "Choose utf8 or base64.");
      return await store.readFile(idOf(id), relativeOf(relative), { encoding });
    },
    async invoke(action, payload = {}) {
      await initialize();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure("INVALID_ARGUMENTS", "An action payload must be an object.");
      if (action === "conversation.send") throw failure(UNSUPPORTED_CHAT_CODE, "The host has not exposed a verified per-artifact native edit-conversation bridge. No message was sent.");
      if (!ACTIONS.includes(action)) throw failure("UNKNOWN_ACTION", "Unsupported library action.");
      switch (action) {
        case "library.list":
          return await store.list({ kind: payload.kind === void 0 ? void 0 : kindOf(payload.kind), query: typeof payload.query === "string" ? payload.query.slice(0, 200) : "", favoritesOnly: payload.favoritesOnly === true, includeDeleted: payload.includeDeleted === true });
        case "library.get":
          return await store.get(idOf(payload.id));
        case "thumbnail.get":
          return await createArtifactThumbnail(store, idOf(payload.id));
        case "library.create":
          return await store.create({ kind: kindOf(payload.kind), title: titleOf(payload.title) });
        case "library.rename":
          return await store.rename(idOf(payload.id), titleOf(payload.title));
        case "library.setFavorite":
          if (typeof payload.favorite !== "boolean") throw failure("INVALID_ARGUMENTS", "favorite must be a boolean.");
          return await store.setFavorite(idOf(payload.id), payload.favorite);
        case "library.duplicate":
          return await store.duplicate(idOf(payload.id), { ...payload.title === void 0 ? {} : { title: titleOf(payload.title) } });
        case "library.trash":
          return await store.trash(idOf(payload.id));
        case "library.restore":
          return await store.restore(idOf(payload.id));
        case "library.snapshot":
          return await store.snapshot(idOf(payload.id));
        case "library.listSnapshots":
          return await store.listSnapshots(idOf(payload.id));
        case "library.restoreSnapshot":
          return await store.restoreSnapshot(idOf(payload.id), payload.snapshotId);
        case "library.exportArtifact":
          return await store.exportArtifact(idOf(payload.id));
        case "library.importArtifact": {
          if (!payload.bundle || typeof payload.bundle !== "object" || Array.isArray(payload.bundle) || Object.hasOwn(payload, "sourcePath")) {
            throw failure("INVALID_IMPORT", "Choose a native artwork package; browser calls cannot import an arbitrary local path.");
          }
          return await store.importArtifact({ bundle: payload.bundle, ...payload.title === void 0 ? {} : { title: titleOf(payload.title) } });
        }
        case "view.get":
          return await store.getViewState();
        case "view.openTab":
          return await store.openTab(idOf(payload.id));
        case "view.activateTab":
          return await store.activateTab(payload.id === "library" ? "library" : idOf(payload.id));
        case "view.closeTab":
          return await store.closeTab(payload.id === "library" ? "library" : idOf(payload.id));
        case "view.reorderTabs":
          if (!Array.isArray(payload.ids)) throw failure("INVALID_ARGUMENTS", "ids must be an array.");
          return await store.reorderTabs(payload.ids.map((id) => id === "library" ? "library" : idOf(id)));
        case "editor.open": {
          const record = await requireRecord(payload.id);
          if (record.contentStatus !== "ok") throw failure("ARTIFACT_CONTENT_UNAVAILABLE", "Missing or invalid artifact content cannot open as a blank replacement.");
          if (!opening.has(record.id)) opening.set(record.id, Promise.resolve().then(() => editorOpen(record, { pluginRoot })).finally(() => opening.delete(record.id)));
          return await opening.get(record.id);
        }
        case "conversation.get": {
          const record = await requireRecord(payload.id);
          return {
            artifactId: record.id,
            binding: await store.getBinding(record.id),
            messages: [],
            status: "unsupported",
            capabilities: { sendMessage: false },
            reasonCode: UNSUPPORTED_CHAT_CODE
          };
        }
        case "reference.get": {
          const value = await reference(payload.id);
          return { ...value, resource: resourceLink(value.artifact) };
        }
        case "reference.readFile":
          return await this.readReferenceFile(payload.id, payload.path, payload.encoding);
      }
    }
  };
}

// source/server/http-preview.mjs
var PREVIEW_STATE = "_state/library-preview.json";
var KIND = "codex-design-library-preview";
var error = (code, message) => Object.assign(new Error(message), { code });
var alive2 = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === "EPERM";
  }
};
var detail = (cause) => ({ code: cause.code || "PREVIEW_ERROR", message: String(cause.message || cause).slice(0, 2e3) });
var samePath2 = (a, b) => process.platform === "win32" ? path9.resolve(a).toLowerCase() === path9.resolve(b).toLowerCase() : path9.resolve(a) === path9.resolve(b);
async function previewNativeActivity(record) {
  try {
    const status = await getWorkerStatus(record.path);
    return status.counts.active > 0 ? { busy: true, reason: "An unfinished native design job is recorded for this artwork." } : false;
  } catch {
    return { busy: true, reason: "The artwork task state cannot be verified." };
  }
}
function verifiedState(state, root) {
  if (!state || state.version !== 1 || state.kind !== KIND || !Number.isInteger(state.pid) || state.pid <= 0 || typeof state.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state.token) || typeof state.instanceId !== "string" || !samePath2(state.root, root)) throw error("INVALID_PREVIEW_STATE", "The preview record cannot identify this library.");
  let url;
  try {
    url = new URL(state.url);
  } catch {
    throw error("INVALID_PREVIEW_STATE", "The preview URL is invalid.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== `/${state.token}/` || !url.port) throw error("INVALID_PREVIEW_STATE", "Only the recorded loopback preview URL is accepted.");
  return url;
}
async function libraryPreviewStatus({ root = createLibraryStore().root, timeoutMs = 2e3 } = {}) {
  root = path9.resolve(root);
  if (!await statOrNull(root)) return { running: false, root };
  const state = await readJson2(root, PREVIEW_STATE, null);
  if (!state) return { running: false, root };
  const url = verifiedState(state, root);
  if (!alive2(state.pid)) return { running: false, stale: true, root, state };
  try {
    const response = await fetch(new URL("session", url), { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const session = response.ok ? await response.json() : null;
    if (!session || session.kind !== KIND || session.pid !== state.pid || session.instanceId !== state.instanceId || !samePath2(session.root, root)) throw error("PREVIEW_IDENTITY_UNVERIFIED", "A live PID did not confirm this preview identity.");
    return { running: true, root, url: state.url, pid: state.pid, instanceId: state.instanceId, state };
  } catch {
    throw error("PREVIEW_IDENTITY_UNVERIFIED", "The recorded live process did not confirm this library preview. No process was stopped.");
  }
}
async function stopLibraryPreview(options = {}) {
  const status = await libraryPreviewStatus(options);
  if (!status.running) return { stopped: false, running: false, root: status.root };
  const url = new URL(status.url);
  const response = await fetch(new URL("shutdown", url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5e3), headers: { Origin: url.origin, "Content-Type": "application/json" }, body: JSON.stringify({ instanceId: status.instanceId }) });
  const result = await response.json();
  if (!response.ok || result.instanceId !== status.instanceId || result.stopping !== true) throw error("PREVIEW_STOP_REFUSED", "The preview did not accept its authenticated shutdown.");
  const deadline = Date.now() + 5e3;
  while (Date.now() < deadline) {
    const recorded = await readJson2(status.root, PREVIEW_STATE, null);
    if (!recorded || recorded.instanceId !== status.instanceId) return { stopped: true, root: status.root, pid: status.pid };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { stopped: false, stopping: true, root: status.root, pid: status.pid };
}
function builtHtml(html, endpoint, eventsUrl, nonce) {
  if (typeof html !== "string" || Buffer.byteLength(html) > 8 * 1024 * 1024 || !/<head\b/i.test(html)) throw error("INVALID_PREVIEW_UI", "The built UI is missing or exceeds its size limit.");
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scripts)) if (/\bsrc\s*=/i.test(match[1])) throw error("UI_NOT_BUNDLED", "Use a published or staged plugin whose ui/index.html has inline assets.");
  if (/<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i.test(html.replace(scripts, ""))) throw error("UI_NOT_BUNDLED", "Use a published or staged plugin whose ui/index.html has inline assets.");
  const config = `<script nonce="${nonce}">window.codexDesignHttpEndpoint=${JSON.stringify(endpoint)};window.codexDesignEventsUrl=${JSON.stringify(eventsUrl)};</script>`;
  return html.replace(scripts, (_, attributes2, body) => `<script nonce="${nonce}"${attributes2}>${body}</script>`).replace(/<head\b[^>]*>/i, (head) => head + config);
}
async function requestJson(request, maximum) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    request.resume();
    throw error("UNSUPPORTED_MEDIA_TYPE", "Expected application/json.");
  }
  if (Number(request.headers["content-length"] || 0) > maximum) {
    request.resume();
    throw error("REQUEST_TOO_LARGE", "The request exceeds the preview limit.");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) {
      request.resume();
      throw error("REQUEST_TOO_LARGE", "The request exceeds the preview limit.");
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw error("INVALID_JSON", "Expected one JSON object.");
  }
}
async function startLibraryPreview({ root, pluginRoot = fileURLToPath2(new URL("../", import.meta.url)), store, service, html, port = 0, maxRequestBytes = 17 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw error("INVALID_PREVIEW_OPTION", "Invalid preview port or request limit.");
  store ||= createLibraryStore({ ...root === void 0 ? {} : { root }, isBusy: previewNativeActivity });
  await store.initialize();
  root = store.root;
  pluginRoot = path9.resolve(pluginRoot);
  service ||= createDesignService({ store, pluginRoot });
  if (html === void 0) html = await fs5.readFile(path9.join(pluginRoot, "ui", "index.html"), "utf8");
  const token = randomBytes(32).toString("base64url"), instanceId = randomUUID4(), nonce = randomBytes(18).toString("base64");
  const prefix = `/${token}/`, subscribers = /* @__PURE__ */ new Set(), timers = /* @__PURE__ */ new Map();
  let origin, servedHtml, state, closed = false;
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: 'self'; font-src data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:* http://localhost:*; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'`;
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": csp, "Cross-Origin-Resource-Policy": "same-origin" };
  const json = (response, status, value, extra = {}) => {
    const body = JSON.stringify(value);
    response.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...extra });
    response.end(body);
  };
  const broadcast = (event) => {
    for (const response of subscribers) response.write("data: " + JSON.stringify(event) + "\n\n");
  };
  let server;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const response of subscribers) {
      clearInterval(timers.get(response));
      response.end();
    }
    subscribers.clear();
    timers.clear();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await locked(root, async () => {
      const recorded = await readJson2(root, PREVIEW_STATE, null);
      if (recorded?.instanceId === instanceId) await fs5.unlink(await safePath(root, PREVIEW_STATE, { type: "file" }));
    });
  };
  server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    try {
      if (!origin || request.headers.host !== new URL(origin).host) {
        request.resume();
        return json(response, 421, { error: { code: "INVALID_HOST", message: "Unexpected Host header." } });
      }
      const route = (request.url || "").split("?")[0];
      if (!route.startsWith(prefix) || route.includes("%") || route.includes("\\") || route.includes("/../")) {
        request.resume();
        return json(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
      }
      const suppliedOrigin = request.headers.origin;
      const topNavigation = route === prefix && ["GET", "HEAD"].includes(request.method) && request.headers["sec-fetch-mode"] === "navigate";
      if (suppliedOrigin !== void 0 && suppliedOrigin !== origin || request.headers["sec-fetch-site"] === "cross-site" && !topNavigation) {
        request.resume();
        return json(response, 403, { error: { code: "ORIGIN_REFUSED", message: "Cross-origin requests are refused." } });
      }
      if (route === prefix && ["GET", "HEAD"].includes(request.method)) {
        response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(servedHtml) });
        response.end(request.method === "HEAD" ? void 0 : servedHtml);
        return;
      }
      if (route === prefix + "session" && ["GET", "HEAD"].includes(request.method)) return json(response, 200, { kind: KIND, pid: process.pid, instanceId, root, startedAt: state.startedAt });
      if (route === prefix + "events" && request.method === "GET") {
        if (subscribers.size >= 16) return json(response, 429, { error: { code: "TOO_MANY_CLIENTS", message: "Too many preview event clients." } });
        response.writeHead(200, { ...headers, "Content-Type": "text/event-stream", Connection: "keep-alive" });
        response.write(": preview events\n\n");
        subscribers.add(response);
        const timer = setInterval(() => response.write(": ping\n\n"), 15e3);
        timer.unref();
        timers.set(response, timer);
        response.on("close", () => {
          clearInterval(timer);
          timers.delete(response);
          subscribers.delete(response);
        });
        return;
      }
      if (![prefix + "api", prefix + "shutdown"].includes(route)) {
        request.resume();
        return json(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
      }
      if (request.method !== "POST") {
        request.resume();
        return json(response, 405, { error: { code: "METHOD_REFUSED", message: "Use POST." } }, { Allow: "POST" });
      }
      if (suppliedOrigin !== origin) {
        request.resume();
        return json(response, 403, { error: { code: "ORIGIN_REQUIRED", message: "A matching Origin is required for preview actions." } });
      }
      const body = await requestJson(request, maxRequestBytes);
      if (route.endsWith("/shutdown")) {
        if (body.instanceId !== instanceId) return json(response, 403, { error: { code: "IDENTITY_REFUSED", message: "The preview instance changed." } });
        json(response, 200, { stopping: true, instanceId });
        setImmediate(() => close().catch(() => {
        }));
        return;
      }
      if (typeof body.action !== "string" || body.action.length > 100 || body.payload !== void 0 && (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload))) return json(response, 400, { error: { code: "INVALID_ACTION", message: "Expected {action, payload}." } });
      const result = await service.invoke(body.action, body.payload || {});
      json(response, 200, { result });
      if (body.action.startsWith("view.")) broadcast({ type: "view.changed", ...result?.tabs ? { viewState: result } : {} });
      else if (body.action.startsWith("library.") && !["library.list", "library.get", "library.listSnapshots", "library.exportArtifact"].includes(body.action)) broadcast({ type: "library.changed" });
    } catch (cause) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = cause.code === "REQUEST_TOO_LARGE" ? 413 : cause.code === "UNSUPPORTED_MEDIA_TYPE" ? 415 : cause.code === "NOT_FOUND" ? 404 : ["ARTIFACT_BUSY", "LIBRARY_BUSY", "BINDING_CONFLICT"].includes(cause.code) ? 409 : 400;
      json(response, status, { error: detail(cause) });
    }
  });
  server.requestTimeout = 3e4;
  server.headersTimeout = 1e4;
  try {
    await locked(root, async () => {
      const previous = await libraryPreviewStatus({ root });
      if (previous.running) throw error("PREVIEW_ALREADY_RUNNING", "This library preview is already running at " + previous.url);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      state = { version: 1, kind: KIND, root, pluginRoot, pid: process.pid, instanceId, token, url: origin + prefix, startedAt: (/* @__PURE__ */ new Date()).toISOString() };
      servedHtml = builtHtml(html, origin + prefix + "api", origin + prefix + "events", nonce);
      await atomicJson(root, PREVIEW_STATE, state);
    });
  } catch (cause) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    throw cause;
  }
  return { url: state.url, endpoint: origin + prefix + "api", eventsUrl: origin + prefix + "events", token, instanceId, pid: process.pid, root, close };
}

// source/scripts/library-preview.mjs
function parse(argv) {
  const [command = "help", ...arguments_] = argv;
  const options = {};
  for (let i = 0; i < arguments_.length; i++) {
    const match = /^--(root|plugin-root|port)(?:=(.*))?$/.exec(arguments_[i]);
    if (!match) throw new Error("Use --root, --plugin-root, or --port.");
    const value = match[2] ?? arguments_[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing option value.");
    options[match[1] === "plugin-root" ? "pluginRoot" : match[1]] = match[1] === "port" ? Number(value) : path10.resolve(value);
  }
  return { command, options };
}
async function main(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("codex design requires Node.js 22 or later.");
  const { command, options } = parse(argv);
  const root = options.root || createLibraryStore().root;
  if (command === "status") {
    const status = await libraryPreviewStatus({ root });
    const { state, ...publicStatus } = status;
    console.log(JSON.stringify(publicStatus, null, 2));
    return;
  }
  if (command === "stop") {
    console.log(JSON.stringify(await stopLibraryPreview({ root }), null, 2));
    return;
  }
  if (command === "serve") {
    const preview = await startLibraryPreview(options);
    console.log(JSON.stringify({ url: preview.url, root: preview.root, pid: preview.pid, mode: "local-http-preview", nativeIntegrationVerified: false }, null, 2));
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => preview.close().then(() => {
      process.exitCode = 0;
    }, (cause) => {
      console.error(cause.message);
      process.exitCode = 1;
    }));
    return;
  }
  if (command === "open") {
    const existing = await libraryPreviewStatus({ root });
    if (existing.running) {
      console.log(JSON.stringify({ url: existing.url, root, pid: existing.pid, reused: true }, null, 2));
      return;
    }
    const store = createLibraryStore({ root });
    await store.initialize();
    const log = await safePath(root, "_state/library-preview.log", { mustExist: false });
    const fd = fs6.openSync(log, "a");
    const entrypoint = fileURLToPath3(import.meta.url), childArgs = [entrypoint, "serve", "--root", root, "--plugin-root", options.pluginRoot || fileURLToPath3(new URL("../", import.meta.url)), ...options.port === void 0 ? [] : ["--port", String(options.port)]];
    const child = spawn2(process.execPath, childArgs, { detached: true, windowsHide: true, shell: false, stdio: ["ignore", fd, fd] });
    child.unref();
    fs6.closeSync(fd);
    let childError;
    child.once("error", (cause) => {
      childError = cause;
    });
    const deadline = Date.now() + 15e3;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const status = await libraryPreviewStatus({ root });
      if (status.running && status.pid === child.pid) {
        console.log(JSON.stringify({ url: status.url, root, pid: status.pid, log, mode: "local-http-preview", nativeIntegrationVerified: false }, null, 2));
        return;
      }
    }
    throw new Error("The preview did not finish starting; inspect " + log + ". No unrelated process was stopped.");
  }
  console.log("Usage: node scripts/library-preview.mjs open|serve|status|stop [--root <library>] [--plugin-root <built-plugin>] [--port <number>]");
}
if (process.argv[1] && pathToFileURL(path10.resolve(process.argv[1])).href === import.meta.url) main().catch((cause) => {
  console.error(JSON.stringify({ error: cause.code || "LIBRARY_PREVIEW_ERROR", message: cause.message }));
  process.exitCode = 1;
});
export {
  main
};
