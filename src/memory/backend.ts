import { WASIAbi } from "../abi.js";
import { FSBackend } from "../filesystem/backend.js";
import {
  DirectoryNode,
  FileNode,
  FSNode,
  nowNs,
} from "../filesystem/namespace.js";
import { resizeContent } from "../filesystem/content.js";

/**
 * Resize a file's backing buffer, zero-filling any growth. Returns an errno.
 *
 * A guest chooses this size, so it can ask for one no JavaScript engine will
 * allocate. Both failures return an errno rather than throw: an exception
 * raised inside an import unwinds through the guest and traps the module,
 * which leaves the guest no way to see the error or recover from it.
 */
const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;

function resizeFile(node: FileNode, size: number): number {
  // Anything that is not a whole, non-negative count of bytes is a bad
  // argument, whatever its magnitude: `NaN`, a fraction, `Infinity`, or a
  // negative. Only a well-formed size that is simply too big is a large file.
  if (!Number.isInteger(size) || size < 0) return WASIAbi.WASI_ERRNO_INVAL;
  // Above 2^53 a size no longer survives the trip through a JS number, so it
  // can be neither honoured nor reported back accurately.
  if (size > MAX_FILE_SIZE) return WASIAbi.WASI_ERRNO_FBIG;
  if (size === node.content.byteLength) return WASIAbi.WASI_ESUCCESS;

  try {
    node.content = resizeContent(node.content, size);
  } catch (error) {
    // The engine refused the allocation. For a filesystem held in memory,
    // that is the same condition as a full disk.
    if (error instanceof RangeError) return WASIAbi.WASI_ERRNO_NOSPC;
    throw error;
  }
  node.mtim = nowNs();
  return WASIAbi.WASI_ESUCCESS;
}

/**
 * The in-memory backend: file bytes live in `FileNode.content` and the
 * namespace is the node tree itself, so persistence points are no-ops.
 */
export class MemoryFSBackend implements FSBackend {
  fileSize(node: FileNode): number {
    return node.content.byteLength;
  }
  readAt(node: FileNode, buf: Uint8Array, offset: number): number {
    const data = node.content;
    if (offset >= data.byteLength) return 0;
    const count = Math.min(buf.byteLength, data.byteLength - offset);
    buf.set(data.subarray(offset, offset + count));
    return count;
  }
  writeAt(node: FileNode, data: Uint8Array, offset: number): number {
    const end = offset + data.byteLength;
    if (end > node.content.byteLength) {
      const errno = resizeFile(node, end);
      if (errno !== WASIAbi.WASI_ESUCCESS) return errno;
    }
    node.content.set(data, offset);
    return WASIAbi.WASI_ESUCCESS;
  }
  resize(node: FileNode, size: number): number {
    return resizeFile(node, size);
  }
  sync(_node: FileNode | DirectoryNode): number {
    return WASIAbi.WASI_ESUCCESS;
  }
  datasync(_node: FileNode | DirectoryNode): number {
    return WASIAbi.WASI_ESUCCESS;
  }
  openFile(_node: FileNode): number {
    return WASIAbi.WASI_ESUCCESS;
  }
  closeFile(_node: FileNode): void {}
  createChild(parent: DirectoryNode, name: string, node: FSNode): number {
    parent.entries[name] = node;
    return WASIAbi.WASI_ESUCCESS;
  }
  removeChild(parent: DirectoryNode, name: string): number {
    delete parent.entries[name];
    return WASIAbi.WASI_ESUCCESS;
  }
  renameChild(
    fromParent: DirectoryNode,
    fromName: string,
    toParent: DirectoryNode,
    toName: string,
  ): number {
    const node = fromParent.entries[fromName];
    delete fromParent.entries[fromName];
    toParent.entries[toName] = node;
    return WASIAbi.WASI_ESUCCESS;
  }
  listChildren(dir: DirectoryNode): string[] {
    return Object.keys(dir.entries);
  }
}
