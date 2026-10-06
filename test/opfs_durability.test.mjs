// Durability promises of the OPFS backend under storage faults: what a
// successful syscall promised must survive a crash, whatever failed before
// it.
import { OPFSBackend } from "uwasi/opfs";
import { WASIAbi } from "../lib/esm/abi.js";
import { MockOPFS } from "./opfs_mock.mjs";
import {
  bindImports,
  sysClose,
  sysLink,
  sysCreate,
  sysMkdir,
  sysOpen,
  sysStat,
  sysSync,
  sysReadText,
  sysRename,
  sysSeekStart,
  sysUnlink,
  sysWrite,
} from "./syscall_harness.mjs";
import { describe, it } from "node:test";
import assert from "node:assert";

const ESUCCESS = 0;

async function makeWorker(store, options = {}) {
  const backend = await OPFSBackend.create(store.root, options);
  return { backend, h: bindImports(backend, backend.fileSystem) };
}

/**
 * With `spareFiles: 1`, call `start()` while a background round is queued,
 * and drive the round it waits for into its spare refill. Meanwhile the
 * guest creates files "a" to "d", each holding its own name; the last
 * one, "d", is created past the pool after the next round is already
 * queued, so only that next round gives it a data file. That round waits
 * on the returned gate. Returns what `start()` returned and the gate.
 */
async function createDuringAwaitedRound(store, w, start) {
  const hold = () =>
    store.holdAsync({ op: "createSyncAccessHandle", match: ".uwasi.data." });
  const create = (name) => {
    const file = sysCreate(w.h, name);
    assert.strictEqual(file.errno, ESUCCESS, `create ${name}`);
    assert.strictEqual(sysWrite(w.h, file.fd, name).errno, ESUCCESS);
  };
  // "a" claims the only spare, and the round refilling the pool stalls.
  const refill = hold();
  create("a");
  await refill.parked(1);
  // Queued behind that round, so it waits for the next one.
  const started = start();
  await new Promise((resolve) => setImmediate(resolve));
  // "b" goes past the pool, so the awaited round materializes it first.
  const materialize = hold();
  create("b");
  refill.release();
  await materialize.parked(1);
  // "c" claims the refilled spare, which queues another round.
  create("c");
  const refillAgain = hold();
  materialize.release();
  await refillAgain.parked(1);
  // The awaited round is refilling now: "d" goes past the pool, and only
  // the queued round can give it a data file.
  const late = hold();
  create("d");
  refillAgain.release();
  return { started, late };
}

describe("settle()", () => {
  it("waits for background work queued while it waits", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    const { started, late } = await createDuringAwaitedRound(store, w, () =>
      w.backend.settle().then(() => sysSync(w.h, sysOpen(w.h, "d").fd)),
    );
    await late.parked(1);
    late.release();
    // Once it resolves, every file it covers has a data file to sync.
    assert.strictEqual(await started, ESUCCESS);
    await w.backend.close();
  });

  it("close() saves files created while it waits", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    const { started, late } = await createDuringAwaitedRound(store, w, () =>
      w.backend.close(),
    );
    late.release();
    await started;
    const fresh = await makeWorker(store, { spareFiles: 0 });
    for (const name of ["a", "b", "c", "d"]) {
      const opened = sysOpen(fresh.h, name);
      assert.strictEqual(opened.errno, ESUCCESS, `open ${name}`);
      assert.strictEqual(sysReadText(fresh.h, opened.fd).text, name);
    }
    await fresh.backend.close();
  });
});

function listNames(backend, path = "/") {
  return backend
    .listChildren(backend.fileSystem.lookup(path))
    .filter((name) => name !== "dev");
}

describe("an allocated id is not a recorded name", () => {
  for (const spareFiles of [0, 2]) {
    const kind = spareFiles === 0 ? "overdrafted" : "spare-backed";
    it(`retrying a seeded open after a failed record makes it durable (${kind})`, async () => {
      const store = new MockOPFS();
      const w = await makeWorker(store, { spareFiles });
      w.backend.fileSystem.addFile("/seeded", "payload");
      // The first open gives the file an id, then fails to record it.
      const injected = store.injectShortWrite(".uwasi.meta.", 4);
      assert.notStrictEqual(sysOpen(w.h, "seeded").errno, ESUCCESS);
      assert.strictEqual(injected.fired, 1);
      const opened = sysOpen(w.h, "seeded");
      assert.strictEqual(opened.errno, ESUCCESS);
      await w.backend.settle();
      assert.strictEqual(sysSync(w.h, opened.fd), ESUCCESS);
      store.simulateCrash();
      const fresh = await makeWorker(store);
      assert.strictEqual(sysStat(fresh.h, "seeded").errno, ESUCCESS);
      const reopened = sysOpen(fresh.h, "seeded");
      assert.strictEqual(sysReadText(fresh.h, reopened.fd).text, "payload");
      await fresh.backend.close();
    });
  }
});

describe("failed background work is reported", () => {
  it("settle reports a failed pending materialization", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 0 });
    const file = sysCreate(w.h, "pending");
    assert.strictEqual(sysWrite(w.h, file.fd, "payload").errno, ESUCCESS);
    const injected = store.injectShortWrite(".uwasi.data.", 2);
    await assert.rejects(w.backend.settle());
    assert.strictEqual(injected.fired, 1);
    await w.backend.close();
  });

  it("a later settle retries and makes every pending file durable", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 0 });
    const a = sysCreate(w.h, "a");
    assert.strictEqual(
      sysWrite(w.h, a.fd, "a longer first payload").errno,
      ESUCCESS,
    );
    const b = sysCreate(w.h, "b");
    assert.strictEqual(sysWrite(w.h, b.fd, "bbb").errno, ESUCCESS);
    // The first attempt acquires a's handle, then writes only part of it.
    const injected = store.injectShortWrite(".uwasi.data.", 2);
    await assert.rejects(w.backend.settle());
    assert.strictEqual(injected.fired, 1);
    assert.notStrictEqual(sysSync(w.h, a.fd), ESUCCESS, "a is still pending");
    // Pending content stays live in memory, and may shrink meanwhile.
    assert.strictEqual(w.h.imports.fd_filestat_set_size(a.fd, 5n), ESUCCESS);
    await w.backend.settle();
    assert.strictEqual(sysSync(w.h, a.fd), ESUCCESS);
    assert.strictEqual(sysSync(w.h, b.fd), ESUCCESS);
    store.simulateCrash();
    const fresh = await makeWorker(store, { spareFiles: 0 });
    for (const [name, text] of [
      ["a", "a lon"],
      ["b", "bbb"],
    ]) {
      const opened = sysOpen(fresh.h, name);
      assert.strictEqual(opened.errno, ESUCCESS);
      assert.strictEqual(sysReadText(fresh.h, opened.fd).text, text);
    }
    await fresh.backend.close();
  });

  it("unlinking a file whose materialization failed recycles its handle", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 0 });
    const file = sysCreate(w.h, "pending");
    assert.strictEqual(sysWrite(w.h, file.fd, "payload").errno, ESUCCESS);
    // The attempt acquires the data file's handle, then fails to write.
    const injected = store.injectShortWrite(".uwasi.data.", 2);
    await assert.rejects(w.backend.settle());
    assert.strictEqual(injected.fired, 1);
    assert.strictEqual(sysUnlink(w.h, "pending"), ESUCCESS);
    // The cancelled file is never retried; its emptied data file backs the
    // next file at once, rather than staying locked until close.
    const next = sysCreate(w.h, "next");
    assert.strictEqual(sysSync(w.h, next.fd), ESUCCESS);
    assert.strictEqual(sysReadText(w.h, next.fd).text, "");
    await w.backend.close();
  });

  it("settle reports a failed spare refill and retries it", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    sysCreate(w.h, "claims-the-spare");
    const fault = store.injectFault({
      op: "createSyncAccessHandle",
      match: ".uwasi.data.",
    });
    await assert.rejects(w.backend.settle());
    assert.strictEqual(fault.fired, 1);
    await w.backend.settle();
    // The refilled spare backs the next file, so it syncs at once.
    const next = sysCreate(w.h, "next");
    assert.strictEqual(sysSync(w.h, next.fd), ESUCCESS);
    await w.backend.close();
  });

  it("close rejects when pending content cannot be saved, releasing every handle", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 0 });
    const file = sysCreate(w.h, "pending");
    assert.strictEqual(sysWrite(w.h, file.fd, "payload").errno, ESUCCESS);
    const fault = store.injectFault({
      op: "write",
      match: ".uwasi.data.",
      times: Infinity,
    });
    await assert.rejects(w.backend.close());
    assert.ok(fault.fired > 0);
    store.clearFaults();
    // Every lock is released: the store opens again in the same worker.
    const fresh = await makeWorker(store, { spareFiles: 0 });
    assert.strictEqual(sysStat(fresh.h, "pending").errno, ESUCCESS);
    await fresh.backend.close();
  });

  for (const truncateFails of [false, true]) {
    const how = truncateFails ? ", even if it cannot be emptied" : "";
    it(`a file close() reports lost never comes back holding part of its content${how}`, async () => {
      const store = new MockOPFS();
      const w = await makeWorker(store, { spareFiles: 0 });
      const file = sysCreate(w.h, "pending");
      assert.strictEqual(sysWrite(w.h, file.fd, "payload").errno, ESUCCESS);
      // Every attempt to give it a data file stops after one byte.
      const short = store.injectFault({
        op: "write",
        match: ".uwasi.data.",
        short: 1,
        times: Infinity,
      });
      const truncate = truncateFails
        ? store.injectFault({
            op: "truncate",
            match: ".uwasi.data.",
            times: Infinity,
          })
        : null;
      await assert.rejects(w.backend.close());
      assert.ok(short.fired > 0);
      if (truncate !== null) assert.ok(truncate.fired > 0);
      store.clearFaults();
      const fresh = await makeWorker(store, { spareFiles: 0 });
      const opened = sysOpen(fresh.h, "pending");
      assert.strictEqual(opened.errno, ESUCCESS);
      assert.strictEqual(sysReadText(fresh.h, opened.fd).text, "");
      await fresh.backend.close();
    });
  }

  it("a failed attempt empties its data file, so a failed removal at close leaks no prefix", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 0 });
    const file = sysCreate(w.h, "pending");
    assert.strictEqual(
      sysWrite(w.h, file.fd, "secret payload").errno,
      ESUCCESS,
    );
    store.injectFault({
      op: "write",
      match: ".uwasi.data.",
      short: 3,
      times: Infinity,
    });
    // close() cannot remove the data file either, so only emptying it
    // after each failed write keeps the prefix out.
    store.injectFault({
      op: "removeEntry",
      match: ".uwasi.data.",
      times: Infinity,
    });
    await assert.rejects(w.backend.settle());
    await assert.rejects(w.backend.close());
    store.clearFaults();
    const fresh = await makeWorker(store, { spareFiles: 0 });
    const opened = sysOpen(fresh.h, "pending");
    assert.strictEqual(opened.errno, ESUCCESS);
    assert.strictEqual(sysReadText(fresh.h, opened.fd).text, "");
    await fresh.backend.close();
  });
});

describe("opening a store survives storage failures", () => {
  for (const [what, fault] of [
    ["the initial record write", { op: "write", match: ".uwasi.meta." }],
    [
      "a data file handle",
      { op: "createSyncAccessHandle", match: ".uwasi.data.", nth: 2 },
    ],
  ]) {
    it(`a create() failing at ${what} releases its handles`, async () => {
      const store = new MockOPFS();
      const first = await makeWorker(store, { spareFiles: 2 });
      const kept = sysCreate(first.h, "keep");
      assert.strictEqual(sysWrite(first.h, kept.fd, "kept").errno, ESUCCESS);
      assert.strictEqual(sysSync(first.h, kept.fd), ESUCCESS);
      store.simulateCrash();
      const armed = store.injectFault(fault);
      await assert.rejects(OPFSBackend.create(store.root, { spareFiles: 2 }));
      assert.strictEqual(armed.fired, 1);
      store.clearFaults();
      // A retry in the same worker finds every lock free.
      const retry = await makeWorker(store, { spareFiles: 2 });
      const opened = sysOpen(retry.h, "keep");
      assert.strictEqual(opened.errno, ESUCCESS);
      assert.strictEqual(sysReadText(retry.h, opened.fd).text, "kept");
      await retry.backend.close();
    });
  }

  it("failing to remove surplus data files does not fail the open", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    const names = ["g0", "g1", "g2", "g3"];
    for (const name of names) {
      const file = sysCreate(w.h, name);
      assert.strictEqual(sysWrite(w.h, file.fd, name).errno, ESUCCESS);
      await w.backend.settle();
      assert.strictEqual(sysSync(w.h, file.fd), ESUCCESS);
    }
    for (const name of names.slice(1)) {
      assert.strictEqual(sysUnlink(w.h, name), ESUCCESS);
    }
    store.simulateCrash();
    // The unlinked files' data files are surplus at the next open.
    const fault = store.injectFault({ op: "removeEntry", times: Infinity });
    const reopened = await makeWorker(store, { spareFiles: 1 });
    assert.ok(fault.fired > 0, "the open never removed a surplus data file");
    assert.deepStrictEqual(listNames(reopened.backend), ["g0"]);
    await reopened.backend.close();
    store.clearFaults();
    const again = await makeWorker(store, { spareFiles: 1 });
    assert.deepStrictEqual(listNames(again.backend), ["g0"]);
    const g0 = sysOpen(again.h, "g0");
    assert.strictEqual(sysReadText(again.h, g0.fd).text, "g0");
    await again.backend.close();
  });

  it("a failed create() leaves no lock behind, even from background work it queued", async () => {
    const store = new MockOPFS();
    const first = await makeWorker(store, { spareFiles: 1 });
    const a = sysCreate(first.h, "a");
    assert.strictEqual(sysWrite(first.h, a.fd, "A").errno, ESUCCESS);
    assert.strictEqual(sysSync(first.h, a.fd), ESUCCESS);
    assert.strictEqual(sysClose(first.h, a.fd), ESUCCESS);
    // A failed unlink, then a create: depending on how the store treats
    // the data file the unlink emptied, the reopen below may have a file
    // to give a data file while it writes its first record, which queues
    // background work - and that write fails.
    const unlinkFault = store.injectFault({
      op: "write",
      match: ".uwasi.meta.",
    });
    assert.notStrictEqual(sysUnlink(first.h, "a"), ESUCCESS);
    assert.strictEqual(unlinkFault.fired, 1);
    assert.strictEqual(sysCreate(first.h, "b").errno, ESUCCESS);
    store.simulateCrash();
    const openFault = store.injectFault({ op: "write", match: /meta\.[01]$/ });
    await assert.rejects(OPFSBackend.create(store.root, { spareFiles: 1 }));
    assert.strictEqual(openFault.fired, 1);
    store.clearFaults();
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for await (const [name, handle] of store.root.entries()) {
      if (handle.kind !== "file") continue;
      let access;
      try {
        access = await handle.createSyncAccessHandle();
      } catch (error) {
        assert.fail(`${name} is still locked: ${error.name}`);
      }
      access.close();
    }
  });
});

describe("failed namespace syscalls", () => {
  it("keep the directory listing order", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 4 });
    assert.strictEqual(sysMkdir(w.h, "d"), ESUCCESS);
    for (const name of ["a", "b", "c", "d/x", "d/y"]) {
      assert.strictEqual(sysClose(w.h, sysCreate(w.h, name).fd), ESUCCESS);
    }
    const before = {
      "/": listNames(w.backend),
      "/d": listNames(w.backend, "/d"),
    };
    const failing = [
      ["unlink", () => sysUnlink(w.h, "a")],
      ["rename", () => sysRename(w.h, "a", "z")],
      ["rename over", () => sysRename(w.h, "a", "c")],
      ["rename across", () => sysRename(w.h, "d/x", "b")],
      ["mkdir", () => sysMkdir(w.h, "new")],
    ];
    for (const [what, call] of failing) {
      const fault = store.injectFault({ op: "write", match: ".uwasi.meta." });
      assert.notStrictEqual(call(), ESUCCESS, `${what} should fail`);
      assert.strictEqual(fault.fired, 1, what);
      for (const dir of ["/", "/d"]) {
        assert.deepStrictEqual(listNames(w.backend, dir), before[dir], what);
      }
    }
    await w.backend.close();
    const reopened = await makeWorker(store, { spareFiles: 4 });
    for (const dir of ["/", "/d"]) {
      assert.deepStrictEqual(listNames(reopened.backend, dir), before[dir]);
    }
    await reopened.backend.close();
  });
});

describe("path_rename of a directory", () => {
  it("refuses to move it into its own subtree", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 2 });
    assert.strictEqual(sysMkdir(w.h, "a"), ESUCCESS);
    assert.strictEqual(sysMkdir(w.h, "a/b"), ESUCCESS);
    assert.strictEqual(sysClose(w.h, sysCreate(w.h, "a/b/f").fd), ESUCCESS);
    assert.strictEqual(sysRename(w.h, "a", "a/b/c"), WASIAbi.WASI_ERRNO_INVAL);
    assert.strictEqual(sysStat(w.h, "a/b/f").errno, ESUCCESS);
    store.simulateCrash();
    const fresh = await makeWorker(store, { spareFiles: 2 });
    assert.deepStrictEqual(listNames(fresh.backend), ["a"]);
    assert.strictEqual(sysStat(fresh.h, "a/b/f").errno, ESUCCESS);
    await fresh.backend.close();
  });
});

/** Open the store in a fresh worker and read `name`, or null if missing. */
async function readAfterReopen(store, name, options = {}) {
  const w = await makeWorker(store, options);
  const opened = sysOpen(w.h, name);
  const text =
    opened.errno === ESUCCESS ? sysReadText(w.h, opened.fd).text : null;
  await w.backend.close();
  return text;
}

describe("a data file a record may still name is not reused", () => {
  // A synced file whose unlink destroys its content, then fails to record
  // the removal: the durable record still maps the name to the data file.
  // A host-seeded file's first open then claims a spare and writes its
  // content into it, and fails to record that.
  async function failedUnlinkThenSeededOpen(store) {
    const w = await makeWorker(store, { spareFiles: 1 });
    const a = sysCreate(w.h, "a");
    assert.strictEqual(sysWrite(w.h, a.fd, "AAAA").errno, ESUCCESS);
    assert.strictEqual(sysSync(w.h, a.fd), ESUCCESS);
    assert.strictEqual(sysClose(w.h, a.fd), ESUCCESS);
    const unlinkFault = store.injectFault({
      op: "write",
      match: ".uwasi.meta.",
    });
    assert.notStrictEqual(sysUnlink(w.h, "a"), ESUCCESS);
    assert.strictEqual(unlinkFault.fired, 1);
    w.backend.fileSystem.addFile("/s", "SEED");
    const openFault = store.injectFault({ op: "write", match: ".uwasi.meta." });
    assert.notStrictEqual(sysOpen(w.h, "s").errno, ESUCCESS);
    assert.strictEqual(openFault.fired, 1);
    return w;
  }

  it("a failed unlink's name never shows another file's bytes after a crash", async () => {
    const store = new MockOPFS();
    await failedUnlinkThenSeededOpen(store);
    store.simulateCrash();
    store.clearFaults();
    const text = await readAfterReopen(store, "a", { spareFiles: 1 });
    assert.ok(text === "" || text === "AAAA", `a shows ${text}`);
  });

  it("a failed unlink's name never shows another file's bytes after a clean close", async () => {
    const store = new MockOPFS();
    const w = await failedUnlinkThenSeededOpen(store);
    store.clearFaults();
    await w.backend.close();
    const text = await readAfterReopen(store, "a", { spareFiles: 1 });
    assert.ok(text === "" || text === "AAAA", `a shows ${text}`);
  });

  it("a failed create's name never shows another file's bytes", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    // The create's record is written but neither flushed nor removed, so
    // anything that persists it later can make it durable - here the
    // mock's close(), which persists what a handle holds.
    const flush = store.injectFault({ op: "flush", match: ".uwasi.meta." });
    const truncate = store.injectFault({
      op: "truncate",
      match: ".uwasi.meta.",
    });
    assert.notStrictEqual(sysCreate(w.h, "b").errno, ESUCCESS);
    assert.ok(flush.fired + truncate.fired > 0, "recording b must fail");
    w.backend.fileSystem.addFile("/s", "SEED");
    store.clearFaults();
    const write = store.injectFault({ op: "write", match: ".uwasi.meta." });
    assert.notStrictEqual(sysOpen(w.h, "s").errno, ESUCCESS);
    assert.strictEqual(write.fired, 1);
    store.clearFaults();
    await w.backend.close();
    const text = await readAfterReopen(store, "b", { spareFiles: 1 });
    assert.ok(text === null || text === "", `b shows ${text}`);
  });
});

describe("a failed unlink of a file past the spare pool", () => {
  // The file has an open fd and no data file yet when its unlink fails to
  // record the removal, so the record still names its pending id.
  async function failedUnlinkOfPendingOpenFile() {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    assert.strictEqual(sysCreate(w.h, "filler").errno, ESUCCESS);
    const file = sysCreate(w.h, "victim");
    assert.strictEqual(file.errno, ESUCCESS);
    const fault = store.injectFault({ op: "write", match: ".uwasi.meta." });
    assert.notStrictEqual(sysUnlink(w.h, "victim"), ESUCCESS);
    assert.strictEqual(fault.fired, 1);
    assert.strictEqual(sysWrite(w.h, file.fd, "IMPORTANT").errno, ESUCCESS);
    return { store, ...w, fd: file.fd };
  }

  it("fd_sync refuses until the file has its data file", async () => {
    const { h, fd, backend } = await failedUnlinkOfPendingOpenFile();
    assert.strictEqual(sysSync(h, fd), WASIAbi.WASI_ERRNO_NOSPC);
    await backend.close();
  });

  it("settle() then fd_sync makes its content durable", async () => {
    const { store, h, fd, backend } = await failedUnlinkOfPendingOpenFile();
    await backend.settle();
    assert.strictEqual(sysSync(h, fd), ESUCCESS);
    store.simulateCrash();
    assert.strictEqual(
      await readAfterReopen(store, "victim", { spareFiles: 1 }),
      "IMPORTANT",
    );
  });

  it("a clean close keeps its content", async () => {
    const { store, h, fd, backend } = await failedUnlinkOfPendingOpenFile();
    assert.strictEqual(sysClose(h, fd), ESUCCESS);
    await backend.close();
    assert.strictEqual(
      await readAfterReopen(store, "victim", { spareFiles: 1 }),
      "IMPORTANT",
    );
  });
});

describe("persistAll() racing the guest", () => {
  it("keeps the data a guest open wrote and synced while it waited", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 2 });
    w.backend.fileSystem.addFile("/s", "SEED");
    const gate = store.holdAsync({
      op: "getFileHandle",
      match: ".uwasi.data.",
    });
    const persisting = w.backend.persistAll();
    await gate.parked(1);
    // The guest's open adopts the file into a spare meanwhile.
    const opened = sysOpen(w.h, "s");
    assert.strictEqual(opened.errno, ESUCCESS);
    assert.strictEqual(sysWrite(w.h, opened.fd, "GUEST").errno, ESUCCESS);
    assert.strictEqual(sysSync(w.h, opened.fd), ESUCCESS);
    gate.release();
    await persisting;
    assert.strictEqual(sysWrite(w.h, opened.fd, "!").errno, ESUCCESS);
    assert.strictEqual(sysSync(w.h, opened.fd), ESUCCESS);
    store.simulateCrash();
    assert.strictEqual(
      await readAfterReopen(store, "s", { spareFiles: 2 }),
      "GUEST!",
    );
  });

  it("does not adopt a seeded file the guest unlinked while it waited", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    w.backend.fileSystem.addFile("/s", "SEED");
    const gate = store.holdAsync({
      op: "getFileHandle",
      match: ".uwasi.data.",
    });
    const persisting = w.backend.persistAll();
    await gate.parked(1);
    assert.strictEqual(sysUnlink(w.h, "s"), ESUCCESS);
    gate.release();
    await persisting;
    // The data file persistAll() acquired names nothing: it is a spare,
    // empty, rather than a locked copy of the unlinked file.
    await w.backend.close();
    for (const name of store.rootNames()) {
      if (!name.startsWith(".uwasi.data.")) continue;
      const text = new TextDecoder().decode(store.durableContent(name));
      assert.strictEqual(text, "", `${name} holds the unlinked file's bytes`);
    }
    assert.strictEqual(await readAfterReopen(store, "s"), null);
  });
});

describe("sizes no buffer can hold, on a file without a data file", () => {
  // Past the spare pool, a file's bytes stay in memory until background
  // work gives it a data file. A guest-chosen size the engine refuses to
  // allocate must come back as an errno: an exception thrown inside an
  // import would trap the guest.
  const HUGE = 2 ** 52;

  it("fd_pwrite at a huge offset reports NOSPC", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 0 });
    const file = sysCreate(w.h, "pending");
    assert.strictEqual(sysWrite(w.h, file.fd, "x").errno, ESUCCESS);
    // Reuse the iovec the write above left in guest memory.
    const iovec = 256;
    assert.strictEqual(
      w.h.imports.fd_pwrite(file.fd, iovec, 1, BigInt(HUGE), 4096 + 8),
      WASIAbi.WASI_ERRNO_NOSPC,
    );
    assert.strictEqual(sysSeekStart(w.h, file.fd), ESUCCESS);
    assert.strictEqual(sysReadText(w.h, file.fd).text, "x");
    await w.backend.close();
  });

  it("fd_filestat_set_size to a huge size reports NOSPC", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 0 });
    const file = sysCreate(w.h, "pending");
    assert.strictEqual(
      w.h.imports.fd_filestat_set_size(file.fd, BigInt(HUGE)),
      WASIAbi.WASI_ERRNO_NOSPC,
    );
    await w.backend.close();
  });
});

describe("device nodes", () => {
  // /dev/null is recreated at every open and no record stores it, so a
  // change to it or under its name could not survive a reopen.
  const NOTSUP = WASIAbi.WASI_ERRNO_NOTSUP;

  it("refuses to link, rename, replace or unlink them", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 2 });
    assert.strictEqual(sysClose(w.h, sysCreate(w.h, "f").fd), ESUCCESS);
    assert.strictEqual(sysLink(w.h, "dev/null", "nul"), NOTSUP);
    assert.strictEqual(sysRename(w.h, "dev/null", "moved"), NOTSUP);
    assert.strictEqual(sysRename(w.h, "f", "dev/null"), NOTSUP);
    assert.strictEqual(sysUnlink(w.h, "dev/null"), NOTSUP);
    assert.strictEqual(sysRename(w.h, "dev", "devices"), NOTSUP);
    const expect = (backend) => {
      assert.deepStrictEqual(listNames(backend), ["f"]);
      assert.deepStrictEqual(listNames(backend, "/dev"), ["null"]);
      assert.strictEqual(
        backend.fileSystem.lookup("/dev/null").type,
        "character",
      );
    };
    expect(w.backend);
    // Twice: a change can last one reopen and vanish at the next.
    for (let i = 0; i < 2; i++) {
      store.simulateCrash();
      const fresh = await makeWorker(store, { spareFiles: 2 });
      expect(fresh.backend);
    }
  });

  it("still allows files of their own in /dev", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 2 });
    assert.strictEqual(sysClose(w.h, sysCreate(w.h, "dev/f").fd), ESUCCESS);
    assert.strictEqual(sysRename(w.h, "dev/f", "dev/g"), ESUCCESS);
    store.simulateCrash();
    const fresh = await makeWorker(store, { spareFiles: 2 });
    assert.deepStrictEqual(listNames(fresh.backend, "/dev"), ["null", "g"]);
  });
});

describe("a clean close", () => {
  // close() on a sync access handle need not persist anything; only
  // flush() does. This store's close() only releases, and drops whatever
  // was left unflushed.
  const releasing = () => new MockOPFS({ closeFlushes: false });

  async function reopenedText(store, name) {
    const fresh = await makeWorker(store);
    const opened = sysOpen(fresh.h, name);
    assert.strictEqual(opened.errno, ESUCCESS, `open ${name}`);
    const { text } = sysReadText(fresh.h, opened.fd);
    await fresh.backend.close();
    return text;
  }

  it("persists what was written to a spare-backed file", async () => {
    const store = releasing();
    const w = await makeWorker(store, { spareFiles: 1 });
    const f = sysCreate(w.h, "saved");
    assert.strictEqual(sysWrite(w.h, f.fd, "SAVED").errno, ESUCCESS);
    assert.strictEqual(sysClose(w.h, f.fd), ESUCCESS);
    await w.backend.close();
    assert.strictEqual(await reopenedText(store, "saved"), "SAVED");
  });

  it("persists later writes to a file that got its data file in the background", async () => {
    const store = releasing();
    const w = await makeWorker(store, { spareFiles: 0 });
    const f = sysCreate(w.h, "late");
    assert.strictEqual(sysWrite(w.h, f.fd, "first").errno, ESUCCESS);
    await w.backend.settle();
    assert.strictEqual(sysWrite(w.h, f.fd, " second").errno, ESUCCESS);
    // The fd stays open across the close.
    await w.backend.close();
    assert.strictEqual(await reopenedText(store, "late"), "first second");
  });

  it("rejects when a file's content cannot be flushed, releasing every handle", async () => {
    const store = releasing();
    const w = await makeWorker(store, { spareFiles: 1 });
    const f = sysCreate(w.h, "doomed");
    assert.strictEqual(sysWrite(w.h, f.fd, "DOOMED").errno, ESUCCESS);
    const fault = store.injectFault({ op: "flush", match: ".uwasi.data." });
    await assert.rejects(w.backend.close(), { name: "QuotaExceededError" });
    assert.strictEqual(fault.fired, 1);
    // Every lock was released: the store opens again in this worker.
    const fresh = await makeWorker(store);
    assert.strictEqual(sysStat(fresh.h, "doomed").errno, ESUCCESS);
    await fresh.backend.close();
  });

  it("does not flush the namespace record, which may hold a failed change", async () => {
    const store = releasing();
    const w = await makeWorker(store, { spareFiles: 1 });
    const start = store.opLog.length;
    await w.backend.close();
    const flushed = store.opLog
      .slice(start)
      .filter((entry) => entry.op === "flush" && entry.path.includes("meta"));
    assert.deepStrictEqual(flushed, []);
  });
});

describe("persistAll()", () => {
  for (const spareFiles of [0, 1]) {
    const kind = spareFiles === 0 ? "overdrafted" : "spare-backed";
    it(`makes the current content of every file durable (${kind})`, async () => {
      const store = new MockOPFS();
      const w = await makeWorker(store, { spareFiles });
      const f = sysCreate(w.h, "saved");
      assert.strictEqual(sysWrite(w.h, f.fd, "first").errno, ESUCCESS);
      await w.backend.settle();
      // Written after the file got its data file, and never synced.
      assert.strictEqual(sysWrite(w.h, f.fd, " second").errno, ESUCCESS);
      w.backend.fileSystem.addFile("/seeded", "seed");
      await w.backend.persistAll();
      store.simulateCrash();
      const fresh = await makeWorker(store);
      for (const [name, text] of [
        ["saved", "first second"],
        ["seeded", "seed"],
      ]) {
        const opened = sysOpen(fresh.h, name);
        assert.strictEqual(opened.errno, ESUCCESS, `open ${name}`);
        assert.strictEqual(sysReadText(fresh.h, opened.fd).text, text);
      }
      await fresh.backend.close();
    });
  }

  it("covers files created while it waits", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    // Crash the moment it resolves, before anything else can run.
    const { started, late } = await createDuringAwaitedRound(store, w, () =>
      w.backend.persistAll().then(() => store.simulateCrash()),
    );
    // Unless it waits for that round, it resolves, crashing the store,
    // before the round can park.
    await Promise.race([late.parked(1), started]);
    late.release();
    await started;
    const fresh = await makeWorker(store, { spareFiles: 0 });
    for (const name of ["a", "b", "c", "d"]) {
      const opened = sysOpen(fresh.h, name);
      assert.strictEqual(opened.errno, ESUCCESS, `open ${name}`);
      assert.strictEqual(sysReadText(fresh.h, opened.fd).text, name);
    }
    await fresh.backend.close();
  });

  it("covers a file overdrafted after settle() resolves", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    const late = store.holdAsync({
      op: "createSyncAccessHandle",
      match: ".uwasi.data.",
    });
    // Stand in for guest calls landing between settle() resolving and
    // persistAll() resuming: "e" claims the spare, "f" goes past the pool.
    const settle = w.backend.settle.bind(w.backend);
    let created = false;
    w.backend.settle = async () => {
      await settle();
      if (created) return;
      created = true;
      for (const name of ["e", "f"]) {
        const file = sysCreate(w.h, name);
        assert.strictEqual(sysWrite(w.h, file.fd, name).errno, ESUCCESS);
      }
    };
    // Crash the moment it resolves, before anything else can run.
    const started = w.backend.persistAll().then(() => store.simulateCrash());
    // Unless it waits for that round, it resolves, crashing the store,
    // before the round can park.
    await Promise.race([late.parked(1), started]);
    late.release();
    await started;
    const fresh = await makeWorker(store, { spareFiles: 0 });
    for (const name of ["e", "f"]) {
      const opened = sysOpen(fresh.h, name);
      assert.strictEqual(opened.errno, ESUCCESS, `open ${name}`);
      assert.strictEqual(sysReadText(fresh.h, opened.fd).text, name);
    }
    await fresh.backend.close();
  });

  it("rejects when a file's content cannot be flushed", async () => {
    const store = new MockOPFS();
    const w = await makeWorker(store, { spareFiles: 1 });
    const f = sysCreate(w.h, "f");
    assert.strictEqual(sysWrite(w.h, f.fd, "data").errno, ESUCCESS);
    await w.backend.settle();
    const fault = store.injectFault({ op: "flush", match: ".uwasi.data." });
    await assert.rejects(w.backend.persistAll(), {
      name: "QuotaExceededError",
    });
    assert.strictEqual(fault.fired, 1);
    await w.backend.close();
  });
});
