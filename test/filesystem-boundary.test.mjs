import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { MockOPFS } from "./opfs_mock.mjs";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// WASI Preview 1 uses fd 0-2 for stdio. This fixture's first preopen is fd 3;
// CREAT is bit 0, SEEK_SET is 0, and the defined rights occupy bits 0-29.
const PREOPEN_FD = 3;
const OFLAGS_CREAT = 1;
const WHENCE_SET = 0;
const ALL_RIGHTS = (1n << 30n) - 1n;
// These are non-overlapping byte offsets chosen for the fixture's Wasm memory,
// not ABI constants. The iovec is a u32 buffer pointer followed by a u32 length.
const PATH_PTR = 0;
const OPENED_FD_PTR = 64;
const BYTE_COUNT_PTR = 68;
const FILE_OFFSET_PTR = 72;
const IOV_PTR = 128;
const IOV_LENGTH_PTR = IOV_PTR + Uint32Array.BYTES_PER_ELEMENT;
const DATA_PTR = 256;
const IOV_COUNT = 1;
// Sentinel used to check that an error path does not overwrite the result slot.
const UNCHANGED_OUTPUT = 1234;

test("public subpaths preserve filesystem identities without root OPFS exports", async () => {
  const root = await import("uwasi");
  const fs = await import("uwasi/filesystem");
  const opfs = await import("uwasi/opfs");
  assert.equal(typeof fs.useFileSystem, "function");
  assert.equal(fs.MemoryFileSystem, root.MemoryFileSystem);
  for (const name of Object.keys(opfs)) {
    assert.equal(name in root, false, `root must not export ${name}`);
  }
  assert.equal(typeof opfs.OPFSBackend, "function");
  assert.equal(typeof opfs.useOPFS, "function");
  const legacy = await import("../lib/esm/features/fd.js");
  for (const name of [
    "MemoryFileSystem",
    "useMemoryFS",
    "useFS",
    "useStdio",
    "lineBuffered",
  ]) {
    assert.equal(root[name], legacy[name]);
  }
  const cjs = require("uwasi");
  assert.equal(
    require("uwasi/filesystem").MemoryFileSystem,
    cjs.MemoryFileSystem,
  );
  const cjsOPFS = require("uwasi/opfs");
  for (const name of Object.keys(cjsOPFS)) {
    assert.equal(name in cjs, false, `CommonJS root must not export ${name}`);
  }
  assert.equal(typeof cjsOPFS.OPFSBackend, "function");
  assert.equal(typeof cjsOPFS.useOPFS, "function");
  const legacyCjs = require("../lib/cjs/features/fd.js");
  for (const name of [
    "MemoryFileSystem",
    "useMemoryFS",
    "useFS",
    "useStdio",
    "lineBuffered",
  ]) {
    assert.equal(cjs[name], legacyCjs[name]);
  }
});

test("root ESM static dependency graph excludes OPFS", async () => {
  const pending = [join(root, "lib/esm/index.js")];
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    assert.doesNotMatch(path, /\/opfs(?:\/|\.js$)/);
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
    );
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)
      )
        continue;
      const specifier = statement.moduleSpecifier?.text;
      if (!specifier) continue;
      assert.ok(specifier.startsWith("."), `${path}: ${specifier}`);
      pending.push(resolve(dirname(path), specifier));
    }
  }
  assert.ok(visited.has(join(root, "lib/esm/features/all.js")));
});

test("fresh CommonJS root dependency graph excludes OPFS", () => {
  assert.doesNotThrow(() =>
    execFileSync(
      process.execPath,
      [
        "-e",
        `
        const assert = require('node:assert/strict');
        const { WASI, useAll } = require('uwasi');
        const wasi = new WASI({ features: [useAll()] });
        assert.equal(typeof wasi.wasiImport.fd_read, 'function');
        for (const path of Object.keys(require.cache)) {
          assert.doesNotMatch(path, /\\/opfs(?:\\/|\\.js$)/);
        }
        `,
      ],
      { cwd: root, encoding: "utf8", stdio: "pipe" },
    ),
  );
});

test("filesystem and OPFS source imports respect the public boundary", async () => {
  for (const subtree of ["filesystem", "memory", "opfs"]) {
    for (const name of await readdir(join(root, "src", subtree))) {
      const path = join(root, "src", subtree, name);
      const source = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
      );
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) &&
          !ts.isExportDeclaration(statement)
        )
          continue;
        const specifier = statement.moduleSpecifier?.text;
        if (!specifier) continue;
        if (subtree === "opfs") {
          assert.ok(
            specifier.startsWith("./") ||
              specifier === "../filesystem/index.js",
            `${path}: ${specifier}`,
          );
        } else {
          assert.ok(
            !specifier.includes("opfs") && !specifier.includes("features/"),
            `${path}: ${specifier}`,
          );
          if (subtree === "filesystem")
            assert.ok(!specifier.includes("memory/"));
        }
      }
    }
  }
});

test("packed public declarations support an external backend and unchanged OPFS source", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "uwasi-boundary-"));
  try {
    const [pack] = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
        { cwd: root, encoding: "utf8" },
      ),
    );
    const installed = join(temp, "node_modules", "uwasi");
    await mkdir(installed, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      join(temp, pack.filename),
      "-C",
      installed,
      "--strip-components=1",
    ]);
    await cp(
      join(root, "test/fixtures/filesystem-consumer.ts"),
      join(temp, "consumer.ts"),
    );
    await cp(join(root, "src/opfs"), join(temp, "opfs"), { recursive: true });
    await mkdir(join(temp, "filesystem"));
    await writeFile(
      join(temp, "filesystem/index.ts"),
      'export * from "uwasi/filesystem";\n',
    );
    execFileSync(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "--strict",
        "--target",
        "es2020",
        "--module",
        "commonjs",
        "--moduleResolution",
        "node",
        "--lib",
        "es2020,dom",
        "--outDir",
        "out",
        "consumer.ts",
        "opfs/index.ts",
      ],
      { cwd: temp, encoding: "utf8" },
    );

    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import * as root from 'uwasi';
      import { MemoryFileSystem, useFileSystem } from 'uwasi/filesystem';
      import { OPFSBackend, useOPFS } from 'uwasi/opfs';
      assert.equal(root.MemoryFileSystem, MemoryFileSystem);
      assert.equal(typeof OPFSBackend, 'function');
      assert.equal(typeof useOPFS, 'function');
      assert.equal(typeof useFileSystem, 'function');
    `,
      ],
      { cwd: temp, encoding: "utf8" },
    );

    const externalRequire = createRequire(join(temp, "consumer.cjs"));
    const { createConsumer } = externalRequire("./out/consumer.js");
    const { backend, fileSystem, wasi } = createConsumer();
    const { FSErrno } = externalRequire("uwasi/filesystem");
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.setInstance({ exports: { memory } });
    const view = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);
    const imports = wasi.wasiImport;
    const filename = new TextEncoder().encode("file");
    bytes.set(filename, PATH_PTR);
    assert.equal(
      imports.path_open(
        PREOPEN_FD,
        0,
        PATH_PTR,
        filename.byteLength,
        OFLAGS_CREAT,
        ALL_RIGHTS,
        ALL_RIGHTS,
        0,
        OPENED_FD_PTR,
      ),
      FSErrno.SUCCESS,
    );
    const fd = view.getUint32(OPENED_FD_PTR, true);
    assert.equal(backend.opens, 1);
    const payload = new Uint8Array([10, 20, 30]);
    const dataEnd = DATA_PTR + payload.byteLength;
    bytes.set(payload, DATA_PTR);
    view.setUint32(IOV_PTR, DATA_PTR, true);
    view.setUint32(IOV_LENGTH_PTR, payload.byteLength, true);
    assert.equal(
      imports.fd_write(fd, IOV_PTR, IOV_COUNT, BYTE_COUNT_PTR),
      FSErrno.SUCCESS,
    );
    assert.equal(view.getUint32(BYTE_COUNT_PTR, true), payload.byteLength);
    assert.equal(fileSystem.lookup("/file").content.length, 0);
    assert.equal(
      imports.fd_seek(fd, 0n, WHENCE_SET, FILE_OFFSET_PTR),
      FSErrno.SUCCESS,
    );
    bytes.fill(0, DATA_PTR, dataEnd);
    assert.equal(
      imports.fd_read(fd, IOV_PTR, IOV_COUNT, BYTE_COUNT_PTR),
      FSErrno.SUCCESS,
    );
    assert.deepEqual(bytes.slice(DATA_PTR, dataEnd), payload);
    assert.equal(imports.fd_sync(fd), FSErrno.SUCCESS);
    assert.equal(imports.fd_datasync(fd), FSErrno.SUCCESS);
    assert.equal(backend.syncs, 2);
    backend.syncError = FSErrno.IO;
    assert.equal(imports.fd_sync(fd), FSErrno.IO);
    backend.writeError = FSErrno.NOSPC;
    view.setUint32(BYTE_COUNT_PTR, UNCHANGED_OUTPUT, true);
    assert.equal(
      imports.fd_write(fd, IOV_PTR, IOV_COUNT, BYTE_COUNT_PTR),
      FSErrno.NOSPC,
    );
    assert.equal(view.getUint32(BYTE_COUNT_PTR, true), UNCHANGED_OUTPUT);
    assert.equal(imports.fd_tell(fd, FILE_OFFSET_PTR), FSErrno.SUCCESS);
    assert.equal(
      view.getBigUint64(FILE_OFFSET_PTR, true),
      BigInt(payload.byteLength),
    );
    assert.equal(imports.fd_close(fd), FSErrno.SUCCESS);
    assert.equal(backend.closes, 1);

    const extracted = externalRequire("./out/opfs/index.js");
    const store = new MockOPFS().root;
    const opfs = await extracted.OPFSBackend.create(store, { spareFiles: 1 });
    const publicFS = externalRequire("uwasi/filesystem");
    assert.ok(opfs.fileSystem instanceof publicFS.MemoryFileSystem);
    const parent = opfs.fileSystem.lookup("/");
    const node = new publicFS.MemoryFileSystem().createFile(
      "/seed",
      new Uint8Array(),
    );
    assert.equal(opfs.createChild(parent, "persisted", node), FSErrno.SUCCESS);
    assert.equal(opfs.writeAt(node, new Uint8Array([42]), 0), FSErrno.SUCCESS);
    assert.equal(opfs.sync(node), FSErrno.SUCCESS);
    await opfs.close();
    const reopened = await extracted.OPFSBackend.create(store, {
      spareFiles: 1,
    });
    const data = new Uint8Array(1);
    assert.equal(
      reopened.readAt(reopened.fileSystem.lookup("/persisted"), data, 0),
      1,
    );
    assert.equal(data[0], 42);
    const { WASI } = externalRequire("uwasi");
    const extractedWasi = new WASI({
      features: [extracted.useOPFS({ withBackend: reopened })],
    });
    extractedWasi.setInstance({ exports: { memory } });
    const persistedName = new TextEncoder().encode("persisted");
    bytes.set(persistedName, PATH_PTR);
    assert.equal(
      extractedWasi.wasiImport.path_open(
        PREOPEN_FD,
        0,
        PATH_PTR,
        persistedName.byteLength,
        0,
        ALL_RIGHTS,
        ALL_RIGHTS,
        0,
        OPENED_FD_PTR,
      ),
      FSErrno.SUCCESS,
    );
    const extractedFd = view.getUint32(OPENED_FD_PTR, true);
    view.setUint32(IOV_LENGTH_PTR, data.byteLength, true);
    assert.equal(
      extractedWasi.wasiImport.fd_read(
        extractedFd,
        IOV_PTR,
        IOV_COUNT,
        BYTE_COUNT_PTR,
      ),
      FSErrno.SUCCESS,
    );
    assert.equal(view.getUint32(BYTE_COUNT_PTR, true), data.byteLength);
    assert.equal(bytes[DATA_PTR], data[0]);
    assert.equal(
      extractedWasi.wasiImport.fd_close(extractedFd),
      FSErrno.SUCCESS,
    );
    await reopened.close();

    const installedOPFS = externalRequire("uwasi/opfs");
    const packedBackend = await installedOPFS.OPFSBackend.create(store, {
      spareFiles: 1,
    });
    assert.equal(
      packedBackend.readAt(
        packedBackend.fileSystem.lookup("/persisted"),
        data,
        0,
      ),
      1,
    );
    assert.equal(data[0], 42);
    assert.equal(
      typeof installedOPFS.useOPFS({ withBackend: packedBackend }),
      "function",
    );
    await packedBackend.close();

    for (const mode of ["esm", "cjs"]) {
      await rm(join(installed, "lib", mode, "opfs"), { recursive: true });
      for (const suffix of ["js", "d.ts"]) {
        await rm(join(installed, "lib", mode, `features/opfs.${suffix}`));
      }
    }
    for (const mode of ["module", "commonjs"]) {
      const load =
        mode === "module" ? "await import('uwasi')" : "require('uwasi')";
      const control =
        mode === "module"
          ? "await assert.rejects(import('uwasi/opfs'), { code: 'ERR_MODULE_NOT_FOUND' });"
          : "assert.throws(() => require('uwasi/opfs'), { code: 'MODULE_NOT_FOUND' });";
      await t.test(`root works without installed OPFS files in ${mode}`, () => {
        assert.doesNotThrow(() =>
          execFileSync(
            process.execPath,
            [
              "--input-type=" + mode,
              "-e",
              `
          ${mode === "module" ? "import assert from 'node:assert/strict';" : "const assert = require('node:assert/strict');"}
          const { WASI, useAll } = ${load};
          const wasi = new WASI({ features: [useAll()] });
          const memory = new WebAssembly.Memory({ initial: 1 });
          wasi.setInstance({ exports: { memory } });
          assert.equal(wasi.wasiImport.fd_fdstat_get(0, 0), 0);
          ${control}
        `,
            ],
            { cwd: temp, encoding: "utf8", stdio: "pipe" },
          ),
        );
      });
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
