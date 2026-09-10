import assert from "node:assert/strict";
import { test } from "node:test";
import { WASI } from "uwasi";
import * as filesystem from "uwasi/filesystem";
import { MemoryFSBackend } from "../lib/esm/memory/backend.js";

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
