import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Fixtures supply backend, makeFileNode(content?), makeDirNode(), and optional
 * cleanup(). Async fixture setup and cleanup are awaited for each test.
 */
export function fsBackendContractSuite(name, createFixture) {
  describe(`FSBackend contract: ${name}`, () => {
    let fixture;
    beforeEach(async (t) => {
      fixture = await createFixture();
      t.after(() => fixture.cleanup?.());
    });

    it("reads and writes bytes at offsets, including EOF and empty writes", () => {
      const { backend, makeFileNode } = fixture;
      const file = makeFileNode(new Uint8Array([1, 2, 3]));
      assert.equal(backend.fileSize(file), 3);
      assert.equal(backend.writeAt(file, new Uint8Array([9]), 1), 0);
      assert.equal(backend.fileSize(file), 3);
      assert.equal(backend.writeAt(file, new Uint8Array([7]), 5), 0);
      assert.equal(backend.fileSize(file), 6);
      assert.equal(backend.writeAt(file, new Uint8Array(0), 100), 0);
      assert.equal(backend.fileSize(file), 6);

      const bytes = new Uint8Array(8).fill(255);
      assert.equal(backend.readAt(file, bytes, 0), 6);
      assert.deepEqual([...bytes], [1, 9, 3, 0, 0, 7, 255, 255]);
      assert.equal(backend.readAt(file, bytes.subarray(0, 2), 4), 2);
      assert.deepEqual([...bytes.subarray(0, 2)], [0, 7]);
      assert.equal(backend.readAt(file, bytes, 100), 0);
      assert.equal(backend.readAt(file, new Uint8Array(0), 0), 0);
    });

    it("resizes with zero fill and discards truncated bytes", () => {
      const { backend, makeFileNode } = fixture;
      const file = makeFileNode(new Uint8Array([7, 8]));
      assert.equal(backend.resize(file, 4), 0);
      assert.equal(backend.fileSize(file), 4);
      const bytes = new Uint8Array(4);
      assert.equal(backend.readAt(file, bytes, 0), 4);
      assert.deepEqual([...bytes], [7, 8, 0, 0]);

      assert.equal(backend.resize(file, 1), 0);
      assert.equal(backend.fileSize(file), 1);
      assert.equal(backend.resize(file, 4), 0);
      assert.equal(backend.readAt(file, bytes, 0), 4);
      assert.deepEqual([...bytes], [7, 0, 0, 0]);
    });

    it("creates, lists, renames and removes live namespace entries", () => {
      const { backend, makeFileNode, makeDirNode } = fixture;
      const from = makeDirNode();
      const to = makeDirNode();
      const file = makeFileNode(new Uint8Array([1]));
      assert.equal(backend.createChild(from, "a", file), 0);
      assert.equal(backend.createChild(to, "b", makeFileNode()), 0);
      assert.equal(from.entries.a, file);
      assert.deepEqual(backend.listChildren(from), ["a"]);

      assert.equal(backend.renameChild(from, "a", to, "b"), 0);
      assert.equal(from.entries.a, undefined);
      assert.equal(to.entries.b, file);
      assert.deepEqual(backend.listChildren(from), []);
      assert.deepEqual(backend.listChildren(to), ["b"]);
      assert.equal(backend.removeChild(to, "b"), 0);
      assert.equal(to.entries.b, undefined);
      assert.deepEqual(backend.listChildren(to), []);
    });

    it("opens, syncs and closes files, and syncs directories", () => {
      const { backend, makeFileNode, makeDirNode } = fixture;
      const file = makeFileNode(new Uint8Array([1]));
      assert.equal(backend.openFile(file), 0);
      assert.equal(backend.sync(file), 0);
      assert.equal(backend.datasync(file), 0);
      backend.closeFile(file);
      const dir = makeDirNode();
      assert.equal(backend.sync(dir), 0);
      assert.equal(backend.datasync(dir), 0);
    });
  });
}
