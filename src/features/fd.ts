import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider, WASIOptions } from "../options.js";

export {
  ReadableTextProxy,
  lineBuffered,
  useStdio,
  StdioOptions,
} from "../filesystem/stdio.js";
export {
  MemoryFileSystem,
  DirectoryNode,
  FileNode,
  SymlinkNode,
  FSNode,
} from "../filesystem/namespace.js";
export { FSBackend } from "../filesystem/backend.js";
export { bindFSSyscalls } from "../filesystem/handlers.js";
export { MemoryFSBackend } from "../memory/backend.js";
export { useMemoryFS } from "../memory/index.js";

export function useFS(useOptions: { fs: any }): WASIFeatureProvider {
  return (options: WASIOptions, abi: WASIAbi, memoryView: () => DataView) => {
    // TODO: implement fd_* syscalls using `useOptions.fs`
    return {};
  };
}
