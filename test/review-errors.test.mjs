import assert from "node:assert/strict";
import { test } from "node:test";
import { WASI } from "uwasi";
import * as filesystem from "uwasi/filesystem";
import { OPFSBackend } from "uwasi/opfs";
import { MemoryFSBackend } from "../lib/esm/memory/backend.js";
import { WASIAbi } from "../lib/esm/abi.js";
import { MockOPFS } from "./opfs_mock.mjs";

const { MemoryFileSystem, FSErrno, useFileSystem } = filesystem;
const RIGHTS = (1n << 30n) - 1n;
const OUTPUT = 512;
const IOVS = 256;
const DATA = 1024;
const STAT = 640;
const SENTINEL = 1234;

function guest(backend, fileSystem = backend.fileSystem) {
  const wasi = new WASI({
    features: [
      useFileSystem({ withBackend: backend, withFileSystem: fileSystem }),
    ],
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.setInstance({ exports: { memory } });
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const calls = wasi.wasiImport;
  const path = (name, ptr = 0) => {
    const encoded = new TextEncoder().encode(name);
    bytes.set(encoded, ptr);
    return [ptr, encoded.length];
  };
  return {
    calls,
    view,
    bytes,
    path,
    open(name, flags = 0) {
      assert.equal(
        calls.path_open(3, 0, ...path(name), flags, RIGHTS, RIGHTS, 0, OUTPUT),
        FSErrno.SUCCESS,
      );
      return view.getUint32(OUTPUT, true);
    },
    links(fd) {
      assert.equal(calls.fd_filestat_get(fd, STAT), FSErrno.SUCCESS);
      return view.getBigUint64(STAT + 24, true);
    },
    rename(from, to) {
      return calls.path_rename(3, ...path(from), 3, ...path(to, 128));
    },
    cursor(fd) {
      assert.equal(calls.fd_tell(fd, OUTPUT + 8), FSErrno.SUCCESS);
      return view.getBigUint64(OUTPUT + 8, true);
    },
    iovecs() {
      for (let i = 0; i < 2; i++) {
        view.setUint32(IOVS + i * 8, DATA + i * 2, true);
        view.setUint32(IOVS + i * 8 + 4, 2, true);
      }
      bytes.fill(99, DATA, DATA + 4);
      view.setUint32(OUTPUT, SENTINEL, true);
    },
  };
}

for (const operation of ["unlink", "rename"]) {
  test(`${operation} changes nlink only after backend success`, () => {
    const fs = new MemoryFileSystem();
    const source = fs.createFile("/source", new Uint8Array([1]));
    fs.createFile("/target", new Uint8Array([2]));
    const backend = new MemoryFSBackend();
    const method = operation === "unlink" ? "removeChild" : "renameChild";
    const original = backend[method].bind(backend);
    let fail = true;
    backend[method] = (...args) => (fail ? FSErrno.IO : original(...args));
    const g = guest(backend, fs);
    const fd = g.open("target");
    const invoke = () =>
      operation === "unlink"
        ? g.calls.path_unlink_file(3, ...g.path("target"))
        : g.rename("source", "target");
    for (let i = 0; i < 2; i++) {
      assert.equal(invoke(), FSErrno.IO);
      assert.equal(g.links(fd), 1n);
      assert.notEqual(fs.lookup("/target"), null);
    }
    fail = false;
    assert.equal(invoke(), FSErrno.SUCCESS);
    assert.equal(g.links(fd), 0n);
    assert.equal(source.nlink, 1);
  });
}

test("rename to a missing target succeeds without changing nlink", () => {
  const fs = new MemoryFileSystem();
  const node = fs.createFile("/source", new Uint8Array());
  const g = guest(new MemoryFSBackend(), fs);
  const fd = g.open("source");
  assert.equal(g.rename("source", "missing"), FSErrno.SUCCESS);
  assert.equal(fs.lookup("/missing"), node);
  assert.equal(fs.lookup("/source"), null);
  assert.equal(g.links(fd), 1n);
});

for (const alias of ["source", "alias"]) {
  test(`rename source to same inode at ${alias} is a no-op`, () => {
    const fs = new MemoryFileSystem();
    const node = fs.createFile("/source", new Uint8Array());
    const backend = new MemoryFSBackend();
    const g = guest(backend, fs);
    const fd = g.open("source");
    if (alias !== "source") {
      assert.equal(
        g.calls.path_link(3, 0, ...g.path("source"), 3, ...g.path(alias, 128)),
        FSErrno.SUCCESS,
      );
    }
    const links = g.links(fd);
    backend.renameChild = () =>
      assert.fail("same-inode rename must not mutate the backend");
    assert.equal(g.rename("source", alias), FSErrno.SUCCESS);
    assert.equal(g.links(fd), links);
    assert.equal(fs.lookup("/source"), node);
    assert.equal(fs.lookup(`/${alias}`), node);
  });
}

async function opfsFixture(t, hooks = {}, spareFiles = 1) {
  const store = new MockOPFS();
  const root = store.root;
  const getFileHandle = root.getFileHandle.bind(root);
  root.getFileHandle = async (name, options) => {
    const file = await getFileHandle(name, options);
    if (!name.startsWith(".uwasi.data.")) return file;
    const acquire = file.createSyncAccessHandle.bind(file);
    file.createSyncAccessHandle = async () => {
      await hooks.acquire?.(name);
      const handle = await acquire();
      for (const method of ["read", "getSize"]) {
        const original = handle[method].bind(handle);
        handle[method] = (...args) => {
          hooks[method]?.();
          return original(...args);
        };
      }
      return handle;
    };
    return file;
  };
  const backend = await OPFSBackend.create(root, { spareFiles });
  t.after(() => backend.close());
  const g = guest(backend);
  return { backend, g, store };
}

for (const syscall of ["fd_read", "fd_pread"]) {
  for (const failingRead of [1, 2]) {
    test(`${syscall} physical failure at iovec ${failingRead} returns IO without committing output or cursor`, async (t) => {
      const hooks = {};
      const { backend, g } = await opfsFixture(t, hooks);
      const fd = g.open("file", WASIAbi.WASI_OFLAGS_CREAT);
      assert.equal(
        backend.writeAt(
          backend.fileSystem.lookup("/file"),
          new Uint8Array([10, 20, 30, 40]),
          0,
        ),
        FSErrno.SUCCESS,
      );
      g.iovecs();
      let reads = 0;
      hooks.read = () => {
        if (++reads === failingRead)
          throw new DOMException("read failed", "UnknownError");
      };
      const args = syscall === "fd_pread" ? [0n, OUTPUT] : [OUTPUT];
      assert.equal(g.calls[syscall](fd, IOVS, 2, ...args), FSErrno.IO);
      assert.equal(g.view.getUint32(OUTPUT, true), SENTINEL);
      assert.equal(g.cursor(fd), 0n);
      assert.deepEqual(
        [...g.bytes.slice(DATA, DATA + 4)],
        failingRead === 1 ? [99, 99, 99, 99] : [10, 20, 99, 99],
      );
      hooks.read = undefined;
      assert.equal(g.calls[syscall](fd, IOVS, 2, ...args), FSErrno.SUCCESS);
      assert.equal(g.view.getUint32(OUTPUT, true), 4);
      assert.equal(g.cursor(fd), syscall === "fd_read" ? 4n : 0n);
      assert.equal(g.calls.fd_pread(fd, IOVS, 2, 4n, OUTPUT), FSErrno.SUCCESS);
      assert.equal(g.view.getUint32(OUTPUT, true), 0);
    });
  }
}

const sizeCalls = {
  fd_filestat_get: (g, fd) => g.calls.fd_filestat_get(fd, STAT),
  path_filestat_get: (g) =>
    g.calls.path_filestat_get(3, 0, ...g.path("file"), STAT),
  fd_seek: (g, fd) => g.calls.fd_seek(fd, 0n, WASIAbi.WASI_WHENCE_END, OUTPUT),
  fd_allocate: (g, fd) => g.calls.fd_allocate(fd, 0n, 8n),
  fd_write: (g, fd) => g.calls.fd_write(fd, IOVS, 2, OUTPUT),
  fd_pwrite: (g, fd) => g.calls.fd_pwrite(fd, IOVS, 2, 0n, OUTPUT),
  fd_write_append: (g, fd) => {
    assert.equal(
      g.calls.fd_fdstat_set_flags(fd, WASIAbi.WASI_FDFLAGS_APPEND),
      FSErrno.SUCCESS,
    );
    return g.calls.fd_write(fd, IOVS, 2, OUTPUT);
  },
};

for (const [name, invoke] of Object.entries(sizeCalls)) {
  test(`${name} physical getSize failure returns IO without changing outputs or cursor`, async (t) => {
    const hooks = {};
    const { backend, g } = await opfsFixture(t, hooks);
    const fd = g.open("file", WASIAbi.WASI_OFLAGS_CREAT);
    g.iovecs();
    g.bytes.fill(99, STAT, STAT + 64);
    hooks.getSize = () => {
      throw new DOMException("size failed", "UnknownError");
    };
    assert.equal(invoke(g, fd), FSErrno.IO);
    assert.equal(g.view.getUint32(OUTPUT, true), SENTINEL);
    assert.deepEqual([...g.bytes.slice(STAT, STAT + 64)], Array(64).fill(99));
    assert.equal(g.cursor(fd), 0n);
    hooks.getSize = undefined;
    assert.equal(backend.fileSize(backend.fileSystem.lookup("/file")), 0);
  });
}

test("public FSError preserves numeric backend APIs and maps only explicit backend errors", () => {
  assert.equal(typeof filesystem.FSError, "function");
  const fs = new MemoryFileSystem();
  fs.createFile("/file", new Uint8Array([1]));
  const backend = new MemoryFSBackend();
  const g = guest(backend, fs);
  const fd = g.open("file");
  g.iovecs();
  const error = new filesystem.FSError(FSErrno.NOSPC);
  backend.readAt = () => {
    throw error;
  };
  assert.equal(g.calls.fd_read(fd, IOVS, 1, OUTPUT), FSErrno.NOSPC);
  const unexpected = new TypeError("backend programming error");
  backend.readAt = () => {
    throw unexpected;
  };
  assert.throws(
    () => g.calls.fd_read(fd, IOVS, 1, OUTPUT),
    (error) => error === unexpected,
  );
  backend.fileSize = () => {
    throw unexpected;
  };
  assert.throws(
    () => g.calls.fd_filestat_get(fd, STAT),
    (error) => error === unexpected,
  );
});

test("OPFS numeric methods throw public FSError with the physical errno mapping", async (t) => {
  const hooks = {};
  const { backend, g } = await opfsFixture(t, hooks);
  g.open("file", WASIAbi.WASI_OFLAGS_CREAT);
  const node = backend.fileSystem.lookup("/file");
  for (const [method, invoke] of [
    ["read", () => backend.readAt(node, new Uint8Array(1), 0)],
    ["getSize", () => backend.fileSize(node)],
  ]) {
    for (const [error, errno] of [
      [new DOMException("IO", "UnknownError"), FSErrno.IO],
      [new DOMException("quota", "QuotaExceededError"), FSErrno.NOSPC],
      [new RangeError("capacity"), FSErrno.NOSPC],
    ]) {
      hooks[method] = () => {
        throw error;
      };
      assert.throws(
        invoke,
        (caught) =>
          typeof filesystem.FSError === "function" &&
          caught instanceof filesystem.FSError &&
          caught.errno === errno,
      );
    }
    const unexpected = new TypeError("programming error");
    hooks[method] = () => {
      throw unexpected;
    };
    assert.throws(invoke, (caught) => caught === unexpected);
    hooks[method] = undefined;
    assert.equal(invoke(), 0);
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("close racing a net-new pending file does not reacquire its recycled id", async (t) => {
  const entered = deferred();
  const release = deferred();
  const acquisitions = [];
  const { backend, g, store } = await opfsFixture(
    t,
    {
      acquire: async (name) => {
        acquisitions.push(name);
        entered.resolve();
        await release.promise;
      },
    },
    0,
  );
  const closing = backend.close();
  g.open("late", WASIAbi.WASI_OFLAGS_CREAT);
  await entered.promise;
  release.resolve();
  await closing;
  assert.equal(acquisitions.length, 1);
  assert.equal(store._openHandles.size, 0);
});

test("cancelled materialization preserves a newer pending id for the same node", async (t) => {
  const entered = deferred();
  const release = deferred();
  const acquisitions = [];
  const { backend, g } = await opfsFixture(
    t,
    {
      acquire: async (name) => {
        acquisitions.push(name);
        if (acquisitions.length === 1) {
          entered.resolve();
          await release.promise;
        }
      },
    },
    0,
  );
  g.open("file", WASIAbi.WASI_OFLAGS_CREAT);
  const node = backend.fileSystem.lookup("/file");
  await entered.promise;
  const root = backend.fileSystem.lookup("/");
  assert.equal(backend.removeChild(root, "file"), FSErrno.SUCCESS);
  backend.fileSystem.setNode("/file", node);
  assert.equal(backend.openFile(node), FSErrno.SUCCESS);
  assert.equal(backend.writeAt(node, new Uint8Array([42]), 0), FSErrno.SUCCESS);
  release.resolve();
  await backend.settle();
  assert.equal(acquisitions.length, 2);
  assert.notEqual(acquisitions[0], acquisitions[1]);
  assert.equal(backend.sync(node), FSErrno.SUCCESS);
  const bytes = new Uint8Array(1);
  assert.equal(backend.readAt(node, bytes, 0), 1);
  assert.equal(bytes[0], 42);
});
