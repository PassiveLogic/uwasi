# Filesystem Backends

The `uwasi/filesystem` entry point is the public boundary for storage backends.
Existing root imports continue to work, including
`useMemoryFS`, `MemoryFileSystem`, `useFS`, `useStdio`, and `lineBuffered`.

`useAll()` still selects memory storage.

## Public Contract

`uwasi/filesystem` exports `FSBackend`, `FileNode`, `DirectoryNode`, `SymlinkNode`,
`FSNode`, `MemoryFileSystem`, `StdioOptions`, `FSErrno`, `FSError`, and `useFileSystem`.

```ts
import { WASI } from "uwasi";
import { useFileSystem } from "uwasi/filesystem";

const wasi = new WASI({
  features: [
    useFileSystem({
      withBackend: backend,
      withFileSystem: namespace,
      withStdio: { stdout: console.log },
    }),
  ],
});
```

Here `backend` implements `FSBackend` and `namespace` is its `MemoryFileSystem`.
The historical class name is retained: it supplies the live node tree and
preopens even when file bytes live elsewhere. The provider uses that namespace's
preopens, not `WASIOptions.preopens`. Complete asynchronous setup before binding.
The provider handles ABI and guest-memory wiring; backends do not import either.

All backend operations remain synchronous and receive the actual node objects.
The handlers resolve paths and read directory entries directly, so backend
namespace operations must update the live `DirectoryNode.entries` as well as any
persistent record. They are not notifications after an independent core mutation.
File identity is object identity; external storage need not use `FileNode.content`
for bytes. Memory-only namespace helpers do not themselves persist changes.

Methods documented as returning errno must return WASI preview1 error numbers,
not throw for ordinary storage failures. `FSErrno` exposes the storage error
constants needed by the included backend. Read methods return byte counts,
including short reads at EOF. `readAt` and `fileSize` retain numeric success
results and report storage failures by throwing `FSError(errno, cause?)`.
The shared syscall boundary converts only that error type to a WASI errno;
unexpected exceptions still propagate. A failed read is not reported as EOF,
and a failed size lookup is not reported as an empty file. Link counts change
only after a namespace operation succeeds.

The error must come from the same uwasi module instance as the provider because
recognition uses constructor identity. Avoid mixing ESM/CJS instances or duplicate
uwasi installations across this boundary.

## Source Layout

- `src/filesystem/backend.ts`: synchronous storage contract.
- `src/filesystem/error.ts`: typed storage failure translated by syscall handlers.
- `src/filesystem/namespace.ts`: nodes, process-wide inode stamping, namespace,
  and path resolution.
- `src/filesystem/content.ts`: shared content-buffer ownership and growth rules.
- `src/filesystem/handlers.ts`: shared rights, fd table, syscall handling, and
  ABI integration.
- `src/filesystem/stdio.ts`: stdio proxies and providers, independent of storage.
- `src/filesystem/index.ts`: deliberate public backend entry point.
- `src/memory/`: memory byte storage and its feature adapter.
- `src/features/fd.ts`: compatibility exports for
  existing internal consumers.

Tests use package-name imports (`uwasi`, `uwasi/filesystem`) when
checking the public surface. Relative `../lib/esm/...` and `../lib/cjs/...`
imports in the compatibility test deliberately check those exact old build
paths. No `@uwasi/...` alias is configured. TypeScript `paths` alone would not
make such an alias resolvable by Node or a browser.

## Unchanged Limits

Memory storage keeps its existing capacity, zero-fill, aliasing, and resizable
buffer behavior.

`test/filesystem-boundary.test.mjs` packs and unpacks the built package in a
temporary directory, tests ESM/CJS imports, and compiles an external backend using
legacy TypeScript Node resolution with no source aliases.

The boundary fixture's named memory addresses are non-overlapping offsets chosen
for its guest buffer, not WASI constants. Its iovec contains a 32-bit buffer
pointer followed by a 32-bit length. The preopen descriptor, create flag, seek
origin and rights mask follow the WASI Preview 1 ABI. Payload values are test
data; `UNCHANGED_OUTPUT` detects accidental result writes on a failed operation.
