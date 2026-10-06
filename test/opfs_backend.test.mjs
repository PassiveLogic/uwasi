import { OPFSBackend, useOPFS } from "uwasi/opfs";
import { WASIAbi } from "../lib/esm/abi.js";
import { fsBackendContractSuite } from "./fs_backend_contract.mjs";
import { MockOPFS } from "./opfs_mock.mjs";
import { UWS1_STORE } from "./fixtures/opfs-store-uws1.mjs";
import {
  bindImports,
  sysCreate,
  sysOpen,
  sysWrite,
  sysReadText,
  sysClose,
  sysSync,
  sysLink,
  sysStat,
  sysMkdir,
  sysRename,
  sysUnlink,
  sysSymlink,
  sysLstat,
} from "./syscall_harness.mjs";
import { describe, it } from "node:test";
import assert from "node:assert";

const ESUCCESS = 0;

// ---------------------------------------------------------------------------
// Sanity checks for the mock itself: the journal-lifecycle tests are only as
// strong as these semantics.
// ---------------------------------------------------------------------------
describe("MockOPFS semantics", () => {
  it("flushed writes survive a crash, unflushed writes do not", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.write(new Uint8Array([1, 2]), { at: 0 });
    handle.flush();
    handle.write(new Uint8Array([9, 9, 9]), { at: 2 });
    store.simulateCrash();
    assert.deepStrictEqual(
      Array.from(store.durableContent("f")),
      [1, 2],
      "only the flushed prefix must be durable",
    );
  });

  it("close() flushes; the lock is exclusive until released", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    await assert.rejects(
      () => file.createSyncAccessHandle(),
      (err) => err.name === "NoModificationAllowedError",
    );
    handle.write(new Uint8Array([7]), { at: 0 });
    handle.close();
    assert.deepStrictEqual(Array.from(store.durableContent("f")), [7]);
    const again = await file.createSyncAccessHandle();
    again.close();
  });

  it("a crash releases locks so a fresh worker can reacquire them", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    await file.createSyncAccessHandle();
    store.simulateCrash();
    // The fresh worker starts from a fresh root handle.
    const fresh = await store.root.getFileHandle("f");
    const handle = await fresh.createSyncAccessHandle();
    handle.close();
  });

  it("handles held by the crashed worker are dead, even for new operations", async () => {
    const store = new MockOPFS();
    const preCrashRoot = store.root;
    const file = await preCrashRoot.getFileHandle("f", { create: true });
    store.simulateCrash();
    // A dead worker cannot act anymore; anything it had scheduled fails.
    await assert.rejects(
      () => preCrashRoot.getFileHandle("g", { create: true }),
      (err) => err.name === "InvalidStateError",
    );
    await assert.rejects(
      () => file.createSyncAccessHandle(),
      (err) => err.name === "InvalidStateError",
    );
  });

  it("injectShortWrite makes exactly one matching write short", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    const injected = store.injectShortWrite("f", 2);
    assert.strictEqual(injected.fired, 0);
    assert.strictEqual(
      handle.write(new Uint8Array([1, 2, 3, 4]), { at: 0 }),
      2,
    );
    // The injection is consumed; the next write is whole again.
    assert.strictEqual(handle.write(new Uint8Array([9, 9]), { at: 2 }), 2);
    assert.strictEqual(injected.fired, 1);
    handle.close();
    assert.deepStrictEqual(Array.from(store.durableContent("f")), [1, 2, 9, 9]);
  });

  it("injectTruncateError makes exactly one matching truncate throw", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    handle.write(new Uint8Array([1, 2]), { at: 0 });
    const injected = store.injectTruncateError("f");
    assert.throws(
      () => handle.truncate(0),
      (err) => err.name === "QuotaExceededError",
    );
    // The failed truncate must not have touched the content.
    assert.strictEqual(handle.getSize(), 2);
    handle.truncate(0); // consumed: works again
    assert.strictEqual(injected.fired, 1);
    handle.close();
  });

  it("simulateCrash can keep the unflushed work of the handles it picks", async () => {
    const store = new MockOPFS();
    const handles = {};
    for (const name of ["kept", "lost"]) {
      const file = await store.root.getFileHandle(name, { create: true });
      handles[name] = await file.createSyncAccessHandle();
      handles[name].write(new Uint8Array([1, 2, 3]), { at: 0 });
      handles[name].flush();
      handles[name].truncate(1);
      handles[name].write(new Uint8Array([9]), { at: 4 });
    }
    const kept = store.simulateCrash({ persist: (path) => path === "/kept" });
    assert.deepStrictEqual(kept, ["/kept"]);
    assert.deepStrictEqual(
      Array.from(store.durableContent("kept")),
      [1, 0, 0, 0, 9],
      "every unflushed write and truncate of a picked handle survives",
    );
    assert.deepStrictEqual(Array.from(store.durableContent("lost")), [1, 2, 3]);
    // Locks are released either way.
    for (const name of ["kept", "lost"]) {
      const file = await store.root.getFileHandle(name);
      (await file.createSyncAccessHandle()).close();
    }
  });

  it("simulateCrash with a probability draws from the given random source", async () => {
    const store = new MockOPFS();
    for (const name of ["a", "b", "c"]) {
      const file = await store.root.getFileHandle(name, { create: true });
      const handle = await file.createSyncAccessHandle();
      handle.write(new Uint8Array([7]), { at: 0 });
    }
    const draws = [0.1, 0.9, 0.4];
    const kept = store.simulateCrash({
      persist: 0.5,
      random: () => draws.shift(),
    });
    assert.deepStrictEqual(kept, ["/a", "/c"]);
    assert.deepStrictEqual(
      ["a", "b", "c"].map((n) => store.durableContent(n).length),
      [1, 0, 1],
    );
  });

  it("closeFlushes: false makes close() only release; reopen or crash settles", async () => {
    const write = async (store, name, bytes) => {
      const file = await store.root.getFileHandle(name, { create: true });
      const handle = await file.createSyncAccessHandle();
      handle.write(new Uint8Array([1]), { at: 0 });
      handle.flush();
      handle.write(new Uint8Array(bytes), { at: 0 });
      handle.close();
    };
    const read = async (store, name) => {
      const file = await store.root.getFileHandle(name);
      const handle = await file.createSyncAccessHandle();
      const buffer = new Uint8Array(handle.getSize());
      handle.read(buffer, { at: 0 });
      handle.close();
      return Array.from(buffer);
    };
    const dropping = new MockOPFS({ closeFlushes: false });
    await write(dropping, "f", [7, 8]);
    assert.deepStrictEqual(Array.from(dropping.durableContent("f")), [1]);
    assert.deepStrictEqual(await read(dropping, "f"), [1], "dropped at reopen");

    const keeping = new MockOPFS({
      closeFlushes: false,
      keepReleased: (path) => path === "/kept",
    });
    await write(keeping, "kept", [7, 8]);
    await write(keeping, "lost", [7, 8]);
    assert.deepStrictEqual(keeping.simulateCrash(), ["/kept"]);
    assert.deepStrictEqual(Array.from(keeping.durableContent("kept")), [7, 8]);
    assert.deepStrictEqual(Array.from(keeping.durableContent("lost")), [1]);
  });

  it("removeEntry refuses locked files and missing names", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    await assert.rejects(
      () => store.root.removeEntry("f"),
      (err) => err.name === "NoModificationAllowedError",
    );
    handle.close();
    await store.root.removeEntry("f");
    await assert.rejects(
      () => store.root.removeEntry("f"),
      (err) => err.name === "NotFoundError",
    );
  });

  it("injectFault throws on the Nth match for K calls then disarms", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    const fault = store.injectFault({
      op: "write",
      match: "f",
      nth: 2,
      times: 2,
    });
    const bytes = new Uint8Array([1]);
    assert.strictEqual(handle.write(bytes, { at: 0 }), 1);
    for (let i = 0; i < 2; i++) {
      assert.throws(() => handle.write(bytes, { at: 1 }), {
        name: "QuotaExceededError",
      });
    }
    assert.strictEqual(handle.write(bytes, { at: 1 }), 1);
    assert.strictEqual(fault.fired, 2);
    assert.strictEqual(handle.getSize(), 2, "failed writes had no effect");
  });

  it("injectFault short writes and throwing flush/truncate/read/getSize", async () => {
    const store = new MockOPFS();
    const file = await store.root.getFileHandle("f", { create: true });
    const handle = await file.createSyncAccessHandle();
    store.injectFault({ op: "write", short: 1 });
    assert.strictEqual(handle.write(new Uint8Array([7, 8, 9]), { at: 0 }), 1);
    assert.strictEqual(handle.getSize(), 1);
    for (const [op, call] of [
      ["flush", () => handle.flush()],
      ["truncate", () => handle.truncate(0)],
      ["read", () => handle.read(new Uint8Array(1), { at: 0 })],
      ["getSize", () => handle.getSize()],
    ]) {
      store.injectFault({ op, match: /f$/ });
      assert.throws(call, { name: "QuotaExceededError" }, op);
      call();
    }
    assert.strictEqual(store.durableContent("f").length, 1);
  });

  it("injectFault rejects async calls and holdAsync parks them", async () => {
    const store = new MockOPFS();
    store.injectFault({ op: "getFileHandle", error: "NotAllowedError" });
    await assert.rejects(store.root.getFileHandle("g", { create: true }), {
      name: "NotAllowedError",
    });
    assert.deepStrictEqual(store.rootNames(), []);
    const file = await store.root.getFileHandle("g", { create: true });
    store.injectFault({ op: "createSyncAccessHandle" });
    await assert.rejects(file.createSyncAccessHandle(), {
      name: "QuotaExceededError",
    });
    store.injectFault({ op: "removeEntry" });
    await assert.rejects(store.root.removeEntry("g"));
    assert.deepStrictEqual(store.rootNames(), ["g"]);

    const gate = store.holdAsync({ op: "getFileHandle", match: "/h" });
    let done = false;
    const pending = store.root
      .getFileHandle("h", { create: true })
      .then(() => (done = true));
    await store.root.getFileHandle("other", { create: true });
    await gate.parked(1);
    assert.strictEqual(done, false);
    assert.ok(!store.rootNames().includes("h"), "parked call has no effect");
    gate.release();
    await pending;
    assert.ok(store.rootNames().includes("h"));
  });
});

// ---------------------------------------------------------------------------
// The OPFS backend must satisfy the same contract as the memory backend.
// ---------------------------------------------------------------------------
async function opfsFixture() {
  const store = new MockOPFS();
  const backend = await OPFSBackend.create(store.root);
  const fs = backend.fileSystem;
  let serial = 0;
  return {
    backend,
    makeFileNode: (content = new Uint8Array(0)) =>
      fs.createFile(`/scratch/f${serial++}`, content),
    makeDirNode: () => fs.ensureDir(`/scratch/d${serial++}`),
  };
}

fsBackendContractSuite("opfs (mock store)", opfsFixture);

// ---------------------------------------------------------------------------
// OPFS-specific behavior, driven through the shared syscall layer.
// ---------------------------------------------------------------------------
async function makeWorker(store, options = {}) {
  const backend = await OPFSBackend.create(store.root, options);
  return { backend, h: bindImports(backend, backend.fileSystem) };
}

describe("OPFSBackend", () => {
  it("a created and written file survives a clean shutdown and re-init", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    const { errno, fd } = sysCreate(w1.h, "data.db");
    assert.strictEqual(errno, ESUCCESS);
    assert.strictEqual(sysWrite(w1.h, fd, "hello opfs").errno, ESUCCESS);
    assert.strictEqual(sysSync(w1.h, fd), ESUCCESS);
    assert.strictEqual(sysClose(w1.h, fd), ESUCCESS);
    await w1.backend.close();

    const w2 = await makeWorker(store);
    const open2 = sysOpen(w2.h, "data.db");
    assert.strictEqual(
      open2.errno,
      ESUCCESS,
      "file must be visible after re-init",
    );
    assert.strictEqual(sysReadText(w2.h, open2.fd).text, "hello opfs");
    await w2.backend.close();
  });

  it("file creation is metadata-durable at syscall return, even on crash", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    assert.strictEqual(sysCreate(w1.h, "journal").errno, ESUCCESS);
    // No close, no settle: the worker dies right after path_open returned.
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const stat = sysStat(w2.h, "journal");
    assert.strictEqual(
      stat.errno,
      ESUCCESS,
      "creation must already be durable",
    );
    assert.strictEqual(stat.size, 0);
    await w2.backend.close();
  });

  it("directories and renames are metadata-durable across a crash", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    assert.strictEqual(sysMkdir(w1.h, "sub"), ESUCCESS);
    const { fd } = sysCreate(w1.h, "a");
    sysWrite(w1.h, fd, "payload");
    sysSync(w1.h, fd);
    sysClose(w1.h, fd);
    assert.strictEqual(sysRename(w1.h, "a", "sub/b"), ESUCCESS);
    store.simulateCrash();

    const w2 = await makeWorker(store);
    assert.strictEqual(sysStat(w2.h, "a").errno, WASIAbi.WASI_ERRNO_NOENT);
    const open2 = sysOpen(w2.h, "sub/b");
    assert.strictEqual(open2.errno, ESUCCESS);
    assert.strictEqual(sysReadText(w2.h, open2.fd).text, "payload");
    await w2.backend.close();
  });

  it("hard links are refused with NOTSUP", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    const { fd } = sysCreate(w.h, "orig");
    sysClose(w.h, fd);
    assert.strictEqual(
      sysLink(w.h, "orig", "alias"),
      WASIAbi.WASI_ERRNO_NOTSUP,
    );
    assert.strictEqual(sysStat(w.h, "alias").errno, WASIAbi.WASI_ERRNO_NOENT);
    await w.backend.close();
  });

  it("hard links to a seeded file no record names yet are refused too", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/seeded", "payload");
    assert.strictEqual(
      sysLink(w.h, "seeded", "alias"),
      WASIAbi.WASI_ERRNO_NOTSUP,
    );
    assert.strictEqual(sysStat(w.h, "alias").errno, WASIAbi.WASI_ERRNO_NOENT);
    assert.strictEqual(
      w.backend.fileSystem.lookup("/seeded").nlink,
      1,
      "a refused link is not counted",
    );
    await w.backend.close();
  });

  it("hard links to a symlink are refused, recorded or seeded", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    assert.strictEqual(sysSymlink(w.h, "target", "made"), ESUCCESS);
    // Seeded through the tree-builder: no record names it yet.
    w.backend.fileSystem.setNode("/seeded", {
      type: "symlink",
      target: "target",
    });
    for (const name of ["made", "seeded"]) {
      assert.strictEqual(
        sysLink(w.h, name, `${name}-alias`),
        WASIAbi.WASI_ERRNO_NOTSUP,
        name,
      );
      assert.strictEqual(
        sysLstat(w.h, `${name}-alias`).errno,
        WASIAbi.WASI_ERRNO_NOENT,
      );
      assert.strictEqual(sysLstat(w.h, name).nlink, 1, "not counted");
    }
    await w.backend.close();
  });

  it("an empty iovec past EOF does not grow a file", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    const h = w.h;
    // fd_write with one empty iovec at a cursor past the end.
    const file = sysCreate(h, "empty");
    assert.strictEqual(h.imports.fd_seek(file.fd, 100n, 0, 5000), ESUCCESS);
    assert.strictEqual(sysWrite(h, file.fd, "").errno, ESUCCESS);
    assert.strictEqual(sysStat(h, "empty").size, 0);
    // fd_pwrite with one empty iovec far past the end.
    assert.strictEqual(sysWrite(h, file.fd, "abc").errno, ESUCCESS);
    h.view.setUint32(256, 512, true);
    h.view.setUint32(260, 0, true);
    assert.strictEqual(
      h.imports.fd_pwrite(file.fd, 256, 1, 1000n, 4096),
      ESUCCESS,
    );
    assert.strictEqual(sysStat(h, "empty").size, 103);
    await w.backend.close();
  });

  it("listChildren order is stable across re-init", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    for (const name of ["bravo", "alpha", "charlie"]) {
      sysClose(w1.h, sysCreate(w1.h, name).fd);
    }
    const root1 = w1.backend.fileSystem.lookup("/");
    const order1 = w1.backend.listChildren(root1);
    await w1.backend.close();

    const w2 = await makeWorker(store);
    const root2 = w2.backend.fileSystem.lookup("/");
    assert.deepStrictEqual(w2.backend.listChildren(root2), order1);
    await w2.backend.close();
  });

  it("creates past the spare pool succeed, but fd_sync on them fails until settle()", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    // One synchronous burst, no event-loop turns: only one pre-created
    // spare can back a new file; the second create overdrafts.
    assert.strictEqual(sysCreate(w.h, "f0").errno, ESUCCESS);
    const f1 = sysCreate(w.h, "f1");
    assert.strictEqual(f1.errno, ESUCCESS, "creation itself must not fail");
    assert.strictEqual(sysWrite(w.h, f1.fd, "not yet durable").errno, ESUCCESS);
    assert.strictEqual(
      sysSync(w.h, f1.fd),
      WASIAbi.WASI_ERRNO_NOSPC,
      "sync must not claim durability before the physical file exists",
    );
    await w.backend.settle();
    assert.strictEqual(
      sysSync(w.h, f1.fd),
      ESUCCESS,
      "after the pool caught up, sync must really flush",
    );
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const reopened = sysOpen(w2.h, "f1");
    assert.strictEqual(reopened.errno, ESUCCESS);
    assert.strictEqual(sysReadText(w2.h, reopened.fd).text, "not yet durable");
    await w2.backend.close();
  });

  it("an overdrafted create is namespace-durable; unsynced content dies with a crash", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    assert.strictEqual(sysCreate(w.h, "f0").errno, ESUCCESS);
    const f1 = sysCreate(w.h, "f1");
    assert.strictEqual(f1.errno, ESUCCESS);
    assert.strictEqual(sysWrite(w.h, f1.fd, "vanishes").errno, ESUCCESS);
    // Crash before the materializer ever ran.
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const stat = sysStat(w2.h, "f1");
    assert.strictEqual(stat.errno, ESUCCESS, "the creation itself was durable");
    assert.strictEqual(
      stat.size,
      0,
      "content that was never fd_sync'd may be lost - but only that",
    );
    await w2.backend.close();
  });

  it("unlink recycles the physical file into the spare pool synchronously", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    // create -> unlink -> create in one burst: the delete-journal churn.
    for (let i = 0; i < 5; i++) {
      const { errno, fd } = sysCreate(w.h, "journal");
      assert.strictEqual(errno, ESUCCESS, `create #${i}`);
      assert.strictEqual(sysWrite(w.h, fd, `j${i}`).errno, ESUCCESS);
      assert.strictEqual(sysClose(w.h, fd), ESUCCESS);
      assert.strictEqual(sysUnlink(w.h, "journal"), ESUCCESS, `unlink #${i}`);
    }
    await w.backend.close();
  });

  it("foreign files in the store directory are left alone and stay invisible", async () => {
    const store = new MockOPFS();
    const foreign = await store.root.getFileHandle("foreign.bin", {
      create: true,
    });
    const fh = await foreign.createSyncAccessHandle();
    fh.write(new Uint8Array([42]), { at: 0 });
    fh.close();

    const w = await makeWorker(store);
    assert.strictEqual(
      sysStat(w.h, "foreign.bin").errno,
      WASIAbi.WASI_ERRNO_NOENT,
      "unmanaged files are not part of the guest namespace",
    );
    sysClose(w.h, sysCreate(w.h, "mine").fd);
    await w.backend.close();
    assert.deepStrictEqual(Array.from(store.durableContent("foreign.bin")), [
      42,
    ]);
  });

  it("files seeded through the MemoryFileSystem tree-builder become durable", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    w1.backend.fileSystem.addFile("/seeded.txt", "from the embedder");
    await w1.backend.persistAll();
    await w1.backend.close();

    const w2 = await makeWorker(store);
    const open2 = sysOpen(w2.h, "seeded.txt");
    assert.strictEqual(open2.errno, ESUCCESS);
    assert.strictEqual(sysReadText(w2.h, open2.fd).text, "from the embedder");
    await w2.backend.close();
  });

  it("reopening an overdrafted file does not rewrite the namespace record", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    sysClose(w.h, sysCreate(w.h, "f0").fd);
    const f1 = sysCreate(w.h, "f1");
    assert.strictEqual(f1.errno, ESUCCESS);
    assert.strictEqual(
      sysSync(w.h, f1.fd),
      WASIAbi.WASI_ERRNO_NOSPC,
      "f1 must still be overdrafted for this test to mean anything",
    );
    sysClose(w.h, f1.fd);

    const metaWrites = () =>
      store.opLog.filter(
        (e) => e.path.includes(".uwasi.meta.") && e.op === "flush",
      ).length;
    const before = metaWrites();
    for (let i = 0; i < 3; i++) {
      const reopened = sysOpen(w.h, "f1");
      assert.strictEqual(reopened.errno, ESUCCESS);
      sysClose(w.h, reopened.fd);
    }
    assert.strictEqual(
      metaWrites(),
      before,
      "a read-only open changed nothing",
    );
    await w.backend.close();
  });

  it("names shadowing Object.prototype members persist across re-init", async () => {
    const names = ["constructor", "__proto__", "toString", "hasOwnProperty"];
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    for (const name of names) {
      assert.strictEqual(sysStat(w1.h, name).errno, WASIAbi.WASI_ERRNO_NOENT);
      putFile(w1.h, name, `content of ${name}`);
    }
    assert.strictEqual(sysMkdir(w1.h, "valueOf"), ESUCCESS);
    putFile(w1.h, "valueOf/__proto__", "nested");
    await w1.backend.close();

    const w2 = await makeWorker(store);
    const root = w2.backend.fileSystem.lookup("/");
    assert.deepStrictEqual(
      w2.backend
        .listChildren(root)
        .filter((n) => n !== "dev")
        .sort(),
      [...names, "valueOf"].sort(),
    );
    for (const name of names) {
      const opened = sysOpen(w2.h, name);
      assert.strictEqual(opened.errno, ESUCCESS, `reopening ${name}`);
      assert.strictEqual(
        sysReadText(w2.h, opened.fd).text,
        `content of ${name}`,
      );
    }
    const nested = sysOpen(w2.h, "valueOf/__proto__");
    assert.strictEqual(nested.errno, ESUCCESS);
    assert.strictEqual(sysReadText(w2.h, nested.fd).text, "nested");
    await w2.backend.close();
  });
});

/** Name of the root-level data file whose durable bytes contain `text`. */
function findDataFileContaining(store, text) {
  for (const name of store.rootNames()) {
    const content = store.durableContent(name);
    if (content && new TextDecoder().decode(content).includes(text)) {
      return name;
    }
  }
  return null;
}

/** create + write + sync + close in one go; returns nothing, asserts all. */
function putFile(h, name, text) {
  const { errno, fd } = sysCreate(h, name);
  assert.strictEqual(errno, ESUCCESS, `creating ${name}`);
  assert.strictEqual(sysWrite(h, fd, text).errno, ESUCCESS);
  assert.strictEqual(sysSync(h, fd), ESUCCESS);
  assert.strictEqual(sysClose(h, fd), ESUCCESS);
}

describe("short and failed physical writes", () => {
  it("a short write on the data file surfaces as NOSPC from fd_write", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    const { errno, fd } = sysCreate(w.h, "f");
    assert.strictEqual(errno, ESUCCESS);
    const injected = store.injectShortWrite(".uwasi.data.", 1);
    assert.strictEqual(
      sysWrite(w.h, fd, "hello").errno,
      WASIAbi.WASI_ERRNO_NOSPC,
      "a partial write must never report success",
    );
    assert.strictEqual(injected.fired, 1);
    await w.backend.close();
  });

  it("a short write on the namespace record fails the create and rolls it back", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    const injected = store.injectShortWrite(".uwasi.meta.", 4);
    assert.strictEqual(
      sysCreate(w.h, "f").errno,
      WASIAbi.WASI_ERRNO_NOSPC,
      "an unrecorded create must not report success",
    );
    assert.strictEqual(injected.fired, 1);
    assert.strictEqual(
      sysStat(w.h, "f").errno,
      WASIAbi.WASI_ERRNO_NOENT,
      "the failed create must be rolled back",
    );
    await w.backend.close();
  });

  it("a short write while adopting a seeded file fails the open", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/seeded", "content");
    const injected = store.injectShortWrite(".uwasi.data.", 3);
    assert.strictEqual(
      sysOpen(w.h, "seeded").errno,
      WASIAbi.WASI_ERRNO_NOSPC,
      "truncated adopted content must not open as if intact",
    );
    assert.strictEqual(injected.fired, 1);
    await w.backend.close();
  });

  it("a spare returned after a failed adoption holds no partial content", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    w.backend.fileSystem.addFile("/seeded", "PARTIAL CONTENT");
    const injected = store.injectShortWrite(".uwasi.data.", 7);
    assert.strictEqual(sysOpen(w.h, "seeded").errno, WASIAbi.WASI_ERRNO_NOSPC);
    assert.strictEqual(injected.fired, 1);
    // The same spare backs the next file, with no I/O to clear it.
    const { errno, fd } = sysCreate(w.h, "fresh");
    assert.strictEqual(errno, ESUCCESS);
    assert.strictEqual(sysSync(w.h, fd), ESUCCESS, "backed by the spare");
    assert.strictEqual(sysStat(w.h, "fresh").size, 0);
    assert.strictEqual(sysReadText(w.h, fd).text, "");
    await w.backend.close();
  });

  it("persistAll rejects on a short write instead of silently dropping content", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/seeded", "content");
    const injected = store.injectShortWrite(".uwasi.data.", 3);
    await assert.rejects(() => w.backend.persistAll(), /short write/);
    assert.strictEqual(injected.fired, 1);
    await w.backend.close();
  });

  it("a failed namespace flush during unlink keeps the file visible", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "f", "data");
    const injected = store.injectShortWrite(".uwasi.meta.", 4);
    assert.strictEqual(sysUnlink(w.h, "f"), WASIAbi.WASI_ERRNO_NOSPC);
    assert.strictEqual(injected.fired, 1);
    // The unlink did not happen, so the name must still resolve. (Its
    // content may already have died - that is the documented crash
    // window of the unlink protocol, name -> empty file.)
    assert.strictEqual(sysStat(w.h, "f").errno, ESUCCESS);
    await w.backend.close();
  });

  it("a failing content destruction aborts the unlink with an errno, content intact", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "f", "precious");
    const dataFile = findDataFileContaining(store, "precious");
    assert.ok(dataFile, "the synced content must be durable somewhere");
    const injected = store.injectTruncateError(dataFile);
    assert.strictEqual(
      sysUnlink(w.h, "f"),
      WASIAbi.WASI_ERRNO_NOSPC,
      "unlink must fail cleanly when step 1 (content death) fails",
    );
    assert.strictEqual(injected.fired, 1);
    const reopened = sysOpen(w.h, "f");
    assert.strictEqual(reopened.errno, ESUCCESS);
    assert.strictEqual(sysReadText(w.h, reopened.fd).text, "precious");
    await w.backend.close();
  });
});

// ---------------------------------------------------------------------------
// Namespace record format and recovery.
// ---------------------------------------------------------------------------

/** Replace a root-level store file's durable bytes, as another worker could. */
async function writeStoreFile(store, name, bytes) {
  const file = await store.root.getFileHandle(name, { create: true });
  const handle = await file.createSyncAccessHandle();
  handle.truncate(0);
  handle.write(bytes, { at: 0 });
  handle.flush();
  handle.close();
}

function fnv1a(bytes, hash = 0x811c9dc5) {
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

describe("namespace record format", () => {
  it("a corrupt newest slot falls back to the older generation", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "first", "1");
    // The older slot keeps a full snapshot that records "first".
    await w.backend.persistAll();
    store.opLog.length = 0;
    // Opening a seeded file records it with a full snapshot.
    w.backend.fileSystem.addFile("/second", "2");
    sysClose(w.h, sysOpen(w.h, "second").fd);
    const newest = store.opLog
      .filter((e) => /\.uwasi\.meta\.[01]$/.test(e.path) && e.op === "flush")
      .pop()
      .path.slice(1);
    store.simulateCrash();

    const slot = store.durableContent(newest);
    slot[slot.byteLength - 1] ^= 0xff;
    await writeStoreFile(store, newest, slot);

    const w2 = await makeWorker(store);
    assert.strictEqual(sysReadText(w2.h, sysOpen(w2.h, "first").fd).text, "1");
    assert.strictEqual(
      sysStat(w2.h, "second").errno,
      WASIAbi.WASI_ERRNO_NOENT,
      "the change recorded only in the corrupt slot is lost, nothing else",
    );
    await w2.backend.close();
  });

  /** Every store file's durable bytes, by name. */
  function storeBytes(store) {
    return new Map(
      store.rootNames().map((name) => [name, store.durableContent(name)]),
    );
  }

  /** A store whose files hold "A" (synced) and that was closed cleanly. */
  async function closedStore() {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "a", "A");
    await w.backend.close();
    return store;
  }

  /**
   * Overwrite a slot with `body` under `magic`, checksum and all: over
   * the first 8 header bytes and the body, as every later format must.
   */
  async function writeVerifiedSlot(store, name, magic, body) {
    const slot = new Uint8Array(12 + body.byteLength);
    const view = new DataView(slot.buffer);
    slot.set(new TextEncoder().encode(magic), 0);
    view.setUint32(4, body.byteLength, true);
    view.setUint32(8, fnv1a(body, fnv1a(slot.subarray(0, 8))), true);
    slot.set(body, 12);
    await writeStoreFile(store, name, slot);
  }

  /** `bytes` with each `[offset, value]` patched in. */
  function patched(bytes, ...patches) {
    const copy = new Uint8Array(bytes);
    for (const [at, value] of patches) copy[at] = value;
    return copy;
  }

  /** Open `store` and expect "a" to read "A": the older slot was used. */
  async function assertOlderSlotUsed(store, what) {
    const fresh = await makeWorker(store);
    assert.strictEqual(
      sysReadText(fresh.h, sysOpen(fresh.h, "a").fd).text,
      "A",
      `${what}: the older slot is used`,
    );
    await fresh.backend.close();
  }

  /** A store whose two slots both name "a" (each open writes one). */
  async function twoSlotStore() {
    const store = new MockOPFS();
    for (const name of ["a", "b", null]) {
      const w = await makeWorker(store);
      if (name !== null) putFile(w.h, name, name.toUpperCase());
      await w.backend.close();
    }
    return store;
  }

  /** The newest slot: the one whose body (after the varint gen) is longer. */
  function slotsByAge(store) {
    const names = [".uwasi.meta.0", ".uwasi.meta.1"];
    const gen = (name) => {
      const bytes = store.durableContent(name);
      return bytes.byteLength < 13 ? -1 : bytes[12];
    };
    return names.sort((a, b) => gen(b) - gen(a));
  }

  async function assertRefusedUntouched(store) {
    const before = storeBytes(store);
    await assert.rejects(
      OPFSBackend.create(store.root),
      /does not understand/,
      "an unknown namespace format must not open as an empty store",
    );
    assert.deepStrictEqual(storeBytes(store), before, "the store was changed");
  }

  it("refuses to open a store whose snapshots are in an unknown format", async () => {
    const store = await closedStore();
    // A later format: same framing and a valid checksum, unknown magic.
    for (const name of [".uwasi.meta.0", ".uwasi.meta.1"]) {
      const slot = store.durableContent(name);
      if (slot.byteLength < 12) continue;
      await writeVerifiedSlot(store, name, "UWS3", slot.subarray(12));
    }
    await assertRefusedUntouched(store);
  });

  it("refuses an unknown newest slot even beside an older readable one", async () => {
    // The unknown slot may hold the newest state, so falling back to the
    // older one would silently roll the store back, and reclaim the data
    // files of every file created since as unreferenced.
    const store = await closedStore();
    const [newest] = slotsByAge(store);
    await writeVerifiedSlot(store, newest, "UWS9", new Uint8Array([1, 2, 3]));
    await assertRefusedUntouched(store);
  });

  it("refuses a slot in this format that verifies but does not decode", async () => {
    // The checksum covers the magic and length too, so no torn write can
    // pass for an intact slot: this one is corrupt or of a later format
    // that kept the magic, and may hold the newest namespace.
    const store = await twoSlotStore();
    const [newest] = slotsByAge(store);
    await writeVerifiedSlot(store, newest, "UWS2", new Uint8Array([1, 9]));
    await assertRefusedUntouched(store);
  });

  it("a slot whose length changed does not verify", async () => {
    // A header torn over another slot's body: the checksum covers the
    // header, so the slot is torn.
    const store = await twoSlotStore();
    const [newest] = slotsByAge(store);
    const slot = store.durableContent(newest);
    await writeStoreFile(store, newest, patched(slot, [4, 1]));
    await assertOlderSlotUsed(store, "length");
  });

  it("refuses a slot whose magic is unknown, however its checksum fares", async () => {
    // A write of a known magic, torn or not, leaves a known magic or
    // zeros (see `decodeSnapshot`), so any other magic is not a tear.
    const store = await twoSlotStore();
    const [newest] = slotsByAge(store);
    const slot = store.durableContent(newest);
    await writeStoreFile(store, newest, patched(slot, [3, 0x33])); // "UWS3"
    await assertRefusedUntouched(store);
  });

  /**
   * A slot as earlier builds of this backend wrote it: "UWM1", length,
   * FNV-1a of the body alone, then a JSON namespace.
   */
  function earlierSlot(payload) {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const slot = new Uint8Array(12 + body.byteLength);
    const view = new DataView(slot.buffer);
    slot.set(new TextEncoder().encode("UWM1"), 0);
    view.setUint32(4, body.byteLength, true);
    view.setUint32(8, fnv1a(body), true);
    slot.set(body, 12);
    return slot;
  }

  it("refuses a store an earlier build wrote, untouched", async () => {
    // Its JSON namespace is not read, so opening the store as empty would
    // reclaim the data files of every file it names.
    for (const older of [null, { gen: 6, next: 1, root: { d: {} } }]) {
      const store = new MockOPFS();
      const encoder = new TextEncoder();
      await writeStoreFile(store, ".uwasi.data.0", encoder.encode("A"));
      await writeStoreFile(store, ".uwasi.data.1", encoder.encode("B"));
      await writeStoreFile(
        store,
        ".uwasi.meta.0",
        older ? earlierSlot(older) : new Uint8Array(0),
      );
      await writeStoreFile(
        store,
        ".uwasi.meta.1",
        earlierSlot({
          gen: 7,
          next: 2,
          root: { d: { a: { f: 0 }, sub: { d: { b: { f: 1 } } } } },
        }),
      );
      const before = storeBytes(store);
      await assert.rejects(
        OPFSBackend.create(store.root),
        /does not understand \(magic "UWM1", the JSON namespace of an earlier build/,
      );
      assert.deepStrictEqual(storeBytes(store), before, "the store changed");
    }
  });

  it("refuses a store the previous binary format wrote, untouched", async () => {
    // That format kept the magics this one replaced, with checksums that
    // do not cover them. Taking its slots for torn writes would open the
    // store as empty and reclaim the data files of every file it names.
    const store = new MockOPFS();
    for (const [name, base64] of Object.entries(UWS1_STORE)) {
      await writeStoreFile(store, name, Buffer.from(base64, "base64"));
    }
    const before = storeBytes(store);
    await assert.rejects(
      OPFSBackend.create(store.root),
      /does not understand \(magic "UWS1", the binary namespace of an earlier build/,
    );
    assert.deepStrictEqual(storeBytes(store), before, "the store changed");
  });

  it("takes a slot whose magic is partly zero and does not verify as torn", async () => {
    const store = await twoSlotStore();
    const [newest] = slotsByAge(store);
    const slot = store.durableContent(newest);
    await writeStoreFile(store, newest, patched(slot, [2, 0], [3, 0]));
    await assertOlderSlotUsed(store, "UW\\0\\0");
  });

  it("nested directories, renames and symlinks survive re-init in order", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    assert.strictEqual(sysMkdir(w1.h, "a"), ESUCCESS);
    assert.strictEqual(sysMkdir(w1.h, "a/b"), ESUCCESS);
    putFile(w1.h, "a/b/deep", "deep");
    putFile(w1.h, "a/top", "top");
    putFile(w1.h, "zeta", "z");
    putFile(w1.h, "alpha", "alpha");
    assert.strictEqual(sysRename(w1.h, "a", "renamed"), ESUCCESS);
    assert.strictEqual(sysRename(w1.h, "zeta", "renamed/b/zeta"), ESUCCESS);
    assert.strictEqual(sysRename(w1.h, "alpha", "omega"), ESUCCESS);
    const fs1 = w1.backend.fileSystem;
    const order = (fs, path) => w1.backend.listChildren(fs.lookup(path));
    const rootOrder = order(fs1, "/");
    const innerOrder = order(fs1, "/renamed/b");
    await w1.backend.close();

    const w2 = await makeWorker(store);
    const fs2 = w2.backend.fileSystem;
    assert.deepStrictEqual(w2.backend.listChildren(fs2.lookup("/")), rootOrder);
    assert.deepStrictEqual(
      w2.backend.listChildren(fs2.lookup("/renamed/b")),
      innerOrder,
    );
    for (const [path, text] of [
      ["renamed/b/deep", "deep"],
      ["renamed/b/zeta", "z"],
      ["renamed/top", "top"],
      ["omega", "alpha"],
    ]) {
      const opened = sysOpen(w2.h, path);
      assert.strictEqual(opened.errno, ESUCCESS, path);
      assert.strictEqual(sysReadText(w2.h, opened.fd).text, text, path);
    }
    assert.strictEqual(sysStat(w2.h, "a").errno, WASIAbi.WASI_ERRNO_NOENT);
    await w2.backend.close();
  });
});

const LOG = ".uwasi.meta.log";

function metaWrites(store, path) {
  return store.opLog.filter((e) => e.op === "write" && e.path === `/${path}`);
}

/** path_open of a directory: every right but FD_WRITE, all to inherit. */
function sysOpenDir(h, name, dirfd = 3) {
  const path = new TextEncoder().encode(name);
  h.bytes.set(path, 0);
  const rights = BigInt((1 << 30) - 1) & ~(1n << 6n); // FD_WRITE
  const errno = h.imports.path_open(
    dirfd,
    0,
    0,
    path.length,
    WASIAbi.WASI_OFLAGS_DIRECTORY,
    rights,
    BigInt((1 << 30) - 1),
    0,
    4096,
  );
  return { errno, fd: h.view.getUint32(4096, true) };
}

describe("namespace change log", () => {
  // A guest can still change a directory it removed, through an fd it
  // holds open, and move things out of it again. A compaction drops the
  // detached directory from the record, so no later record may name it.
  for (const via of ["created in it", "moved into it"]) {
    it(`a file ${via} after its directory was removed, then renamed out, survives a crash`, async () => {
      const store = new MockOPFS();
      const w = await makeWorker(store, { spareFiles: 4 });
      for (const dir of ["x", "y"]) {
        assert.strictEqual(sysMkdir(w.h, dir), ESUCCESS);
      }
      const x = sysOpenDir(w.h, "x");
      assert.strictEqual(x.errno, ESUCCESS);
      const encoder = new TextEncoder();
      w.h.bytes.set(encoder.encode("x"), 0);
      assert.strictEqual(w.h.imports.path_remove_directory(3, 0, 1), ESUCCESS);
      // The file to rescue, in "x" itself or in "y" moved into "x".
      let from = x.fd;
      if (via === "moved into it") {
        w.h.bytes.set(encoder.encode("y"), 0);
        w.h.bytes.set(encoder.encode("y"), 128);
        assert.strictEqual(w.h.imports.path_rename(3, 0, 1, x.fd, 128, 1), 0);
        const y = sysOpenDir(w.h, "y", x.fd);
        assert.strictEqual(y.errno, ESUCCESS);
        from = y.fd;
        await w.backend.persistAll(); // compacts: "y" is out of the tree
      }
      const inner = sysCreate(w.h, "a", from);
      assert.strictEqual(inner.errno, ESUCCESS);
      assert.strictEqual(sysWrite(w.h, inner.fd, "DETACHED").errno, ESUCCESS);
      assert.strictEqual(sysSync(w.h, inner.fd), ESUCCESS);
      await w.backend.persistAll(); // compacts
      w.h.bytes.set(encoder.encode("a"), 0);
      w.h.bytes.set(encoder.encode("b"), 128);
      assert.strictEqual(w.h.imports.path_rename(from, 0, 1, 3, 128, 1), 0);
      assert.strictEqual(sysStat(w.h, "b").errno, ESUCCESS);
      store.simulateCrash();
      const fresh = await makeWorker(store);
      const b = sysOpen(fresh.h, "b");
      assert.strictEqual(b.errno, ESUCCESS, "the rename was durable");
      assert.strictEqual(sysReadText(fresh.h, b.fd).text, "DETACHED");
      await fresh.backend.close();
    });
  }

  it("compacts once the log outgrows its threshold (test-only override)", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 4 });
    // Not an option: an internal knob that lets tests reach compaction
    // without writing 64 KiB of records.
    w.backend.compactAt = { minBytes: 0, ratio: 0 };
    store.opLog.length = 0;
    putFile(w.h, "a", "A");
    assert.ok(
      metaWrites(store, ".uwasi.meta.0").length +
        metaWrites(store, ".uwasi.meta.1").length >
        0,
      "an append past the threshold compacts",
    );
    assert.strictEqual(sysMkdir(w.h, "d"), ESUCCESS);
    assert.strictEqual(sysRename(w.h, "a", "d/b"), ESUCCESS);
    store.simulateCrash();
    const fresh = await makeWorker(store);
    assert.strictEqual(
      sysReadText(fresh.h, sysOpen(fresh.h, "d/b").fd).text,
      "A",
    );
    await fresh.backend.close();
  });

  /** Open, change, crash: a store whose log holds `names`' creates. */
  async function loggedStore(...names) {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    for (const name of names) sysClose(w.h, sysCreate(w.h, name).fd);
    store.simulateCrash();
    return store;
  }

  async function assertLogRefusedUntouched(store, why = /does not understand/) {
    const before = new Map(
      store.rootNames().map((name) => [name, store.durableContent(name)]),
    );
    await assert.rejects(OPFSBackend.create(store.root), why);
    assert.deepStrictEqual(
      new Map(
        store.rootNames().map((name) => [name, store.durableContent(name)]),
      ),
      before,
      "the store was changed",
    );
  }

  /** Re-seal a log header: FNV-1a over the magic, then the generation. */
  function sealLogHeader(log) {
    const view = new DataView(log.buffer, log.byteOffset);
    view.setUint32(
      4,
      fnv1a(log.subarray(8, 16), fnv1a(log.subarray(0, 4))),
      true,
    );
    return log;
  }

  /** `log` plus a frame of `body` that verifies at its end. */
  function withFrame(log, body) {
    const seed = new Uint8Array(8);
    const seedView = new DataView(seed.buffer);
    seedView.setUint32(
      0,
      new DataView(log.buffer, log.byteOffset).getUint32(8, true),
      true,
    );
    seedView.setUint32(4, log.byteLength, true);
    const frame = new Uint8Array(8 + body.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, body.byteLength, true);
    view.setUint32(4, fnv1a(body, fnv1a(seed)), true);
    frame.set(body, 8);
    const out = new Uint8Array(log.byteLength + frame.byteLength);
    out.set(log, 0);
    out.set(frame, log.byteLength);
    return out;
  }

  it("refuses to open a store whose log is in an unknown format", async () => {
    const store = await loggedStore("a");
    // A later log format: the header's checksum verifies, its magic is new.
    const log = store.durableContent(LOG);
    log.set(new TextEncoder().encode("UWL3"), 0);
    await writeStoreFile(store, LOG, sealLogHeader(log));
    await assertLogRefusedUntouched(store);
  });

  it("refuses a log whose magic is unknown, however its checksum fares", async () => {
    const store = await loggedStore("a");
    const log = store.durableContent(LOG);
    log[3] = 0x33; // "UWL3", the checksum left as it was
    await writeStoreFile(store, LOG, log);
    await assertLogRefusedUntouched(store);
  });

  it("refuses the log of the previous binary format", async () => {
    // Its header check does not cover the magic, so under this version's
    // check it would pass for torn and be reset, losing its changes.
    const store = await loggedStore("a");
    const log = Buffer.from(UWS1_STORE[LOG], "base64");
    await writeStoreFile(store, LOG, log);
    await assertLogRefusedUntouched(
      store,
      /does not understand \(magic "UWL1", the change log of an earlier build/,
    );
  });

  it("ignores a log whose header checksum fails over its magic", async () => {
    // The checksum covers the magic: a zeroed magic byte is a tear.
    const store = await loggedStore("a");
    const log = store.durableContent(LOG);
    log[3] = 0;
    await writeStoreFile(store, LOG, log);
    const fresh = await makeWorker(store);
    assert.strictEqual(sysStat(fresh.h, "a").errno, WASIAbi.WASI_ERRNO_NOENT);
    await fresh.backend.close();
  });

  // A frame that verifies was written whole at its offset in this log, so
  // one that does not decode is not a tear. Ending replay there would lose
  // the changes after it for good, as the open compacts.
  for (const [what, body] of [
    ["an unknown op", [99, 0, 1, 0x61]],
    ["trailing bytes", [4, 0, 1, 0x61, 0]], // REMOVE 0 "a", then a 0
    ["a truncated record", [4, 0, 5, 0x61]],
  ]) {
    it(`refuses a log with a frame that verifies but holds ${what}`, async () => {
      const store = await loggedStore("a");
      const log = withFrame(store.durableContent(LOG), new Uint8Array(body));
      await writeStoreFile(store, LOG, log);
      await assertLogRefusedUntouched(store);
    });
  }

  it("a data file logged under a second live name never aliases the first", async () => {
    // The backend never logs this; replay must still not share the bytes.
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "a", "A-CONTENT");
    store.simulateCrash();
    const id = Number(
      findDataFileContaining(store, "A-CONTENT").slice(".uwasi.data.".length),
    );
    assert.ok(id < 0x80, "a one-byte varint keeps the record simple");
    const file = [2, 0, 1, 0x62, id]; // FILE 0 "b" <id>
    const log = withFrame(store.durableContent(LOG), new Uint8Array(file));
    await writeStoreFile(store, LOG, log);
    const fresh = await makeWorker(store);
    assert.strictEqual(
      sysReadText(fresh.h, sysOpen(fresh.h, "b").fd).text,
      "A-CONTENT",
    );
    assert.strictEqual(sysStat(fresh.h, "a").size, 0, "a is left empty");
    await fresh.backend.close();
  });

  it("a verified frame appended by hand replays", async () => {
    // The helpers above build frames as the backend does.
    const store = await loggedStore("a", "b");
    const remove = [4, 0, 1, 0x61]; // REMOVE 0 "a"
    const log = withFrame(store.durableContent(LOG), new Uint8Array(remove));
    await writeStoreFile(store, LOG, log);
    const fresh = await makeWorker(store);
    assert.strictEqual(sysStat(fresh.h, "a").errno, WASIAbi.WASI_ERRNO_NOENT);
    assert.strictEqual(sysStat(fresh.h, "b").errno, ESUCCESS);
    await fresh.backend.close();
  });

  it("namespace changes append small records instead of rewriting the tree", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    store.opLog.length = 0;
    for (let i = 0; i < 300; i++) {
      const { errno, fd } = sysCreate(w.h, `object-${i}`);
      assert.strictEqual(errno, ESUCCESS);
      sysClose(w.h, fd);
    }
    const appends = metaWrites(store, LOG);
    assert.strictEqual(appends.length, 300, "one append per create");
    assert.ok(
      appends.every((e) => e.length < 64),
      "each append holds one record",
    );
    assert.strictEqual(
      metaWrites(store, ".uwasi.meta.0").length +
        metaWrites(store, ".uwasi.meta.1").length,
      0,
      "no snapshot below the compaction threshold",
    );
    await w.backend.close();
  });

  it("logged changes survive a crash", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    assert.strictEqual(sysMkdir(w1.h, "dir"), ESUCCESS);
    putFile(w1.h, "dir/kept", "kept");
    putFile(w1.h, "moved", "moved");
    putFile(w1.h, "gone", "gone");
    assert.strictEqual(sysRename(w1.h, "moved", "dir/arrived"), ESUCCESS);
    assert.strictEqual(sysUnlink(w1.h, "gone"), ESUCCESS);
    store.simulateCrash();

    const w2 = await makeWorker(store);
    assert.strictEqual(
      sysReadText(w2.h, sysOpen(w2.h, "dir/kept").fd).text,
      "kept",
    );
    assert.strictEqual(
      sysReadText(w2.h, sysOpen(w2.h, "dir/arrived").fd).text,
      "moved",
    );
    assert.strictEqual(sysStat(w2.h, "moved").errno, WASIAbi.WASI_ERRNO_NOENT);
    assert.strictEqual(sysStat(w2.h, "gone").errno, WASIAbi.WASI_ERRNO_NOENT);
    await w2.backend.close();
  });

  it("a torn final record loses only that change, and logging resumes", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    sysClose(w1.h, sysCreate(w1.h, "a").fd);
    sysClose(w1.h, sysCreate(w1.h, "b").fd);
    store.simulateCrash();
    const log = store.durableContent(LOG);
    await writeStoreFile(store, LOG, log.subarray(0, log.byteLength - 1));

    const w2 = await makeWorker(store);
    assert.strictEqual(sysStat(w2.h, "a").errno, ESUCCESS);
    assert.strictEqual(sysStat(w2.h, "b").errno, WASIAbi.WASI_ERRNO_NOENT);
    sysClose(w2.h, sysCreate(w2.h, "c").fd);
    store.simulateCrash();

    const w3 = await makeWorker(store);
    assert.strictEqual(sysStat(w3.h, "a").errno, ESUCCESS);
    assert.strictEqual(sysStat(w3.h, "c").errno, ESUCCESS);
    await w3.backend.close();
  });

  it("a log whose header does not verify is ignored", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    putFile(w1.h, "snapshotted", "s");
    await w1.backend.close();
    const w2 = await makeWorker(store);
    sysClose(w2.h, sysCreate(w2.h, "logged").fd);
    store.simulateCrash();
    const log = store.durableContent(LOG);
    log[8] ^= 0x01; // the generation the log claims to build on
    await writeStoreFile(store, LOG, log);

    const w3 = await makeWorker(store);
    assert.strictEqual(sysStat(w3.h, "snapshotted").errno, ESUCCESS);
    assert.strictEqual(sysStat(w3.h, "logged").errno, WASIAbi.WASI_ERRNO_NOENT);
    await w3.backend.close();
  });

  it("compaction folds the log into a snapshot and loses nothing", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store, { spareFiles: 1 });
    store.opLog.length = 0;
    const count = 2000;
    for (let i = 0; i < count; i++) {
      const name = `objects-${String(i).padStart(4, "0")}-${"x".repeat(32)}`;
      sysClose(w1.h, sysCreate(w1.h, name).fd);
    }
    assert.ok(
      metaWrites(store, ".uwasi.meta.0").length +
        metaWrites(store, ".uwasi.meta.1").length >
        0,
      "the log must have been compacted at least once",
    );
    assert.ok(
      store.opLog.some(
        (e) => e.path === `/${LOG}` && e.op === "truncate" && e.size === 16,
      ),
      "compaction must reset the log to its header",
    );
    await w1.backend.settle();
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const root = w2.backend.fileSystem.lookup("/");
    const names = w2.backend.listChildren(root).filter((n) => n !== "dev");
    assert.strictEqual(names.length, count);
    assert.strictEqual(names[0], `objects-0000-${"x".repeat(32)}`);
    assert.strictEqual(names[count - 1], `objects-1999-${"x".repeat(32)}`);
    await w2.backend.close();
  });

  it("a recycled data-file id maps to its newest name after replay", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store, { spareFiles: 1 });
    putFile(w1.h, "first", "FIRST");
    const id = findDataFileContaining(store, "FIRST");
    assert.strictEqual(sysUnlink(w1.h, "first"), ESUCCESS);
    putFile(w1.h, "second", "SECOND");
    assert.strictEqual(
      findDataFileContaining(store, "SECOND"),
      id,
      "the unlinked file's data file is reused",
    );
    store.simulateCrash();

    const w2 = await makeWorker(store);
    assert.strictEqual(sysStat(w2.h, "first").errno, WASIAbi.WASI_ERRNO_NOENT);
    assert.strictEqual(
      sysReadText(w2.h, sysOpen(w2.h, "second").fd).text,
      "SECOND",
    );
    await w2.backend.close();
  });

  it("a failed unlink never lets its name alias the recycled data file", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store, { spareFiles: 1 });
    putFile(w1.h, "victim", "OLD");
    const injected = store.injectShortWrite(".uwasi.meta.", 4);
    assert.strictEqual(sysUnlink(w1.h, "victim"), WASIAbi.WASI_ERRNO_NOSPC);
    assert.strictEqual(injected.fired, 1);
    // The content died in step 1. The record still names its data file,
    // so the file stays out of the pool: the next create gets another.
    await w1.backend.settle();
    putFile(w1.h, "newcomer", "NEW");
    store.simulateCrash();

    const w2 = await makeWorker(store);
    assert.strictEqual(
      sysReadText(w2.h, sysOpen(w2.h, "newcomer").fd).text,
      "NEW",
    );
    const victim = sysStat(w2.h, "victim");
    assert.strictEqual(victim.errno, ESUCCESS, "the unlink did not happen");
    assert.strictEqual(victim.size, 0, "but its content is gone, not NEW");
    await w2.backend.close();
  });

  it("an unlink recorded in the log frees its data file at once", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    putFile(w.h, "first", "FIRST");
    await w.backend.settle();
    assert.strictEqual(sysUnlink(w.h, "first"), ESUCCESS);
    // One spare from the refill, one from the unlink: neither create
    // overdrafts, so both sync at once, before any settle().
    putFile(w.h, "second", "SECOND");
    putFile(w.h, "third", "THIRD");
    await w.backend.close();
  });

  it("a failed log reset falls back to snapshots without losing changes", async () => {
    const store = new MockOPFS();
    const w1 = await makeWorker(store);
    const injected = store.injectTruncateError(LOG);
    await w1.backend.persistAll();
    assert.strictEqual(injected.fired, 1);
    store.opLog.length = 0;
    sysClose(w1.h, sysCreate(w1.h, "after").fd);
    assert.ok(
      metaWrites(store, ".uwasi.meta.0").length +
        metaWrites(store, ".uwasi.meta.1").length >
        0,
      "a change over a stale log is recorded by a full snapshot",
    );
    assert.deepStrictEqual(
      metaWrites(store, LOG).map((e) => [e.at, e.length]),
      [[0, 16]],
      "the stale log takes no append, only the retried reset",
    );
    store.opLog.length = 0;
    sysClose(w1.h, sysCreate(w1.h, "later").fd);
    assert.strictEqual(
      metaWrites(store, LOG)[0].at,
      16,
      "once reset, changes append again",
    );
    store.simulateCrash();

    const w2 = await makeWorker(store);
    assert.strictEqual(sysStat(w2.h, "after").errno, ESUCCESS);
    assert.strictEqual(sysStat(w2.h, "later").errno, ESUCCESS);
    await w2.backend.close();
  });

  it("later directory sync cannot publish a failed snapshot and discard newer log entries", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 2 });
    sysClose(w.h, sysCreate(w.h, "before").fd);
    // The snapshot is complete in its slot when the truncate fails.
    const injected = store.injectTruncateError(".uwasi.meta.");
    await assert.rejects(w.backend.persistAll());
    assert.strictEqual(injected.fired, 1);
    const later = sysCreate(w.h, "after");
    assert.strictEqual(later.errno, ESUCCESS);
    assert.strictEqual(sysWrite(w.h, later.fd, "AFTER").errno, ESUCCESS);
    assert.strictEqual(sysSync(w.h, later.fd), ESUCCESS);
    assert.strictEqual(sysSync(w.h, 3), ESUCCESS); // the preopen directory
    store.simulateCrash();
    const fresh = await makeWorker(store);
    assert.strictEqual(sysStat(fresh.h, "before").errno, ESUCCESS);
    const opened = sysOpen(fresh.h, "after");
    assert.strictEqual(opened.errno, ESUCCESS);
    assert.strictEqual(sysReadText(fresh.h, opened.fd).text, "AFTER");
    await fresh.backend.close();
  });

  // Every point at which a snapshot or the log reset after it can fail.
  // Whatever a slot or the log is left holding, possibly made durable by
  // the next directory sync, recovery must show every later change.
  const SLOT = /\.uwasi\.meta\.[01]$/;
  const LOG_PATH = /\.uwasi\.meta\.log$/;
  for (const [what, fault, persistFails] of [
    ["snapshot write", { op: "write", match: SLOT }, true],
    ["short snapshot write", { op: "write", match: SLOT, short: 5 }, true],
    ["snapshot truncate", { op: "truncate", match: SLOT }, true],
    ["snapshot flush", { op: "flush", match: SLOT }, true],
    ["log reset write", { op: "write", match: LOG_PATH }, false],
    [
      "short log reset write",
      { op: "write", match: LOG_PATH, short: 3 },
      false,
    ],
    ["log reset truncate", { op: "truncate", match: LOG_PATH }, false],
    ["log reset flush", { op: "flush", match: LOG_PATH }, false],
  ]) {
    it(`a failed ${what} loses no change made after it`, async () => {
      const store = new MockOPFS();
      const w = await makeWorker(store, { spareFiles: 4 });
      sysClose(w.h, sysCreate(w.h, "before").fd);
      const armed = store.injectFault(fault);
      if (persistFails) {
        await assert.rejects(w.backend.persistAll());
      } else {
        await w.backend.persistAll();
      }
      assert.strictEqual(armed.fired, 1);
      assert.strictEqual(sysMkdir(w.h, "dir"), ESUCCESS);
      putFile(w.h, "dir/after", "AFTER");
      assert.strictEqual(sysRename(w.h, "before", "dir/moved"), ESUCCESS);
      putFile(w.h, "last", "LAST");
      assert.strictEqual(sysSync(w.h, 3), ESUCCESS);
      store.simulateCrash();

      const fresh = await makeWorker(store);
      const root = fresh.backend.fileSystem.lookup("/");
      const dir = fresh.backend.fileSystem.lookup("/dir");
      assert.deepStrictEqual(
        fresh.backend.listChildren(root).filter((n) => n !== "dev"),
        ["dir", "last"],
      );
      assert.deepStrictEqual(fresh.backend.listChildren(dir), [
        "after",
        "moved",
      ]);
      const after = sysOpen(fresh.h, "dir/after");
      assert.strictEqual(sysReadText(fresh.h, after.fd).text, "AFTER");
      await fresh.backend.close();
    });
  }

  it("a clean close does not publish a snapshot that failed", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    sysClose(w.h, sysCreate(w.h, "kept").fd);
    w.backend.fileSystem.addFile("/seeded", "payload");
    // Renaming an unrecorded file takes a snapshot, which already holds
    // the rename when its flush fails.
    const fault = store.injectFault({ op: "flush", match: SLOT });
    assert.notStrictEqual(sysRename(w.h, "seeded", "renamed"), ESUCCESS);
    assert.strictEqual(fault.fired, 1);
    await w.backend.close();
    const fresh = await makeWorker(store);
    assert.strictEqual(sysStat(fresh.h, "kept").errno, ESUCCESS);
    assert.strictEqual(
      sysStat(fresh.h, "renamed").errno,
      WASIAbi.WASI_ERRNO_NOENT,
      "the failed rename did not happen",
    );
    await fresh.backend.close();
  });

  it("renaming a seeded file persists the successful namespace change", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/seeded", "payload");
    assert.strictEqual(sysRename(w.h, "seeded", "moved"), ESUCCESS);
    await w.backend.close();
    const fresh = await makeWorker(store);
    assert.strictEqual(
      sysStat(fresh.h, "seeded").errno,
      WASIAbi.WASI_ERRNO_NOENT,
    );
    const moved = sysOpen(fresh.h, "moved");
    assert.strictEqual(moved.errno, ESUCCESS);
    assert.strictEqual(sysReadText(fresh.h, moved.fd).text, "payload");
    await fresh.backend.close();
  });

  it("renaming a seeded file over a recorded one survives a crash", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    const old = sysCreate(w.h, "target");
    assert.strictEqual(sysWrite(w.h, old.fd, "old target").errno, ESUCCESS);
    assert.strictEqual(sysSync(w.h, old.fd), ESUCCESS);
    // The open fd defers destroying the replaced content past the crash.
    w.backend.fileSystem.addFile("/seeded", "seeded");
    assert.strictEqual(sysRename(w.h, "seeded", "target"), ESUCCESS);
    store.simulateCrash();
    const fresh = await makeWorker(store);
    assert.strictEqual(
      sysStat(fresh.h, "seeded").errno,
      WASIAbi.WASI_ERRNO_NOENT,
    );
    const target = sysOpen(fresh.h, "target");
    assert.strictEqual(target.errno, ESUCCESS);
    assert.strictEqual(sysReadText(fresh.h, target.fd).text, "seeded");
    await fresh.backend.close();
  });

  it("renames of seeded directories and symlinks persist", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    w.backend.fileSystem.addFile("/seeded-dir/inner", "inner");
    w.backend.fileSystem.setNode("/seeded-link", {
      type: "symlink",
      target: "seeded-dir/inner",
    });
    assert.strictEqual(sysRename(w.h, "seeded-dir", "dir"), ESUCCESS);
    assert.strictEqual(sysRename(w.h, "seeded-link", "link"), ESUCCESS);
    store.simulateCrash();
    const fresh = await makeWorker(store);
    const root = fresh.backend.fileSystem.lookup("/");
    assert.deepStrictEqual(
      fresh.backend.listChildren(root).filter((n) => n !== "dev"),
      ["dir", "link"],
    );
    assert.strictEqual(
      fresh.backend.fileSystem.lookup("/link").target,
      "seeded-dir/inner",
    );
    await fresh.backend.close();
  });
});

/** create + write + close, without fd_sync: fine past the spare pool. */
function writeFile(h, name, text) {
  const { errno, fd } = sysCreate(h, name);
  assert.strictEqual(errno, ESUCCESS, `creating ${name}`);
  assert.strictEqual(sysWrite(h, fd, text).errno, ESUCCESS);
  assert.strictEqual(sysClose(h, fd), ESUCCESS);
}

function dataFileCount(store) {
  return store.rootNames().filter((n) => n.startsWith(".uwasi.data.")).length;
}

describe("handle pool lifecycle", () => {
  it("close trims spares freed by unlinks back to the pool target", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 2 });
    for (let i = 0; i < 20; i++) writeFile(w.h, `f${i}`, `content ${i}`);
    await w.backend.settle();
    for (let i = 0; i < 20; i++) assert.strictEqual(sysUnlink(w.h, `f${i}`), 0);
    await w.backend.close();
    assert.strictEqual(dataFileCount(store), 2, "only the pool target is left");

    const w2 = await makeWorker(store, { spareFiles: 2 });
    assert.strictEqual(dataFileCount(store), 2);
    await w2.backend.close();
  });

  it("re-init after a crash removes leftover data files beyond the pool", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 2 });
    for (let i = 0; i < 20; i++) writeFile(w.h, `f${i}`, `secret ${i}`);
    writeFile(w.h, "kept", "kept");
    await w.backend.settle();
    for (let i = 0; i < 20; i++) assert.strictEqual(sysUnlink(w.h, `f${i}`), 0);
    store.simulateCrash();

    const w2 = await makeWorker(store, { spareFiles: 2 });
    assert.strictEqual(dataFileCount(store), 3, "kept plus two spares");
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(findDataFileContaining(store, `secret ${i}`), null);
    }
    assert.strictEqual(
      sysReadText(w2.h, sysOpen(w2.h, "kept").fd).text,
      "kept",
    );
    await w2.backend.close();
  });

  it("settle materializes a large overdraft with every file's content intact", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    for (let i = 0; i < 200; i++) {
      const { fd } = sysCreate(w.h, `f${i}`);
      sysWrite(w.h, fd, `payload ${i}`);
      sysClose(w.h, fd);
    }
    await w.backend.settle();
    for (let i = 0; i < 200; i += 37) {
      const { fd } = sysOpen(w.h, `f${i}`);
      assert.strictEqual(sysSync(w.h, fd), ESUCCESS, "materialized");
      sysClose(w.h, fd);
    }
    store.simulateCrash();

    const w2 = await makeWorker(store);
    for (let i = 0; i < 200; i++) {
      assert.strictEqual(
        sysReadText(w2.h, sysOpen(w2.h, `f${i}`).fd).text,
        `payload ${i}`,
      );
    }
    await w2.backend.close();
  });
});

describe("atomic rename over an existing target", () => {
  it("rename-replace records the new mapping before destroying the replaced content", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "dst", "OLD TARGET");
    putFile(w.h, "src", "NEW CONTENT");
    const dstData = findDataFileContaining(store, "OLD TARGET");
    assert.ok(dstData);

    store.opLog.length = 0;
    assert.strictEqual(sysRename(w.h, "src", "dst"), ESUCCESS);

    // Atomic replace: if the record still maps dst -> old content, that
    // content must be intact; destruction may only follow the flush.
    const log = store.opLog;
    const metaFlushAt = log.findIndex(
      (op) => op.op === "flush" && op.path.includes("meta"),
    );
    const truncateAt = log.findIndex(
      (op) =>
        op.op === "truncate" && op.size === 0 && op.path === `/${dstData}`,
    );
    assert.ok(metaFlushAt !== -1, "the rename must flush the record");
    assert.ok(truncateAt !== -1, "the replaced content must be reclaimed");
    assert.ok(
      metaFlushAt < truncateAt,
      `the new mapping must be durable before the replaced content dies: ` +
        JSON.stringify(log),
    );
    await w.backend.close();
  });

  it("a crash in the rename-replace window leaves the renamed file intact at the destination", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store);
    putFile(w.h, "dst", "OLD TARGET");
    putFile(w.h, "src", "NEW CONTENT");
    const dstData = findDataFileContaining(store, "OLD TARGET");
    assert.ok(dstData);
    // The replaced file's cleanup dies - equivalent to a crash between
    // the record flush and the tombstone. The rename must already be
    // safe: cleanup is not a durability point.
    const injected = store.injectTruncateError(dstData);
    assert.strictEqual(sysRename(w.h, "src", "dst"), ESUCCESS);
    assert.strictEqual(injected.fired, 1, "the cleanup must have failed");
    store.simulateCrash();

    const w2 = await makeWorker(store);
    const reopened = sysOpen(w2.h, "dst");
    assert.strictEqual(reopened.errno, ESUCCESS);
    assert.strictEqual(
      sysReadText(w2.h, reopened.fd).text,
      "NEW CONTENT",
      "the destination must hold the renamed file, never a truncated husk",
    );
    assert.strictEqual(sysStat(w2.h, "src").errno, WASIAbi.WASI_ERRNO_NOENT);
    // The replaced content became unreferenced and re-init reclaimed it.
    assert.strictEqual(findDataFileContaining(store, "OLD TARGET"), null);
    await w2.backend.close();
  });
});

describe("useOPFS", () => {
  it("mirrors useMemoryFS's provider shape over a constructed backend", async () => {
    const store = new MockOPFS();
    const backend = await OPFSBackend.create(store.root);
    const provider = useOPFS({ withBackend: backend });
    const memory = new ArrayBuffer(65536);
    const view = new DataView(memory);
    const imports = provider({}, new WASIAbi(), () => view);
    for (const name of [
      "path_open",
      "fd_write",
      "fd_read",
      "fd_sync",
      "fd_datasync",
      "path_unlink_file",
      "fd_prestat_get",
    ]) {
      assert.strictEqual(
        typeof imports[name],
        "function",
        `useOPFS must provide ${name}`,
      );
    }
    await backend.close();
  });
});
