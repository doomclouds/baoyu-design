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
  } catch (error3) {
    if (error3.code === "ENOENT") return fallback;
    throw new BridgeError("INVALID_BRIDGE_STATE", `Cannot read ${file}: ${error3.message}`);
  }
}
function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, file);
        break;
      } catch (error3) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error3.code) || attempt >= 19) throw error3;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error3) {
    return error3.code === "EPERM";
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
  const marker8 = markers[0];
  let owner;
  if (marker8) {
    try {
      owner = readJson(path.join(directory, marker8));
    } catch (error3) {
      if (error3.code !== "INVALID_BRIDGE_STATE") throw error3;
    }
  }
  const valid = owner && Number.isInteger(owner.pid) && typeof owner.token === "string" && Number.isFinite(owner.at);
  if (valid ? alive(owner.pid) : Date.now() - stat.mtimeMs <= initializationGraceMs) return;
  if (marker8) fs.rmSync(path.join(directory, marker8), { force: true });
  try {
    fs.rmdirSync(directory);
  } catch (error3) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error3.code)) throw error3;
  }
}
function tryReaper(directory, initializationGraceMs) {
  const token = randomUUID();
  const marker8 = `owner-${token}.json`;
  const staging = `${directory}.${process.pid}.${token}.initializing`;
  fs.mkdirSync(staging);
  let published = false;
  try {
    fs.writeFileSync(path.join(staging, marker8), JSON.stringify({ pid: process.pid, token, at: Date.now() }), { mode: 384 });
    if (fs.existsSync(directory)) reapDeadReaper(directory, initializationGraceMs);
    if (fs.existsSync(directory)) return null;
    try {
      fs.renameSync(staging, directory);
      published = true;
    } catch (error3) {
      if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error3.code)) return null;
      throw error3;
    }
    return () => {
      fs.rmSync(path.join(directory, marker8), { force: true });
      try {
        fs.rmdirSync(directory);
      } catch (error3) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error3.code)) throw error3;
      }
    };
  } finally {
    if (!published) {
      fs.rmSync(path.join(staging, marker8), { force: true });
      try {
        fs.rmdirSync(staging);
      } catch (error3) {
        if (error3.code !== "ENOENT") throw error3;
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
    } catch (error3) {
      if (error3.code !== "ENOENT") throw error3;
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
      } catch (error3) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error3.code)) throw error3;
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
        } catch (error3) {
          if (error3.code !== "INVALID_BRIDGE_STATE") throw error3;
        }
        const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
        const valid = owner && Number.isInteger(owner.pid) && typeof owner.token === "string" && Number.isFinite(owner.at);
        const expired = stat && (valid ? Date.now() - owner.at > staleMs && !alive(owner.pid) : Date.now() - stat.mtimeMs > initializationGraceMs);
        if (expired) {
          fs.rmSync(ownerFile, { force: true });
          fs.rmdirSync(lockPath);
        }
      } catch (error3) {
        if (!["EEXIST", "ENOENT", "ENOTEMPTY"].includes(error3.code)) throw error3;
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
      } catch (error3) {
        if (error3.code !== "ENOTEMPTY") throw error3;
      }
    }
    if (!acquired) removeInitializing();
  }
}
function normalizeEvent(payload) {
  if (!payload || typeof payload !== "object") throw new BridgeError("INVALID_COMMENT", "Expected a comment or {request} JSON object.");
  const event = payload.request ?? payload;
  if (typeof event.id !== "string" || !event.id || event.id.length > 200) throw new BridgeError("INVALID_COMMENT", "The comment/request id is missing or invalid.");
  if (payload.request) {
    if (typeof event.text !== "string" || !event.text.trim()) throw new BridgeError("INVALID_COMMENT", "The request has no text.");
    return { kind: "request", data: { id: event.id, text: event.text, label: event.label, selection: event.selection, sentAt: event.sentAt } };
  }
  if (!Array.isArray(event.messages)) throw new BridgeError("INVALID_COMMENT", "The comment has no messages.");
  const messages = event.messages.filter((message) => (message.from ?? message.author?.kind) === "user").map((message) => ({
    from: "user",
    text: message.text,
    at: message.at,
    editedAt: message.editedAt
  }));
  if (!messages.length || messages.some((message) => typeof message.text !== "string")) throw new BridgeError("INVALID_COMMENT", "The comment has no valid user messages.");
  return { kind: "comment", data: { id: event.id, file: event.file ?? event.location?.file, where: event.where ?? event.label, detail: event.detail, location: event.location, messages } };
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

// source/library/safety.mjs
import fs2 from "node:fs/promises";
import { constants } from "node:fs";
import path2 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
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
  } catch (error3) {
    if (error3.code === "ENOENT") return null;
    throw error3;
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
async function readJson2(root, relative, fallback) {
  const file = await safePath(root, relative, { mustExist: false });
  try {
    return JSON.parse(await fs2.readFile(file, "utf8"));
  } catch (error3) {
    if (error3.code === "ENOENT") {
      if (fallback !== void 0) return structuredClone(fallback);
      throw new LibraryError("NOT_FOUND", "The requested JSON file is missing.", { path: relative });
    }
    if (error3 instanceof LibraryError) throw error3;
    throw new LibraryError("INVALID_STATE", "A library JSON file is malformed.", { path: relative });
  }
}
async function atomicJson2(root, relative, value) {
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
      } catch (error3) {
        if (!["EACCES", "EBUSY", "EPERM"].includes(error3.code) || attempt >= 12) throw error3;
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
var LibraryError, UUID, KINDS, cursorFor;
var init_safety = __esm({
  "source/library/safety.mjs"() {
    init_bridge_core();
    LibraryError = class extends Error {
      constructor(code, message, details) {
        super(message);
        this.name = "LibraryError";
        this.code = code;
        if (details !== void 0) this.details = details;
      }
    };
    UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    KINDS = Object.freeze(["slides", "design", "design-system", "dashboard"]);
    cursorFor = (root, parts) => within(root, path2.join(root, ...parts));
  }
});

// source/library/content.mjs
import fs3 from "node:fs/promises";
import path3 from "node:path";
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
      found.push({ path: relative, bytes: info.size, contentType: contentType(relative), modifiedAt: info.mtime.toISOString(), ...includeBytes ? { data: (await readBytes(root, relative, limits.maxFileBytes)).toString("base64"), encoding: "base64" } : {} });
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
function blankContent(kind, title, at2) {
  const marker8 = { v: 1, at: at2 };
  if (kind === "slides") return [entry("project/deck.json", { v: 4, createdOnFiles: marker8, lists: "css", title, order: ["cover"], cover: "cover", sections: {}, faces: {}, designSystems: [] }), entry("project/slides/cover.html", '<section id="cover" style="background:#ffffff;color:#20211f;font-family:Arial,sans-serif;padding:128px;display:flex;flex-direction:column;gap:32px"></section>\n')];
  if (kind === "design") return [entry("project/canvas.json", { v: 3, createdOnFiles: marker8, title, launch: { view: "canvas" }, pages: [], boards: {}, order: [], notes: {}, designSystems: [] })];
  if (kind === "design-system") return [
    entry("project/design-system.json", { v: 3, layout: "files", createdOnFiles: marker8, title, namespace: "DesignSystem", libraries: [], sections: {}, groups: [], assetGroups: {}, blobs: {}, docs: { readme: "project/README.md", sections: [] } }),
    entry("project/tokens.json", { name: title, version: 1, color: { themes: [{ id: "light", name: "Light" }], tokens: [] }, type: { fonts: [], families: { sans: "Arial, sans-serif" }, groups: [] }, spacing: { tokens: [] }, radius: { tokens: [] } }),
    entry("project/README.md", "# " + title + "\n"),
    entry("project/components/Cover/preview.html", '<!-- @dsCard group="Overview" height=160 -->\n<div style="min-height:120px"></div>\n')
  ];
  return [entry("db/dash/meta.json", { title }), entry("db/dash/params.json", {}), entry("db/files/index.html.json", { text: '<meta name="dash-one-writer"><style>#dash-root{color:#20211f;background:#fafaf8;font-family:Arial,sans-serif}#dash-root .library-blank-title{color:#20211f;font-size:28px;font-weight:500}</style><h1 class="library-blank-title">' + escape(title) + "</h1>" })];
}
var INDEX_FILES, DEFAULT_LIMITS, forbidden, entry, escape;
var init_content = __esm({
  "source/library/content.mjs"() {
    init_safety();
    INDEX_FILES = Object.freeze({ slides: "project/deck.json", design: "project/canvas.json", "design-system": "project/design-system.json", dashboard: "db/dash/meta.json" });
    DEFAULT_LIMITS = Object.freeze({ maxFiles: 2048, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024, maxBundleBytes: 180 * 1024 * 1024 });
    forbidden = (part) => ["comments.json", "node_modules", "_state", "_trash"].includes(part) || part.startsWith(".") && part !== ".image-slots.state.json";
    entry = (file, value) => ({ path: file, encoding: "base64", data: Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n").toString("base64") });
    escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
});

// source/scripts/worker-core.mjs
import path4 from "node:path";
import { createHash as createHash2 } from "node:crypto";
function loadJobs(root) {
  const state = readJson(path4.join(root, WORKER_JOBS_FILE), { version: 1, jobs: {}, order: [] });
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
    ...job.restorePoint ? { restorePoint: job.restorePoint } : {},
    ...job.ownerThreadId ? { ownerThreadId: job.ownerThreadId } : {},
    ...job.requestId ? { requestId: job.requestId } : {},
    ...job.phase ? { phase: job.phase } : {}
  };
}
function userRevisionHash(event) {
  const messages = event.data.messages?.map((message) => ({ text: message.text, at: message.at, editedAt: message.editedAt }));
  return event.kind === "comment" ? createHash2("sha256").update(JSON.stringify(messages)).digest("hex") : null;
}
var WORKER_FILE, WORKER_JOBS_FILE, WORKER_LOG_FILE, WORKER_LOCK_FILE, NATIVE_BINDING_FILE, saveJobs;
var init_worker_core = __esm({
  "source/scripts/worker-core.mjs"() {
    init_bridge_core();
    WORKER_FILE = ".codex-design-worker.json";
    WORKER_JOBS_FILE = ".codex-design-worker-jobs.json";
    WORKER_LOG_FILE = ".codex-design-worker.log";
    WORKER_LOCK_FILE = ".codex-design-worker.lock";
    NATIVE_BINDING_FILE = ".codex-design-native-binding.json";
    saveJobs = (root, state) => atomicJson(path4.join(root, WORKER_JOBS_FILE), state);
  }
});

// source/library/index.mjs
import fs4 from "node:fs/promises";
import os from "node:os";
import path5 from "node:path";
import { createHash as createHash3, randomUUID as randomUUID3 } from "node:crypto";
async function nativeTrashActivity(record) {
  const busy = (reason) => ({ busy: true, reason });
  try {
    const id = artifactId(record.id), kind = artifactKind(record.kind), root = path5.resolve(record.path);
    const libraryRoot = path5.dirname(path5.dirname(root));
    const expected = path5.join(libraryRoot, "_trash", id);
    const same = (a, b) => typeof a === "string" && (process.platform === "win32" ? path5.resolve(a).toLowerCase() === path5.resolve(b).toLowerCase() : path5.resolve(a) === path5.resolve(b));
    if (!same(root, expected)) return busy("The trash task location cannot be verified.");
    const target = await safePath(libraryRoot, `_trash/${id}`, { mustExist: false });
    if (!await statOrNull(target)) {
      const progress = await readJson2(libraryRoot, `_state/purge-progress/${id}.json`, null);
      const active = await safePath(libraryRoot, `${kind}/${id}`, { mustExist: false });
      return progress?.version === 1 && progress.artifactId === id && progress.kind === kind && !await statOrNull(active) ? false : busy("The missing trash task location cannot be verified.");
    }
    await safePath(libraryRoot, `_trash/${id}`, { type: "directory" });
    const registry = await readJson2(root, WORKER_FILE, null);
    const state = await readJson2(root, WORKER_JOBS_FILE, { version: 1, jobs: {}, order: [] });
    if (registry && (registry.version !== 1 || registry.url || registry.token || !UUID.test(registry.nativeThreadId ?? "") || !same(registry.root, root) && !same(registry.root, path5.join(libraryRoot, kind, id)) || !["waiting", "paused", "active"].includes(registry.status))) return busy("The native owner is unknown; permanent deletion was refused.");
    if (!state || state.version !== 1 || !state.jobs || typeof state.jobs !== "object" || Array.isArray(state.jobs) || !Array.isArray(state.order) || Object.values(state.jobs).some((job) => !job || !["pending", "active", "completed", "failed", "superseded"].includes(job.status))) return busy("The native job journal cannot be verified; permanent deletion was refused.");
    if (Object.values(state.jobs).some((job) => job.status === "active") || registry?.activeJobId || registry?.status === "active" || registry?.listener && (!Number.isFinite(registry.listener.expiresAt) || !Number.isInteger(registry.listener.pid) || registry.listener.expiresAt > Date.now() && alive(registry.listener.pid))) return busy("An unfinished native job or listener still owns this artwork. Its parent must coordinate it before permanent deletion.");
    return false;
  } catch {
    return busy("The native task state cannot be verified; permanent deletion was refused.");
  }
}
function createLibraryStore(options) {
  return new LibraryStore(options);
}
var BUNDLE_FORMAT, catalogFile, viewFile, bindingsFile, emptyCatalog, libraryTab, emptyView, at, metadata, LibraryStore;
var init_library = __esm({
  "source/library/index.mjs"() {
    init_safety();
    init_content();
    init_bridge_core();
    init_worker_core();
    BUNDLE_FORMAT = "codex-design-artifact";
    catalogFile = "_state/catalog.json";
    viewFile = "_state/view.json";
    bindingsFile = "_state/bindings.json";
    emptyCatalog = () => ({ version: 1, artifacts: {} });
    libraryTab = () => ({ id: "library", type: "library" });
    emptyView = () => ({ version: 1, tabs: [libraryTab()], activeTabId: "library" });
    at = () => (/* @__PURE__ */ new Date()).toISOString();
    metadata = (value) => {
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
    LibraryStore = class {
      constructor({ root = path5.join(os.homedir(), ".codex", "CodexDesignLibrary"), isBusy = async () => false, limits = {} } = {}) {
        if (typeof root !== "string" || !root.trim()) throw new LibraryError("INVALID_PATH", "A library root is required.");
        if (typeof isBusy !== "function") throw new LibraryError("INVALID_OPTION", "isBusy must be a function.");
        this.root = path5.resolve(root);
        this.isBusy = isBusy;
        this.limits = { ...DEFAULT_LIMITS, ...limits };
        if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new LibraryError("INVALID_OPTION", "Content limits must be positive integers.");
      }
      async initialize() {
        if (!this.ready) this.ready = this._initialize().catch((error3) => {
          this.ready = null;
          throw error3;
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
            await atomicJson2(this.root, "_state/library.json", identity);
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
          if (!await statOrNull(await safePath(this.root, viewFile, { mustExist: false }))) await atomicJson2(this.root, viewFile, emptyView());
          if (!await statOrNull(await safePath(this.root, bindingsFile, { mustExist: false }))) await atomicJson2(this.root, bindingsFile, { version: 1, artifacts: {} });
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
        return atomicJson2(this.root, catalogFile, catalog);
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
        const result = { ...metadata(record), path: path5.join(this.root, ...this._relative(record).split("/")), contentStatus: "ok", deleted: record.location === "trash" };
        try {
          const root = await this._artifactPath(record);
          const manifest = metadata(await readJson2(root, "artifact.json"));
          if (manifest.id !== record.id || manifest.kind !== record.kind) throw new LibraryError("INVALID_MANIFEST", "The artifact identity changed.");
          const listed = await collectContent(root, record.kind, this.limits, { includeBytes: false });
          const needed = /* @__PURE__ */ new Set([INDEX_FILES[record.kind], "project/tokens.json", "db/files/index.html.json"]);
          const files = [];
          for (const file of listed) files.push({ ...file, data: needed.has(file.path) || /\.(?:html|css|js|mjs|json|md|svg)$/i.test(file.path) ? (await readBytes(root, file.path, this.limits.maxFileBytes)).toString("base64") : "" });
          const native7 = validateFiles(record.kind, files);
          const changedAt = listed.reduce((latest, file) => file.modifiedAt > latest ? file.modifiedAt : latest, manifest.updatedAt);
          Object.assign(result, manifest, { title: native7.title, updatedAt: changedAt });
        } catch (error3) {
          result.contentStatus = ["NOT_FOUND", "MISSING_CONTENT"].includes(error3.code) ? "missing" : "invalid";
          result.contentError = { code: error3.code || "INVALID_CONTENT", message: error3.message };
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
        within(path5.join(this.root, "_state/staging"), absolute);
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
          await atomicJson2(stage.absolute, "artifact.json", manifest);
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
          await atomicJson2(root, INDEX_FILES[record.kind], index);
        }
        await atomicJson2(root, "artifact.json", next);
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
        const native7 = validateFiles(record.kind, files);
        const bundle = { format: BUNDLE_FORMAT, version: 1, kind: record.kind, title: native7.title, files: files.map(({ path: path14, encoding, data }) => ({ path: path14, encoding, data })) };
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
        const native7 = validateFiles(bundle.kind, files);
        return { kind: bundle.kind, title: native7.title, files };
      }
      async _source(sourcePath, kind) {
        if (typeof sourcePath !== "string" || !path5.isAbsolute(sourcePath)) throw new LibraryError("INVALID_PATH", "Choose an absolute source path explicitly.");
        const info = await fs4.lstat(sourcePath).catch((error3) => {
          if (error3.code === "ENOENT") throw new LibraryError("NOT_FOUND", "The import source is missing.");
          throw error3;
        });
        if (info.isSymbolicLink()) throw new LibraryError("SYMLINK_REFUSED", "The import source cannot be a symbolic link.");
        if (info.isFile()) return this._bundle(await readBytes(path5.dirname(sourcePath), path5.basename(sourcePath), this.limits.maxBundleBytes), kind);
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
        const native7 = validateFiles(kind, files);
        return { kind, title: native7.title, files };
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
        return {
          path: relative,
          contentType: type,
          bytes: bytes.length,
          revision: { sha256: createHash3("sha256").update(bytes).digest("hex"), observedAt: at() },
          ...encoding === "base64" ? { encoding, data: bytes.toString("base64") } : { text: bytes.toString("utf8") }
        };
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
          await atomicJson2(destination, "artifact.json", next);
          catalog.artifacts[record.id] = { ...next, location: "trash" };
          await this._saveCatalog(catalog);
          const view = await this._view(catalog);
          view.tabs = view.tabs.filter((tab) => tab.id !== record.id);
          if (view.activeTabId === record.id) view.activeTabId = "library";
          await atomicJson2(this.root, viewFile, view);
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
          await atomicJson2(destination, "artifact.json", next);
          catalog.artifacts[record.id] = { ...next, location: "active" };
          await this._saveCatalog(catalog);
          return this._inspect(catalog.artifacts[record.id]);
        });
      }
      async _purgeTree(relative, { inspectOnly = true } = {}) {
        if (!/^(?:_trash|_state\/snapshots)\/[0-9a-f-]{36}$/.test(relative) || !UUID.test(relative.split("/").at(-1))) throw new LibraryError("INVALID_PATH", "Permanent deletion requires an exact trash or snapshot identity.");
        if (await fs4.realpath(this.root) !== this.realRoot || (await fs4.lstat(this.root)).isSymbolicLink()) throw new LibraryError("ROOT_CHANGED", "The library root changed before permanent deletion.");
        const absolute = await safePath(this.root, relative, { mustExist: false });
        const expected = path5.resolve(this.root, ...relative.split("/"));
        within(this.root, absolute);
        if (path5.resolve(absolute) !== expected) throw new LibraryError("INVALID_PATH", "The permanent deletion target changed.");
        if (!await statOrNull(absolute)) return false;
        const walk = async (child) => {
          const target = await safePath(this.root, child);
          const info = await fs4.lstat(target);
          if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new LibraryError("SYMLINK_REFUSED", "Permanent deletion refuses links and special files.");
          if (info.isDirectory()) for (const entry2 of await fs4.readdir(target)) await walk(`${child}/${entry2}`);
        };
        await safePath(this.root, relative, { type: "directory" });
        await walk(relative);
        if (!inspectOnly) {
          const checked = await safePath(this.root, relative, { type: "directory" });
          if (path5.resolve(checked) !== expected || await fs4.realpath(this.root) !== this.realRoot) throw new LibraryError("ROOT_CHANGED", "The permanent deletion target changed.");
          await fs4.rm(checked, { recursive: true, force: false });
        }
        return true;
      }
      async _purgeNativeIdle(record, root) {
        const inspected = record.title ? await this._inspect(record) : { ...record, path: root, deleted: true, contentStatus: "missing" };
        const native7 = await nativeTrashActivity({ ...inspected, path: root });
        if (native7?.busy) throw new LibraryError("ARTIFACT_BUSY", native7.reason);
        const external = await this.isBusy(inspected);
        if (external === true || external?.busy) throw new LibraryError("ARTIFACT_BUSY", external?.reason || "An external artwork task still owns this trash item.");
      }
      async purge(ids) {
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200) throw new LibraryError("INVALID_ARGUMENTS", "Choose between 1 and 200 trash artifact ids.");
        ids = [...new Set(ids.map(artifactId))];
        await this._checkRoot();
        return locked(this.root, async () => {
          const catalog = await this._catalog(), bindings = await this._bindings();
          const legacy = await readJson2(this.root, "_state/legacy-imports.json", null);
          if (legacy && (legacy.version !== 1 || !legacy.sources || typeof legacy.sources !== "object" || Array.isArray(legacy.sources))) throw new LibraryError("INVALID_STATE", "The legacy registration state is invalid.");
          const requestFiles = new Map(ids.map((id) => [id, []]));
          const requests = await safePath(this.root, "_state/edit-requests", { mustExist: false });
          if (await statOrNull(requests)) {
            await safePath(this.root, "_state/edit-requests", { type: "directory" });
            for (const name of await fs4.readdir(requests)) if (/^[0-9a-f-]{36}\.json$/i.test(name)) {
              const relative = `_state/edit-requests/${name}`;
              let request;
              try {
                request = JSON.parse((await readBytes(this.root, relative, 512 * 1024)).toString("utf8"));
              } catch (error3) {
                if (error3 instanceof LibraryError) throw error3;
                throw new LibraryError("INVALID_STATE", "An edit request record is malformed.");
              }
              if (request.version !== 1 || !UUID.test(request.id ?? "") || request.id.toLowerCase() !== name.slice(0, -5).toLowerCase() || !UUID.test(request.artifactId ?? "")) throw new LibraryError("INVALID_STATE", "An edit request identity is invalid.");
              requestFiles.get(request.artifactId.toLowerCase())?.push(relative);
            }
          }
          const plans = [];
          for (const id of ids) {
            const progressPath = `_state/purge-progress/${id}.json`;
            const progress = await readJson2(this.root, progressPath, null);
            if (progress && (progress.version !== 1 || progress.artifactId !== id || !KINDS.includes(progress.kind))) throw new LibraryError("INVALID_STATE", "A permanent deletion receipt is invalid.");
            const record = catalog.artifacts[id] || (progress ? { id, kind: progress.kind, location: "trash" } : null);
            if (!record) throw new LibraryError("NOT_FOUND", "No such trash artifact.");
            if (record.location !== "trash") throw new LibraryError("NOT_IN_TRASH", "Only artifacts currently in the trash can be permanently deleted.");
            if (progress && progress.kind !== record.kind) throw new LibraryError("INVALID_STATE", "A permanent deletion receipt has a different artifact kind.");
            const active = await safePath(this.root, `${record.kind}/${id}`, { mustExist: false });
            if (await statOrNull(active)) throw new LibraryError("NOT_IN_TRASH", "An active artifact occupies this identity; permanent deletion was refused.");
            const present = await this._purgeTree(`_trash/${id}`);
            if (!present && !progress) throw new LibraryError("NOT_FOUND", "The selected trash directory is missing.");
            if (present) {
              const root = await safePath(this.root, `_trash/${id}`, { type: "directory" });
              const manifestFile = await safePath(root, "artifact.json", { mustExist: false });
              if (await statOrNull(manifestFile)) {
                const manifest = metadata(await readJson2(root, "artifact.json"));
                if (manifest.id !== id || manifest.kind !== record.kind || !manifest.deletedAt) throw new LibraryError("NOT_IN_TRASH", "The trash directory does not contain this deleted artwork identity.");
              } else if (!progress) throw new LibraryError("NOT_FOUND", "The selected trash manifest is missing.");
            }
            await this._purgeNativeIdle(record, await safePath(this.root, `_trash/${id}`, { mustExist: false }));
            await this._purgeTree(`_state/snapshots/${id}`);
            const snapshots = await safePath(this.root, `_state/snapshots/${id}`, { mustExist: false });
            if (await statOrNull(snapshots)) {
              for (const name of await fs4.readdir(snapshots)) if (/^[0-9a-f-]{36}\.json$/i.test(name)) {
                const saved = await readJson2(this.root, `_state/snapshots/${id}/${name}`);
                if (saved.artifactId !== id || saved.id !== name.slice(0, -5)) throw new LibraryError("INVALID_STATE", "A recovery point belongs to a different artifact identity.");
              }
            }
            plans.push({ id, record, progressPath, progress, requestFiles: requestFiles.get(id) });
          }
          const deleted = [], failed = [];
          for (const plan of plans) {
            const { id } = plan, removed = [];
            let stage = "prepare";
            try {
              if (catalog.artifacts[id] && catalog.artifacts[id].location !== "trash") throw new LibraryError("NOT_IN_TRASH", "The selected artwork is no longer in the trash.");
              await atomicJson2(this.root, plan.progressPath, plan.progress || { version: 1, artifactId: id, kind: plan.record.kind, startedAt: at() });
              const trashRoot = await safePath(this.root, `_trash/${id}`, { mustExist: false });
              await this._purgeNativeIdle(plan.record, trashRoot);
              stage = "artwork";
              if (await this._purgeTree(`_trash/${id}`, { inspectOnly: false })) removed.push("artwork");
              stage = "snapshots";
              if (await this._purgeTree(`_state/snapshots/${id}`, { inspectOnly: false })) removed.push("snapshots");
              stage = "requests";
              for (const relative of plan.requestFiles) {
                const file = await safePath(this.root, relative, { mustExist: false });
                if (await statOrNull(file)) await fs4.unlink(await safePath(this.root, relative, { type: "file" }));
              }
              if (plan.requestFiles.length) removed.push("requests");
              stage = "metadata";
              const nextBindings = structuredClone(bindings);
              delete nextBindings.artifacts[id];
              await atomicJson2(this.root, bindingsFile, nextBindings);
              delete bindings.artifacts[id];
              if (legacy) {
                const nextLegacy = structuredClone(legacy);
                for (const [key, value] of Object.entries(nextLegacy.sources)) if (value === id) delete nextLegacy.sources[key];
                await atomicJson2(this.root, "_state/legacy-imports.json", nextLegacy);
                legacy.sources = nextLegacy.sources;
              }
              const nextCatalog = structuredClone(catalog);
              delete nextCatalog.artifacts[id];
              await atomicJson2(this.root, viewFile, await this._view(nextCatalog));
              await this._saveCatalog(nextCatalog);
              delete catalog.artifacts[id];
              removed.push("metadata");
              stage = "receipt";
              await fs4.unlink(await safePath(this.root, plan.progressPath, { type: "file" }));
              deleted.push(id);
            } catch (error3) {
              const message = (stage === "prepare" ? "" : "Permanent deletion was incomplete; some local data may already be removed. ") + String(error3.message || error3);
              failed.push({ id, error: { code: error3.code || "PURGE_FAILED", message: message.slice(0, 1e3) }, removed, stage });
            }
          }
          return { deleted, failed };
        });
      }
      async snapshot(id, { label = "Snapshot" } = {}) {
        label = titleText(label);
        await this._checkRoot();
        return locked(this.root, async () => {
          const { record } = await this._raw(id), bundle = await this._export(record);
          const snapshot = { id: randomUUID3(), artifactId: record.id, label, createdAt: at(), bundle };
          await atomicJson2(this.root, `_state/snapshots/${record.id}/${snapshot.id}.json`, snapshot);
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
          const before = path5.join(stage.absolute, "before"), after = path5.join(stage.absolute, "after");
          await fs4.mkdir(before);
          await fs4.mkdir(after);
          await writeContent(after, bundle.files);
          const moved = [], added = [];
          try {
            for (const file of current) {
              const from = await safePath(root, file.path, { type: "file" }), to = await safePath(before, file.path, { mustExist: false });
              await fs4.mkdir(path5.dirname(to), { recursive: true });
              await fs4.rename(from, to);
              moved.push(file.path);
            }
            for (const file of bundle.files) {
              const from = await safePath(after, file.path, { type: "file" }), to = await safePath(root, file.path, { mustExist: false });
              if (await statOrNull(to)) throw new LibraryError("CONTENT_CHANGED", "A file changed while restoring a snapshot.");
              await fs4.mkdir(path5.dirname(to), { recursive: true });
              await fs4.rename(from, to);
              added.push(file.path);
            }
            const next = metadata({ ...record, title: bundle.title, updatedAt: at() });
            await atomicJson2(root, "artifact.json", next);
            manifestWritten = true;
            catalog.artifacts[id] = { ...next, location: "active" };
            await this._saveCatalog(catalog);
            return this._inspect(catalog.artifacts[id]);
          } catch (error3) {
            for (const relative of added) await fs4.unlink(await safePath(root, relative, { type: "file" }));
            for (const relative of moved) {
              const from = await safePath(before, relative, { type: "file" }), to = await safePath(root, relative, { mustExist: false });
              await fs4.mkdir(path5.dirname(to), { recursive: true });
              await fs4.rename(from, to);
            }
            if (manifestWritten) await atomicJson2(root, "artifact.json", originalManifest);
            throw error3;
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
              results.push({ kind, path: path5.join(this.root, relative), status: "invalid", code: "SYMLINK_REFUSED" });
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
              await atomicJson2(this.root, "_state/legacy-imports.json", state);
              results.push({ kind, path: source, status: "imported", artifactId: imported.id });
            } catch (error3) {
              results.push({ kind, path: source, status: ["MISSING_CONTENT", "NOT_FOUND"].includes(error3.code) ? "missing" : "invalid", code: error3.code || "INVALID_CONTENT", message: error3.message });
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
          await atomicJson2(this.root, bindingsFile, state);
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
          await atomicJson2(this.root, bindingsFile, state);
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
          await atomicJson2(this.root, viewFile, view);
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
  }
});

// source/scripts/artifact-delivery.mjs
var init_artifact_delivery = __esm({
  "source/scripts/artifact-delivery.mjs"() {
    init_library();
    init_safety();
    init_bridge_core();
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
  const binding = readNativeBinding(root);
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
async function stopWorker(root, { onlyWhenIdle = false } = {}) {
  return await withJobs(root, async () => {
    const registry = readRegistry(root);
    const state = loadJobs(root);
    if (onlyWhenIdle && Object.values(state.jobs).some((job) => job.status === "active")) {
      throw new BridgeError("ARTIFACT_BUSY", "An active native design job owns this artwork. Its parent must coordinate ownership before stopping the editor or moving its files.");
    }
    if (!registry) return { paused: false, interruptRequired: false, nativeThreadId: null };
    let active = false;
    for (const job of Object.values(state.jobs)) if (job.status === "active") {
      active = true;
      job.status = "pending";
      job.pausedAt = now();
    }
    registry.status = "paused";
    registry.pausedAt = now();
    delete registry.listener;
    delete registry.activeJobId;
    saveJobs(root, state);
    saveRegistry(root, registry);
    return {
      paused: true,
      nativeThreadId: registry.nativeThreadId,
      interruptRequired: active,
      note: "This pauses the local listener only. The parent must use native agent tools to interrupt a child that is still editing."
    };
  });
}
var registryFile, withJobs, saveRegistry, now, readNativeBinding;
var init_worker_client = __esm({
  "source/scripts/worker-client.mjs"() {
    init_bridge_core();
    init_worker_core();
    init_library();
    init_artifact_delivery();
    registryFile = (root) => path6.join(root, WORKER_FILE);
    withJobs = (root, action) => withLock(path6.join(root, WORKER_LOCK_FILE), action, { timeoutMs: 1e4, staleMs: 0 });
    saveRegistry = (root, registry) => atomicJson(registryFile(root), registry);
    now = () => (/* @__PURE__ */ new Date()).toISOString();
    readNativeBinding = (root) => readJson(path6.join(root, NATIVE_BINDING_FILE)) ?? readJson(path6.join(root, BINDING_FILE));
  }
});

// source/scripts/design-system-search.mjs
var init_design_system_search = __esm({
  "source/scripts/design-system-search.mjs"() {
  }
});

// source/library/edit-requests.mjs
import fs5 from "node:fs/promises";
import path7 from "node:path";
import { createHash as createHash4, randomUUID as randomUUID4 } from "node:crypto";
function eventFor(thread, kind) {
  const event = normalizeEvent(thread);
  const canonicalFile = (value) => {
    relativePath(value);
    if (kind === "dashboard" && !contentPath(kind, value) && !value.startsWith("db/") && !value.startsWith("_blobs/")) {
      return /^(?:files|datasets)\//.test(value) ? `db/${value}.json` : `db/files/${value}.json`;
    }
    return value;
  };
  if (event.data.file !== void 0) event.data.file = canonicalFile(event.data.file);
  if (event.data.location?.file !== void 0) event.data.location.file = canonicalFile(event.data.location.file);
  if (event.data.file !== void 0) {
    relativePath(event.data.file);
    if (!contentPath(kind, event.data.file)) throw new LibraryError("CONTENT_ONLY", "A comment location must identify artwork content.");
  }
  if (event.data.location?.file !== void 0) {
    relativePath(event.data.location.file);
    if (!contentPath(kind, event.data.location.file)) throw new LibraryError("CONTENT_ONLY", "A comment location must identify artwork content.");
    if (event.data.file !== event.data.location.file) throw new LibraryError("INVALID_COMMENT", "The comment file and location disagree.");
  }
  if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) throw new LibraryError("LIMIT_EXCEEDED", "The comment request context is too large.");
  return JSON.parse(JSON.stringify(event));
}
function stateError(record, thread, kind) {
  if (!thread || thread.status !== "open") return new LibraryError("COMMENT_RESOLVED", "This comment is no longer open. Prepare a current open comment instead.");
  try {
    if (userRevisionHash(eventFor(thread, kind)) === record.commentRevision) return null;
  } catch {
  }
  return new LibraryError("COMMENT_REVISION_CHANGED", "The user changed this comment after the request was prepared. Prepare the current revision instead.");
}
function validateRecord(record, id) {
  if (!record || record.version !== 1 || requestId(record.id) !== id || artifactId(record.artifactId) !== record.artifactId || typeof record.commentRevision !== "string" || !/^[a-f0-9]{64}$/.test(record.commentRevision) || !record.artifact || record.artifact.id !== record.artifactId || !Array.isArray(record.fileRevisions) || !record.event || record.event.kind !== "comment" || record.event.data?.id !== record.commentId || !["draft_ready", "prepared", "needs_attention", "accepted", "queued", "superseded"].includes(record.status)) {
    throw new LibraryError("INVALID_STATE", "The edit request record is invalid.");
  }
  commentId(record.commentId);
  eventFor(record.event.data, record.artifact.kind);
  for (const file of record.fileRevisions) {
    relativePath(file.path);
    if (!contentPath(record.artifact.kind, file.path)) throw new LibraryError("INVALID_STATE", "An edit request includes a non-content file.");
  }
  return record;
}
function publicRequest(record, status = record.status) {
  return structuredClone({
    id: record.id,
    requestId: record.id,
    requestUri: requestUri(record.id),
    artifactId: record.artifactId,
    commentId: record.commentId,
    artifact: record.artifact,
    event: record.event,
    commentRevision: record.commentRevision,
    fileRevisions: record.fileRevisions,
    artifactRevision: record.artifactRevision,
    createdAt: record.createdAt,
    status,
    ...record.draftAddedAt ? { draftAddedAt: record.draftAddedAt } : {},
    ...record.draftError ? { error: record.draftError } : {},
    ...record.acceptedAt ? { acceptedAt: record.acceptedAt } : {},
    ...record.dispatch ? { dispatch: record.dispatch } : {}
  });
}
function projection(record, thread, worker, rawJobs) {
  const base = { requestId: record?.id ?? null };
  const revision = record?.commentRevision ?? (() => {
    try {
      return userRevisionHash(normalizeEvent(thread));
    } catch {
      return null;
    }
  })();
  const job = record ? worker?.jobs.find((job2) => (record.dispatch ? job2.id === record.dispatch.jobId : job2.requestId === record.id) && rawJobs[job2.id]?.requestId === record.id && rawJobs[job2.id]?.capturedUserRevision === revision) : worker?.jobs.findLast((job2) => job2.commentId === thread.id && rawJobs[job2.id]?.capturedUserRevision === revision);
  const currentRevision = (() => {
    try {
      return userRevisionHash(normalizeEvent(thread));
    } catch {
      return null;
    }
  })();
  if (job?.status === "completed" && job.repliedAt && currentRevision === revision) return { ...base, status: "completed", ...job.phase ? { phase: job.phase } : {} };
  if (record && (record.status === "superseded" || stateError(record, thread, record.artifact.kind))) return { ...base, status: "superseded", message: "The comment changed or was resolved. Add its current revision to a draft." };
  if (job && (record || job.status !== "pending")) {
    const phase = job.phase ?? rawJobs[job.id]?.phase;
    const detail2 = phase ? { phase } : {};
    if (phase?.startsWith("awaiting-")) return {
      ...base,
      status: "needs_attention",
      ...detail2,
      message: job.error?.message || "The native request needs confirmation before editing can continue."
    };
    if (job.status === "active") return { ...base, status: "working", ...detail2 };
    if (job.status === "pending") return { ...base, status: "queued", ...detail2 };
    if (job.status === "failed") return { ...base, status: "failed", ...detail2, ...job.error?.message ? { message: String(job.error.message).slice(0, 1e3) } : {} };
    if (job.status === "superseded") return { ...base, status: "superseded" };
    if (job.status === "completed" && job.repliedAt) return { ...base, status: "completed", ...detail2 };
    return { ...base, status: "needs_attention", message: "The worker has not recorded a completed comment reply." };
  }
  if (record?.dispatch) return { ...base, status: "needs_attention", message: "The dispatched native job could not be found. Retry from the accepting chat." };
  if (record) {
    if (record.status === "needs_attention") return { ...base, status: "needs_attention", message: record.draftError?.message || "The native draft could not be updated. Try adding this request again." };
    return { ...base, status: record.status, ...record.status === "draft_ready" ? { message: "Ready to add to a native draft." } : {} };
  }
  return { ...base, status: "needs_attention", message: "This earlier submission has no accepted native request. Add it to a draft to continue." };
}
function createEditRequestStore({ store } = {}) {
  if (!store || typeof store._checkRoot !== "function" || typeof store._raw !== "function") throw new LibraryError("INVALID_OPTION", "An initialized library store is required.");
  const ready = () => store._checkRoot();
  const location = async (id) => {
    const { record } = await store._raw(artifactId(id));
    return { record, root: await store._artifactPath(record) };
  };
  const comments = async (root) => {
    const file = await safePath(root, "comments.json", { mustExist: false });
    if (!await statOrNull(file)) return { version: 1, threads: [] };
    let value;
    try {
      value = JSON.parse((await readBytes(root, "comments.json", MAX_COMMENTS_BYTES)).toString("utf8"));
    } catch (error3) {
      if (error3 instanceof LibraryError) throw error3;
      throw new LibraryError("INVALID_STATE", "The canonical comment document is malformed.");
    }
    if (!value || !Array.isArray(value.threads)) throw new LibraryError("INVALID_STATE", "The canonical comment document has no threads.");
    return value;
  };
  const recordPath = (id) => `${DIRECTORY}/${requestId(id)}.json`;
  const load = async (id) => {
    id = requestId(id);
    let value;
    try {
      value = JSON.parse((await readBytes(store.root, recordPath(id), MAX_REQUEST_BYTES)).toString("utf8"));
    } catch (error3) {
      if (error3 instanceof LibraryError) throw error3;
      throw new LibraryError("INVALID_STATE", "The edit request record is malformed.");
    }
    return validateRecord(value, id);
  };
  const save = async (value) => {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_REQUEST_BYTES) throw new LibraryError("LIMIT_EXCEEDED", "The edit request snapshot is too large.");
    await atomicJson2(store.root, recordPath(value.id), value);
  };
  const all = async () => {
    const directory = await safePath(store.root, DIRECTORY, { mustExist: false });
    if (!await statOrNull(directory)) return [];
    await safePath(store.root, DIRECTORY, { type: "directory" });
    const records = [];
    for (const entry2 of await fs5.readdir(directory)) if (/^[0-9a-f-]{36}\.json$/i.test(entry2)) records.push(await load(entry2.slice(0, -5)));
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  };
  const current = async (record) => {
    try {
      const found = await location(record.artifactId);
      const document2 = await comments(found.root);
      return { ...found, thread: document2.threads.find((thread) => thread.id === record.commentId) };
    } catch (error3) {
      if (error3.code === "NOT_FOUND") return null;
      throw error3;
    }
  };
  const stale = async (record) => {
    const found = await current(record);
    const error3 = found ? stateError(record, found.thread, found.record.kind) : new LibraryError("COMMENT_RESOLVED", "This artifact or comment is no longer active.");
    return { found, error: error3 };
  };
  const mutateCurrent = async (id, action) => {
    await ready();
    let failure3;
    const result = await locked(store.root, async () => {
      const record = await load(id);
      const check = await stale(record);
      if (check.error || record.status === "superseded") {
        record.status = "superseded";
        record.supersededAt ??= now2();
        await save(record);
        failure3 = check.error || new LibraryError("COMMENT_REVISION_CHANGED", "This superseded request cannot be accepted again. Prepare a new user revision.");
        return null;
      }
      await action(record, check.found);
      await save(record);
      return publicRequest(record);
    });
    if (failure3) throw failure3;
    return result;
  };
  const api = {
    async prepare({ artifactId: id, commentId: idOfComment } = {}) {
      id = artifactId(id);
      idOfComment = commentId(idOfComment);
      await ready();
      return locked(store.root, async () => {
        const found = await location(id);
        const document2 = await comments(found.root);
        const thread = document2.threads.find((thread2) => thread2.id === idOfComment);
        if (!thread || thread.status !== "open") throw new LibraryError("COMMENT_RESOLVED", "Prepare an existing open comment.");
        const event = eventFor(thread, found.record.kind);
        const commentRevision = userRevisionHash(event);
        const existing = (await all()).findLast((record2) => record2.artifactId === id && record2.commentId === idOfComment && record2.commentRevision === commentRevision && record2.status !== "superseded");
        if (existing) return publicRequest(existing);
        const observedAt = now2(), fileRevisions = [];
        for (const relative of [...new Set([INDEX_FILES[found.record.kind], event.data.file].filter(Boolean))]) {
          const file = await safePath(found.root, relative, { mustExist: false });
          if (!await statOrNull(file)) {
            fileRevisions.push({ path: relative, missing: true, observedAt });
            continue;
          }
          const bytes = await readBytes(found.root, relative, store.limits.maxFileBytes);
          fileRevisions.push({ path: relative, sha256: sha(bytes), bytes: bytes.length, observedAt });
        }
        const artifact = { id, kind: found.record.kind, title: found.record.title };
        const record = {
          version: 1,
          id: randomUUID4(),
          artifactId: id,
          commentId: idOfComment,
          artifact,
          event,
          commentRevision,
          fileRevisions,
          artifactRevision: sha(JSON.stringify({ artifact, files: fileRevisions.map(({ observedAt: _at, ...file }) => file) })),
          createdAt: observedAt,
          status: "draft_ready"
        };
        await save(record);
        return publicRequest(record);
      });
    },
    async read(id) {
      requestId(id);
      await ready();
      return locked(store.root, async () => {
        const record = await load(id);
        if ((await stale(record)).error && record.status !== "superseded") {
          record.status = "superseded";
          record.supersededAt ??= now2();
          await save(record);
        }
        return publicRequest(record);
      });
    },
    async requestForModel(id) {
      const result = await api.read(id);
      if (result.status === "superseded") return result;
      const found = await location(result.artifactId);
      return { ...result, artifactRoot: found.root };
    },
    markDraftAdded: (id) => mutateCurrent(id, (record) => {
      if (record.acceptedAt || record.dispatch) return;
      record.draftAddedAt ??= now2();
      record.status = "prepared";
      delete record.draftError;
    }),
    markDraftFailed: (id, error3) => mutateCurrent(id, (record) => {
      if (record.acceptedAt || record.dispatch || record.draftAddedAt) return;
      record.status = "needs_attention";
      record.draftError = errorSummary(error3);
    }),
    accept: (id) => mutateCurrent(id, async (record, found) => {
      for (const file of record.fileRevisions) await safePath(found.root, file.path, { type: "file" });
      record.acceptedAt ??= now2();
      if (!record.dispatch) record.status = "accepted";
    }),
    // The native parent integration holds binding/worker locks when calling
    // this method. Only take the library lock here, in that established order.
    markDispatched: (id, { jobId, originThreadId } = {}) => mutateCurrent(id, async (record, found) => {
      if (!record.acceptedAt) throw new LibraryError("REQUEST_NOT_ACCEPTED", "The real parent must accept this request before dispatch.");
      if (typeof jobId !== "string" || !/^[A-Za-z0-9:_-]{1,200}$/.test(jobId) || typeof originThreadId !== "string" || !UUID.test(originThreadId)) throw new LibraryError("INVALID_JOB", "Expected a native job id and a verified origin thread UUID.");
      if (record.dispatch) {
        if (record.dispatch.jobId !== jobId || record.dispatch.originThreadId !== originThreadId) throw new LibraryError("DISPATCH_CONFLICT", "This request already belongs to another native dispatch.");
        return;
      }
      const binding = await readJson2(found.root, NATIVE_BINDING_FILE2, null);
      const state = await readJson2(found.root, WORKER_JOBS_FILE, null);
      const job = state?.jobs?.[jobId];
      if (binding?.threadId !== originThreadId || !["native", "worker"].includes(binding?.deliveryMode) || !job || job.requestId !== record.id || job.event?.kind !== "comment" || job.event.data?.id !== record.commentId || job.capturedUserRevision !== record.commentRevision) throw new LibraryError("INVALID_JOB", "The native journal does not contain this accepted request and origin.");
      record.dispatch = { jobId, originThreadId, dispatchedAt: now2() };
      record.status = "queued";
    }),
    async project(id, canonicalSnapshot) {
      id = artifactId(id);
      await ready();
      if (!canonicalSnapshot || !Array.isArray(canonicalSnapshot.threads)) throw new LibraryError("INVALID_COMMENT", "Expected a canonical comment snapshot.");
      const found = await location(id);
      const lockPath = path7.join(found.root, WORKER_LOCK_FILE);
      if ((await statOrNull(lockPath))?.isSymbolicLink()) throw new LibraryError("SYMLINK_REFUSED", "The worker lock must be a real directory.");
      let worker, rawJobs = {};
      try {
        for (const file of [WORKER_FILE, WORKER_JOBS_FILE, BINDING_FILE, NATIVE_BINDING_FILE2]) await safePath(found.root, file, { mustExist: false });
        worker = await getWorkerStatus(found.root);
        rawJobs = (await readJson2(found.root, WORKER_JOBS_FILE, { jobs: {} })).jobs || {};
      } catch (error3) {
        if (error3.code === "SYMLINK_REFUSED" || error3.code === "INVALID_PATH") throw error3;
      }
      return locked(store.root, async () => {
        const records = (await all()).filter((record) => record.artifactId === id);
        const snapshot = structuredClone(canonicalSnapshot);
        for (const thread of snapshot.threads) {
          const related = records.filter((record2) => record2.commentId === thread.id);
          for (const old of related) if (old.status !== "superseded" && stateError(old, thread, found.record.kind)) {
            old.status = "superseded";
            old.supersededAt ??= now2();
            await save(old);
          }
          const record = related.findLast((record2) => !stateError(record2, thread, found.record.kind)) ?? related.at(-1);
          const legacy = ["delivered", "pending", "working", "queued", "failed"].includes(thread.agent?.status);
          if (!record && !legacy) continue;
          thread.agent = { ...thread.agent, ...record ? { sentAt: record.createdAt } : {}, nativeRequest: projection(record, thread, worker, rawJobs) };
        }
        return snapshot;
      });
    }
  };
  return api;
}
var DIRECTORY, NATIVE_BINDING_FILE2, MAX_COMMENTS_BYTES, MAX_REQUEST_BYTES, MAX_EVENT_BYTES, sha, now2, requestId, commentId, errorSummary, requestUri;
var init_edit_requests = __esm({
  "source/library/edit-requests.mjs"() {
    init_safety();
    init_content();
    init_bridge_core();
    init_worker_core();
    init_worker_client();
    DIRECTORY = "_state/edit-requests";
    NATIVE_BINDING_FILE2 = ".codex-design-native-binding.json";
    MAX_COMMENTS_BYTES = 4 * 1024 * 1024;
    MAX_REQUEST_BYTES = 512 * 1024;
    MAX_EVENT_BYTES = 256 * 1024;
    sha = (value) => createHash4("sha256").update(value).digest("hex");
    now2 = () => (/* @__PURE__ */ new Date()).toISOString();
    requestId = (value) => {
      if (typeof value !== "string" || !UUID.test(value)) throw new LibraryError("INVALID_ID", "Expected an edit request UUID.");
      return value.toLowerCase();
    };
    commentId = (value) => {
      if (typeof value !== "string" || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new LibraryError("INVALID_COMMENT", "Expected a comment id.");
      return value;
    };
    errorSummary = (error3) => ({ code: String(error3?.code || "DRAFT_FAILED").slice(0, 100), message: String(error3?.message || error3 || "The native draft could not be updated.").slice(0, 1e3) });
    requestUri = (id) => `codex-design://edit-requests/${requestId(id)}`;
  }
});

// source/scripts/edit-request-dispatch.mjs
import { fileURLToPath } from "node:url";
var executingModule;
var init_edit_request_dispatch = __esm({
  "source/scripts/edit-request-dispatch.mjs"() {
    init_library();
    init_edit_requests();
    init_safety();
    init_artifact_delivery();
    init_bridge_core();
    init_worker_core();
    executingModule = fileURLToPath(import.meta.url);
  }
});

// source/scripts/artifact-command.mjs
async function verifyEditorInstance(state, root, kind) {
  const fail4 = (reason) => Object.assign(new BridgeError("EDITOR_IDENTITY_UNVERIFIED", "The recorded PID was not confirmed by this plugin editor’s live session endpoint. No process was stopped and its records were preserved; inspect the existing editor/process manually."), reason ? { reason } : {});
  if (!state || !alive(state.pid) || state.kind !== kind || !samePath(state.root, root)) throw fail4();
  let url;
  try {
    const base = new URL(state.url);
    if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith("/")) throw fail4();
    url = new URL("__codex/editor-session", base);
  } catch {
    throw fail4();
  }
  let response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2e3), headers: { Accept: "application/json" } });
  } catch (error3) {
    throw fail4(refusedConnection(error3) ? "SESSION_CONNECTION_REFUSED" : void 0);
  }
  try {
    if (!response.ok) throw fail4();
    const session = await response.json();
    if (session.pid !== state.pid || session.kind !== kind || !samePath(session.root, root) || !alive(state.pid)) throw fail4();
    return session;
  } catch {
    throw fail4();
  }
}
function refusedConnection(error3, seen = /* @__PURE__ */ new Set()) {
  if (!error3 || typeof error3 !== "object" || seen.has(error3)) return false;
  const next = new Set(seen).add(error3);
  if (Array.isArray(error3.errors)) return error3.errors.length > 0 && error3.errors.every((item) => refusedConnection(item, next)) && (error3.cause === void 0 || refusedConnection(error3.cause, next));
  if (error3.code === "ECONNREFUSED") return error3.cause === void 0 || refusedConnection(error3.cause, next);
  return refusedConnection(error3.cause, next);
}
var init_artifact_command = __esm({
  "source/scripts/artifact-command.mjs"() {
    init_bridge_core();
    init_worker_client();
    init_design_system_search();
    init_library();
    init_safety();
    init_worker_core();
    init_artifact_delivery();
    init_edit_request_dispatch();
  }
});

// source/scripts/library-preview.mjs
init_library();
init_safety();
import fs9 from "node:fs";
import path13 from "node:path";
import { spawn as spawn3 } from "node:child_process";
import { fileURLToPath as fileURLToPath4, pathToFileURL } from "node:url";

// source/server/http-preview.mjs
init_library();
init_safety();
init_worker_client();
import http from "node:http";
import fs8 from "node:fs/promises";
import path12 from "node:path";
import { randomBytes, randomUUID as randomUUID8 } from "node:crypto";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// source/server/service.mjs
init_bridge_core();
init_artifact_command();
import { spawn as spawn2 } from "node:child_process";
import { createHash as createHash9 } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path11 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// source/library/thumbnail.mjs
init_safety();
import path8 from "node:path";
import { createHash as createHash5 } from "node:crypto";
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
    for (let [attribute2, value] of attrs) {
      if (attribute2.startsWith("sc-camel-")) attribute2 = attribute2.slice(9);
      if (attribute2.startsWith("on") || attribute2.startsWith("data-") || ["nonce", "srcset", "formaction", "action", "autofocus", "contenteditable"].includes(attribute2)) continue;
      if (["src", "href", "xlink:href", "poster", "background"].includes(attribute2)) {
        if (name === "use" && /^#[A-Za-z_][\w:.-]*$/.test(value)) rendered.push('href="' + escape2(value) + '"');
        else if (["img", "image"].includes(name)) {
          const uri = await context.asset(value, base, "image");
          if (uri) rendered.push((name === "image" ? "href" : "src") + '="' + escape2(uri) + '"');
        }
        continue;
      }
      if (!ATTRS.has(attribute2) || value.length > 65536) continue;
      if (name === "x-shape" && attribute2 === "style") continue;
      if (attribute2 === "style") value = await sanitizedCss(value, base, context);
      else if (/url\s*\(/i.test(value)) value = await sanitizedCss(value, base, context);
      if (attribute2 === "type" && name === "input" && !["text", "email", "number", "date", "range", "checkbox", "radio", "button"].includes(value)) value = "text";
      rendered.push((ATTR_NAMES[attribute2] || attribute2) + '="' + escape2(value) + '"');
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
function hasRootBackground(html) {
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const css = style[1];
    let selectorStart = 0;
    for (let cursor = 0; cursor < css.length; cursor++) {
      if (css[cursor] === "}") {
        selectorStart = cursor + 1;
        continue;
      }
      if (css[cursor] !== "{") continue;
      const close = css.indexOf("}", cursor + 1), nested = css.indexOf("{", cursor + 1);
      if (close < 0) break;
      if (nested >= 0 && nested < close) {
        selectorStart = cursor + 1;
        continue;
      }
      const selectors = css.slice(selectorStart, cursor), declarations = css.slice(cursor + 1, close);
      cursor = close;
      selectorStart = close + 1;
      if (!/(?:^|;)\s*background(?:-color)?\s*:/i.test(declarations)) continue;
      if (selectors.split(",").some((selector) => /(?:^|[\s>+~])(?:html|body|:root)(?:\.[\w-]+|#[\w-]+|\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)*$/i.test(selector.trim()))) return true;
    }
  }
  return false;
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
    for (const [key, attribute2] of Object.entries({ fontSize: "font-size", lineHeight: "line-height", fontWeight: "font-weight", letterSpacing: "letter-spacing", textTransform: "text-transform" })) if (safeValue(style[key])) properties.push(attribute2 + ":" + style[key]);
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
  const hash = createHash5("sha256");
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
      const relative = path8.posix.normalize(path8.posix.join(path8.posix.dirname(base), value.split(/[?#]/)[0]));
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
      const info = files.get(file), mime2 = info.contentType || "application/octet-stream";
      if (!(mime2.startsWith("image/") || purpose === "style" && mime2.startsWith("font/")) || info.bytes > limits.maxAssetBytes || total + info.bytes > limits.maxTotalBytes) {
        context.note("An unsupported or large material was omitted.");
        return null;
      }
      visiting.add(file);
      try {
        const resource = await store.readFile(id, file, { encoding: "base64" });
        total += resource.bytes;
        hash.update(file + "\0" + resource.data);
        let data = resource.data;
        if (mime2 === "image/svg+xml") data = Buffer.from(await sanitize(Buffer.from(data, "base64").toString("utf8"), file, context)).toString("base64");
        const uri = "data:" + mime2 + ";base64," + data;
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
  const canvasBackground = hasRootBackground(clean) ? "transparent" : "#fff";
  const srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escape2(csp) + '"><meta name="referrer" content="no-referrer"><title>' + escape2(record.title) + "</title><style>html,body{background:transparent}" + extraCss + normalizer + '</style></head><body><svg class="codex-cover-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="xMidYMid meet"><foreignObject width="' + width + '" height="' + height + '"><div xmlns="http://www.w3.org/1999/xhtml" class="codex-cover-surface" style="width:' + width + "px;height:" + height + "px;overflow:hidden;background:" + canvasBackground + '">' + clean + "</div></foreignObject></svg><style>html,body{margin:0!important;width:100%;height:100%;overflow:hidden!important}body>.codex-cover-svg{display:block;width:100vw;height:100vh}.codex-cover-surface *{animation:none!important;transition:none!important;pointer-events:none!important}</style></body></html>";
  if (Buffer.byteLength(srcdoc) > limits.maxDocumentBytes) throw new LibraryError("THUMBNAIL_LIMIT", "The static cover exceeds its output limit.");
  return { artifactId: record.id, id: record.id, kind: record.kind, title: record.title, revision, cacheKey: record.id + ":" + revision, srcdoc, previewWidth: width, previewHeight: height, fidelity, sourceFile, notes };
}

// source/server/service.mjs
init_edit_requests();

// source/library/export-store.mjs
init_safety();
import fs6 from "node:fs/promises";
import { constants as constants2 } from "node:fs";
import os2 from "node:os";
import path9 from "node:path";
import { createHash as createHash6, randomUUID as randomUUID5 } from "node:crypto";
var MAX_BYTES = 128 * 1024 * 1024;
var PAGE_SIZE = 200;
var MAX_ENTRIES = 2e4;
var TOKEN_MS = 30 * 60 * 1e3;
var preferenceFile = "_state/export-location.json";
var sha2 = (value) => createHash6("sha256").update(value).digest("hex");
var fail = (code, message) => new LibraryError(code, message);
var samePath2 = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
var fingerprint = (stat) => ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs", "birthtimeNs"].map((key) => String(stat[key])).join(":");
function absoluteDirectory(value) {
  if (typeof value !== "string" || !value || value.length > 32e3 || /[\u0000-\u001f\u007f]/.test(value) || !path9.isAbsolute(value)) {
    throw fail("EXPORT_INVALID_DIRECTORY", "Choose an existing absolute folder path.");
  }
  return path9.resolve(value);
}
function exportInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.requestId !== "string" || !UUID.test(input.requestId)) {
    throw fail("EXPORT_INVALID_REQUEST", "A unique export request ID is required.");
  }
  const filename = input.filename;
  if (typeof filename !== "string" || !filename || filename.length > 240 || process.platform !== "win32" && Buffer.byteLength(filename) > 240 || filename === "." || filename === ".." || /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(filename) || filename.trim() !== filename || /[. ]$/.test(filename) || /^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(filename)) {
    throw fail("EXPORT_INVALID_FILENAME", "Use a safe filename without path separators or reserved characters.");
  }
  if (typeof input.mimeType !== "string" || input.mimeType.length > 200 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[a-z0-9= -]+)?$/i.test(input.mimeType)) {
    throw fail("EXPORT_INVALID_CONTENT", "The export file type is invalid.");
  }
  const hasText = Object.hasOwn(input, "text"), hasBase64 = Object.hasOwn(input, "base64");
  if (hasText === hasBase64) throw fail("EXPORT_INVALID_CONTENT", "Provide exactly one text or base64 export payload.");
  let bytes;
  if (hasText) {
    if (typeof input.text !== "string" || input.text.length > MAX_BYTES || Buffer.byteLength(input.text) > MAX_BYTES) {
      throw fail("EXPORT_LIMIT_EXCEEDED", "The export exceeds the 128 MiB save limit.");
    }
    bytes = Buffer.from(input.text, "utf8");
  } else {
    if (typeof input.base64 !== "string" || input.base64.length > Math.ceil(MAX_BYTES / 3) * 4 || input.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(input.base64)) {
      throw fail("EXPORT_INVALID_CONTENT", "The export payload is not bounded, valid base64.");
    }
    const padding = input.base64.endsWith("==") ? 2 : input.base64.endsWith("=") ? 1 : 0;
    const firstPadding = input.base64.indexOf("=");
    if (firstPadding !== -1 && firstPadding !== input.base64.length - padding) throw fail("EXPORT_INVALID_CONTENT", "The export padding is invalid.");
    bytes = Buffer.from(input.base64, "base64");
    if (bytes.length > MAX_BYTES || bytes.toString("base64") !== input.base64) throw fail("EXPORT_INVALID_CONTENT", "The export payload is not canonical base64.");
  }
  if (input.overwriteToken !== void 0 && (typeof input.overwriteToken !== "string" || !UUID.test(input.overwriteToken))) {
    throw fail("EXPORT_INVALID_CONFIRMATION", "An explicit overwrite confirmation token is required.");
  }
  return {
    requestId: input.requestId.toLowerCase(),
    filename,
    mimeType: input.mimeType,
    bytes,
    directory: absoluteDirectory(input.directory),
    overwriteToken: input.overwriteToken
  };
}
function createExportStore({ store, homeDirectory = os2.homedir(), fsImpl = fs6, now: now3 = Date.now, beforeCommit } = {}) {
  if (!store || typeof store.initialize !== "function" || typeof store._checkRoot !== "function") throw new TypeError("A LibraryStore is required.");
  const io = fsImpl;
  const ready = async () => {
    await store.initialize();
    await store._checkRoot();
  };
  const statOrNull2 = async (file) => {
    try {
      return await io.lstat(file, { bigint: true });
    } catch (error3) {
      if (error3.code === "ENOENT") return null;
      throw error3;
    }
  };
  const directoryInfo = async (input) => {
    const requested = absoluteDirectory(input), canonical = await io.realpath(requested);
    const stat = await io.lstat(canonical, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("EXPORT_INVALID_DIRECTORY", "The selected location is not a real folder.");
    return { requested, canonical, identity: `${stat.dev}:${stat.ino}`, stat };
  };
  const assertDirectory = async (info) => {
    const current = await directoryInfo(info.requested);
    if (!samePath2(current.canonical, info.canonical) || current.identity !== info.identity) {
      throw fail("EXPORT_DIRECTORY_CHANGED", "The selected folder moved or changed. Choose it again before saving.");
    }
  };
  const targetInfo = async (target) => {
    const stat = await statOrNull2(target);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) throw fail("EXPORT_UNSAFE_TARGET", "The destination must be a regular file, not a link or folder.");
    return { fingerprint: fingerprint(stat), size: Number(stat.size), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString() };
  };
  const matchesPayload = async (target, request, contentHash) => {
    const info = await targetInfo(target);
    if (!info || info.size !== request.bytes.length) return false;
    const handle = await io.open(target, constants2.O_RDONLY | (constants2.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || fingerprint(opened) !== info.fingerprint) return false;
      const hash = createHash6("sha256").update(request.mimeType + "\0");
      const buffer = Buffer.alloc(64 * 1024);
      for (let position = 0; position < info.size; ) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
        if (!bytesRead) return false;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return hash.digest("hex") === contentHash && fingerprint(await handle.stat({ bigint: true })) === info.fingerprint;
    } finally {
      await handle.close();
    }
  };
  const receiptPath = (id) => `_state/export-receipts/${id}.json`;
  const collision = async (request, target, contentHash, existing) => {
    const receipt = {
      version: 1,
      requestId: request.requestId,
      status: "confirmation",
      target,
      contentHash,
      existingFingerprint: existing.fingerprint,
      overwriteToken: randomUUID5(),
      expiresAt: now3() + TOKEN_MS
    };
    await atomicJson2(store.root, receiptPath(request.requestId), receipt);
    return {
      saved: false,
      exists: true,
      path: target,
      overwriteToken: receipt.overwriteToken,
      existing: { size: existing.size, modifiedAt: existing.modifiedAt }
    };
  };
  const api = {
    async locations() {
      await ready();
      const candidates = [
        ["home", "Home", homeDirectory],
        ["desktop", "Desktop", path9.join(homeDirectory, "Desktop")],
        ["documents", "Documents", path9.join(homeDirectory, "Documents")],
        ["downloads", "Downloads", path9.join(homeDirectory, "Downloads")]
      ];
      const locations = [];
      for (const [id, label, candidate] of candidates) {
        try {
          const folder = await directoryInfo(candidate);
          if (!locations.some((item) => samePath2(item.path, folder.canonical))) locations.push({ id, label, path: folder.canonical });
        } catch (error3) {
          if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EXPORT_INVALID_DIRECTORY"].includes(error3.code)) throw error3;
        }
      }
      let defaultDirectory = locations.find((item) => item.id === "downloads")?.path ?? locations[0]?.path ?? null;
      let preference;
      try {
        preference = await readJson2(store.root, preferenceFile, null);
      } catch (error3) {
        if (error3.code !== "INVALID_STATE") throw error3;
      }
      if (preference?.version === 1 && typeof preference.directory === "string") {
        try {
          defaultDirectory = (await directoryInfo(preference.directory)).canonical;
        } catch {
        }
      }
      return { locations, defaultDirectory };
    },
    async listDirectory({ path: selected, cursor } = {}) {
      await ready();
      const folder = await directoryInfo(selected), key = sha2(folder.canonical), revision = `${folder.stat.ino}:${folder.stat.mtimeNs}`;
      let offset = 0;
      if (cursor !== void 0) {
        let value;
        try {
          if (typeof cursor !== "string" || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("cursor");
          value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        } catch {
          throw fail("EXPORT_INVALID_CURSOR", "The folder page cursor is invalid.");
        }
        if (value.key !== key || value.revision !== revision || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > MAX_ENTRIES) {
          throw fail("EXPORT_DIRECTORY_CHANGED", "The folder changed. Refresh it before continuing.");
        }
        offset = value.offset;
      }
      const entries = [];
      let count = 0;
      const directory = await io.opendir(folder.canonical);
      for await (const entry2 of directory) {
        if (++count > MAX_ENTRIES) throw fail("EXPORT_DIRECTORY_TOO_LARGE", "This folder contains too many items. Enter a more specific folder path.");
        if (entry2.isDirectory() && !entry2.isSymbolicLink()) entries.push({ name: entry2.name, path: path9.join(folder.canonical, entry2.name) });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
      await assertDirectory(folder);
      if ((await directoryInfo(folder.requested)).stat.mtimeNs !== folder.stat.mtimeNs) throw fail("EXPORT_DIRECTORY_CHANGED", "The folder changed. Refresh it before continuing.");
      const parentPath = path9.dirname(folder.canonical);
      return {
        path: folder.canonical,
        parent: parentPath === folder.canonical ? null : parentPath,
        entries: entries.slice(offset, offset + PAGE_SIZE),
        ...offset + PAGE_SIZE < entries.length ? { nextCursor: Buffer.from(JSON.stringify({ key, revision, offset: offset + PAGE_SIZE })).toString("base64url") } : {}
      };
    },
    async save(input) {
      const request = exportInput(input);
      await ready();
      return locked(store.root, async () => {
        const folder = await directoryInfo(request.directory), target = path9.join(folder.canonical, request.filename);
        const contentHash = createHash6("sha256").update(request.mimeType + "\0").update(request.bytes).digest("hex");
        const previous = await readJson2(store.root, receiptPath(request.requestId), null);
        if (previous && (previous.version !== 1 || previous.requestId !== request.requestId || !["confirmation", "committing", "saved"].includes(previous.status) || typeof previous.target !== "string" || !path9.isAbsolute(previous.target) || !/^[a-f0-9]{64}$/.test(previous.contentHash ?? "") || previous.status === "confirmation" && (!UUID.test(previous.overwriteToken ?? "") || !Number.isSafeInteger(previous.expiresAt) || typeof previous.existingFingerprint !== "string" || previous.existingFingerprint.length > 1e3))) {
          throw fail("EXPORT_INVALID_STATE", "The previous export receipt cannot be verified.");
        }
        if (previous && (!samePath2(previous.target, target) || previous.contentHash !== contentHash)) {
          throw fail("EXPORT_REQUEST_CONFLICT", "This export ID already belongs to different content or a different destination.");
        }
        if (previous?.status === "saved") {
          if (previous.result?.saved !== true || previous.result.path !== target || previous.result.filename !== request.filename || previous.result.bytes !== request.bytes.length) {
            throw fail("EXPORT_INVALID_STATE", "The saved export receipt cannot be verified.");
          }
          if (!await matchesPayload(target, request, contentHash)) throw fail("EXPORT_RESULT_CHANGED", "This export was saved earlier, but the destination has since changed. Start a new export before choosing whether to replace it.");
          return { ...previous.result, duplicate: true };
        }
        if (previous?.status === "committing" && await matchesPayload(target, request, contentHash)) {
          const result = { saved: true, path: target, filename: request.filename, bytes: request.bytes.length };
          await atomicJson2(store.root, receiptPath(request.requestId), { ...previous, status: "saved", result, savedAt: new Date(now3()).toISOString() });
          await atomicJson2(store.root, preferenceFile, { version: 1, directory: folder.canonical }).catch(() => {
          });
          return { ...result, duplicate: true };
        }
        let existing = await targetInfo(target);
        if (existing) {
          if (!request.overwriteToken || previous?.status !== "confirmation" || previous.overwriteToken !== request.overwriteToken || previous.expiresAt < now3() || previous.existingFingerprint !== existing.fingerprint) {
            return collision(request, target, contentHash, existing);
          }
        }
        const temporary = path9.join(folder.canonical, `.codex-export-${randomUUID5()}.tmp`);
        let handle;
        try {
          handle = await io.open(temporary, constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | (constants2.O_NOFOLLOW || 0), 384);
          await handle.writeFile(request.bytes);
          await handle.sync();
          await handle.close();
          handle = null;
          if (beforeCommit) await beforeCommit({ path: target, temporary, replacing: Boolean(existing) });
          await assertDirectory(folder);
          const latest = await targetInfo(target);
          if (existing && (!latest || latest.fingerprint !== existing.fingerprint)) {
            if (latest) return collision(request, target, contentHash, latest);
            throw fail("EXPORT_TARGET_CHANGED", "The file changed before replacement. Choose the destination again.");
          }
          if (!existing && latest) return collision(request, target, contentHash, latest);
          await atomicJson2(store.root, receiptPath(request.requestId), { version: 1, requestId: request.requestId, status: "committing", target, contentHash });
          if (existing) await io.rename(temporary, target);
          else {
            try {
              await io.link(temporary, target);
            } catch (error3) {
              if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(error3.code)) await io.copyFile(temporary, target, constants2.COPYFILE_EXCL);
              else if (error3.code === "EEXIST") {
                const appeared = await targetInfo(target);
                if (appeared) return collision(request, target, contentHash, appeared);
                throw error3;
              } else throw error3;
            }
          }
          const result = { saved: true, path: target, filename: request.filename, bytes: request.bytes.length };
          await atomicJson2(store.root, receiptPath(request.requestId), { version: 1, requestId: request.requestId, status: "saved", target, contentHash, result, savedAt: new Date(now3()).toISOString() });
          await atomicJson2(store.root, preferenceFile, { version: 1, directory: folder.canonical }).catch(() => {
          });
          return result;
        } finally {
          await handle?.close().catch(() => {
          });
          try {
            await assertDirectory(folder);
            await io.unlink(temporary).catch((error3) => {
              if (error3.code !== "ENOENT") throw error3;
            });
          } catch {
          }
        }
      });
    }
  };
  return api;
}

// source/server/service.mjs
init_safety();

// source/server/editor-transport.mjs
import { randomUUID as randomUUID6 } from "node:crypto";

// source/scripts/base64.mjs
function isValidBase64(value) {
  if (typeof value !== "string" || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.indexOf("=");
  return padding < 0 || value.length - padding <= 2 && /^={1,2}$/.test(value.slice(padding));
}

// source/server/editor-transport.mjs
var fail2 = (code, message) => Object.assign(new Error(message), { code });
var METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
var REQUEST_HEADERS = /* @__PURE__ */ new Set(["content-type", "accept", "if-match", "if-none-match", "last-event-id", "x-filename", "x-deck-client"]);
var RESPONSE_HEADERS = ["content-type", "content-disposition", "etag", "last-modified", "cache-control", "content-security-policy", "referrer-policy", "x-content-type-options"];
var MAX_BODY = 32 * 1024 * 1024;
var MAX_RESPONSE = 64 * 1024 * 1024;
function validateEditorRequest(request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw fail2("INVALID_EDITOR_REQUEST", "An editor request object is required.");
  const method = String(request.method || "GET").toUpperCase();
  if (!METHODS.has(method)) throw fail2("INVALID_EDITOR_REQUEST", "Unsupported editor request method.");
  const headers = new Headers();
  if (request.headers && (typeof request.headers !== "object" || Array.isArray(request.headers))) throw fail2("INVALID_EDITOR_REQUEST", "Invalid editor request headers.");
  for (const [name, value] of Object.entries(request.headers || {})) {
    if (!REQUEST_HEADERS.has(name.toLowerCase()) || typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) throw fail2("INVALID_EDITOR_REQUEST", "Unsupported editor request header.");
    if (name.toLowerCase() === "x-deck-client" && !/^[A-Za-z0-9_-]{8,64}$/.test(value)) throw fail2("INVALID_EDITOR_REQUEST", "Invalid editor client identity.");
    headers.set(name, value);
  }
  let body;
  if (request.body !== void 0) {
    if (typeof request.body !== "string" || request.body.length > Math.ceil(MAX_BODY / 3) * 4 || !isValidBase64(request.body)) throw fail2("INVALID_EDITOR_REQUEST", "Invalid editor request body.");
    body = Buffer.from(request.body, "base64");
    if (body.length > MAX_BODY || method === "GET" || method === "HEAD") throw fail2("INVALID_EDITOR_REQUEST", "Invalid editor request body.");
  }
  return { method, headers, body };
}
function editorRequestUrl(base, relative) {
  const root = new URL(base);
  if (root.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(root.hostname) || root.username || root.password || !root.pathname.endsWith("/")) throw fail2("INVALID_EDITOR_URL", "An authenticated local editor session is required.");
  if (typeof relative !== "string" || relative.length > 4096 || /[\\\u0000-\u0020]/.test(relative) || relative.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(relative)) throw fail2("INVALID_EDITOR_REQUEST", "Only a request inside this artwork editor is accepted.");
  const path14 = relative.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(path14);
  } catch {
    throw fail2("INVALID_EDITOR_REQUEST", "Invalid editor request encoding.");
  }
  if (decoded.includes("\\") || /[\u0000-\u001f]/.test(decoded) || decoded.split("/").some((part) => part === "." || part === "..") || /%2f|%5c|%2e/i.test(decoded)) throw fail2("INVALID_EDITOR_REQUEST", "Editor requests cannot escape their artwork session.");
  const target = new URL(relative, root);
  if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname) || target.hash) throw fail2("INVALID_EDITOR_REQUEST", "Editor requests cannot escape their artwork session.");
  if (decoded.split("/").filter(Boolean)[0] === "__share") throw fail2("EDITOR_NETWORK_SHARING_UNAVAILABLE", "Network sharing and raw folder archives are not available through this native editor.");
  return target;
}
async function limitedBody(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw fail2("EDITOR_RESPONSE_TOO_LARGE", "The editor response exceeds the transfer limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
function previewReadUrl(editor, url, method) {
  const root = new URL(editor.url);
  const relative = url.pathname.slice(root.pathname.length);
  const preview = /^v\/([1-9][0-9]{0,8})\/(.*)$/.exec(relative);
  if (!preview) return url;
  if (!["GET", "HEAD"].includes(method)) throw fail2("EDITOR_PREVIEW_READ_ONLY", "Earlier versions are read-only.");
  if (editor.kind !== "dashboard") return url;
  const translated = editorRequestUrl(root.href, preview[2] + url.search);
  translated.searchParams.set("at", preview[1]);
  return translated;
}
function createEditorTransport({ editorFor, fetcher = fetch, idleMs = 12e4 } = {}) {
  const streams = /* @__PURE__ */ new Map();
  const get = async (id, relative) => {
    const editor = await editorFor(id);
    return { editor, url: editorRequestUrl(editor.url, relative) };
  };
  const close = (stream) => {
    stream.closed = true;
    clearTimeout(stream.expiry);
    stream.abort.abort();
    streams.delete(stream.id);
  };
  const touch = (stream) => {
    clearTimeout(stream.expiry);
    stream.expiry = setTimeout(() => close(stream), idleMs);
    stream.expiry.unref?.();
  };
  const pump = async (stream) => {
    let buffer = "";
    const decoder = new TextDecoder();
    const record = (block) => {
      const lines = block.split("\n");
      let event = "message", data = [], id;
      for (const line of lines) {
        if (!line || line.startsWith(":")) continue;
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
      if (!data.length) return;
      stream.events.push({ cursor: ++stream.cursor, event, data: data.join("\n"), ...id === void 0 ? {} : { id } });
      if (stream.events.length > 128) stream.events.shift();
      for (const wake of stream.waiters) wake();
      stream.waiters.clear();
    };
    try {
      for await (const chunk of stream.response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        if (buffer.length > 4 * 1024 * 1024) throw fail2("EDITOR_EVENT_TOO_LARGE", "The editor event exceeds the transfer limit.");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          record(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    } catch (error3) {
      if (!stream.closed) stream.error = { code: error3.code || "EDITOR_EVENTS_FAILED", message: error3.message };
    } finally {
      stream.ended = true;
      for (const wake of stream.waiters) wake();
      stream.waiters.clear();
    }
  };
  return {
    async request(id, request = {}) {
      const { url: granted, editor } = await get(id, request.path);
      const { method, headers, body } = validateEditorRequest(request);
      const url = previewReadUrl(editor, granted, method);
      headers.set("origin", url.origin);
      const response = await fetcher(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(3e4) });
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel();
        throw fail2("INVALID_EDITOR_REQUEST", "Use the editor event subscription for a live stream.");
      }
      const bytes = await limitedBody(response, MAX_RESPONSE);
      return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(RESPONSE_HEADERS.flatMap((name) => response.headers.has(name) ? [[name, response.headers.get(name)]] : [])), body: bytes.toString("base64") };
    },
    async openEvents(id, path14) {
      const { url: granted, editor } = await get(id, path14);
      const url = previewReadUrl(editor, granted, "GET");
      if (!/(?:^|\/)events$/.test(url.pathname)) throw fail2("INVALID_EDITOR_REQUEST", "Only editor event endpoints can be subscribed.");
      const abort = new AbortController();
      let response;
      const startup = setTimeout(() => abort.abort(), 1e4);
      try {
        response = await fetcher(url, { headers: { accept: "text/event-stream", origin: url.origin }, redirect: "error", signal: abort.signal });
      } finally {
        clearTimeout(startup);
      }
      if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
        abort.abort();
        throw fail2("EDITOR_EVENTS_FAILED", "The local editor did not open its event stream.");
      }
      const stream = { id: randomUUID6(), artifactId: id, response, abort, events: [], cursor: 0, waiters: /* @__PURE__ */ new Set(), closed: false, ended: false };
      streams.set(stream.id, stream);
      touch(stream);
      void pump(stream);
      return { subscriptionId: stream.id, cursor: 0 };
    },
    async pollEvents(id, subscriptionId, cursor = 0) {
      const stream = streams.get(subscriptionId);
      if (!stream || stream.artifactId !== id || stream.closed) throw fail2("EDITOR_SUBSCRIPTION_UNAVAILABLE", "The editor event subscription has closed.");
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stream.cursor) throw fail2("INVALID_EDITOR_REQUEST", "Invalid editor event cursor.");
      touch(stream);
      if (!stream.ended && stream.cursor <= cursor) await new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          stream.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, 1e3);
        stream.waiters.add(wake);
      });
      return { events: stream.events.filter((event) => event.cursor > cursor), cursor: stream.cursor, ended: stream.ended, ...stream.error ? { error: stream.error } : {} };
    },
    async closeEvents(id, subscriptionId) {
      const stream = streams.get(subscriptionId);
      if (stream && stream.artifactId === id) close(stream);
      return { closed: true };
    },
    dispose() {
      for (const stream of streams.values()) close(stream);
    }
  };
}

// source/scripts/native-preview.mjs
function installNativePreviews({ target, baseUrl, rpc, flush } = {}) {
  target ??= window;
  const document2 = target.document;
  if (!document2?.body || typeof rpc !== "function") throw new TypeError("A native preview needs its editor document and scoped transport.");
  if (target.__CODEX_DESIGN_EDITOR_TRANSPORT__?.readOnly === true) return { open: async () => false, close() {
  }, updateHostContext() {
  }, dispose() {
  } };
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.hostname !== "codex-design.invalid" || base.username || base.password || base.search || base.hash || !/^\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/i.test(base.pathname)) throw new TypeError("A preview needs its artwork virtual root.");
  const originalOpen = target.open;
  const LIMIT = 24 * 1024 * 1024, PASSIVE_LIMIT = 2 * 1024 * 1024;
  const MAX_PENDING = 32, MAX_CACHE = 128, MAX_PENDING_BYTES = 48 * 1024 * 1024, MAX_CACHE_BYTES = 64 * 1024 * 1024;
  const UUID3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/;
  const PASSIVE_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  let disposed = false, current;
  let hostContext = {};
  const failure3 = (code, message) => Object.assign(new Error(message), { code });
  const detail2 = (error3) => ({ code: typeof error3?.code === "string" ? error3.code.slice(0, 100) : "PREVIEW_FAILED", message: String(error3?.message || error3).slice(0, 2e3) });
  const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
  const alive3 = (entry2) => !disposed && !entry2.closed && current === entry2;
  const classify = (value) => {
    if (typeof value !== "string" || !value || value.length > 4096 || /[\\\u0000-\u0020]/.test(value)) return { refused: true };
    let url;
    try {
      url = new URL(value, base);
    } catch {
      return { refused: true };
    }
    if (url.username || url.password) return { refused: true };
    if (url.origin !== base.origin) {
      const local = /^(?:localhost\.?|.*\.localhost\.?|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[::(?:1)?\]|\[::ffff:[^\]]+\])$/i.test(url.hostname);
      const virtual = /(?:^|\.)codex-design\.invalid\.?$/i.test(url.hostname);
      return !local && !virtual && (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") ? { external: true } : { refused: true };
    }
    if (!url.pathname.startsWith(base.pathname) || url.search || url.hash) return { refused: true };
    const relative = url.pathname.slice(base.pathname.length);
    const system = /^__ds\/([a-z0-9][a-z0-9_-]{0,63})\/$/.exec(relative);
    if (system) return { path: relative, kind: "system", title: "Design system reference" };
    const version = /^v\/(\d{1,9})\/$/.exec(relative);
    if (version && Number(version[1]) > 0) return { path: `v/${Number(version[1])}/`, kind: "history", version: Number(version[1]), title: `Version ${Number(version[1])} - Read only` };
    return { refused: true };
  };
  const send = (entry2, message) => {
    if (alive3(entry2)) entry2.frame?.contentWindow?.postMessage({ ...message, channel: entry2.channel }, "*");
  };
  const closeSubscriptions = (entry2) => {
    for (const id of entry2.subscriptions.keys()) void Promise.resolve().then(() => rpc("editor.events.close", { subscriptionId: id })).catch(() => {
    });
    entry2.subscriptions.clear();
  };
  const close = (restoreFocus = true) => {
    const entry2 = current;
    if (!entry2) return;
    entry2.closed = true;
    current = void 0;
    clearTimeout(entry2.startup);
    closeSubscriptions(entry2);
    entry2.requests.clear();
    entry2.cacheBytes = 0;
    entry2.overlay.remove();
    for (const url of entry2.urls) target.URL.revokeObjectURL(url);
    entry2.urls.clear();
    if (restoreFocus && !disposed && entry2.focus?.isConnected !== false) {
      try {
        entry2.focus?.focus?.({ preventScroll: true });
      } catch {
      }
    }
  };
  const create = (title) => {
    close(false);
    const overlay = document2.createElement("section"), header = document2.createElement("div"), heading = document2.createElement("strong");
    const button = document2.createElement("button"), status = document2.createElement("p"), content = document2.createElement("div");
    overlay.setAttribute("data-codex-native-preview", "");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", title);
    overlay.style.cssText = "position:fixed;inset:12px;z-index:2147483640;display:flex;flex-direction:column;overflow:hidden;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:12px;background:Canvas;color:CanvasText;font:inherit;box-shadow:0 12px 40px #0004";
    header.style.cssText = "display:flex;align-items:center;gap:16px;min-height:48px;padding:8px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent);flex:none";
    heading.textContent = title;
    heading.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px";
    button.type = "button";
    button.textContent = "Back to current";
    button.setAttribute("aria-label", "Close read-only preview");
    button.style.cssText = "font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:7px;padding:6px 10px;cursor:pointer";
    status.textContent = "Opening read-only preview...";
    status.setAttribute("role", "status");
    status.style.cssText = "margin:12px 16px;font-size:13px;overflow-wrap:anywhere";
    content.style.cssText = "flex:1;min-height:0;display:flex";
    header.append(heading, button);
    overlay.append(header, status, content);
    document2.body.append(overlay);
    const entry2 = {
      overlay,
      content,
      status,
      button,
      closed: false,
      focus: document2.activeElement,
      subscriptions: /* @__PURE__ */ new Map(),
      pendingStreams: 0,
      requests: /* @__PURE__ */ new Map(),
      pending: 0,
      pendingBytes: 0,
      cacheBytes: 0,
      urls: /* @__PURE__ */ new Set()
    };
    current = entry2;
    button.addEventListener("click", () => {
      if (alive3(entry2)) close();
    });
    button.focus?.({ preventScroll: true });
    return entry2;
  };
  const showError = (entry2, error3) => {
    if (!alive3(entry2)) return;
    clearTimeout(entry2.startup);
    entry2.status.textContent = detail2(error3).message;
    entry2.status.setAttribute("role", "alert");
    entry2.status.hidden = false;
  };
  const frame = (entry2, sandbox) => {
    const child = document2.createElement("iframe");
    child.title = entry2.title || "Read-only preview";
    child.setAttribute("sandbox", sandbox);
    child.setAttribute("referrerpolicy", "no-referrer");
    child.style.cssText = "display:block;border:0;flex:1;min-width:0;width:100%;height:100%;background:transparent";
    entry2.frame = child;
    entry2.content.append(child);
    return child;
  };
  const passiveHtml = (html) => {
    const template = document2.createElement("template");
    if (!template.content?.querySelectorAll) throw failure3("PREVIEW_UNAVAILABLE", "An inert reference parser is unavailable.");
    template.innerHTML = html;
    const content = template.content;
    for (const node of content.querySelectorAll("script,noscript,base,meta,link,iframe,object,embed,form,input,button,textarea,select,video,audio,source,track,template,foreignObject,animate,set")) node.remove();
    for (const node of content.querySelectorAll("*")) {
      for (const attribute2 of [...node.attributes]) {
        const name = attribute2.name.toLowerCase(), value = attribute2.value;
        if (name.startsWith("on") || ["target", "download", "ping", "action", "formaction", "srcdoc", "xlink:href"].includes(name) || name === "href" && !/^#[A-Za-z0-9_:.\-]{1,128}$/.test(value) || name === "src" && !(node.localName === "img" && /^data:image\/(?:png|gif|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(value))) node.removeAttribute(attribute2.name);
      }
      if (node.localName === "a" && !node.hasAttribute("href")) {
        node.setAttribute("aria-disabled", "true");
        node.setAttribute("title", "Links are disabled in this read-only reference.");
      }
    }
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + PASSIVE_CSP + '"><meta name="referrer" content="no-referrer"></head><body>' + template.innerHTML + "</body></html>";
  };
  function loadSnapshotDocument(channel) {
    const document3 = window.document;
    let accepted = false, editor, errors = 0;
    const outgoing = /* @__PURE__ */ new Set(["codex-design:editor-request", "codex-design:editor-transport-ready", "codex-design:editor-app-ready", "codex-design:editor-diagnostic", "codex-design:preview-close"]);
    const incoming = /* @__PURE__ */ new Set(["codex-design:editor-response", "codex-design:host-context-changed", "codex-design:comment-viewport-changed"]);
    const diagnostic = (error3) => {
      if (errors >= 4) return;
      const message = typeof error3 === "string" ? error3 : typeof error3?.message === "string" ? error3.message : "";
      if (!message) return;
      errors++;
      window.parent.postMessage({ type: "codex-design:editor-diagnostic", channel, message: "Historical preview loader: " + message.slice(0, 1e3) }, "*");
    };
    window.addEventListener("error", (event) => diagnostic(event.message), true);
    window.addEventListener("unhandledrejection", (event) => diagnostic(event.reason));
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.channel !== channel) return;
      try {
        if (event.source === window.parent) {
          if (!accepted && message.type === "codex-design:editor-document" && typeof message.html === "string" && message.html.length <= 24 * 1024 * 1024) {
            accepted = true;
            editor = document3.createElement("iframe");
            editor.setAttribute("sandbox", "allow-scripts allow-same-origin");
            editor.setAttribute("referrerpolicy", "no-referrer");
            editor.title = "Read-only historical editor";
            editor.srcdoc = message.html;
            document3.body.append(editor);
          } else if (editor && incoming.has(message.type)) editor.contentWindow?.postMessage(message, "*");
        } else if (editor && event.source === editor.contentWindow && outgoing.has(message.type)) window.parent.postMessage(message, "*");
      } catch (error3) {
        diagnostic(error3);
      }
    });
    window.parent.postMessage({ type: "codex-design:editor-document-request", channel }, "*");
  }
  const historyPath = (entry2, value, events = false) => {
    if (typeof value !== "string" || !value || value.length > 4096 || /[\\\u0000-\u0020]/.test(value) || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw failure3("PREVIEW_READ_ONLY", "A historical preview can only read its own version.");
    const encoded = value.split(/[?#]/, 1)[0];
    let decoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      throw failure3("PREVIEW_READ_ONLY", "Invalid historical preview path.");
    }
    if (/%2f|%5c/i.test(encoded) || decoded.includes("\\") || /[\u0000-\u001f]/.test(decoded) || /%2f|%5c|%2e/i.test(decoded) || decoded.split("/").some((part) => part === "." || part === "..") || !decoded.startsWith(entry2.prefix)) throw failure3("PREVIEW_READ_ONLY", "A historical preview cannot leave its captured version.");
    const url = new URL(value, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname + entry2.prefix) || url.hash || events && !/(?:^|\/)events$/.test(decoded)) throw failure3("PREVIEW_READ_ONLY", "The historical preview endpoint is unavailable.");
    return value;
  };
  const validate = (entry2, action, payload) => {
    if (!plain(payload)) throw failure3("PREVIEW_READ_ONLY", "Invalid historical preview request.");
    if (action === "editor.request") {
      const value = payload.request;
      if (!plain(value) || Object.hasOwn(value, "body")) throw failure3("PREVIEW_READ_ONLY", "A historical preview cannot write files.");
      const method = String(value.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") throw failure3("PREVIEW_READ_ONLY", "A historical preview is read only.");
      const headers = {};
      if (value.headers !== void 0) {
        if (!plain(value.headers) || Object.keys(value.headers).length > 8) throw failure3("PREVIEW_READ_ONLY", "Invalid preview headers.");
        for (const [key2, item] of Object.entries(value.headers)) {
          if (!["accept", "content-type", "if-match", "if-none-match", "last-event-id"].includes(key2.toLowerCase()) || typeof item !== "string" || item.length > 4096 || /[\r\n]/.test(item)) throw failure3("PREVIEW_READ_ONLY", "Unsupported preview header.");
          headers[key2.toLowerCase()] = item;
        }
      }
      return { request: { path: historyPath(entry2, value.path), method, headers } };
    }
    if (action === "editor.digest") {
      const text = payload.base64;
      if (payload.algorithm !== "SHA-256" || typeof text !== "string" || text.length > 44739244 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw failure3("PREVIEW_READ_ONLY", "Only a bounded SHA-256 digest is available.");
      const bytes = target.atob(text);
      if (bytes.length > 32 * 1024 * 1024 || target.btoa(bytes) !== text) throw failure3("PREVIEW_READ_ONLY", "Invalid preview digest payload.");
      return { algorithm: "SHA-256", base64: text };
    }
    if (action === "editor.events.open") return { path: historyPath(entry2, payload.path, true) };
    if (action === "editor.events.poll" || action === "editor.events.close") {
      if (typeof payload.subscriptionId !== "string" || !entry2.subscriptions.has(payload.subscriptionId)) throw failure3("PREVIEW_READ_ONLY", "This event stream does not belong to the preview.");
      if (action === "editor.events.poll" && (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0 || payload.cursor > entry2.subscriptions.get(payload.subscriptionId))) throw failure3("PREVIEW_READ_ONLY", "Invalid preview event cursor.");
      return { subscriptionId: payload.subscriptionId, ...action === "editor.events.poll" ? { cursor: payload.cursor } : {} };
    }
    throw failure3("PREVIEW_READ_ONLY", "Historical previews cannot save, download or send requests to chat.");
  };
  const execute = async (entry2, action, payload) => {
    if (!alive3(entry2)) throw failure3("PREVIEW_CLOSED", "The read-only preview has closed.");
    if (action === "editor.events.open") {
      if (entry2.subscriptions.size + entry2.pendingStreams >= 4) throw failure3("PREVIEW_BUSY", "The preview already has its event streams.");
      entry2.pendingStreams++;
      try {
        const result2 = await rpc(action, payload);
        if (!UUID3.test(result2?.subscriptionId || "") || !Number.isSafeInteger(result2.cursor) || result2.cursor < 0) {
          if (UUID3.test(result2?.subscriptionId || "")) void Promise.resolve().then(() => rpc("editor.events.close", { subscriptionId: result2.subscriptionId })).catch(() => {
          });
          throw failure3("PREVIEW_FAILED", "The preview event service returned an invalid stream.");
        }
        if (!alive3(entry2)) {
          void Promise.resolve().then(() => rpc("editor.events.close", { subscriptionId: result2.subscriptionId })).catch(() => {
          });
          return;
        }
        entry2.subscriptions.set(result2.subscriptionId, result2.cursor);
        return result2;
      } finally {
        entry2.pendingStreams--;
      }
    }
    if (action === "editor.events.close") {
      const result2 = await rpc(action, payload);
      entry2.subscriptions.delete(payload.subscriptionId);
      return result2;
    }
    const result = await rpc(action, payload);
    if (action === "editor.events.poll" && alive3(entry2)) {
      if (!Number.isSafeInteger(result?.cursor) || result.cursor < payload.cursor || !Array.isArray(result.events) || result.events.length > 128) throw failure3("PREVIEW_FAILED", "The preview event service returned invalid events.");
      if (entry2.subscriptions.has(payload.subscriptionId)) entry2.subscriptions.set(payload.subscriptionId, Math.max(entry2.subscriptions.get(payload.subscriptionId), result.cursor));
    }
    return result;
  };
  const forget = (entry2, id, cached) => {
    if (entry2.requests.get(id) !== cached) return;
    entry2.requests.delete(id);
    entry2.cacheBytes -= cached.bytes;
  };
  const trimCache = (entry2, needed, currentId) => {
    for (const [id, cached] of entry2.requests) {
      if (entry2.requests.size < MAX_CACHE && entry2.cacheBytes + needed <= MAX_CACHE_BYTES) break;
      if (id !== currentId && cached.settled && !(cached.subscriptionId && entry2.subscriptions.has(cached.subscriptionId))) forget(entry2, id, cached);
    }
  };
  const resultFor = (entry2, id, cached, answer) => {
    if (!alive3(entry2)) return answer;
    const bytes = new TextEncoder().encode(JSON.stringify(answer)).byteLength;
    if (bytes > MAX_CACHE_BYTES) throw failure3("PREVIEW_TOO_LARGE", "The preview response exceeds its transfer limit.");
    trimCache(entry2, bytes, id);
    if (entry2.cacheBytes + bytes <= MAX_CACHE_BYTES) {
      cached.bytes += bytes;
      entry2.cacheBytes += bytes;
    } else cached.evictWhenSettled = true;
    return answer;
  };
  const receive = async (event) => {
    const entry2 = current, message = event.data;
    if (!entry2 || !alive3(entry2) || entry2.kind !== "history" || event.source !== entry2.frame?.contentWindow || message?.channel !== entry2.channel) return;
    if (message.type === "codex-design:editor-document-request") {
      send(entry2, { type: "codex-design:editor-document", html: entry2.html });
      return;
    }
    if (message.type === "codex-design:preview-close") {
      close();
      return;
    }
    if (message.type === "codex-design:editor-transport-ready") {
      send(entry2, { type: "codex-design:host-context-changed", context: hostContext, hostContextIsSnapshot: true });
      return;
    }
    if (message.type === "codex-design:editor-app-ready") {
      clearTimeout(entry2.startup);
      entry2.status.hidden = true;
      return;
    }
    if (message.type === "codex-design:editor-diagnostic") {
      showError(entry2, failure3("PREVIEW_RUNTIME_ERROR", typeof message.message === "string" ? message.message.slice(0, 2e3) : "The historical preview could not be displayed."));
      return;
    }
    if (message.type !== "codex-design:editor-request" || typeof message.requestId !== "string" || !REQUEST_ID.test(message.requestId)) return;
    const respond = (value) => send(entry2, { type: "codex-design:editor-response", requestId: message.requestId, ...value });
    try {
      const payload = validate(entry2, message.action, message.payload);
      const signature = message.action + ":" + JSON.stringify(payload);
      const bytes = new TextEncoder().encode(signature).byteLength;
      if (bytes > MAX_PENDING_BYTES) throw failure3("PREVIEW_BUSY", "The preview request exceeds its transfer limit.");
      let cached = entry2.requests.get(message.requestId);
      if (cached && cached.signature !== signature) throw failure3("PREVIEW_REQUEST_CONFLICT", "A preview request identifier was reused with different content.");
      if (!cached) {
        if (entry2.pending >= MAX_PENDING || entry2.pendingBytes + bytes > MAX_PENDING_BYTES) throw failure3("PREVIEW_BUSY", "The preview has too many pending reads.");
        trimCache(entry2, bytes);
        if (entry2.requests.size >= MAX_CACHE || entry2.cacheBytes + bytes > MAX_CACHE_BYTES) throw failure3("PREVIEW_BUSY", "The preview request cache is full.");
        cached = { signature, settled: false, bytes };
        entry2.pending++;
        entry2.pendingBytes += bytes;
        entry2.cacheBytes += bytes;
        cached.promise = Promise.resolve().then(() => execute(entry2, message.action, payload)).then((result) => {
          if (message.action === "editor.events.open" && UUID3.test(result?.subscriptionId || "")) cached.subscriptionId = result.subscriptionId;
          return resultFor(entry2, message.requestId, cached, { result });
        }).catch((error3) => resultFor(entry2, message.requestId, cached, { error: detail2(error3) })).finally(() => {
          cached.settled = true;
          entry2.pending--;
          entry2.pendingBytes -= bytes;
          if (cached.evictWhenSettled || !alive3(entry2)) forget(entry2, message.requestId, cached);
        });
        entry2.requests.set(message.requestId, cached);
      }
      respond(await cached.promise);
    } catch (error3) {
      respond({ error: detail2(error3) });
    }
  };
  const open = async (value) => {
    const item = classify(value);
    if (disposed || item.external) return false;
    const entry2 = create(item.title || "Read-only preview");
    entry2.kind = item.kind;
    entry2.title = item.title;
    try {
      if (item.refused) throw failure3("PREVIEW_UNAVAILABLE", "This link cannot be opened as a read-only Codex Design preview.");
      const saved = typeof flush === "function" ? await flush() : void 0;
      if (!alive3(entry2)) return false;
      if (saved?.saved === false) throw failure3("EDITOR_UNSAVED_CHANGES", "Save the current editor before opening its preview.");
      if (item.kind === "system") {
        const response = await target.fetch(new URL(item.path, base).href, { method: "GET" });
        if (!alive3(entry2)) return false;
        if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get("content-type") || "")) throw failure3("PREVIEW_UNAVAILABLE", `The design system reference could not be loaded (HTTP ${response.status}).`);
        if (Number(response.headers.get("content-length")) > PASSIVE_LIMIT) throw failure3("PREVIEW_TOO_LARGE", "The design system reference exceeds its preview limit.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!alive3(entry2)) return false;
        if (bytes.byteLength > PASSIVE_LIMIT) throw failure3("PREVIEW_TOO_LARGE", "The design system reference exceeds its preview limit.");
        const html = passiveHtml(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!alive3(entry2)) return false;
        const url = target.URL.createObjectURL(new Blob([html], { type: "text/html" }));
        entry2.urls.add(url);
        frame(entry2, "").src = url;
        entry2.status.hidden = true;
      } else {
        entry2.channel = target.crypto.randomUUID();
        entry2.prefix = item.path;
        if (!UUID3.test(entry2.channel)) throw failure3("PREVIEW_FAILED", "A unique preview channel could not be created.");
        const result = await rpc("editor.previewDocument", { version: item.version, channel: entry2.channel });
        if (!alive3(entry2)) return false;
        if (typeof result?.html !== "string" || !result.html.trim() || new TextEncoder().encode(result.html).byteLength > LIMIT) throw failure3("PREVIEW_TOO_LARGE", "The historical editor document is missing or exceeds its preview limit.");
        entry2.html = result.html;
        const loader = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="form-action &#39;none&#39;"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><script>(' + loadSnapshotDocument.toString().replace(/<\/script/gi, "<\\/script") + ")(" + JSON.stringify(entry2.channel) + ");</script></body></html>";
        frame(entry2, "allow-scripts allow-same-origin").src = "data:text/html;base64," + target.btoa(loader);
        entry2.startup = setTimeout(() => showError(entry2, failure3("PREVIEW_START_TIMEOUT", "The historical editor did not finish opening. Close and retry this preview.")), 3e4);
        entry2.startup.unref?.();
      }
      return true;
    } catch (error3) {
      showError(entry2, error3);
      return false;
    }
  };
  const wrappedOpen = function(value, ...args) {
    const item = classify(value);
    if (item.external) return typeof originalOpen === "function" ? originalOpen.call(target, value, ...args) : null;
    void open(value);
    return null;
  };
  const click = (event) => {
    if (event.defaultPrevented || event.button !== void 0 && event.button !== 0 && event.button !== 1) return;
    const link = event.composedPath?.().find((node) => node?.nodeType === 1 && String(node.localName).toLowerCase() === "a" && node.hasAttribute("href"));
    if (!link || link.hasAttribute("download")) return;
    const href = link.getAttribute("href");
    if (href?.startsWith("#")) return;
    const item = classify(href);
    if (item.external) return;
    event.preventDefault();
    event.stopPropagation?.();
    void open(href);
  };
  const key = (event) => {
    if (current && event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation?.();
      close();
    }
  };
  const updateHostContext = (context) => {
    const value = { ...context?.theme === "light" || context?.theme === "dark" ? { theme: context.theme } : {}, ...plain(context?.styles) ? { styles: context.styles } : {} };
    try {
      const text = JSON.stringify(value);
      hostContext = text.length <= 2 * 1024 * 1024 ? JSON.parse(text) : { theme: value.theme };
    } catch {
      hostContext = {};
    }
    if (current?.kind === "history") send(current, { type: "codex-design:host-context-changed", context: hostContext, hostContextIsSnapshot: true });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    close(false);
    target.removeEventListener("message", receive);
    target.removeEventListener("unload", dispose);
    document2.removeEventListener("click", click, true);
    document2.removeEventListener("auxclick", click, true);
    document2.removeEventListener("keydown", key, true);
    if (target.open === wrappedOpen) target.open = originalOpen;
  };
  target.open = wrappedOpen;
  target.addEventListener("message", receive);
  target.addEventListener("unload", dispose);
  document2.addEventListener("click", click, true);
  document2.addEventListener("auxclick", click, true);
  document2.addEventListener("keydown", key, true);
  updateHostContext(target.__CODEX_DESIGN_EDITOR_TRANSPORT__?.hostContext);
  return { open, close, updateHostContext, dispose };
}

// source/server/native-comments.mjs
import { createHash as createHash7, randomUUID as randomUUID7 } from "node:crypto";
var fail3 = (code, message) => Object.assign(new Error(message), { code });
var encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
var jsonResult = (value, status = 200) => ({ status, statusText: status === 200 ? "OK" : "Accepted", headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: encode(value) });
var parseResult = (result) => {
  try {
    return JSON.parse(Buffer.from(result.body, "base64").toString("utf8"));
  } catch {
    throw fail3("INVALID_COMMENT_RESPONSE", "The comment service did not return valid JSON.");
  }
};
function createNativeComments({ requests, transport, editorFor, pollMs = 1e3, idleMs = 12e4 } = {}) {
  const streams = /* @__PURE__ */ new Map();
  const route = async (id, relative) => {
    const editor = await editorFor(id);
    const url = editorRequestUrl(editor.url, relative);
    const base = new URL(editor.url);
    const path14 = decodeURIComponent(url.pathname.slice(base.pathname.length)).split("/").filter(Boolean).join("/");
    return { editor, path: path14, url };
  };
  const project = async (id, snapshot2) => {
    const value = await requests.project(id, snapshot2);
    value.agent = {
      ...value.agent,
      available: true,
      listening: false,
      busy: value.threads.some((thread) => thread.agent?.nativeRequest?.status === "working"),
      hook: false
    };
    return value;
  };
  const snapshot = async (id) => {
    const result = await transport.request(id, { path: "__comments", method: "GET" });
    if (result.status < 200 || result.status >= 300) throw fail3("COMMENTS_UNAVAILABLE", "The artwork comments could not be loaded.");
    return project(id, parseResult(result));
  };
  const prepared = async (id, threadId, response) => {
    const request = await requests.prepare({ artifactId: id, commentId: threadId });
    const title = `${request.artifact.title} · ${request.event.data.where || request.event.data.location?.file || "Comment"}`;
    const summary = request.event.data.messages.map((message) => message.text).join("\n\n");
    const body = parseResult(response);
    if (body.thread) {
      const value = await project(id, { threads: [body.thread] });
      body.thread = value.threads[0];
    }
    return { ...response, body: encode(body), nativeDraft: {
      requestId: request.id,
      attemptId: randomUUID7(),
      savedCommentId: threadId,
      artifactId: id,
      uri: request.requestUri,
      title: title.slice(0, 300),
      summary: summary.slice(0, 12e3)
    } };
  };
  const close = (stream) => {
    clearTimeout(stream.expiry);
    streams.delete(stream.id);
  };
  const touch = (stream) => {
    clearTimeout(stream.expiry);
    stream.expiry = setTimeout(() => close(stream), idleMs);
    stream.expiry.unref?.();
  };
  return {
    async request(id, request) {
      const { path: path14 } = await route(id, request.path);
      const { method, body } = validateEditorRequest(request);
      if (path14 === "__comments" && ["GET", "HEAD"].includes(method)) {
        const result = jsonResult(await snapshot(id));
        return method === "HEAD" ? { ...result, body: "" } : result;
      }
      const send = /^__comments\/([^/]+)\/send$/.exec(path14);
      if (send && method === "POST") {
        const current = await snapshot(id);
        const matches = current.threads.filter((item) => item.id === send[1]);
        if (!matches.length && send[1].length >= 3) matches.push(...current.threads.filter((item) => item.id.startsWith(send[1])));
        if (matches.length !== 1) throw fail3(matches.length ? "AMBIGUOUS_COMMENT" : "COMMENT_NOT_FOUND", "Select one existing comment before adding it to chat.");
        const thread = matches[0];
        return prepared(id, thread.id, jsonResult({ thread }));
      }
      const mutation = path14 === "__comments" && method === "POST" || /^__comments\/[^/]+\/messages(?:\/[^/]+)?$/.test(path14) && ["POST", "PATCH"].includes(method);
      const adHoc = path14 === "__comments/agent/requests" && method === "POST";
      if ((mutation || adHoc) && body) {
        if (body.length > 256 * 1024) throw fail3("INVALID_COMMENT", "The comment exceeds its transfer limit.");
        let input;
        try {
          input = JSON.parse(body.toString("utf8"));
        } catch {
          throw fail3("INVALID_COMMENT", "The comment request is not valid JSON.");
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) throw fail3("INVALID_COMMENT", "Expected a comment object.");
        if (input.send === true || adHoc) {
          const normal = adHoc ? {
            anchor: "request:" + randomUUID7(),
            label: input.label || "Artwork request",
            text: input.text,
            ...input.selection ? { detail: input.selection } : {},
            send: false
          } : { ...input, send: false };
          const result = await transport.request(id, { ...request, path: adHoc ? "__comments" : request.path, body: encode(normal) });
          if (result.status < 200 || result.status >= 300) return result;
          const saved = parseResult(result);
          if (!saved.thread?.id) throw fail3("INVALID_COMMENT_RESPONSE", "The saved comment has no identity.");
          return prepared(id, saved.thread.id, adHoc ? { ...result, body: encode({ ...saved, request: { id: saved.thread.id } }) } : result);
        }
      }
      return transport.request(id, request);
    },
    async openEvents(id, path14) {
      const found = await route(id, path14);
      if (found.path !== "__comments/events") return transport.openEvents(id, path14);
      const stream = { id: randomUUID7(), artifactId: id, cursor: 0, events: [], fingerprint: null, lastPoll: 0 };
      streams.set(stream.id, stream);
      touch(stream);
      return { subscriptionId: stream.id, cursor: 0 };
    },
    async pollEvents(id, subscriptionId, cursor = 0) {
      const stream = streams.get(subscriptionId);
      if (!stream) return transport.pollEvents(id, subscriptionId, cursor);
      if (stream.artifactId !== id) throw fail3("EDITOR_SUBSCRIPTION_UNAVAILABLE", "This comment stream belongs to another artwork.");
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stream.cursor) throw fail3("INVALID_EDITOR_REQUEST", "Invalid comment event cursor.");
      touch(stream);
      const delay = Math.max(0, pollMs - (Date.now() - stream.lastPoll));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!streams.has(subscriptionId)) return { events: [], cursor: stream.cursor, ended: true };
      const value = await snapshot(id);
      const data = JSON.stringify(value), fingerprint2 = createHash7("sha256").update(data).digest("hex");
      if (fingerprint2 !== stream.fingerprint) {
        stream.fingerprint = fingerprint2;
        stream.events.push({ cursor: ++stream.cursor, event: "comments", data });
        if (stream.events.length > 128) stream.events.shift();
      }
      stream.lastPoll = Date.now();
      return { events: stream.events.filter((item) => item.cursor > cursor), cursor: stream.cursor, ended: false };
    },
    async closeEvents(id, subscriptionId) {
      const stream = streams.get(subscriptionId);
      if (!stream) return transport.closeEvents(id, subscriptionId);
      if (stream.artifactId !== id) throw fail3("EDITOR_SUBSCRIPTION_UNAVAILABLE", "This comment stream belongs to another artwork.");
      close(stream);
      return { closed: true };
    },
    dispose() {
      for (const stream of streams.values()) close(stream);
    }
  };
}

// source/server/editor-document.mjs
import { createHash as createHash8 } from "node:crypto";

// source/scripts/comment-toolbar-adapter.mjs
var native = "globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__";
var marker = "/* codex-design:native-comment-toolbar */";
var escape3 = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function readCommentComponent(source, pattern) {
  const match = pattern.exec(source);
  if (!match) return null;
  let depth = 1, quote = null, escaped = false;
  const begin = match.index + match[0].length;
  for (let index = begin; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === "`") quote = character;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return { match, start: match.index, end: index + 1, text: source.slice(match.index, index + 1) };
  }
  throw new Error("The packaged comment component could not be read.");
}
function adaptCommentToolbar(source) {
  if (source.includes(marker)) return source;
  let changed = false, factoryCalls = 0;
  const factory2 = /function ([\w$]+)\(\{base:[\w$]+,win:[\w$]+=window,modeShortcut:[\w$]+="C",launcher:[\w$]+,header:[\w$]+=!1,toolbar:[\w$]+=!1,pinSide:[\w$]+\}\)\{/.exec(source);
  if (factory2) {
    const call = new RegExp(`${escape3(factory2[1])}\\(\\{base:([\\w$]+)(,header:!0)?\\}\\)`, "g");
    source = source.replace(call, (_, base, header) => {
      changed = true;
      factoryCalls++;
      return `${factory2[1]}({base:${base}${header ? `,header:${native}?!1:!0` : ""},toolbar:!!${native}})`;
    });
    const top = /function ([\w$]+)\(([\w$]+)\)\{for\((?:const|let) ([\w$]+) of \2\)\{(?:const|let) ([\w$]+)=\(\3\.el\.closest\([\w$]+\)\?\?\3\.el\.parentElement\)\?\.getBoundingClientRect\(\);if\(!\(!\4\|\|\4\.height===0\)\)return Math\.round\(\4\.bottom\+([\w$]+)\)\}return null\}/;
    let positioned = 0;
    source = source.replace(top, (match, name, seats, seat2, rect, margin) => {
      positioned++;
      changed = true;
      return match.replace(`Math.round(${rect}.bottom+${margin})`, `Math.round(${native}?Math.min(${rect}.bottom+${margin},Math.max(${margin},globalThis.innerHeight/2)):${rect}.bottom+${margin})`);
    });
    if (positioned !== 1) throw new Error("The canonical toolbar comment-list anchor changed; adaptation was refused.");
  }
  const seat = (jsx) => `${native}?${jsx}.jsx("span",{"data-baoyu-comments-seat":"","data-codex-comment-toolbar":"",style:{display:"contents"}}):null`;
  const floating = readCommentComponent(source, /function ([\w$]+)\(\{sections:[\w$]+,tail:[\w$]+,current:[\w$]+,onJump:[\w$]+,footer:[\w$]+,status:([\w$]+),navRef:[\w$]+,edgeRef:[\w$]+,port:[\w$]+,marks:[\w$]+,search:[\w$]+,pending:[\w$]+\}\)\{/);
  const sidebar = readCommentComponent(source, /function ([\w$]+)\(\{sections:[\w$]+,tail:[\w$]+,current:[\w$]+,onJump:[\w$]+,dropProps:[\w$]+,footer:([\w$]+),navRef:[\w$]+,marks:[\w$]+,search:[\w$]+,pending:[\w$]+\}\)\{/);
  if (floating || sidebar) {
    if (!floating || !sidebar) throw new Error("The design-system navigation modes changed; adaptation was refused.");
    if (factoryCalls !== 1) throw new Error("The design-system comment mounting options changed; adaptation was refused.");
    const jsx = /return ([\w$]+)\.jsx\(/.exec(floating.text)?.[1];
    if (!jsx) throw new Error("The design-system navigation JSX runtime was not found.");
    const status = floating.match[2], footer = sidebar.match[2];
    const suffix = `}),${status}]})})}`;
    if (!floating.text.endsWith(suffix)) throw new Error("The design-system chapter tool row changed; adaptation was refused.");
    const floatingText = floating.text.slice(0, -suffix.length) + `}),${seat(jsx)},${status}]})})}`;
    const footerPattern = new RegExp(`${escape3(footer)}!==void 0\\?${escape3(jsx)}\\.jsx\\("div",\\{className:"ds-nav-foot[^"]*","data-testid":"ds-nav-foot",children:${escape3(footer)}\\}\\):null`);
    let footers = 0;
    const sidebarText = sidebar.text.replace(footerPattern, (match) => {
      footers++;
      return match.replace(`${footer}!==void 0?`, `(${footer}!==void 0||${native})?`).replace(`children:${footer}`, `children:${jsx}.jsxs(${jsx}.Fragment,{children:[${seat(jsx)},${footer}]})`);
    });
    if (footers !== 1) throw new Error("The design-system sidebar tool row changed; adaptation was refused.");
    for (const part of [{ ...floating, replacement: floatingText }, { ...sidebar, replacement: sidebarText }].sort((a, b) => b.start - a.start)) source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
    changed = true;
  }
  if (source.includes("toolbarTrailing:") && source.includes("markToolbarUncommentable")) {
    const slot = /([\w$]+)\.jsx\("span",\{ref:([\w$]+)\.markToolbarUncommentable,hidden:!0\}\)/;
    if (!slot.test(source)) throw new Error("The dashboard toolbar slot changed; adaptation was refused.");
    source = source.replace(slot, (_, jsx, namespace) => `${jsx}.jsx("span",{ref:${namespace}.markToolbarUncommentable,hidden:!${native},"data-baoyu-comments-seat":${native}?"":void 0,"data-codex-comment-toolbar":${native}?"":void 0,style:${native}?{display:"contents"}:void 0})`);
    changed = true;
  }
  return changed ? marker + "\n" + source : source;
}

// source/scripts/editor-export-adapter.mjs
var marker2 = "/* codex-design:native-export-save-results */";
var native2 = "globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__";
var escape4 = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function throwNativeEditorExportFailure(error3, code) {
  if (error3?.nativeExportSaveFailure === true) throw error3;
  const failureCode = typeof code === "string" && code ? code : "EXPORT_FAILED";
  const message = typeof error3?.message === "string" && error3.message ? error3.message : failureCode === "EXPORT_UNCONFIRMED" ? "The export save result could not be confirmed. The file may already exist. Check the selected folder before starting another export." : `Save As did not complete (${failureCode}). The export was not retried automatically.`;
  throw Object.assign(new Error(message), { code: failureCode, nativeExportSaveFailure: true });
}
function definitionFor(source, property) {
  const matches = [...source.matchAll(new RegExp(`\\b[at]\\(e,"${escape4(property)}",\\(\\)=>(${String.raw`[\w$]+`})\\)`, "g"))];
  if (matches.length !== 1) throw new Error(`The canonical ${property} export changed; native export recovery was refused.`);
  const exported = matches[0];
  const start = source.lastIndexOf("function " + exported[1] + "(", exported.index);
  const part = start < 0 ? null : readCommentComponent(source.slice(start), new RegExp(`^function ${escape4(exported[1])}\\([^)]*\\)\\{`));
  if (!part) throw new Error(`The canonical ${property} function changed; native export recovery was refused.`);
  return { ...part, start, end: start + part.end };
}
function adaptEditorExportFallbacks(source) {
  if (source.includes(marker2) || !source.includes('"saveThroughHost"')) return source;
  const part = definitionFor(source, "saveThroughHost");
  const replaceOnce = (text, expression, transform) => {
    let count = 0;
    const replacement = text.replace(expression, (...values) => {
      count++;
      return transform(...values);
    });
    if (count !== 1) throw new Error("The canonical Canvas save error handler changed; native export recovery was refused.");
    return replacement;
  };
  let save = replaceOnce(
    part.text,
    /catch\(([\w$]+)\)\{let ([\w$]+)=([\w$]+)\(\1\);return\{outcome:\2==="declined"\?"declined":"unsupported",code:\2\}/g,
    (match, error3, code) => match.replace(";return", `;if(${native2}&&${code}!=="declined")__codexThrowNativeExportFailure(${error3},${code});return`)
  );
  save = replaceOnce(
    save,
    /if\(([\w$]+)===null\)return\{outcome:"unsupported",code:"no_shell_save"\}/g,
    (match, capability) => `if(${capability}===null){if(${native2})__codexThrowNativeExportFailure(new Error("Save As is unavailable in this editor."),"no_shell_save");return{outcome:"unsupported",code:"no_shell_save"}}`
  );
  source = source.slice(0, part.start) + save + source.slice(part.end);
  const producer = definitionFor(source, "runExportProducer");
  const delivery = /\}let ([\w$]+)=([\w$]+)\(([\w$]+),([\w$]+)\);if\(\1\.released===!0&&[\w$]+\.aborted\)return/.exec(producer.text);
  const finalResult = /return\{format:([\w$]+),\.\.\.([\w$]+),outcome:[\w$]+,code:[\w$]+\.code,filename:([\w$]+)\.filename,/.exec(producer.text);
  if (!delivery || !finalResult || delivery[3] !== finalResult[1] || !producer.text.endsWith("}")) {
    throw new Error("The canonical registered export delivery changed; native export recovery was refused.");
  }
  const request = delivery[1], resolve = delivery[2], format = delivery[3], execution = delivery[4];
  const variants = finalResult[2], file = finalResult[3];
  const declaration = `let ${request}=${resolve}(${format},${execution});`;
  const deliveryStart = delivery.index + 1 + declaration.length;
  const catchDelivery = `}catch(__codexNativeDeliveryError){if(${native2}&&__codexNativeDeliveryError?.nativeExportSaveFailure===true){if(${request}.released!==!0)(0,e.declineFrameExport)(${request}.request);return{format:${format},...${variants},outcome:"failed",code:__codexNativeDeliveryError.code,filename:${file}.filename}}throw __codexNativeDeliveryError}`;
  const producerText = producer.text.slice(0, deliveryStart) + "try{" + producer.text.slice(deliveryStart, -1) + catchDelivery + "}";
  source = source.slice(0, producer.start) + producerText + source.slice(producer.end);
  const image = definitionFor(source, "exportArtboardImage");
  const imageText = replaceOnce(
    image.text,
    /&&\(\(0,e\.triggerBrowserDownload\)\(/g,
    () => `&&(!${native2}&&(0,e.triggerBrowserDownload)(`
  );
  source = source.slice(0, image.start) + imageText + source.slice(image.end);
  const pdf = definitionFor(source, "exportPdf");
  const pdfText = replaceOnce(
    pdf.text,
    /(if\([\w$]+==="unsupported"\)\{)try\{(?=let [\w$]+=document\.createElement\("a"\))/g,
    (match, condition) => `${condition}if(!${native2})try{`
  );
  source = source.slice(0, pdf.start) + pdfText + source.slice(pdf.end);
  let cardCount = 0;
  source = source.replace(
    /id:"dUR5426EKh"\}\)\)\}finally\{([\w$]+)\(!1\)\}\}\)\(\)\};return ([\w$]+)\.jsxs\("div",\{className:"flex flex-col gap-1\.5",children:\[\2\.jsxs\("div",\{"data-testid":"export-delivery-card"/g,
    (match, busy, jsx, offset) => {
      const start = source.lastIndexOf("function ", offset);
      const prefix = source.slice(start, offset);
      const toast = /let\{showToast:([\w$]+)\}=\(0,e\.useToast\)\(\)/.exec(prefix)?.[1];
      if (!toast || prefix.length > 1e4) throw new Error("The canonical export warning card changed; native export recovery was refused.");
      cardCount++;
      const caught = `}catch(__codexNativeSaveError){if(${native2}&&__codexNativeSaveError?.nativeExportSaveFailure===true){${toast}(__codexNativeSaveError.message,"error");return{outcome:"failed",code:__codexNativeSaveError.code}}throw __codexNativeSaveError}finally{`;
      return match.replace("}finally{", caught);
    }
  );
  if (cardCount !== 1) throw new Error("The canonical export warning card changed; native export recovery was refused.");
  let catchCount = 0;
  const zipFailure = /\}catch\(([\w$]+)\)\{e\.healthReporter\.report\(\.\.\.\(0,e\.classifyExportFailure\)\("zip"\)\),([\w$]+)\((?:"Couldn't build the HTML zip: "\+String\(\1\)|\(0,e\.formatMessage\)\(\{defaultMessage:"Couldn’t build the HTML zip: \{error\}",id:"q0OIrbxby5"\},\{error:String\(\1\)\}\)),"error"\)\}finally\{([\w$]+)\(!1\)\}/g;
  source = source.replace(
    zipFailure,
    (match, error3, toast) => {
      catchCount++;
      const guard = `if(${native2}&&${error3}?.nativeExportSaveFailure===true){e.healthReporter.report(...(0,e.classifyExportFailure)("zip"));${toast}(${error3}.message,"error");return{outcome:"failed",code:${error3}.code}}`;
      return match.replace(`}catch(${error3}){`, `}catch(${error3}){${guard}`);
    }
  );
  if (catchCount !== 1) throw new Error("The canonical HTML zip error handler changed; native export recovery was refused.");
  return marker2 + "\nconst __codexThrowNativeExportFailure=" + throwNativeEditorExportFailure.toString() + ";\n" + source;
}

// source/scripts/blank-artboard-adapter.mjs
var marker3 = "/* codex-design:native-blank-artboard-contract */";
var native3 = "globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__";
var escape5 = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var __codexBlankScriptBody = "class Component extends DCLogic {\n  renderVals() { return {}; }\n}";
var __codexBlankPreviewOwners = /* @__PURE__ */ new WeakMap();
function completeNativeBlankArtboard(html, size) {
  if (typeof html !== "string" || /\bdata-dc-script\b/.test(html)) return html;
  if (typeof size?.file !== "string" || !size.file.endsWith(".dc.html") || ![size.w, size.h].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
    throw new Error("The new artboard needs a finite positive width and height.");
  }
  const end = html.lastIndexOf("</body>");
  const close = html.lastIndexOf("</x-dc>");
  if (end < 0 || close < 0 || close >= end) throw new Error("The new blank artboard template changed.");
  const props = JSON.stringify({ $preview: { width: size.w, height: size.h } });
  const script = `<script type="text/x-dc" data-dc-script data-codex-design-blank="${encodeURIComponent(size.file)}" data-props='${props}'>
${__codexBlankScriptBody}
</script>
`;
  return html.slice(0, end) + script + html.slice(end);
}
function syncNativeBlankArtboardPreviews(state, indexFile, owner) {
  const files = state?.content?.files;
  const indexText = files?.[indexFile];
  if (typeof indexText !== "string") return state;
  const tracked = typeof owner === "function" || owner !== null && typeof owner === "object";
  const previous = tracked ? __codexBlankPreviewOwners.get(owner) : void 0;
  if (previous?.indexFile === indexFile && previous.indexText === indexText) return state;
  let index;
  try {
    index = JSON.parse(indexText);
  } catch {
    return state;
  }
  let boards;
  if (index?.boards && typeof index.boards === "object" && !Array.isArray(index.boards)) boards = Object.entries(index.boards);
  else if (Array.isArray(index?.artboards)) {
    const seen = /* @__PURE__ */ new Set();
    boards = [];
    for (const size of index.artboards) {
      if (!size || typeof size !== "object" || Array.isArray(size) || typeof size.file !== "string" || !size.file || seen.has(size.file) || ![size.w, size.h].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) return state;
      seen.add(size.file);
      boards.push([size.file, size]);
    }
  } else return state;
  let next;
  for (const [file, size] of boards) {
    const html = files[file];
    if (typeof html !== "string" || ![size?.w, size?.h].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) continue;
    const scripts = [...html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)].filter((match) => /\bdata-dc-script\b/i.test(match[1]));
    if (scripts.length !== 1) continue;
    const script = scripts[0], attrs = script[1];
    if (!/\btype="text\/x-dc"/.test(attrs) || !attrs.includes(`data-codex-design-blank="${encodeURIComponent(file)}"`) || script[2].replace(/\r\n/g, "\n").trim() !== __codexBlankScriptBody) continue;
    const attribute2 = /\sdata-props=(['"])([\s\S]*?)\1/.exec(attrs);
    if (!attribute2) continue;
    let props;
    try {
      const decoded = attribute2[2].replace(/&(quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, (match, name) => {
        if (name[0] === "#") return String.fromCodePoint(parseInt(name.slice(name[1].toLowerCase() === "x" ? 2 : 1), name[1].toLowerCase() === "x" ? 16 : 10));
        return { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" }[name.toLowerCase()];
      });
      props = JSON.parse(decoded);
    } catch {
      continue;
    }
    if (!props || typeof props !== "object" || Array.isArray(props) || !props.$preview || typeof props.$preview !== "object" || Array.isArray(props.$preview)) continue;
    if (![props.$preview.width, props.$preview.height].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) continue;
    if (props.$preview.width === size.w && props.$preview.height === size.h && attribute2[1] === "'") continue;
    const json = JSON.stringify({ ...props, $preview: { ...props.$preview, width: size.w, height: size.h } }).replaceAll("&", "&amp;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const changedAttrs = attrs.slice(0, attribute2.index) + ` data-props='${json}'` + attrs.slice(attribute2.index + attribute2[0].length);
    next ??= { ...files };
    next[file] = html.slice(0, script.index) + script[0].replace(attrs, changedAttrs) + html.slice(script.index + script[0].length);
  }
  const result = next ? { ...state, content: { ...state.content, files: next } } : state;
  if (tracked) __codexBlankPreviewOwners.set(owner, { indexFile, indexText });
  return result;
}
function adaptBlankArtboardCreation(source) {
  if (source.includes(marker3) || !source.includes('"blankDcDocument"')) return source;
  const once2 = (expression, replacement, label) => {
    let count = 0;
    source = source.replace(expression, (...values) => {
      count++;
      return replacement(...values);
    });
    if (count !== 1) throw new Error(`The canonical ${label} changed; blank artboard adaptation was refused.`);
  };
  const ui = /let ([\w$]+)=([\w$]+)\?\(0,e\.insertBlankArtboardMarkup\)\(\(0,e\.blankDcDocument\)\(\),\2\):\(0,e\.blankDcDocument\)\(\);(await\(0,e\.getKvClient\)\(\)\.set\(\(0,e\.PlatformFileContentHandler_4\)\(([\w$]+)\),\1\));/g;
  let text, body, save, file;
  once2(ui, (match, html, markup, write, name) => {
    [text, body, save, file] = [html, markup, write, name];
    return match.replace(write + ";", `if(!${native3}||${body})${write};`);
  }, "new empty artboard save");
  const uiCommit = new RegExp(`;([\\w$]+)\\.current\\(\\{kind:"add",entries:\\[\\{file:${escape5(file)},src:${escape5(text)},spec:([\\w$]+)\\}\\]\\}`, "g");
  once2(uiCommit, (match, history, spec) => `;if(${native3}&&!${body}){${text}=__codexCompleteBlankArtboard(${text},${spec});${save};}${match.slice(1)}`, "new empty artboard metadata");
  const batch = /([\w$]+)\[([\w$]+)\]=([\w$]+);let [\s\S]{0,1700}?([\w$]+)\.push\(([\w$]+)\),([\w$]+)\.push\(\{file:\2,src:\3,spec:\5\}\)/g;
  once2(batch, (match, files, name, html, boards, spec, entries, offset) => {
    const bodyInput = /typeof ([\w$]+)\.x==/.exec(match)?.[1];
    const selection = source.slice(Math.max(0, offset - 900), offset);
    if (!bodyInput || !selection.includes(`${bodyInput}.body.trim()===""`) || !selection.includes(`${bodyInput}.from!==void 0?`)) {
      throw new Error("The canonical blank batch input changed; adaptation was refused.");
    }
    const guard = `${native3}&&${bodyInput}.from===void 0&&${bodyInput}.body.trim()===""&&(${bodyInput}.pageRule===void 0||${bodyInput}.pageRule==="")`;
    const before = `if(${guard}){${html}=__codexCompleteBlankArtboard(${html},${spec});${files}[${name}]=${html};}`;
    return match.replace(`${boards}.push(${spec}),${entries}.push`, before + `${boards}.push(${spec}),${entries}.push`);
  }, "blank batch artboard metadata");
  once2(
    /function ([\w$]+)\(([\w$]+)\)\{([\w$]+)=\2,([\w$]+)\(\2\.content\.files\),([\w$]+)\(!1\),([\w$]+)\(\)\}/g,
    (match, name, value, state) => match.replace(`{${state}=`, `{if(${native3})${value}=__codexSyncBlankPreviews(${value},e.canvasMetadataFile,${name});${state}=`),
    "local canvas content update"
  );
  return marker3 + "\nconst __codexBlankScriptBody=" + JSON.stringify(__codexBlankScriptBody) + ";\nconst __codexBlankPreviewOwners=new WeakMap();\nconst __codexCompleteBlankArtboard=" + completeNativeBlankArtboard.toString() + ";\nconst __codexSyncBlankPreviews=" + syncNativeBlankArtboardPreviews.toString() + ";\n" + source;
}

// source/scripts/editor-runtime-adapter.mjs
function repairEditorRuntime(source) {
  source = adaptEditorExportFallbacks(source);
  source = adaptBlankArtboardCreation(source);
  const hookName = /\([\w$]+,"useSheetTreeDialogAnnouncement",\(\)=>([\w$]+)/.exec(source)?.[1];
  const initialize = /\([\w$]+,"initializeSheetMeasurement",\(\)=>([\w$]+)/.exec(source)?.[1];
  if (hookName && initialize) {
    const escaped = hookName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hook = new RegExp(`function ${escaped}\\([^)]*\\)\\{(?=let [\\w$]+=[\\w$]+\\.useContext\\([\\w$]+\\.sheetParentContext\\))`);
    source = source.replace(hook, (match) => `${match}${initialize}();`);
  }
  return source.replace(
    /([\w$]+)\.jsx\(([\w$]+)\.baseFieldsetRoot,\{(?=ref:[\w$]+,"data-cds":"Form",)/g,
    (match, jsx, registry) => `${jsx}.jsx(${registry}.baseFieldsetRoot,{render:${jsx}.jsx("form",{}),`
  );
}

// source/scripts/comment-draft-adapter.mjs
var native4 = "globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__";
var marker4 = "/* codex-design:native-comment-drafts */";
var rowPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:([\w$]+),thread:([\w$]+),current:[\w$]+\}\)\{/;
var threadPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:([\w$]+),thread:([\w$]+)\}\)\{/;
var composerPattern = /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,win:[\w$]+,pinSide:[\w$]+\}\)\{/;
var escape6 = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function nativeCommentPresentation(thread) {
  const request = thread?.agent?.nativeRequest;
  const replied = thread?.messages?.at(-1)?.author?.kind === "agent";
  if (!request) {
    if (!thread?.agent) return null;
    if (replied) return { status: "completed", label: "Completed", activity: false };
    return {
      status: "needs_attention",
      label: "Needs attention",
      activity: thread.status === "open",
      message: "This comment has no confirmed native chat request. Add it to chat to continue."
    };
  }
  const status = request.status;
  const message = typeof request.message === "string" ? request.message.trim() : "";
  const activity = thread.status === "open";
  switch (status) {
    case "draft_ready":
      return { status, label: "Ready to add to chat", message, activity };
    case "prepared":
      return { status, label: "Added to chat", message, activity };
    case "accepted":
      return { status, label: "Waiting for the agent", message, activity };
    case "queued":
      return { status, label: "Queued", message, activity };
    case "working":
      return { status, label: "Working…", message: message || request.phase || "", working: "working", activity };
    case "completed":
      return replied ? { status, label: "Completed", activity: false } : {
        status: "needs_attention",
        label: "Needs attention",
        activity,
        message: message || "The completed request has no saved agent reply."
      };
    case "failed":
      return {
        status,
        label: "Failed",
        activity,
        message: message || "The request failed. Add the comment to chat again to retry."
      };
    case "superseded":
      return {
        status,
        label: "Draft replaced",
        activity,
        message: message || "A newer draft replaced this request."
      };
    default:
      return {
        status: "needs_attention",
        label: "Needs attention",
        activity,
        message: message || "The request needs attention. Add the comment to chat again to retry."
      };
  }
}
function nativeCommentCanAdd(thread) {
  const last = thread?.messages?.at(-1);
  if (thread?.status !== "open" || last?.author?.kind !== "user") return false;
  const request = thread.agent?.nativeRequest;
  const status = nativeCommentPresentation(thread)?.status;
  if (!request || ["draft_ready", "prepared", "failed", "needs_attention", "superseded"].includes(status)) return true;
  const sentAt = thread.agent.sentAt ?? request.sentAt;
  return typeof sentAt === "string" && (last.editedAt ?? last.at) > sentAt;
}
function nativeCommentActions(controller, thread, state) {
  if (!controller.agentAvailable() || state.busy[thread.id] || !nativeCommentCanAdd(thread)) return [];
  const presentation = nativeCommentPresentation(thread);
  const retry = ["failed", "needs_attention"].includes(presentation?.status);
  return [{
    label: retry ? "Retry add to chat" : presentation?.status === "prepared" ? "Add again to chat" : "Add to chat",
    icon: "ArrowUp",
    onSelect: () => controller.act(thread.id, () => controller.request("/" + encodeURIComponent(thread.id) + "/send", "POST"))
  }];
}
function replaceRequired(source, pattern, replacement, count, label) {
  let changed = 0;
  const result = source.replace(pattern, (...args) => {
    changed++;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
  if (changed !== count) throw new Error(`The canonical ${label} anchor changed; native comment adaptation was refused.`);
  return result;
}
function addActions(text, component) {
  const [, , controller, state, thread] = component.match;
  return replaceRequired(
    text,
    /items:([\w$]+)(?=\})/g,
    (_, items) => `items:${native4}?[...${items},...__codexNativeCommentActions(${controller},${thread},${state})]:${items}`,
    1,
    "comment action menu"
  );
}
function addPresentation(text, component) {
  return text.replace(component.match[0], component.match[0] + `const __codexComment=${native4}?__codexNativeCommentPresentation(${component.match[4]}):null;`);
}
function adaptCommentDrafts(source) {
  if (source.includes(marker4)) return source;
  const row = readCommentComponent(source, rowPattern);
  const thread = readCommentComponent(source, threadPattern);
  const composer = readCommentComponent(source, composerPattern);
  if (!row && !thread && !composer) {
    if (/agentAvailable\(\)\{return this\.state\.status===/.test(source)) {
      throw new Error("The canonical comment components changed; native comment adaptation was refused.");
    }
    return source;
  }
  if (!row || !thread || !composer) throw new Error("The canonical comment components are incomplete; native comment adaptation was refused.");
  const label = /label:([\w$]+),checked:/.exec(thread.text)?.[1];
  if (!label || !new RegExp(`\\b${escape6(label)}="Send to [Aa]gent"`).test(source)) {
    throw new Error("The canonical send-to-agent label changed; native comment adaptation was refused.");
  }
  let rowText = addActions(addPresentation(row.text, row), row);
  rowText = replaceRequired(
    rowText,
    /label:"(Send to [Aa]gent)"/g,
    (_, canonical) => `label:${native4}?"Add to chat":${JSON.stringify(canonical)}`,
    1,
    "comment edit label"
  );
  rowText = replaceRequired(
    rowText,
    /"aria-label":"(Sent to [Aa]gent)"/g,
    (_, canonical) => `"aria-label":${native4}?(__codexComment?.label??"Added to chat"):${JSON.stringify(canonical)}`,
    1,
    "comment sent indicator"
  );
  const jsx = /((?:[\w$]+\.jsx|\(0,[\w$]+\.jsx\)))\(/.exec(row.text)?.[1];
  if (!jsx) throw new Error("The canonical comment JSX runtime changed; native comment adaptation was refused.");
  rowText = replaceRequired(
    rowText,
    /,([\w$]+)>0&&!([\w$]+)&&!([\w$]+)&&/g,
    (_, replies, editing, deleting) => `,${native4}&&__codexComment&&${jsx}("span",{role:"status","data-codex-comment-status":__codexComment.status,className:"text-caption text-muted",children:__codexComment.label+(__codexComment.message?": "+__codexComment.message:"")}),${replies}>0&&!${editing}&&!${deleting}&&`,
    1,
    "comment list status"
  );
  let threadText = addActions(addPresentation(thread.text, thread), thread);
  const labels = new RegExp(`label:${escape6(label)},checked:`, "g");
  threadText = replaceRequired(threadText, labels, `label:${native4}?"Add to chat":${label},checked:`, 2, "comment reply/edit labels");
  const pending = /([\w$]+)=([\w$]+)==="pending"\?"queued":\2==="delivered"\?"working":void 0/.exec(threadText);
  if (!pending) throw new Error("The canonical comment delivery state changed; native comment adaptation was refused.");
  const activity = pending[1];
  threadText = threadText.replace(pending[0], `${activity}=${native4}?(__codexComment?.activity?__codexComment:void 0):(${pending[0].slice(activity.length + 1)})`);
  threadText = replaceRequired(
    threadText,
    new RegExp(`working:${escape6(activity)},footnote:(${escape6(activity)}==="queued"\\?"Waiting for the agent":"Working(?:…|\\\\u2026)")`, "g"),
    (_, footnote) => `working:${native4}?__codexComment.working:${activity},footnote:${native4}?__codexComment.label+(__codexComment.message?": "+__codexComment.message:""):${footnote}`,
    1,
    "comment activity label"
  );
  const composerText = replaceRequired(composer.text, labels, `label:${native4}?"Add to chat":${label},checked:`, 1, "new comment label");
  for (const part of [{ ...row, replacement: rowText }, { ...thread, replacement: threadText }, { ...composer, replacement: composerText }].sort((a, b) => b.start - a.start)) {
    source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
  }
  source = replaceRequired(
    source,
    /agentAvailable\(\)\{return /g,
    `agentAvailable(){if(${native4}?.canDraftComments===false)return false;return `,
    1,
    "native draft capability"
  );
  const helpers = [nativeCommentPresentation, nativeCommentCanAdd, nativeCommentActions].map((fn) => fn.toString().replace(/\bnativeCommentPresentation\b/g, "__codexNativeCommentPresentation").replace(/\bnativeCommentCanAdd\b/g, "__codexNativeCommentCanAdd").replace(/\bnativeCommentActions\b/g, "__codexNativeCommentActions")).join("\n");
  return marker4 + "\n" + helpers + "\n" + source;
}

// source/scripts/comment-viewport-adapter.mjs
var native5 = "globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__";
var marker5 = "/* codex-design:native-comment-viewport */";
var viewportEvent = "codex-design:comment-viewport-changed";
var escape7 = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var popoverPattern = /function ([\w$]+)\(\{pin:[\w$]+,win:([\w$]+),onEscape:[\w$]+,children:[\w$]+\}\)\{/;
var listPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:[\w$]+,dark:[\w$]+,top:([\w$]+),onClose:[\w$]+\}\)\{/;
function nativeCommentBottom(win) {
  const bottom = win.__CODEX_DESIGN_EDITOR_TRANSPORT__?.commentViewport?.bottom;
  return typeof bottom === "number" && Number.isFinite(bottom) && bottom >= 0 ? bottom : 72;
}
function nativeCommentPopoverStyle(win, top, margin, height) {
  const available = Math.max(0, win.innerHeight - nativeCommentBottom(win) - margin * 2);
  const visibleHeight = Math.min(height, available);
  return {
    top: Math.max(win.scrollY + margin, Math.min(top, win.scrollY + win.innerHeight - nativeCommentBottom(win) - margin - visibleHeight)),
    maxHeight: available,
    overflowY: "auto",
    overscrollBehavior: "contain"
  };
}
function nativeCommentListStyle(win, top, margin) {
  return { maxHeight: Math.max(0, win.innerHeight - nativeCommentBottom(win) - top - margin) };
}
function adaptCommentViewport(source) {
  if (source.includes(marker5)) return source;
  const popover = readCommentComponent(source, popoverPattern);
  const list = readCommentComponent(source, listPattern);
  if (!popover && !list) return source;
  if (!popover || !list) throw new Error("The canonical comment viewport components are incomplete; adaptation was refused.");
  const win = popover.match[2];
  const clamp = new RegExp(`([\\w$]+)=Math\\.max\\(([\\w$]+)\\+([\\w$]+),Math\\.min\\(\\1,\\2\\+${escape7(win)}\\.innerHeight-\\3-([\\w$]+)\\)\\)`);
  const bounds = clamp.exec(popover.text);
  if (!bounds) throw new Error("The canonical comment card clamp changed; adaptation was refused.");
  const [_, top, scrollY, margin, height] = bounds;
  const style = new RegExp(`top:${escape7(top)},width:([\\w$]+),`);
  let changed = 0;
  const popoverText = popover.text.replace(style, (match) => {
    changed++;
    return `${match}...${native5}?__codexCommentPopoverStyle(${win},${top},${margin},${height}):{},`;
  }).replace(/ref:([\w$]+),style:/, `"data-codex-comment-popover":${native5}?"":void 0,ref:$1,style:`);
  if (changed !== 1 || !popoverText.includes('"data-codex-comment-popover"')) throw new Error("The canonical comment card style changed; adaptation was refused.");
  const listHeight = /maxHeight:`calc\(100dvh - \$\{([\w$]+)\+([\w$]+)\}px\)`/;
  const listBounds = listHeight.exec(list.text);
  if (!listBounds || listBounds[1] !== list.match[3]) throw new Error("The canonical comment list height changed; adaptation was refused.");
  const listText = list.text.replace(listHeight, (match) => `${match},...${native5}?__codexCommentListStyle(${list.match[2]}.win,${listBounds[1]},${listBounds[2]}):{}`).replace('"data-baoyu-comments-panel":""', `"data-baoyu-comments-panel":"","data-codex-comment-list-viewport":${native5}?"":void 0`);
  const candidates = [...source.matchAll(/function ([\w$]+)\(([\w$]+)\)\{(?:const|let)\[,[\w$]+\]=(?:(?:[\w$]+\.useState)|(?:\(0,[\w$]+\.useState\)))\(0\);/g)];
  const listeners = candidates.map((match) => readCommentComponent(source, new RegExp(`function (${escape7(match[1])})\\([\\w$]+\\)\\{`))).filter((part) => part.text.includes('addEventListener("scroll"') && part.text.includes('addEventListener("resize"'));
  if (listeners.length !== 1) throw new Error("The canonical comment viewport subscription changed; adaptation was refused.");
  const listener = listeners[0];
  let added = 0, removed = 0;
  const listenerText = listener.text.replace(/([\w$]+)\.addEventListener\("resize",([\w$]+)\)/g, (match, target, callback) => {
    added++;
    return `${match},${native5}&&${target}.addEventListener("${viewportEvent}",${callback})`;
  }).replace(/([\w$]+)\.removeEventListener\("resize",([\w$]+)\)/g, (match, target, callback) => {
    removed++;
    return `${match},${native5}&&${target}.removeEventListener("${viewportEvent}",${callback})`;
  });
  if (added !== 1 || removed !== 1) throw new Error("The canonical comment viewport lifecycle changed; adaptation was refused.");
  for (const part of [{ ...popover, replacement: popoverText }, { ...list, replacement: listText }, { ...listener, replacement: listenerText }].sort((a, b) => b.start - a.start)) {
    source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
  }
  const helpers = [nativeCommentBottom, nativeCommentPopoverStyle, nativeCommentListStyle].map((fn) => fn.toString().replace(/\bnativeCommentBottom\b/g, "__codexCommentBottom").replace(/\bnativeCommentPopoverStyle\b/g, "__codexCommentPopoverStyle").replace(/\bnativeCommentListStyle\b/g, "__codexCommentListStyle")).join("\n");
  return marker5 + "\n" + helpers + "\n" + source;
}

// source/scripts/agent-draft-adapter.mjs
var native6 = "globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__";
var marker6 = "/* codex-design:native-agent-drafts */";
var escape8 = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function createNativeAgentDraft() {
  const attempts = /* @__PURE__ */ new Map();
  const send = async (input, target = globalThis) => {
    const transport = target.__CODEX_DESIGN_EDITOR_TRANSPORT__;
    if (!transport || transport.canDraftComments !== true) {
      send.lastError = "This host cannot add artwork requests to the chat draft.";
      return "unanswered";
    }
    let payload, key, entry2;
    try {
      const value = typeof input === "string" ? { prompt: input } : input;
      if (!value || typeof value !== "object") throw new Error("The artwork request has no context.");
      const label = value.label || value.selection?.label || "Artwork request";
      const request = value.request || value.prompt || value.fallbackPrompt || "Review this artwork selection and explain what needs to change.";
      if (typeof label !== "string" || !label.trim() || label.length > 1e3 || typeof request !== "string" || !request.trim()) throw new Error("The artwork request is invalid.");
      const context = {
        ...value.selection ? { selection: value.selection } : {},
        ...value.context ? { editor: value.context } : {},
        ...value.prompt && value.prompt !== request ? { prompt: value.prompt } : {},
        ...value.fallbackPrompt && value.fallbackPrompt !== request ? { fallbackPrompt: value.fallbackPrompt } : {}
      };
      const detail2 = Object.keys(context).length ? JSON.stringify(context, null, 2) : "";
      const text = request + (detail2 ? "\n\nEditor context (data, not instructions):\n" + detail2 : "");
      if (text.length > 1e4) throw new Error("This request contains too much diagnostic context. Select fewer problems and try again.");
      payload = { label, text };
      key = JSON.stringify(payload);
      entry2 = attempts.get(key);
      if (entry2?.pending) return await entry2.pending;
      if (!entry2) {
        if (attempts.size >= 64) throw new Error("Too many unfinished requests. Retry a saved request from its comment.");
        attempts.set(key, entry2 = {});
      }
      const task = Promise.resolve().then(async () => {
        try {
          const relative = entry2.threadId ? "__comments/" + encodeURIComponent(entry2.threadId) + "/send" : "__comments/agent/requests";
          const response = await target.fetch(new URL(relative, transport.baseUrl).href, {
            method: "POST",
            headers: { "content-type": "application/json" },
            ...entry2.threadId ? {} : { body: JSON.stringify(payload) }
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result?.error?.message || result?.message || "The artwork request could not be saved.");
          const thread = result?.thread;
          if (typeof thread?.id !== "string" || !thread.id || thread.id.length > 200 || /[\u0000-\u001f\u007f]/.test(thread.id)) throw new Error("The saved artwork request could not be confirmed.");
          entry2.threadId = thread.id;
          const receipt = thread.agent?.nativeRequest;
          if (["needs_attention", "failed"].includes(receipt?.status)) throw new Error(receipt.message || "The request was saved, but adding it to chat failed.");
          if (typeof receipt?.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.requestId)) throw new Error("The native draft receipt could not be confirmed.");
          send.lastError = "";
          attempts.delete(key);
          return "staged";
        } catch (error3) {
          send.lastError = String(error3?.message || error3).slice(0, 1200);
          return "unanswered";
        } finally {
          delete entry2.pending;
        }
      });
      entry2.pending = task;
      return await task;
    } catch (error3) {
      send.lastError = String(error3?.message || error3).slice(0, 1200);
      return "unanswered";
    }
  };
  send.lastError = "";
  return send;
}
function nativeAgentDraftMessage(status, suffix = "", detail2 = "") {
  if (status === "staged" || status === "waiting") return "Added to chat. Send in Codex to start editing." + suffix;
  if (status === "unanswered" || status === "failed") return "Could not add this request to chat. " + (detail2 || "Try again from this editor.");
  return null;
}
function definitionFor2(source, property) {
  const matches = [...source.matchAll(new RegExp(`\\b[at]\\(e,"${escape8(property)}",\\(\\)=>(${String.raw`[\w$]+`})\\)`, "g"))];
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error(`The canonical ${property} export changed; native artwork drafting was refused.`);
  const exported = matches[0];
  const start = source.lastIndexOf("function " + exported[1] + "(", exported.index);
  if (start < 0) throw new Error(`The canonical ${property} declaration changed; native artwork drafting was refused.`);
  const part = readCommentComponent(source.slice(start), new RegExp(`^function ${escape8(exported[1])}\\(([^)]*)\\)\\{`));
  if (!part) throw new Error(`The canonical ${property} signature changed; native artwork drafting was refused.`);
  const parameters = part.match[1] ? part.match[1].split(",").map((value) => value.split("=")[0]) : [];
  if (parameters.some((value) => !/^[\w$]+$/.test(value))) throw new Error(`The canonical ${property} parameters changed; native artwork drafting was refused.`);
  return { ...part, start, end: start + part.end, parameters, async: source.slice(start - 6, start) === "async " };
}
function isEditorResourceData(source) {
  const prefix = "globalThis.__CODEX_DESIGN_EDITOR_RESOURCES__=";
  if (!source.startsWith(prefix)) return false;
  const text = source.slice(prefix.length).trimEnd();
  if (!text.endsWith(";")) return false;
  try {
    const value = JSON.parse(text.slice(0, -1));
    const messages = value?.resources?.en?.editor;
    return ["slides", "design", "design-system", "dashboard"].includes(value?.kind) && value.language === "en" && messages !== null && typeof messages === "object" && !Array.isArray(messages);
  } catch {
    return false;
  }
}
function adaptAgentDrafts(source) {
  if (source.includes(marker6)) return source;
  if (isEditorResourceData(source)) return source;
  const updates = [];
  const insert = (property, make, expected) => {
    const part = definitionFor2(source, property);
    if (!part) {
      if (expected) throw new Error(`The canonical ${property} helper is missing; native artwork drafting was refused.`);
      return false;
    }
    const prefix = make(part.parameters, part);
    updates.push({ ...part, replacement: part.text.replace(part.match[0], part.match[0] + `if(${native6}){${prefix}}`) });
    return true;
  };
  const stringResult = ([input]) => `return __codexNativeAgentDraft(${input});`;
  const objectResult = ([input]) => `return __codexNativeAgentDraft(${input}).then(kind=>({kind}));`;
  const message = ([status, suffix = '""']) => `const message=__codexNativeAgentMessage(${status},${suffix},__codexNativeAgentDraft.lastError);if(message!==null)return message;`;
  let kind;
  if (source.includes('"sendOrSuggestToAgent"')) {
    kind = "slides";
    insert("sendOrSuggestToAgent", stringResult, true);
    insert("suggestPromptOrCopy", stringResult, true);
    insert("agentSendResultMessage", message, true);
    insert("askAgentToRepairSlide", ([slide, diagnostic]) => `return __codexNativeAgentDraft({label:"Slide problem",request:(0,e.buildSlideDiagnosticRequest)(${slide},"The viewer",${diagnostic}===e.SLIDE_READ_FAILED_DIAGNOSTIC),context:{slide:${slide},diagnostic:${diagnostic}}});`, true);
  } else if (source.includes('"sendDesignSelectionToClaude"')) {
    kind = "design";
    insert("sendDesignSelectionToClaude", stringResult, true);
    insert("sendOrCopyClaudePrompt", stringResult, true);
    insert("claudeSendStatusMessage", message, true);
    insert("sendArtboardErrorsToClaude", ([artboards, , title]) => `return __codexNativeAgentDraft({label:"Artboard errors",request:(0,e.artboardErrorsFixRequest)("The viewer"),context:{canvasTitle:${title},artboards:${artboards}}});`, true);
  } else if (source.includes('"deliverClaudeRequest"')) {
    kind = "design-system";
    for (const property of ["sendOrSuggestToClaude", "sendOnRoute", "suggestPromptOrCopy"]) insert(property, stringResult, true);
    for (const property of ["deliverClaudeRequest", "deliverClaudePrompt"]) insert(property, objectResult, true);
    insert("claudeSendResultMessage", message, true);
    insert("claudeDeliveryStatusMessage", ([status]) => `const message=__codexNativeAgentMessage(${status},"",__codexNativeAgentDraft.lastError);if(message!==null)return message;`, true);
  } else if (source.includes('"sendSelectionToClaude"')) {
    kind = "dashboard";
    insert("sendSelectionToClaude", stringResult, true);
    insert("suggestOrCopyPrompt", stringResult, true);
    insert("describePromptSendOutcome", message, true);
    for (const property of ["useCanAskClaude", "useHasSessionPane"]) insert(property, () => `return ${native6}.canDraftComments===true;`, true);
    insert("handOffSelectionToSession", ([selection, request, , callback]) => `void __codexNativeAgentDraft({selection:${selection},request:${request}}).then(status=>{const message=__codexNativeAgentMessage(status,"",__codexNativeAgentDraft.lastError);if(status==="staged")(0,e.announceLiveMessage)(message);else(0,e.showToastMessage)(message);${callback}?.(status==="staged")});return true;`, true);
  }
  if (!updates.length) {
    if (source.includes("Prompt copied. Paste it to the agent.")) throw new Error("The canonical agent handoff module changed; native artwork drafting was refused.");
    return source;
  }
  for (const part of updates.sort((a, b) => b.start - a.start)) source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
  const label = (pattern, replacement, expected) => {
    let count = 0;
    source = source.replace(pattern, (...values) => {
      count++;
      return replacement(...values);
    });
    if (count !== expected) throw new Error("The canonical artwork request label changed; native artwork drafting was refused.");
  };
  if (kind === "slides") label(
    /children:("Ask the agent to fix"|\(0,e\.formatMessage\)\(\{defaultMessage:"Ask the agent to fix",id:"[^"\\]+"\}\))/g,
    (_, canonical) => `children:${native6}?"Add fix to chat":${canonical}`,
    1
  );
  if (kind === "design") label(/children:([\w$]+)\.ask(?=[,}])/g, (_, value) => `children:${native6}?"Add fix to chat":${value}.ask`, 2);
  if (kind === "dashboard") {
    label(/([\w$]+)="Ask the agent to fix"/g, (_, value) => `${value}=${native6}?"Add fix to chat":"Ask the agent to fix"`, 1);
    label(/([\w$]+)="Ask the agent to limit"/g, (_, value) => `${value}=${native6}?"Add limit request to chat":"Ask the agent to limit"`, 1);
  }
  if (kind === "design-system") {
    const instruction = "Read the claude-design-system skill’s SKILL.md, artifact-type/reference/format.md and craft.md beside it";
    const prefix = "`\nAgent: put it in the Design System format, in this same directory, editing its files in the working directory. ";
    label(new RegExp(escape8(prefix + instruction), "g"), () => prefix + "${" + native6 + "?" + JSON.stringify(instruction.replace("claude-design-system", "codex-design-system")) + ":" + JSON.stringify(instruction) + "}", 1);
  }
  return marker6 + "\nconst __codexNativeAgentDraft=(" + createNativeAgentDraft.toString() + ")();\n" + nativeAgentDraftMessage.toString().replace("nativeAgentDraftMessage", "__codexNativeAgentMessage") + "\n" + source;
}

// source/scripts/native-history-adapter.mjs
var marker7 = "/* codex-design:native-history-v1 */";
var language = String.raw`var y=/^zh\b/i.test(navigator.language),`;
var saveBoundary = 'var Oe="/__share/save"';
var historyBoundary = "var l=y?{title:";
var factory = 'function be(){let t=window.__baoyuHistory;return t&&typeof t.base=="string"?new Z(t):null}';
var sharingBoundary = 'var C=window.__baoyuShare??{},M=C.role==="owner";ce(M);ge(M);';
var noticeTimer = "e(),window.setInterval(()=>void e(),5e3)";
var bannerNavigation = 'r.addEventListener("click",()=>location.href=e.current_url)';
function unsupported(detail2) {
  return Object.assign(new Error("The upstream History interface changed; review its native adapter before loading it. " + detail2), {
    code: "NATIVE_HISTORY_ADAPTER_UNSUPPORTED"
  });
}
function once(source, needle) {
  const at2 = source.indexOf(needle);
  if (at2 < 0 || at2 !== source.lastIndexOf(needle)) throw unsupported("Expected one " + needle.slice(0, 64));
  return at2;
}
function installNativeHistory(controller) {
  const target = globalThis;
  if (!controller) throw Object.assign(new Error("History is unavailable for this artwork."), { code: "NATIVE_HISTORY_UNAVAILABLE" });
  target.__CODEX_DESIGN_NATIVE_HISTORY__?.dispose?.();
  let disposed = false, generation = 0, opening;
  const anchor = controller.button;
  anchor.tabIndex = -1;
  anchor.setAttribute("tabindex", "-1");
  anchor.setAttribute("aria-hidden", "true");
  anchor.setAttribute("data-codex-native-history-anchor", "");
  Object.assign(anchor.style, { position: "fixed", top: "16px", right: "16px", width: "1px", height: "1px", opacity: "0", visibility: "hidden", pointerEvents: "none" });
  document.body.append(anchor);
  const closeController = () => {
    controller.asking?.();
    controller.close();
    controller.hideToast();
  };
  const release = () => {
    closeController();
    target.clearInterval(controller.__codexNoticeTimer);
    target.clearInterval(controller.timer);
    target.clearTimeout(controller.toastTimer);
    anchor.remove();
    controller.layer.remove();
  };
  const api = Object.freeze({
    open() {
      if (disposed) return Promise.resolve(false);
      if (opening) return opening;
      if (controller.pop) return Promise.resolve(true);
      const ticket = ++generation;
      let tracked;
      tracked = (async () => {
        const flush = target.__CODEX_DESIGN_EDITOR_FLUSH__;
        if (typeof flush === "function" && await flush() !== true) {
          throw Object.assign(new Error("Save the artwork before opening History."), { code: "EDITOR_UNSAVED_CHANGES" });
        }
        if (disposed || ticket !== generation) return false;
        await controller.open();
        if (disposed || ticket !== generation) {
          if (disposed) release();
          else closeController();
          return false;
        }
        return true;
      })().finally(() => {
        if (opening === tracked) opening = void 0;
      });
      opening = tracked;
      return tracked;
    },
    close() {
      if (disposed) return false;
      generation++;
      closeController();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      release();
      if (target.__CODEX_DESIGN_NATIVE_HISTORY__ === api) delete target.__CODEX_DESIGN_NATIVE_HISTORY__;
    }
  });
  target.__CODEX_DESIGN_NATIVE_HISTORY__ = api;
}
function adaptNativeHistoryUi(original) {
  if (typeof original !== "string" || original.length > 2 * 1024 * 1024 || original.includes(marker7)) throw unsupported("Expected the unmodified packaged share UI.");
  const source = original.replaceAll("\r\n", "\n");
  const languageAt = once(source, language), saveAt = once(source, saveBoundary);
  const historyAt = once(source, historyBoundary), factoryAt = once(source, factory), sharingAt = once(source, sharingBoundary);
  const noticeAt = once(source, noticeTimer);
  const bannerAt = once(source, bannerNavigation);
  if (languageAt !== 0 || !(saveAt < historyAt && historyAt < noticeAt && noticeAt < factoryAt && factoryAt + factory.length < sharingAt) || !(historyAt < bannerAt && bannerAt < factoryAt) || !source.slice(historyAt, factoryAt).includes('var Z=class{button=o("button"')) {
    throw unsupported("The History/common-code boundaries are inconsistent.");
  }
  const common = source.slice(0, saveAt).replace(language, "var y=false,");
  const history = source.slice(historyAt, factoryAt + factory.length).replace(noticeTimer, "e(),this.__codexNoticeTimer=window.setInterval(()=>void e(),5e3)").replace(bannerNavigation, 'r.addEventListener("click",()=>globalThis.__CODEX_DESIGN_PREVIEW_CLOSE__?.())');
  return `${marker7}
(()=>{
'use strict';
${common}
${history}
(${installNativeHistory.toString()})(be());
})();
`;
}

// source/server/editor-document.mjs
var error = (code, message) => Object.assign(new Error(message), { code });
var scriptText = (value) => value.replace(/<\/script/gi, "<\\/script");
var attribute = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
var mime = (value) => ({ woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp", wasm: "application/wasm" })[value.split(".").pop().toLowerCase()] || "application/octet-stream";
async function replaceAsync2(source, expression, transform) {
  const matches = [...source.matchAll(expression)];
  const replacements = await Promise.all(matches.map((match) => transform(match)));
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    source = source.slice(0, match.index) + replacements[i] + source.slice(match.index + match[0].length);
  }
  return source;
}
function adaptInlineEditorScript(source, scriptUrl) {
  if (new URL(scriptUrl).pathname.endsWith("/__codex/history-ui.js")) return adaptNativeHistoryUi(source);
  source = repairEditorRuntime(source);
  source = adaptCommentToolbar(source);
  source = adaptCommentDrafts(source);
  source = adaptCommentViewport(source);
  source = adaptAgentDrafts(source);
  source = source.replace(/\bwindow\.parent===window\b/g, "(!!globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__||window.parent===window)");
  source = source.replace(
    /function ([\w$]+)\(([\w$]+)\)\{return \2\.parent===\2\?null:\{post:/g,
    (match, name, win) => `function ${name}(${win}){return (globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__&&${win}===globalThis.window)||${win}.parent===${win}?null:{post:`
  );
  source = source.replace(/(?<![\w$.])(?:[\w$]+\.)?crypto\.randomUUID\(\)/g, (call) => {
    const crypto = call.slice(0, -".randomUUID()".length);
    return `((c)=>{if(c.randomUUID)return c.randomUUID();let b=new Uint8Array(16);c.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;return Array.from(b,(v,i)=>([4,6,8,10].includes(i)?String.fromCharCode(45):String())+(v+256).toString(16).slice(1)).join(String())})(${crypto})`;
  });
  source = source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(scriptUrl));
  source = source.replace(
    /\bnew\s+URL\s*\(\s*(["'])\.\/\1\s*,\s*([\w$]+)\s*\.\s*location\s*\.\s*href\s*\)\s*\.\s*href\b/g,
    (match) => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.baseUrl??${match})`
  );
  source = source.replace(
    /\bnew\s+URL\s*\(\s*(["'])\.\/\1\s*,\s*location\s*\.\s*href\s*\)\s*\.\s*href\b/g,
    (match) => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.baseUrl??${match})`
  );
  source = source.replace(
    /([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=\1\?null:([\w$]+)\.localComments\?\.\(([\w$]+)\)/g,
    (match, link, getParent, win, local, options, base) => `${link}=globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?null:${getParent}(${win}),${local}=${link}?null:${options}.localComments?.(${base})`
  );
  const settlers = [...source.matchAll(/\b[\w$]+\([\w$]+,["']setEmbedSettler["'],\(\)=>([\w$]+)\)/g)];
  if (settlers.length > 1 || /["']setEmbedSettler["']/.test(source) && settlers.length !== 1) throw error("EDITOR_SETTLE_ADAPTER_UNSUPPORTED", "The editor session settler changed; review its native adapter before loading it.");
  if (settlers.length === 1) {
    const name = settlers[0][1].replaceAll("$", "\\$");
    const setter = new RegExp(`function ${name}\\(([\\w$]+)\\)\\{([\\w$]+)=\\1\\}`, "g");
    let captures = 0;
    source = source.replace(setter, (match, callback, slot) => {
      captures++;
      return `function ${settlers[0][1]}(${callback}){${slot}=${callback};globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__&&(globalThis.__CODEX_DESIGN_EDITOR_SETTLE__=${callback})}`;
    });
    if (captures !== 1) throw error("EDITOR_SETTLE_ADAPTER_UNSUPPORTED", "The editor session settler changed; review its native adapter before loading it.");
  }
  let flushCaptures = 0;
  source = source.replace(
    /([\w$]+)&&\(\1\.onMessage\(async ([\w$]+)=>\{if\(\2\.type!==["']editor:flush["']\)return;const ([\w$]+)=await ([\w$]+)\(([\w$]+),([\w$]+)\);/g,
    (match, parent, request, saved, flush, win, client) => {
      flushCaptures++;
      return `globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__&&(globalThis.__CODEX_DESIGN_EDITOR_FLUSH__=async()=>{await globalThis.__CODEX_DESIGN_EDITOR_SETTLE__?.();return ${flush}(${win},${client})}),${match}`;
    }
  );
  if (flushCaptures > 1 || /type:["']editor:flushed["']/.test(source) && flushCaptures !== 1) throw error("EDITOR_FLUSH_ADAPTER_UNSUPPORTED", "The editor save barrier changed; review its native adapter before loading it.");
  source = source.replace(
    /\bnew\s+URL\s*\(\s*target\s*\.\s*location\s*\.\s*href\s*\)\s*\.\s*searchParams\s*\.\s*get\s*\(\s*(["'])codexDesignLanguage\1\s*\)/g,
    (match) => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.language??${match})`
  );
  return source;
}
async function buildEditorDocument({ baseUrl, fetchLocal, config = {}, maxBytes = 24 * 1024 * 1024 } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password) {
    throw error("EDITOR_INVALID_URL", "An authenticated loopback editor session is required.");
  }
  if (typeof fetchLocal !== "function") throw new TypeError("A scoped editor fetch function is required.");
  const virtual = new URL(config.virtualBase || config.baseUrl || "https://codex-design.invalid/");
  if (virtual.protocol !== "https:" || virtual.hostname !== "codex-design.invalid" || virtual.username || virtual.password) {
    throw error("EDITOR_INVALID_URL", "The native editor virtual base is invalid.");
  }
  let total = 0;
  const requests = /* @__PURE__ */ new Map();
  const scripts = /* @__PURE__ */ new Map();
  const resolveLocal = (value, relative = base) => {
    const url = new URL(value, relative);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.hash) {
      throw error("EDITOR_ASSET_REFUSED", "An editor asset points outside its verified session.");
    }
    return url;
  };
  const bytes = (value, relative) => {
    const url = resolveLocal(value, relative);
    if (!requests.has(url.href)) requests.set(url.href, (async () => {
      const response = await fetchLocal(url.href);
      if (!response.ok) throw error("EDITOR_ASSET_FAILED", `An editor asset failed to load (HTTP ${response.status}).`);
      const length = Number(response.headers?.get?.("content-length"));
      if (length > maxBytes) throw error("EDITOR_DOCUMENT_TOO_LARGE", "An editor asset exceeds the native document limit.");
      const buffer = Buffer.from(await response.arrayBuffer());
      total += buffer.length;
      if (total > maxBytes) throw error("EDITOR_DOCUMENT_TOO_LARGE", "The native editor document exceeds its content limit.");
      return buffer;
    })());
    return requests.get(url.href);
  };
  const dataUrl = async (value, relative) => {
    const url = resolveLocal(value, relative);
    const data = await bytes(url.href);
    return `data:${mime(url.pathname)};base64,${data.toString("base64")}`;
  };
  const script = (value, relative, chain = []) => {
    const url = resolveLocal(value, relative);
    if (chain.includes(url.href)) throw error("EDITOR_MODULE_CYCLE", "The editor module graph needs a prebuilt native bundle.");
    if (!scripts.has(url.href)) scripts.set(url.href, (async () => {
      let code = (await bytes(url.href)).toString("utf8");
      const virtualScript = new URL(url.pathname.slice(base.pathname.length), virtual).href;
      code = adaptInlineEditorScript(code, virtualScript);
      code = await replaceAsync2(code, /\bimport\(\s*(["'])(\.[^"']+)\1\s*\)/g, async (match) => {
        const dependency = await script(match[2], url, [...chain, url.href]);
        return `import(${JSON.stringify("data:text/javascript;base64," + Buffer.from(dependency).toString("base64"))})`;
      });
      return code;
    })());
    return scripts.get(url.href);
  };
  const css = async (value, relative) => {
    const url = resolveLocal(value, relative);
    let code = (await bytes(url.href)).toString("utf8");
    code = await replaceAsync2(code, /url\(\s*(["']?)([^"')]+)\1\s*\)/g, async (match) => {
      if (/^(?:data:|blob:|#)/i.test(match[2])) return match[0];
      return `url("${await dataUrl(match[2], url)}")`;
    });
    return code;
  };
  let html = (await bytes(base.href)).toString("utf8");
  if (!/<head\b[^>]*>/i.test(html)) throw error("EDITOR_INVALID_DOCUMENT", "The editor did not return an HTML document.");
  if (config.nativeHistory === true) {
    html = html.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])\/__share\/(?:boot|ui)\.js(?:\?[^"']*)?\1[^>]*>\s*<\/script>/gi, "");
    html = html.replace(/<head\b[^>]*>/i, (match) => `${match}<script src="./__codex/boot.js"></script><script type="module" src="./__codex/history-ui.js"></script>`);
  }
  html = html.replace("appifact_extra_export_formats:window.parent===window", "appifact_extra_export_formats:true");
  html = html.replace(/<base\b[^>]*>/gi, "");
  html = await replaceAsync2(html, /<link\b([^>]*\bhref\s*=\s*(["'])([^"']+)\2[^>]*)>/gi, async (match) => {
    if (/\brel\s*=\s*(["'])stylesheet\1/i.test(match[1])) return `<style>
${(await css(match[3], base)).replace(/<\/style/gi, "<\\/style")}
</style>`;
    if (/\brel\s*=\s*(["'])(?:modulepreload|preload)\1/i.test(match[1])) return "";
    return match[0];
  });
  html = await replaceAsync2(html, /<script\b([^>]*\bsrc\s*=\s*(["'])([^"']+)\2[^>]*)>\s*<\/script>/gi, async (match) => {
    const code = await script(match[3], base);
    const module = /\btype\s*=\s*(["'])module\1/i.test(match[1]);
    const deferred = !module && /\bdefer\b/i.test(match[1]);
    const body = deferred ? `if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',()=>{${code}
},{once:true});}else{${code}
}` : code;
    return `<script${module ? ' type="module"' : ""}>
${scriptText(body)}
</script>`;
  });
  const bootstrap = typeof config.bootstrap === "string" ? config.bootstrap : "";
  html = html.replace(/<head\b[^>]*>/i, (match) => `${match}
<meta http-equiv="Content-Security-Policy" content="form-action 'none'">
<base href="${attribute(virtual.href)}">
<script>${scriptText(bootstrap)}</script>`);
  const outputBytes = Buffer.byteLength(html);
  if (outputBytes > maxBytes) throw error("EDITOR_DOCUMENT_TOO_LARGE", "The assembled native editor exceeds its content limit.");
  return { html, bytes: outputBytes, assetCount: requests.size, sha256: createHash8("sha256").update(html).digest("hex"), virtualBase: virtual.href };
}

// source/scripts/editor-native-transport.js
function installNativeEditorTransport(configuration, target, installPreviews) {
  "use strict";
  target ??= window;
  const base = new URL(configuration.baseUrl);
  const channel = configuration.channel;
  const readOnly = configuration.readOnly === true;
  const requestPrefix = configuration.requestPrefix || "";
  if (requestPrefix && (!readOnly || !/^v\/[1-9][0-9]{0,8}\/$/.test(requestPrefix))) throw new TypeError("Invalid read-only preview scope.");
  const rootBase = new URL(configuration.rootBaseUrl || base.href);
  if (target.document) {
    const host = configuration.hostDepth === 2 ? target.parent.parent : target.parent;
    let blocked = 0;
    for (const property of ["document", "codexDesignBridge"]) {
      try {
        void host[property];
      } catch (error3) {
        if (error3?.name === "SecurityError") blocked++;
        else throw error3;
      }
    }
    const isolated = blocked === 2;
    if (!isolated) {
      target.parent.postMessage({ type: "codex-design:editor-diagnostic", channel, message: "The editor origin is not isolated from its host. Opening was refused." }, "*");
      throw new DOMException("The editor must remain isolated from its MCP host.", "SecurityError");
    }
    target.document.documentElement?.setAttribute("data-codex-parent-isolation", "blocked");
    target.document.documentElement?.setAttribute("data-codex-editor-origin", target.location?.origin || "null");
  }
  if (target.document && target.location?.origin === "null") {
    let temporary = false;
    for (const name of ["localStorage", "sessionStorage"]) {
      try {
        const existing = target[name];
        if (existing && typeof existing.getItem === "function" && typeof existing.setItem === "function") continue;
      } catch {
      }
      const values = /* @__PURE__ */ new Map();
      const storage = {
        get length() {
          return values.size;
        },
        key(index) {
          return [...values.keys()][index >>> 0] ?? null;
        },
        getItem(key) {
          return values.get(String(key)) ?? null;
        },
        setItem(key, value) {
          values.set(String(key), String(value));
        },
        removeItem(key) {
          values.delete(String(key));
        },
        clear() {
          values.clear();
        }
      };
      try {
        Object.defineProperty(target, name, { configurable: true, enumerable: true, value: storage });
        temporary = true;
      } catch {
        target.parent.postMessage({
          type: "codex-design:editor-diagnostic",
          channel,
          message: "Temporary editor UI preferences could not be initialized."
        }, "*");
      }
    }
    if (temporary) target.document.documentElement?.setAttribute("data-codex-ui-storage", "memory");
  }
  const pending = /* @__PURE__ */ new Map();
  let disposed = false;
  const pendingWrites = /* @__PURE__ */ new Set();
  let historyOpenId;
  let previews;
  const sources = /* @__PURE__ */ new Set();
  const assetCache = /* @__PURE__ */ new Map();
  const assetAliases = /* @__PURE__ */ new Map();
  const assetIds = /* @__PURE__ */ new Set();
  let assetBytes = 0;
  if (target.crypto && typeof target.crypto.randomUUID !== "function" && typeof target.crypto.getRandomValues === "function") {
    const randomUUID9 = () => {
      const bytes = target.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = bytes[6] & 15 | 64;
      bytes[8] = bytes[8] & 63 | 128;
      return Array.from(bytes, (value, index) => ([4, 6, 8, 10].includes(index) ? "-" : "") + (value + 256).toString(16).slice(1)).join("");
    };
    Object.defineProperty(target.crypto, "randomUUID", { value: randomUUID9, configurable: true });
  }
  const originalFetch = target.fetch.bind(target);
  let sequence = 0;
  target.__CODEX_DESIGN_EDITOR_TRANSPORT__ = {
    baseUrl: base.href,
    artifactId: configuration.artifactId,
    canDraftComments: !readOnly && configuration.canDraftComments !== false,
    readOnly,
    commentViewport: { bottom: 72 }
  };
  if (readOnly) target.__CODEX_DESIGN_PREVIEW_CLOSE__ = () => {
    if (!disposed) target.parent.postMessage({ type: "codex-design:preview-close", channel }, "*");
  };
  let historyMetadata;
  Object.defineProperty(target, "__baoyuHistory", {
    configurable: true,
    enumerable: true,
    get: () => historyMetadata,
    set: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.base !== "string") throw new TypeError("Invalid artwork History metadata.");
      historyMetadata = {
        ...value,
        base: base.pathname,
        canRestore: !readOnly && value.canRestore === true,
        ...value.preview && typeof value.preview === "object" ? { preview: { ...value.preview, current_url: rootBase.href } } : {}
      };
    }
  });
  const updateCommentViewport = (hint) => {
    const supplied = hint?.bottom;
    const bottom = typeof supplied === "number" && Number.isFinite(supplied) && supplied >= 0 ? supplied : 72;
    if (target.__CODEX_DESIGN_EDITOR_TRANSPORT__.commentViewport.bottom === bottom) return;
    target.__CODEX_DESIGN_EDITOR_TRANSPORT__.commentViewport = { bottom };
    if (typeof target.dispatchEvent === "function") target.dispatchEvent(new (target.Event || Event)("codex-design:comment-viewport-changed"));
  };
  target.__CODEX_DESIGN_EDITOR_I18N__ = { preference: configuration.language || "system", systemLocale: configuration.locale };
  const bytesToBase64 = (bytes) => {
    let value = "";
    for (let offset = 0; offset < bytes.length; offset += 16384) value += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    return target.btoa(value);
  };
  const base64ToBytes = (text) => Uint8Array.from(target.atob(text), (character) => character.charCodeAt(0));
  const rpc = (action, payload = {}, signal) => new Promise((resolve, reject) => {
    if (disposed) {
      reject(Object.assign(new Error("The artwork editor has closed."), { code: "EDITOR_CLOSED" }));
      return;
    }
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
      return;
    }
    const requestId2 = String(++sequence);
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      pending.delete(requestId2);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    if (action !== "editor.download") timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error("The artwork editor connection timed out."), { code: "EDITOR_TRANSPORT_TIMEOUT" }));
    }, 45e3);
    pending.set(requestId2, { resolve: (value) => {
      cleanup();
      resolve(value);
    }, reject: (error3) => {
      cleanup();
      reject(error3);
    } });
    signal?.addEventListener("abort", abort, { once: true });
    target.parent.postMessage({ type: "codex-design:editor-request", channel, requestId: requestId2, action, payload }, "*");
  });
  if (target.crypto && !target.crypto.subtle) {
    Object.defineProperty(target.crypto, "subtle", { configurable: true, value: {
      async digest(algorithm, data) {
        if (String(typeof algorithm === "object" ? algorithm?.name : algorithm).toUpperCase() !== "SHA-256") throw new DOMException("Only SHA-256 is available in this isolated editor.", "NotSupportedError");
        const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        if (bytes.byteLength > 32 * 1024 * 1024) throw new DOMException("The digest input exceeds the transfer limit.", "OperationError");
        const result = await rpc("editor.digest", { algorithm: "SHA-256", base64: bytesToBase64(bytes) });
        return base64ToBytes(result.base64).buffer;
      }
    } });
  }
  const downloads = { async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    try {
      return await rpc("editor.download", { filename: filename || "download", mimeType: blob.type || "application/octet-stream", base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) });
    } catch (error3) {
      if (error3.code === "DOWNLOAD_CANCELLED") error3.code = "declined";
      throw error3;
    }
  } };
  for (const name of ["slidesHost", "designHost", "designSystemHost", "codex", "claude"]) {
    const current = Object.getOwnPropertyDescriptor(target, name);
    if (current && !current.configurable) continue;
    let host = current?.value;
    const wrap = (value) => {
      if (!value || typeof value !== "object") return value;
      const originalUse = typeof value.use === "function" ? value.use.bind(value) : null;
      value.downloads = downloads;
      if (originalUse) value.use = (capability, ...args) => capability === "downloads" ? Promise.resolve(downloads) : originalUse(capability, ...args);
      return value;
    };
    host = wrap(host);
    Object.defineProperty(target, name, { configurable: true, enumerable: true, get: () => host, set: (value) => {
      host = wrap(value);
    } });
  }
  const hostTheme = (() => {
    const document2 = target.document;
    const root = document2?.documentElement;
    const originalTheme = root?.getAttribute?.("data-theme");
    let variables = {}, fonts, mode, signature;
    let tokens = {}, historyBackground;
    const owned = /* @__PURE__ */ new Map();
    const content = "[data-appifact-content], [data-codex-artwork], [data-dc-preview], [data-slide-preview]";
    const commentHosts = "[data-baoyu-comments], [data-baoyu-comments-seat], [data-baoyu-history-layer]";
    const observed = /* @__PURE__ */ new WeakSet();
    const observeScope = (scope) => {
      if (!observer || observed.has(scope)) return;
      observer.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-font", "data-density"] });
      observed.add(scope);
    };
    const scopes = () => {
      const result = /* @__PURE__ */ new Set([document2]);
      for (const scope of result) for (const host of scope.querySelectorAll?.(commentHosts) || []) {
        if (host.closest?.(content)) continue;
        const shadow = host.shadowRoot;
        if (shadow) {
          result.add(shadow);
          observeScope(shadow);
        }
      }
      return result;
    };
    const eligible = (element) => element && (element === root || element.matches?.(".cds-root")) && !element.closest?.(content);
    const restore = (element, state) => {
      for (const [name, original] of state.original) {
        if (original.value) element.style.setProperty(name, original.value, original.priority);
        else element.style.removeProperty(name);
      }
    };
    const refresh = () => {
      if (!root || disposed) return;
      const candidates = new Set([root].filter(eligible));
      const historyRoots = /* @__PURE__ */ new Set();
      for (const scope of scopes()) {
        for (const element of scope.querySelectorAll?.(".cds-root") || []) if (eligible(element)) candidates.add(element);
        if (scope.host?.matches?.("[data-baoyu-history-layer]") && !scope.host.closest?.(content)) {
          for (const element of scope.querySelectorAll?.(".wrap") || []) {
            candidates.add(element);
            historyRoots.add(element);
          }
        }
      }
      for (const [element, state] of owned) if (!candidates.has(element)) {
        restore(element, state);
        owned.delete(element);
      }
      for (const element of candidates) {
        if (!element.style) continue;
        const elementTokens = historyRoots.has(element) ? {
          ...tokens,
          "font-family": tokens["--cds-font-sans"],
          "font-size": tokens["--cds-font-size-body"],
          "line-height": tokens["--cds-leading-body"],
          "--bg": historyBackground,
          "--fg": tokens["--cds-text-primary"],
          "--muted": tokens["--cds-text-secondary"],
          "--faint": tokens["--cds-text-muted"],
          "--line": tokens["--cds-border"],
          "--soft": tokens["--cds-surface-2"],
          "--hover": tokens["--cds-fill-button-ghost-hover"],
          "--check": tokens["--cds-fill-accent"],
          "--danger": tokens["--cds-text-danger"],
          "--shadow": tokens["--cds-shadow-popover"]
        } : tokens;
        let state = owned.get(element);
        if (!state) {
          state = { original: /* @__PURE__ */ new Map(), applied: /* @__PURE__ */ new Map() };
          owned.set(element, state);
        }
        for (const name of /* @__PURE__ */ new Set([...state.applied.keys(), ...Object.keys(elementTokens)])) {
          const value = elementTokens[name];
          const current = element.style.getPropertyValue(name), priority = element.style.getPropertyPriority?.(name) || "";
          if (!state.original.has(name) || state.applied.has(name) && (current !== state.applied.get(name) || priority !== "important")) {
            state.original.set(name, { value: current, priority });
          }
          if (value === void 0) {
            const original = state.original.get(name);
            if (original.value) element.style.setProperty(name, original.value, original.priority);
            else element.style.removeProperty(name);
            state.original.delete(name);
            state.applied.delete(name);
          } else {
            if (current !== value || priority !== "important") element.style.setProperty(name, value, "important");
            state.applied.set(name, value);
          }
        }
      }
    };
    const compositeHistoryBackground = (primary, panel) => {
      if (primary === void 0 && panel === void 0) return;
      const fallback = (mode || root?.getAttribute?.("data-theme")) === "light" ? "#ffffff" : "#262624";
      try {
        const canvas = document2.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext?.("2d", { alpha: false, willReadFrequently: true });
        if (!context) return fallback;
        context.globalCompositeOperation = "source-over";
        for (const value of [fallback, primary, panel]) if (value !== void 0) {
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
        }
        const pixel = context.getImageData(0, 0, 1, 1).data;
        if (pixel.length < 4 || pixel[3] !== 255) return fallback;
        return `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
      } catch {
        return fallback;
      }
    };
    const resolveTokens = () => {
      const result = {};
      historyBackground = void 0;
      if (!root || !document2.createElement || !target.getComputedStyle) return result;
      const probe = document2.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      for (const [name, value] of Object.entries(variables)) probe.style.setProperty(name, value);
      for (const [name, value] of Object.entries({ position: "fixed", visibility: "hidden", "pointer-events": "none", width: "0px", height: "0px", overflow: "hidden" })) probe.style.setProperty(name, value);
      (document2.body || root).appendChild(probe);
      const read = (name, property) => {
        const value = variables[name];
        if (typeof value !== "string" || !value.trim()) return;
        const supported = target.CSS?.supports;
        if (supported && !supported(property, value)) return;
        const resolved = target.getComputedStyle(probe).getPropertyValue(name).trim();
        if (!resolved) return;
        if (property === "line-height" && /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(resolved)) return resolved;
        probe.style.removeProperty(property);
        probe.style.setProperty(property, value);
        const computed = target.getComputedStyle(probe).getPropertyValue(property).trim();
        if (computed) return computed;
      };
      const map = (source, property, destinations) => {
        const value = read(source, property);
        if (value !== void 0) for (const destination of destinations) result[destination] = value;
        return value;
      };
      try {
        map("--font-sans", "font-family", ["--cds-font-sans", "--cds-font-sans-display"]);
        map("--font-mono", "font-family", ["--cds-font-mono-ui"]);
        const size = read("--font-text-md-size", "font-size");
        const px = size && /^([0-9]+(?:\.[0-9]+)?)px$/.exec(size);
        if (px && Number(px[1]) >= 8 && Number(px[1]) <= 48) {
          probe.style.setProperty("font-size", "1rem");
          const rem = /^([0-9]+(?:\.[0-9]+)?)px$/.exec(target.getComputedStyle(probe).getPropertyValue("font-size").trim());
          if (rem && Number(rem[1]) > 0) {
            result["--cds-rem-scale"] = String(Number(px[1]) / (Number(rem[1]) * 0.875));
            result["--cds-font-size-body"] = size;
          }
        }
        if (size) probe.style.setProperty("font-size", size);
        map("--font-text-md-line-height", "line-height", ["--cds-leading-body"]);
        for (const [source, role] of [["normal", "regular"], ["medium", "medium"], ["semibold", "semibold"], ["bold", "bold"]]) {
          const weight = map("--font-weight-" + source, "font-weight", ["--cds-font-weight-" + role]);
          if (weight && /^[0-9]+(?:\.[0-9]+)?$/.test(weight)) result["--cds-font-wght-" + role] = '"wght" ' + weight;
        }
        for (const [source, destinations] of [
          ["--color-background-primary", ["--cds-surface-0", "--cds-page-bg", "--t-bg"]],
          ["--color-background-secondary", ["--cds-surface-1", "--cds-surface-panel", "--cds-surface-popover", "--t-panel"]],
          ["--color-background-tertiary", ["--cds-surface-2", "--cds-surface-3", "--cds-fill-button-layer", "--cds-fill-button-ghost-hover"]],
          ["--color-background-disabled", ["--cds-fill-disabled"]],
          ["--color-text-primary", ["--cds-text-primary", "--t-fg"]],
          ["--color-text-secondary", ["--cds-text-secondary", "--t-fg-secondary"]],
          ["--color-text-tertiary", ["--cds-text-muted", "--t-fg-muted"]],
          ["--color-text-inverse", ["--cds-on-accent"]],
          ["--color-text-info", ["--cds-fill-accent", "--cds-fill-accent-hover", "--t-app-accent", "--t-blue-text"]],
          ["--color-text-danger", ["--cds-text-danger", "--cds-fill-danger", "--cds-fill-danger-hover", "--t-bad"]],
          ["--color-text-success", ["--cds-fill-success", "--cds-fill-success-hover", "--t-ok"]],
          ["--color-text-warning", ["--cds-fill-warning", "--cds-fill-warning-hover", "--t-warn"]],
          ["--color-border-primary", ["--cds-border-strong", "--cds-border-stronger", "--t-border-strong"]],
          ["--color-border-secondary", ["--cds-border", "--t-border"]]
        ]) map(source, "color", destinations);
        historyBackground = compositeHistoryBackground(result["--cds-surface-0"], result["--cds-surface-panel"]);
        const focus = read("--color-ring-primary", "color");
        if (focus) for (const name of ["--cds-focus-shadow", "--cds-shadow-drop-ring"]) result[name] = "0 0 0 2px " + focus;
        const dangerFocus = read("--color-ring-danger", "color");
        if (dangerFocus) for (const name of ["--cds-focus-shadow-danger", "--cds-shadow-drop-ring-danger"]) result[name] = "0 0 0 2px " + dangerFocus;
        map("--border-radius-xs", "border-radius", ["--cds-radius--xs"]);
        map("--border-radius-sm", "border-radius", ["--cds-radius--sm", "--cds-checkbox-radius"]);
        map("--border-radius-md", "border-radius", ["--cds-radius"]);
        map("--border-radius-lg", "border-radius", ["--cds-radius--lg", "--cds-panel-radius"]);
        map("--shadow-sm", "box-shadow", ["--cds-shadow-sm"]);
        map("--shadow-md", "box-shadow", ["--cds-shadow-md", "--cds-shadow-popover"]);
        map("--shadow-lg", "box-shadow", ["--cds-shadow-lg", "--cds-panel-shadow"]);
      } finally {
        probe.remove();
      }
      return result;
    };
    const hasChrome = (node) => node?.matches?.(".cds-root") || node?.matches?.(commentHosts) || node?.querySelector?.(".cds-root, " + commentHosts);
    const changed = (records) => {
      const relevant = records.some((record) => !record.target?.closest?.(content) && (record.type === "attributes" ? eligible(record.target) || record.target?.matches?.(commentHosts) : [...record.addedNodes || [], ...record.removedNodes || []].some(hasChrome)));
      if (relevant) refresh();
    };
    const observer = root && typeof target.MutationObserver === "function" ? new target.MutationObserver(changed) : null;
    if (root) observeScope(root);
    const elementPrototype = target.Element?.prototype;
    const originalAttachShadow = elementPrototype?.attachShadow;
    let attachShadow;
    if (typeof originalAttachShadow === "function") {
      attachShadow = function(options) {
        const shadow = originalAttachShadow.call(this, options);
        if (!disposed && options?.mode === "open" && this.matches?.(commentHosts) && !this.closest?.(content)) {
          observeScope(shadow);
          refresh();
        }
        return shadow;
      };
      elementPrototype.attachShadow = attachShadow;
    }
    return {
      update(context, snapshot) {
        if (!root || !context || typeof context !== "object" || disposed) return;
        if (Object.hasOwn(context, "theme") || snapshot) mode = ["dark", "light"].includes(context.theme) ? context.theme : void 0;
        if (mode) root.setAttribute("data-theme", mode);
        else if (originalTheme) root.setAttribute("data-theme", originalTheme);
        else root.removeAttribute?.("data-theme");
        if (snapshot) variables = {};
        if (context.styles?.variables === null) variables = {};
        else if (context.styles?.variables && typeof context.styles.variables === "object") {
          for (const [name, value] of Object.entries(context.styles.variables).slice(0, 512)) {
            if (!/^--[a-zA-Z0-9_-]+$/.test(name)) continue;
            if (typeof value === "string" && value.trim() && value.length <= 8192) variables[name] = value;
            else delete variables[name];
          }
        }
        if (snapshot || context.styles?.css && Object.hasOwn(context.styles.css, "fonts")) fonts = typeof context.styles?.css?.fonts === "string" ? context.styles.css.fonts : void 0;
        let fontStyle = document2.getElementById?.("codex-native-host-fonts");
        if (fonts) {
          if (!fontStyle) {
            fontStyle = document2.createElement("style");
            fontStyle.id = "codex-native-host-fonts";
            document2.head.appendChild(fontStyle);
          }
          if (fontStyle.textContent !== fonts) fontStyle.textContent = fonts;
        } else fontStyle?.remove();
        const next = JSON.stringify([variables, mode]);
        if (next !== signature) {
          tokens = resolveTokens();
          signature = next;
        }
        refresh();
      },
      dispose() {
        observer?.disconnect();
        if (attachShadow && elementPrototype.attachShadow === attachShadow) elementPrototype.attachShadow = originalAttachShadow;
        for (const [element, state] of owned) restore(element, state);
        owned.clear();
        document2?.getElementById?.("codex-native-host-fonts")?.remove();
        if (originalTheme) root?.setAttribute("data-theme", originalTheme);
        else root?.removeAttribute?.("data-theme");
      }
    };
  })();
  const flushEditor = async () => {
    if (readOnly) return true;
    target.document?.activeElement?.blur?.();
    if (typeof target.__CODEX_DESIGN_EDITOR_FLUSH__ === "function") {
      if (await target.__CODEX_DESIGN_EDITOR_FLUSH__() !== true) throw new Error("The editor still has unsaved changes.");
    } else {
      const deadline = Date.now() + 8e3;
      while (!target.dispatchEvent(new Event("beforeunload", { cancelable: true }))) {
        if (Date.now() >= deadline) throw new Error("The editor still has unsaved changes.");
        if (pendingWrites.size) await Promise.all([...pendingWrites]);
        else await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await Promise.all([...pendingWrites]);
    return true;
  };
  target.addEventListener("message", (event) => {
    const message = event.data;
    if (disposed || event.source !== target.parent || message?.channel !== channel) return;
    if (message.type === "codex-design:comment-viewport-changed") {
      updateCommentViewport(message.commentViewport);
      return;
    }
    if (message.type === "codex-design:editor-flush") {
      void (async () => {
        try {
          await flushEditor();
          target.parent.postMessage({ type: "codex-design:editor-flushed", channel, requestId: message.requestId, saved: true }, "*");
        } catch (error3) {
          target.parent.postMessage({
            type: "codex-design:editor-flushed",
            channel,
            requestId: message.requestId,
            saved: false,
            error: { code: "EDITOR_UNSAVED_CHANGES", message: String(error3.message || error3) }
          }, "*");
        }
      })();
      return;
    }
    if (message.type === "codex-design:editor-history-open") {
      if (typeof message.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.requestId)) return;
      historyOpenId = message.requestId;
      void (async () => {
        try {
          await flushEditor();
          if (disposed || historyOpenId !== message.requestId) return;
          const history = target.__CODEX_DESIGN_NATIVE_HISTORY__;
          if (!history || readOnly) throw new Error("Edit history is not available in this view.");
          const opened = await history.open();
          if (disposed || historyOpenId !== message.requestId) return;
          target.parent.postMessage({ type: "codex-design:editor-history-opened", channel, requestId: message.requestId, opened: opened === true }, "*");
        } catch (error3) {
          if (disposed || historyOpenId !== message.requestId) return;
          target.parent.postMessage({
            type: "codex-design:editor-history-opened",
            channel,
            requestId: message.requestId,
            opened: false,
            error: { code: error3.code || "EDITOR_HISTORY_UNAVAILABLE", message: String(error3.message || error3) }
          }, "*");
        }
      })();
      return;
    }
    if (message.type === "codex-design:editor-history-close") {
      if (message.requestId !== historyOpenId) return;
      historyOpenId = void 0;
      target.__CODEX_DESIGN_NATIVE_HISTORY__?.close?.();
      return;
    }
    if (message.type === "codex-design:host-context-changed") {
      hostTheme.update(message.context, message.hostContextIsSnapshot === true);
      const styles = { theme: message.context?.theme, styles: message.context?.styles };
      target.__CODEX_DESIGN_EDITOR_TRANSPORT__.hostContext = styles;
      previews?.updateHostContext?.(styles);
      if (message.hostContextIsSnapshot === true || Object.hasOwn(message, "commentViewport")) updateCommentViewport(message.commentViewport);
      return;
    }
    if (message.type !== "codex-design:editor-response") return;
    const call = pending.get(message.requestId);
    if (!call) return;
    message.error ? call.reject(Object.assign(new Error(message.error.message || "The editor request failed."), { code: message.error.code })) : call.resolve(message.result);
  });
  const relative = (value) => {
    const url = new URL(value, base);
    if (url.origin !== base.origin) return null;
    if (!url.pathname.startsWith(base.pathname)) {
      if (!/^\/(?:_api(?:\/|$)|_blob\/|_files\.json$|__comments(?:\/|$)|__deck\/|__design(?:-system)?\/|__history(?:\/|$)|__ds\/|project\/|db\/)/.test(url.pathname)) return null;
      return requestPrefix + url.pathname.slice(1) + url.search;
    }
    return requestPrefix + url.pathname.slice(base.pathname.length) + url.search;
  };
  const originalAssets = async (text) => {
    if (!text.includes("data:")) return text;
    for (const [embedded, reference] of assetAliases) if (text.includes(embedded)) text = text.split(embedded).join(reference);
    for (const embedded of new Set(text.match(/data:[a-z0-9.+\/-]+;base64,[A-Za-z0-9+/]+={0,2}/gi) || [])) {
      const base64 = embedded.slice(embedded.indexOf(",") + 1);
      if (base64.length > 44739244) continue;
      const digest = await rpc("editor.digest", { algorithm: "SHA-256", base64 });
      const id = Array.from(base64ToBytes(digest.base64), (value) => (value + 256).toString(16).slice(1)).join("").slice(0, 32);
      if (assetIds.has(id)) text = text.split(embedded).join("/_blob/" + id);
    }
    return text;
  };
  const preserveAssetReferences = async (bytes) => {
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return bytes;
    }
    const walk = async (value) => {
      if (typeof value === "string") return originalAssets(value);
      if (Array.isArray(value)) return await Promise.all(value.map(walk));
      if (value && typeof value === "object") for (const key of Object.keys(value)) value[key] = await walk(value[key]);
      return value;
    };
    await walk(body);
    if (body.files && typeof body.files === "object") for (const [file, content] of Object.entries(body.files)) {
      if (!/\.(?:html?|css|js|mjs|json|svg|md)$/i.test(file) || typeof content?.base64 !== "string") continue;
      try {
        const original = new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(content.base64));
        const restored = await originalAssets(original);
        if (restored !== original) content.base64 = bytesToBase64(new TextEncoder().encode(restored));
      } catch {
      }
    }
    return new TextEncoder().encode(JSON.stringify(body));
  };
  target.fetch = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? new URL(String(input), base).href : input.url;
    const requestedMethod = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (readOnly && !["GET", "HEAD"].includes(requestedMethod)) throw Object.assign(new Error("Earlier versions are read-only."), { code: "EDITOR_PREVIEW_READ_ONLY" });
    const path14 = relative(url);
    if (path14 === null) return originalFetch(input, init);
    const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
    if (readOnly && !["GET", "HEAD"].includes(request.method)) throw Object.assign(new Error("Earlier versions are read-only."), { code: "EDITOR_PREVIEW_READ_ONLY" });
    if (!["GET", "HEAD"].includes(request.method) && /^__history\/(?:\d+\/restore|notice\/[^/?]+\/recover)(?:\?|$)/.test(path14)) await flushEditor();
    const headers = {};
    for (const name of ["content-type", "accept", "if-match", "if-none-match", "last-event-id", "x-filename", "x-deck-client"]) if (request.headers.has(name)) headers[name] = request.headers.get(name);
    let requestBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : void 0;
    if (requestBytes && /(?:^|\/)(?:__deck\/publish|_api\/write)$/.test(path14.split("?")[0]) && request.headers.get("content-type")?.includes("application/json")) requestBytes = await preserveAssetReferences(requestBytes);
    const body = requestBytes ? bytesToBase64(requestBytes) : void 0;
    const responseTask = rpc("editor.request", { request: { path: path14, method: request.method, headers, ...body === void 0 ? {} : { body } } }, init?.signal || request.signal);
    const writing = !["GET", "HEAD"].includes(request.method);
    if (writing) pendingWrites.add(responseTask);
    let response;
    try {
      response = await responseTask;
    } finally {
      if (writing) pendingWrites.delete(responseTask);
    }
    let responseBytes = base64ToBytes(response.body);
    if (!readOnly && /^__history(?:\/|\?|$)/.test(path14) && response.headers?.["content-type"]?.includes("application/json")) {
      try {
        const value = JSON.parse(new TextDecoder().decode(responseBytes));
        for (const row of Array.isArray(value.rows) ? value.rows : []) {
          if (typeof row.preview !== "string") continue;
          const serverPath = configuration.serverPath;
          const route = typeof serverPath === "string" && row.preview.startsWith(serverPath) ? row.preview.slice(serverPath.length) : row.preview;
          if (/^v\/[1-9][0-9]{0,8}\/$/.test(route)) row.preview = new URL(route, rootBase).href;
          else if (configuration.kind === "dashboard" && Number.isSafeInteger(row.n) && row.n >= 1 && row.n <= 999999999 && route === `?at=${row.n}`) row.preview = new URL(`v/${row.n}/`, rootBase).href;
        }
        responseBytes = new TextEncoder().encode(JSON.stringify(value));
      } catch {
      }
    }
    const result = new Response([101, 204, 205, 304].includes(response.status) || request.method === "HEAD" ? null : responseBytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(result, "url", { value: url });
    return result;
  };
  target.__CODEX_DESIGN_EDITOR_RESOLVE_ASSET__ = async (reference) => {
    const id = /(?:^|\/)\_blob\/([0-9a-f]{32})(?:[?#].*)?$/.exec(String(reference))?.[1];
    if (!id) throw new TypeError("Only artwork upload references can be embedded.");
    const key = "_blob/" + id;
    if (!assetCache.has(key)) {
      const entry2 = { size: 0 };
      entry2.promise = (async () => {
        const response = await target.fetch(key);
        if (!response.ok) throw new Error("The artwork image or font could not be loaded.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("The artwork asset exceeds its transfer limit.");
        const url = "data:" + (response.headers.get("content-type")?.split(";")[0] || "application/octet-stream") + ";base64," + bytesToBase64(bytes);
        entry2.size = bytes.byteLength;
        entry2.ready = true;
        entry2.url = url;
        assetBytes += entry2.size;
        assetIds.add(id);
        assetAliases.set(url, "/_blob/" + id);
        for (const [oldKey, old] of assetCache) {
          if (assetCache.size <= 128 && assetBytes <= 64 * 1024 * 1024) break;
          if (oldKey === key || !old.ready) continue;
          assetCache.delete(oldKey);
          assetBytes -= old.size;
          assetAliases.delete(old.url);
        }
        return url;
      })().catch((error3) => {
        assetCache.delete(key);
        throw error3;
      });
      assetCache.set(key, entry2);
    }
    return assetCache.get(key).promise;
  };
  function installPreviewTransport() {
    let resolveAsset, fetcher, crypto;
    try {
      resolveAsset = window.parent.__CODEX_DESIGN_EDITOR_RESOLVE_ASSET__;
      fetcher = window.parent.fetch.bind(window.parent);
      crypto = window.parent.crypto;
    } catch {
      return;
    }
    if (typeof resolveAsset !== "function") return;
    window.fetch = (input, init) => {
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      if (!["GET", "HEAD"].includes(method) || typeof url !== "string" || !/^(?:blob:|data:|\/?_blob\/[0-9a-f]{32}(?:[?#]|$))/.test(url)) return Promise.reject(new TypeError("A preview can only read its uploaded artwork assets."));
      return fetcher(input, init);
    };
    if (!window.crypto.randomUUID && crypto?.randomUUID) Object.defineProperty(window.crypto, "randomUUID", { value: crypto.randomUUID.bind(crypto), configurable: true });
    if (!window.crypto.subtle && crypto?.subtle) Object.defineProperty(window.crypto, "subtle", { value: crypto.subtle, configurable: true });
    const reference = /(?:\/?_blob\/[0-9a-f]{32})/g;
    const seen = /* @__PURE__ */ new WeakMap();
    const transform = async (element, attribute2, value) => {
      if (typeof value !== "string" || !value.includes("_blob/")) return;
      let state = seen.get(element);
      if (!state) {
        state = /* @__PURE__ */ new Map();
        seen.set(element, state);
      }
      if (state.get(attribute2) === value) return;
      state.set(attribute2, value);
      try {
        let next = value;
        for (const match of new Set(value.match(reference) || [])) next = next.split(match).join(await resolveAsset(match));
        if (!element.isConnected || state.get(attribute2) !== value) return;
        if (attribute2 === "textContent") {
          if (element.textContent === value) element.textContent = next;
        } else if (element.getAttribute(attribute2) === value) element.setAttribute(attribute2, next);
      } catch (error3) {
        console.error("Codex Design could not display an artwork asset.", error3);
      }
    };
    const inspect = (element) => {
      if (element.nodeType !== 1) return;
      for (const attribute2 of ["src", "href", "poster", "style", "srcset"]) if (element.hasAttribute(attribute2)) void transform(element, attribute2, element.getAttribute(attribute2));
      if (element.tagName === "STYLE") void transform(element, "textContent", element.textContent);
      for (const child of element.querySelectorAll("[src],[href],[poster],[style],[srcset],style")) {
        for (const attribute2 of ["src", "href", "poster", "style", "srcset"]) if (child.hasAttribute(attribute2)) void transform(child, attribute2, child.getAttribute(attribute2));
        if (child.tagName === "STYLE") void transform(child, "textContent", child.textContent);
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") inspect(record.target);
        else if (record.type === "characterData" && record.target.parentElement?.tagName === "STYLE") inspect(record.target.parentElement);
        else for (const node of record.addedNodes) inspect(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "href", "poster", "style", "srcset"], characterData: true });
    inspect(document.documentElement);
  }
  const framePrototype = target.HTMLIFrameElement?.prototype;
  const srcdoc = framePrototype && Object.getOwnPropertyDescriptor(framePrototype, "srcdoc");
  if (srcdoc?.set && srcdoc.get) {
    const originals = /* @__PURE__ */ new WeakMap();
    Object.defineProperty(framePrototype, "srcdoc", {
      configurable: true,
      enumerable: srcdoc.enumerable,
      get() {
        return originals.has(this) ? originals.get(this) : srcdoc.get.call(this);
      },
      set(value) {
        const source = String(value).replace(/<script data-codex-native-preview-transport>[\s\S]*?<\/script>/gi, "");
        originals.set(this, source);
        let preview = source;
        for (const vendor of configuration.previewVendors || []) {
          const relative2 = "artifact-type/vendor/" + vendor.file;
          const url = new URL(relative2, base);
          for (const path14 of [url.href, url.pathname, "/" + relative2, relative2]) preview = preview.split(path14).join(vendor.url);
        }
        const runtime = "<script data-codex-native-preview-transport>(" + installPreviewTransport.toString() + ")();</script>";
        srcdoc.set.call(this, /<head\b[^>]*>/i.test(preview) ? preview.replace(/<head\b[^>]*>/i, (head) => head + runtime) : runtime + preview);
      }
    });
    const elementPrototype = target.Element?.prototype;
    if (elementPrototype) {
      const setAttribute = elementPrototype.setAttribute;
      elementPrototype.setAttribute = function(name, value) {
        if (this instanceof target.HTMLIFrameElement && String(name).toLowerCase() === "srcdoc") {
          this.srcdoc = value;
          return;
        }
        return setAttribute.call(this, name, value);
      };
    }
  }
  class EditorEventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    CONNECTING = 0;
    OPEN = 1;
    CLOSED = 2;
    readyState = 0;
    withCredentials = false;
    onopen = null;
    onmessage = null;
    onerror = null;
    constructor(url) {
      super();
      this.url = new URL(String(url), base).href;
      this.path = relative(this.url);
      this.controller = new AbortController();
      if (this.path === null) throw new TypeError("Only events from this artwork editor can be subscribed.");
      sources.add(this);
      void this.listen();
    }
    emit(type, data) {
      const event = data === void 0 ? new Event(type) : new MessageEvent(type, { data: data.data, lastEventId: data.id || "", origin: base.origin });
      this.dispatchEvent(event);
      this["on" + type]?.(event);
    }
    async listen() {
      try {
        const opened = await rpc("editor.events.open", { path: this.path }, this.controller.signal);
        if (this.readyState === 2) {
          void rpc("editor.events.close", { subscriptionId: opened.subscriptionId }).catch(() => {
          });
          return;
        }
        this.subscriptionId = opened.subscriptionId;
        this.readyState = 1;
        let cursor = opened.cursor;
        this.emit("open");
        while (this.readyState !== 2) {
          const result = await rpc("editor.events.poll", { subscriptionId: this.subscriptionId, cursor }, this.controller.signal);
          for (const event of result.events || []) this.emit(event.event, event);
          cursor = result.cursor;
          if (result.ended || result.error) throw new Error(result.error?.message || "The editor event connection closed.");
        }
      } catch {
        if (this.readyState === 2) return;
        this.readyState = 2;
        sources.delete(this);
        this.emit("error");
      }
    }
    close() {
      if (this.readyState === 2 && !this.subscriptionId) return;
      this.readyState = 2;
      sources.delete(this);
      this.controller.abort();
      if (this.subscriptionId) void rpc("editor.events.close", { subscriptionId: this.subscriptionId }).catch(() => {
      });
    }
  }
  target.EventSource = EditorEventSource;
  const startPreviews = () => {
    if (disposed || readOnly || previews || typeof installPreviews !== "function" || !target.document?.body) return;
    previews = installPreviews({ target, baseUrl: rootBase.href, rpc, flush: flushEditor });
    const context = target.__CODEX_DESIGN_EDITOR_TRANSPORT__.hostContext;
    if (context) previews?.updateHostContext?.(context);
  };
  if (target.document?.body) startPreviews();
  else target.document?.addEventListener?.("DOMContentLoaded", startPreviews, { once: true });
  if (readOnly && target.document) {
    target.document.addEventListener("click", (event) => {
      const anchor = event.target?.closest?.("a[href]");
      if (!anchor) return;
      let url;
      try {
        url = new URL(anchor.getAttribute("href"), base);
      } catch {
        return;
      }
      if (url.href !== rootBase.href) return;
      event.preventDefault();
      target.parent.postMessage({ type: "codex-design:preview-close", channel }, "*");
    }, true);
  }
  const anchorPrototype = target.HTMLAnchorElement?.prototype;
  if (anchorPrototype) {
    const click = anchorPrototype.click;
    anchorPrototype.click = function() {
      if (!this.hasAttribute("download") || !/^(?:blob:|data:)/i.test(this.href)) return click.call(this);
      const filename = this.download || "download";
      void (async () => {
        const resource = await originalFetch(this.href);
        const bytes = new Uint8Array(await resource.arrayBuffer());
        await rpc("editor.download", { filename, mimeType: resource.headers.get("content-type") || "application/octet-stream", base64: bytesToBase64(bytes) });
      })().catch((error3) => target.parent.postMessage({ type: "codex-design:editor-diagnostic", channel, message: String(error3.message || error3).slice(0, 500) }, "*"));
    };
  }
  target.addEventListener("unload", () => {
    for (const source of sources) source.close();
    disposed = true;
    target.document?.removeEventListener?.("DOMContentLoaded", startPreviews);
    hostTheme.dispose();
    previews?.dispose?.();
    target.__CODEX_DESIGN_NATIVE_HISTORY__?.dispose?.();
    if (readOnly) delete target.__CODEX_DESIGN_PREVIEW_CLOSE__;
    for (const call of [...pending.values()]) call.reject(Object.assign(new Error("The artwork editor has closed."), { code: "EDITOR_CLOSED" }));
  });
  target.addEventListener("error", (event) => {
    if (!event.message) return;
    target.parent.postMessage({ type: "codex-design:editor-diagnostic", channel, message: String(event.message).slice(0, 500) }, "*");
  });
  target.parent.postMessage({ type: "codex-design:editor-transport-ready", channel }, "*");
  if (target.document && target.MutationObserver) {
    let ready = false;
    const observe = () => {
      if (ready || !target.document.querySelector("[data-cds],#root button,.dash-page")) return;
      ready = true;
      observer.disconnect();
      target.parent.postMessage({ type: "codex-design:editor-app-ready", channel }, "*");
    };
    const observer = new target.MutationObserver(observe);
    observer.observe(target.document.documentElement, { childList: true, subtree: true });
    observe();
  }
}

// source/server/service.mjs
init_worker_client();
init_bridge_core();
init_worker_core();

// source/server/editor-lifecycle.mjs
init_bridge_core();
import { spawn } from "node:child_process";
import fs7 from "node:fs";
import path10 from "node:path";
var failure = (code, message) => Object.assign(new Error(message), { code });
async function stopLocalEditor(record, { pluginRoot, env = process.env, timeoutMs = 15e3 } = {}) {
  const stateFile = path10.join(record.path, ".artifact-server.json");
  if (!fs7.existsSync(stateFile)) return { stopped: false };
  const state = readJson(stateFile);
  if (!state || state.kind !== record.kind || !samePath(state.root, record.path)) {
    throw failure("EDITOR_IDENTITY_UNVERIFIED", "The selected artwork editor record is invalid. Its process and files were preserved.");
  }
  const cli = path10.join(pluginRoot, "skills", `codex-${record.kind}`, "scripts", "codex-artifact.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "stop", record.path], {
      cwd: pluginRoot,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", finished = false;
    const finish = (error3, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error3 ? reject(error3) : resolve(result);
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
      child.kill();
      finish(failure("EDITOR_STOP_TIMEOUT", "The selected editor did not finish stopping. Artwork files were not moved."));
    }, timeoutMs);
    child.once("error", (error3) => finish(failure("EDITOR_STOP_FAILED", error3.message)));
    child.once("close", (code) => {
      if (finished) return;
      if (code !== 0) {
        let detail2;
        try {
          detail2 = JSON.parse(stderr.trim().split(/\r?\n/).at(-1));
        } catch {
        }
        return finish(failure(detail2?.error || "EDITOR_STOP_FAILED", detail2?.message || stderr.trim().slice(-2e3) || `Editor stop exited ${code}.`));
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (alive(state.pid)) return finish(failure("EDITOR_STOP_FAILED", "The verified editor is still running. Artwork files were not moved."));
        finish(null, result);
      } catch {
        finish(failure("EDITOR_STOP_FAILED", "The selected editor stop returned invalid data. Artwork files were not moved."));
      }
    });
  });
}

// source/server/contract.mjs
var PLUGIN_UI_VERSION = "0.6.2";
var LIBRARY_UI_URI = `ui://codex-design/${PLUGIN_UI_VERSION}/library`;
var FILE_UI_URI = `ui://codex-design/${PLUGIN_UI_VERSION}/file`;
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
  "library.purge",
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
  "editor.open",
  "editor.document",
  "editor.previewDocument",
  "editor.request",
  "editor.digest",
  "editor.events.open",
  "editor.events.poll",
  "editor.events.close",
  "request.draftAdded",
  "request.draftFailed",
  "export.locations",
  "export.listDirectory",
  "export.save"
]);
var UNSUPPORTED_CHAT_CODE = "NATIVE_EDIT_CHAT_UNAVAILABLE";
var referenceUri = (id) => `codex-design://artifacts/${encodeURIComponent(id)}/reference`;
var fileUri = (id, relative) => `codex-design://artifacts/${encodeURIComponent(id)}/files/${encodeURIComponent(relative)}`;

// source/server/service.mjs
var failure2 = (code, message) => Object.assign(new Error(message), { code });
var UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idOf(value) {
  if (typeof value !== "string" || !UUID2.test(value)) throw failure2("INVALID_ID", "An artifact UUID is required.");
  return value.toLowerCase();
}
function titleOf(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw failure2("INVALID_TITLE", "Provide a title of at most 200 characters.");
  return value.trim();
}
function kindOf(value) {
  if (!KINDS2.includes(value)) throw failure2("INVALID_KIND", "Unsupported artifact kind.");
  return value;
}
function relativeOf(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\\") || value.includes("%") || path11.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) || /[\u0000-\u001f:]/.test(value)) throw failure2("INVALID_PATH", "Only a safe artifact-relative content path is accepted.");
  return value;
}
var capabilityState = () => ({
  actions: [...ACTIONS],
  nativeEditConversation: false,
  selectNativeProject: false,
  arbitraryThreadTarget: false,
  reasonCode: UNSUPPORTED_CHAT_CODE
});
async function openLocalEditor(record, { pluginRoot, env = process.env, timeoutMs = 3e4, spawnProcess = spawn2 } = {}) {
  const current = readJson(path11.join(record.path, ".artifact-server.json"));
  if (current && alive(current.pid)) {
    try {
      const session = await verifyEditorInstance(current, record.path, record.kind);
      const binding = readJson(path11.join(record.path, ".codex-design-bridge.json"));
      if (session.nativeSessionVersion === 2 && session.nativeLocalOnly === true) {
        return {
          url: current.url,
          artifactId: record.id,
          kind: record.kind,
          reused: true,
          delivery: binding?.deliveryMode || "manual",
          nativeConversationBound: false
        };
      }
    } catch (error3) {
      if (error3.code !== "EDITOR_IDENTITY_UNVERIFIED" || error3.reason !== "SESSION_CONNECTION_REFUSED") throw error3;
    }
  }
  const skill = `codex-${record.kind}`;
  const cli = path11.join(pluginRoot, "skills", skill, "scripts", "codex-artifact.mjs");
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [cli, "open-service", record.path, "--delivery", "native"], {
      cwd: record.path,
      env: { ...env, CODEX_DESIGN_NATIVE_SESSION: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", settled = false, timedOut = false;
    const finish = (error3, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      error3 ? reject(error3) : resolve(result);
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
      finish(failure2("EDITOR_TIMEOUT", "The local editor did not finish starting."));
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }, timeoutMs + 1e3);
    child.once("error", (error3) => finish(failure2("EDITOR_START_FAILED", error3.message)));
    child.once("close", (code) => {
      if (timedOut) return finish(failure2("EDITOR_TIMEOUT", "The local editor did not finish starting."));
      if (code !== 0) {
        let detail2;
        try {
          detail2 = JSON.parse(stderr.trim().split(/\r?\n/).at(-1));
        } catch {
        }
        if (detail2?.error === "EDITOR_IDENTITY_UNVERIFIED") return finish(failure2(detail2.error, "The existing editor identity could not be safely recovered. Its records were preserved."));
        return finish(failure2("EDITOR_START_FAILED", stderr.trim().slice(-2e3) || `Editor command exited ${code}.`));
      }
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        return finish(failure2("EDITOR_INVALID_RESPONSE", "The local editor returned invalid startup data."));
      }
      let url;
      try {
        url = new URL(result.url);
      } catch {
        return finish(failure2("EDITOR_INVALID_RESPONSE", "The local editor did not return a URL."));
      }
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
        return finish(failure2("EDITOR_INVALID_RESPONSE", "Only a local editor URL is accepted."));
      }
      finish(null, { url: url.href, artifactId: record.id, kind: record.kind, delivery: "native", nativeConversationBound: false });
    });
  });
}
function createDesignService({ store, pluginRoot = fileURLToPath2(new URL("../", import.meta.url)), editorOpen = openLocalEditor, editorStop = stopLocalEditor } = {}) {
  if (!store) throw new TypeError("A LibraryStore is required.");
  const opening = /* @__PURE__ */ new Map();
  const trashing = /* @__PURE__ */ new Set();
  const requireRecord = async (id) => {
    const record = await store.get(idOf(id));
    if (!record || record.deletedAt) throw failure2("ARTIFACT_UNAVAILABLE", "The artifact is missing or in the trash.");
    return record;
  };
  const initialize = async () => {
    await store.initialize();
    return store;
  };
  const editorFor = async (id) => {
    const record = await requireRecord(id);
    if (trashing.has(record.id)) throw failure2("ARTIFACT_BUSY", "This artwork is being moved to the trash.");
    if (record.contentStatus !== "ok") throw failure2("ARTIFACT_CONTENT_UNAVAILABLE", "Missing or invalid artifact content cannot open as a blank replacement.");
    if (!opening.has(record.id)) opening.set(record.id, Promise.resolve().then(() => editorOpen(record, { pluginRoot })).finally(() => opening.delete(record.id)));
    return await opening.get(record.id);
  };
  const transport = createEditorTransport({ editorFor });
  const requests = createEditRequestStore({ store });
  const exports = createExportStore({ store });
  const nativeComments = createNativeComments({ requests, transport, editorFor });
  const modelRequest = async (requestId2) => {
    const value = await requests.requestForModel(idOf(requestId2));
    if (value.status === "superseded") return value;
    const comments = await readJson2(value.artifactRoot, "comments.json", { version: 1, threads: [] });
    const projected = await requests.project(value.artifactId, { threads: comments.threads });
    const reported = projected.threads.find((thread) => thread.agent?.nativeRequest?.requestId === value.id)?.agent.nativeRequest;
    const cli = path11.join(pluginRoot, "skills", `codex-${value.artifact.kind}`, "scripts", "codex-artifact.mjs");
    return {
      ...value,
      ...reported ? { status: reported.status, phase: reported.phase } : {},
      skillFile: path11.join(pluginRoot, "skills", `codex-${value.artifact.kind}`, "SKILL.md"),
      dispatchCommand: { executable: process.execPath, args: [cli, "request-dispatch", value.artifactRoot, value.id] },
      workerStatus: { executable: process.execPath, args: [cli, "worker-status", value.artifactRoot] },
      executionPolicy: "Dispatch only requests attached to the user message you actually received. Run the dispatch command in your own native parent environment. Inspect the real native worker before choosing reuse, resume or a new child; only the registered native child runs worker-register/worker-next/worker-complete. Never invent thread IDs, start an independent model process, or replay legacy unconfirmed jobs."
    };
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
    readEditRequest: modelRequest,
    async operateEditRequests(action, ids) {
      if (!["read", "accept"].includes(action) || !Array.isArray(ids) || ids.length < 1 || ids.length > 25) throw failure2("INVALID_ARGUMENTS", "Read or accept between 1 and 25 immutable request IDs.");
      const results = [], errors = [];
      for (const id of [...new Set(ids.map(idOf))]) {
        try {
          if (action === "accept") await requests.accept(id);
          results.push(await modelRequest(id));
        } catch (error3) {
          errors.push({ requestId: id, code: error3.code || "REQUEST_FAILED", message: String(error3.message).slice(0, 2e3) });
        }
      }
      return { requests: results, errors };
    },
    async readReferenceFile(id, relative, encoding = "utf8") {
      await initialize();
      await requireRecord(id);
      if (!["utf8", "base64"].includes(encoding)) throw failure2("INVALID_ENCODING", "Choose utf8 or base64.");
      return await store.readFile(idOf(id), relativeOf(relative), { encoding });
    },
    async invoke(action, payload = {}) {
      await initialize();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure2("INVALID_ARGUMENTS", "An action payload must be an object.");
      if (action === "conversation.send") throw failure2(UNSUPPORTED_CHAT_CODE, "The host has not exposed a verified per-artifact native edit-conversation bridge. No message was sent.");
      if (!ACTIONS.includes(action)) throw failure2("UNKNOWN_ACTION", "Unsupported library action.");
      switch (action) {
        case "export.locations":
          return await exports.locations();
        case "export.listDirectory":
          return await exports.listDirectory(payload);
        case "export.save":
          return await exports.save(payload);
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
          if (typeof payload.favorite !== "boolean") throw failure2("INVALID_ARGUMENTS", "favorite must be a boolean.");
          return await store.setFavorite(idOf(payload.id), payload.favorite);
        case "library.duplicate":
          return await store.duplicate(idOf(payload.id), { ...payload.title === void 0 ? {} : { title: titleOf(payload.title) } });
        case "library.trash": {
          const id = idOf(payload.id);
          if (trashing.has(id)) throw failure2("ARTIFACT_BUSY", "This artwork is already being moved to the trash.");
          trashing.add(id);
          try {
            const record = await requireRecord(id);
            if (opening.has(id)) await opening.get(id);
            await stopWorker(record.path, { onlyWhenIdle: true });
            await editorStop(record, { pluginRoot });
            return await store.trash(id);
          } finally {
            trashing.delete(id);
          }
        }
        case "library.restore":
          return await store.restore(idOf(payload.id));
        case "library.purge": {
          if (!Array.isArray(payload.ids) || payload.ids.length < 1 || payload.ids.length > 200) throw failure2("INVALID_ARGUMENTS", "Choose between 1 and 200 trashed artworks.");
          return await store.purge(payload.ids.map(idOf));
        }
        case "library.snapshot":
          return await store.snapshot(idOf(payload.id), payload.label === void 0 ? {} : { label: titleOf(payload.label) });
        case "library.listSnapshots":
          return await store.listSnapshots(idOf(payload.id));
        case "library.restoreSnapshot":
          return await store.restoreSnapshot(idOf(payload.id), payload.snapshotId);
        case "library.exportArtifact":
          return await store.exportArtifact(idOf(payload.id));
        case "library.importArtifact": {
          if (!payload.bundle || typeof payload.bundle !== "object" || Array.isArray(payload.bundle) || Object.hasOwn(payload, "sourcePath")) {
            throw failure2("INVALID_IMPORT", "Choose a native artwork package; browser calls cannot import an arbitrary local path.");
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
          if (!Array.isArray(payload.ids)) throw failure2("INVALID_ARGUMENTS", "ids must be an array.");
          return await store.reorderTabs(payload.ids.map((id) => id === "library" ? "library" : idOf(id)));
        case "editor.open":
          return await editorFor(payload.id);
        case "editor.previewDocument": {
          if (!Number.isSafeInteger(payload.version) || payload.version < 1 || payload.version > 999999999) throw failure2("INVALID_EDITOR_PREVIEW", "Choose an existing positive history version.");
          const listed = await transport.request(idOf(payload.id), { path: "__history", method: "GET" });
          let history;
          try {
            history = JSON.parse(Buffer.from(listed.body, "base64").toString("utf8"));
          } catch {
            throw failure2("EDITOR_HISTORY_UNAVAILABLE", "The artwork history could not be read.");
          }
          if (listed.status !== 200 || !Array.isArray(history.rows) || !history.rows.some((row) => row.n === payload.version)) throw failure2("EDITOR_PREVIEW_UNAVAILABLE", "That history version is no longer available.");
          return await this.invoke("editor.document", { id: payload.id, channel: payload.channel, previewVersion: payload.version, canDraftComments: false });
        }
        case "request.draftAdded":
          return await requests.markDraftAdded(idOf(payload.requestId));
        case "request.draftFailed":
          return await requests.markDraftFailed(idOf(payload.requestId), payload.error);
        case "editor.document": {
          const id = idOf(payload.id);
          if (typeof payload.channel !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(payload.channel)) throw failure2("INVALID_EDITOR_REQUEST", "A unique editor channel is required.");
          const language2 = "en";
          const editor = await editorFor(id);
          const rootBaseUrl = `https://codex-design.invalid/artifacts/${id}/`;
          const previewVersion = payload.previewVersion;
          if (previewVersion !== void 0 && (!Number.isSafeInteger(previewVersion) || previewVersion < 1 || previewVersion > 999999999)) throw failure2("INVALID_EDITOR_PREVIEW", "Choose an existing positive history version.");
          const requestPrefix = previewVersion === void 0 ? "" : `v/${previewVersion}/`;
          const virtualBase = rootBaseUrl + requestPrefix;
          const configuration = {
            artifactId: id,
            kind: editor.kind,
            channel: payload.channel,
            baseUrl: virtualBase,
            language: language2,
            hostDepth: 2,
            rootBaseUrl,
            serverPath: new URL(editor.url).pathname,
            requestPrefix,
            readOnly: previewVersion !== void 0,
            canDraftComments: previewVersion === void 0 && payload.canDraftComments === true
          };
          if (editor.kind === "design-system") {
            configuration.previewVendors = await Promise.all([
              ["react.production.min.js", "d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd"],
              ["react-dom.production.min.js", "35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d"]
            ].map(async ([file, expected]) => {
              const bytes = await readFile(path11.join(pluginRoot, "skills/codex-design-system/scripts/editor/artifact-type/vendor", file));
              if (bytes.length > 256 * 1024 || createHash9("sha256").update(bytes).digest("hex") !== expected) throw failure2("EDITOR_VENDOR_INTEGRITY", "The packaged preview runtime failed its integrity check.");
              return { file, url: "data:text/javascript;base64," + bytes.toString("base64") };
            }));
          }
          const bootstrap = `(${installNativeEditorTransport.toString()})(${JSON.stringify(configuration).replace(/</g, "\\u003c")},undefined,${installNativePreviews.toString()});`;
          const root = new URL(editor.url);
          const fetchLocal = async (value) => {
            const url = new URL(String(value));
            if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw failure2("INVALID_EDITOR_REQUEST", "Editor assets must stay inside their artwork session.");
            const relative = url.pathname.slice(root.pathname.length);
            editorRequestUrl(root.href, relative + url.search);
            let asset;
            if (!relative) asset = path11.join(pluginRoot, "skills", `codex-${editor.kind}`, "scripts/editor/index.html");
            else if (relative === "__codex/annotations.js") asset = path11.join(pluginRoot, "scripts/browser-annotations.js");
            else if (relative === "__codex/boot.js") {
              const response = await transport.request(id, { path: "__codex/boot.js" + (previewVersion === void 0 ? "" : `?at=${previewVersion}`), method: "GET" });
              return new Response(Buffer.from(response.body, "base64"), { status: response.status, headers: response.headers });
            } else if (relative === "__codex/history-ui.js") asset = path11.join(pluginRoot, "skills", `codex-${editor.kind}`, "scripts/editor/share-ui.js");
            else if (/^(?:assets\/[A-Za-z0-9._-]+|comments\.js|local-host\.js)$/.test(relative)) {
              asset = path11.join(pluginRoot, "skills", `codex-${editor.kind}`, "scripts/editor", relative);
            } else throw failure2("EDITOR_ASSET_REFUSED", "Only packaged static editor assets can be assembled.");
            const bytes = await readFile(asset);
            return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
          };
          const document2 = await buildEditorDocument({ baseUrl: editor.url, fetchLocal, config: { ...configuration, virtualBase, bootstrap, nativeHistory: true } });
          return { ...editor, ...document2, artifactId: id, channel: payload.channel, transport: "mcp" };
        }
        case "editor.request": {
          const id = idOf(payload.id), request = payload.request ?? {};
          const { method } = validateEditorRequest(request);
          const editor = await editorFor(id);
          const url = editorRequestUrl(editor.url, request.path);
          const route = decodeURIComponent(url.pathname.slice(new URL(editor.url).pathname.length)).split("/").filter(Boolean).join("/");
          if (method === "POST" && /^__history\/(?:\d+\/restore|notice\/[^/]+\/recover)$/.test(route)) {
            const record = await requireRecord(id);
            return await withLock(path11.join(record.path, WORKER_LOCK_FILE), async () => {
              const worker = await getWorkerStatus(record.path);
              const jobs = loadJobs(record.path);
              let registry;
              try {
                const file = path11.join(record.path, WORKER_FILE);
                const info = await lstat(file).catch((error3) => {
                  if (error3.code === "ENOENT") return null;
                  throw error3;
                });
                if (info) {
                  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unverified worker registry.");
                  registry = JSON.parse(await readFile(file, "utf8"));
                  if (!registry || registry.version !== 1 || !samePath(registry.root, record.path) || !["waiting", "paused"].includes(registry.status) || registry.activeJobId || !UUID2.test(registry.nativeThreadId || "") || ["pid", "url", "token", "command"].some((key) => Object.hasOwn(registry, key))) throw new Error("Unverified worker ownership.");
                }
              } catch {
                throw failure2("ARTIFACT_BUSY", "Worker ownership could not be verified before restoring edit history.");
              }
              if (worker.counts.active || worker.counts.pending || Object.values(jobs.jobs).some((job) => !job || !["completed", "failed", "superseded"].includes(job.status))) throw failure2("ARTIFACT_BUSY", "Finish or coordinate queued AI work before restoring edit history.");
              await store.snapshot(id, { label: "Before partial restore" });
              return await nativeComments.request(id, request);
            }, { timeoutMs: 1e4, staleMs: 0 });
          }
          return await nativeComments.request(id, request);
        }
        case "editor.digest": {
          await requireRecord(payload.id);
          if (payload.algorithm !== "SHA-256" || typeof payload.base64 !== "string" || payload.base64.length > 44739244 || !isValidBase64(payload.base64)) throw failure2("INVALID_EDITOR_DIGEST", "Only a bounded SHA-256 digest is supported.");
          const bytes = Buffer.from(payload.base64, "base64");
          if (bytes.length > 32 * 1024 * 1024) throw failure2("INVALID_EDITOR_DIGEST", "The digest input exceeds the transfer limit.");
          return { base64: createHash9("sha256").update(bytes).digest("base64") };
        }
        case "editor.events.open":
          return await nativeComments.openEvents(idOf(payload.id), payload.path);
        case "editor.events.poll":
          return await nativeComments.pollEvents(idOf(payload.id), payload.subscriptionId, payload.cursor);
        case "editor.events.close":
          return await nativeComments.closeEvents(idOf(payload.id), payload.subscriptionId);
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
var error2 = (code, message) => Object.assign(new Error(message), { code });
var alive2 = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === "EPERM";
  }
};
var detail = (cause) => ({ code: cause.code || "PREVIEW_ERROR", message: String(cause.message || cause).slice(0, 2e3) });
var samePath3 = (a, b) => process.platform === "win32" ? path12.resolve(a).toLowerCase() === path12.resolve(b).toLowerCase() : path12.resolve(a) === path12.resolve(b);
async function previewNativeActivity(record) {
  try {
    const status = await getWorkerStatus(record.path);
    return status.counts.active > 0 ? { busy: true, reason: "An unfinished native design job is recorded for this artwork." } : false;
  } catch {
    return { busy: true, reason: "The artwork task state cannot be verified." };
  }
}
function verifiedState(state, root) {
  if (!state || state.version !== 1 || state.kind !== KIND || !Number.isInteger(state.pid) || state.pid <= 0 || typeof state.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state.token) || typeof state.instanceId !== "string" || !samePath3(state.root, root)) throw error2("INVALID_PREVIEW_STATE", "The preview record cannot identify this library.");
  let url;
  try {
    url = new URL(state.url);
  } catch {
    throw error2("INVALID_PREVIEW_STATE", "The preview URL is invalid.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== `/${state.token}/` || !url.port) throw error2("INVALID_PREVIEW_STATE", "Only the recorded loopback preview URL is accepted.");
  return url;
}
async function libraryPreviewStatus({ root = createLibraryStore().root, timeoutMs = 2e3 } = {}) {
  root = path12.resolve(root);
  if (!await statOrNull(root)) return { running: false, root };
  const state = await readJson2(root, PREVIEW_STATE, null);
  if (!state) return { running: false, root };
  const url = verifiedState(state, root);
  if (!alive2(state.pid)) return { running: false, stale: true, root, state };
  try {
    const response = await fetch(new URL("session", url), { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const session = response.ok ? await response.json() : null;
    if (!session || session.kind !== KIND || session.pid !== state.pid || session.instanceId !== state.instanceId || !samePath3(session.root, root)) throw error2("PREVIEW_IDENTITY_UNVERIFIED", "A live PID did not confirm this preview identity.");
    return { running: true, root, url: state.url, pid: state.pid, instanceId: state.instanceId, state };
  } catch {
    throw error2("PREVIEW_IDENTITY_UNVERIFIED", "The recorded live process did not confirm this library preview. No process was stopped.");
  }
}
async function stopLibraryPreview(options = {}) {
  const status = await libraryPreviewStatus(options);
  if (!status.running) return { stopped: false, running: false, root: status.root };
  const url = new URL(status.url);
  const response = await fetch(new URL("shutdown", url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5e3), headers: { Origin: url.origin, "Content-Type": "application/json" }, body: JSON.stringify({ instanceId: status.instanceId }) });
  const result = await response.json();
  if (!response.ok || result.instanceId !== status.instanceId || result.stopping !== true) throw error2("PREVIEW_STOP_REFUSED", "The preview did not accept its authenticated shutdown.");
  const deadline = Date.now() + 5e3;
  while (Date.now() < deadline) {
    const recorded = await readJson2(status.root, PREVIEW_STATE, null);
    if (!recorded || recorded.instanceId !== status.instanceId) return { stopped: true, root: status.root, pid: status.pid };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { stopped: false, stopping: true, root: status.root, pid: status.pid };
}
function builtHtml(html, endpoint, eventsUrl, nonce) {
  if (typeof html !== "string" || Buffer.byteLength(html) > 8 * 1024 * 1024 || !/<head\b/i.test(html)) throw error2("INVALID_PREVIEW_UI", "The built UI is missing or exceeds its size limit.");
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scripts)) if (/\bsrc\s*=/i.test(match[1])) throw error2("UI_NOT_BUNDLED", "Use a published or staged plugin whose ui/index.html has inline assets.");
  if (/<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i.test(html.replace(scripts, ""))) throw error2("UI_NOT_BUNDLED", "Use a published or staged plugin whose ui/index.html has inline assets.");
  const config = `<script nonce="${nonce}">window.codexDesignHttpEndpoint=${JSON.stringify(endpoint)};window.codexDesignEventsUrl=${JSON.stringify(eventsUrl)};</script>`;
  return html.replace(scripts, (_, attributes2, body) => `<script nonce="${nonce}"${attributes2}>${body}</script>`).replace(/<head\b[^>]*>/i, (head) => head + config);
}
async function requestJson(request, maximum) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
    request.resume();
    throw error2("UNSUPPORTED_MEDIA_TYPE", "Expected application/json.");
  }
  if (Number(request.headers["content-length"] || 0) > maximum) {
    request.resume();
    throw error2("REQUEST_TOO_LARGE", "The request exceeds the preview limit.");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) {
      request.resume();
      throw error2("REQUEST_TOO_LARGE", "The request exceeds the preview limit.");
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw error2("INVALID_JSON", "Expected one JSON object.");
  }
}
async function startLibraryPreview({ root, pluginRoot = fileURLToPath3(new URL("../", import.meta.url)), store, service, html, port = 0, maxRequestBytes = 17 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw error2("INVALID_PREVIEW_OPTION", "Invalid preview port or request limit.");
  store ||= createLibraryStore({ ...root === void 0 ? {} : { root }, isBusy: previewNativeActivity });
  await store.initialize();
  root = store.root;
  pluginRoot = path12.resolve(pluginRoot);
  service ||= createDesignService({ store, pluginRoot });
  if (html === void 0) html = await fs8.readFile(path12.join(pluginRoot, "ui", "index.html"), "utf8");
  const token = randomBytes(32).toString("base64url"), instanceId = randomUUID8(), nonce = randomBytes(18).toString("base64");
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
      if (recorded?.instanceId === instanceId) await fs8.unlink(await safePath(root, PREVIEW_STATE, { type: "file" }));
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
      if (previous.running) throw error2("PREVIEW_ALREADY_RUNNING", "This library preview is already running at " + previous.url);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      state = { version: 1, kind: KIND, root, pluginRoot, pid: process.pid, instanceId, token, url: origin + prefix, startedAt: (/* @__PURE__ */ new Date()).toISOString() };
      servedHtml = builtHtml(html, origin + prefix + "api", origin + prefix + "events", nonce);
      await atomicJson2(root, PREVIEW_STATE, state);
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
    options[match[1] === "plugin-root" ? "pluginRoot" : match[1]] = match[1] === "port" ? Number(value) : path13.resolve(value);
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
    const fd = fs9.openSync(log, "a");
    const entrypoint = fileURLToPath4(import.meta.url), childArgs = [entrypoint, "serve", "--root", root, "--plugin-root", options.pluginRoot || fileURLToPath4(new URL("../", import.meta.url)), ...options.port === void 0 ? [] : ["--port", String(options.port)]];
    const child = spawn3(process.execPath, childArgs, { detached: true, windowsHide: true, shell: false, stdio: ["ignore", fd, fd] });
    child.unref();
    fs9.closeSync(fd);
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
if (process.argv[1] && pathToFileURL(path13.resolve(process.argv[1])).href === import.meta.url) main().catch((cause) => {
  console.error(JSON.stringify({ error: cause.code || "LIBRARY_PREVIEW_ERROR", message: cause.message }));
  process.exitCode = 1;
});
export {
  main
};
