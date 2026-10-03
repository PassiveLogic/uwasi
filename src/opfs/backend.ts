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
import {
  ByteWriter,
  NsRecord,
  Op,
  ROOT_DIR_ID,
  Snapshot,
  UnknownFormatError,
  beginSnapshot,
  decodeSnapshot,
  encodeRecord,
  finishSnapshot,
} from "./format.js";

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
// Store layout
// ---------------------------------------------------------------------------

const META_NAMES = [".uwasi.meta.0", ".uwasi.meta.1"];
const DATA_PREFIX = ".uwasi.data.";

function dataName(id: number): string {
  return DATA_PREFIX + id;
}

function readAll(handle: OPFSSyncAccessHandle): Uint8Array {
  const buffer = new Uint8Array(handle.getSize());
  if (buffer.byteLength > 0) handle.read(buffer, { at: 0 });
  return buffer;
}

/** Live state while records rebuild the namespace at `init`. */
type ReplayState = {
  dirs: Map<number, DirectoryNode>;
  files: Map<number, FileNode>;
  maxDir: number;
  maxFile: number;
};

const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;

/**
 * `data` resized to `size` bytes, zero-filled, or `null` if the engine
 * refuses to allocate that much. The guest picks the size (a write offset
 * or a truncate length), and an exception thrown inside a WASI import
 * traps the guest, so callers report a refusal as a full device, as the
 * memory backend does.
 */
function resizedContent(data: Uint8Array, size: number): Uint8Array | null {
  let next: Uint8Array;
  try {
    next = new Uint8Array(size);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  next.set(data.subarray(0, Math.min(size, data.byteLength)));
  return next;
}

/**
 * Whether a namespace change naming `node` involves a device node: the
 * node is one, or is a directory holding one (`/dev`). Device nodes belong
 * to the runtime: the `MemoryFileSystem` constructor creates them at every
 * open and no record stores them, so such a change would quietly come
 * undone at a later open. The backend refuses it instead.
 */
function involvesDevice(node: FSNode | undefined): boolean {
  if (node === undefined) return false;
  if (node.type === "character") return true;
  if (node.type !== "dir") return false;
  for (const name in node.entries) {
    if (node.entries[name].type === "character") return true;
  }
  return false;
}

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
 * Limits: hard links are refused with `NOTSUP`, as are changes naming a
 * device node (see `involvesDevice`), inode numbers and timestamps are
 * not persisted, and the store needs exactly one live backend, since sync
 * access handles are exclusive locks.
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
  /**
   * Directory node -> its id in the namespace records. Ids are assigned
   * when a directory is first recorded and never reused.
   */
  private dirIds = new WeakMap<DirectoryNode, number>();
  private nextDirId = ROOT_DIR_ID + 1;
  /** Reused across snapshots to avoid regrowing the encode buffer. */
  private encoder = new ByteWriter();
  /** Guest file node -> data-file id, for every persisted file. */
  private physByNode = new Map<FileNode, number>();
  /** Data-file id -> its always-open sync access handle. */
  private handleById = new Map<number, OPFSSyncAccessHandle>();
  /** Ids of pre-created, empty, claimable data files. */
  private spares: number[] = [];
  /**
   * Ids of emptied data files that a namespace record may still name: the
   * durable record a failed unlink did not replace, or the snapshot a
   * failed change left in a slot, which a later flush (or the storage
   * itself) can still make durable. A spare gets new content, so handing
   * one of these out would let that name show another file's bytes. They
   * rejoin the pool once a snapshot is durable: it names none of them,
   * and it overwrites the slot any failed snapshot was left in.
   */
  private quarantine: number[] = [];
  /**
   * Files created past the spare pool: their id is already durable in the
   * namespace record, their content still lives in `node.content` until
   * the background materializer creates the physical file.
   */
  private pendingIds = new Map<FileNode, number>();
  /**
   * File nodes a durable namespace record names. A node joins only once a
   * record naming it is flushed: an id alone proves nothing, since `adopt`
   * hands one out before the record that would name it is written, and
   * that write can fail. Hard-link detection and `openFile` rely on it.
   */
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
    try {
      await backend.init(options.preopens);
    } catch (error) {
      // Sync access handles are exclusive locks: any left held would make
      // every later attempt to open the store in this worker fail. Mark the
      // backend closed first: background work the open queued may still be
      // waiting on OPFS, and must release whatever it acquires afterwards.
      backend.closed = true;
      backend.releaseHandles();
      throw error;
    }
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
    // A slot this version cannot read stops the open before anything is
    // changed (see `readSlot`).
    let snapshot: Snapshot | null = null;
    for (const name of META_NAMES) {
      const fileHandle = await this.store.getFileHandle(name, { create: true });
      const handle = await fileHandle.createSyncAccessHandle();
      this.metaHandles.push(handle);
      const slot = this.readSlot(name, handle);
      if (slot && (!snapshot || slot.gen > snapshot.gen)) snapshot = slot;
    }
    this.generation = snapshot ? snapshot.gen : 0;

    // Rebuild the guest namespace from the records alone. Data files the
    // records do not reference belong to unlinked files, so they stay
    // invisible to the guest whatever bytes they still hold.
    this.fileSystem = new MemoryFileSystem(preopens);
    const root = this.fileSystem.lookup("/") as DirectoryNode;
    this.dirIds.set(root, ROOT_DIR_ID);
    const replay: ReplayState = {
      dirs: new Map([[ROOT_DIR_ID, root]]),
      files: new Map(),
      maxDir: ROOT_DIR_ID,
      maxFile: -1,
    };
    for (const record of snapshot ? snapshot.records : []) {
      this.applyRecord(record, replay);
    }
    // Ids may have been handed out after the records were last written
    // (background pool refills are not recorded); never reuse one.
    this.nextId = Math.max(maxSeenId, replay.maxFile) + 1;
    this.nextDirId = replay.maxDir + 1;

    // Claim every referenced data file's handle for life.
    for (const [, id] of this.physByNode) {
      let fileHandle = dataFiles.get(id);
      if (!fileHandle) {
        // Referenced but physically missing (a foreign actor removed it,
        // or `close()` did for a file it reported lost): surface it as an
        // empty file rather than failing the whole store.
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
      this.handleById.set(id, handle);
      handle.truncate(0);
      handle.flush();
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
      try {
        await this.store.removeEntry(dataName(id));
      } catch {
        // Best effort: the file is unreferenced, and the next open
        // reclaims it again.
      }
    }

    // Persist the initial state (also records the advanced id counter).
    this.snapshotFlush();
  }

  /**
   * Decode the snapshot in slot `name`; `null` if it is empty or torn.
   * Throws if the slot holds intact bytes in a format this version cannot
   * read, such as the one earlier builds of this backend wrote, or one a
   * later uwasi wrote. Opening anyway, from the other slot or as an empty
   * store, would reclaim as unreferenced the data files of every file
   * only that slot names, destroying their content.
   */
  private readSlot(
    name: string,
    handle: OPFSSyncAccessHandle,
  ): Snapshot | null {
    try {
      return decodeSnapshot(readAll(handle));
    } catch (error) {
      if (!(error instanceof UnknownFormatError)) throw error;
      throw new Error(
        `uwasi: ${name} holds a namespace snapshot this version does not understand (${error.message}); refusing to open the store rather than discard it`,
      );
    }
  }

  /**
   * Apply one namespace record to the tree being rebuilt. Records come
   * from a snapshot or, in order, from later changes, so each mirrors what
   * the live `FSBackend` hook did to `entries` - including where a name
   * lands in insertion order, which keeps `listChildren` (and with it
   * readdir cookie indexing) stable across re-init. A record naming a
   * parent or source that does not exist is skipped.
   */
  private applyRecord(record: NsRecord, replay: ReplayState): void {
    switch (record.op) {
      case Op.Mkdir: {
        const parent = replay.dirs.get(record.parent);
        if (!parent) return;
        const existing = parent.entries[record.name];
        let dir: DirectoryNode;
        if (existing !== undefined && existing.type === "dir") {
          // Preopens and /dev already exist in a fresh namespace.
          dir = existing;
        } else {
          this.forget(existing, replay);
          // Null-prototype entries, as `makeDir` creates them.
          dir = {
            type: "dir",
            entries: Object.create(null),
          } as DirectoryNode;
          this.fileSystem.setNodeIn(parent, record.name, dir);
        }
        replay.dirs.set(record.dir, dir);
        this.dirIds.set(dir, record.dir);
        replay.maxDir = Math.max(replay.maxDir, record.dir);
        return;
      }
      case Op.File: {
        const parent = replay.dirs.get(record.parent);
        if (!parent) return;
        let node = replay.files.get(record.file);
        if (parent.entries[record.name] !== node) {
          this.forget(parent.entries[record.name], replay);
        }
        if (!node) {
          node = {
            type: "file",
            content: new Uint8Array(0),
            nlink: 1,
          } as FileNode;
          replay.files.set(record.file, node);
          this.physByNode.set(node, record.file);
        }
        // Two names for one id should not happen without hard links;
        // keep them coherent by sharing the node if it ever does.
        this.fileSystem.setNodeIn(parent, record.name, node);
        this.known.add(node);
        replay.maxFile = Math.max(replay.maxFile, record.file);
        return;
      }
      case Op.Symlink: {
        const parent = replay.dirs.get(record.parent);
        if (!parent) return;
        this.forget(parent.entries[record.name], replay);
        this.fileSystem.setNodeIn(parent, record.name, {
          type: "symlink",
          target: record.target,
        } as SymlinkNode);
        return;
      }
      case Op.Remove: {
        const parent = replay.dirs.get(record.parent);
        if (!parent) return;
        const node = parent.entries[record.name];
        if (node === undefined) return;
        delete parent.entries[record.name];
        this.forget(node, replay);
        return;
      }
      case Op.Rename: {
        const from = replay.dirs.get(record.fromParent);
        const to = replay.dirs.get(record.toParent);
        if (!from || !to) return;
        const node = from.entries[record.fromName];
        if (node === undefined) return;
        const replaced = to.entries[record.toName];
        delete from.entries[record.fromName];
        to.entries[record.toName] = node;
        if (replaced !== undefined && replaced !== node) {
          this.forget(replaced, replay);
        }
        return;
      }
    }
  }

  /**
   * A replayed record dropped `node`'s last name: release its data-file id
   * so a later record may map the recycled id to a new file.
   */
  private forget(node: FSNode | undefined, replay: ReplayState): void {
    if (node === undefined || node.type !== "file") return;
    const id = this.physByNode.get(node);
    if (id === undefined) return;
    this.physByNode.delete(node);
    this.known.delete(node);
    if (replay.files.get(id) === node) replay.files.delete(id);
  }

  // -------------------------------------------------------------------
  // Namespace persistence
  // -------------------------------------------------------------------

  /**
   * Apply a namespace change to `dirs` with `apply` and record it. If the
   * record fails, `dirs` get back exactly the entries they had, in their
   * order too: insertion order is the listing order, which a reopen
   * rebuilds from the record. Rethrows the failure.
   */
  private recordChange(dirs: DirectoryNode[], apply: () => void): void {
    const saved = dirs.map((dir) =>
      Object.assign(Object.create(null), dir.entries),
    );
    apply();
    try {
      this.snapshotFlush();
    } catch (error) {
      dirs.forEach((dir, i) => {
        for (const name of Object.keys(dir.entries)) delete dir.entries[name];
        Object.assign(dir.entries, saved[i]);
      });
      throw error;
    }
  }

  /**
   * Serialize the live node tree into the older record slot and flush it.
   * This is the single durability point for every namespace change. It
   * also adopts any reachable file the backend has not persisted yet
   * (files seeded through the `MemoryFileSystem` tree-builder), claiming
   * spares - or overdraft ids - for them.
   */
  private snapshotFlush(): void {
    const root = this.fileSystem.lookup("/") as DirectoryNode;
    const files: FileNode[] = [];
    const generation = this.generation + 1;
    const out = this.encoder;
    beginSnapshot(out, generation);
    this.encodeDir(root, ROOT_DIR_ID, out, files);
    const buffer = finishSnapshot(out);
    const handle = this.metaHandles[generation % 2];
    writeFully(handle, buffer, 0);
    handle.truncate(buffer.byteLength);
    handle.flush();
    this.generation = generation;
    for (const file of files) this.known.add(file);
    this.spares.push(...this.quarantine.splice(0));
  }

  /**
   * Emit the records that recreate `dir`'s subtree, in `entries` order,
   * collecting the file nodes they name.
   */
  private encodeDir(
    dir: DirectoryNode,
    dirId: number,
    out: ByteWriter,
    files: FileNode[],
  ): void {
    for (const name of Object.keys(dir.entries)) {
      const child = dir.entries[name];
      switch (child.type) {
        case "dir": {
          const id = this.dirIdOf(child);
          encodeRecord(out, { op: Op.Mkdir, parent: dirId, name, dir: id });
          this.encodeDir(child, id, out, files);
          break;
        }
        case "file": {
          this.adopt(child);
          files.push(child);
          const file =
            this.physByNode.get(child) ?? this.pendingIds.get(child)!;
          encodeRecord(out, { op: Op.File, parent: dirId, name, file });
          break;
        }
        case "symlink":
          encodeRecord(out, {
            op: Op.Symlink,
            parent: dirId,
            name,
            target: child.target,
          });
          break;
        case "character":
          // Recreated by the MemoryFileSystem constructor on re-init.
          break;
      }
    }
  }

  private dirIdOf(dir: DirectoryNode): number {
    let id = this.dirIds.get(dir);
    if (id === undefined) {
      id = this.nextDirId++;
      this.dirIds.set(dir, id);
    }
    return id;
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
   * `mayBeNamed` says a record that may yet become durable still names the
   * file (see `recycle`). Returns an errno; on failure nothing is recycled.
   */
  private tombstone(node: FileNode, mayBeNamed: boolean): number {
    const pendingId = this.pendingIds.get(node);
    if (pendingId !== undefined) {
      // Never materialized: nothing durable exists to destroy, and the
      // materializer will notice the cancellation and recycle the file it
      // may already have created. Open fds keep working on the in-memory
      // content.
      this.pendingIds.delete(node);
      this.known.delete(node);
      this.recycleAbandoned(pendingId, mayBeNamed);
      return FSErrno.SUCCESS;
    }
    if (!this.physByNode.has(node)) return FSErrno.SUCCESS;
    if ((this.openCounts.get(node) ?? 0) > 0) {
      this.pendingTombstones.add(node);
      return FSErrno.SUCCESS;
    }
    return this.destroyContent(node, mayBeNamed);
  }

  /**
   * Return an emptied data file to the spare pool, or, while a record that
   * may yet become durable still names it, to `quarantine`.
   */
  private recycle(id: number, mayBeNamed: boolean): void {
    if (mayBeNamed) this.quarantine.push(id);
    else this.spares.push(id);
  }

  /**
   * A failed materialization leaves its handle tracked for the retry, but
   * a cancelled id is never retried, so recycle that handle here. (An
   * attempt still acquiring one has not tracked it yet, and recycles it
   * itself.)
   */
  private recycleAbandoned(id: number, mayBeNamed: boolean): void {
    const handle = this.handleById.get(id);
    if (handle === undefined) return;
    try {
      handle.truncate(0);
      handle.flush();
      this.recycle(id, mayBeNamed);
    } catch {
      // It may still hold content, so it cannot be a spare. Release its
      // lock instead; re-init reclaims the unreferenced data file.
      this.handleById.delete(id);
      try {
        handle.close();
      } catch {
        // Already closed or revoked.
      }
    }
  }

  private destroyContent(node: FileNode, mayBeNamed: boolean): number {
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
    this.recycle(id, mayBeNamed);
    return FSErrno.SUCCESS;
  }

  private scheduleBackground(): void {
    if (this.replenishScheduled || this.closed) return;
    this.replenishScheduled = true;
    // A round starts even after a failed one: it retries whatever that
    // round left undone.
    this.background = this.background
      .catch(() => {})
      .then(async () => {
        this.replenishScheduled = false;
        // Materialize overdrafted files first: each waits on a durability
        // guarantee (`sync` fails until its physical file exists). One
        // failure does not hold the others back.
        const failures: unknown[] = [];
        const tried = new Set<FileNode>();
        for (;;) {
          const batch = [...this.pendingIds].filter(
            ([node]) => !tried.has(node),
          );
          if (batch.length === 0) break;
          for (const [node, id] of batch) {
            tried.add(node);
            try {
              await this.materialize(node, id);
            } catch (error) {
              failures.push(error);
            }
          }
        }
        if (failures.length > 0) throw failures[0];
        // Then refill the spare pool.
        while (this.spares.length < this.spareTarget && !this.closed) {
          const id = this.nextId++;
          const handle = await this.openDataFile(id);
          if (handle === undefined) return;
          this.handleById.set(id, handle);
          this.spares.push(id);
        }
      });
    // `settle()` and `close()` report a failure; nothing else awaits it.
    this.background.catch(() => {});
  }

  /**
   * Acquire the sync access handle of data file `id`, creating the file if
   * needed. Background work can outlive the backend - a failed `create()`
   * releases every handle while work it queued still waits on OPFS - so a
   * handle that arrives after shutdown is released at once, and nothing is
   * returned in its place.
   */
  private async openDataFile(
    id: number,
  ): Promise<OPFSSyncAccessHandle | undefined> {
    const fileHandle = await this.store.getFileHandle(dataName(id), {
      create: true,
    });
    if (this.closed) return undefined;
    const handle = await fileHandle.createSyncAccessHandle();
    if (this.closed) {
      try {
        handle.close();
      } catch {
        // Already closed or revoked.
      }
      return undefined;
    }
    return handle;
  }

  /**
   * Give an overdrafted file its physical data file. A handle left by an
   * earlier failed attempt is reused: it still holds the file's exclusive
   * lock, so acquiring another would fail.
   */
  private async materialize(node: FileNode, id: number): Promise<void> {
    // Unlinked before its turn: `tombstone` recycled any handle it had.
    if (this.pendingIds.get(node) !== id) return;
    let handle = this.handleById.get(id);
    const retry = handle !== undefined;
    if (handle === undefined) {
      handle = await this.openDataFile(id);
      if (handle === undefined) return;
      // Tracked at once, so a failure below leaves it for the next attempt
      // and for `close()` to release.
      this.handleById.set(id, handle);
    }
    if (this.pendingIds.get(node) !== id || this.closed) {
      // Unlinked (or shut down) while we were acquiring the handle:
      // recycle the physical file. Whether the record that dropped the id
      // became durable is no longer known here, so assume it did not.
      if (this.pendingIds.get(node) === id) this.pendingIds.delete(node);
      this.recycleAbandoned(id, true);
      return;
    }
    try {
      if (node.content.byteLength > 0) {
        writeFully(handle, node.content, 0);
      }
      // An earlier attempt may have written more than the content now holds.
      if (retry) handle.truncate(node.content.byteLength);
      handle.flush();
    } catch (error) {
      try {
        // A failed write may leave part of the content in the file, and
        // releasing the handle at `close()` may persist it. Empty the
        // file, so nothing publishes a prefix the file never held as a
        // whole; the content stays in memory for the retry.
        handle.truncate(0);
      } catch {
        // Then a later flush, or the storage itself before a crash, may
        // still publish that prefix; `close()` removes the data file of a
        // file it reports lost.
      }
      throw error;
    }
    this.pendingIds.delete(node);
    this.physByNode.set(node, id);
    node.content = new Uint8Array(0);
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

  /**
   * Wait until background work is quiescent - no round scheduled or
   * running, no file waiting for its data file - so files created past
   * the spare pool have their data files, and the pool is refilled.
   * Guest calls may run while it waits, and it waits for the work they
   * queue too: no file reachable when it resolves still waits for its
   * data file. A guest that keeps creating files past the pool during
   * every wait can delay that indefinitely. Rejects as soon as a round
   * fails; the files it left overdrafted keep their content in memory,
   * and the next `settle()` (or file creation) retries.
   */
  async settle(): Promise<void> {
    // A fresh round retries what an earlier failed one left, rather than
    // reporting its stale failure.
    this.scheduleBackground();
    for (;;) {
      const round = this.background;
      await round;
      // A guest call during the wait queued another round: wait for it.
      if (this.background !== round) continue;
      // Only a closed backend leaves files pending after a clean round.
      if (this.pendingIds.size === 0 || this.closed) return;
      this.scheduleBackground();
    }
  }

  /**
   * Make every file reachable in the tree durable, name and content alike,
   * including files seeded through the `MemoryFileSystem` tree-builder
   * after `create()`: once it resolves, a crash keeps each one with the
   * content it held then. Guest calls may run while it waits; it resolves
   * once background work is quiescent (see `settle()`), and covers every
   * file reachable at that point except files seeded while it waited. A
   * guest that keeps creating files past the spare pool during every wait
   * can delay that indefinitely. Being async it does not draw on the
   * spare pool; call it after seeding to keep the pool free for the
   * guest. Rejects if any of it failed.
   */
  async persistAll(): Promise<void> {
    const root = this.fileSystem.lookup("/") as DirectoryNode;
    await this.adoptSubtree(root);
    this.snapshotFlush();
    // A guest call may overdraft another file once `settle()` has resolved
    // but before this resumes: settle again until none is pending. No
    // await separates that check from the flush, so no guest call can
    // slip in between.
    do {
      await this.settle();
    } while (this.pendingIds.size > 0);
    // Files that had a data file already may hold writes no flush has
    // covered yet.
    const failure = this.flushDataFiles();
    if (failure !== undefined) throw failure;
  }

  private async adoptSubtree(dir: DirectoryNode): Promise<void> {
    for (const name of Object.keys(dir.entries)) {
      // The guest runs while this awaits, so an entry may be gone.
      const child = dir.entries[name] as FSNode | undefined;
      if (child === undefined) continue;
      if (child.type === "dir") {
        await this.adoptSubtree(child);
      } else if (
        child.type === "file" &&
        !this.physByNode.has(child) &&
        // Overdrafted files already have an id; settle() materializes them.
        !this.pendingIds.has(child)
      ) {
        const id = this.nextId++;
        const handle = await this.openDataFile(id);
        if (handle === undefined) return;
        this.handleById.set(id, handle);
        if (
          this.physByNode.has(child) ||
          this.pendingIds.has(child) ||
          child.nlink === 0
        ) {
          // Adopted while the handle was on its way, by a guest open or a
          // snapshot, and maybe written and synced since; or unlinked (or
          // replaced by a rename), so no name needs its bytes. The new
          // data file is empty and no record names it: keep it as a spare.
          this.spares.push(id);
          continue;
        }
        try {
          if (child.content.byteLength > 0) {
            writeFully(handle, child.content, 0);
          }
          handle.flush();
        } catch (error) {
          // No record names the new data file: empty it for the pool.
          this.recycleAbandoned(id, false);
          throw error;
        }
        this.physByNode.set(child, id);
        child.content = new Uint8Array(0);
      }
    }
  }

  /**
   * Make every file's content durable and release every handle; the
   * backend is unusable afterwards. Rejects, once everything is released,
   * if a file created past the spare pool still could not get its data
   * file (its name is recorded, but the content it held only in memory is
   * lost), or if flushing a file's content failed (what was written to it
   * since its last successful `fd_sync` may be lost).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    // Let pending materializations and refills finish first (retrying any
    // that failed), so files created past the spare pool become durable on
    // a clean shutdown. Settling again if a guest call overdrafted a file
    // after `settle()` resolved means only a failure loses content.
    let failure: unknown = undefined;
    do {
      failure = await this.settle().then(
        () => undefined,
        (error: unknown) => error,
      );
    } while (failure === undefined && this.pendingIds.size > 0);
    const lost = new Set(this.pendingIds.keys());
    // Data files that failed attempts acquired for the files lost.
    const abandoned = [...this.pendingIds.values()].filter((id) =>
      this.handleById.has(id),
    );
    this.closed = true;
    await this.background.catch(() => {});
    // A guest call during that wait may have overdrafted a file that no
    // round can give a data file any more.
    for (const node of this.pendingIds.keys()) lost.add(node);
    // Closing a sync access handle only releases it: the File System
    // Standard leaves persisting its writes to `flush()`.
    const flushFailure = this.flushDataFiles();
    this.releaseHandles();
    // A failed attempt that could not empty its data file left part of a
    // lost file's content there, and closing the handle may have
    // persisted it. Remove those data files, so the next open recreates
    // them empty rather than showing a prefix the file never held. Best
    // effort: if the removal fails, or a crash comes first, the prefix may
    // remain.
    for (const id of abandoned) {
      try {
        await this.store.removeEntry(dataName(id));
      } catch {
        // See above.
      }
    }
    if (lost.size > 0) {
      throw (
        failure ??
        new Error(`uwasi: ${lost.size} files lost their content at close`)
      );
    }
    if (flushFailure !== undefined) throw flushFailure;
  }

  /**
   * Flush the data file of every file the guest may still reach; unlinked
   * files awaiting their last close are skipped. The namespace slots are
   * not flushed: every successful change flushed its record already, and
   * a failed one may have left bytes there that a flush would publish.
   * Every file is tried; returns the first failure.
   */
  private flushDataFiles(): unknown {
    let failure: unknown = undefined;
    for (const [node, id] of this.physByNode) {
      if (this.pendingTombstones.has(node)) continue;
      try {
        this.handleById.get(id)!.flush();
      } catch (error) {
        failure ??= error;
      }
    }
    return failure;
  }

  private releaseHandles(): void {
    for (const handle of [...this.handleById.values(), ...this.metaHandles]) {
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
        const grown = resizedContent(node.content, end);
        if (grown === null) return FSErrno.NOSPC;
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
        const next = resizedContent(node.content, size);
        if (next === null) return FSErrno.NOSPC;
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
        if (id === undefined) {
          // No data file and no pending id. A file no record names (seeded
          // through the tree-builder and never adopted, or unlinked) was
          // promised nothing, so there is nothing to flush. A named one
          // has nowhere durable for its content: never report success.
          return this.known.has(node) ? FSErrno.NOSPC : FSErrno.SUCCESS;
        }
        this.handleById.get(id)!.flush();
      }
      // A directory needs nothing: every namespace change flushed its
      // record before its syscall returned. Flushing the slots again could
      // only make durable a snapshot that a failed change left behind.
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
    if (
      !this.known.has(node) ||
      (!this.physByNode.has(node) && !this.pendingIds.has(node))
    ) {
      // First open of a file the record does not name yet: adopt it now
      // so every later op runs over its sync access handle, and record it
      // (path_open with CREAT already snapshotted, this covers
      // tree-builder seeded files opened before any namespace change, and
      // retries after that snapshot failed). A recorded file needs no new
      // record, even overdrafted: its id is already in it.
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
      // mapped and unreferenced, and re-init reclaims it. The unlink is
      // durable, so no record names the data file any more.
      this.destroyContent(node, false);
    }
  }

  // -------------------------------------------------------------------
  // FSBackend: namespace
  // -------------------------------------------------------------------

  createChild(parent: DirectoryNode, name: string, node: FSNode): number {
    // `path_link` of a device node.
    if (involvesDevice(node)) return FSErrno.NOTSUP;
    if (
      (node.type !== "dir" && node.nlink > 1) ||
      (node.type === "file" &&
        (this.physByNode.has(node) ||
          this.pendingIds.has(node) ||
          this.known.has(node)))
    ) {
      // A second name for an existing file or symlink is a hard link; the
      // namespace record maps ids to exactly one name, and stores each
      // symlink name as a node of its own (documented limitation).
      // `path_link` counts the new name in `nlink` first, which also
      // catches a node seeded through the tree-builder that no record
      // names yet.
      return FSErrno.NOTSUP;
    }
    try {
      this.recordChange([parent], () => {
        parent.entries[name] = node;
      });
    } catch (error) {
      if (node.type === "file") {
        // Hand back the data file (or overdraft id) the record would have
        // named. The failed snapshot may still name it, so it waits in
        // quarantine rather than backing the next file at once.
        this.tombstone(node, true);
      }
      return this.errnoOf(error);
    }
    return FSErrno.SUCCESS;
  }

  removeChild(parent: DirectoryNode, name: string): number {
    const node = parent.entries[name];
    if (involvesDevice(node)) return FSErrno.NOTSUP;
    // A file past the spare pool has nothing durable to destroy, and must
    // keep its id - which the record still names - if step 2 fails. Its
    // id is released once the removal is durable.
    const pending =
      node !== undefined && node.type === "file" && this.pendingIds.has(node);
    if (node !== undefined && node.type === "file" && !pending) {
      // Step 1: destroy the content durably, or defer that to the last
      // close while fds are open, before the unlink itself becomes
      // durable in step 2. If this fails, the name keeps resolving. Until
      // step 2 is durable the record still names the data file.
      const errno = this.tombstone(node, true);
      if (errno !== FSErrno.SUCCESS) return errno;
    }
    try {
      // Step 2: record the namespace without the entry.
      this.recordChange([parent], () => {
        delete parent.entries[name];
      });
    } catch (error) {
      // The name keeps resolving. The content may already be gone,
      // leaving the name mapped to an empty file - the documented crash
      // window of step 1. Its data file stays in quarantine, since the
      // durable record still maps the name to it.
      if (node !== undefined && node.type === "file") {
        this.pendingTombstones.delete(node);
      }
      return this.errnoOf(error);
    }
    if (pending) this.tombstone(node as FileNode, false);
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
    if (involvesDevice(node) || involvesDevice(replaced)) {
      return FSErrno.NOTSUP;
    }
    try {
      // Record the new mapping first, so that a crash here shows either
      // the old target or the renamed node at the destination, never a
      // truncated file in between.
      this.recordChange(
        fromParent === toParent ? [fromParent] : [fromParent, toParent],
        () => {
          delete fromParent.entries[fromName];
          toParent.entries[toName] = node;
        },
      );
    } catch (error) {
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
      this.tombstone(replaced, false);
    }
    return FSErrno.SUCCESS;
  }

  listChildren(dir: DirectoryNode): string[] {
    return Object.keys(dir.entries);
  }
}
