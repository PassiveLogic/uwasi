import { WASIAbi } from "../abi.js";
import { WASIFeatureProvider } from "../options.js";
import { FSBackend } from "./backend.js";
import { bindFSSyscalls } from "./handlers.js";
import { MemoryFileSystem } from "./namespace.js";
import { StdioOptions } from "./stdio.js";

export { FSBackend } from "./backend.js";
export { FSError } from "./error.js";
export {
  DirectoryNode,
  FileNode,
  FSNode,
  SymlinkNode,
  MemoryFileSystem,
} from "./namespace.js";
export { StdioOptions } from "./stdio.js";

/** Storage errors returned by backends, using WASI preview1 errno values. */
export const FSErrno = {
  SUCCESS: WASIAbi.WASI_ESUCCESS,
  NOSPC: WASIAbi.WASI_ERRNO_NOSPC,
  IO: WASIAbi.WASI_ERRNO_IO,
  INVAL: WASIAbi.WASI_ERRNO_INVAL,
  FBIG: WASIAbi.WASI_ERRNO_FBIG,
  NOTSUP: WASIAbi.WASI_ERRNO_NOTSUP,
} as const;

/** Bind a ready synchronous backend and its live namespace to WASI. */
export function useFileSystem(useOptions: {
  withBackend: FSBackend;
  withFileSystem: MemoryFileSystem;
  withStdio?: StdioOptions;
}): WASIFeatureProvider {
  return (_options, abi, memoryView) =>
    bindFSSyscalls(
      useOptions.withBackend,
      useOptions.withFileSystem,
      useOptions.withStdio || {},
      abi,
      memoryView,
    );
}
