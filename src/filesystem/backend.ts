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
   * Write `data` at `offset`, extending the file (zero-filling any gap) if
   * it ends past EOF. Returns an errno.
   */
  writeAt(node: FileNode, data: Uint8Array, offset: number): number;
  /** Truncate or zero-fill-extend the file to `size`. Returns an errno. */
  resize(node: FileNode, size: number): number;
  /** Flush data and metadata for `fd_sync`. Returns an errno. */
  sync(node: FileNode | DirectoryNode): number;
  /** Flush data for `fd_datasync`. Returns an errno. */
  datasync(node: FileNode | DirectoryNode): number;
  /** A file is about to get an fd; claim any handle. Returns an errno. */
  openFile(node: FileNode): number;
  /** The fd over this file was closed; release any handle. */
  closeFile(node: FileNode): void;
  /** Link `node` into `parent` under `name`. Returns an errno. */
  createChild(parent: DirectoryNode, name: string, node: FSNode): number;
  /** Unlink `name` from `parent`. Returns an errno. */
  removeChild(parent: DirectoryNode, name: string): number;
  /**
   * Move the node at `fromName` to `toName`, replacing any node already
   * there. Returns an errno.
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
