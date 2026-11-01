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
  const marker3 = markers[0];
  let owner;
  if (marker3) {
    try {
      owner = readJson(path.join(directory, marker3));
    } catch (error3) {
      if (error3.code !== "INVALID_BRIDGE_STATE") throw error3;
    }
  }
  const valid = owner && Number.isInteger(owner.pid) && typeof owner.token === "string" && Number.isFinite(owner.at);
  if (valid ? alive(owner.pid) : Date.now() - stat.mtimeMs <= initializationGraceMs) return;
  if (marker3) fs.rmSync(path.join(directory, marker3), { force: true });
  try {
    fs.rmdirSync(directory);
  } catch (error3) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error3.code)) throw error3;
  }
}
function tryReaper(directory, initializationGraceMs) {
  const token = randomUUID();
  const marker3 = `owner-${token}.json`;
  const staging = `${directory}.${process.pid}.${token}.initializing`;
  fs.mkdirSync(staging);
  let published = false;
  try {
    fs.writeFileSync(path.join(staging, marker3), JSON.stringify({ pid: process.pid, token, at: Date.now() }), { mode: 384 });
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
      fs.rmSync(path.join(directory, marker3), { force: true });
      try {
        fs.rmdirSync(directory);
      } catch (error3) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error3.code)) throw error3;
      }
    };
  } finally {
    if (!published) {
      fs.rmSync(path.join(staging, marker3), { force: true });
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
  const marker3 = { v: 1, at: at2 };
  if (kind === "slides") return [entry("project/deck.json", { v: 4, createdOnFiles: marker3, lists: "css", title, order: ["cover"], cover: "cover", sections: {}, faces: {}, designSystems: [] }), entry("project/slides/cover.html", '<section id="cover" style="background:#ffffff;color:#20211f;font-family:Arial,sans-serif;padding:128px;display:flex;flex-direction:column;gap:32px"></section>\n')];
  if (kind === "design") return [entry("project/canvas.json", { v: 3, createdOnFiles: marker3, title, launch: { view: "canvas" }, pages: [], boards: {}, order: [], notes: {}, designSystems: [] })];
  if (kind === "design-system") return [
    entry("project/design-system.json", { v: 3, layout: "files", createdOnFiles: marker3, title, namespace: "DesignSystem", libraries: [], sections: {}, groups: [], assetGroups: {}, blobs: {}, docs: { readme: "project/README.md", sections: [] } }),
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
          const native3 = validateFiles(record.kind, files);
          const changedAt = listed.reduce((latest, file) => file.modifiedAt > latest ? file.modifiedAt : latest, manifest.updatedAt);
          Object.assign(result, manifest, { title: native3.title, updatedAt: changedAt });
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
        const native3 = validateFiles(record.kind, files);
        const bundle = { format: BUNDLE_FORMAT, version: 1, kind: record.kind, title: native3.title, files: files.map(({ path: path13, encoding, data }) => ({ path: path13, encoding, data })) };
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
        const native3 = validateFiles(bundle.kind, files);
        return { kind: bundle.kind, title: native3.title, files };
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
        const native3 = validateFiles(kind, files);
        return { kind, title: native3.title, files };
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
        const native3 = await nativeTrashActivity({ ...inspected, path: root });
        if (native3?.busy) throw new LibraryError("ARTIFACT_BUSY", native3.reason);
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
var init_edit_request_dispatch = __esm({
  "source/scripts/edit-request-dispatch.mjs"() {
    init_library();
    init_edit_requests();
    init_safety();
    init_artifact_delivery();
    init_bridge_core();
    init_worker_core();
  }
});

// source/scripts/artifact-command.mjs
async function verifyEditorInstance(state, root, kind) {
  const fail3 = () => new BridgeError("EDITOR_IDENTITY_UNVERIFIED", "The recorded PID was not confirmed by this plugin editor’s live session endpoint. No process was stopped and its records were preserved; inspect the existing editor/process manually.");
  if (!state || !alive(state.pid) || state.kind !== kind || !samePath(state.root, root)) throw fail3();
  try {
    const url = new URL("__codex/editor-session", state.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw fail3();
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2e3), headers: { Accept: "application/json" } });
    if (!response.ok) throw fail3();
    const session = await response.json();
    if (session.pid !== state.pid || session.kind !== kind || !samePath(session.root, root) || !alive(state.pid)) throw fail3();
    return session;
  } catch {
    throw fail3();
  }
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
import fs8 from "node:fs";
import path12 from "node:path";
import { spawn as spawn3 } from "node:child_process";
import { fileURLToPath as fileURLToPath3, pathToFileURL } from "node:url";

// source/server/http-preview.mjs
init_library();
init_safety();
init_worker_client();
import http from "node:http";
import fs7 from "node:fs/promises";
import path11 from "node:path";
import { randomBytes, randomUUID as randomUUID7 } from "node:crypto";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// source/server/service.mjs
init_bridge_core();
init_artifact_command();
import { spawn as spawn2 } from "node:child_process";
import { createHash as createHash8 } from "node:crypto";
import { readFile } from "node:fs/promises";
import path10 from "node:path";
import { fileURLToPath } from "node:url";

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
  const srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escape2(csp) + '"><meta name="referrer" content="no-referrer"><title>' + escape2(record.title) + "</title><style>" + extraCss + normalizer + '</style></head><body><svg class="codex-cover-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="xMidYMid meet"><foreignObject width="' + width + '" height="' + height + '"><div xmlns="http://www.w3.org/1999/xhtml" class="codex-cover-surface" style="width:' + width + "px;height:" + height + 'px;overflow:hidden">' + clean + "</div></foreignObject></svg><style>html,body{margin:0!important;width:100%;height:100%;overflow:hidden!important}body>.codex-cover-svg{display:block;width:100vw;height:100vh}.codex-cover-surface *{animation:none!important;transition:none!important;pointer-events:none!important}</style></body></html>";
  if (Buffer.byteLength(srcdoc) > limits.maxDocumentBytes) throw new LibraryError("THUMBNAIL_LIMIT", "The static cover exceeds its output limit.");
  return { artifactId: record.id, id: record.id, kind: record.kind, title: record.title, revision, cacheKey: record.id + ":" + revision, srcdoc, previewWidth: width, previewHeight: height, fidelity, sourceFile, notes };
}

// source/server/service.mjs
init_edit_requests();
init_safety();

// source/server/editor-transport.mjs
import { randomUUID as randomUUID5 } from "node:crypto";

// source/scripts/base64.mjs
function isValidBase64(value) {
  if (typeof value !== "string" || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.indexOf("=");
  return padding < 0 || value.length - padding <= 2 && /^={1,2}$/.test(value.slice(padding));
}

// source/server/editor-transport.mjs
var fail = (code, message) => Object.assign(new Error(message), { code });
var METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
var REQUEST_HEADERS = /* @__PURE__ */ new Set(["content-type", "accept", "if-match", "if-none-match", "last-event-id", "x-filename"]);
var RESPONSE_HEADERS = ["content-type", "content-disposition", "etag", "last-modified", "cache-control"];
var MAX_BODY = 32 * 1024 * 1024;
var MAX_RESPONSE = 64 * 1024 * 1024;
function validateEditorRequest(request = {}) {
  const method = String(request.method || "GET").toUpperCase();
  if (!METHODS.has(method)) throw fail("INVALID_EDITOR_REQUEST", "Unsupported editor request method.");
  const headers = new Headers();
  if (request.headers && (typeof request.headers !== "object" || Array.isArray(request.headers))) throw fail("INVALID_EDITOR_REQUEST", "Invalid editor request headers.");
  for (const [name, value] of Object.entries(request.headers || {})) {
    if (!REQUEST_HEADERS.has(name.toLowerCase()) || typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) throw fail("INVALID_EDITOR_REQUEST", "Unsupported editor request header.");
    headers.set(name, value);
  }
  let body;
  if (request.body !== void 0) {
    if (typeof request.body !== "string" || request.body.length > Math.ceil(MAX_BODY / 3) * 4 || !isValidBase64(request.body)) throw fail("INVALID_EDITOR_REQUEST", "Invalid editor request body.");
    body = Buffer.from(request.body, "base64");
    if (body.length > MAX_BODY || method === "GET" || method === "HEAD") throw fail("INVALID_EDITOR_REQUEST", "Invalid editor request body.");
  }
  return { method, headers, body };
}
function editorRequestUrl(base, relative) {
  const root = new URL(base);
  if (root.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(root.hostname) || root.username || root.password || !root.pathname.endsWith("/")) throw fail("INVALID_EDITOR_URL", "An authenticated local editor session is required.");
  if (typeof relative !== "string" || relative.length > 4096 || /[\\\u0000-\u0020]/.test(relative) || relative.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(relative)) throw fail("INVALID_EDITOR_REQUEST", "Only a request inside this artwork editor is accepted.");
  const path13 = relative.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(path13);
  } catch {
    throw fail("INVALID_EDITOR_REQUEST", "Invalid editor request encoding.");
  }
  if (decoded.includes("\\") || /[\u0000-\u001f]/.test(decoded) || decoded.split("/").some((part) => part === "." || part === "..") || /%2f|%5c|%2e/i.test(decoded)) throw fail("INVALID_EDITOR_REQUEST", "Editor requests cannot escape their artwork session.");
  const target = new URL(relative, root);
  if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname) || target.hash) throw fail("INVALID_EDITOR_REQUEST", "Editor requests cannot escape their artwork session.");
  return target;
}
async function limitedBody(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw fail("EDITOR_RESPONSE_TOO_LARGE", "The editor response exceeds the transfer limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
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
        if (buffer.length > 4 * 1024 * 1024) throw fail("EDITOR_EVENT_TOO_LARGE", "The editor event exceeds the transfer limit.");
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
      const { url } = await get(id, request.path);
      const { method, headers, body } = validateEditorRequest(request);
      headers.set("origin", url.origin);
      const response = await fetcher(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(3e4) });
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel();
        throw fail("INVALID_EDITOR_REQUEST", "Use the editor event subscription for a live stream.");
      }
      const bytes = await limitedBody(response, MAX_RESPONSE);
      return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(RESPONSE_HEADERS.flatMap((name) => response.headers.has(name) ? [[name, response.headers.get(name)]] : [])), body: bytes.toString("base64") };
    },
    async openEvents(id, path13) {
      const { url } = await get(id, path13);
      if (!/(?:^|\/)events$/.test(url.pathname)) throw fail("INVALID_EDITOR_REQUEST", "Only editor event endpoints can be subscribed.");
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
        throw fail("EDITOR_EVENTS_FAILED", "The local editor did not open its event stream.");
      }
      const stream = { id: randomUUID5(), artifactId: id, response, abort, events: [], cursor: 0, waiters: /* @__PURE__ */ new Set(), closed: false, ended: false };
      streams.set(stream.id, stream);
      touch(stream);
      void pump(stream);
      return { subscriptionId: stream.id, cursor: 0 };
    },
    async pollEvents(id, subscriptionId, cursor = 0) {
      const stream = streams.get(subscriptionId);
      if (!stream || stream.artifactId !== id || stream.closed) throw fail("EDITOR_SUBSCRIPTION_UNAVAILABLE", "The editor event subscription has closed.");
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stream.cursor) throw fail("INVALID_EDITOR_REQUEST", "Invalid editor event cursor.");
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

// source/server/native-comments.mjs
import { createHash as createHash6, randomUUID as randomUUID6 } from "node:crypto";
var fail2 = (code, message) => Object.assign(new Error(message), { code });
var encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
var jsonResult = (value, status = 200) => ({ status, statusText: status === 200 ? "OK" : "Accepted", headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: encode(value) });
var parseResult = (result) => {
  try {
    return JSON.parse(Buffer.from(result.body, "base64").toString("utf8"));
  } catch {
    throw fail2("INVALID_COMMENT_RESPONSE", "The comment service did not return valid JSON.");
  }
};
function createNativeComments({ requests, transport, editorFor, pollMs = 1e3, idleMs = 12e4 } = {}) {
  const streams = /* @__PURE__ */ new Map();
  const route = async (id, relative) => {
    const editor = await editorFor(id);
    const url = editorRequestUrl(editor.url, relative);
    const base = new URL(editor.url);
    const path13 = decodeURIComponent(url.pathname.slice(base.pathname.length)).split("/").filter(Boolean).join("/");
    return { editor, path: path13, url };
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
    if (result.status < 200 || result.status >= 300) throw fail2("COMMENTS_UNAVAILABLE", "The artwork comments could not be loaded.");
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
      attemptId: randomUUID6(),
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
      const { path: path13 } = await route(id, request.path);
      const { method, body } = validateEditorRequest(request);
      if (path13 === "__comments" && ["GET", "HEAD"].includes(method)) {
        const result = jsonResult(await snapshot(id));
        return method === "HEAD" ? { ...result, body: "" } : result;
      }
      const send = /^__comments\/([^/]+)\/send$/.exec(path13);
      if (send && method === "POST") {
        const current = await snapshot(id);
        const matches = current.threads.filter((item) => item.id === send[1]);
        if (!matches.length && send[1].length >= 3) matches.push(...current.threads.filter((item) => item.id.startsWith(send[1])));
        if (matches.length !== 1) throw fail2(matches.length ? "AMBIGUOUS_COMMENT" : "COMMENT_NOT_FOUND", "Select one existing comment before adding it to chat.");
        const thread = matches[0];
        return prepared(id, thread.id, jsonResult({ thread }));
      }
      const mutation = path13 === "__comments" && method === "POST" || /^__comments\/[^/]+\/messages(?:\/[^/]+)?$/.test(path13) && ["POST", "PATCH"].includes(method);
      const adHoc = path13 === "__comments/agent/requests" && method === "POST";
      if ((mutation || adHoc) && body) {
        if (body.length > 256 * 1024) throw fail2("INVALID_COMMENT", "The comment exceeds its transfer limit.");
        let input;
        try {
          input = JSON.parse(body.toString("utf8"));
        } catch {
          throw fail2("INVALID_COMMENT", "The comment request is not valid JSON.");
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) throw fail2("INVALID_COMMENT", "Expected a comment object.");
        if (input.send === true || adHoc) {
          const normal = adHoc ? {
            anchor: "request:" + randomUUID6(),
            label: input.label || "Artwork request",
            text: input.text,
            ...input.selection ? { detail: input.selection } : {},
            send: false
          } : { ...input, send: false };
          const result = await transport.request(id, { ...request, path: adHoc ? "__comments" : request.path, body: encode(normal) });
          if (result.status < 200 || result.status >= 300) return result;
          const saved = parseResult(result);
          if (!saved.thread?.id) throw fail2("INVALID_COMMENT_RESPONSE", "The saved comment has no identity.");
          return prepared(id, saved.thread.id, adHoc ? { ...result, body: encode({ ...saved, request: { id: saved.thread.id } }) } : result);
        }
      }
      return transport.request(id, request);
    },
    async openEvents(id, path13) {
      const found = await route(id, path13);
      if (found.path !== "__comments/events") return transport.openEvents(id, path13);
      const stream = { id: randomUUID6(), artifactId: id, cursor: 0, events: [], fingerprint: null, lastPoll: 0 };
      streams.set(stream.id, stream);
      touch(stream);
      return { subscriptionId: stream.id, cursor: 0 };
    },
    async pollEvents(id, subscriptionId, cursor = 0) {
      const stream = streams.get(subscriptionId);
      if (!stream) return transport.pollEvents(id, subscriptionId, cursor);
      if (stream.artifactId !== id) throw fail2("EDITOR_SUBSCRIPTION_UNAVAILABLE", "This comment stream belongs to another artwork.");
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stream.cursor) throw fail2("INVALID_EDITOR_REQUEST", "Invalid comment event cursor.");
      touch(stream);
      const delay = Math.max(0, pollMs - (Date.now() - stream.lastPoll));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!streams.has(subscriptionId)) return { events: [], cursor: stream.cursor, ended: true };
      const value = await snapshot(id);
      const data = JSON.stringify(value), fingerprint = createHash6("sha256").update(data).digest("hex");
      if (fingerprint !== stream.fingerprint) {
        stream.fingerprint = fingerprint;
        stream.events.push({ cursor: ++stream.cursor, event: "comments", data });
        if (stream.events.length > 128) stream.events.shift();
      }
      stream.lastPoll = Date.now();
      return { events: stream.events.filter((item) => item.cursor > cursor), cursor: stream.cursor, ended: false };
    },
    async closeEvents(id, subscriptionId) {
      const stream = streams.get(subscriptionId);
      if (!stream) return transport.closeEvents(id, subscriptionId);
      if (stream.artifactId !== id) throw fail2("EDITOR_SUBSCRIPTION_UNAVAILABLE", "This comment stream belongs to another artwork.");
      close(stream);
      return { closed: true };
    },
    dispose() {
      for (const stream of streams.values()) close(stream);
    }
  };
}

// source/server/editor-document.mjs
import { createHash as createHash7 } from "node:crypto";

// source/scripts/editor-runtime-adapter.mjs
function repairEditorRuntime(source) {
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
  let changed = false;
  const factory = /function ([\w$]+)\(\{base:[\w$]+,win:[\w$]+=window,modeShortcut:[\w$]+="C",launcher:[\w$]+,header:[\w$]+=!1,toolbar:[\w$]+=!1,pinSide:[\w$]+\}\)\{/.exec(source);
  if (factory) {
    const call = new RegExp(`${escape3(factory[1])}\\(\\{base:([\\w$]+)\\}\\)`, "g");
    source = source.replace(call, (_, base) => {
      changed = true;
      return `${factory[1]}({base:${base},toolbar:!!${native}})`;
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

// source/scripts/comment-draft-adapter.mjs
var native2 = "globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__";
var marker2 = "/* codex-design:native-comment-drafts */";
var rowPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:([\w$]+),thread:([\w$]+),current:[\w$]+\}\)\{/;
var threadPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:([\w$]+),thread:([\w$]+)\}\)\{/;
var composerPattern = /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,win:[\w$]+,pinSide:[\w$]+\}\)\{/;
var escape4 = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    (_, items) => `items:${native2}?[...${items},...__codexNativeCommentActions(${controller},${thread},${state})]:${items}`,
    1,
    "comment action menu"
  );
}
function addPresentation(text, component) {
  return text.replace(component.match[0], component.match[0] + `const __codexComment=${native2}?__codexNativeCommentPresentation(${component.match[4]}):null;`);
}
function adaptCommentDrafts(source) {
  if (source.includes(marker2)) return source;
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
  if (!label || !new RegExp(`\\b${escape4(label)}="Send to agent"`).test(source)) {
    throw new Error("The canonical send-to-agent label changed; native comment adaptation was refused.");
  }
  let rowText = addActions(addPresentation(row.text, row), row);
  rowText = replaceRequired(rowText, /label:"Send to agent"/g, `label:${native2}?"Add to chat":"Send to agent"`, 1, "comment edit label");
  rowText = replaceRequired(
    rowText,
    /"aria-label":"Sent to agent"/g,
    `"aria-label":${native2}?(__codexComment?.label??"Added to chat"):"Sent to agent"`,
    1,
    "comment sent indicator"
  );
  const jsx = /((?:[\w$]+\.jsx|\(0,[\w$]+\.jsx\)))\(/.exec(row.text)?.[1];
  if (!jsx) throw new Error("The canonical comment JSX runtime changed; native comment adaptation was refused.");
  rowText = replaceRequired(
    rowText,
    /,([\w$]+)>0&&!([\w$]+)&&!([\w$]+)&&/g,
    (_, replies, editing, deleting) => `,${native2}&&__codexComment&&${jsx}("span",{role:"status","data-codex-comment-status":__codexComment.status,className:"text-caption text-muted",children:__codexComment.label+(__codexComment.message?": "+__codexComment.message:"")}),${replies}>0&&!${editing}&&!${deleting}&&`,
    1,
    "comment list status"
  );
  let threadText = addActions(addPresentation(thread.text, thread), thread);
  const labels = new RegExp(`label:${escape4(label)},checked:`, "g");
  threadText = replaceRequired(threadText, labels, `label:${native2}?"Add to chat":${label},checked:`, 2, "comment reply/edit labels");
  const pending = /([\w$]+)=([\w$]+)==="pending"\?"queued":\2==="delivered"\?"working":void 0/.exec(threadText);
  if (!pending) throw new Error("The canonical comment delivery state changed; native comment adaptation was refused.");
  const activity = pending[1];
  threadText = threadText.replace(pending[0], `${activity}=${native2}?(__codexComment?.activity?__codexComment:void 0):(${pending[0].slice(activity.length + 1)})`);
  threadText = replaceRequired(
    threadText,
    new RegExp(`working:${escape4(activity)},footnote:(${escape4(activity)}==="queued"\\?"Waiting for the agent":"Working(?:…|\\\\u2026)")`, "g"),
    (_, footnote) => `working:${native2}?__codexComment.working:${activity},footnote:${native2}?__codexComment.label+(__codexComment.message?": "+__codexComment.message:""):${footnote}`,
    1,
    "comment activity label"
  );
  const composerText = replaceRequired(composer.text, labels, `label:${native2}?"Add to chat":${label},checked:`, 1, "new comment label");
  for (const part of [{ ...row, replacement: rowText }, { ...thread, replacement: threadText }, { ...composer, replacement: composerText }].sort((a, b) => b.start - a.start)) {
    source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
  }
  source = replaceRequired(
    source,
    /agentAvailable\(\)\{return /g,
    `agentAvailable(){if(${native2}?.canDraftComments===false)return false;return `,
    1,
    "native draft capability"
  );
  const helpers = [nativeCommentPresentation, nativeCommentCanAdd, nativeCommentActions].map((fn) => fn.toString().replace(/\bnativeCommentPresentation\b/g, "__codexNativeCommentPresentation").replace(/\bnativeCommentCanAdd\b/g, "__codexNativeCommentCanAdd").replace(/\bnativeCommentActions\b/g, "__codexNativeCommentActions")).join("\n");
  return marker2 + "\n" + helpers + "\n" + source;
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
  source = repairEditorRuntime(source);
  source = adaptCommentToolbar(source);
  source = adaptCommentDrafts(source);
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
    /new URL\((["'])\.\/\1,([\w$]+)\.location\.href\)\.href/g,
    (match) => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.baseUrl??${match})`
  );
  source = source.replace(
    /new URL\((["'])\.\/\1,location\.href\)\.href/g,
    (match) => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.baseUrl??${match})`
  );
  source = source.replace(
    /([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=\1\?null:([\w$]+)\.localComments\?\.\(([\w$]+)\)/g,
    (match, link, getParent, win, local, options, base) => `${link}=globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?null:${getParent}(${win}),${local}=${link}?null:${options}.localComments?.(${base})`
  );
  source = source.replace(
    /return ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\),\5&&\(\5\.onMessage\(async ([\w$]+)=>\{if\(\6\.type!==["']editor:flush["']\)return;const ([\w$]+)=await ([\w$]+)\(\2,\4\);/g,
    (match, listen, win, base, client, parent, request, saved, flush) => `return globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__&&(globalThis.__CODEX_DESIGN_EDITOR_FLUSH__=()=>${flush}(${win},${client})),${match.slice(7)}`
  );
  source = source.replace(
    /new URL\(target\.location\.href\)\.searchParams\.get\(["']codexDesignLanguage["']\)/g,
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
  return { html, bytes: outputBytes, assetCount: requests.size, sha256: createHash7("sha256").update(html).digest("hex"), virtualBase: virtual.href };
}

// source/scripts/editor-native-transport.js
function installNativeEditorTransport(configuration, target) {
  "use strict";
  target ??= window;
  const base = new URL(configuration.baseUrl);
  const channel = configuration.channel;
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
  const pendingWrites = /* @__PURE__ */ new Set();
  const sources = /* @__PURE__ */ new Set();
  const assetCache = /* @__PURE__ */ new Map();
  const assetAliases = /* @__PURE__ */ new Map();
  const assetIds = /* @__PURE__ */ new Set();
  let assetBytes = 0;
  if (target.crypto && typeof target.crypto.randomUUID !== "function" && typeof target.crypto.getRandomValues === "function") {
    const randomUUID8 = () => {
      const bytes = target.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = bytes[6] & 15 | 64;
      bytes[8] = bytes[8] & 63 | 128;
      return Array.from(bytes, (value, index) => ([4, 6, 8, 10].includes(index) ? "-" : "") + (value + 256).toString(16).slice(1)).join("");
    };
    Object.defineProperty(target.crypto, "randomUUID", { value: randomUUID8, configurable: true });
  }
  const originalFetch = target.fetch.bind(target);
  let sequence = 0;
  target.__CODEX_DESIGN_EDITOR_TRANSPORT__ = {
    baseUrl: base.href,
    artifactId: configuration.artifactId,
    canDraftComments: configuration.canDraftComments !== false
  };
  target.__CODEX_DESIGN_EDITOR_I18N__ = { preference: configuration.language || "system", systemLocale: configuration.locale };
  const bytesToBase64 = (bytes) => {
    let value = "";
    for (let offset = 0; offset < bytes.length; offset += 16384) value += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    return target.btoa(value);
  };
  const base64ToBytes = (text) => Uint8Array.from(target.atob(text), (character) => character.charCodeAt(0));
  const rpc = (action, payload = {}, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
      return;
    }
    const requestId2 = String(++sequence);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      pending.delete(requestId2);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
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
  target.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== target.parent || message?.channel !== channel) return;
    if (message.type === "codex-design:editor-flush") {
      void (async () => {
        try {
          target.document?.activeElement?.blur?.();
          if (typeof target.__CODEX_DESIGN_EDITOR_FLUSH__ === "function") {
            const saved = await target.__CODEX_DESIGN_EDITOR_FLUSH__();
            if (saved !== true) throw new Error("The editor still has unsaved changes.");
          } else {
            const deadline = Date.now() + 8e3;
            while (!target.dispatchEvent(new Event("beforeunload", { cancelable: true }))) {
              if (Date.now() >= deadline) throw new Error("The editor still has unsaved changes.");
              if (pendingWrites.size) await Promise.all([...pendingWrites]);
              else await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          await Promise.all([...pendingWrites]);
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
    if (message.type === "codex-design:host-context-changed") {
      const root = target.document?.documentElement;
      const context = message.context;
      if (!root || !context || typeof context !== "object") return;
      if (context.theme === "dark" || context.theme === "light") root.setAttribute("data-theme", context.theme);
      const variables = context.styles?.variables || {};
      if (typeof variables["--font-sans"] === "string") {
        root.style.setProperty("--cds-font-sans", variables["--font-sans"]);
        root.style.setProperty("--cds-font-sans-display", variables["--font-sans"]);
      }
      if (typeof variables["--font-mono"] === "string") root.style.setProperty("--cds-font-mono-ui", variables["--font-mono"]);
      const size = Number.parseFloat(variables["--font-text-md-size"]);
      if (Number.isFinite(size) && size >= 10 && size <= 32) root.style.setProperty("--cds-rem-scale", String(size / 16));
      if (typeof context.styles?.css?.fonts === "string") {
        let style = target.document.getElementById("codex-native-host-fonts");
        if (!style) {
          style = target.document.createElement("style");
          style.id = "codex-native-host-fonts";
          target.document.head.appendChild(style);
        }
        style.textContent = context.styles.css.fonts;
      }
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
      if (!/^\/(?:_api(?:\/|$)|_blob\/|_files\.json$|__comments(?:\/|$)|__deck\/|__design(?:-system)?\/|project\/|db\/)/.test(url.pathname)) return null;
      return url.pathname.slice(1) + url.search;
    }
    return url.pathname.slice(base.pathname.length) + url.search;
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
    const path13 = relative(url);
    if (path13 === null) return originalFetch(input, init);
    const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
    const headers = {};
    for (const name of ["content-type", "accept", "if-match", "if-none-match", "last-event-id", "x-filename"]) if (request.headers.has(name)) headers[name] = request.headers.get(name);
    let requestBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : void 0;
    if (requestBytes && /(?:^|\/)(?:__deck\/publish|_api\/write)$/.test(path13.split("?")[0]) && request.headers.get("content-type")?.includes("application/json")) requestBytes = await preserveAssetReferences(requestBytes);
    const body = requestBytes ? bytesToBase64(requestBytes) : void 0;
    const responseTask = rpc("editor.request", { request: { path: path13, method: request.method, headers, ...body === void 0 ? {} : { body } } }, init?.signal || request.signal);
    const writing = !["GET", "HEAD"].includes(request.method);
    if (writing) pendingWrites.add(responseTask);
    let response;
    try {
      response = await responseTask;
    } finally {
      if (writing) pendingWrites.delete(responseTask);
    }
    const result = new Response([101, 204, 205, 304].includes(response.status) || request.method === "HEAD" ? null : base64ToBytes(response.body), { status: response.status, statusText: response.statusText, headers: response.headers });
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
          for (const path13 of [url.href, url.pathname, "/" + relative2, relative2]) preview = preview.split(path13).join(vendor.url);
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

// source/server/editor-lifecycle.mjs
init_bridge_core();
import { spawn } from "node:child_process";
import fs6 from "node:fs";
import path9 from "node:path";
var failure = (code, message) => Object.assign(new Error(message), { code });
async function stopLocalEditor(record, { pluginRoot, env = process.env, timeoutMs = 15e3 } = {}) {
  const stateFile = path9.join(record.path, ".artifact-server.json");
  if (!fs6.existsSync(stateFile)) return { stopped: false };
  const state = readJson(stateFile);
  if (!state || state.kind !== record.kind || !samePath(state.root, record.path)) {
    throw failure("EDITOR_IDENTITY_UNVERIFIED", "The selected artwork editor record is invalid. Its process and files were preserved.");
  }
  const cli = path9.join(pluginRoot, "skills", `codex-${record.kind}`, "scripts", "codex-artifact.mjs");
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
var PLUGIN_UI_VERSION = "0.5.0";
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
  "editor.request",
  "editor.digest",
  "editor.events.open",
  "editor.events.poll",
  "editor.events.close",
  "request.draftAdded",
  "request.draftFailed"
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
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\\") || value.includes("%") || path10.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) || /[\u0000-\u001f:]/.test(value)) throw failure2("INVALID_PATH", "Only a safe artifact-relative content path is accepted.");
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
  const current = readJson(path10.join(record.path, ".artifact-server.json"));
  if (current && alive(current.pid)) {
    await verifyEditorInstance(current, record.path, record.kind);
    const binding = readJson(path10.join(record.path, ".codex-design-bridge.json"));
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
  const cli = path10.join(pluginRoot, "skills", skill, "scripts", "codex-artifact.mjs");
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [cli, "open-service", record.path, "--delivery", "native"], {
      cwd: record.path,
      env,
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
      if (code !== 0) return finish(failure2("EDITOR_START_FAILED", stderr.trim().slice(-2e3) || `Editor command exited ${code}.`));
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
function createDesignService({ store, pluginRoot = fileURLToPath(new URL("../", import.meta.url)), editorOpen = openLocalEditor, editorStop = stopLocalEditor } = {}) {
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
  const nativeComments = createNativeComments({ requests, transport, editorFor });
  const modelRequest = async (requestId2) => {
    const value = await requests.requestForModel(idOf(requestId2));
    if (value.status === "superseded") return value;
    const comments = await readJson2(value.artifactRoot, "comments.json", { version: 1, threads: [] });
    const projected = await requests.project(value.artifactId, { threads: comments.threads });
    const reported = projected.threads.find((thread) => thread.agent?.nativeRequest?.requestId === value.id)?.agent.nativeRequest;
    const cli = path10.join(pluginRoot, "skills", `codex-${value.artifact.kind}`, "scripts", "codex-artifact.mjs");
    return {
      ...value,
      ...reported ? { status: reported.status, phase: reported.phase } : {},
      skillFile: path10.join(pluginRoot, "skills", `codex-${value.artifact.kind}`, "SKILL.md"),
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
        case "request.draftAdded":
          return await requests.markDraftAdded(idOf(payload.requestId));
        case "request.draftFailed":
          return await requests.markDraftFailed(idOf(payload.requestId), payload.error);
        case "editor.document": {
          const id = idOf(payload.id);
          if (typeof payload.channel !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(payload.channel)) throw failure2("INVALID_EDITOR_REQUEST", "A unique editor channel is required.");
          const language = "en";
          const editor = await editorFor(id);
          const virtualBase = `https://codex-design.invalid/artifacts/${id}/`;
          const configuration = {
            artifactId: id,
            channel: payload.channel,
            baseUrl: virtualBase,
            language,
            hostDepth: 2,
            canDraftComments: payload.canDraftComments === true
          };
          if (editor.kind === "design-system") {
            configuration.previewVendors = await Promise.all([
              ["react.production.min.js", "d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd"],
              ["react-dom.production.min.js", "35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d"]
            ].map(async ([file, expected]) => {
              const bytes = await readFile(path10.join(pluginRoot, "skills/codex-design-system/scripts/editor/artifact-type/vendor", file));
              if (bytes.length > 256 * 1024 || createHash8("sha256").update(bytes).digest("hex") !== expected) throw failure2("EDITOR_VENDOR_INTEGRITY", "The packaged preview runtime failed its integrity check.");
              return { file, url: "data:text/javascript;base64," + bytes.toString("base64") };
            }));
          }
          const bootstrap = `(${installNativeEditorTransport.toString()})(${JSON.stringify(configuration).replace(/</g, "\\u003c")});`;
          const root = new URL(editor.url);
          const fetchLocal = async (value) => {
            const url = new URL(String(value));
            if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw failure2("INVALID_EDITOR_REQUEST", "Editor assets must stay inside their artwork session.");
            const relative = url.pathname.slice(root.pathname.length);
            editorRequestUrl(root.href, relative + url.search);
            let asset;
            if (!relative) asset = path10.join(pluginRoot, "skills", `codex-${editor.kind}`, "scripts/editor/index.html");
            else if (relative === "__codex/annotations.js") asset = path10.join(pluginRoot, "scripts/browser-annotations.js");
            else if (/^(?:assets\/[A-Za-z0-9._-]+|comments\.js|local-host\.js)$/.test(relative)) {
              asset = path10.join(pluginRoot, "skills", `codex-${editor.kind}`, "scripts/editor", relative);
            } else throw failure2("EDITOR_ASSET_REFUSED", "Only packaged static editor assets can be assembled.");
            const bytes = await readFile(asset);
            return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
          };
          const document2 = await buildEditorDocument({ baseUrl: editor.url, fetchLocal, config: { ...configuration, virtualBase, bootstrap } });
          return { ...editor, ...document2, artifactId: id, channel: payload.channel, transport: "mcp" };
        }
        case "editor.request":
          return await nativeComments.request(idOf(payload.id), payload.request);
        case "editor.digest": {
          await requireRecord(payload.id);
          if (payload.algorithm !== "SHA-256" || typeof payload.base64 !== "string" || payload.base64.length > 44739244 || !isValidBase64(payload.base64)) throw failure2("INVALID_EDITOR_DIGEST", "Only a bounded SHA-256 digest is supported.");
          const bytes = Buffer.from(payload.base64, "base64");
          if (bytes.length > 32 * 1024 * 1024) throw failure2("INVALID_EDITOR_DIGEST", "The digest input exceeds the transfer limit.");
          return { base64: createHash8("sha256").update(bytes).digest("base64") };
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
var samePath2 = (a, b) => process.platform === "win32" ? path11.resolve(a).toLowerCase() === path11.resolve(b).toLowerCase() : path11.resolve(a) === path11.resolve(b);
async function previewNativeActivity(record) {
  try {
    const status = await getWorkerStatus(record.path);
    return status.counts.active > 0 ? { busy: true, reason: "An unfinished native design job is recorded for this artwork." } : false;
  } catch {
    return { busy: true, reason: "The artwork task state cannot be verified." };
  }
}
function verifiedState(state, root) {
  if (!state || state.version !== 1 || state.kind !== KIND || !Number.isInteger(state.pid) || state.pid <= 0 || typeof state.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state.token) || typeof state.instanceId !== "string" || !samePath2(state.root, root)) throw error2("INVALID_PREVIEW_STATE", "The preview record cannot identify this library.");
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
  root = path11.resolve(root);
  if (!await statOrNull(root)) return { running: false, root };
  const state = await readJson2(root, PREVIEW_STATE, null);
  if (!state) return { running: false, root };
  const url = verifiedState(state, root);
  if (!alive2(state.pid)) return { running: false, stale: true, root, state };
  try {
    const response = await fetch(new URL("session", url), { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const session = response.ok ? await response.json() : null;
    if (!session || session.kind !== KIND || session.pid !== state.pid || session.instanceId !== state.instanceId || !samePath2(session.root, root)) throw error2("PREVIEW_IDENTITY_UNVERIFIED", "A live PID did not confirm this preview identity.");
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
async function startLibraryPreview({ root, pluginRoot = fileURLToPath2(new URL("../", import.meta.url)), store, service, html, port = 0, maxRequestBytes = 17 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw error2("INVALID_PREVIEW_OPTION", "Invalid preview port or request limit.");
  store ||= createLibraryStore({ ...root === void 0 ? {} : { root }, isBusy: previewNativeActivity });
  await store.initialize();
  root = store.root;
  pluginRoot = path11.resolve(pluginRoot);
  service ||= createDesignService({ store, pluginRoot });
  if (html === void 0) html = await fs7.readFile(path11.join(pluginRoot, "ui", "index.html"), "utf8");
  const token = randomBytes(32).toString("base64url"), instanceId = randomUUID7(), nonce = randomBytes(18).toString("base64");
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
      if (recorded?.instanceId === instanceId) await fs7.unlink(await safePath(root, PREVIEW_STATE, { type: "file" }));
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
    options[match[1] === "plugin-root" ? "pluginRoot" : match[1]] = match[1] === "port" ? Number(value) : path12.resolve(value);
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
    const fd = fs8.openSync(log, "a");
    const entrypoint = fileURLToPath3(import.meta.url), childArgs = [entrypoint, "serve", "--root", root, "--plugin-root", options.pluginRoot || fileURLToPath3(new URL("../", import.meta.url)), ...options.port === void 0 ? [] : ["--port", String(options.port)]];
    const child = spawn3(process.execPath, childArgs, { detached: true, windowsHide: true, shell: false, stdio: ["ignore", fd, fd] });
    child.unref();
    fs8.closeSync(fd);
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
if (process.argv[1] && pathToFileURL(path12.resolve(process.argv[1])).href === import.meta.url) main().catch((cause) => {
  console.error(JSON.stringify({ error: cause.code || "LIBRARY_PREVIEW_ERROR", message: cause.message }));
  process.exitCode = 1;
});
export {
  main
};
