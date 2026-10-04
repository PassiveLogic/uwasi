import { DirectoryNode, FileNode, FSNode } from "./namespace.js";

/**
 * Storage backend behind the file-system syscalls.
 *
 * The shared syscall layer owns everything WASI-shaped: path
 * resolution, rights, errno mapping, the fd table, seek cursors, readdir
 * cookies and inode metadata. A backend owns only where the bytes and the
 * namespace live: file contents behind `readAt`/`writeAt`/`resize`, and
 * directory membership behind `createChild`/`removeChild`/`renameChild`.
 *
 * Every method is synchronous, because the syscall path is synchronous. A
 * backend that needs asynchronous setup must complete it before WASI starts.
 *
 * The node tree doubles as the backend's in-memory namespace mirror: path
 * resolution and `readdir` read `DirectoryNode.entries` directly, so the
 * namespace methods must keep `entries` exact as they persist the change.
 */
export interface FSBackend {
  /** Current size in bytes. Throws public `FSError` on storage failure. */
  fileSize(node: FileNode): number;
  /**
   * Read into `buf` from `offset`; returns bytes read, short at EOF.
   * Throws public `FSError` on storage failure, never reports it as EOF.
   */
  readAt(node: FileNode, buf: Uint8Array, offset: number): number;
  /**
   * Write `data` at `offset`. Returns an errno. A write that ends past EOF
   * must extend the file itself, zero-filling any gap: the syscall layer
   * does not resize it first. Empty `data` leaves the file as it is, even
   * at an offset past EOF. A failed write may still have changed the
   * file: extended it, or written part of `data`. `fd_write` and
   * `fd_pwrite` call this once per iovec, in order, so when a later one
   * fails, the earlier ones stay written while the syscall reports only
   * the errno.
   */
  writeAt(node: FileNode, data: Uint8Array, offset: number): number;
  /** Truncate or zero-fill-extend the file to `size`. Returns an errno. */
  resize(node: FileNode, size: number): number;
  /**
   * Flush data and metadata for `fd_sync`. Returns an errno. On a
   * directory, every namespace change that has succeeded must be durable
   * when this returns. A backend whose namespace methods make each change
   * durable before they return has nothing left to do here.
   */
  sync(node: FileNode | DirectoryNode): number;
  /** Flush data for `fd_datasync`. Returns an errno. */
  datasync(node: FileNode | DirectoryNode): number;
  /** A file is about to get an fd; claim any handle. Returns an errno. */
  openFile(node: FileNode): number;
  /** The fd over this file was closed; release any handle. */
  closeFile(node: FileNode): void;
  /**
   * Link `node` into `parent` under `name`. Returns an errno.
   *
   * The syscall layer keeps every `nlink`; a backend reads it but never
   * changes it. A create passes a new node: a directory, or a node whose
   * `nlink` is 1. `path_link` passes an existing node, any but a
   * directory, whose `nlink` it has already raised to count the new name,
   * so it is above 1, and lowers it again if this returns an error or
   * throws. A backend without hard links tells a link from a create that
   * way and returns `NOTSUP`.
   */
  createChild(parent: DirectoryNode, name: string, node: FSNode): number;
  /**
   * Unlink `name` from `parent`. Returns an errno. The caller lowers the
   * node's `nlink` once this succeeds.
   */
  removeChild(parent: DirectoryNode, name: string): number;
  /**
   * Move the node at `fromName` to `toName`, replacing any node already
   * there. Returns an errno. The caller lowers a replaced node's `nlink`
   * once this succeeds.
   */
  renameChild(
    fromParent: DirectoryNode,
    fromName: string,
    toParent: DirectoryNode,
    toName: string,
  ): number;
  /** Child names of `dir`, in the stable order `readdir` cookies index. */
  listChildren(dir: DirectoryNode): string[];
}
