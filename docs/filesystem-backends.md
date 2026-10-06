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
adopts seeded files on open and through `persistAll()`. Other seeded files become
durable only when the backend next writes a full snapshot (at compaction, the next
`create()`, or a guest rename of a seeded name, which no log record could replay),
so call `persistAll()` after seeding.

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
only after a namespace operation succeeds, except in `path_link`: it raises the
source node's `nlink` before it calls `createChild`, so a backend without hard
links can refuse a second name for an existing node, and lowers it again if the
link fails. Every node but a directory carries `nlink`, symlinks and device
nodes included.

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

The OPFS data-file format is unchanged. The namespace record is now binary (see
[Namespace Record](#namespace-record)). The store format is not compatible with
stores written by earlier builds of this fork's OPFS backend, in its JSON format
or an earlier binary one: `create()` refuses
such a store rather than open it, and leaves it untouched, as it does any store
whose namespace it cannot read, such as one written by a later version.

Sync access handles still require a worker and exclusive ownership by one live backend. Hard links
remain unsupported, and so are links, renames and unlinks of device nodes such
as `/dev/null`, which the runtime recreates at every open; both return `NOTSUP`.
Inode numbers and timestamps are not persisted. Async startup,
spare-handle pooling, pending file materialization, `settle()`, sync errors during
pool exhaustion, metadata recovery, and destructive unlink ordering are unchanged.
Memory storage keeps its existing capacity, zero-fill, aliasing, and resizable
buffer behavior.

Each namespace change is recorded by appending one record to a change log and
flushing it, so recording it costs amortized constant time, whatever the
namespace size. Periodic compaction rewrites the whole filename tree, amortized
over the changes that preceded it (see [Namespace Record](#namespace-record)).
The syscall itself may still cost more than recording: renaming a directory
searches its subtree, so that it is not moved into itself.

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

## Sizing the OPFS Spare Pool

Guest syscalls are synchronous, but creating an OPFS file is not. The backend
bridges the two with a pool of pre-created, empty data files, each held open: a
guest file create claims one synchronously. When a guest call creates more files
than the pool holds, the excess files _overdraft_:

- Their names are recorded durably as usual, but their bytes stay in memory until
  the backend creates their data files in the background.
- `fd_sync` and `fd_datasync` on them return `NOSPC` until then.
- A crash before that happens leaves those names mapped to empty files.

Background work (creating overdrafted files and refilling the pool) runs only when
the event loop gets a turn, which means between guest calls, never during one. A
host that starts the next guest call as soon as the last returns, for example
from a message handler, may never let it finish.

A host controls this with two things:

- **`spareFiles`** (default 16) sets the pool size. Set it to at least the number
  of spares one guest call claims; files beyond it overdraft. A call claims one
  spare per file it creates and per host-seeded file it opens for the first time.
  A snapshot of the namespace (every compaction, and any change no log record can
  express, such as renaming a seeded file) also claims one for every reachable
  seeded file not yet persisted; `persistAll()` after seeding avoids that. A
  failed create's spare waits in quarantine until the next snapshot succeeds,
  since the failed record may still name it. Each spare is an open sync access
  handle on an empty data file, created at `create()`, so a large pool costs open
  time and handles. In one Chromium measurement, 1,024 spares
  added about 130 ms to `create()`.
- **`await backend.settle()`** waits for the background work: overdrafted files
  get their data files and the pool is refilled to `spareFiles`. Await it between
  guest calls whenever files created so far should survive a crash, and before a
  call that will create many files. It costs time proportional to the files
  created since the last settle. Guest calls may still run while it waits, and it
  waits for the work they queue too: it resolves once no work is queued or running
  and no file is waiting for its data file, so no file reachable at that point
  still waits for one. A guest that keeps creating files past the pool during every wait
  can delay it indefinitely. It rejects as soon as storage refuses any of that
  work; the files it left keep their bytes in memory, and the next `settle()`
  retries. `persistAll()` waits the same way, then flushes every reachable file.

With `spareFiles` at least the largest burst and `settle()` between calls, no file
overdrafts. Without `settle()`, a large pool helps only the first call, since the
refill may not finish before the next. A single call that creates more files than
the pool always overdrafts the excess; await `settle()` after it to make them
durable. `close()` also finishes the background work and flushes every file, so a
clean shutdown keeps every file's bytes, overdrafted ones included; if storage
refuses any of it, `close()` still releases every handle, then rejects, since
those bytes may be lost. (Seeded files that nothing has recorded yet are not saved
by `close()`; see `persistAll()`.)

Fewer, larger files avoid the problem altogether: each file costs a spare, while
bytes written to an existing file do not.

## Namespace Record

The OPFS backend persists guest names separately from file content. Each
`.uwasi.data.<id>` file holds one guest file's bytes; the namespace record maps
names to those ids. It is a sequence of binary records over directory ids and
data-file ids:

| Record    | Fields                               |
| --------- | ------------------------------------ |
| `MKDIR`   | parent dir, name, new dir id         |
| `FILE`    | parent dir, name, data-file id       |
| `SYMLINK` | parent dir, name, target             |
| `REMOVE`  | parent dir, name                     |
| `RENAME`  | from dir, from name, to dir, to name |

Ids are LEB128 varints and names are length-prefixed UTF-8. The root directory
is id 0. A snapshot is the `MKDIR`, `FILE`, and `SYMLINK` records that rebuild the
tree from an empty root, in `entries` order, so re-init preserves directory
listing order. Snapshots alternate between `.uwasi.meta.0` and `.uwasi.meta.1`,
each framed as `"UWS2" | u32 body length | u32 checksum | body`, where the body is
a varint generation followed by the records and the checksum is FNV-1a over the
first 8 bytes (magic and length) continued over the body. Re-init loads the
highest intact generation. A slot whose length or checksum does not verify is
torn, and re-init falls back to the other one. A slot that verifies but that this
version cannot read, under an unknown magic or as a `"UWS2"` body that does not
decode, is intact: no torn write passes the checksum, since it covers the header.
It may hold the newest namespace, so `create()` rejects without changing the store
rather than fall back or open it as empty. So it does for a magic of four nonzero
bytes it does not know, even if the checksum fails: a torn write of a known magic
leaves a known magic or a zero byte, never that. The formats of earlier builds of
this backend are refused the same way, by name: the JSON namespace under `"UWM1"`,
and the binary one under `"UWS1"`, whose checksum covered the body alone.

Changes after a snapshot go to `.uwasi.meta.log`, one record per namespace change,
appended and flushed before the syscall returns. The log header is
`"UWL2" | u32 check | u64 generation`: it names the snapshot generation the log
builds on, and its check is FNV-1a over the magic continued over the generation.
As for a snapshot slot, a header that verifies under a magic this version does
not know, or that has an unknown magic of four nonzero bytes, makes `create()`
reject, and so does the `"UWL1"` log of earlier builds, whose check covered the
generation alone. Each frame is `u32 body length | u32 check | record`, where the check is
FNV-1a of the record seeded with the generation and the frame's offset, so bytes
left over from an earlier generation, or from a frame at another offset, never
verify. Re-init replays the log on top of the snapshot it names, stopping at the
first frame that does not verify. A frame that verifies was written whole, so if
it does not decode to exactly one record, `create()` rejects: stopping there
would drop the changes after it for good, since every open compacts. A failed
append is truncated away where possible. A complete frame left behind at the end
of the log does verify, and may still become durable, so the failed change may
take effect after all, which a failed syscall allows.

Every later format of these files must keep their header: a 4-byte magic first,
new for any change in format, and a checksum that covers it. That is what lets an
older version tell a store it must refuse from one it may recover.

Once the log exceeds both 64 KiB and twice the last snapshot, the backend writes
the next snapshot and then resets the log to build on it. A crash between those
steps leaves a log naming the older generation, which re-init ignores because the
new snapshot already holds its changes. If the reset itself fails, changes are
recorded by full snapshots until a later compaction resets the log. If the
snapshot fails, the slot may still hold it, and storage may keep it however the
write failed, with the same effect. Its generation is not used again in that
session and the log takes no further appends, so changes are again recorded by
full snapshots (into the same slot) until one succeeds and replaces it. Every
`create()` also compacts, so a store opens with an empty log. It counts
generations on from the one it loaded, which may reuse a failed snapshot's
generation; that is harmless, since a slot it did not load is torn or older,
and its first snapshot overwrites that slot.

A failed change can thus leave a record that names a data file the backend has
freed: the file whose content an unlink destroyed before recording the removal
failed, or the file a failed create claimed. Such a data file stays out of the
spare pool until a later snapshot succeeds, since a new file claiming it would
make that name show the new file's bytes. A data file whose name a durable
record already dropped, by an unlink or a replacing rename that succeeded, is
reused at once: replay forgets it at that record. A directory `fd_sync` flushes
nothing, since every guest change was flushed before its syscall returned; it
does not record host-seeded files either (see `persistAll()`).
