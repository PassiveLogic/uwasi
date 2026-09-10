import {
  DirectoryNode,
  FileNode,
  FSBackend,
  FSNode,
  MemoryFileSystem,
  SymlinkNode,
  FSErrno,
  FSError,
} from "../filesystem/index.js";

/**
 * The slice of the OPFS API surface the backend uses, typed structurally so
 * uwasi does not depend on newer DOM lib definitions. A real
 * `FileSystemDirectoryHandle` from `navigator.storage.getDirectory()`
 * satisfies `OPFSDirectoryHandle` in a worker.
 */
export interface OPFSSyncAccessHandle {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface OPFSFileHandle {
  readonly kind: "file";
  readonly name: string;
  createSyncAccessHandle(): Promise<OPFSSyncAccessHandle>;
}

export interface OPFSDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OPFSFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OPFSDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<
    [string, OPFSFileHandle | OPFSDirectoryHandle]
  >;
}

// ---------------------------------------------------------------------------
// Durable metadata format
// ---------------------------------------------------------------------------

/** Serialized namespace: a tree of names over physical file ids. */
type MetaDir = { d: { [name: string]: MetaEntry } };
type MetaEntry = MetaDir | { f: number } | { l: string };
type MetaPayload = { gen: number; next: number; root: MetaDir };

const META_NAMES = [".uwasi.meta.0", ".uwasi.meta.1"];
const DATA_PREFIX = ".uwasi.data.";
const META_MAGIC = new Uint8Array([0x55, 0x57, 0x4d, 0x31]); // "UWM1"
const META_HEADER = 12; // magic + u32 body length + u32 FNV-1a of the body

function dataName(id: number): string {
  return DATA_PREFIX + id;
}

function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function encodeMeta(payload: MetaPayload): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const buffer = new Uint8Array(META_HEADER + body.byteLength);
  const view = new DataView(buffer.buffer);
  buffer.set(META_MAGIC, 0);
  view.setUint32(4, body.byteLength, true);
  view.setUint32(8, fnv1a(body), true);
  buffer.set(body, META_HEADER);
  return buffer;
}

/** Parse a meta slot; `null` for an empty, torn or foreign slot. */
function decodeMeta(handle: OPFSSyncAccessHandle): MetaPayload | null {
  const size = handle.getSize();
  if (size < META_HEADER) return null;
  const buffer = new Uint8Array(size);
  handle.read(buffer, { at: 0 });
  for (let i = 0; i < META_MAGIC.length; i++) {
    if (buffer[i] !== META_MAGIC[i]) return null;
  }
  const view = new DataView(buffer.buffer);
  const length = view.getUint32(4, true);
  if (META_HEADER + length > size) return null;
  const body = buffer.subarray(META_HEADER, META_HEADER + length);
  if (fnv1a(body) !== view.getUint32(8, true)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(body));
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.gen !== "number" ||
      typeof payload.next !== "number" ||
      typeof payload.root !== "object"
    ) {
      return null;
    }
    return payload as MetaPayload;
  } catch {
    return null;
  }
}

const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;

/**
 * Write all of `data` at `at`. OPFS reports partial writes (e.g. under
 * quota pressure) only through the return value; a short write must never
 * pass as success, so it becomes a `RangeError` - which `errnoOf` maps to
 * `NOSPC`, the same way a full device surfaces.
 */
function writeFully(
  handle: OPFSSyncAccessHandle,
  data: Uint8Array,
  at: number,
): void {
  const written = handle.write(data, { at });
  if (written !== data.byteLength) {
    throw new RangeError(
      `uwasi: short write: ${written} of ${data.byteLength} bytes`,
    );
  }
}

/**
 * An OPFS-backed `FSBackend` for workers.
 *
 * OPFS namespace calls (`getFileHandle`, `removeEntry`, `move`) are async
 * while the WASI syscall path is synchronous, so guest names cannot be
 * mapped 1:1 onto OPFS names at syscall time. The backend owns the whole
 * directory it is given instead:
 *
 * - `.uwasi.data.<id>`: one content file per guest file, each held open
 *   through a sync access handle for the backend's whole life. Releasing a
 *   handle is unsafe, because re-acquiring one is async.
 * - `.uwasi.meta.0/1`: the namespace record mapping guest names to data
 *   file ids, flushed on every namespace change, alternating between the
 *   two slots with a generation number and a checksum, so a torn write
 *   loses at most the in-flight change.
 * - a bounded pool of spare data files with open handles, so creating a
 *   guest file is a synchronous claim.
 *
 * Other entries in the directory are ignored and left untouched.
 *
 * Creating more files than the pool holds still succeeds: the record maps
 * the name immediately and the physical file follows on the next event
 * loop turn. Until it does, `fd_sync` reports `NOSPC` rather than claiming
 * durability it cannot provide, and `settle()` clears the backlog.
 *
 * Unlink destroys the content before it records the name removal, so a
 * crash leaves at worst an empty file, never live content under a name the
 * record no longer maps. While fds are still open, destruction defers to
 * the last `closeFile` (dangling-fd semantics) and only the record is
 * written. Rename over an existing target records the new mapping first,
 * which keeps the replacement atomic, then reclaims the replaced content.
 * Re-init rebuilds the namespace from the record alone, so unreferenced
 * data files are reclaimed rather than resurrected.
 *
 * Limits: hard links are refused with `NOTSUP`, inode numbers and
 * timestamps are not persisted, and the store needs exactly one live
 * backend, since sync access handles are exclusive locks.
 */
export class OPFSBackend implements FSBackend {
  /**
   * The node tree the syscall layer resolves paths against. Grafted from
   * the namespace record at `create()`; from then on the backend keeps it
   * exact while persisting every namespace change.
   */
  public fileSystem!: MemoryFileSystem;

  private metaHandles: OPFSSyncAccessHandle[] = [];
  private generation = 0;
  private nextId = 0;
  /** Guest file node -> data-file id, for every persisted file. */
  private physByNode = new Map<FileNode, number>();
  /** Data-file id -> its always-open sync access handle. */
  private handleById = new Map<number, OPFSSyncAccessHandle>();
  /** Ids of pre-created, empty, claimable data files. */
  private spares: number[] = [];
  /**
   * Files created past the spare pool: their id is already durable in the
   * namespace record, their content still lives in `node.content` until
   * the background materializer creates the physical file.
   */
  private pendingIds = new Map<FileNode, number>();
  /** Nodes already part of the persisted namespace (hard-link detection). */
  private known = new WeakSet<FileNode>();
  private openCounts = new Map<FileNode, number>();
  /** Unlinked-but-open files awaiting content destruction at last close. */
  private pendingTombstones = new Set<FileNode>();
  private background: Promise<void> = Promise.resolve();
  private replenishScheduled = false;
  private closed = false;

  private constructor(
    private readonly store: OPFSDirectoryHandle,
    private readonly spareTarget: number,
  ) {}

  /**
   * Open (or initialize) a store inside `store` - typically
   * `await navigator.storage.getDirectory()` or a subdirectory of it - and
   * finish every piece of async setup, so that all `FSBackend` methods are
   * synchronous afterwards.
   */
  static async create(
    store: OPFSDirectoryHandle,
    options: {
      /** Guest preopen directories, as for `MemoryFileSystem`. */
      preopens?: { [guestPath: string]: string };
      /**
       * Spare data files to keep pre-created: the maximum number of
       * net-new guest files creatable within one synchronous burst.
       */
      spareFiles?: number;
    } = {},
  ): Promise<OPFSBackend> {
    const backend = new OPFSBackend(store, options.spareFiles ?? 16);
    await backend.init(options.preopens);
    return backend;
  }

  private async init(preopens?: {
    [guestPath: string]: string;
  }): Promise<void> {
    // Scan the (flat) physical store. Foreign entries are left untouched.
    const dataFiles = new Map<number, OPFSFileHandle>();
    let maxSeenId = -1;
    for await (const [name, handle] of this.store.entries()) {
      if (handle.kind !== "file" || !name.startsWith(DATA_PREFIX)) continue;
      const id = Number(name.slice(DATA_PREFIX.length));
      if (!Number.isInteger(id) || id < 0) continue;
      dataFiles.set(id, handle);
      maxSeenId = Math.max(maxSeenId, id);
    }

    // Read both namespace-record slots; the highest intact generation wins.
    let meta: MetaPayload | null = null;
    for (const name of META_NAMES) {
      const fileHandle = await this.store.getFileHandle(name, { create: true });
      const handle = await fileHandle.createSyncAccessHandle();
      this.metaHandles.push(handle);
      const slot = decodeMeta(handle);
      if (slot && (!meta || slot.gen > meta.gen)) meta = slot;
    }
    this.generation = meta ? meta.gen : 0;
    // Ids may have been handed out after the record was last written
    // (background pool refills are not snapshotted); never reuse one.
    this.nextId = Math.max(meta ? meta.next : 0, maxSeenId + 1);

    // Rebuild the guest namespace from the record alone. Data files the
    // record does not reference belong to unlinked files, so they stay
    // invisible to the guest whatever bytes they still hold.
    this.fileSystem = new MemoryFileSystem(preopens);
    if (meta) this.graft(meta.root, "");

    // Claim every referenced data file's handle for life.
    for (const [, id] of this.physByNode) {
      let fileHandle = dataFiles.get(id);
      if (!fileHandle) {
        // Referenced but physically missing (a foreign actor removed it):
        // surface it as an empty file rather than failing the whole store.
        fileHandle = await this.store.getFileHandle(dataName(id), {
          create: true,
        });
      }
      dataFiles.delete(id);
      this.handleById.set(id, await fileHandle.createSyncAccessHandle());
    }

    // Reclaim tombstones: destroy any leftover content, reuse as spares.
    for (const [id, fileHandle] of dataFiles) {
      const handle = await fileHandle.createSyncAccessHandle();
      handle.truncate(0);
      handle.flush();
      this.handleById.set(id, handle);
      this.spares.push(id);
    }

    // Size the spare pool: pre-create what is missing, remove any excess.
    while (this.spares.length < this.spareTarget) {
      const id = this.nextId++;
      const fileHandle = await this.store.getFileHandle(dataName(id), {
        create: true,
      });
      this.handleById.set(id, await fileHandle.createSyncAccessHandle());
      this.spares.push(id);
    }
    while (this.spares.length > this.spareTarget) {
      const id = this.spares.pop()!;
      this.handleById.get(id)!.close();
      this.handleById.delete(id);
      await this.store.removeEntry(dataName(id));
    }

    // Persist the initial state (also records the advanced id counter).
    this.snapshotFlush();
  }

  /**
   * Rebuild the node tree from the namespace record. Children are created
   * in record order - which `serializeDir` wrote in `entries` insertion
   * order - so `listChildren` (and with it readdir cookie indexing) is
   * stable across re-init.
   */
  private graft(
    dir: MetaDir,
    base: string,
    nodeById: Map<number, FileNode> = new Map(),
  ): void {
    for (const name of Object.keys(dir.d)) {
      const child = dir.d[name];
      const childPath = `${base}/${name}`;
      if ("d" in child) {
        this.fileSystem.ensureDir(childPath);
        this.graft(child, childPath, nodeById);
      } else if ("f" in child) {
        let node = nodeById.get(child.f);
        if (!node) {
          node = this.fileSystem.createFile(childPath, new Uint8Array(0));
          nodeById.set(child.f, node);
          this.physByNode.set(node, child.f);
        } else {
          // Two names for one id should not happen without hard links;
          // keep them coherent by sharing the node if it ever does.
          this.fileSystem.setNode(childPath, node);
        }
        this.known.add(node);
      } else {
        // `setNode` stamps inode metadata onto the bare node.
        this.fileSystem.setNode(childPath, {
          type: "symlink",
          target: child.l,
        } as SymlinkNode);
      }
    }
  }

  // -------------------------------------------------------------------
  // Namespace persistence
  // -------------------------------------------------------------------

  /**
   * Serialize the live node tree into the older record slot and flush it.
   * This is the single durability point for every namespace change. It
   * also adopts any reachable file the backend has not persisted yet
   * (files seeded through the `MemoryFileSystem` tree-builder), claiming
   * spares - or overdraft ids - for them.
   */
  private snapshotFlush(): void {
    const root = this.fileSystem.lookup("/") as DirectoryNode;
    const record = this.serializeDir(root);
    const generation = this.generation + 1;
    const buffer = encodeMeta({
      gen: generation,
      next: this.nextId,
      root: record,
    });
    const handle = this.metaHandles[generation % 2];
    writeFully(handle, buffer, 0);
    handle.truncate(buffer.byteLength);
    handle.flush();
    this.generation = generation;
  }

  private serializeDir(dir: DirectoryNode): MetaDir {
    const d: { [name: string]: MetaEntry } = {};
    for (const name of Object.keys(dir.entries)) {
      const child = dir.entries[name];
      switch (child.type) {
        case "dir":
          d[name] = this.serializeDir(child);
          break;
        case "file": {
          this.adopt(child);
          this.known.add(child);
          const id = this.physByNode.get(child) ?? this.pendingIds.get(child)!;
          d[name] = { f: id };
          break;
        }
        case "symlink":
          d[name] = { l: child.target };
          break;
        case "character":
          // Recreated by the MemoryFileSystem constructor on re-init.
          break;
      }
    }
    return { d };
  }

  /**
   * Give `node` a physical data file, synchronously, by claiming a spare.
   * Any in-memory content (tree-builder seeded files) moves into it. With
   * the pool dry the node overdrafts: it gets an id now and a physical
   * file later, and until then its content stays in memory (and `sync`
   * refuses to pretend otherwise).
   */
  private adopt(node: FileNode): void {
    if (this.physByNode.has(node) || this.pendingIds.has(node)) return;
    const id = this.spares.shift();
    if (id === undefined) {
      this.pendingIds.set(node, this.nextId++);
      this.scheduleBackground();
      return;
    }
    const handle = this.handleById.get(id)!;
    try {
      handle.truncate(0);
      if (node.content.byteLength > 0) {
        writeFully(handle, node.content, 0);
      }
      handle.flush();
    } catch (error) {
      this.spares.unshift(id);
      throw error;
    }
    this.physByNode.set(node, id);
    node.content = new Uint8Array(0);
    this.scheduleBackground();
  }

  /**
   * Destroy a file's durable content and recycle its data file. Deferred
   * to the last `closeFile` while fds are open (dangling-fd semantics).
   * Returns an errno; on failure nothing is recycled.
   */
  private tombstone(node: FileNode): number {
    if (this.pendingIds.delete(node)) {
      // Never materialized: nothing durable exists to destroy, and the
      // materializer will notice the cancellation and recycle the file it
      // may already have created. Open fds keep working on the in-memory
      // content.
      return FSErrno.SUCCESS;
    }
    if (!this.physByNode.has(node)) return FSErrno.SUCCESS;
    if ((this.openCounts.get(node) ?? 0) > 0) {
      this.pendingTombstones.add(node);
      return FSErrno.SUCCESS;
    }
    return this.destroyContent(node);
  }

  private destroyContent(node: FileNode): number {
    const id = this.physByNode.get(node)!;
    const handle = this.handleById.get(id)!;
    // Content destruction must be durable before the namespace change
    // that removes the name is recorded; see the class comment.
    try {
      handle.truncate(0);
      handle.flush();
    } catch (error) {
      // The data file may still hold live bytes: keep it mapped to the
      // node rather than recycling a spare with content in it, and let
      // the caller decide what the failure means.
      return this.errnoOf(error);
    }
    this.physByNode.delete(node);
    this.known.delete(node);
    this.spares.push(id);
    return FSErrno.SUCCESS;
  }

  private scheduleBackground(): void {
    if (this.replenishScheduled || this.closed) return;
    this.replenishScheduled = true;
    this.background = this.background
      .then(async () => {
        this.replenishScheduled = false;
        // Materialize overdrafted files first: each waits on a durability
        // guarantee (`sync` fails until its physical file exists).
        while (this.pendingIds.size > 0) {
          const [node, id] = this.pendingIds.entries().next().value as [
            FileNode,
            number,
          ];
          const fileHandle = await this.store.getFileHandle(dataName(id), {
            create: true,
          });
          const handle = await fileHandle.createSyncAccessHandle();
          if (this.pendingIds.get(node) !== id || this.closed) {
            // Unlinked (or shut down) while we were acquiring the handle:
            // recycle the physical file as a spare.
            handle.truncate(0);
            handle.flush();
            this.handleById.set(id, handle);
            this.spares.push(id);
            if (this.pendingIds.get(node) === id) this.pendingIds.delete(node);
            continue;
          }
          if (node.content.byteLength > 0) {
            writeFully(handle, node.content, 0);
          }
          handle.flush();
          this.handleById.set(id, handle);
          this.pendingIds.delete(node);
          this.physByNode.set(node, id);
          node.content = new Uint8Array(0);
        }
        // Then refill the spare pool.
        while (this.spares.length < this.spareTarget && !this.closed) {
          const id = this.nextId++;
          const fileHandle = await this.store.getFileHandle(dataName(id), {
            create: true,
          });
          const handle = await fileHandle.createSyncAccessHandle();
          this.handleById.set(id, handle);
          this.spares.push(id);
        }
      })
      .catch(() => {
        // Best effort: the pool just stays smaller until the next attempt.
      });
  }

  private errnoOf(error: unknown): number {
    if (error instanceof RangeError) return FSErrno.NOSPC;
    if ((error as { name?: string } | null)?.name === "QuotaExceededError") {
      return FSErrno.NOSPC;
    }
    return FSErrno.IO;
  }

  // -------------------------------------------------------------------
  // Public lifecycle helpers
  // -------------------------------------------------------------------

  /** Wait for background work (spare-pool refills) to finish. */
  async settle(): Promise<void> {
    await this.background;
  }

  /**
   * Persist every file reachable in the tree, including ones seeded
   * through the `MemoryFileSystem` tree-builder after `create()`. Being
   * async it does not draw on the spare pool; call it after seeding to
   * keep the pool free for the guest.
   */
  async persistAll(): Promise<void> {
    const root = this.fileSystem.lookup("/") as DirectoryNode;
    await this.adoptSubtree(root);
    this.snapshotFlush();
    await this.settle();
  }

  private async adoptSubtree(dir: DirectoryNode): Promise<void> {
    for (const name of Object.keys(dir.entries)) {
      const child = dir.entries[name];
      if (child.type === "dir") {
        await this.adoptSubtree(child);
      } else if (
        child.type === "file" &&
        !this.physByNode.has(child) &&
        // Overdrafted files already have an id; settle() materializes them.
        !this.pendingIds.has(child)
      ) {
        const id = this.nextId++;
        const fileHandle = await this.store.getFileHandle(dataName(id), {
          create: true,
        });
        const handle = await fileHandle.createSyncAccessHandle();
        if (child.content.byteLength > 0) {
          writeFully(handle, child.content, 0);
        }
        handle.flush();
        this.handleById.set(id, handle);
        this.physByNode.set(child, id);
        this.known.add(child);
        child.content = new Uint8Array(0);
      }
    }
  }

  /** Flush and release every handle; the backend is unusable afterwards. */
  async close(): Promise<void> {
    if (this.closed) return;
    // Let pending materializations and refills finish first, so files
    // created past the spare pool become durable on a clean shutdown.
    await this.background.catch(() => {});
    this.closed = true;
    await this.background.catch(() => {});
    for (const handle of this.handleById.values()) {
      try {
        handle.close();
      } catch {
        // Already closed or revoked; nothing left to release.
      }
    }
    for (const handle of this.metaHandles) {
      try {
        handle.close();
      } catch {
        // Already closed or revoked; nothing left to release.
      }
    }
  }

  // -------------------------------------------------------------------
  // FSBackend: file content
  // -------------------------------------------------------------------

  fileSize(node: FileNode): number {
    const id = this.physByNode.get(node);
    if (id === undefined) return node.content.byteLength;
    try {
      return this.handleById.get(id)!.getSize();
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new FSError(this.errnoOf(error), error);
    }
  }

  readAt(node: FileNode, buf: Uint8Array, offset: number): number {
    const id = this.physByNode.get(node);
    if (id === undefined) {
      const data = node.content;
      if (offset >= data.byteLength) return 0;
      const count = Math.min(buf.byteLength, data.byteLength - offset);
      buf.set(data.subarray(offset, offset + count));
      return count;
    }
    if (buf.byteLength === 0) return 0;
    try {
      return this.handleById.get(id)!.read(buf, { at: offset });
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new FSError(this.errnoOf(error), error);
    }
  }

  writeAt(node: FileNode, data: Uint8Array, offset: number): number {
    const id = this.physByNode.get(node);
    if (id === undefined) {
      // Not yet persisted (tree-builder seeded): plain in-memory write;
      // the content moves to OPFS wholesale when the node is adopted.
      const end = offset + data.byteLength;
      if (end > node.content.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(node.content);
        node.content = grown;
      }
      node.content.set(data, offset);
      return FSErrno.SUCCESS;
    }
    const handle = this.handleById.get(id)!;
    try {
      const size = handle.getSize();
      if (offset > size) {
        // Zero-fill the gap explicitly rather than relying on the
        // implementation's write-past-EOF behavior.
        handle.truncate(offset);
      }
      writeFully(handle, data, offset);
    } catch (error) {
      return this.errnoOf(error);
    }
    return FSErrno.SUCCESS;
  }

  resize(node: FileNode, size: number): number {
    if (!Number.isInteger(size) || size < 0) return FSErrno.INVAL;
    if (size > MAX_FILE_SIZE) return FSErrno.FBIG;
    const id = this.physByNode.get(node);
    if (id === undefined) {
      if (size !== node.content.byteLength) {
        const next = new Uint8Array(size);
        next.set(
          node.content.subarray(0, Math.min(size, node.content.byteLength)),
        );
        node.content = next;
      }
      return FSErrno.SUCCESS;
    }
    try {
      this.handleById.get(id)!.truncate(size);
    } catch (error) {
      return this.errnoOf(error);
    }
    return FSErrno.SUCCESS;
  }

  sync(node: FileNode | DirectoryNode): number {
    try {
      if (node.type === "file") {
        if (this.pendingIds.has(node)) {
          // The physical file has not materialized yet, so content
          // durability cannot be guaranteed. Report the failure, as fsync
          // may fail with ENOSPC on POSIX too.
          return FSErrno.NOSPC;
        }
        const id = this.physByNode.get(node);
        // No id and not pending: a tree-builder-seeded file that was
        // never adopted - nothing durable was promised yet, so there is
        // nothing to flush.
        if (id !== undefined) this.handleById.get(id)!.flush();
      } else {
        // Directory sync: the namespace record is flushed on every change
        // already; flush it again as a harmless hardening point.
        for (const handle of this.metaHandles) handle.flush();
      }
    } catch (error) {
      return this.errnoOf(error);
    }
    return FSErrno.SUCCESS;
  }

  datasync(node: FileNode | DirectoryNode): number {
    return this.sync(node);
  }

  // -------------------------------------------------------------------
  // FSBackend: fd lifecycle
  // -------------------------------------------------------------------

  openFile(node: FileNode): number {
    if (!this.physByNode.has(node)) {
      // First open of a file the backend has not persisted yet: adopt it
      // now so every later op runs over its sync access handle, and
      // record it (path_open with CREAT already snapshotted, this covers
      // tree-builder seeded files opened before any namespace change).
      try {
        this.adopt(node);
        this.snapshotFlush();
      } catch (error) {
        return this.errnoOf(error);
      }
    }
    this.openCounts.set(node, (this.openCounts.get(node) ?? 0) + 1);
    return FSErrno.SUCCESS;
  }

  closeFile(node: FileNode): void {
    const count = this.openCounts.get(node) ?? 0;
    if (count > 1) {
      this.openCounts.set(node, count - 1);
      return;
    }
    this.openCounts.delete(node);
    if (this.pendingTombstones.delete(node)) {
      // A failure here has nowhere to be reported; the data file stays
      // mapped and unreferenced, and re-init reclaims it.
      this.destroyContent(node);
    }
  }

  // -------------------------------------------------------------------
  // FSBackend: namespace
  // -------------------------------------------------------------------

  createChild(parent: DirectoryNode, name: string, node: FSNode): number {
    if (
      node.type === "file" &&
      (this.physByNode.has(node) || this.known.has(node))
    ) {
      // A second name for an existing file is a hard link; the namespace
      // record maps ids to exactly one name (documented limitation).
      return FSErrno.NOTSUP;
    }
    const previous = parent.entries[name];
    parent.entries[name] = node;
    try {
      this.snapshotFlush();
    } catch (error) {
      if (previous !== undefined) parent.entries[name] = previous;
      else delete parent.entries[name];
      return this.errnoOf(error);
    }
    return FSErrno.SUCCESS;
  }

  removeChild(parent: DirectoryNode, name: string): number {
    const node = parent.entries[name];
    if (node !== undefined && node.type === "file") {
      // Step 1: destroy the content durably, or defer that to the last
      // close while fds are open, before the unlink itself becomes
      // durable in step 2. If this fails, the name keeps resolving.
      const errno = this.tombstone(node);
      if (errno !== FSErrno.SUCCESS) return errno;
    }
    delete parent.entries[name];
    try {
      // Step 2: record the namespace without the entry.
      this.snapshotFlush();
    } catch (error) {
      // Roll the in-memory namespace back so the name keeps resolving.
      // The content may already be gone, leaving the name mapped to an
      // empty file - the documented crash window of step 1.
      if (node !== undefined) {
        parent.entries[name] = node;
        if (node.type === "file") this.pendingTombstones.delete(node);
      }
      return this.errnoOf(error);
    }
    return FSErrno.SUCCESS;
  }

  renameChild(
    fromParent: DirectoryNode,
    fromName: string,
    toParent: DirectoryNode,
    toName: string,
  ): number {
    const node = fromParent.entries[fromName];
    const replaced = toParent.entries[toName];
    delete fromParent.entries[fromName];
    toParent.entries[toName] = node;
    try {
      // Record the new mapping first, so that a crash here shows either
      // the old target or the renamed node at the destination, never a
      // truncated file in between.
      this.snapshotFlush();
    } catch (error) {
      if (replaced !== undefined) toParent.entries[toName] = replaced;
      else delete toParent.entries[toName];
      fromParent.entries[fromName] = node;
      return this.errnoOf(error);
    }
    if (
      replaced !== undefined &&
      replaced !== node &&
      replaced.type === "file"
    ) {
      // The record no longer references the replaced target, so this is
      // cleanup rather than a durability point: a failure here leaves an
      // unreferenced data file that re-init reclaims.
      this.tombstone(replaced);
    }
    return FSErrno.SUCCESS;
  }

  listChildren(dir: DirectoryNode): string[] {
    return Object.keys(dir.entries);
  }
}
