# Filesystem Backends

uwasi remains one npm package. There is no separate `uwasi-opfs` package yet.
The `uwasi/filesystem` entry point is the public boundary for storage backends;
`uwasi/opfs` exposes the existing OPFS backend and feature adapter as a subpath of
that same package. Existing non-OPFS root imports continue to work, including
`useMemoryFS`, `MemoryFileSystem`, `useFS`, `useStdio`, and `lineBuffered`.

OPFS is exposed only through the public `uwasi/opfs` subpath, not the root.
Root imports of `WASI` and `useAll` exclude OPFS from both the ESM and CommonJS
dependency graphs. `useAll()` still selects memory storage.

Existing fork consumers, including Khasm, must split their previous combined
root import:

```ts
import { WASI } from "uwasi";
import { OPFSBackend, useOPFS } from "uwasi/opfs";
```

A future package extraction would require consumers to install the new package
and change their OPFS import specifier, not just move source files.

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
for bytes. Memory-only namespace helpers do not themselves persist changes. OPFS
retains its existing seeded-file adoption on open and through `persistAll()`.

In particular, calling `backend.fileSystem.removeEntry()` on a persisted OPFS
file only changes the live memory tree. The durable mapping can still restore
the file on restart. Perform guest mutations through the filesystem handlers;
do not use the namespace's memory-only helpers as a persistent delete API.

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
- `src/opfs/`: OPFS storage, metadata/recovery, handle pool, and feature adapter.
- `src/features/fd.ts` and `src/features/opfs.ts`: compatibility exports for
  existing internal consumers.

OPFS imports core only through `../filesystem/index.js`, the source entry point
published as `uwasi/filesystem`. Relative imports preserve direct ESM loading
without an import map. A future extraction can move `src/opfs/` and replace that
single boundary specifier with `uwasi/filesystem`; no syscall internals need move.
No such package is created or published by this refactor.

Tests use package-name imports (`uwasi`, `uwasi/filesystem`, `uwasi/opfs`) when
checking the public surface. Relative `../lib/esm/...` and `../lib/cjs/...`
imports in the compatibility test deliberately check those exact old build
paths. No `@uwasi/...` alias is configured. TypeScript `paths` alone would not
make such an alias resolvable by Node or a browser.

## Unchanged Limits

The OPFS on-disk metadata and data-file formats are unchanged. Sync access handles
still require a worker and exclusive ownership by one live backend. Hard links
remain unsupported; inode numbers and timestamps are not persisted. Async startup,
spare-handle pooling, pending file materialization, `settle()`, sync errors during
pool exhaustion, metadata recovery, and destructive unlink ordering are unchanged.
Memory storage keeps its existing capacity, zero-fill, aliasing, and resizable
buffer behavior.

Namespace changes serialize and flush the whole filename tree. This cost grows
with namespace size and mutation frequency; it is not constant-cost metadata I/O.

Shutdown hardening removes a pending mapping when its materialization is
cancelled by close, without dropping a newer mapping. This does not make guest
operations during or after backend close supported.

`test/filesystem-boundary.test.mjs` packs and unpacks the built package in a
temporary directory, tests ESM/CJS imports, and compiles an external backend using
legacy TypeScript Node resolution with no source aliases. It also copies the real
OPFS subtree unchanged and supplies a one-line public-package re-export at the
boundary, then compiles and exercises that copy against the packaged declarations.
Its persistence round trip uses the existing OPFS mock, not a browser. These tests
do not establish real-browser durability or change the existing storage guarantees.

The tests also traverse the emitted ESM static dependency graph and inspect a
fresh CommonJS process's `require.cache` to exclude OPFS from root imports.
After verifying the full packed installation supports OPFS, the fixture removes
only its installed OPFS modules and compatibility exports. Fresh ESM and CommonJS
processes still construct `WASI` with `useAll()` and exercise a filesystem syscall;
explicit `uwasi/opfs` imports fail as a control. Repository files are not removed.

The boundary fixture's named memory addresses are non-overlapping offsets chosen
for its guest buffer, not WASI constants. Its iovec contains a 32-bit buffer
pointer followed by a 32-bit length. The preopen descriptor, create flag, seek
origin and rights mask follow the WASI Preview 1 ABI. Payload values are test
data; `UNCHANGED_OUTPUT` detects accidental result writes on a failed operation.
