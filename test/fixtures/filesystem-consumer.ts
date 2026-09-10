import { WASI } from "uwasi";
import {
  DirectoryNode,
  FileNode,
  FSBackend,
  FSErrno,
  FSNode,
  MemoryFileSystem,
  useFileSystem,
} from "uwasi/filesystem";

export class ExternalBackend implements FSBackend {
  bytes = new Map<FileNode, Uint8Array>();
  writeError = FSErrno.SUCCESS;
  syncError = FSErrno.SUCCESS;
  syncs = 0;
  opens = 0;
  closes = 0;

  fileSize(node: FileNode): number {
    return this.bytes.get(node)?.length ?? 0;
  }
  readAt(node: FileNode, buffer: Uint8Array, offset: number): number {
    const data = (this.bytes.get(node) ?? new Uint8Array()).subarray(
      offset,
      offset + buffer.length,
    );
    buffer.set(data);
    return data.length;
  }
  writeAt(node: FileNode, data: Uint8Array, offset: number): number {
    if (this.writeError) return this.writeError;
    this.resize(node, Math.max(this.fileSize(node), offset + data.length));
    this.bytes.get(node)!.set(data, offset);
    return FSErrno.SUCCESS;
  }
  resize(node: FileNode, size: number): number {
    const data = new Uint8Array(size);
    data.set((this.bytes.get(node) ?? new Uint8Array()).subarray(0, size));
    this.bytes.set(node, data);
    return FSErrno.SUCCESS;
  }
  sync(_node: FileNode | DirectoryNode): number {
    this.syncs++;
    return this.syncError;
  }
  datasync(node: FileNode | DirectoryNode): number {
    return this.sync(node);
  }
  openFile(_node: FileNode): number {
    this.opens++;
    return FSErrno.SUCCESS;
  }
  closeFile(_node: FileNode): void {
    this.closes++;
  }
  createChild(parent: DirectoryNode, name: string, node: FSNode): number {
    parent.entries[name] = node;
    return FSErrno.SUCCESS;
  }
  removeChild(parent: DirectoryNode, name: string): number {
    delete parent.entries[name];
    return FSErrno.SUCCESS;
  }
  renameChild(
    from: DirectoryNode,
    fromName: string,
    to: DirectoryNode,
    toName: string,
  ): number {
    to.entries[toName] = from.entries[fromName];
    delete from.entries[fromName];
    return FSErrno.SUCCESS;
  }
  listChildren(dir: DirectoryNode): string[] {
    return Object.keys(dir.entries);
  }
}

export function createConsumer() {
  const backend = new ExternalBackend();
  const fileSystem = new MemoryFileSystem();
  const wasi = new WASI({
    features: [
      useFileSystem({ withBackend: backend, withFileSystem: fileSystem }),
    ],
  });
  return { backend, fileSystem, wasi };
}
