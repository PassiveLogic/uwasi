// A faithful in-Node mock of the OPFS surface `OPFSBackend` uses:
// getDirectoryHandle/getFileHandle/removeEntry/entries on directory handles,
// createSyncAccessHandle on file handles, and
// read/write/truncate/getSize/flush/close on sync access handles.
//
// The semantics that matter for the journal-lifecycle tests are modeled
// exactly:
// - A sync access handle takes an exclusive lock; a second
//   createSyncAccessHandle on the same file rejects until close (or a crash
//   releases the lock).
// - Writes and truncates through a handle are only visible to *durable*
//   storage after flush() (or close(), which flushes by default; see
//   below). `simulateCrash()` releases every open handle WITHOUT flushing,
//   dropping unflushed work - exactly what a dying worker does to OPFS.
// - close() may or may not persist. The File System Standard has close()
//   release the handle; only flush() promises persistence. By default the
//   mock's close() flushes. `new MockOPFS({ closeFlushes: false })` makes
//   it only release the lock: whatever the handle left unflushed is
//   neither durable nor lost yet, since storage may still write it back.
//   It settles at the next crash or the next createSyncAccessHandle on
//   that file, whichever comes first: kept (made durable) if `keepReleased`
//   picks the path, else dropped. `keepReleased` is a predicate
//   `(path) => boolean` or a probability (default 0: always dropped),
//   drawn from `random` (default `Math.random`).
// - Storage state and handle objects are separate, mirroring real workers:
//   a handle belongs to the connection (worker) that created it. After
//   `simulateCrash()` every pre-crash handle object is dead - directory and
//   file handles reject, sync access handles throw - while `store.root`
//   hands the "fresh worker" new handles over the same durable state. This
//   is what stops a crashed backend's pending background work from running
//   on: its code may still be scheduled in-process, but every operation it
//   attempts fails, as death would have prevented them entirely.
// - `simulateCrash({ persist })` models storage that wrote some unflushed
//   work back before the worker died, which real OPFS may do at any time:
//   each open handle whose path `persist` picks keeps all of its unflushed
//   writes and truncates; the others lose them. `persist` is a predicate
//   `(path) => boolean` or a probability, drawn from `random` (default
//   `Math.random`; pass a seeded one for reproducible runs). It returns the
//   paths it kept.
// - removeEntry of a locked file rejects, as in Chromium.
//
// Fault and latency injection (all matching is by substring of the full
// path, e.g. ".uwasi.meta.0", or a RegExp, or a predicate `(path, op) =>
// boolean`; omit `match` to match every path):
// - `store.injectFault({ op, match, nth = 1, times = 1, error, short })`
//   arms a fault on the sync-handle ops "write", "flush", "truncate",
//   "read", "getSize" or the async ops "getFileHandle",
//   "createSyncAccessHandle", "removeEntry". Calls matching `op` and
//   `match` are counted from arming; the fault fires on the `nth` match
//   and the `times - 1` matches after it (`times: Infinity` = forever).
//   A firing sync op throws, an async op rejects, with a DOMException named
//   `error` (default "QuotaExceededError") and no effect on state. For
//   "write", `short: n` instead accepts only n bytes (reported through the
//   return value, as in real OPFS) and does not throw. A throwing flush
//   leaves durable state untouched. Returns a fault object with `fired`
//   (count so far), `matched` and `cancel()`.
// - `store.clearFaults()` disarms every fault and releases nothing else.
// - `store.holdAsync(filter)` gates async calls: `filter` is `{ op, match }`
//   (op may be one name or an array; default is all three async ops) or a
//   bare match. Every matching call parks BEFORE doing anything until
//   `gate.release()`; calls made after release pass straight through.
//   `gate.pending` counts parked calls and `await gate.parked(n)` resolves
//   once n are parked. A call resuming after `simulateCrash()` fails like
//   any other call from a dead worker. Faults are evaluated when a call
//   resumes, not when it parks.
// - `injectShortWrite` / `injectTruncateError` remain as one-shot
//   shorthands, independent of the above. They return an object whose
//   `fired` counts the injection once it is consumed, so a test can check
//   that the failure it set up actually happened.
//
// Every state mutation is appended to `store.opLog` as
// `{ path, op, ...detail }` so tests can assert cross-file ordering (e.g.
// "the journal was truncated+flushed before the meta slot recorded the
// unlink").

function domException(message, name) {
  if (typeof DOMException === "function") {
    return new DOMException(message, name);
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

class FileState {
  constructor(path) {
    this.path = path;
    this.durable = new Uint8Array(0);
    this.lock = null;
    /**
     * What a handle closed without flushing left unflushed (only with
     * `closeFlushes: false`), until it is kept or dropped; else null.
     */
    this.released = null;
  }
}

class DirState {
  constructor(path) {
    this.path = path;
    /** @type {Map<string, FileState | DirState>} */
    this.children = new Map();
  }
}

class MockSyncAccessHandle {
  #state;
  #store;
  #working;
  #cursor = 0;
  #closed = false;
  /** Writes or truncates since the last flush. */
  #dirty = false;

  constructor(state, store) {
    this.#state = state;
    this.#store = store;
    store._settleReleased(state);
    this.#working = new Uint8Array(state.durable);
  }

  #ensureOpen() {
    if (this.#closed) {
      throw domException("The access handle is closed", "InvalidStateError");
    }
  }

  #log(op, detail = {}) {
    this.#store.opLog.push({ path: this.#state.path, op, ...detail });
  }

  read(buffer, options = {}) {
    this.#ensureOpen();
    this.#store._fireFault("read", this.#state.path);
    const at = options.at !== undefined ? options.at : this.#cursor;
    if (!Number.isInteger(at) || at < 0) {
      throw new TypeError(`invalid read offset: ${at}`);
    }
    const view =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer ?? buffer);
    if (at >= this.#working.byteLength) {
      this.#cursor = at;
      return 0;
    }
    const count = Math.min(view.byteLength, this.#working.byteLength - at);
    view.set(this.#working.subarray(at, at + count));
    this.#cursor = at + count;
    return count;
  }

  write(buffer, options = {}) {
    this.#ensureOpen();
    const at = options.at !== undefined ? options.at : this.#cursor;
    if (!Number.isInteger(at) || at < 0) {
      throw new TypeError(`invalid write offset: ${at}`);
    }
    let data =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer ?? buffer);
    const writeFault = this.#store._fireFault("write", this.#state.path);
    // Fault injection: a write may be short (fewer bytes accepted than
    // requested), which real OPFS reports only through the return value.
    const shortCount = this.#store._takeShortWrite(
      this.#state.path,
      data.byteLength,
    );
    if (shortCount !== null) {
      data = data.subarray(0, shortCount);
    }
    if (writeFault?.short !== undefined) {
      data = data.subarray(0, Math.min(writeFault.short, data.byteLength));
    }
    const end = at + data.byteLength;
    if (end > this.#working.byteLength) {
      // Per spec, a write past EOF extends the file, zero-filling any gap.
      const grown = new Uint8Array(end);
      grown.set(this.#working);
      this.#working = grown;
    }
    this.#working.set(data, at);
    this.#dirty = true;
    this.#cursor = end;
    this.#log("write", { at, length: data.byteLength });
    return data.byteLength;
  }

  truncate(newSize) {
    this.#ensureOpen();
    if (!Number.isInteger(newSize) || newSize < 0) {
      throw new TypeError(`invalid truncate size: ${newSize}`);
    }
    this.#store._fireFault("truncate", this.#state.path);
    if (this.#store._takeTruncateError(this.#state.path)) {
      throw domException(
        `Simulated quota failure truncating ${this.#state.path}`,
        "QuotaExceededError",
      );
    }
    if (newSize !== this.#working.byteLength) {
      const next = new Uint8Array(newSize);
      next.set(
        this.#working.subarray(0, Math.min(newSize, this.#working.byteLength)),
      );
      this.#working = next;
    }
    this.#dirty = true;
    this.#cursor = Math.min(this.#cursor, newSize);
    this.#log("truncate", { size: newSize });
  }

  getSize() {
    this.#ensureOpen();
    this.#store._fireFault("getSize", this.#state.path);
    return this.#working.byteLength;
  }

  flush() {
    this.#ensureOpen();
    this.#store._fireFault("flush", this.#state.path);
    this.#state.durable = new Uint8Array(this.#working);
    this.#dirty = false;
    this.#log("flush", { size: this.#working.byteLength });
  }

  /** Full path of the file this handle is open on. */
  get _path() {
    return this.#state.path;
  }

  close() {
    if (this.#closed) return;
    this.#ensureOpen();
    if (this.#store.closeFlushes) {
      this.#state.durable = new Uint8Array(this.#working);
      this.#log("flush", { size: this.#working.byteLength });
    } else if (this.#dirty) {
      // Released, not persisted: settled later (see the header).
      this.#state.released = this.#working;
      this.#log("release", { size: this.#working.byteLength });
    }
    this.#closed = true;
    this.#state.lock = null;
    this.#store._openHandles.delete(this);
  }

  /**
   * Worker died: the lock evaporates and unflushed work is lost, unless
   * `persist` says the storage wrote it back first.
   */
  _crash(persist = false) {
    if (persist) this.#state.durable = new Uint8Array(this.#working);
    this.#closed = true;
    this.#state.lock = null;
    this.#store._openHandles.delete(this);
  }
}

class MockFileHandle {
  kind = "file";

  constructor(state, connection, store) {
    this.name = state.path.split("/").pop();
    this._state = state;
    this._connection = connection;
    this._store = store;
  }

  async createSyncAccessHandle() {
    await this._store._gate("createSyncAccessHandle", this._state.path);
    if (!this._connection.alive) {
      throw domException(
        "The worker owning this handle died",
        "InvalidStateError",
      );
    }
    if (this._state.lock) {
      throw domException(
        `Access handle already open on ${this._state.path}`,
        "NoModificationAllowedError",
      );
    }
    this._store._fireFault("createSyncAccessHandle", this._state.path);
    const handle = new MockSyncAccessHandle(this._state, this._store);
    this._state.lock = handle;
    this._store._openHandles.add(handle);
    return handle;
  }
}

class MockDirectoryHandle {
  kind = "directory";

  constructor(state, connection, store) {
    this.name = state.path.split("/").pop();
    this._state = state;
    this._connection = connection;
    this._store = store;
  }

  #ensureAlive() {
    if (!this._connection.alive) {
      throw domException(
        "The worker owning this handle died",
        "InvalidStateError",
      );
    }
  }

  #wrap(state) {
    return state instanceof DirState
      ? new MockDirectoryHandle(state, this._connection, this._store)
      : new MockFileHandle(state, this._connection, this._store);
  }

  async getFileHandle(name, options = {}) {
    const fullPath = `${this._state.path}/${name}`;
    await this._store._gate("getFileHandle", fullPath);
    this.#ensureAlive();
    this._store._fireFault("getFileHandle", fullPath);
    const existing = this._state.children.get(name);
    if (existing) {
      if (existing instanceof DirState) {
        throw domException(`${name} is a directory`, "TypeMismatchError");
      }
      return this.#wrap(existing);
    }
    if (!options.create) {
      throw domException(`No file named ${name}`, "NotFoundError");
    }
    const state = new FileState(`${this._state.path}/${name}`);
    this._state.children.set(name, state);
    return this.#wrap(state);
  }

  async getDirectoryHandle(name, options = {}) {
    this.#ensureAlive();
    const existing = this._state.children.get(name);
    if (existing) {
      if (!(existing instanceof DirState)) {
        throw domException(`${name} is a file`, "TypeMismatchError");
      }
      return this.#wrap(existing);
    }
    if (!options.create) {
      throw domException(`No directory named ${name}`, "NotFoundError");
    }
    const state = new DirState(`${this._state.path}/${name}`);
    this._state.children.set(name, state);
    return this.#wrap(state);
  }

  async removeEntry(name, options = {}) {
    const fullPath = `${this._state.path}/${name}`;
    await this._store._gate("removeEntry", fullPath);
    this.#ensureAlive();
    this._store._fireFault("removeEntry", fullPath);
    const child = this._state.children.get(name);
    if (!child) {
      throw domException(`No entry named ${name}`, "NotFoundError");
    }
    if (child instanceof FileState && child.lock) {
      throw domException(
        `${name} has an open access handle`,
        "NoModificationAllowedError",
      );
    }
    if (
      child instanceof DirState &&
      child.children.size > 0 &&
      !options.recursive
    ) {
      throw domException(`${name} is not empty`, "InvalidModificationError");
    }
    this._state.children.delete(name);
    this._store.opLog.push({ path: child.path, op: "removeEntry" });
  }

  async *entries() {
    this.#ensureAlive();
    for (const [name, state] of this._state.children) {
      yield [name, this.#wrap(state)];
    }
  }
}

const SYNC_OPS = ["write", "flush", "truncate", "read", "getSize"];
const ASYNC_OPS = ["getFileHandle", "createSyncAccessHandle", "removeEntry"];
const FAULT_OPS = [...SYNC_OPS, ...ASYNC_OPS];

function matches(match, path, op) {
  if (match === undefined) return true;
  if (typeof match === "string") return path.includes(match);
  if (match instanceof RegExp) return match.test(path);
  return Boolean(match(path, op));
}

export class MockOPFS {
  /**
   * `closeFlushes` (default true) and `keepReleased` (default 0) choose
   * what a sync access handle's close() does with unflushed work; see the
   * header. `random` draws `keepReleased` when it is a probability.
   */
  constructor({
    closeFlushes = true,
    keepReleased = 0,
    random = Math.random,
  } = {}) {
    this.closeFlushes = closeFlushes;
    this._keepReleased =
      typeof keepReleased === "number"
        ? () => random() < keepReleased
        : keepReleased;
    this._openHandles = new Set();
    this._rootState = new DirState("");
    this._connection = { alive: true };
    /** @type {{path: string, op: string}[]} */
    this.opLog = [];
    this._shortWrite = null;
    this._truncateError = null;
    this._faults = [];
    this._gates = [];
  }

  injectFault({
    op,
    match,
    nth = 1,
    times = 1,
    error = "QuotaExceededError",
    short,
  }) {
    if (!FAULT_OPS.includes(op)) {
      throw new TypeError(`unknown fault op: ${op}`);
    }
    const fault = {
      op,
      match,
      nth,
      times,
      error,
      short,
      matched: 0,
      fired: 0,
      cancel: () => {
        this._faults = this._faults.filter((f) => f !== fault);
      },
    };
    this._faults.push(fault);
    return fault;
  }

  clearFaults() {
    this._faults = [];
  }

  /** Throws (or returns a short-write directive) if an armed fault fires. */
  _fireFault(op, path) {
    let short = null;
    for (const fault of [...this._faults]) {
      if (fault.op !== op || !matches(fault.match, path, op)) continue;
      fault.matched++;
      if (
        fault.matched < fault.nth ||
        fault.matched >= fault.nth + fault.times
      ) {
        continue;
      }
      fault.fired++;
      if (fault.matched === fault.nth + fault.times - 1) fault.cancel();
      if (fault.short !== undefined) {
        short = { short: fault.short };
        continue;
      }
      throw domException(
        `Simulated ${fault.error} during ${op} of ${path}`,
        fault.error,
      );
    }
    return short;
  }

  holdAsync(filter = {}) {
    const spec =
      typeof filter === "string" ||
      filter instanceof RegExp ||
      typeof filter === "function"
        ? { match: filter }
        : filter;
    const ops = spec.op === undefined ? ASYNC_OPS : [spec.op].flat();
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    const gate = {
      ops,
      match: spec.match,
      released,
      pending: 0,
      isReleased: false,
      _waiters: [],
      release: () => {
        gate.isReleased = true;
        this._gates = this._gates.filter((g) => g !== gate);
        release();
      },
      parked: (n = 1) =>
        gate.pending >= n
          ? Promise.resolve()
          : new Promise((resolve) => gate._waiters.push({ n, resolve })),
    };
    this._gates.push(gate);
    return gate;
  }

  async _gate(op, path) {
    for (const gate of [...this._gates]) {
      if (!gate.ops.includes(op) || !matches(gate.match, path, op)) continue;
      gate.pending++;
      for (const w of gate._waiters.filter((w) => gate.pending >= w.n)) {
        w.resolve();
      }
      await gate.released;
      gate.pending--;
    }
  }

  /**
   * Make the next write to a file whose path contains `substring` short:
   * only `bytes` bytes are accepted (reported via the return value, as in
   * real OPFS). Consumed by the first matching write.
   */
  injectShortWrite(substring, bytes) {
    this._shortWrite = { substring, bytes, fired: 0 };
    return this._shortWrite;
  }

  _takeShortWrite(path, requested) {
    if (this._shortWrite && path.includes(this._shortWrite.substring)) {
      const count = Math.min(this._shortWrite.bytes, requested);
      this._shortWrite.fired++;
      this._shortWrite = null;
      return count;
    }
    return null;
  }

  /**
   * Make the next truncate on a file whose path contains `substring` throw
   * QuotaExceededError, without touching the content. Consumed by the
   * first matching truncate.
   */
  injectTruncateError(substring) {
    this._truncateError = { substring, fired: 0 };
    return this._truncateError;
  }

  _takeTruncateError(path) {
    if (this._truncateError && path.includes(this._truncateError.substring)) {
      this._truncateError.fired++;
      this._truncateError = null;
      return true;
    }
    return false;
  }

  /**
   * Settle what a handle closed without flushing left on `state`: storage
   * either wrote it back or dropped it. Returns whether it was kept.
   */
  _settleReleased(state) {
    if (state.released === null) return false;
    const keep = Boolean(this._keepReleased(state.path));
    if (keep) state.durable = new Uint8Array(state.released);
    state.released = null;
    this.opLog.push({ path: state.path, op: keep ? "kept" : "dropped" });
    return keep;
  }

  /**
   * The current worker's view of the store root. After `simulateCrash()`
   * this returns handles for the fresh worker; handles obtained before the
   * crash stay dead.
   */
  get root() {
    return new MockDirectoryHandle(this._rootState, this._connection, this);
  }

  /**
   * The worker died: every open access handle is released without flushing
   * (unflushed writes are lost, except on the handles `persist` picks; see
   * the header), and every handle object the dead worker held stops
   * working. What handles closed without flushing left behind is kept or
   * dropped (see `keepReleased`). Durable state survives for the next
   * worker. Returns the paths whose unflushed work was kept.
   */
  simulateCrash({ persist, random = Math.random } = {}) {
    const pick =
      typeof persist === "number"
        ? () => random() < persist
        : (persist ?? (() => false));
    const kept = [];
    for (const handle of [...this._openHandles]) {
      const path = handle._path;
      const keep = Boolean(pick(path));
      if (keep) kept.push(path);
      handle._crash(keep);
    }
    const settle = (dir) => {
      for (const child of dir.children.values()) {
        if (child instanceof DirState) settle(child);
        else if (this._settleReleased(child)) kept.push(child.path);
      }
    };
    settle(this._rootState);
    this._connection.alive = false;
    this._connection = { alive: true };
    return kept;
  }

  /** Durable bytes of a root-level file at the store level, or null. */
  durableContent(name) {
    const child = this._rootState.children.get(name);
    if (!child || child instanceof DirState) return null;
    return new Uint8Array(child.durable);
  }

  /** Names of the root's children, in insertion order. */
  rootNames() {
    return [...this._rootState.children.keys()];
  }
}
