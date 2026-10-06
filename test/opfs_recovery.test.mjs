// Crash-recovery, fault-injection and randomized robustness suites for the
// OPFS backend.
//
// Everything here drives guest syscalls through `syscall_harness.mjs`
// against a `MockOPFS`, tracks what a POSIX-like guest was promised in a
// small model, and compares the model with the live tree after every
// operation and with the recovered tree after every crash or clean reopen.
//
// Promises the model enforces (the backend's documented durability rules):
// - A namespace change (create, mkdir, rename, unlink, rmdir) is durable
//   when its syscall returns success. After a crash, every name the model
//   holds from successful syscalls is present, and no name the model
//   removed is present.
// - A failed namespace syscall is rolled back in the live tree. After a
//   crash it may or may not have taken effect, so the names it touched are
//   "uncertain": present or absent until the next reopen. Their content is
//   checked all the same (see below), against every file the failed
//   syscall could have left there - a failed create's empty file, a failed
//   rename's source, the files under a failed directory rename's source.
// - File content is durable after a successful fd_sync with no later write.
//   Otherwise a recovered file holds one of the contents it had since its
//   last successful fd_sync (including that one), or empty if it was never
//   synced. A failed unlink that destroyed the content counts as a write of
//   nothing: the name may then show an empty file, never anything else.
//   This holds for every recovered name, uncertain or not, so a name never
//   shows bytes that belong to another file. Every write carries a per-file
//   tag, so such aliasing is reported with the foreign tags it found.
//   Storage that keeps unflushed writes at a crash may also leave a
//   prefix of a content the file held and no fd_sync vouched for, once a
//   fault cut a background write short and its cleanup failed too.
// - fd_sync never lies: once it returns success, the file's content at
//   that moment (or a later one) survives a crash, unless a successful
//   namespace syscall removed or replaced the name since.
// - Host-seeded files (`fileSystem.addFile`) are not recorded until
//   `persistAll()`, first open, or a snapshot adopts them. The model's
//   policy: a seeded name may be absent after a crash until a guest
//   operation succeeds on it (open, rename, unlink, create beside it, and
//   so on) or `persistAll()` succeeds; from then on it must be durable. A
//   seeded file that is present holds its seed content or is empty (an
//   overdrafted adoption loses content that was only in memory).
// - After a clean close and reopen, names, contents and directory listing
//   order equal the live tree from before the close (seeded files that
//   were never persisted are exempt, as above, and uncertain names follow
//   the crash rules, since closing a handle may persist whatever a failed
//   syscall left). If close() rejects (a file past the spare pool never
//   got its data file), the reopen follows the crash rules.
// - persistAll() never lies either: once it resolves, every file it could
//   reach is durable under its name, with the content it held then, as
//   after an fd_sync. That holds when guest syscalls run while it waits
//   too: every file reachable when it resolves counts, except files
//   seeded meanwhile.
// - settle() promises no durability itself: once it resolves, fd_sync
//   works on every file (no file still waits for its data file).
// - Listing order survives every reopen for the names a successful
//   syscall made durable; names a failed syscall left uncertain, and
//   seeded names nothing recorded, are left out of the comparison, as they
//   may be missing (or, for a failed rename that took effect, at the end).
// - Symlinks keep their targets. Hard links to files and symlinks fail
//   with NOTSUP and leave nlink alone.
//   Linking, renaming, replacing or unlinking /dev/null, or moving /dev,
//   fails with NOTSUP, and /dev/null is there after every reopen.
// - fd_sync fails with NOSPC only for a file still waiting for its data
//   file, and with nothing else unless a fault fired.
// - A failed write or truncate leaves the old content, or what the call
//   was writing in part: a write past the end may leave the zero-filled
//   gap and any prefix of its bytes.
// - A store whose namespace slot or log is disguised as a later format,
//   or as the format of an earlier build ("UWM1" or "UWS1" slots, a
//   "UWL1" log), is refused by create() without a byte changing.
//
// Workloads interleave guest syscalls with host calls: settle(), awaited
// and un-awaited persistAll(), host seeding, and faults armed at random
// (one-shot and persistent, on every mock operation), with crashes right
// at a failure, after a directory fd_sync, or a few operations later.
// Besides create, write, fd_sync, mkdir, rmdir, rename and unlink, the
// guest truncates, opens with O_TRUNC, writes at offsets past the end,
// makes symlinks, tries hard links and device-node changes, and keeps
// using a directory after removing it, through an fd. Variants of the
// random suites crash keeping some handles' unflushed writes, as real
// storage may, and shrink the log compaction threshold (an internal
// knob) so the log is folded into snapshots every few changes. In about
// half the cases of every randomized suite, chosen by seed, closing a
// sync access handle only releases it, as the File System Standard
// allows, instead of persisting it.
//
// Debug knobs: UWASI_SEEDS / UWASI_STEPS / UWASI_BASE_SEED size the random
// suites (UWASI_FAULT_SEEDS the one with faults), UWASI_ONLY=<substring>
// keeps only the cases whose JSON contains it, UWASI_TRACE=<n> prints the
// last n trace lines, UWASI_NO_SEED=1 removes host seeding from the
// workloads, UWASI_NO_BACKGROUND=1 always awaits persistAll(),
// UWASI_STATS=1 prints fault-matrix counters, UWASI_CLOSE=flush|release
// forces how closing a handle behaves (see `storeFor`).
//
// Every failure message starts with a one-line reason, then the seed and
// the operation trace.
import { OPFSBackend } from "uwasi/opfs";
import { MockOPFS } from "./opfs_mock.mjs";
import {
  bindImports,
  sysCreate,
  sysOpen,
  sysWrite,
  sysReadText,
  sysClose,
  sysSync,
  sysUnlink,
  sysMkdir,
  sysRename,
  sysLink,
  PREOPEN_FD,
} from "./syscall_harness.mjs";
import { WASIAbi } from "../lib/esm/abi.js";
import { describe, it } from "node:test";
import assert from "node:assert";

const decoder = new TextDecoder();
const TRACE_LINES = Number(process.env.UWASI_TRACE ?? 80);
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  const rng = {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
  return rng;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Tags of the write chunks (and seed contents) found in `content`. */
function chunkTags(content) {
  const tags = new Set();
  for (const m of content.matchAll(/(T\d+)#\d+;|(seed-\d+)/g)) {
    tags.add(m[1] ?? m[2]);
  }
  return tags;
}

class MFile {
  constructor(tag, { seed = null } = {}) {
    this.type = "file";
    this.tag = tag;
    // Every tag this file's bytes may carry: its own write tag, its seed,
    // and (after a rebase) whatever the recovered content carried.
    this.tags = new Set([tag]);
    if (seed !== null) this.tags.add(seed);
    this.content = seed ?? "";
    this.seedContent = seed;
    // Contents the file may hold after a crash, wherever its node ends up:
    // the content at its last successful fd_sync (or creation, or seed),
    // and every content it held since.
    this.cands = seed === null ? [""] : ["", seed];
    this.persisted = seed === null;
    // The content a successful fd_sync (or persistAll) last vouched for,
    // or null, and which call it was.
    this.synced = null;
    this.syncedBy = null;
  }

  write(content) {
    this.content = content;
    this.cands.push(content);
  }

  /** `by` returned success: the current content is durable. */
  sync(by = "fd_sync") {
    this.cands = [this.content];
    this.synced = this.content;
    this.syncedBy = by;
  }
}

class MDir {
  constructor(persisted = true) {
    this.type = "dir";
    this.kids = new Map();
    this.persisted = persisted;
  }
}

class MLink {
  constructor(target) {
    this.type = "symlink";
    this.target = target;
    this.persisted = true;
  }
}

function splitPath(path) {
  return path === "" ? [] : path.split("/");
}

function under(path, prefix) {
  return path === prefix || path.startsWith(prefix + "/");
}

function contentOf(backend, node) {
  const size = backend.fileSize(node);
  const buffer = new Uint8Array(size);
  if (size > 0) backend.readAt(node, buffer, 0);
  return decoder.decode(buffer);
}

/**
 * Snapshot of a backend's live tree: paths -> {type, content or target},
 * listings, and what /dev holds (outside the model: the runtime owns it).
 */
function dumpTree(backend) {
  const nodes = new Map();
  const lists = new Map();
  const walk = (dir, base) => {
    const names = Object.keys(dir.entries).filter(
      (name) => !(base === "" && name === "dev"),
    );
    lists.set(base, names);
    for (const name of names) {
      const child = dir.entries[name];
      const path = base === "" ? name : `${base}/${name}`;
      if (child.type === "dir") {
        nodes.set(path, { type: "dir" });
        walk(child, path);
      } else if (child.type === "file") {
        nodes.set(path, { type: "file", content: contentOf(backend, child) });
      } else if (child.type === "symlink") {
        nodes.set(path, { type: "symlink", target: child.target });
      } else {
        nodes.set(path, { type: child.type });
      }
    }
  };
  const root = backend.fileSystem.lookup("/");
  walk(root, "");
  const dev = root.entries.dev;
  const devices =
    dev?.type === "dir"
      ? Object.keys(dev.entries).map((n) => `${n}:${dev.entries[n].type}`)
      : [];
  return { nodes, lists, devices: devices.join(",") };
}

// ---------------------------------------------------------------------------
// Store files, written and read behind the backend's back
// ---------------------------------------------------------------------------

function fnv1a(bytes, hash = 0x811c9dc5) {
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A namespace slot: magic, body length, checksum, body. The checksum is
 * FNV-1a over the first 8 bytes continued over the body, but over the
 * body alone for the "UWM1" and "UWS1" slots of earlier builds of the
 * backend.
 */
function verifiedSlot(magic, body) {
  const slot = new Uint8Array(12 + body.byteLength);
  const view = new DataView(slot.buffer);
  slot.set(new TextEncoder().encode(magic), 0);
  view.setUint32(4, body.byteLength, true);
  const seed = ["UWM1", "UWS1"].includes(magic)
    ? undefined
    : fnv1a(slot.subarray(0, 8));
  view.setUint32(8, fnv1a(body, seed), true);
  slot.set(body, 12);
  return slot;
}

/**
 * A log header's check: FNV-1a over the magic, then the generation; over
 * the generation alone for the "UWL1" logs of earlier builds.
 */
function logHeaderCheck(log) {
  const magic = decoder.decode(log.subarray(0, 4));
  const seed = magic === "UWL1" ? undefined : fnv1a(log.subarray(0, 4));
  return fnv1a(log.subarray(8, 16), seed);
}

/** The generation of an intact "UWS2" slot, else -1. */
function slotGen(slot) {
  if (slot === null || slot.byteLength < 13) return -1;
  const view = new DataView(slot.buffer, slot.byteOffset);
  const length = view.getUint32(4, true);
  if (12 + length > slot.byteLength) return -1;
  const body = slot.subarray(12, 12 + length);
  if (fnv1a(body, fnv1a(slot.subarray(0, 8))) !== view.getUint32(8, true)) {
    return -1;
  }
  if (new TextDecoder().decode(slot.subarray(0, 4)) !== "UWS2") return -1;
  let gen = 0;
  for (let i = 0, scale = 1; i < body.byteLength; i++, scale *= 128) {
    gen += (body[i] & 0x7f) * scale;
    if (body[i] < 0x80) return gen;
  }
  return -1;
}

/** A log frame of `body` that verifies at `offset` of a `gen` log. */
function verifiedFrame(body, gen, offset) {
  const seed = new Uint8Array(8);
  const seedView = new DataView(seed.buffer);
  seedView.setUint32(0, gen >>> 0, true);
  seedView.setUint32(4, offset, true);
  const frame = new Uint8Array(8 + body.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, body.byteLength, true);
  view.setUint32(4, fnv1a(body, fnv1a(seed)), true);
  frame.set(body, 8);
  return frame;
}

/** Replace a root-level store file's durable bytes, as another worker could. */
async function writeStoreFile(store, name, bytes) {
  const file = await store.root.getFileHandle(name, { create: true });
  const handle = await file.createSyncAccessHandle();
  handle.truncate(0);
  handle.write(bytes, { at: 0 });
  handle.flush();
  handle.close();
}

function storeBytes(store) {
  return new Map(store.rootNames().map((n) => [n, store.durableContent(n)]));
}

function bytesEqual(a, b) {
  return a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
}

/**
 * A mock store for case `seed`. Its sync access handles' close() either
 * persists, or only releases them, as the File System Standard allows;
 * which one is drawn from the seed (UWASI_CLOSE=flush or release forces
 * it). What a released handle left unflushed survives as often as a crash
 * keeps a handle's unflushed writes (`persist`).
 */
function storeFor(seed, persist = 0) {
  const rng = makeRng((seed ^ 0x2545f491) >>> 0);
  const forced = process.env.UWASI_CLOSE;
  const closeFlushes = forced ? forced === "flush" : rng.chance(0.5);
  return new MockOPFS({
    closeFlushes,
    keepReleased: persist,
    random: rng.next,
  });
}

// ---------------------------------------------------------------------------
// Simulation: backend + guest + model
// ---------------------------------------------------------------------------

const DIRS = ["", "x", "y", "x/z"];
const FILE_NAMES = ["a", "b", "c", "s0"];
const DIR_PATHS = ["x", "y", "x/z"];

const NOSPC = WASIAbi.WASI_ERRNO_NOSPC;
const NOTSUP = WASIAbi.WASI_ERRNO_NOTSUP;

function rmdirSyscall(h, path) {
  const bytes = new TextEncoder().encode(path);
  h.bytes.set(bytes, 0);
  return h.imports.path_remove_directory(PREOPEN_FD, 0, bytes.length);
}

function symlinkSyscall(h, target, path) {
  const encoder = new TextEncoder();
  const from = encoder.encode(target);
  const to = encoder.encode(path);
  h.bytes.set(from, 0);
  h.bytes.set(to, 128);
  return h.imports.path_symlink(0, from.length, PREOPEN_FD, 128, to.length);
}

/** path_rename between two directory fds. */
function renameAtSyscall(h, fromFd, from, toFd, to) {
  const encoder = new TextEncoder();
  const a = encoder.encode(from);
  const b = encoder.encode(to);
  h.bytes.set(a, 0);
  h.bytes.set(b, 128);
  return h.imports.path_rename(fromFd, 0, a.length, toFd, 128, b.length);
}

/** path_open of a directory: every right but FD_WRITE, all to inherit. */
function openDirSyscall(h, path) {
  const bytes = new TextEncoder().encode(path);
  h.bytes.set(bytes, 0);
  const all = BigInt((1 << 30) - 1);
  const errno = h.imports.path_open(
    PREOPEN_FD,
    0,
    0,
    bytes.length,
    WASIAbi.WASI_OFLAGS_DIRECTORY,
    all & ~(1n << 6n), // FD_WRITE
    all,
    0,
    4096,
  );
  return { errno, fd: h.view.getUint32(4096, true) };
}

/** fd_pwrite of `text` at `offset`; never moves the cursor. */
function pwriteSyscall(h, fd, offset, text) {
  const bytes = new TextEncoder().encode(text);
  h.bytes.set(bytes, 512);
  h.view.setUint32(256, 512, true);
  h.view.setUint32(260, bytes.length, true);
  return h.imports.fd_pwrite(fd, 256, 1, BigInt(offset), 4096 + 8);
}

/** `content` grown with zeros to `size`, if shorter. */
function zeroExtended(content, size) {
  return content.length < size
    ? content + "\0".repeat(size - content.length)
    : content;
}

/**
 * Whether `observed` is what a failed write of `text` at `at` may leave in
 * `old`: nothing, the zero-extension up to `at`, or any prefix of `text`
 * written over it (`writeAt` grows the file, then writes).
 */
function plausibleFailedWrite(observed, old, at, text) {
  if (observed === old) return true;
  const base = zeroExtended(old, at);
  for (let k = 0; k <= text.length; k++) {
    if (observed === base.slice(0, at) + text.slice(0, k) + base.slice(at + k))
      return true;
  }
  return false;
}

class Sim {
  constructor(
    store,
    {
      seed,
      label,
      spareFiles,
      faulty = false,
      persist = 0,
      compactAt = null,
      foreignRate = 0,
    },
  ) {
    this.store = store;
    this.seed = seed;
    this.label = label;
    this.spareFiles = spareFiles;
    this.faulty = faulty;
    // The chance that a crash keeps a handle's unflushed writes, drawn from
    // its own seeded stream so the operation sequence does not shift.
    this.persist = persist;
    this.crashRng = makeRng((seed ^ 0x5bd1e995) >>> 0);
    // Test-only log compaction threshold (see `OPFSBackend#compactAt`).
    this.compactAt = compactAt;
    // The chance that a reopen first checks that a namespace in an unknown
    // format is refused (see `checkForeignRefused`).
    this.foreignRate = foreignRate;
    this.faults = [];
    this.trace = [];
    this.root = new MDir();
    // Paths (with everything beneath) whose presence and type a failed
    // namespace syscall left open until the next reopen.
    this.uncertain = new Set();
    // Path -> files a failed syscall may have left at that name (a failed
    // create's empty file, a failed rename's source).
    this.maybe = new Map();
    // [recoveredPrefix, modelPrefix] pairs: a failed directory rename may
    // have taken effect, so a recovered path under the first may be the
    // model's path under the second.
    this.aliases = [];
    this.fds = [];
    this.counter = 0;
    this.tagCounter = 0;
    // A persistAll() started without awaiting it, or null: `{ promise,
    // checkpointed }`, see `opPersistAllBackground`.
    this.bgPersist = null;
    // Keep armed faults through reopens (removeEntry only runs there).
    this.keepFaultsOnReopen = false;
  }

  /** Run harness-side reads of the backend with every fault disarmed. */
  quiet(fn) {
    const saved = this.store._faults;
    this.store._faults = [];
    try {
      return fn();
    } finally {
      this.store._faults = saved;
    }
  }

  dump() {
    return this.quiet(() => dumpTree(this.backend));
  }

  fired() {
    return this.faults.reduce((n, f) => n + f.fired, 0);
  }

  clearFaults() {
    this.store.clearFaults();
    this.log("faults cleared");
  }

  addMaybe(path, file) {
    let set = this.maybe.get(path);
    if (!set) this.maybe.set(path, (set = new Set()));
    set.add(file);
  }

  /**
   * A successful rename moved whatever was at `from` to `to`: the
   * uncertainty a failed syscall left on paths under `from` moves along,
   * since records name directories by id, not path.
   */
  carryUncertainty(from, to) {
    const moved = (path) => to + path.slice(from.length);
    if (this.isUncertain(from)) this.uncertain.add(to);
    for (const path of [...this.uncertain]) {
      if (under(path, from)) this.uncertain.add(moved(path));
    }
    for (const [path, files] of [...this.maybe]) {
      if (under(path, from))
        for (const f of files) this.addMaybe(moved(path), f);
    }
    for (const [recovered, model] of [...this.aliases]) {
      if (under(model, from)) this.aliases.push([recovered, moved(model)]);
    }
  }

  /** Model paths a recovered `path` may correspond to. */
  aliasClosure(path) {
    const out = new Set([path]);
    for (let round = 0; round < 4; round++) {
      for (const p of [...out]) {
        for (const [recovered, model] of this.aliases) {
          if (under(p, recovered)) out.add(model + p.slice(recovered.length));
        }
      }
    }
    return out;
  }

  /** Every model file or symlink a recovered `path` may show. */
  candidates(path) {
    const nodes = new Set();
    for (const p of this.aliasClosure(path)) {
      const node = this.resolve(p);
      if (node !== undefined && node.type !== "dir") nodes.add(node);
      for (const f of this.maybe.get(p) ?? []) nodes.add(f);
    }
    return nodes;
  }

  /** Every model file whose content a recovered `path` may show. */
  candidateFiles(path) {
    return new Set([...this.candidates(path)].filter((n) => n.type === "file"));
  }

  checkSymlink(path, target, where) {
    const links = [...this.candidates(path)].filter(
      (n) => n.type === "symlink",
    );
    if (links.some((l) => l.target === target)) return;
    this.fail(
      `symlink ${path} after ${where} points to ${JSON.stringify(target)}; allowed ${JSON.stringify(links.map((l) => l.target))}`,
    );
  }

  /**
   * A recovered file at `path` must hold content one of its candidate
   * files may hold after a crash; in particular never bytes written to a
   * different file (aliasing), and never less than a successful fd_sync
   * vouched for.
   */
  checkFileContent(path, content, where) {
    const files = [...this.candidateFiles(path)];
    if (files.some((f) => f.cands.includes(content))) return;
    // A background write of a file's content (giving it its data file)
    // that a fault cut short, with the cleanup after it failing too, leaves
    // a prefix in the data file unflushed; storage that writes it back on
    // its own then keeps that prefix. A torn copy of the file's own content
    // that no fd_sync vouched for, as POSIX allows, never another file's.
    if (
      this.persist > 0 &&
      this.fired() > 0 &&
      files.some(
        (f) => f.synced === null && f.cands.some((c) => c.startsWith(content)),
      )
    ) {
      return;
    }
    const own = new Set(files.flatMap((f) => [...f.tags]));
    const foreign = [...chunkTags(content)].filter((t) => !own.has(t));
    if (foreign.length > 0) {
      this.fail(
        `aliasing: ${path} shows another file's bytes (${foreign.join(",")}) after ${where}: ${JSON.stringify(content)}; allowed ${JSON.stringify(files.flatMap((f) => f.cands))}`,
      );
    }
    const node = this.resolve(path);
    if (node?.type === "file" && node.synced !== null) {
      this.fail(
        `${node.syncedBy} of ${path} returned success for ${JSON.stringify(node.synced)}, but after ${where} it holds ${JSON.stringify(content)}; allowed ${JSON.stringify(files.flatMap((f) => f.cands))}`,
      );
    }
    this.fail(
      `content of ${path} after ${where} is ${JSON.stringify(content)}; allowed ${JSON.stringify(files.flatMap((f) => f.cands))}`,
    );
  }

  async open() {
    this.backend = await OPFSBackend.create(this.store.root, {
      spareFiles: this.spareFiles,
    });
    // An internal knob, not an option: reach compaction in short runs.
    if (this.compactAt) this.backend.compactAt = { ...this.compactAt };
    this.h = bindImports(this.backend, this.backend.fileSystem);
    this.fds = [];
  }

  /** The worker dies; storage may keep some unflushed work (`persist`). */
  crash() {
    const kept = this.store.simulateCrash({
      persist: this.persist,
      random: this.crashRng.next,
    });
    if (kept.length > 0) this.log(`crash kept unflushed ${kept.join(",")}`);
  }

  /** Reopen after a crash or close; with no fault armed it must succeed. */
  async reopen(where) {
    try {
      await this.open();
    } catch (error) {
      this.fail(`create() failed at ${where}: ${error.name}: ${error.message}`);
    }
  }

  log(message) {
    this.trace.push(message);
  }

  fail(reason) {
    const trace = this.trace.slice(-TRACE_LINES).join("\n");
    throw new Error(
      `${reason}\n[${this.label} seed=${this.seed} spareFiles=${this.spareFiles} close=${this.store.closeFlushes ? "flush" : "release"}]\n--- trace (last ${Math.min(TRACE_LINES, this.trace.length)} of ${this.trace.length}) ---\n${trace}`,
    );
  }

  // -- model access --------------------------------------------------------

  resolve(path) {
    let node = this.root;
    for (const part of splitPath(path)) {
      if (!node || node.type !== "dir") return undefined;
      node = node.kids.get(part);
    }
    return node;
  }

  parent(path) {
    const parts = splitPath(path);
    const name = parts.pop();
    return { dir: this.resolve(parts.join("/")), name };
  }

  walkModel(fn, node = this.root, base = "") {
    for (const [name, child] of node.kids) {
      const path = base === "" ? name : `${base}/${name}`;
      fn(path, child);
      if (child.type === "dir") this.walkModel(fn, child, path);
    }
  }

  newTag() {
    return `T${this.tagCounter++}`;
  }

  isUncertain(path) {
    for (const prefix of this.uncertain) {
      if (under(path, prefix)) return true;
    }
    return false;
  }

  /** The guest touched `path`: it and every ancestor are durable now. */
  touchChain(path) {
    const parts = splitPath(path);
    let node = this.root;
    for (const part of parts) {
      node = node?.kids?.get(part);
      if (!node) return;
      node.persisted = true;
    }
  }

  // -- verification --------------------------------------------------------

  /** The live tree must equal the model (rollbacks included). */
  checkLive(where) {
    const live = this.dump();
    this.checkDevices(live, where);
    this.walkModel((path, node) => {
      const got = live.nodes.get(path);
      if (!got) this.fail(`live tree lost ${path} (${where})`);
      if (got.type !== node.type) {
        this.fail(`live type mismatch at ${path} (${where})`);
      }
      if (node.type === "file" && got.content !== node.content) {
        this.fail(
          `live content of ${path} is ${JSON.stringify(got.content)}, model ${JSON.stringify(node.content)} (${where})`,
        );
      }
      if (node.type === "symlink" && got.target !== node.target) {
        this.fail(`live symlink ${path} points to ${got.target} (${where})`);
      }
    });
    for (const path of live.nodes.keys()) {
      if (!this.resolve(path)) {
        this.fail(`live tree has unexpected ${path} (${where})`);
      }
    }
    // A failed change is rolled back in place, so the live order always
    // matches the model.
    this.walkModel((path, node) => {
      if (node.type !== "dir") return;
      this.compareOrder(path, node, live, where);
    });
    this.compareOrder("", this.root, live, where);
    return live;
  }

  /** /dev holds /dev/null and nothing else, live and after every reopen. */
  checkDevices(tree, where) {
    if (tree.devices !== "null:character") {
      this.fail(`/dev holds [${tree.devices}] (${where})`);
    }
  }

  /**
   * The names in `dir`'s listing whose order a reopen must keep: those a
   * successful syscall made durable. Names a failed syscall left
   * uncertain may or may not be there (and if a failed rename took
   * effect, sit at the end), and seeded names nothing recorded may be
   * missing, so neither constrains the order of the rest.
   */
  orderedNames(path, dir) {
    return [...dir.kids]
      .filter(([name, node]) => {
        const child = path === "" ? name : `${path}/${name}`;
        return node.persisted && !this.isUncertain(child);
      })
      .map(([name]) => name);
  }

  /** Compare listing order after a reopen, on the names `orderedNames` keeps. */
  checkRecoveredOrder(lists, where) {
    const check = (path, dir) => {
      const want = this.orderedNames(path, dir);
      const keep = new Set(want);
      const got = (lists.get(path) ?? []).filter((n) => keep.has(n));
      if (want.join(",") !== got.join(",")) {
        this.fail(
          `listing order of /${path} after ${where} is [${got}], expected [${want}]`,
        );
      }
    };
    check("", this.root);
    this.walkModel((path, node) => {
      if (node.type === "dir") check(path, node);
    });
  }

  compareOrder(path, node, live, where) {
    const want = [...node.kids.keys()];
    const got = live.lists.get(path) ?? [];
    if (want.join(",") !== got.join(",")) {
      this.fail(
        `live listing order of /${path} is [${got}], model [${want}] (${where})`,
      );
    }
  }

  /**
   * Compare a tree recovered after a crash with the model. Names follow
   * the namespace rules (uncertain paths may or may not be present); the
   * content under every recovered name, uncertain or not, must be one its
   * candidate files may hold after a crash.
   */
  checkRecovered(recovered, where) {
    this.checkDevices(recovered, where);
    this.walkModel((path, node) => {
      const got = recovered.nodes.get(path);
      const unsure = this.isUncertain(path);
      if (!got) {
        if (unsure || !node.persisted) return;
        if (node.type === "file" && node.synced !== null) {
          this.fail(
            `${node.syncedBy} of ${path} returned success, but ${path} is gone after ${where}`,
          );
        }
        this.fail(`lost ${node.type} ${path} after ${where}`);
      }
      if (got.type !== node.type && !unsure) {
        this.fail(`type of ${path} changed after ${where}`);
      }
    });
    for (const [path, got] of recovered.nodes) {
      if (!this.resolve(path) && !this.isUncertain(path)) {
        this.fail(`unexpected ${got.type} ${path} appeared after ${where}`);
      }
      if (got.type === "file") this.checkFileContent(path, got.content, where);
      if (got.type === "symlink") this.checkSymlink(path, got.target, where);
    }
    this.checkRecoveredOrder(recovered.lists, where);
  }

  /** Adopt the recovered tree as the new model baseline. */
  rebase(recovered) {
    const old = new Map();
    this.walkModel((path, node) => old.set(path, node));
    const rebuilt = new MDir();
    const lists = recovered.lists;
    const build = (path, dir) => {
      for (const name of lists.get(path) ?? []) {
        const child = path === "" ? name : `${path}/${name}`;
        const got = recovered.nodes.get(child);
        if (got.type === "dir") {
          const sub = new MDir();
          dir.kids.set(name, sub);
          build(child, sub);
        } else if (got.type === "symlink") {
          dir.kids.set(name, new MLink(got.target));
        } else {
          const prior = old.get(child);
          const file = new MFile(
            prior?.type === "file" ? prior.tag : this.newTag(),
          );
          file.content = got.content;
          file.cands = [got.content];
          for (const tag of chunkTags(got.content)) file.tags.add(tag);
          dir.kids.set(name, file);
        }
      }
    };
    build("", rebuilt);
    this.root = rebuilt;
    this.uncertain = new Set();
    this.maybe = new Map();
    this.aliases = [];
    this.fds = [];
  }

  // -- guest operations ----------------------------------------------------

  /** Guest syscalls fail only after an injected fault fired. */
  unexpected(op, errno) {
    if (!this.faults.some((fault) => fault.fired > 0)) {
      this.fail(`${op} failed with errno ${errno} but no fault fired`);
    }
  }

  arm(spec) {
    const fault = this.store.injectFault(spec);
    this.faults.push(fault);
    return fault;
  }

  mismatch(op, errno, predicted) {
    this.fail(
      `model mismatch: ${op} returned errno ${errno}, model predicted ${predicted ? "success" : "failure"}`,
    );
  }

  /** path_open with CREAT, and with `trunc`, TRUNC. */
  opCreate(path, { trunc = false } = {}) {
    const { dir, name } = this.parent(path);
    const existing = dir?.type === "dir" ? dir.kids.get(name) : undefined;
    // An unfollowed final symlink cannot be opened.
    const predicted = dir?.type === "dir" && existing?.type !== "symlink";
    const oflags =
      WASIAbi.WASI_OFLAGS_CREAT | (trunc ? WASIAbi.WASI_OFLAGS_TRUNC : 0);
    const { errno, fd } = sysOpen(this.h, path, oflags);
    const what = trunc ? "create+trunc" : "create";
    this.log(`${what} ${path} -> ${errno}${errno === 0 ? ` fd${fd}` : ""}`);
    if (errno !== 0) {
      if (!predicted) return;
      this.unexpected(what, errno);
      if (!existing) {
        // It may have taken effect: an empty file the guest never wrote.
        this.uncertain.add(path);
        this.addMaybe(path, new MFile(this.newTag()));
      } else if (trunc) {
        // The truncate may have happened before the open failed.
        const node = this.backend.fileSystem.lookup("/" + path);
        const observed = this.quiet(() => contentOf(this.backend, node));
        if (observed !== existing.content) {
          if (observed !== "") {
            this.fail(`failed ${what} left ${JSON.stringify(observed)}`);
          }
          existing.write("");
        }
      }
      this.checkLive(`failed ${what} ${path}`);
      return;
    }
    if (!predicted) this.mismatch(what, errno, predicted);
    if (existing && trunc) existing.write("");
    let file = existing;
    if (!file) {
      file = new MFile(this.newTag());
      dir.kids.set(name, file);
      this.touchChain(splitPath(path).slice(0, -1).join("/"));
    } else {
      this.touchChain(path);
    }
    // A create beside unrecorded seeded files may snapshot everything, but
    // the policy only promises the names the guest touched.
    this.fds.push({
      file,
      node: this.backend.fileSystem.lookup("/" + path),
      pos: 0,
      fd,
      path,
    });
    this.checkLive(`create ${path}`);
  }

  pickFd(rng) {
    const open = this.fds.filter(Boolean);
    return open.length ? rng.pick(open) : null;
  }

  tagged(entry) {
    return `${entry.file.tag}#${this.counter++};`;
  }

  opWrite(entry, text) {
    const { errno, written } = sysWrite(this.h, entry.fd, text);
    this.log(`write fd${entry.fd}(${entry.path}) ${text} -> ${errno}`);
    const file = entry.file;
    const old = file.content;
    if (errno === 0) {
      if (written !== text.length) this.fail("short write reported as success");
      const base =
        old.length < entry.pos
          ? old + "\0".repeat(entry.pos - old.length)
          : old;
      const next =
        base.slice(0, entry.pos) + text + base.slice(entry.pos + text.length);
      file.write(next);
      entry.pos += text.length;
      this.checkLive(`write ${entry.path}`);
      return;
    }
    this.unexpected("write", errno);
    const observed = this.quiet(() => contentOf(this.backend, entry.node));
    if (!plausibleFailedWrite(observed, old, entry.pos, text)) {
      this.fail(
        `failed write left ${JSON.stringify(observed)} in ${entry.path}, was ${JSON.stringify(old)}`,
      );
    }
    file.write(observed);
    this.checkLive(`failed write ${entry.path}`);
  }

  opSync(entry) {
    const errno = sysSync(this.h, entry.fd);
    this.log(`fsync fd${entry.fd}(${entry.path}) -> ${errno}`);
    if (errno === 0) {
      entry.file.sync();
    } else if (errno !== NOSPC || !this.overdrafted(entry.node)) {
      // NOSPC is the honest answer only while the file waits for its data
      // file; anything else needs a fault to explain it.
      this.unexpected("fd_sync", errno);
    }
    return errno;
  }

  /** Whether `node` still waits for its data file (a private field). */
  overdrafted(node) {
    return this.backend.pendingIds.has(node);
  }

  opPwrite(entry, offset, text) {
    const errno = pwriteSyscall(this.h, entry.fd, offset, text);
    this.log(
      `pwrite fd${entry.fd}(${entry.path}) @${offset} ${text} -> ${errno}`,
    );
    const file = entry.file;
    const old = file.content;
    if (errno === 0) {
      const base = zeroExtended(old, offset);
      file.write(
        base.slice(0, offset) + text + base.slice(offset + text.length),
      );
      this.checkLive(`pwrite ${entry.path}`);
      return;
    }
    this.unexpected("pwrite", errno);
    const observed = this.quiet(() => contentOf(this.backend, entry.node));
    if (!plausibleFailedWrite(observed, old, offset, text)) {
      this.fail(
        `failed pwrite left ${JSON.stringify(observed)} in ${entry.path}, was ${JSON.stringify(old)}`,
      );
    }
    file.write(observed);
    this.checkLive(`failed pwrite ${entry.path}`);
  }

  opTruncate(entry, size) {
    const errno = this.h.imports.fd_filestat_set_size(entry.fd, BigInt(size));
    this.log(`truncate fd${entry.fd}(${entry.path}) ${size} -> ${errno}`);
    const file = entry.file;
    const next = zeroExtended(file.content.slice(0, size), size);
    if (errno === 0) {
      file.write(next);
      this.checkLive(`truncate ${entry.path}`);
      return;
    }
    this.unexpected("truncate", errno);
    const observed = this.quiet(() => contentOf(this.backend, entry.node));
    if (observed !== file.content && observed !== next) {
      this.fail(`failed truncate left ${JSON.stringify(observed)}`);
    }
    if (observed !== file.content) file.write(observed);
    this.checkLive(`failed truncate ${entry.path}`);
  }

  opSymlink(path) {
    const { dir, name } = this.parent(path);
    const predicted = dir?.type === "dir" && !dir.kids.has(name);
    // Dangling, and unique, so a symlink showing another's target is caught.
    const target = `nowhere/L${this.counter++}`;
    const errno = symlinkSyscall(this.h, target, path);
    this.log(`symlink ${path} -> ${target}: ${errno}`);
    if (errno !== 0) {
      if (predicted) {
        this.unexpected("symlink", errno);
        this.uncertain.add(path);
        this.addMaybe(path, new MLink(target));
      }
      this.checkLive(`symlink ${path}`);
      return;
    }
    if (!predicted) this.mismatch("symlink", errno, predicted);
    dir.kids.set(name, new MLink(target));
    this.touchChain(splitPath(path).slice(0, -1).join("/"));
    this.checkLive(`symlink ${path}`);
  }

  /**
   * path_link: hard links to files and symlinks are refused with NOTSUP,
   * whatever the backend recorded.
   */
  opLink(from, to) {
    const source = this.resolve(from);
    const { dir, name } = this.parent(to);
    const free = dir?.type === "dir" && !dir.kids.has(name);
    const errno = sysLink(this.h, from, to);
    this.log(`link ${from} ${to}: ${errno}`);
    if (errno === 0) this.fail(`path_link ${from} ${to} made a hard link`);
    if (source?.type === "file" || source?.type === "symlink") {
      if (free && errno !== NOTSUP) {
        this.fail(`path_link of ${from} returned ${errno}, not NOTSUP`);
      }
      const node = this.backend.fileSystem.lookup("/" + from);
      if (node.nlink !== 1) {
        this.fail(`a refused link left ${from} with nlink ${node.nlink}`);
      }
    }
    this.checkLive(`link ${from} ${to}`);
  }

  /**
   * Try to link, rename, replace or unlink /dev/null, or move /dev: the
   * runtime recreates them at every open, so each is refused with NOTSUP
   * once the syscall layer hands it to the backend.
   */
  opDevice(rng) {
    const path = randomFilePath(rng, this);
    const node = this.resolve(path);
    const { dir } = this.parent(path);
    const parentOk = dir?.type === "dir";
    let errno;
    let what;
    let reachesBackend;
    switch (rng.int(5)) {
      case 0:
        what = `link dev/null ${path}`;
        errno = sysLink(this.h, "dev/null", path);
        reachesBackend = parentOk && node === undefined;
        break;
      case 1:
        what = `rename dev/null ${path}`;
        errno = sysRename(this.h, "dev/null", path);
        reachesBackend = parentOk && node?.type !== "dir";
        break;
      case 2:
        what = `rename ${path} dev/null`;
        errno = sysRename(this.h, path, "dev/null");
        reachesBackend = node !== undefined && node.type !== "dir";
        break;
      case 3:
        what = "unlink dev/null";
        errno = sysUnlink(this.h, "dev/null");
        reachesBackend = true;
        break;
      default: {
        const to = rng.pick(["devices", "x/dev"]);
        what = `rename dev ${to}`;
        errno = sysRename(this.h, "dev", to);
        reachesBackend = this.parent(to).dir?.type === "dir";
      }
    }
    this.log(`${what}: ${errno}`);
    if (errno === 0) this.fail(`${what} succeeded`);
    if (reachesBackend && errno !== NOTSUP) {
      this.fail(`${what} returned ${errno}, not NOTSUP`);
    }
    this.checkLive(what);
  }

  /**
   * Open a directory, remove it, create a file in it through the fd (which
   * still works, though no path reaches it), maybe compact, then rename
   * the file back into the tree.
   */
  async opDetached(rng, { noBlock = false } = {}) {
    const empty = DIR_PATHS.filter((p) => {
      const node = this.resolve(p);
      return node?.type === "dir" && node.kids.size === 0;
    });
    if (empty.length === 0) return;
    const path = rng.pick(empty);
    const dirNode = this.backend.fileSystem.lookup("/" + path);
    const dirFd = openDirSyscall(this.h, path);
    this.log(`opendir ${path} -> ${dirFd.errno} fd${dirFd.fd}`);
    if (dirFd.errno !== 0) this.fail(`opening dir ${path}: ${dirFd.errno}`);
    try {
      this.opRmdir(path);
      if (this.resolve(path)) return;
      const created = sysCreate(this.h, "a", dirFd.fd);
      this.log(`create a in removed ${path} -> ${created.errno}`);
      if (created.errno !== 0) {
        this.unexpected("create in a removed dir", created.errno);
        return;
      }
      const file = new MFile(this.newTag());
      const text = `${file.tag}#${this.counter++};`;
      const wrote = sysWrite(this.h, created.fd, text);
      this.log(`write removed ${path}/a ${text} -> ${wrote.errno}`);
      if (wrote.errno === 0) {
        file.write(text);
      } else {
        this.unexpected("write", wrote.errno);
        const node = dirNode.entries.a;
        file.write(this.quiet(() => contentOf(this.backend, node)));
      }
      if (rng.chance(0.5)) {
        this.opSync({ file, node: dirNode.entries.a, fd: created.fd, path });
      }
      sysClose(this.h, created.fd);
      if (!noBlock && rng.chance(0.5)) {
        await this.drainBackground();
        await this.opPersistAll();
      }
      const to = randomFilePath(rng, this);
      const { dir: toDir, name: toName } = this.parent(to);
      const predicted =
        toDir?.type === "dir" && toDir.kids.get(toName)?.type !== "dir";
      const errno = renameAtSyscall(this.h, dirFd.fd, "a", PREOPEN_FD, to);
      this.log(`rename removed ${path}/a -> ${to}: ${errno}`);
      if (errno !== 0) {
        if (predicted) {
          this.unexpected("rename out of a removed dir", errno);
          this.uncertain.add(to);
          this.addMaybe(to, file);
        }
      } else {
        if (!predicted) this.mismatch("rename", errno, predicted);
        toDir.kids.set(toName, file);
        this.touchChain(splitPath(to).slice(0, -1).join("/"));
      }
    } finally {
      sysClose(this.h, dirFd.fd);
      this.checkLive(`removed dir ${path}`);
    }
  }

  opDirSync() {
    const errno = sysSync(this.h, PREOPEN_FD);
    this.log(`fsync dir -> ${errno}`);
    if (errno !== 0) this.unexpected("dir fsync", errno);
    this.checkLive("dir fsync");
  }

  opClose(entry) {
    const errno = sysClose(this.h, entry.fd);
    this.log(`close fd${entry.fd}(${entry.path}) -> ${errno}`);
    this.fds[this.fds.indexOf(entry)] = null;
  }

  opMkdir(path) {
    const { dir, name } = this.parent(path);
    const predicted = dir?.type === "dir" && !dir.kids.has(name);
    const errno = sysMkdir(this.h, path);
    this.log(`mkdir ${path} -> ${errno}`);
    if (errno !== 0) {
      if (predicted) {
        this.unexpected("mkdir", errno);
        this.uncertain.add(path);
      }
      this.checkLive(`mkdir ${path}`);
      return;
    }
    if (!predicted) this.mismatch("mkdir", errno, predicted);
    dir.kids.set(name, new MDir());
    this.touchChain(splitPath(path).slice(0, -1).join("/"));
    this.checkLive(`mkdir ${path}`);
  }

  opRmdir(path) {
    const { dir, name } = this.parent(path);
    const node = dir?.type === "dir" ? dir.kids.get(name) : undefined;
    const predicted = node?.type === "dir" && node.kids.size === 0;
    const errno = rmdirSyscall(this.h, path);
    this.log(`rmdir ${path} -> ${errno}`);
    if (errno !== 0) {
      if (predicted) {
        this.unexpected("rmdir", errno);
        this.uncertain.add(path);
      }
      this.checkLive(`rmdir ${path}`);
      return;
    }
    if (!predicted) this.mismatch("rmdir", errno, predicted);
    dir.kids.delete(name);
    this.touchChain(splitPath(path).slice(0, -1).join("/"));
    this.checkLive(`rmdir ${path}`);
  }

  predictRename(from, to) {
    const source = this.resolve(from);
    if (!source) return false;
    const { dir: toDir, name: toName } = this.parent(to);
    if (toDir?.type !== "dir") return false;
    const target = toDir.kids.get(toName);
    if (target === source) return true;
    if (source.type === "dir" && under(to, from)) return false;
    if (target) {
      if (source.type === "dir") {
        return target.type === "dir" && target.kids.size === 0;
      }
      return target.type !== "dir";
    }
    return true;
  }

  opRename(from, to) {
    const predicted = this.predictRename(from, to);
    const source = this.resolve(from);
    const { dir: toDir, name: toName } = this.parent(to);
    const errno = sysRename(this.h, from, to);
    this.log(`rename ${from} -> ${to}: ${errno}`);
    if (errno !== 0) {
      if (predicted) {
        this.unexpected("rename", errno);
        this.uncertain.add(from);
        this.uncertain.add(to);
        // If it took effect, `to` holds the source node.
        if (source.type !== "dir") this.addMaybe(to, source);
        else this.aliases.push([to, from]);
        this.carryUncertainty(from, to);
      }
      this.checkLive(`rename ${from} ${to}`);
      return;
    }
    if (!predicted) this.mismatch("rename", errno, predicted);
    if (this.resolve(to) !== source) {
      this.carryUncertainty(from, to);
      const { dir: fromDir, name: fromName } = this.parent(from);
      fromDir.kids.delete(fromName);
      toDir.kids.set(toName, source);
      // Only the renamed name itself is promised durable; names beneath a
      // renamed seeded dir are covered by a targeted test instead.
      source.persisted = true;
      this.touchChain(splitPath(to).slice(0, -1).join("/"));
      this.touchChain(splitPath(from).slice(0, -1).join("/"));
    }
    this.checkLive(`rename ${from} ${to}`);
  }

  opUnlink(path) {
    const { dir, name } = this.parent(path);
    const node = dir?.type === "dir" ? dir.kids.get(name) : undefined;
    const predicted = node !== undefined && node.type !== "dir";
    const liveNode = predicted
      ? this.backend.fileSystem.lookup("/" + path)
      : null;
    const errno = sysUnlink(this.h, path);
    this.log(`unlink ${path} -> ${errno}`);
    if (errno !== 0) {
      if (predicted) {
        this.unexpected("unlink", errno);
        this.uncertain.add(path);
      }
      if (node?.type === "file") {
        // The content may already be destroyed: the documented window in
        // which the name keeps pointing at an empty file. That is a write
        // of nothing, as far as crash candidates go; it must not let any
        // other file's bytes show under the name.
        const observed = this.quiet(() => contentOf(this.backend, liveNode));
        if (observed !== node.content) {
          if (observed !== "") {
            this.fail(
              `failed unlink left ${JSON.stringify(observed)} in ${path}, was ${JSON.stringify(node.content)}`,
            );
          }
          node.write("");
        }
      }
      this.checkLive(`failed unlink ${path}`);
      return;
    }
    if (!predicted) this.mismatch("unlink", errno, predicted);
    dir.kids.delete(name);
    this.touchChain(splitPath(path).slice(0, -1).join("/"));
    this.checkLive(`unlink ${path}`);
  }

  opSeed(path, text) {
    // Debug aid: UWASI_NO_SEED=1 removes host seeding from the workloads.
    if (process.env.UWASI_NO_SEED) return;
    const { dir, name } = this.parent(path);
    if (dir?.type !== "dir" || dir.kids.has(name)) return;
    // A seeded file inside a persisted dir only; the dir is live already.
    this.backend.fileSystem.addFile("/" + path, text);
    const file = new MFile(this.newTag(), { seed: text });
    dir.kids.set(name, file);
    this.log(`seed ${path} = ${text}`);
    this.checkLive(`seed ${path}`);
  }

  async opSettle() {
    let rejected = false;
    try {
      await this.backend.settle();
    } catch {
      rejected = true;
    }
    this.log(`settle${rejected ? " (rejected)" : ""}`);
    // After settle resolves, every file must be materialized: fd_sync works
    // unless a fault is still armed.
    if (!rejected && this.store._faults.length === 0) {
      for (const entry of this.fds.filter(Boolean)) {
        const errno = this.opSync(entry);
        if (errno !== 0) {
          this.fail(
            `settle() resolved but fd_sync(${entry.path}) fails with errno ${errno}`,
          );
        }
      }
    }
    this.checkLive("settle");
  }

  async opPersistAll() {
    try {
      await this.backend.persistAll();
    } catch (error) {
      this.log(`persistAll rejected: ${error.name}`);
      this.unexpected("persistAll", error.name);
      this.checkLive("failed persistAll");
      return;
    }
    this.log("persistAll");
    this.walkModel((_path, node) => {
      node.persisted = true;
      // Its content as of now is durable too, as after an fd_sync.
      if (node.type === "file") node.sync("persistAll");
    });
    this.checkLive("persistAll");
  }

  /**
   * Start persistAll() without awaiting it, so guest syscalls run while it
   * acquires handles and waits for background work. Its completion is
   * awaited by `drainBackground`. Files seeded while it waits are not
   * promised (a seed may land after it walked the tree), but once it
   * resolves, every other file reachable then is durable with the content
   * it held then, as after an fd_sync, and later crashes enforce that.
   *
   * persistAll() resolves in the same job as its final flush of the data
   * files, before any guest call can run, while a reaction to its promise
   * may run after one. So the model takes that checkpoint inside the flush
   * (a private method, wrapped for the call), once it succeeded.
   */
  opPersistAllBackground() {
    if (this.bgPersist) return;
    const backend = this.backend;
    // Seeded files nothing has recorded yet: covered only if present now.
    const unrecorded = new Set();
    this.walkModel((_path, node) => {
      if (!node.persisted) unrecorded.add(node);
    });
    const call = { promise: null, checkpointed: false };
    const flush = backend.flushDataFiles;
    backend.flushDataFiles = (...args) => {
      const failure = flush.apply(backend, args);
      if (failure === undefined && this.bgPersist === call) {
        call.checkpointed = true;
        this.log("persistAll checkpoint");
        this.walkModel((_path, node) => {
          if (!node.persisted && !unrecorded.has(node)) return;
          node.persisted = true;
          if (node.type === "file") node.sync("background persistAll");
        });
      }
      return failure;
    };
    this.bgPersist = call;
    call.promise = backend.persistAll();
    call.promise
      .catch(() => {})
      .then(() => {
        delete backend.flushDataFiles;
      });
    this.log("persistAll started");
  }

  async drainBackground() {
    const call = this.bgPersist;
    if (!call) return;
    let error = null;
    try {
      await call.promise;
    } catch (e) {
      error = e;
    }
    this.bgPersist = null;
    this.log(`persistAll finished${error ? ` (rejected: ${error.name})` : ""}`);
    if (error) {
      this.unexpected("persistAll", error.name);
    } else if (!call.checkpointed) {
      this.fail("persistAll() resolved without a final flush to check");
    }
    this.checkLive("background persistAll");
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Crash, reopen and check the recovered tree. With `reopenFault`, the
   * first reopen runs with that fault armed; if it fails, a retry in the
   * same worker - after letting anything the failed attempt left scheduled
   * run - must succeed.
   */
  async crashAndReopen(
    label = "crash",
    { gate = null, reopenFault = null } = {},
  ) {
    this.log(label);
    this.crash();
    this.bgPersist = null; // the dead worker's call fails on its own
    if (!this.keepFaultsOnReopen) this.store.clearFaults();
    if (gate) {
      // Parked calls from the dead worker resume now and must fail.
      gate.release();
      await tick();
    }
    if (this.foreignRate > 0 && this.crashRng.chance(this.foreignRate)) {
      await this.checkForeignRefused();
    }
    if (reopenFault) {
      await this.openWithFault(reopenFault);
    } else {
      await this.reopen(label);
    }
    const recovered = this.dump();
    this.checkRecovered(recovered, label);
    this.rebase(recovered);
    this.checkLive(`${label} rebase`);
  }

  /**
   * Open with `fault` armed. If that fails, retry in the same worker, after
   * letting anything the failed attempt left scheduled run; that must
   * succeed.
   */
  async openWithFault(fault) {
    if (fault) {
      this.store.injectFault(fault);
      this.log(`open with fault ${describeFault(fault)}`);
    }
    try {
      await this.open();
    } catch (error) {
      if (!/Simulated|short write/.test(String(error))) {
        this.fail(`create() failed: ${error.name}: ${error.message}`);
      }
      this.log(`open failed: ${error.name}`);
      for (let i = 0; i < 4; i++) await tick();
      this.store.clearFaults();
      try {
        await this.open();
      } catch (retryError) {
        this.fail(
          `retrying create() after a failed init failed: ${retryError.name}: ${retryError.message}`,
        );
      }
    }
    this.store.clearFaults();
  }

  /**
   * Disguise one namespace file as a foreign format and check that
   * create() refuses the store without changing a byte of it, then
   * restore it. A slot: one that verifies under a new magic, a "UWS2" one
   * that verifies but does not decode, a new magic whose checksum fails,
   * or the slot of an earlier build: "UWM1" JSON, or "UWS1" records with
   * a checksum over the body alone. A log: a header that verifies under a
   * new magic, a new magic whose check fails, an earlier build's "UWL1"
   * header, or a first frame that verifies but does not decode.
   */
  async checkForeignRefused() {
    const rng = this.crashRng;
    const name = rng.pick([
      ".uwasi.meta.0",
      ".uwasi.meta.1",
      ".uwasi.meta.log",
    ]);
    const original = this.store.durableContent(name);
    let foreign;
    let how;
    if (name.endsWith("log")) {
      // Only a header that verifies is read as a log at all.
      if (original === null || original.byteLength < 16) return;
      const view = new DataView(original.buffer, original.byteOffset);
      if (logHeaderCheck(original) !== view.getUint32(4, true)) return;
      foreign = new Uint8Array(original);
      const foreignView = new DataView(foreign.buffer);
      const gen = view.getUint32(8, true) + 2 ** 32 * view.getUint32(12, true);
      // Frames are read only in a log built on the snapshot loaded.
      const loaded = Math.max(
        slotGen(this.store.durableContent(".uwasi.meta.0")),
        slotGen(this.store.durableContent(".uwasi.meta.1")),
      );
      const variant = rng.int(gen === loaded ? 4 : 3);
      if (variant === 3) {
        how = "a frame of an unknown op";
        const frame = verifiedFrame(new Uint8Array([99, 0]), gen, 16);
        foreign = new Uint8Array(16 + frame.byteLength);
        foreign.set(original.subarray(0, 16), 0);
        foreign.set(frame, 16);
      } else if (variant === 2) {
        // An earlier build's header, sealed its way, over this log's
        // frames.
        foreign.set([0x55, 0x57, 0x4c, 0x31], 0); // "UWL1"
        foreignView.setUint32(4, logHeaderCheck(foreign), true);
        how = "an earlier build's UWL1";
      } else {
        foreign.set([0x55, 0x57, 0x4c, 0x33], 0); // "UWL3"
        how = "magic UWL3";
        if (variant === 0) {
          foreignView.setUint32(4, logHeaderCheck(foreign), true);
          how += ", resealed";
        }
      }
    } else {
      const variant = rng.int(5);
      if (variant === 3) {
        const json = { gen: rng.int(128), next: 0, root: { d: {} } };
        foreign = verifiedSlot(
          "UWM1",
          new TextEncoder().encode(JSON.stringify(json)),
        );
        how = "an earlier build's UWM1";
      } else if (variant === 4) {
        // Records that decode, under the magic and checksum of the binary
        // format's earlier builds.
        const body =
          original !== null && original.byteLength > 12
            ? original.subarray(12)
            : new Uint8Array([rng.int(128)]);
        foreign = verifiedSlot("UWS1", body);
        how = "an earlier build's UWS1";
      } else {
        const body = new Uint8Array([rng.int(128), 1, 2]);
        foreign = verifiedSlot(variant === 1 ? "UWS2" : "UWS3", body);
        how = [
          "magic UWS3",
          "an undecodable UWS2 body",
          "magic UWS3, unsealed",
        ][variant];
        if (variant === 2) foreign[8] ^= 0xff;
      }
    }
    this.log(`disguise ${name} as a foreign format: ${how}`);
    await writeStoreFile(this.store, name, foreign);
    const before = storeBytes(this.store);
    let opened = null;
    try {
      opened = await OPFSBackend.create(this.store.root, {
        spareFiles: this.spareFiles,
      });
    } catch (error) {
      if (!/does not understand/.test(error.message)) {
        this.fail(`a foreign format failed the open oddly: ${error.message}`);
      }
      if (how.includes("earlier") && !/earlier build/.test(error.message)) {
        this.fail(`an earlier format was refused unnamed: ${error.message}`);
      }
    }
    if (opened !== null)
      this.fail(`create() opened a store with a foreign ${name}`);
    const after = storeBytes(this.store);
    for (const [file, bytes] of before) {
      const now = after.get(file);
      if (now === undefined || !bytesEqual(bytes, now)) {
        this.fail(`a refused open changed ${file}`);
      }
    }
    if (after.size !== before.size) this.fail("a refused open added files");
    if (original === null) {
      await this.store.root.removeEntry(name);
    } else {
      await writeStoreFile(this.store, name, original);
    }
  }

  async closeAndReopen() {
    await this.drainBackground();
    this.log("close+reopen");
    const before = this.dump();
    let closeError = null;
    try {
      await this.backend.close();
    } catch (error) {
      closeError = error;
    }
    // Faults apply to the close, not the reopen.
    if (!this.keepFaultsOnReopen) this.store.clearFaults();
    await this.reopen("close+reopen");
    const after = this.dump();
    if (closeError) {
      // close() rejects when a file created past the pool never got its
      // data file, or a file's flush failed: that content is lost, as in
      // a crash.
      this.log(`close rejected: ${closeError.name}`);
      this.unexpected("close", closeError.name);
      this.checkRecovered(after, "rejected close");
      this.rebase(after);
      this.checkLive("rejected close rebase");
      return;
    }
    // Exact comparison with the pre-close live tree, except that names a
    // failed syscall left uncertain, and unpersisted seeded files, follow
    // the crash rules (closing a handle may persist whatever a failed
    // syscall left behind, so they are a crash that kept it).
    const exempt = (path) => {
      if (this.isUncertain(path)) return true;
      const node = this.resolve(path);
      return node !== undefined && !node.persisted;
    };
    for (const [path, want] of before.nodes) {
      if (exempt(path)) continue;
      const got = after.nodes.get(path);
      if (!got) this.fail(`lost ${want.type} ${path} across clean close`);
      if (got.type !== want.type) this.fail(`type of ${path} changed`);
      if (want.type === "file" && got.content !== want.content) {
        this.fail(
          `content of ${path} changed across clean close: ${JSON.stringify(want.content)} -> ${JSON.stringify(got.content)}`,
        );
      }
      if (want.type === "symlink" && got.target !== want.target) {
        this.fail(`symlink ${path} changed across clean close`);
      }
    }
    for (const [path, got] of after.nodes) {
      if (!exempt(path)) {
        if (!before.nodes.has(path)) {
          this.fail(`unexpected ${path} after clean close`);
        }
        continue;
      }
      if (got.type === "file") {
        this.checkFileContent(path, got.content, "clean close");
      }
      if (got.type === "symlink") {
        this.checkSymlink(path, got.target, "clean close");
      }
    }
    this.checkDevices(after, "clean close");
    this.checkRecoveredOrder(after.lists, "clean close");
    this.rebase(after);
    this.checkLive("close+reopen rebase");
  }
}

// ---------------------------------------------------------------------------
// Random operation generator (shared by the matrix and the model suite)
// ---------------------------------------------------------------------------

function randomFilePath(rng, sim) {
  const dirs = DIRS.filter((d) => d === "" || sim.resolve(d)?.type === "dir");
  const dir = rng.pick(dirs.length ? dirs : [""]);
  const name = rng.pick(FILE_NAMES);
  return dir === "" ? name : `${dir}/${name}`;
}

/**
 * Operations beyond create, write, sync, rename and unlink: resizing,
 * truncating opens, positional writes past the end, symlinks, refused
 * hard links, refused device-node changes, and a directory removed while
 * the guest keeps an fd on it.
 */
async function extraStep(sim, rng, { noBlock }) {
  const r = rng.next();
  const entry = sim.pickFd(rng);
  if (r < 0.2) {
    if (entry) sim.opTruncate(entry, rng.int(40));
  } else if (r < 0.32) {
    sim.opCreate(randomFilePath(rng, sim), { trunc: true });
  } else if (r < 0.52) {
    // Often past the end, leaving a zero-filled gap.
    if (entry) sim.opPwrite(entry, rng.int(60), sim.tagged(entry));
  } else if (r < 0.64) {
    sim.opSymlink(randomFilePath(rng, sim));
  } else if (r < 0.76) {
    sim.opLink(randomFilePath(rng, sim), randomFilePath(rng, sim));
  } else if (r < 0.86) {
    sim.opDevice(rng);
  } else {
    await sim.opDetached(rng, { noBlock });
  }
}

async function randomStep(
  sim,
  rng,
  {
    lifecycle = false,
    noBlock = false,
    compactRate = 0,
    background = false,
    seedRate = 0,
    extraRate = 0.15,
  } = {},
) {
  if (rng.chance(extraRate)) {
    await extraStep(sim, rng, { noBlock });
    return;
  }
  if (seedRate > 0 && rng.chance(seedRate)) {
    // Seed a host file, and often have the guest open it right away, which
    // adopts it into a spare data file.
    const path = randomFilePath(rng, sim);
    sim.opSeed(path, `seed-${sim.counter++}`);
    if (rng.chance(0.5)) sim.opCreate(path);
    return;
  }
  if (compactRate > 0 && !noBlock && rng.chance(compactRate)) {
    // Force a full snapshot: seed a file, then persist everything.
    sim.opSeed(randomFilePath(rng, sim), `seed-${sim.counter++}`);
    await sim.drainBackground();
    await sim.opPersistAll();
    return;
  }
  let r = rng.next();
  // While background work is held, settle/persistAll/close would wait.
  if (noBlock && r >= 0.94 && r < 0.97) r = 0.5;
  if (noBlock && r >= 0.985) r = 0.2;
  if (r < 0.2) {
    sim.opCreate(randomFilePath(rng, sim));
  } else if (r < 0.4) {
    const entry = sim.pickFd(rng);
    if (entry) sim.opWrite(entry, sim.tagged(entry));
  } else if (r < 0.5) {
    const entry = sim.pickFd(rng);
    if (entry) sim.opSync(entry);
  } else if (r < 0.57) {
    const entry = sim.pickFd(rng);
    if (entry) sim.opClose(entry);
  } else if (r < 0.63) {
    sim.opMkdir(rng.pick(DIR_PATHS));
  } else if (r < 0.66) {
    sim.opRmdir(rng.pick(DIR_PATHS));
  } else if (r < 0.77) {
    sim.opRename(randomFilePath(rng, sim), randomFilePath(rng, sim));
  } else if (r < 0.79) {
    const from = rng.pick(DIR_PATHS);
    const to = rng.pick(DIR_PATHS);
    if (!under(to, from) || to === from) sim.opRename(from, to);
  } else if (r < 0.88) {
    sim.opUnlink(randomFilePath(rng, sim));
  } else if (r < 0.91) {
    sim.opDirSync();
  } else if (r < 0.94) {
    await tick();
    sim.log("tick");
    sim.checkLive("tick");
    if (!noBlock && rng.chance(0.3)) await sim.drainBackground();
  } else if (r < 0.96) {
    await sim.drainBackground();
    await sim.opSettle();
  } else if (r < 0.97) {
    // Debug aid: UWASI_NO_BACKGROUND=1 always awaits persistAll().
    if (background && !process.env.UWASI_NO_BACKGROUND && rng.chance(0.5)) {
      sim.opPersistAllBackground();
    } else {
      await sim.drainBackground();
      await sim.opPersistAll();
    }
  } else if (r < 0.985) {
    const path = randomFilePath(rng, sim);
    sim.opSeed(path, `seed-${sim.counter++}`);
  } else if (lifecycle) {
    if (rng.chance(0.5)) await sim.crashAndReopen();
    else await sim.closeAndReopen();
  }
}

/**
 * A step that leans on what a failed syscall may have left behind: more
 * unlinks and creates, seeded files the guest opens (claiming spare data
 * files), and fsyncs vouching for what open files hold. Never waits for
 * background work.
 */
async function aftermathStep(sim, rng) {
  const r = rng.next();
  if (r < 0.25) {
    // Unlink an existing file, usually with no fd open, so that its
    // content is destroyed before the removal is recorded.
    const files = [];
    sim.walkModel((path, node) => {
      if (node.type === "file") files.push(path);
    });
    const path = files.length ? rng.pick(files) : randomFilePath(rng, sim);
    if (rng.chance(0.7)) {
      for (const entry of sim.fds.filter((e) => e && e.path === path)) {
        sim.opClose(entry);
      }
    }
    sim.opUnlink(path);
  } else if (r < 0.5) {
    const path = randomFilePath(rng, sim);
    sim.opSeed(path, `seed-${sim.counter++}`);
    sim.opCreate(path);
  } else if (r < 0.75) {
    const entry = sim.pickFd(rng);
    if (entry) {
      sim.opWrite(entry, sim.tagged(entry));
      sim.opSync(entry);
    }
  } else {
    await randomStep(sim, rng, { noBlock: true });
  }
}

async function runWorkload(sim, rng, steps, opts) {
  for (let i = 0; i < steps; i++) await randomStep(sim, rng, opts);
}

// ---------------------------------------------------------------------------
// Failure summarizing for the many-seed suites
// ---------------------------------------------------------------------------

function reasonOf(error) {
  return String(error.message)
    .split("\n")[0]
    .replace(/\b(?:x\/z|x|y|z)(?:\/(?:a|b|c|s0))?\b|\b(?:b|c|s0)\b/g, "<p>")
    .replace(/T\d+/g, "T#")
    .replace(/fd\d+/g, "fd#")
    .replace(/\d+/g, "#")
    .slice(0, 110);
}

/** Run `fn` for every case; fail once at the end with a summary by reason. */
async function runAll(cases, fn, after) {
  const failures = new Map();
  let total = 0;
  const only = process.env.UWASI_ONLY;
  for (const c of cases) {
    if (
      only &&
      !JSON.stringify(c, (_k, v) =>
        v instanceof RegExp ? String(v) : v,
      ).includes(only)
    )
      continue;
    total++;
    try {
      await fn(c);
    } catch (error) {
      const reason = reasonOf(error);
      const entry = failures.get(reason) ?? { count: 0, example: error };
      entry.count++;
      failures.set(reason, entry);
    }
  }
  after?.();
  if (failures.size === 0) return;
  const lines = [
    `${[...failures.values()].reduce((s, f) => s + f.count, 0)} of ${total} cases failed, ${failures.size} distinct reasons:`,
  ];
  for (const [reason, { count, example }] of failures) {
    lines.push(`\n=== ${count}x ${reason}\n${example.message}`);
  }
  assert.fail(lines.join("\n"));
}

const SPARE_CHOICES = [0, 1, 2, 16];

// ---------------------------------------------------------------------------
// (a) Fault-injection boundary matrix
// ---------------------------------------------------------------------------

const BOUNDARIES = [
  { name: "snapshot slot write", op: "write", match: /meta\.[01]$/ },
  {
    name: "snapshot slot short write",
    op: "write",
    match: /meta\.[01]$/,
    short: 3,
  },
  { name: "snapshot slot truncate", op: "truncate", match: /meta\.[01]$/ },
  { name: "snapshot slot flush", op: "flush", match: /meta\.[01]$/ },
  { name: "log append/reset write", op: "write", match: /meta\.log$/ },
  {
    name: "log append short write",
    op: "write",
    match: /meta\.log$/,
    short: 5,
  },
  { name: "log truncate", op: "truncate", match: /meta\.log$/ },
  { name: "log append/reset flush", op: "flush", match: /meta\.log$/ },
  { name: "data write", op: "write", match: /data\.\d+$/ },
  { name: "data short write", op: "write", match: /data\.\d+$/, short: 2 },
  {
    name: "data truncate (destroy/spare)",
    op: "truncate",
    match: /data\.\d+$/,
  },
  {
    name: "data flush (destroy/adopt/fsync)",
    op: "flush",
    match: /data\.\d+$/,
  },
  {
    name: "data getFileHandle (refill/materialize)",
    op: "getFileHandle",
    match: /data\.\d+$/,
  },
  {
    name: "data createSyncAccessHandle",
    op: "createSyncAccessHandle",
    match: /data\.\d+$/,
  },
  { name: "data removeEntry", op: "removeEntry", match: /data\.\d+$/ },
];

describe("fault-injection boundary matrix", () => {
  for (const boundary of BOUNDARIES) {
    it(`${boundary.name}: continue, crash, recover`, async () => {
      const cases = [];
      for (const nth of [1, 2, 3, 4, 6, 9, 13]) {
        for (const times of [1, 3]) {
          for (let variant = 0; variant < 9; variant++) {
            cases.push({ nth, times, variant });
          }
        }
      }
      let totalFired = 0;
      await runAll(
        cases,
        async ({ nth, times, variant }) => {
          const seed = 1000 * nth + 100 * times + variant;
          const rng = makeRng(seed);
          // Every other variant crashes keeping some unflushed writes.
          const persist = variant % 2 === 1 ? 0.5 : 0;
          const store = storeFor(seed, persist);
          const sim = new Sim(store, {
            seed,
            label: `${boundary.name} nth=${nth} times=${times}`,
            spareFiles: SPARE_CHOICES[(nth + variant) % SPARE_CHOICES.length],
            faulty: true,
            persist,
          });
          await sim.open();
          await runWorkload(sim, rng, 12, { compactRate: 0.03 });
          const fault = sim.arm({
            op: boundary.op,
            match: boundary.match,
            nth,
            times,
            short: boundary.short,
          });
          sim.log(`ARM ${boundary.name} nth=${nth} times=${times}`);
          await runWorkload(sim, rng, 40, { compactRate: 0.06 });
          // Keep using the backend with the fault gone (or still pending).
          store.clearFaults();
          sim.log(`fault fired ${fault.fired}x; cleared`);
          await runWorkload(sim, rng, 25, { compactRate: 0.0 });
          await sim.opSettle();
          sim.opDirSync();
          // removeEntry only runs while closing (excess spares) and opening
          // (surplus data files), so its fault stays armed through both.
          const atReopen = boundary.op === "removeEntry";
          if (variant % 3 === 2 || atReopen) {
            // Faults at shutdown too (excess spare removal, final flushes).
            sim.arm({
              op: boundary.op,
              match: boundary.match,
              nth: 1,
              times,
              short: boundary.short,
            });
          }
          sim.keepFaultsOnReopen = atReopen;
          if (variant % 3 === 2) await sim.closeAndReopen();
          else await sim.crashAndReopen();
          sim.keepFaultsOnReopen = false;
          store.clearFaults();
          // More use on the recovered backend, then a second crash.
          await runWorkload(sim, rng, 20, { compactRate: 0.0 });
          await sim.crashAndReopen("second crash");
          totalFired += sim.faults.reduce((n, f) => n + f.fired, 0);
        },
        () => {
          if (process.env.UWASI_STATS) {
            console.log(`${boundary.name}: fired ${totalFired}`);
          }
        },
      );
      assert.ok(totalFired > 0, `${boundary.name}: no fault ever fired`);
    });
  }

  it("faults armed across a reopen: recovery still succeeds", async () => {
    const cases = [];
    for (const b of BOUNDARIES.filter((x) =>
      [
        "getFileHandle",
        "createSyncAccessHandle",
        "removeEntry",
        "write",
        "truncate",
        "flush",
      ].includes(x.op),
    )) {
      for (const nth of [1, 2, 4, 7]) cases.push({ b, nth });
    }
    await runAll(cases, async ({ b, nth }) => {
      const seed = 77 + nth;
      const rng = makeRng(seed);
      const store = storeFor(seed);
      const sim = new Sim(store, {
        seed,
        label: `reopen with ${b.name} nth=${nth}`,
        spareFiles: SPARE_CHOICES[nth % 4],
        faulty: true,
      });
      await sim.open();
      await runWorkload(sim, rng, 40, {});
      store.simulateCrash();
      // The reopen runs with a fault armed; whether it fails is up to the
      // backend, but afterwards a fresh worker must recover.
      store.injectFault({
        op: b.op,
        match: b.match,
        nth,
        times: 1,
        short: b.short,
      });
      let retryError = null;
      try {
        const first = await OPFSBackend.create(store.root, {
          spareFiles: sim.spareFiles,
        });
        // Opened despite the fault: it must not have lost anything.
        sim.checkRecovered(dumpTree(first), `reopen under ${b.name}`);
      } catch (error) {
        if (!/Simulated|Quota|short write/.test(String(error))) throw error;
        // A failed init must release its handles: an embedder retrying in
        // the same worker has no restart to fall back on.
        store.clearFaults();
        try {
          const retried = await OPFSBackend.create(store.root, {
            spareFiles: sim.spareFiles,
          });
          sim.checkRecovered(dumpTree(retried), `retry after failed ${b.name}`);
        } catch (retryFailure) {
          retryError = retryFailure;
        }
      }
      store.clearFaults();
      store.simulateCrash();
      await sim.open();
      const recovered = dumpTree(sim.backend);
      sim.checkRecovered(recovered, `final reopen after ${b.name}`);
      if (retryError) {
        sim.fail(
          `retrying create() after a failed init failed: ${retryError.name}: ${retryError.message}`,
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// (a') Crash at the point of failure
// ---------------------------------------------------------------------------

const SLOT = /meta\.[01]$/;
const LOG = /meta\.log$/;
const DATA_FILE = /data\.\d+$/;

// Two faults armed together; the first few leave stray bytes behind (a
// failed write that cannot be truncated back), which a later flush - a
// directory fd_sync, or close() - may publish.
const COMBOS = [
  {
    name: "log flush + log truncate (stray log frame)",
    faults: [
      { op: "flush", match: LOG },
      { op: "truncate", match: LOG },
    ],
  },
  {
    name: "slot flush + slot truncate (stray snapshot)",
    faults: [
      { op: "flush", match: SLOT },
      { op: "truncate", match: SLOT },
    ],
  },
  {
    name: "slot write + slot truncate",
    faults: [
      { op: "write", match: SLOT },
      { op: "truncate", match: SLOT },
    ],
  },
  {
    name: "log short write + log truncate",
    faults: [
      { op: "write", match: LOG, short: 5 },
      { op: "truncate", match: LOG },
    ],
  },
  {
    name: "log flush + slot write",
    faults: [
      { op: "flush", match: LOG },
      { op: "write", match: SLOT },
    ],
  },
  {
    name: "log flush + data write",
    faults: [
      { op: "flush", match: LOG },
      { op: "write", match: DATA_FILE },
    ],
  },
  {
    name: "slot write + data flush",
    faults: [
      { op: "write", match: SLOT },
      { op: "flush", match: DATA_FILE },
    ],
  },
  {
    name: "data truncate + log flush",
    faults: [
      { op: "truncate", match: DATA_FILE },
      { op: "flush", match: LOG },
    ],
  },
  {
    name: "log flush + data createSyncAccessHandle",
    faults: [
      { op: "flush", match: LOG },
      { op: "createSyncAccessHandle", match: DATA_FILE },
    ],
  },
  {
    name: "slot truncate + data getFileHandle",
    faults: [
      { op: "truncate", match: SLOT },
      { op: "getFileHandle", match: DATA_FILE },
    ],
  },
];

// What happens between the faulting operation and the crash: nothing, a
// directory fd_sync (which flushes whatever a failed write left behind),
// or a few more operations with no settle().
const CRASH_POINTS = ["now", "dirsync", "ops"];

describe("fault matrix: crash at the point of failure", () => {
  const rows = [
    // removeEntry runs only while opening and closing; the matrix above
    // keeps its fault armed through both.
    ...BOUNDARIES.filter((b) => b.op !== "removeEntry").map((b) => ({
      name: b.name,
      faults: [{ op: b.op, match: b.match, short: b.short }],
    })),
    ...COMBOS,
  ];
  for (const row of rows) {
    it(`${row.name}: crash at the failure`, async () => {
      const cases = [];
      for (const nth of [1, 2, 3, 5, 8]) {
        for (const times of [1, Infinity]) {
          for (const point of CRASH_POINTS) {
            for (let variant = 0; variant < 4; variant++) {
              cases.push({ nth, times, point, variant });
            }
          }
        }
      }
      let firedCases = 0;
      await runAll(
        cases,
        async ({ nth, times, point, variant }) => {
          const seed =
            7000 * nth +
            300 * (times === 1 ? 1 : 2) +
            10 * variant +
            point.length;
          const rng = makeRng(seed);
          // Every other variant crashes keeping some unflushed writes.
          const persist = variant % 2 === 1 ? 0.5 : 0;
          const store = storeFor(seed, persist);
          const sim = new Sim(store, {
            seed,
            label: `${row.name} nth=${nth} times=${times} crash=${point}`,
            spareFiles: SPARE_CHOICES[(nth + variant) % SPARE_CHOICES.length],
            faulty: true,
            persist,
          });
          await sim.open();
          await runWorkload(sim, rng, 12, {
            compactRate: 0.05,
            seedRate: 0.05,
          });
          for (const spec of row.faults) sim.arm({ ...spec, nth, times });
          sim.log(`ARM ${row.name} nth=${nth} times=${times}`);
          let fired = false;
          for (let i = 0; i < 60 && !fired; i++) {
            const before = sim.fired();
            await randomStep(sim, rng, { compactRate: 0.08, seedRate: 0.08 });
            fired = sim.fired() > before;
          }
          if (fired) firedCases++;
          if (point === "dirsync") sim.opDirSync();
          if (point === "ops") {
            for (let i = 2 + rng.int(6); i > 0; i--) {
              await aftermathStep(sim, rng);
            }
          }
          await sim.crashAndReopen(`crash at failure (${point})`);
          await runWorkload(sim, rng, 15, { compactRate: 0.03 });
          await sim.crashAndReopen("second crash");
        },
        () => {
          if (process.env.UWASI_STATS) {
            console.log(`${row.name}: fired in ${firedCases} cases`);
          }
        },
      );
      assert.ok(firedCases > 0, `${row.name}: no fault ever fired`);
    });
  }
});

// ---------------------------------------------------------------------------
// Targeted scenarios for the faults the matrix exercises generically
// ---------------------------------------------------------------------------

async function openBackend(store, options = {}) {
  const backend = await OPFSBackend.create(store.root, options);
  return { backend, h: bindImports(backend, backend.fileSystem) };
}

function listNames(backend, path = "/") {
  return backend
    .listChildren(backend.fileSystem.lookup(path))
    .filter((n) => n !== "dev");
}

describe("targeted fault scenarios", () => {
  it("a stray snapshot left by a failed truncate does not strand later log appends", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 4 });
    // A directory create on an unrecorded parent forces a snapshot via
    // persistAll-style compaction: use rename of a seeded file, which has
    // no record, so a full snapshot is taken. Simpler: persistAll() is
    // itself a compaction whose truncate we break.
    assert.strictEqual(sysCreate(h, "kept-1").errno, 0);
    backend.fileSystem.addFile("/seed", "seeded");
    const fault = store.injectFault({ op: "truncate", match: /meta\.[01]$/ });
    await assert.rejects(() => backend.persistAll());
    assert.strictEqual(fault.fired, 1);
    // The snapshot bytes are in the slot (written, not truncated, maybe
    // unflushed). Keep working: appended records build on the old
    // generation.
    assert.strictEqual(sysCreate(h, "later-1").errno, 0);
    assert.strictEqual(sysMkdir(h, "later-dir"), 0);
    assert.strictEqual(sysRename(h, "later-1", "later-2"), 0);
    // A directory fsync flushes every slot, making the stray newer
    // snapshot durable.
    assert.strictEqual(sysSync(h, PREOPEN_FD), 0);
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 4 });
    const names = listNames(w2.backend);
    for (const name of ["kept-1", "later-2", "later-dir"]) {
      assert.ok(names.includes(name), `${name} lost; have [${names}]`);
    }
    assert.ok(!names.includes("later-1"), "renamed source reappeared");
  });

  it("snapshot truncate failure while opening a seeded file strands nothing", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 4 });
    backend.fileSystem.addFile("/seed", "seeded");
    // mkdir under an unrecorded parent is not needed: open of the seeded
    // file compacts. Break the slot's truncate for that compaction.
    const fault = store.injectFault({ op: "truncate", match: /meta\.[01]$/ });
    assert.notStrictEqual(sysOpen(h, "seed").errno, 0);
    assert.strictEqual(fault.fired, 1);
    assert.strictEqual(sysCreate(h, "after-1").errno, 0);
    assert.strictEqual(sysCreate(h, "after-2").errno, 0);
    assert.strictEqual(sysSync(h, PREOPEN_FD), 0);
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 4 });
    const names = listNames(w2.backend);
    for (const name of ["after-1", "after-2"]) {
      assert.ok(names.includes(name), `${name} lost; have [${names}]`);
    }
  });

  it("a seeded file is durable once an open succeeds after a failed one", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 4 });
    backend.fileSystem.addFile("/seed", "seeded");
    // adopt() claims a spare and flushes the content; the namespace
    // record that follows fails.
    const fault = store.injectFault({ op: "write", match: /meta\.[01]$/ });
    const failed = sysOpen(h, "seed");
    assert.notStrictEqual(failed.errno, 0, "open should fail with the fault");
    assert.strictEqual(fault.fired, 1);
    const retry = sysOpen(h, "seed");
    assert.strictEqual(retry.errno, 0, "the retry succeeds");
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 4 });
    assert.ok(
      listNames(w2.backend).includes("seed"),
      "a seeded file opened successfully must be durable",
    );
  });

  it("a seeded file is durable once an open succeeds after a failed one, past the spare pool", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 0 });
    backend.fileSystem.addFile("/seed", "seeded");
    const fault = store.injectFault({ op: "write", match: /meta\.[01]$/ });
    assert.notStrictEqual(sysOpen(h, "seed").errno, 0);
    assert.strictEqual(fault.fired, 1);
    const retry = sysOpen(h, "seed");
    assert.strictEqual(retry.errno, 0);
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 0 });
    assert.ok(listNames(w2.backend).includes("seed"));
  });

  it("renaming a never-recorded seeded file is durable under the new name only", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 4 });
    backend.fileSystem.addFile("/seed", "seeded");
    assert.strictEqual(sysRename(h, "seed", "renamed"), 0);
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 4 });
    const names = listNames(w2.backend);
    assert.ok(names.includes("renamed"), `renamed lost; have [${names}]`);
    assert.ok(!names.includes("seed"), "source name resurrected");
  });

  it("renaming a dir that holds an unrecorded seeded file, then persistAll, keeps the file", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 4 });
    assert.strictEqual(sysMkdir(h, "d"), 0);
    backend.fileSystem.addFile("/d/seed", "seeded");
    assert.strictEqual(sysRename(h, "d", "e"), 0);
    await backend.persistAll();
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 4 });
    assert.deepStrictEqual(listNames(w2.backend), ["e"]);
    assert.deepStrictEqual(listNames(w2.backend, "/e"), ["seed"]);
  });

  it("renaming a seeded file over a recorded one never shows the replaced content", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 4 });
    const old = sysCreate(h, "target");
    assert.strictEqual(sysWrite(h, old.fd, "old target").errno, 0);
    assert.strictEqual(sysSync(h, old.fd), 0);
    // The fd stays open, so destruction of the replaced content is deferred
    // to its last close and a crash leaves the old bytes in the data file.
    backend.fileSystem.addFile("/seed", "seeded");
    assert.strictEqual(sysRename(h, "seed", "target"), 0);
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 4 });
    const r = sysOpen(w2.h, "target");
    assert.strictEqual(r.errno, 0);
    // The rename was durable: the name must not show the replaced file.
    assert.notStrictEqual(sysReadText(w2.h, r.fd).text, "old target");
  });

  it("settle() does not resolve over a failed background materialization", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 0 });
    const created = sysCreate(h, "pending");
    assert.strictEqual(created.errno, 0);
    assert.strictEqual(sysWrite(h, created.fd, "payload").errno, 0);
    assert.strictEqual(
      sysSync(h, created.fd),
      51,
      "pending file refuses fsync",
    );
    const fault = store.injectFault({
      op: "createSyncAccessHandle",
      match: /data\./,
    });
    let rejected = false;
    try {
      await backend.settle();
    } catch {
      rejected = true;
    }
    assert.strictEqual(fault.fired, 1);
    if (!rejected) {
      // Resolved: every file must now be materialized (retried).
      assert.strictEqual(
        sysSync(h, created.fd),
        0,
        "settle() resolved but the pending file never materialized",
      );
    }
    // Whatever settle did, the next attempt must not collide with a handle
    // the failed attempt left held.
    store.clearFaults();
    const again = (async () => {
      try {
        await backend.settle();
      } catch {
        // allowed
      }
    })();
    await again;
    await backend.close();
    const w2 = await openBackend(store, { spareFiles: 0 });
    const reopened = sysOpen(w2.h, "pending");
    assert.strictEqual(reopened.errno, 0, "name lost");
  });

  it("a failed materialization retried later does not hit an already-held handle", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 0 });
    const a = sysCreate(h, "a");
    assert.strictEqual(sysWrite(h, a.fd, "aaa").errno, 0);
    // The handle is acquired, then the write of the content fails.
    const fault = store.injectFault({ op: "write", match: /data\.\d+$/ });
    await backend.settle().catch(() => {});
    assert.strictEqual(fault.fired, 1);
    store.clearFaults();
    // A second create schedules more background work: it must be able to
    // finish materializing both files.
    const b = sysCreate(h, "b");
    assert.strictEqual(sysWrite(h, b.fd, "bbb").errno, 0);
    await backend.settle().catch(() => {});
    assert.strictEqual(sysSync(h, a.fd), 0, "file a never materialized");
    assert.strictEqual(sysSync(h, b.fd), 0, "file b never materialized");
  });

  it("a zero-length write past EOF does not extend the file", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 2 });
    const f = sysCreate(h, "z");
    assert.strictEqual(sysWrite(h, f.fd, "abc").errno, 0);
    // fd_pwrite with one empty iovec at offset 100.
    h.view.setUint32(256, 512, true);
    h.view.setUint32(260, 0, true);
    const errno = h.imports.fd_pwrite(f.fd, 256, 1, 100n, 4096);
    assert.strictEqual(errno, 0);
    const node = backend.fileSystem.lookup("/z");
    assert.strictEqual(backend.fileSize(node), 3, "empty write grew the file");
  });

  it("read and getSize faults surface as errno, not exceptions", async () => {
    const store = new MockOPFS();
    const { h } = await openBackend(store, { spareFiles: 2 });
    const f = sysCreate(h, "r");
    assert.strictEqual(sysWrite(h, f.fd, "data").errno, 0);
    assert.strictEqual(sysSeekStartHelper(h, f.fd), 0);
    const readFault = store.injectFault({ op: "read", match: /data\.\d+$/ });
    const failed = sysReadText(h, f.fd);
    assert.notStrictEqual(failed.errno, 0);
    assert.strictEqual(readFault.fired, 1);
    assert.strictEqual(sysSeekStartHelper(h, f.fd), 0);
    assert.strictEqual(sysReadText(h, f.fd).text, "data");
    const sizeFault = store.injectFault({
      op: "getSize",
      match: /data\.\d+$/,
    });
    const wrote = sysWrite(h, f.fd, "more");
    assert.notStrictEqual(wrote.errno, 0);
    assert.strictEqual(sizeFault.fired, 1);
  });

  it("a failed unlink then fsync'd rewrite of the orphaned file stays durable", async () => {
    // Destruction succeeds, the removal record fails: the name keeps
    // resolving, but its data file was recycled. Later writes must not be
    // lost behind a successful fd_sync.
    const store = new MockOPFS();
    const { h } = await openBackend(store, { spareFiles: 4 });
    const f = sysCreate(h, "victim");
    assert.strictEqual(sysWrite(h, f.fd, "old content").errno, 0);
    assert.strictEqual(sysSync(h, f.fd), 0);
    assert.strictEqual(sysClose(h, f.fd), 0);
    const fault = store.injectFault({ op: "flush", match: /meta\.log$/ });
    assert.notStrictEqual(sysUnlink(h, "victim"), 0);
    assert.strictEqual(fault.fired, 1);
    const g = sysOpen(h, "victim");
    assert.strictEqual(g.errno, 0, "the name keeps resolving");
    assert.strictEqual(sysWrite(h, g.fd, "fresh").errno, 0);
    // The open re-adopted the file into a fresh data file (nothing is
    // armed any more), so fd_sync has no reason to fail.
    assert.strictEqual(sysSync(h, g.fd), 0);
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 4 });
    const r = sysOpen(w2.h, "victim");
    assert.strictEqual(r.errno, 0, "victim lost");
    assert.strictEqual(
      sysReadText(w2.h, r.fd).text,
      "fresh",
      "fd_sync reported success but the rewritten content was lost",
    );
  });

  // The same with the file past the spare pool and its fd open across the
  // failed unlink, so it is still waiting for its data file.
  async function failedUnlinkOfPendingOpenFile() {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 1 });
    assert.strictEqual(sysCreate(h, "filler").errno, 0); // drains the pool
    const f = sysCreate(h, "victim");
    assert.strictEqual(f.errno, 0);
    const fault = store.injectFault({ op: "write", match: /meta\./ });
    assert.notStrictEqual(sysUnlink(h, "victim"), 0);
    assert.strictEqual(fault.fired, 1);
    assert.strictEqual(sysWrite(h, f.fd, "IMPORTANT").errno, 0);
    return { store, backend, h, fd: f.fd };
  }

  it("after a failed unlink of an open file past the spare pool, fd_sync does not claim durability before its data file exists", async () => {
    const { h, fd } = await failedUnlinkOfPendingOpenFile();
    // The name still maps to the overdrafted id; nothing durable holds
    // the content yet.
    assert.strictEqual(sysSync(h, fd), 51, "fd_sync must report NOSPC");
  });

  it("after a failed unlink of an open file past the spare pool, settle() then fd_sync makes its content durable", async () => {
    const { store, backend, h, fd } = await failedUnlinkOfPendingOpenFile();
    await backend.settle();
    assert.strictEqual(sysSync(h, fd), 0, "settle() resolved, fd_sync works");
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 1 });
    const r = sysOpen(w2.h, "victim");
    assert.strictEqual(r.errno, 0, "victim lost");
    assert.strictEqual(
      sysReadText(w2.h, r.fd).text,
      "IMPORTANT",
      "fd_sync reported success but the content was lost",
    );
  });

  it("after a failed unlink of an open file past the spare pool, a clean close keeps its content", async () => {
    const { store, backend, h, fd } = await failedUnlinkOfPendingOpenFile();
    assert.strictEqual(sysClose(h, fd), 0);
    await backend.close(); // resolves: nothing reported lost
    const w2 = await openBackend(store, { spareFiles: 1 });
    const r = sysOpen(w2.h, "victim");
    assert.strictEqual(r.errno, 0, "victim lost");
    assert.strictEqual(
      sysReadText(w2.h, r.fd).text,
      "IMPORTANT",
      "close() resolved but the content was lost",
    );
  });

  it("failed namespace syscalls keep the directory listing order", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 4 });
    for (const n of ["a", "b", "c"]) {
      const f = sysCreate(h, n);
      sysClose(h, f.fd);
    }
    const before = listNames(backend);
    const unlinkFault = store.injectFault({ op: "flush", match: /meta\.log$/ });
    assert.notStrictEqual(sysUnlink(h, "a"), 0);
    assert.strictEqual(unlinkFault.fired, 1);
    assert.deepStrictEqual(listNames(backend), before, "unlink rollback");
    // The failed unlink left "a" unrecorded, so its rename takes a full
    // snapshot rather than a log append.
    const renameFault = store.injectFault({ op: "flush", match: /meta\./ });
    assert.notStrictEqual(sysRename(h, "a", "z"), 0);
    assert.strictEqual(renameFault.fired, 1);
    assert.deepStrictEqual(listNames(backend), before, "rename rollback");
    await backend.close();
    const w2 = await openBackend(store, { spareFiles: 4 });
    assert.deepStrictEqual(listNames(w2.backend), before);
  });

  it("removeEntry failures at close are best effort and lose nothing", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 1 });
    const names = ["f0", "f1", "f2", "f3", "f4", "f5"];
    for (const name of names) {
      const f = sysCreate(h, name);
      assert.strictEqual(sysWrite(h, f.fd, `content-${name}`).errno, 0);
      await backend.settle(); // overdrafted files materialize first
      assert.strictEqual(sysSync(h, f.fd), 0);
      sysClose(h, f.fd);
    }
    await backend.settle();
    for (const name of names.slice(1))
      assert.strictEqual(sysUnlink(h, name), 0);
    const fault = store.injectFault({ op: "removeEntry", times: 3 });
    await backend.close();
    assert.ok(fault.fired > 0, "close never removed excess spares");
    store.clearFaults();
    const w2 = await openBackend(store, { spareFiles: 1 });
    assert.deepStrictEqual(listNames(w2.backend), ["f0"]);
    const f0 = sysOpen(w2.h, "f0");
    assert.strictEqual(sysReadText(w2.h, f0.fd).text, "content-f0");
    const fresh = sysCreate(w2.h, "fresh");
    assert.strictEqual(sysReadText(w2.h, fresh.fd).text, "", "aliased spare");
  });

  it("removeEntry failure while reopening does not fail recovery", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 1 });
    for (const name of ["g0", "g1", "g2", "g3"]) {
      const f = sysCreate(h, name);
      assert.strictEqual(sysWrite(h, f.fd, `content-${name}`).errno, 0);
      await backend.settle(); // overdrafted files materialize first
      assert.strictEqual(sysSync(h, f.fd), 0);
      sysClose(h, f.fd);
    }
    await backend.settle();
    for (const name of ["g1", "g2", "g3"])
      assert.strictEqual(sysUnlink(h, name), 0);
    store.simulateCrash();
    // The unreferenced data files left behind are reclaimed at open; a
    // failure to remove surplus ones is cleanup, not a reason to refuse.
    const fault = store.injectFault({ op: "removeEntry", times: 5 });
    let w2;
    try {
      w2 = await openBackend(store, { spareFiles: 1 });
    } catch (error) {
      assert.fail(`recovery failed because cleanup failed: ${error.name}`);
    }
    assert.ok(fault.fired > 0, "reopen never removed surplus data files");
    assert.deepStrictEqual(listNames(w2.backend), ["g0"]);
  });

  it("a failed create() releases its handles so a retry succeeds", async () => {
    const store = new MockOPFS();
    const first = await openBackend(store, { spareFiles: 2 });
    sysCreate(first.h, "keep");
    await first.backend.close();
    const fault = store.injectFault({
      op: "getFileHandle",
      match: /data\.\d+$/,
    });
    await assert.rejects(() =>
      OPFSBackend.create(store.root, { spareFiles: 2 }),
    );
    assert.strictEqual(fault.fired, 1);
    store.clearFaults();
    const retry = await OPFSBackend.create(store.root, { spareFiles: 2 });
    assert.ok(listNames(retry).includes("keep"));
  });

  it("unlink of a spare-backed file whose destruction fails keeps the name and content", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 2 });
    const f = sysCreate(h, "u");
    assert.strictEqual(sysWrite(h, f.fd, "keep me").errno, 0);
    assert.strictEqual(sysSync(h, f.fd), 0);
    sysClose(h, f.fd);
    const fault = store.injectFault({ op: "truncate", match: /data\.\d+$/ });
    assert.notStrictEqual(sysUnlink(h, "u"), 0);
    assert.strictEqual(fault.fired, 1);
    assert.ok(listNames(backend).includes("u"));
    store.simulateCrash();
    const w2 = await openBackend(store, { spareFiles: 2 });
    const r = sysOpen(w2.h, "u");
    assert.strictEqual(r.errno, 0);
    assert.strictEqual(sysReadText(w2.h, r.fd).text, "keep me");
  });
});

// ---------------------------------------------------------------------------
// Regression scenarios: a failed syscall's after-effects
// ---------------------------------------------------------------------------

/** Open the store and read `names` (null for a missing one). */
async function readNames(store, names, options) {
  const { h } = await openBackend(store, options);
  return names.map((name) => {
    const r = sysOpen(h, name);
    return r.errno === 0 ? sysReadText(h, r.fd).text : null;
  });
}

async function readName(store, name, options) {
  return (await readNames(store, [name], options))[0];
}

describe("failed syscalls never alias or lose content", () => {
  // A closed, synced file whose unlink fails after its content was
  // destroyed: the record still maps the name to its data file.
  async function failedUnlinkThenFailedAdopt(store) {
    const { backend, h } = await openBackend(store, { spareFiles: 1 });
    const f = sysCreate(h, "a");
    assert.strictEqual(f.errno, 0);
    assert.strictEqual(sysWrite(h, f.fd, "AAAA").errno, 0);
    assert.strictEqual(sysSync(h, f.fd), 0);
    assert.strictEqual(sysClose(h, f.fd), 0);
    const unlinkFault = store.injectFault({ op: "write", match: /meta\./ });
    assert.notStrictEqual(sysUnlink(h, "a"), 0);
    assert.strictEqual(unlinkFault.fired, 1);
    // A guest open of a host-seeded file adopts it into a spare data file,
    // then fails to record it.
    backend.fileSystem.addFile("/s", "SEED");
    const openFault = store.injectFault({ op: "write", match: /meta\.[01]$/ });
    assert.notStrictEqual(sysOpen(h, "s").errno, 0);
    assert.strictEqual(openFault.fired, 1);
    return backend;
  }

  it("a failed unlink never lets the name show another file's bytes after a crash", async () => {
    const store = new MockOPFS();
    await failedUnlinkThenFailedAdopt(store);
    store.simulateCrash();
    store.clearFaults();
    const text = await readName(store, "a", { spareFiles: 1 });
    assert.ok(
      text === "" || text === "AAAA",
      `"a" shows ${JSON.stringify(text)}`,
    );
  });

  it("a failed unlink never lets the name show another file's bytes after a clean close", async () => {
    const store = new MockOPFS();
    const backend = await failedUnlinkThenFailedAdopt(store);
    store.clearFaults();
    const before = dumpTree(backend).nodes.get("a").content;
    await backend.close();
    assert.strictEqual(
      await readName(store, "a", { spareFiles: 1 }),
      before,
      "a clean close changed what the name shows",
    );
  });

  it("a failed create published by a directory fd_sync never shows another file's bytes", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 1 });
    // The log append fails to flush and cannot be truncated back: a stray
    // record naming the new file stays behind the log's end.
    const flush = store.injectFault({ op: "flush", match: /meta\.log$/ });
    const truncate = store.injectFault({ op: "truncate", match: /meta\.log$/ });
    assert.notStrictEqual(sysCreate(h, "b").errno, 0);
    assert.strictEqual(flush.fired + truncate.fired, 2);
    assert.strictEqual(sysSync(h, PREOPEN_FD), 0); // flushes the stray record
    backend.fileSystem.addFile("/s", "SEED");
    const openFault = store.injectFault({ op: "write", match: /meta\.[01]$/ });
    assert.notStrictEqual(sysOpen(h, "s").errno, 0);
    assert.strictEqual(openFault.fired, 1);
    store.simulateCrash();
    store.clearFaults();
    const text = await readName(store, "b", { spareFiles: 1 });
    // The failed create may or may not have taken effect; if it did, b
    // is the empty file it created.
    assert.ok(text === null || text === "", `b shows ${JSON.stringify(text)}`);
  });

  it("a failed create left in a snapshot slot never shows another file's bytes", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 2 });
    // A create under a never-recorded directory takes a full snapshot,
    // which fails to flush and cannot be truncated away.
    backend.fileSystem.addFile("/seeded/x", "X");
    const flush = store.injectFault({ op: "flush", match: /meta\.[01]$/ });
    const truncate = store.injectFault({
      op: "truncate",
      match: /meta\.[01]$/,
      times: 2,
    });
    assert.notStrictEqual(sysCreate(h, "seeded/b").errno, 0);
    assert.strictEqual(flush.fired + truncate.fired, 2);
    store.clearFaults();
    assert.strictEqual(sysSync(h, PREOPEN_FD), 0); // publishes the slot
    backend.fileSystem.addFile("/s", "SEED");
    const openFault = store.injectFault({ op: "write", match: /meta\.[01]$/ });
    assert.notStrictEqual(sysOpen(h, "s").errno, 0);
    assert.strictEqual(openFault.fired, 1);
    store.simulateCrash();
    store.clearFaults();
    const [b, x] = await readNames(store, ["seeded/b", "seeded/x"], {
      spareFiles: 2,
    });
    assert.ok(b === null || b === "", `seeded/b shows ${JSON.stringify(b)}`);
    assert.ok(
      x === null || x === "" || x === "X",
      `seeded/x shows ${JSON.stringify(x)}`,
    );
  });

  it("a guest open of a seeded file while persistAll() acquires handles keeps the guest's fsync'd data", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 2 });
    backend.fileSystem.addFile("/s", "SEED");
    const gate = store.holdAsync({ op: "getFileHandle", match: /data\./ });
    const persisting = backend.persistAll();
    await gate.parked(1);
    const o = sysOpen(h, "s");
    assert.strictEqual(o.errno, 0);
    assert.strictEqual(sysWrite(h, o.fd, "GUEST-DATA").errno, 0);
    assert.strictEqual(sysSync(h, o.fd), 0);
    gate.release();
    await persisting;
    assert.strictEqual(sysSeekStartHelper(h, o.fd), 0);
    assert.strictEqual(
      sysReadText(h, o.fd).text,
      "GUEST-DATA",
      "persistAll() replaced the content under an open fd",
    );
    assert.strictEqual(sysWrite(h, o.fd, "!").errno, 0);
    assert.strictEqual(sysSync(h, o.fd), 0);
    store.simulateCrash();
    assert.strictEqual(
      await readName(store, "s", { spareFiles: 2 }),
      "GUEST-DATA!",
    );
  });

  it("a failed create() leaves no sync access handle behind, even from background work it queued", async () => {
    const store = new MockOPFS();
    const { h } = await openBackend(store, { spareFiles: 1 });
    const a = sysCreate(h, "a");
    assert.strictEqual(sysWrite(h, a.fd, "A").errno, 0);
    assert.strictEqual(sysSync(h, a.fd), 0);
    assert.strictEqual(sysClose(h, a.fd), 0);
    // A failed unlink leaves "a" recorded under a data file that "b" then
    // claims, so the reopen below has a file to adopt into a spare while
    // compacting - and that compaction fails.
    const unlinkFault = store.injectFault({ op: "write", match: /meta\./ });
    assert.notStrictEqual(sysUnlink(h, "a"), 0);
    assert.strictEqual(unlinkFault.fired, 1);
    assert.strictEqual(sysCreate(h, "b").errno, 0);
    store.simulateCrash();
    const openFault = store.injectFault({ op: "write", match: /meta\.[01]$/ });
    await assert.rejects(OPFSBackend.create(store.root, { spareFiles: 1 }));
    assert.strictEqual(openFault.fired, 1);
    store.clearFaults();
    for (let i = 0; i < 4; i++) await tick();
    // Every file in the store must be free to lock again.
    for await (const [name, handle] of store.root.entries()) {
      if (handle.kind !== "file") continue;
      let access;
      try {
        access = await handle.createSyncAccessHandle();
      } catch (error) {
        assert.fail(`${name} is still locked: ${error.name}`);
      }
      access.close();
    }
    await OPFSBackend.create(store.root, { spareFiles: 1 });
  });

  it("a file close() reports lost does not come back holding a torn prefix of its content", async () => {
    const store = new MockOPFS();
    const { backend, h } = await openBackend(store, { spareFiles: 0 });
    const f = sysCreate(h, "f");
    assert.strictEqual(sysWrite(h, f.fd, "payload").errno, 0);
    // Every attempt to give it a data file stops after one byte.
    const fault = store.injectFault({
      op: "write",
      match: /data\.\d+$/,
      short: 1,
      times: Infinity,
    });
    await assert.rejects(backend.close());
    assert.ok(fault.fired > 0);
    store.clearFaults();
    const text = await readName(store, "f", { spareFiles: 0 });
    assert.ok(
      text === "" || text === "payload",
      `f holds ${JSON.stringify(text)}`,
    );
  });
});

function sysSeekStartHelper(h, fd) {
  return h.imports.fd_seek(fd, 0n, 0, 4096 + 16);
}

// ---------------------------------------------------------------------------
// (b) Model-based randomized crash testing
// ---------------------------------------------------------------------------

const SEEDS_PER_CONFIG = Number(process.env.UWASI_SEEDS ?? 1500);
const STEPS = Number(process.env.UWASI_STEPS ?? 150);
const BASE_SEED = Number(process.env.UWASI_BASE_SEED ?? 1);

/**
 * Variants of the random suites, each with its own seeds and a share of
 * the seed count: crashes that keep a random half of the handles'
 * unflushed writes (as real storage may), and a compaction threshold so
 * small that the log is folded into a snapshot every few changes (through
 * a test-only knob; see `OPFSBackend#compactAt`).
 */
const MODES = [
  { name: "", share: 1, options: () => ({}) },
  {
    name: ", unflushed writes may survive crashes",
    share: 0.3,
    options: () => ({ persist: 0.5 }),
  },
  {
    name: ", tiny compaction threshold",
    share: 0.3,
    options: (rng) => ({
      compactAt: { minBytes: rng.pick([0, 40, 200]), ratio: rng.pick([0, 1]) },
    }),
  },
  {
    name: ", both",
    share: 0.2,
    options: (rng) => ({
      persist: 0.5,
      compactAt: { minBytes: rng.pick([0, 40, 200]), ratio: rng.pick([0, 1]) },
    }),
  },
];

/** Seeds for one random-suite configuration (`base` keeps them apart). */
function modeSeeds(count, base, modeIndex, share) {
  const cases = [];
  for (let i = 0; i < Math.ceil(count * share); i++) {
    cases.push(base + modeIndex * 20000 + i);
  }
  return cases;
}

describe("model-based randomized crash testing", () => {
  for (const [modeIndex, mode] of MODES.entries()) {
    for (const spareFiles of SPARE_CHOICES) {
      it(`random op sequences, spareFiles=${spareFiles}${mode.name}`, async () => {
        const cases = modeSeeds(
          SEEDS_PER_CONFIG,
          BASE_SEED + spareFiles * 100000,
          modeIndex,
          mode.share,
        );
        await runAll(cases, async (seed) => {
          const rng = makeRng(seed);
          const options = mode.options(rng);
          const store = storeFor(seed, options.persist);
          const sim = new Sim(store, {
            seed,
            label: `random${mode.name}`,
            spareFiles,
            foreignRate: 0.05,
            ...options,
          });
          await sim.open();
          await runWorkload(sim, rng, STEPS, {
            lifecycle: true,
            background: true,
          });
          await sim.crashAndReopen("final crash");
          await runWorkload(sim, rng, 20, { background: true });
          await sim.closeAndReopen();
        });
      });
    }
  }
});

const FAULT_SEEDS = Number(process.env.UWASI_FAULT_SEEDS ?? 2000);
const ALL_FAULT_OPS = [
  "write",
  "flush",
  "truncate",
  "read",
  "getSize",
  "getFileHandle",
  "createSyncAccessHandle",
  "removeEntry",
];
// Namespace-record faults, which leave a syscall half done, weigh more.
const FAULT_TARGETS = [SLOT, LOG, /meta\./, /meta\./, DATA_FILE, undefined];

function describeFault(spec) {
  return JSON.stringify(spec, (_k, v) =>
    v instanceof RegExp || v === Infinity ? String(v) : v,
  );
}

function randomFault(rng) {
  const op = rng.chance(0.5)
    ? rng.pick(["write", "flush", "truncate"])
    : rng.pick(ALL_FAULT_OPS);
  return {
    op,
    match: rng.pick(FAULT_TARGETS),
    nth: 1 + rng.int(4),
    times: rng.pick([1, 1, 2, Infinity]),
    short: op === "write" && rng.chance(0.3) ? rng.int(6) : undefined,
  };
}

describe("model-based randomized crash testing with faults", () => {
  for (const [modeIndex, mode] of MODES.entries()) {
    for (const spareFiles of SPARE_CHOICES) {
      it(`random op sequences with random faults, spareFiles=${spareFiles}${mode.name}`, async () => {
        const cases = modeSeeds(
          FAULT_SEEDS,
          BASE_SEED + 500000 + spareFiles * 100000,
          modeIndex,
          mode.share,
        );
        await runAll(cases, async (seed) => {
          const rng = makeRng(seed);
          const options = mode.options(rng);
          const store = storeFor(seed, options.persist);
          const sim = new Sim(store, {
            seed,
            label: `random-faulty${mode.name}`,
            spareFiles,
            faulty: true,
            foreignRate: 0.05,
            ...options,
          });
          await sim.open();
          for (let i = 0; i < STEPS; i++) {
            if (rng.chance(0.06)) {
              const spec = randomFault(rng);
              sim.arm(spec);
              sim.log(`ARM ${describeFault(spec)}`);
            } else if (rng.chance(0.02)) {
              sim.clearFaults();
            }
            const before = sim.fired();
            await randomStep(sim, rng, {
              lifecycle: true,
              background: true,
              compactRate: 0.02,
              seedRate: 0.05,
            });
            if (sim.fired() > before && rng.chance(0.2)) {
              // Crash right at the failure, maybe once a directory fd_sync
              // has flushed whatever the failure left behind.
              if (rng.chance(0.5)) sim.opDirSync();
              await sim.crashAndReopen("crash at failure", {
                reopenFault: rng.chance(0.25) ? randomFault(rng) : null,
              });
            }
          }
          await sim.crashAndReopen("final crash", {
            reopenFault: rng.chance(0.25) ? randomFault(rng) : null,
          });
          await runWorkload(sim, rng, 20, { background: true });
          await sim.closeAndReopen();
        });
      });
    }
  }
});

// ---------------------------------------------------------------------------
// (c) Delayed handle acquisition
// ---------------------------------------------------------------------------

describe("delayed handle acquisition", () => {
  const DATA = /data\.\d+$/;

  async function gatedSim(
    spareFiles,
    seed,
    ops = ["getFileHandle", "createSyncAccessHandle"],
  ) {
    const store = storeFor(seed);
    const sim = new Sim(store, {
      seed,
      label: "gated",
      spareFiles,
    });
    await sim.open();
    await sim.opSettle();
    const gate = store.holdAsync({ op: ops, match: DATA });
    return { store, sim, gate };
  }

  const fdFor = (sim, path) =>
    sim.fds.filter((e) => e && e.path === path).pop();

  it("operate on pending files while materialization is held", async () => {
    for (const spareFiles of [0, 1, 2]) {
      const { store, sim, gate } = await gatedSim(spareFiles, 31 + spareFiles);
      for (const name of ["a", "b", "c", "d", "e"]) sim.opCreate(name);
      for (const name of ["a", "b", "c", "d", "e"]) {
        sim.opWrite(fdFor(sim, name), sim.tagged(fdFor(sim, name)));
      }
      // Let background work start: acquisition is now in flight, parked.
      await tick();
      await gate.parked(1);
      assert.ok(gate.pending > 0, "nothing parked");
      // fd_sync on a pending file must not claim durability.
      const pendingSync = sim.opSync(fdFor(sim, "e"));
      // e is the fifth create and the pool holds at most two spares, which
      // the gate keeps from refilling: e is overdrafted in every round.
      assert.strictEqual(pendingSync, 51, "fd_sync on a pending file");
      sim.opRename("b", "b2");
      sim.opUnlink("c");
      sim.opClose(fdFor(sim, "d"));
      sim.opCreate("d"); // reopen
      sim.opWrite(fdFor(sim, "d"), sim.tagged(fdFor(sim, "d")));
      sim.opMkdir("x");
      sim.opRename("e", "x/e");
      sim.opCreate("c"); // same name as the unlinked pending file
      sim.opWrite(fdFor(sim, "c"), sim.tagged(fdFor(sim, "c")));
      sim.opCreate("f");
      sim.opDirSync();
      sim.checkLive("while held");
      gate.release();
      await sim.opSettle();
      // Everything materialized: fsync works and newly created files read
      // empty.
      for (const entry of sim.fds.filter(Boolean)) {
        assert.strictEqual(sim.opSync(entry), 0, `fsync ${entry.path}`);
      }
      const brandNew = sysCreate(sim.h, "fresh");
      assert.strictEqual(brandNew.errno, 0);
      assert.strictEqual(sysReadText(sim.h, brandNew.fd).text, "", "alias");
      sim.fds.push({
        file: (() => {
          const f = new MFile(sim.newTag());
          sim.root.kids.set("fresh", f);
          return f;
        })(),
        node: sim.backend.fileSystem.lookup("/fresh"),
        pos: 0,
        fd: brandNew.fd,
        path: "fresh",
      });
      sim.checkLive("after release");
      await sim.crashAndReopen("crash after release");
      await sim.closeAndReopen();
      void store;
    }
  });

  it("unlink and recreate while the handle for the pending id is in flight", async () => {
    // Park after getFileHandle created the file but before the sync access
    // handle is acquired, so the materializer sees the cancellation late.
    const { store, sim, gate } = await gatedSim(0, 5, [
      "createSyncAccessHandle",
    ]);
    sim.opCreate("p");
    sim.opWrite(fdFor(sim, "p"), sim.tagged(fdFor(sim, "p")));
    await gate.parked(1).catch(() => {});
    await tick();
    sim.opClose(fdFor(sim, "p"));
    sim.opUnlink("p");
    sim.opCreate("q"); // may claim whatever the materializer recycles
    sim.opWrite(fdFor(sim, "q"), sim.tagged(fdFor(sim, "q")));
    sim.opCreate("p");
    sim.checkLive("while in flight");
    gate.release();
    await sim.opSettle();
    for (const entry of sim.fds.filter(Boolean)) sim.opSync(entry);
    sim.opCreate("r");
    assert.strictEqual(sysReadText(sim.h, fdFor(sim, "r").fd).text, "");
    sim.checkLive("settled");
    await sim.crashAndReopen("crash");
    void store;
  });

  it("crash while handle acquisition is parked, then release", async () => {
    const { store, sim, gate } = await gatedSim(0, 6);
    for (const name of ["a", "b", "c"]) sim.opCreate(name);
    sim.opMkdir("x");
    sim.opRename("a", "x/a");
    sim.opUnlink("b");
    await tick();
    await gate.parked(1);
    assert.ok(gate.pending > 0, "nothing parked");
    // The old worker dies with background work parked inside the mock.
    await sim.crashAndReopen("crash while parked", { gate });
    await tick();
    // The dead worker's late calls must not have disturbed the new one.
    sim.checkLive("after late release");
    await sim.opSettle();
    await sim.crashAndReopen("second crash");
    void store;
  });

  it("clean close completes while acquisition is held and then released", async () => {
    const { store, sim, gate } = await gatedSim(0, 7);
    for (const name of ["a", "b", "c", "d"]) sim.opCreate(name);
    for (const e of sim.fds.filter(Boolean)) sim.opWrite(e, sim.tagged(e));
    const closing = sim.closeAndReopen();
    await tick();
    gate.release();
    await closing;
    void store;
  });

  it("held getFileHandle during refill: spares stay empty and usable", async () => {
    const { store, sim, gate } = await gatedSim(2, 8, ["getFileHandle"]);
    sim.opCreate("a");
    sim.opWrite(fdFor(sim, "a"), sim.tagged(fdFor(sim, "a")));
    sim.opCreate("b");
    sim.opCreate("c"); // pool is empty now: overdraft
    sim.opWrite(fdFor(sim, "c"), sim.tagged(fdFor(sim, "c")));
    sim.opUnlink("a");
    sim.opCreate("a");
    sim.opWrite(fdFor(sim, "a"), sim.tagged(fdFor(sim, "a")));
    gate.release();
    await sim.opSettle();
    for (const e of sim.fds.filter(Boolean)) sim.opSync(e);
    await sim.crashAndReopen();
    void store;
  });

  it("randomized with random gating windows", async () => {
    const cases = [];
    for (let i = 0; i < 40; i++) cases.push(9000 + i);
    await runAll(cases, async (seed) => {
      const rng = makeRng(seed);
      const store = storeFor(seed);
      const sim = new Sim(store, {
        seed,
        label: "gated-random",
        spareFiles: rng.pick([0, 1, 2]),
      });
      await sim.open();
      let gate = null;
      for (let i = 0; i < 100; i++) {
        if (!gate && rng.chance(0.1)) {
          gate = store.holdAsync({
            op: rng.pick([
              ["getFileHandle"],
              ["createSyncAccessHandle"],
              ["getFileHandle", "createSyncAccessHandle"],
            ]),
            match: DATA,
          });
          sim.log("GATE on");
        } else if (gate && rng.chance(0.15)) {
          gate.release();
          gate = null;
          sim.log("GATE released");
        }
        await randomStep(sim, rng, { noBlock: gate !== null });
        // A crash with a parked gate leaves late calls to fail harmlessly.
        if (rng.chance(0.02)) {
          await sim.crashAndReopen("crash", { gate });
          gate = null;
        }
      }
      if (gate) gate.release();
      await sim.opSettle();
      await sim.crashAndReopen("final");
    });
  });
});
