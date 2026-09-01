import { useMemoryFS, MemoryFileSystem } from "../lib/esm/features/fd.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { describe, it } from "node:test";
import assert from "node:assert";

const PREOPEN_FD = 3;
const OFLAGS_CREAT = 1 << 0;
const ALL_RIGHTS = BigInt((1 << 30) - 1);
const ESUCCESS = 0;
const EINVAL = 28;
const EFBIG = 22;
const NOSPC = 51;

const PATH_PTR = 0;
const IOVEC_PTR = 256;
const DATA_PTR = 512;
const OUT_PTR = 4096;

/** A size no engine will allocate, and one a JS number cannot hold exactly. */
const UNREPRESENTABLE = 1n << 63n;

function makeFS() {
  const memory = new ArrayBuffer(65536);
  const view = new DataView(memory);
  const fileSystem = new MemoryFileSystem({ "/": "/" });
  const imports = useMemoryFS({ withFileSystem: fileSystem })(
    {},
    new WASIAbi(),
    () => view,
  );
  return { fs: fileSystem, imports, view, bytes: new Uint8Array(memory) };
}

function openFile(h, name) {
  const path = new TextEncoder().encode(name);
  h.bytes.set(path, PATH_PTR);
  const ret = h.imports.path_open(
    PREOPEN_FD,
    0,
    PATH_PTR,
    path.length,
    OFLAGS_CREAT,
    ALL_RIGHTS,
    ALL_RIGHTS,
    0,
    OUT_PTR,
  );
  assert.strictEqual(ret, ESUCCESS, `path_open errno ${ret}`);
  return h.view.getUint32(OUT_PTR, true);
}

function writeOneByte(h) {
  h.bytes[DATA_PTR] = 65;
  h.view.setUint32(IOVEC_PTR, DATA_PTR, true);
  h.view.setUint32(IOVEC_PTR + 4, 1, true);
}

describe("fd.useMemoryFS oversize requests", () => {
  // A guest picks these sizes. An exception thrown inside an import unwinds
  // through the guest and traps the module, so each of these must come back as
  // an errno the guest can act on.
  it("fd_filestat_set_size reports EFBIG", () => {
    const h = makeFS();
    const fd = openFile(h, "a");
    assert.strictEqual(
      h.imports.fd_filestat_set_size(fd, UNREPRESENTABLE),
      EFBIG,
    );
  });

  it("fd_allocate reports EFBIG", () => {
    const h = makeFS();
    const fd = openFile(h, "b");
    assert.strictEqual(h.imports.fd_allocate(fd, 0n, UNREPRESENTABLE), EFBIG);
  });

  it("fd_pwrite past a huge offset reports EFBIG", () => {
    const h = makeFS();
    const fd = openFile(h, "c");
    writeOneByte(h);
    assert.strictEqual(
      h.imports.fd_pwrite(fd, IOVEC_PTR, 1, UNREPRESENTABLE, OUT_PTR + 8),
      EFBIG,
    );
  });

  it("fd_write after a huge seek reports EFBIG", () => {
    const h = makeFS();
    const fd = openFile(h, "d");
    h.imports.fd_seek(fd, UNREPRESENTABLE, 0, OUT_PTR + 8);
    writeOneByte(h);
    assert.strictEqual(
      h.imports.fd_write(fd, IOVEC_PTR, 1, OUT_PTR + 8),
      EFBIG,
    );
  });

  it("reports EINVAL for a negative size", () => {
    // A guest cannot reach this, because `filesize` is unsigned. A host that
    // drives the imports directly can.
    const h = makeFS();
    const fd = openFile(h, "e");
    assert.strictEqual(h.imports.fd_filestat_set_size(fd, -1n), EINVAL);
  });

  it("leaves the file untouched when it refuses", () => {
    const h = makeFS();
    const fd = openFile(h, "f");
    writeOneByte(h);
    assert.strictEqual(
      h.imports.fd_write(fd, IOVEC_PTR, 1, OUT_PTR + 8),
      ESUCCESS,
    );

    assert.strictEqual(
      h.imports.fd_filestat_set_size(fd, UNREPRESENTABLE),
      EFBIG,
    );
    const node = h.fs.lookup("/f");
    assert.strictEqual(node.content.byteLength, 1);
    assert.strictEqual(node.content[0], 65);
  });

  it("still accepts a size the engine can allocate", () => {
    const h = makeFS();
    const fd = openFile(h, "g");
    assert.strictEqual(h.imports.fd_filestat_set_size(fd, 4096n), ESUCCESS);
    assert.strictEqual(h.fs.lookup("/g").content.byteLength, 4096);
  });

  it("reports NOSPC when the engine refuses an allocation it could describe", () => {
    // Between "the engine can do this" and "a JS number cannot hold this"
    // there is a band where the allocation simply fails. That is a full disk
    // as far as an in-memory filesystem is concerned.
    const h = makeFS();
    const fd = openFile(h, "h");
    // 2^52 is a safe integer, so it passes the representability check, but no
    // engine will hand back four petabytes.
    const ret = h.imports.fd_filestat_set_size(fd, 1n << 52n);
    assert.strictEqual(ret, NOSPC, `expected NOSPC, got ${ret}`);
  });
});
