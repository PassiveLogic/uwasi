// An OPFS store as an earlier build of uwasi's OPFS backend left it: every
// file's durable bytes, base64-encoded, by name. Its namespace is binary
// records under the magics "UWS1" (snapshot slots) and "UWL1" (change log),
// with checksums that do not cover the magic. The current backend must
// refuse it, unchanged, rather than mistake its slots for torn writes and
// open it as empty.
//
// Written by a development build of that format (the OPFS backend as of
// commit 736c36cf1e, never published), with the test mock of that build:
// create({ spareFiles: 1 }), mkdir docs, then docs/alpha and notes written
// and fd_sync'd, persistAll() (so both slots hold a snapshot), beta
// written, synced and renamed to docs/beta, gone written, synced and
// unlinked (so the log holds records), and close(). To regenerate, run
// that sequence against such a build and print `durableContent(name)` of
// every name in `rootNames()` as base64.
export const UWS1_STORE = {
  ".uwasi.data.0": "YWxwaGEgY29udGVudA==",
  ".uwasi.data.1": "bm90ZXMgY29udGVudA==",
  ".uwasi.data.2": "YmV0YSBjb250ZW50",
  ".uwasi.data.3": "",
  ".uwasi.meta.0":
    "VVdTMSIAAADJhW5FAgEAA2RldgEBAARkb2NzAgICBWFscGhhAAIABW5vdGVzAQ==",
  ".uwasi.meta.1": "VVdTMQgAAABoAbegAQEAA2RldgE=",
  ".uwasi.meta.log":
    "VVdMMacvpFYCAAAAAAAAAAgAAAAJVbBgAgAEYmV0YQINAAAAND4CtgUABGJldGECBGJldGEIAAAAqDElYgIABGdvbmUDBwAAAFGqHqIEAARnb25l",
};
