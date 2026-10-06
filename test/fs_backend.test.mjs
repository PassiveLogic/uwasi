import assert from "node:assert/strict";
import { it } from "node:test";
import { WASI, useFS } from "uwasi";
import { FSErrno, FSError, MemoryFileSystem } from "uwasi/filesystem";
import { WASIAbi } from "../lib/esm/abi.js";
import { MemoryFSBackend } from "../lib/esm/memory/backend.js";
import { fsBackendContractSuite } from "./fs_backend_contract.mjs";
import {
  bindImports,
  sysCreate,
  sysWrite,
  sysReadText,
  sysSeekStart,
  sysSync,
  sysDatasync,
  sysClose,
  sysLink,
  sysLstat,
} from "./syscall_harness.mjs";

fsBackendContractSuite("memory", () => {
  const fs = new MemoryFileSystem({ "/": "/" });
  let serial = 0;
  return {
    backend: new MemoryFSBackend(),
    makeFileNode: (content = new Uint8Array(0)) =>
      fs.createFile(`/scratch/f${serial++}`, content),
    makeDirNode: () => fs.ensureDir(`/scratch/d${serial++}`),
  };
});

it("root useFS supplies working filesystem syscalls and provider preopens", () => {
  const fileSystem = new MemoryFileSystem({ "/store": "/" });
  const wasi = new WASI({
    preopens: { "/ignored": "/" },
    features: [
      useFS({ withBackend: new MemoryFSBackend(), withFileSystem: fileSystem }),
    ],
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.setInstance({ exports: { memory } });
  const h = {
    imports: wasi.wasiImport,
    view: new DataView(memory.buffer),
    bytes: new Uint8Array(memory.buffer),
  };
  assert.equal(h.imports.fd_prestat_get(3, 4096), 0);
  const length = h.view.getUint32(4100, true);
  assert.equal(h.imports.fd_prestat_dir_name(3, 512, length), 0);
  assert.equal(
    new TextDecoder().decode(h.bytes.subarray(512, 512 + length)),
    "/store",
  );

  const { errno, fd } = sysCreate(h, "file.txt");
  assert.equal(errno, 0);
  assert.deepEqual(sysWrite(h, fd, "stored bytes"), { errno: 0, written: 12 });
  assert.equal(sysSeekStart(h, fd), 0);
  h.bytes.fill(0, 512, 524);
  assert.deepEqual(sysReadText(h, fd), { errno: 0, text: "stored bytes" });
  assert.equal(sysSync(h, fd), 0);
  assert.equal(sysDatasync(h, fd), 0);
  assert.equal(sysClose(h, fd), 0);
});

it("maps FSError to errno but propagates unexpected backend errors", () => {
  const backend = new MemoryFSBackend();
  const h = bindImports(backend, new MemoryFileSystem({ "/": "/" }));
  const { errno, fd } = sysCreate(h, "file");
  assert.equal(errno, 0);
  backend.readAt = () => {
    throw new FSError(FSErrno.IO);
  };
  assert.equal(sysReadText(h, fd).errno, FSErrno.IO);

  const unexpected = new TypeError("backend programming error");
  backend.readAt = () => {
    throw unexpected;
  };
  assert.throws(
    () => sysReadText(h, fd),
    (error) => error === unexpected,
  );
  assert.equal(sysClose(h, fd), 0);
});

it("rolls back link bookkeeping when namespace creation fails", () => {
  class FailingLinkBackend extends MemoryFSBackend {
    createChild(parent, name, node) {
      if (node.nlink > 1) throw new FSError(FSErrno.IO);
      return super.createChild(parent, name, node);
    }
  }
  const h = bindImports(
    new FailingLinkBackend(),
    new MemoryFileSystem({ "/": "/" }),
  );
  const { errno, fd } = sysCreate(h, "src");
  assert.equal(errno, 0);
  assert.equal(sysClose(h, fd), 0);
  assert.equal(sysLink(h, "src", "dst"), FSErrno.IO);
  const source = sysLstat(h, "src");
  assert.equal(source.errno, 0);
  assert.equal(source.nlink, 1);
  assert.equal(sysLstat(h, "dst").errno, WASIAbi.WASI_ERRNO_NOENT);
});
