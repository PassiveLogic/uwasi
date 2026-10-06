import { OPFSBackend, useOPFS } from "uwasi/opfs";
import { MemoryFileSystem } from "uwasi/filesystem";
import { WASIAbi } from "../lib/esm/abi.js";
import { fsBackendContractSuite } from "./fs_backend_contract.mjs";
import { MockOPFS } from "./opfs_mock.mjs";
import {
  bindImports,
  sysCreate,
  sysOpen,
  sysWrite,
  sysReadText,
  sysClose,
  sysSync,
  sysDatasync,
  sysStat,
  sysMkdir,
  sysRename,
  sysUnlink,
} from "./syscall_harness.mjs";
import { describe, it } from "node:test";
import assert from "node:assert";

const ESUCCESS = 0;
const { WASI_ERRNO_NOENT: NOENT, WASI_ERRNO_NOSPC: NOSPC } = WASIAbi;

fsBackendContractSuite("opfs (mock store)", async () => {
  const backend = await OPFSBackend.create(new MockOPFS().root);
  const fs = backend.fileSystem;
  const nodes = new MemoryFileSystem();
  let serial = 0;
  return {
    backend,
    makeFileNode: (content = new Uint8Array(0)) =>
      nodes.createFile(`/scratch/f${serial++}`, content),
    makeDirNode: () => fs.ensureDir(`/scratch/d${serial++}`),
    cleanup: () => backend.close(),
  };
});

async function makeWorker(store, options = {}) {
  const backend = await OPFSBackend.create(store.root, options);
  return { backend, h: bindImports(backend, backend.fileSystem) };
}

function putFile(h, name, text) {
  const { errno, fd } = sysCreate(h, name);
  assert.strictEqual(errno, ESUCCESS, name);
  assert.strictEqual(sysWrite(h, fd, text).errno, ESUCCESS);
  assert.strictEqual(sysSync(h, fd), ESUCCESS);
  assert.strictEqual(sysClose(h, fd), ESUCCESS);
}

function assertFile(h, name, text) {
  const { errno, fd } = sysOpen(h, name);
  assert.strictEqual(errno, ESUCCESS, name);
  assert.deepStrictEqual(sysReadText(h, fd), { errno: ESUCCESS, text });
  assert.strictEqual(sysClose(h, fd), ESUCCESS);
}

describe("OPFS persistence", () => {
  it("creates, writes, reads and reopens through useOPFS", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    w.h.imports = useOPFS({ withBackend: w.backend })(
      {},
      new WASIAbi(),
      () => w.h.view,
    );
    putFile(w.h, "data.db", "hello opfs");
    assertFile(w.h, "data.db", "hello opfs");
    await w.backend.close();
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "data.db", "hello opfs");
    await fresh.backend.close();
  });

  it("sync and datasync survive a crash, unlike unsynced content", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    for (const [name, flush] of [
      ["sync", sysSync],
      ["datasync", sysDatasync],
    ]) {
      const { errno, fd } = sysCreate(w.h, name);
      assert.strictEqual(errno, ESUCCESS);
      assert.strictEqual(sysWrite(w.h, fd, name).errno, ESUCCESS);
      assert.strictEqual(flush(w.h, fd), ESUCCESS);
    }
    const unsynced = sysCreate(w.h, "unsynced");
    assert.strictEqual(unsynced.errno, ESUCCESS);
    assert.strictEqual(sysWrite(w.h, unsynced.fd, "lost").errno, ESUCCESS);
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "sync", "sync");
    assertFile(fresh.h, "datasync", "datasync");
    assertFile(fresh.h, "unsynced", "");
    await fresh.backend.close();
  });

  it("pending file sync returns NOSPC until settle materializes it", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store, { spareFiles: 1 });
    assert.strictEqual(sysCreate(w.h, "first").errno, ESUCCESS);
    const pending = sysCreate(w.h, "pending");
    assert.strictEqual(pending.errno, ESUCCESS);
    assert.strictEqual(sysWrite(w.h, pending.fd, "payload").errno, ESUCCESS);
    assert.strictEqual(sysSync(w.h, pending.fd), NOSPC);
    await w.backend.settle();
    assert.strictEqual(sysSync(w.h, pending.fd), ESUCCESS);
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "pending", "payload");
    await fresh.backend.close();
  });

  it("persistAll saves seeded content and close flushes later writes", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/seeded.txt", "from the embedder");
    await w.backend.persistAll();
    store.simulateCrash();

    const reopened = await makeWorker(store);
    assertFile(reopened.h, "seeded.txt", "from the embedder");
    const { errno, fd } = sysCreate(reopened.h, "closed.txt");
    assert.strictEqual(errno, ESUCCESS);
    assert.strictEqual(
      sysWrite(reopened.h, fd, "flushed on close").errno,
      ESUCCESS,
    );
    assert.strictEqual(sysClose(reopened.h, fd), ESUCCESS);
    await reopened.backend.close();
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "seeded.txt", "from the embedder");
    assertFile(fresh.h, "closed.txt", "flushed on close");
    await fresh.backend.close();
  });
});

describe("OPFS namespace and errors", () => {
  it("renames, replaces and unlinks across reopen", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    assert.strictEqual(sysMkdir(w.h, "dir"), ESUCCESS);
    putFile(w.h, "source", "new content");
    putFile(w.h, "dir/target", "old content");
    assert.strictEqual(sysRename(w.h, "source", "moved"), ESUCCESS);
    assert.strictEqual(sysRename(w.h, "moved", "dir/target"), ESUCCESS);
    store.simulateCrash();

    const reopened = await makeWorker(store);
    assert.strictEqual(sysStat(reopened.h, "source").errno, NOENT);
    assert.strictEqual(sysStat(reopened.h, "moved").errno, NOENT);
    assertFile(reopened.h, "dir/target", "new content");
    assert.strictEqual(sysUnlink(reopened.h, "dir/target"), ESUCCESS);
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assert.strictEqual(sysStat(fresh.h, "dir/target").errno, NOENT);
    assert.strictEqual(sysStat(fresh.h, "dir").errno, ESUCCESS);
    await fresh.backend.close();
  });

  it("failed metadata persistence returns errno and rolls back the live rename", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "source", "kept");
    const fault = store.injectFault({
      op: "flush",
      match: ".uwasi.meta.log",
      error: "QuotaExceededError",
    });
    assert.strictEqual(sysRename(w.h, "source", "target"), NOSPC);
    assert.strictEqual(fault.fired, 1);
    assert.strictEqual(sysStat(w.h, "target").errno, NOENT);
    assertFile(w.h, "source", "kept");
    store.clearFaults();
    await w.backend.close();
  });

  it("a physical short write returns NOSPC", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    const { errno, fd } = sysCreate(w.h, "file");
    assert.strictEqual(errno, ESUCCESS);
    const fault = store.injectFault({
      op: "write",
      match: ".uwasi.data.",
      short: 1,
    });
    assert.strictEqual(sysWrite(w.h, fd, "hello").errno, NOSPC);
    assert.strictEqual(fault.fired, 1);
    await w.backend.close();
  });

  for (const recovery of ["log", "snapshot"]) {
    it(`keeps plain and U+FEFF-prefixed filenames distinct through ${recovery}`, async () => {
      const store = new MockOPFS({ closeFlushes: false });
      const w = await makeWorker(store);
      assert.strictEqual(sysMkdir(w.h, "dir"), ESUCCESS);
      const files = [
        ["dir/name", "plain"],
        ["dir/\uFEFFname", "prefixed"],
      ];
      for (const [name, content] of files) putFile(w.h, name, content);
      if (recovery === "snapshot") await w.backend.persistAll();
      store.simulateCrash();

      const fresh = await makeWorker(store);
      for (const [name, content] of files) assertFile(fresh.h, name, content);
      await fresh.backend.close();
    });
  }

  it("rejects an unknown metadata format without changing the store", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "kept", "valuable content");
    await w.backend.close();
    const file = await store.root.getFileHandle(".uwasi.meta.log");
    const handle = await file.createSyncAccessHandle();
    handle.write(new TextEncoder().encode("FUTR"), { at: 0 });
    handle.flush();
    handle.close();
    const contents = () =>
      store
        .rootNames()
        .sort()
        .map((name) => [name, Array.from(store.durableContent(name))]);
    const before = contents();
    await assert.rejects(OPFSBackend.create(store.root), /does not understand/);
    assert.deepStrictEqual(contents(), before);
  });
});

describe("OPFS recovery", () => {
  it("a failed log reset loses no subsequent successful changes", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    putFile(w.h, "before", "BEFORE");
    const fault = store.injectFault({
      op: "write",
      match: ".uwasi.meta.log",
    });
    await w.backend.persistAll();
    assert.strictEqual(fault.fired, 1);
    putFile(w.h, "after", "AFTER");
    putFile(w.h, "later", "LATER");
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "before", "BEFORE");
    assertFile(fresh.h, "after", "AFTER");
    assertFile(fresh.h, "later", "LATER");
    await fresh.backend.close();
  });

  it("a torn final log record preserves earlier changes and logging resumes", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store);
    putFile(w.h, "kept", "KEPT");
    putFile(w.h, "torn", "TORN");
    store.simulateCrash();
    const file = await store.root.getFileHandle(".uwasi.meta.log");
    const handle = await file.createSyncAccessHandle();
    handle.truncate(handle.getSize() - 1);
    handle.flush();
    handle.close();

    const reopened = await makeWorker(store);
    assertFile(reopened.h, "kept", "KEPT");
    assert.strictEqual(sysStat(reopened.h, "torn").errno, NOENT);
    putFile(reopened.h, "later", "LATER");
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "kept", "KEPT");
    assertFile(fresh.h, "later", "LATER");
    assert.strictEqual(sysStat(fresh.h, "torn").errno, NOENT);
    await fresh.backend.close();
  });

  it("a failed unlink keeps its data file out of the spare pool", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const w = await makeWorker(store, { spareFiles: 1 });
    putFile(w.h, "victim", "OLD");
    const dataFile = store
      .rootNames()
      .find(
        (name) =>
          name.startsWith(".uwasi.data.") &&
          new TextDecoder().decode(store.durableContent(name)) === "OLD",
      );
    assert.ok(dataFile);
    const fault = store.injectFault({
      op: "write",
      match: ".uwasi.meta.log",
      short: 4,
    });
    assert.strictEqual(sysUnlink(w.h, "victim"), NOSPC);
    assert.strictEqual(fault.fired, 1);
    await w.backend.settle();
    putFile(w.h, "newcomer", "NEW");
    assert.deepStrictEqual(store.durableContent(dataFile), new Uint8Array(0));
    store.simulateCrash();

    const fresh = await makeWorker(store);
    assertFile(fresh.h, "newcomer", "NEW");
    assertFile(fresh.h, "victim", "");
    await fresh.backend.close();
  });
});

describe("MockOPFS durability", () => {
  it("reopen sees cached writes but a crash restores only flushed bytes", async () => {
    const store = new MockOPFS({ closeFlushes: false });
    const file = await store.root.getFileHandle("file", { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.write(new Uint8Array([1]), { at: 0 });
    handle.flush();
    handle.write(new Uint8Array([7, 8]), { at: 0 });
    handle.close();
    const reopened = await file.createSyncAccessHandle();
    const cached = new Uint8Array(reopened.getSize());
    reopened.read(cached, { at: 0 });
    assert.deepStrictEqual(Array.from(cached), [7, 8]);
    assert.deepStrictEqual(Array.from(store.durableContent("file")), [1]);
    reopened.close();
    store.simulateCrash();

    const freshFile = await store.root.getFileHandle("file");
    const fresh = await freshFile.createSyncAccessHandle();
    const durable = new Uint8Array(fresh.getSize());
    fresh.read(durable, { at: 0 });
    assert.deepStrictEqual(Array.from(durable), [1]);
    fresh.close();
  });
});
