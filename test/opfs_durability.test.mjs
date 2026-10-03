// Durability promises of the OPFS backend under storage faults: what a
// successful syscall promised must survive a crash, whatever failed before
// it.
import { OPFSBackend } from "uwasi/opfs";
import { MockOPFS } from "./opfs_mock.mjs";
import {
  bindImports,
  sysOpen,
  sysStat,
  sysSync,
  sysReadText,
} from "./syscall_harness.mjs";
import { describe, it } from "node:test";
import assert from "node:assert";

const ESUCCESS = 0;

async function makeWorker(store, options = {}) {
  const backend = await OPFSBackend.create(store.root, options);
  return { backend, h: bindImports(backend, backend.fileSystem) };
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
