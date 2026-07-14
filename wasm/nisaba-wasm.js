/**
 * nisaba-wasm.js — standalone WASM-backed document database engine,
 * buildable and usable independently of the rest of the parent project
 * (see build-wasm.sh in this directory).
 *
 * Extracted verbatim from the parent project's src/binjson-wasm.js (its
 * own combined WASM module bundles this together with the parent's own
 * CLI-facing exports, and keeps its own copy of this same logic rather
 * than depending on this package) -- this file is that file's entire
 * content: the binjson codec, BPlusTree/RTree/TextLog/TextIndex (and
 * their own dependencies -- geo, diff, stemmer), and the Db/Collection/
 * ChangeStream/StorageProvider/Client layer built on top of them. All of
 * it travels together because this package's own combined WASM binary
 * links the same C sources together for the same reason: db.c's CRUD
 * functions call bplustree/rtree/textindex functions directly (real
 * link-time calls, not just shared headers), so the JS wrapper classes
 * for those structures must run against this exact same WASM module
 * instance too -- a BPlusTree opened against a *different* module's
 * linear memory can't be attached to this module's dc_collection as a
 * secondary index.
 *
 * Depends on binjson (this package's own third_party/binjson submodule),
 * used here purely for its JS value types (ObjectId/Pointer/TYPE) and
 * OPFS helpers (MemoryHandle/exists/deleteFile/getFileHandle) -- see
 * third_party/binjson-structures/wasm/binjson-structures-wasm.js (which
 * this file's tree-wrapper classes were themselves extracted from) for
 * why every independently-buildable WASM module here keeps its own
 * self-contained copy of the codec rather than importing another
 * package's WASM instance.
 *
 * The cloud SaaS layer that runs this as a service (control plane,
 * REST/WebSocket gateways, the MongoClient-shaped driver) is NOT part
 * of this package -- it lives in the parent project's service/ and
 * client/ directories, built on top of the Db/Client this file exports,
 * the same way any other application would consume it.
 *
 * The WASM module loads asynchronously; call and await `ready()` once
 * before using any of these synchronously-shaped APIs.
 */
import createModule from './lib/nisaba.wasm.mjs';
import {
  TYPE,
  ObjectId,
  Pointer,
  MemoryHandle,
  exists,
  deleteFile,
  getFileHandle
} from '../third_party/binjson/js/binjson.js';

// Event tags — must match the BJW_EV_* constants in c/binjson_wasm.c.
const EV = {
  NULL: 0, FALSE: 1, TRUE: 2, INT: 3, FLOAT: 4, STRING: 5, OID: 6,
  DATE: 7, POINTER: 8, BINARY: 9, ARR_BEGIN: 10, ARR_END: 11,
  OBJ_BEGIN: 12, KEY: 13, OBJ_END: 14
};

// Error codes — must match the BJ_ERR_* constants in c/binjson.h.
const ERR = {
  [-1]: 'out of memory',
  [-2]: 'builder state error',
  [-3]: 'Unexpected end of data',
  [-4]: 'Unknown type byte',
  [-5]: 'Decoded integer exceeds safe range',
  [-6]: 'Pointer offset out of valid range',
  [-7]: 'Maximum nesting depth exceeded',
  [-8]: 'Structural invariant violated',
  [-9]: 'Argument out of range',
  [-10]: 'Duplicate _id',
  [-11]: 'replaceOne cannot change the _id of an existing document',
  [-12]: 'Duplicate key: a unique index already has a document with these field values'
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let Module = null;
let readyPromise = null;

/**
 * Instantiate the WASM module. Idempotent; returns a promise that resolves when
 * encode/decode are usable. Must be awaited before the first encode/decode.
 */
function ready() {
  if (!readyPromise) {
    readyPromise = createModule().then((m) => { Module = m; return m; });
  }
  return readyPromise;
}

/** True once the module is instantiated and encode/decode may be called. */
function isReady() {
  return Module !== null;
}

function requireModule() {
  if (!Module) {
    throw new Error('binjson-wasm not initialized: await ready() before encode/decode');
  }
  return Module;
}

function codeError(code, context) {
  const msg = ERR[code] || `binjson error ${code}`;
  return new Error(context ? `${msg} (${context})` : msg);
}

function check(code) {
  if (code !== 0) throw codeError(code);
}

/**
 * Copy `bytes` into the WASM heap, invoke `fn(ptr, len)`, then free. The C
 * builder copies immediately, so the scratch allocation is safe to release.
 */
function withBytes(M, bytes, fn) {
  const n = bytes.length;
  const ptr = n ? M._malloc(n) : 0;
  if (n) M.HEAPU8.set(bytes, ptr);
  try {
    return fn(ptr, n);
  } finally {
    if (n) M._free(ptr);
  }
}

function writeValue(M, val) {
  if (val === null) { check(M._bjw_put_null()); return; }
  if (val === false) { check(M._bjw_put_bool(0)); return; }
  if (val === true) { check(M._bjw_put_bool(1)); return; }

  if (val instanceof ObjectId) {
    withBytes(M, val.toBytes(), (p) => check(M._bjw_put_oid(p)));
    return;
  }
  if (val instanceof Date) { check(M._bjw_put_date(val.getTime())); return; }
  if (val instanceof Pointer) { check(M._bjw_put_pointer(val.offset)); return; }
  if (val instanceof Uint8Array) {
    withBytes(M, val, (p, n) => check(M._bjw_put_binary(p, n)));
    return;
  }

  const t = typeof val;
  if (t === 'number') {
    if (Number.isInteger(val) && Number.isSafeInteger(val)) check(M._bjw_put_int(val));
    else check(M._bjw_put_float(val));
    return;
  }
  if (t === 'string') {
    withBytes(M, textEncoder.encode(val), (p, n) => check(M._bjw_put_string(p, n)));
    return;
  }
  if (Array.isArray(val)) {
    check(M._bjw_begin_array());
    for (const item of val) writeValue(M, item);
    check(M._bjw_end_array());
    return;
  }
  if (t === 'object') {
    check(M._bjw_begin_object());
    for (const key of Object.keys(val)) {
      withBytes(M, textEncoder.encode(key), (p, n) => check(M._bjw_put_key(p, n)));
      writeValue(M, val[key]);
    }
    check(M._bjw_end_object());
    return;
  }
  throw new Error(`Unsupported type: ${t}`);
}

/**
 * Encode a JavaScript value to binjson binary format.
 * @returns {Uint8Array}
 */
function encode(value) {
  const M = requireModule();
  check(M._bjw_enc_reset());
  writeValue(M, value);
  const len = M._bjw_enc_finish();
  if (len < 0) throw codeError(len, 'encode');
  const ptr = M._bjw_enc_ptr();
  // Copy out: the builder buffer is reused on the next encode call.
  return M.HEAPU8.slice(ptr, ptr + len);
}

/** Rebuild a JS value from the flat event stream emitted by the C decoder. */
function readEvents(M, ptr, len) {
  const heap = M.HEAPU8;
  const dv = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
  const stack = [];
  let root;
  let off = ptr;
  const end = ptr + len;

  const emit = (v) => {
    if (stack.length === 0) { root = v; return; }
    const top = stack[stack.length - 1];
    if (top.isObject) { top.value[top.key] = v; top.key = undefined; }
    else top.value.push(v);
  };

  while (off < end) {
    const tag = heap[off++];
    switch (tag) {
      case EV.NULL: emit(null); break;
      case EV.FALSE: emit(false); break;
      case EV.TRUE: emit(true); break;
      case EV.INT: emit(dv.getFloat64(off, true)); off += 8; break;
      case EV.FLOAT: emit(dv.getFloat64(off, true)); off += 8; break;
      case EV.DATE: emit(new Date(dv.getFloat64(off, true))); off += 8; break;
      case EV.POINTER: emit(new Pointer(dv.getFloat64(off, true))); off += 8; break;
      case EV.STRING: {
        const n = dv.getUint32(off, true); off += 4;
        emit(textDecoder.decode(heap.subarray(off, off + n))); off += n;
        break;
      }
      case EV.KEY: {
        const n = dv.getUint32(off, true); off += 4;
        stack[stack.length - 1].key = textDecoder.decode(heap.subarray(off, off + n));
        off += n;
        break;
      }
      case EV.BINARY: {
        const n = dv.getUint32(off, true); off += 4;
        emit(heap.slice(off, off + n)); off += n;
        break;
      }
      case EV.OID: {
        emit(new ObjectId(heap.slice(off, off + 12))); off += 12;
        break;
      }
      case EV.ARR_BEGIN: off += 4; stack.push({ isObject: false, value: [] }); break;
      case EV.OBJ_BEGIN: off += 4; stack.push({ isObject: true, value: {}, key: undefined }); break;
      case EV.ARR_END:
      case EV.OBJ_END: emit(stack.pop().value); break;
      default: throw new Error(`binjson: bad event tag ${tag}`);
    }
  }
  return root;
}

/**
 * Decode binjson binary data to a JavaScript value.
 * @param {Uint8Array|ArrayBuffer} data
 */
function decode(data) {
  const M = requireModule();
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const n = u8.length;
  const inPtr = n ? M._malloc(n) : 0;
  if (n) M.HEAPU8.set(u8, inPtr);

  let rc;
  try {
    rc = M._bjw_decode(inPtr, n);
  } finally {
    if (n) M._free(inPtr);
  }
  if (rc !== 0) throw codeError(rc, 'decode');

  const evPtr = M._bjw_events_ptr();
  const evLen = M._bjw_events_len();
  return readEvents(M, evPtr, evLen);
}

/**
 * Total on-wire size of the value whose leading bytes are `header`, computed by
 * the C codec (bj_value_size). `header` only needs the type byte plus, for
 * length-prefixed/container types, the 4-byte size field (i.e. up to 5 bytes).
 */
function wasmValueSize(M, header) {
  const n = header.length;
  const inPtr = M._malloc(n + 4);
  M.HEAPU8.set(header, inPtr);
  const outPtr = inPtr + n;
  const rc = M._bjw_value_size(inPtr, n, 0, outPtr);
  let size = 0;
  if (rc === 0) {
    size = new DataView(M.HEAPU8.buffer).getUint32(outPtr, true);
  }
  M._free(inPtr);
  if (rc !== 0) throw codeError(rc, 'value_size');
  return size;
}

/**
 * On-wire size (in bytes) of the top-level value whose leading bytes are
 * `header`, computed by the C codec. `header` only needs the type byte plus,
 * for length-prefixed/container types, the 4-byte size field (i.e. up to 5
 * bytes). Await ready() before calling. Useful for scanning append-only files
 * of concatenated records without decoding each one.
 */
function valueSize(header) {
  const M = requireModule();
  return wasmValueSize(M, header instanceof Uint8Array ? header : new Uint8Array(header));
}

/**
 * OPFS-backed file using a FileSystemSyncAccessHandle, with the binjson codec
 * running in WASM. Byte-level work (encode/decode + scan record sizing) is done
 * in C; only the raw synchronous handle calls (read/write/truncate/getSize/
 * flush) — which are browser APIs with no WASM equivalent — stay in JS.
 *
 * As with the reference, this requires FileSystemSyncAccessHandle (Web Workers)
 * and the WASM module to be initialized (await ready() first).
 */
class BinJsonFile {
  constructor(syncAccessHandle) {
    if (!syncAccessHandle) {
      throw new Error('FileSystemSyncAccessHandle is required');
    }
    this.syncAccessHandle = syncAccessHandle;
  }

  /** Read a range of bytes, returning only what was actually read. */
  #readRange(start, length) {
    const buffer = new Uint8Array(length);
    const bytesRead = this.syncAccessHandle.read(buffer, { at: start });
    return bytesRead < length ? buffer.slice(0, bytesRead) : buffer;
  }

  getFileSize() {
    return this.syncAccessHandle.getSize();
  }

  /** Encode and write `data`, replacing any existing content. */
  write(data) {
    const binaryData = encode(data);
    this.syncAccessHandle.truncate(0);
    this.syncAccessHandle.write(binaryData, { at: 0 });
  }

  /** Read and decode the value at `pointer` (default: start of file). */
  read(pointer = new Pointer(0)) {
    const fileSize = this.getFileSize();
    if (fileSize === 0) {
      throw new Error('File is empty');
    }
    const pointerValue = pointer.valueOf();
    if (pointerValue < 0 || pointerValue >= fileSize) {
      throw new Error(`Pointer offset ${pointer} out of file bounds [0, ${fileSize})`);
    }
    const binaryData = this.#readRange(pointerValue, fileSize - pointerValue);
    return decode(binaryData);
  }

  /** Encode and append `data` without truncating existing content. */
  append(data) {
    const binaryData = encode(data);
    const existingSize = this.getFileSize();
    this.syncAccessHandle.write(binaryData, { at: existingSize });
  }

  flush() {
    this.syncAccessHandle.flush();
  }

  /**
   * Yield each top-level record in the file, decoded one at a time as
   * `{ value, offset, size }`, where `offset` is the record's byte position in
   * the file and `size` is the number of bytes it occupies.
   */
  *scan() {
    const fileSize = this.getFileSize();
    if (fileSize === 0) return;

    const M = requireModule();
    let offset = 0;
    while (offset < fileSize) {
      // The value-size header needs at most type byte + 4-byte length field.
      const headerLen = Math.min(5, fileSize - offset);
      const header = this.#readRange(offset, headerLen);
      const valueSize = wasmValueSize(M, header);

      const valueData = this.#readRange(offset, valueSize);
      const valueOffset = offset;
      offset += valueSize;
      yield { value: decode(valueData), offset: valueOffset, size: valueSize };
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers for the tree/index/log/diff/stemmer wrappers below.
// ---------------------------------------------------------------------------

// Aliases so the copied wrappers can keep using their original names.
const encoder = textEncoder;
const decoder = textDecoder;

/**
 * Host I/O registry for the file-resident C structures (c/hostio.c).
 *
 * Each open FileSystemSyncAccessHandle is registered under an integer slot in
 * `Module.bjioHandles`; the C side reads and writes the file through EM_JS
 * imports that index this table and pass HEAPU8 subarray views straight to the
 * handle's synchronous read/write — the bytes move directly between the file
 * and WASM memory with no intermediate copies, and no copy of the file is ever
 * held in memory on either side of the bridge.
 */
let nextBjioFd = 1;

function registerHandle(M, syncHandle) {
  if (!M.bjioHandles) M.bjioHandles = {};
  const fd = nextBjioFd++;
  M.bjioHandles[fd] = syncHandle;
  return fd;
}

function unregisterHandle(M, fd) {
  if (M.bjioHandles) delete M.bjioHandles[fd];
}

/** Copy a JS string into the heap as UTF-8; returns { ptr, len, free }. */
function allocStr(M, str) {
  const bytes = textEncoder.encode(str);
  const len = bytes.length;
  const ptr = M._malloc(len || 1);
  if (len) M.HEAPU8.set(bytes, ptr);
  return { ptr, len, free() { M._free(ptr); } };
}

/** Little-endian u32 read from the heap (HEAPU32 isn't exported). */
function readU32(M, addr) {
  const b = M.HEAPU8;
  return (b[addr] | (b[addr + 1] << 8) | (b[addr + 2] << 16) | (b[addr + 3] * 0x1000000)) >>> 0;
}

/** Little-endian signed i32 read from the heap -- for out-params carrying a BJ_ERR_* code (can be negative). */
function readI32(M, addr) {
  return readU32(M, addr) | 0;
}

/** Copy a JS string into the heap as UTF-8; returns { ptr, len }. */
function writeBytes(M, str) {
  const bytes = encoder.encode(str);
  const ptr = M._malloc(bytes.length || 1);
  if (bytes.length) M.HEAPU8.set(bytes, ptr);
  return { ptr, len: bytes.length };
}

/** Copy a JS string into the heap as a NUL-terminated C string; returns ptr. */
function writeCString(M, str) {
  const bytes = encoder.encode(str);
  const ptr = M._malloc(bytes.length + 1);
  if (bytes.length) M.HEAPU8.set(bytes, ptr);
  M.HEAPU8[ptr + bytes.length] = 0;
  return ptr;
}

/**
 * Read a (uint8_t** out, size_t* outlen) result the C side malloc'd, decode it
 * as UTF-8, and free the C buffer. `outPP`/`outLP` are heap slots holding the
 * pointer and length.
 */
function takeOut(M, outPP, outLP) {
  const outPtr = readU32(M, outPP);
  const outLen = readU32(M, outLP);
  const bytes = M.HEAPU8.slice(outPtr, outPtr + outLen);
  if (outPtr) M._free(outPtr);
  return decoder.decode(bytes);
}

// ---------------------------------------------------------------------------
// B+ tree
// ---------------------------------------------------------------------------

/**
 * Order-preserving byte encoding of one scalar key part, so the B+ tree's
 * byte-wise (memcmp) key comparison reproduces the value's natural order.
 * Numbers encode to a 9-byte sequence (a 0x00 tag then a sign-normalized
 * big-endian IEEE-754 double); strings to a 0x01 tag, their UTF-8 bytes, and a
 * 0x00 terminator. The number tag sorts before the string tag, matching the
 * tree's "numbers before strings" rule, and both forms are self-delimiting so
 * they can be concatenated (see compositeKey). String parts must not contain
 * U+0000 (reserved as the terminator, matching the engine's NUL convention).
 *
 * @param {number|string} value
 * @returns {Uint8Array}
 */
function orderedKey(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new Error('orderedKey: NaN has no ordering');
    if (value === 0) value = 0; // normalize -0 to +0 so they compare equal
    const out = new Uint8Array(9);
    out[0] = 0x00; // number tag (sorts before strings)
    const dv = new DataView(out.buffer);
    dv.setFloat64(1, value, false); // big-endian
    // Total-order transform: flip the sign bit for positives, all bits for
    // negatives, so unsigned byte order matches numeric order.
    if (out[1] & 0x80) { for (let i = 1; i < 9; i++) out[i] ^= 0xff; }
    else out[1] ^= 0x80;
    return out;
  }
  if (typeof value === 'string') {
    const body = textEncoder.encode(value);
    for (let i = 0; i < body.length; i++) {
      if (body[i] === 0) throw new Error('orderedKey: string key must not contain U+0000');
    }
    const out = new Uint8Array(body.length + 2);
    out[0] = 0x01; // string tag
    out.set(body, 1);
    out[out.length - 1] = 0x00; // terminator keeps prefixes ordered correctly
    return out;
  }
  throw new Error(`orderedKey: unsupported part type: ${typeof value}`);
}

/**
 * Build a composite B+ tree key from ordered parts — the convention for
 * duplicate / secondary indexes, where the tree itself is unique-key. Encode
 * the indexed value(s) followed by the primary key:
 *   tree.add(compositeKey(tag, postId), postId)
 * All entries sharing a leading value then form a contiguous range; retrieve
 * them with a range/cursor scan whose lower bound is compositeKey(...prefix)
 * and whose upper bound appends 0xff bytes (compositeUpperBound). The row
 * reference lives in the value, so the composite key is never decoded back.
 *
 * @param {...(number|string)} parts
 * @returns {Uint8Array}
 */
function compositeKey(...parts) {
  const encoded = parts.map(orderedKey);
  let total = 0;
  for (const e of encoded) total += e.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const e of encoded) { out.set(e, at); at += e.length; }
  return out;
}

/**
 * Upper bound for scanning every composite key that begins with `parts`: the
 * prefix followed by 0xff. Because each part's encoding is self-delimiting, a
 * real continuation always starts with a tag byte (0x00/0x01) below 0xff, so
 * this sorts after every key extending the prefix yet before the next distinct
 * prefix value. Use as the max bound of a range/cursor scan grouped by `parts`
 * (bpt_range is inclusive; this sentinel is never itself a stored key).
 *
 * @param {...(number|string)} parts
 * @returns {Uint8Array}
 */
function compositeUpperBound(...parts) {
  const prefix = compositeKey(...parts);
  const out = new Uint8Array(prefix.length + 1);
  out.set(prefix, 0);
  out[prefix.length] = 0xff;
  return out;
}

/**
 * Persistent immutable B+ tree with append-only WASM-backed storage.
 * Mirrors the API of the original (since removed) pure-JS implementation.
 *
 * The tree is unique-key (add is an upsert). For duplicate / secondary-index
 * access, store composite keys built with compositeKey()/orderedKey() and scan
 * grouped ranges with compositeUpperBound(); string and Uint8Array keys are
 * both accepted (Uint8Array bytes pass through verbatim).
 */
class BPlusTree {
  /**
   * @param {FileSystemSyncAccessHandle} syncHandle - storage file handle
   * @param {number} order - tree order (default 3, minimum 3)
   *
   * The tree is durable: every add/delete writes its appended bytes straight
   * through to the file handle (matching the write-through model of
   * the original JS design), so data survives a crash before close().
   */
  constructor(syncHandle, order = 3) {
    if (order < 3) {
      throw new Error('B+ tree order must be at least 3');
    }
    this.syncAccessHandle = syncHandle;
    this.order = order;
    this.isOpen = false;
    this.ctx = 0;
    this._fd = 0;
    this._size = 0;
  }

  /**
   * Open the tree against the file handle. The C side is file-resident: it
   * reads nodes from the handle on demand and writes each mutation's records
   * straight through, so nothing is buffered here and data survives a crash
   * before close() (matching the original JS model).
   */
  async open() {
    if (this.isOpen) {
      throw new Error('Tree is already open');
    }
    const M = await ready();

    this._fd = registerHandle(M, this.syncAccessHandle);
    const fileSize = this.syncAccessHandle.getSize();
    if (fileSize > 0) {
      this.ctx = M._bptw_open(this._fd);
      if (!this.ctx) {
        unregisterHandle(M, this._fd);
        await this.syncAccessHandle.close(); // isOpen never becomes true, so this.close() can't reach it -- must release it here
        throw new Error('Invalid tree file');
      }
      this.order = M._bptw_order(this.ctx);
    } else {
      this.ctx = M._bptw_create(this._fd, this.order);
      if (!this.ctx) {
        unregisterHandle(M, this._fd);
        await this.syncAccessHandle.close();
        throw new Error('Failed to create B+ tree');
      }
    }
    this._size = M._bptw_size(this.ctx);
    this.isOpen = true;
  }

  /** fsync the file handle (all writes are already on it). */
  flush() {
    this.syncAccessHandle.flush();
  }

  /** Close the sync handle and release the WASM context. */
  async close() {
    if (!this.isOpen) return;
    if (this.syncAccessHandle) {
      this.flush();
      await this.syncAccessHandle.close();
    }
    if (this.ctx) {
      Module._bptw_free(this.ctx);
      this.ctx = 0;
    }
    unregisterHandle(Module, this._fd);
    this._fd = 0;
    this.isOpen = false;
  }

  /** Allocate a marshalled key; caller must call .free(). */
  #allocKey(key) {
    const M = Module;
    if (typeof key === 'number') {
      return { type: 0, num: key, ptr: 0, len: 0, free() {} };
    }
    // A string key marshals as its UTF-8 bytes; a Uint8Array is passed
    // verbatim (opaque byte-string key). Both are string-type keys on the C
    // side (compared byte-for-byte), so composite / order-preserving keys
    // built with compositeKey()/orderedKey() flow through unchanged.
    let bytes = null;
    if (typeof key === 'string') bytes = textEncoder.encode(key);
    else if (key instanceof Uint8Array) bytes = key;
    if (bytes) {
      const len = bytes.length;
      const ptr = len ? M._malloc(len) : 0;
      if (len) M.HEAPU8.set(bytes, ptr);
      return { type: 1, num: 0, ptr, len, free() { if (len) M._free(ptr); } };
    }
    throw new Error(`Unsupported key type: ${typeof key}`);
  }

  /** Insert or update a key-value pair. */
  add(key, value) {
    const M = requireModule();
    const k = this.#allocKey(key);
    const vbytes = encode(value);
    const vlen = vbytes.length;
    const vptr = vlen ? M._malloc(vlen) : 0;
    if (vlen) M.HEAPU8.set(vbytes, vptr);
    try {
      const rc = M._bptw_add(this.ctx, k.type, k.num, k.ptr, k.len, vptr, vlen);
      if (rc !== 0) throw codeError(rc, 'add');
      this._size = M._bptw_size(this.ctx);
    } finally {
      k.free();
      if (vlen) M._free(vptr);
    }
  }

  /** Search for a key; returns the value or undefined. */
  search(key) {
    const M = requireModule();
    const k = this.#allocKey(key);
    try {
      const rc = M._bptw_search(this.ctx, k.type, k.num, k.ptr, k.len);
      if (rc < 0) throw codeError(rc, 'search');
      if (rc === 0) return undefined;
      return this.#readOut(M, 'search');
    } finally {
      k.free();
    }
  }

  /** Decode this tree's last output buffer (scoped to the handle: calls on
   * other trees don't disturb it). Throws if the length overflows the
   * boundary's int. */
  #readOut(M, op) {
    const ptr = M._bptw_out_ptr(this.ctx);
    const len = M._bptw_out_len(this.ctx);
    if (len < 0) throw codeError(len, op);
    return decode(M.HEAPU8.slice(ptr, ptr + len));
  }

  /** Delete a key (no-op if absent). */
  delete(key) {
    const M = requireModule();
    const k = this.#allocKey(key);
    try {
      const rc = M._bptw_delete(this.ctx, k.type, k.num, k.ptr, k.len);
      if (rc !== 0) throw codeError(rc, 'delete');
      this._size = M._bptw_size(this.ctx);
    } finally {
      k.free();
    }
  }

  /** All entries as an array of { key, value } in sorted order. */
  toArray() {
    const M = requireModule();
    const rc = M._bptw_entries(this.ctx);
    if (rc !== 0) throw codeError(rc, 'toArray');
    return this.#readOut(M, 'toArray');
  }

  /** Entries with min <= key <= max, in sorted order. */
  rangeSearch(minKey, maxKey) {
    const M = requireModule();
    const kmin = this.#allocKey(minKey);
    const kmax = this.#allocKey(maxKey);
    try {
      const rc = M._bptw_range(
        this.ctx,
        kmin.type, kmin.num, kmin.ptr, kmin.len,
        kmax.type, kmax.num, kmax.ptr, kmax.len
      );
      if (rc !== 0) throw codeError(rc, 'rangeSearch');
      return this.#readOut(M, 'rangeSearch');
    } finally {
      kmin.free();
      kmax.free();
    }
  }

  /** Allocate an optional marshalled key: undefined/null means "no bound". */
  #allocKeyOpt(key) {
    if (key === undefined || key === null) {
      return { type: -1, num: 0, ptr: 0, len: 0, free() {} };
    }
    return this.#allocKey(key);
  }

  /**
   * Stream entries in sorted order through a C cursor, optionally bounded to
   * minKey <= key <= maxKey (either bound may be omitted). Memory is bounded
   * by the batch size, not the result size: the cursor reads one leaf at a
   * time and entries cross the bridge in ~64 KB batches.
   *
   * The cursor pins the tree's root at open, so iteration sees a consistent
   * snapshot even if the tree is mutated while iterating.
   */
  async *iterate(minKey, maxKey) {
    if (!this.isOpen) {
      throw new Error('Tree must be open before iteration');
    }
    const M = requireModule();
    const kmin = this.#allocKeyOpt(minKey);
    const kmax = this.#allocKeyOpt(maxKey);
    let cur;
    try {
      cur = M._bptw_cursor_open(
        this.ctx,
        kmin.type, kmin.num, kmin.ptr, kmin.len,
        kmax.type, kmax.num, kmax.ptr, kmax.len
      );
    } finally {
      kmin.free();
      kmax.free();
    }
    if (!cur) throw new Error('Failed to open cursor');
    try {
      // Batches grow from 2 KB to 64 KB: the first results arrive after a
      // couple of leaf reads (early termination stays cheap), while long
      // scans quickly reach full batch throughput.
      let batchBytes = 2048;
      for (;;) {
        if (!this.isOpen) throw new Error('Tree closed during iteration');
        const n = M._bptw_cursor_next(cur, batchBytes);
        if (n < 0) throw codeError(n, 'cursor');
        if (n === 0) return;
        const batch = this.#readOut(M, 'cursor');
        for (const entry of batch) yield entry;
        batchBytes = Math.min(batchBytes * 4, 65536);
      }
    } finally {
      M._bptw_cursor_free(cur);
    }
  }

  /** Async iterator over { key, value } entries in sorted order. */
  async *[Symbol.asyncIterator]() {
    yield* this.iterate();
  }

  /** Tree height (0 for a single leaf). */
  getHeight() {
    const M = requireModule();
    const h = M._bptw_height(this.ctx);
    if (h < 0) throw codeError(h, 'getHeight');
    return h;
  }

  /**
   * Walk every node checking the tree's structural invariants: key order
   * and routing-key consistency, node capacity, uniform leaf depth,
   * child-before-parent offsets (no cycles), and the entry count matching
   * the metadata size. Min-fill is deliberately not checked — JS-written
   * files never rebalance and are legitimately under-filled — and unary
   * internal nodes are legal (compaction emits them at level tails).
   * Returns true, or throws describing the corruption. O(N): a
   * testing/diagnostic tool, not an every-request check.
   */
  verify() {
    const M = requireModule();
    const rc = M._bptw_verify(this.ctx);
    if (rc !== 0) throw codeError(rc, 'verify');
    return true;
  }

  size() {
    return requireModule()._bptw_size(this.ctx);
  }

  isEmpty() {
    return this.size() === 0;
  }

  /**
   * Wrap a C-side read-only handle as a snapshot object: all read APIs work
   * (search, rangeSearch, toArray, iterate, size, compact), mutations throw.
   * The snapshot shares this tree's file handle without owning it — close
   * the snapshot before closing the parent tree.
   */
  #wrapSnapshot(ctx) {
    const M = requireModule();
    // A real instance (not Object.create) so private-field methods work.
    const snap = new BPlusTree(this.syncAccessHandle, M._bptw_order(ctx));
    snap.ctx = ctx;                 // shared file handle, not owned
    snap._fd = this._fd;
    snap._size = M._bptw_size(ctx);
    snap.isOpen = true;
    snap.isSnapshot = true;
    snap.open = async () => { throw new Error('Snapshot is already open'); };
    snap.close = async function () {
      if (!this.isOpen) return;
      requireModule()._bptw_free(this.ctx);
      this.ctx = 0;
      this.isOpen = false;
    };
    return snap;
  }

  /**
   * Read-only snapshot pinned at the current root. The file is append-only,
   * so the snapshot stays consistent while this tree keeps mutating (it
   * simply never sees later changes). Invalidated if the file is truncated
   * or replaced (e.g. adopting a compaction).
   */
  snapshot() {
    if (!this.isOpen) throw new Error('Tree file is not open');
    const ctx = requireModule()._bptw_snapshot(this.ctx);
    if (!ctx) throw new Error('Failed to create snapshot');
    return this.#wrapSnapshot(ctx);
  }

  /**
   * Read-only snapshot pinned at a historical commit boundary — an `offset`
   * from boundaries(). Time-travel: the tree exactly as it was when that
   * commit landed.
   */
  snapshotAt(offset) {
    if (!this.isOpen) throw new Error('Tree file is not open');
    const ctx = requireModule()._bptw_open_at(this._fd, offset);
    if (!ctx) throw new Error(`No commit boundary at offset ${offset}`);
    return this.#wrapSnapshot(ctx);
  }

  /**
   * Every verified commit boundary in the file, oldest first, as
   * [{ offset, size }] — offset opens that state via snapshotAt(), size is
   * the entry count it had. Scans the file.
   */
  boundaries() {
    if (!this.isOpen) throw new Error('Tree file is not open');
    const M = requireModule();
    const rc = M._bptw_boundaries(this.ctx);
    if (rc !== 0) throw codeError(rc, 'boundaries');
    return this.#readOut(M, 'boundaries');
  }

  /**
   * Compact into a fresh file, dropping stale append-only history and any
   * deletion cruft. The C side streams a minimal fully-packed tree (bulk
   * load) straight to the destination handle — nothing is materialized in
   * memory.
   * @param {FileSystemSyncAccessHandle} destSyncHandle
   * @returns {Promise<{oldSize:number,newSize:number,bytesSaved:number}>}
   */
  async compact(destSyncHandle) {
    if (!this.isOpen) {
      throw new Error('Tree file is not open');
    }
    if (!destSyncHandle) {
      throw new Error('Destination sync handle is required for compaction');
    }
    const M = requireModule();
    const oldSize = this.syncAccessHandle.getSize();

    destSyncHandle.truncate(0);
    const dstFd = registerHandle(M, destSyncHandle);
    try {
      const rc = M._bptw_compact(this.ctx, dstFd);
      if (rc !== 0) throw codeError(rc, 'compact');
    } finally {
      unregisterHandle(M, dstFd);
    }
    const newSize = destSyncHandle.getSize();
    destSyncHandle.flush();
    await destSyncHandle.close();

    return {
      oldSize,
      newSize,
      bytesSaved: Math.max(0, oldSize - newSize)
    };
  }
}

// ---------------------------------------------------------------------------
// R-tree
// ---------------------------------------------------------------------------

/**
 * Haversine distance in kilometers, computed by the WASM libm (c/geo.c).
 * Requires the module to be instantiated — call ready() (or open() a tree)
 * first.
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  return requireModule()._rtw_haversine(lat1, lng1, lat2, lng2);
}

/**
 * Persistent on-disk R-tree with append-only WASM-backed storage.
 * Mirrors the API of the original (since removed) pure-JS implementation.
 */
class RTree {
  /**
   * @param {FileSystemSyncAccessHandle} syncHandle - storage file handle
   * @param {number} maxEntries - node capacity (default 9, minimum 2)
   *
   * The tree is durable: every mutation writes its appended bytes straight
   * through to the file handle (matching the write-through model of
   * the original JS design), so data survives a crash before close().
   */
  constructor(syncHandle, maxEntries = 9) {
    this.syncAccessHandle = syncHandle;
    this.maxEntries = maxEntries;
    this.isOpen = false;
    this.ctx = 0;
    this._fd = 0;
    this._size = 0;

    // Shim exposing file size, used by some tests (tree.file.getFileSize()).
    this.file = {
      getFileSize: () => this.syncAccessHandle.getSize()
    };
  }

  /**
   * Open the tree against the file handle. The C side is file-resident: it
   * reads nodes from the handle on demand and writes each mutation's records
   * straight through (matching the original JS model).
   */
  async open() {
    if (this.isOpen) {
      throw new Error('R-tree is already open');
    }
    const M = await ready();

    this._fd = registerHandle(M, this.syncAccessHandle);
    const fileSize = this.syncAccessHandle.getSize();
    if (fileSize > 0) {
      this.ctx = M._rtw_open(this._fd);
      if (!this.ctx) {
        unregisterHandle(M, this._fd);
        await this.syncAccessHandle.close(); // isOpen never becomes true, so this.close() can't reach it -- must release it here
        throw new Error('Invalid R-tree file');
      }
      this.maxEntries = M._rtw_max_entries(this.ctx);
    } else {
      this.ctx = M._rtw_create(this._fd, this.maxEntries);
      if (!this.ctx) {
        unregisterHandle(M, this._fd);
        await this.syncAccessHandle.close();
        throw new Error('Failed to create R-tree');
      }
    }
    this._size = M._rtw_size(this.ctx);
    this.isOpen = true;
  }

  /** fsync the file handle (all writes are already on it). */
  flush() {
    this.syncAccessHandle.flush();
  }

  /** Close the sync handle and release the WASM context. */
  async close() {
    if (!this.isOpen) return;
    if (this.syncAccessHandle) {
      this.flush();
      await this.syncAccessHandle.close();
    }
    if (this.ctx) {
      Module._rtw_free(this.ctx);
      this.ctx = 0;
    }
    unregisterHandle(Module, this._fd);
    this._fd = 0;
    this.isOpen = false;
  }

  /**
   * Insert a point (lat, lng) associated with an ObjectId.
   *
   * ObjectId uniqueness is the caller's contract: duplicates are never
   * checked, so inserting the same id twice stores two independent entries
   * and remove() takes out only one of them.
   */
  insert(lat, lng, objectId) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    if (!(objectId instanceof ObjectId)) {
      throw new Error('objectId must be an instance of ObjectId to insert into rtree');
    }
    const M = requireModule();
    const bytes = objectId.toBytes();
    const ptr = M._malloc(12);
    M.HEAPU8.set(bytes, ptr);
    try {
      const rc = M._rtw_insert(this.ctx, lat, lng, ptr);
      if (rc !== 0) throw codeError(rc, 'insert');
      this._size = M._rtw_size(this.ctx);
    } finally {
      M._free(ptr);
    }
  }

  /**
   * Remove the entry for an ObjectId. Returns true if one was removed.
   * Pass the entry's stored coordinates when known: OIDs have no spatial
   * locality, so a blind remove probes subtrees in order (worst-case the
   * whole tree) while a located remove prunes to the point's path. A wrong
   * point finds nothing and returns false.
   */
  remove(objectId, lat, lng) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    if (!(objectId instanceof ObjectId)) {
      throw new Error('objectId must be an instance of ObjectId to remove from rtree');
    }
    const located = typeof lat === 'number' && typeof lng === 'number';
    const M = requireModule();
    const bytes = objectId.toBytes();
    const ptr = M._malloc(12);
    M.HEAPU8.set(bytes, ptr);
    try {
      const rc = located
        ? M._rtw_remove_at(this.ctx, lat, lng, ptr)
        : M._rtw_remove(this.ctx, ptr);
      if (rc < 0) throw codeError(rc, 'remove');
      this._size = M._rtw_size(this.ctx);
      return rc === 1;
    } finally {
      M._free(ptr);
    }
  }

  /**
   * Stream bounding-box matches without materializing the result set:
   * yields { objectId, lat, lng } in bounded batches, pinned to the tree
   * state at the first pull (append-only snapshot semantics). Early
   * termination reads only the nodes already visited.
   */
  async *iterateBBox(bbox) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    const M = requireModule();
    const cur = M._rtw_cursor_open(this.ctx, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
    if (!cur) throw new Error('Failed to open cursor');
    try {
      let batchBytes = 2048;
      for (;;) {
        const n = M._rtw_cursor_next(cur, batchBytes);
        if (n < 0) throw codeError(n, 'iterateBBox');
        if (n === 0) return;
        const entries = this._readOut(M, 'iterateBBox');
        for (const e of entries) yield e;
        batchBytes = Math.min(batchBytes * 4, 65536);
      }
    } finally {
      M._rtw_cursor_free(cur);
    }
  }

  /**
   * The k nearest entries to a point, best-first over node bounding boxes —
   * reads only subtrees that can beat the current candidates. Returns
   * [{ objectId, lat, lng, distance }] by ascending haversine km.
   */
  nearest(lat, lng, k) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    const M = requireModule();
    const rc = M._rtw_nearest(this.ctx, lat, lng, k);
    if (rc !== 0) throw codeError(rc, 'nearest');
    return this._readOut(M, 'nearest');
  }

  /** Decode this tree's last output buffer (scoped to the handle: calls on
   * other trees don't disturb it). Throws if the length overflows the
   * boundary's int. */
  _readOut(M, op) {
    const ptr = M._rtw_out_ptr(this.ctx);
    const len = M._rtw_out_len(this.ctx);
    if (len < 0) throw codeError(len, op);
    if (len === 0) return [];
    return decode(M.HEAPU8.slice(ptr, ptr + len));
  }

  /** Candidate entries whose point falls inside a bounding box. */
  _searchBBoxRaw(bbox) {
    const M = requireModule();
    const rc = M._rtw_search(this.ctx, bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
    if (rc !== 0) throw codeError(rc, 'searchBBox');
    return this._readOut(M, 'searchBBox');
  }

  /** Search for points within a bounding box; returns { objectId, lat, lng }. */
  searchBBox(bbox) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    return this._searchBBoxRaw(bbox);
  }

  /**
   * Search for points within a radius (km) of a location; returns
   * { objectId, lat, lng, distance }. The radius-to-bbox conversion, tree
   * traversal and haversine distance filter all run in C (c/geo.c + rtree.c).
   */
  searchRadius(lat, lng, radiusKm) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    const M = requireModule();
    const rc = M._rtw_search_radius(this.ctx, lat, lng, radiusKm);
    if (rc !== 0) throw codeError(rc, 'searchRadius');
    return this._readOut(M, 'searchRadius');
  }

  /** Drop all entries by appending a fresh empty root. */
  async clear() {
    const M = requireModule();
    const rc = M._rtw_clear(this.ctx);
    if (rc !== 0) throw codeError(rc, 'clear');
    this._size = 0;
  }

  size() {
    return this._size;
  }

  isEmpty() {
    return this._size === 0;
  }

  /**
   * Compact into a fresh file, dropping stale append-only history.
   * @param {FileSystemSyncAccessHandle} destSyncHandle
   * @returns {Promise<{oldSize:number,newSize:number,bytesSaved:number}>}
   */
  async compact(destSyncHandle) {
    if (!this.isOpen) {
      throw new Error('R-tree file must be opened before use');
    }
    if (!destSyncHandle) {
      throw new Error('Destination sync handle is required for compaction');
    }
    const M = requireModule();
    const oldSize = this.syncAccessHandle.getSize();

    // The C side streams the compacted records straight to the destination
    // handle in chunks; the compacted file is never materialized in memory.
    destSyncHandle.truncate(0);
    const dstFd = registerHandle(M, destSyncHandle);
    try {
      const rc = M._rtw_compact(this.ctx, dstFd);
      if (rc !== 0) throw codeError(rc, 'compact');
    } finally {
      unregisterHandle(M, dstFd);
    }
    const newSize = destSyncHandle.getSize();
    destSyncHandle.flush();
    await destSyncHandle.close();

    return {
      oldSize,
      newSize,
      bytesSaved: Math.max(0, oldSize - newSize)
    };
  }
}

// ---------------------------------------------------------------------------
// Text versioning log
// ---------------------------------------------------------------------------

/**
 * Persistent versioned text log with append-only WASM-backed storage.
 * Mirrors the API of the original (since removed) pure-JS implementation.
 */
class TextLog {
  /**
   * @param {FileSystemSyncAccessHandle} syncHandle - storage file handle
   * @param {number} diffsPerSnapshot - diffs between full snapshots (default 10)
   * @param {number} baseVersion - when creating a fresh file, the global
   *   version this tile continues from: it owns versions (baseVersion, ...].
   *   0 (the default) is an ordinary standalone log; only TiledTextLog passes
   *   a nonzero value. Ignored when opening an existing file (its stored base
   *   is adopted). See textlog_create_at.
   */
  constructor(syncHandle, diffsPerSnapshot = 10, baseVersion = 0) {
    if (diffsPerSnapshot < 1) {
      throw new Error('diffsPerSnapshot must be at least 1');
    }
    this.syncAccessHandle = syncHandle;
    this.diffsPerSnapshot = diffsPerSnapshot;
    this.baseVersion = baseVersion;
    this.isOpen = false;
    this.ctx = 0;
    this._fd = 0;
    this.version = 0;

    // Shim mirroring the reference's `file` member (used by some tests).
    this.file = {
      syncAccessHandle: syncHandle,
      getFileSize: () => this.syncAccessHandle.getSize()
    };
  }

  /**
   * Open the log against the file handle. The C side is file-resident: open
   * scans the file once to index entry offsets, then every read fetches only
   * the records it needs and every addVersion writes straight through
   * (matching the original JS model).
   */
  async open() {
    if (this.isOpen) {
      throw new Error('TextLog is already open');
    }
    const M = await ready();

    this._fd = registerHandle(M, this.syncAccessHandle);
    const fileSize = this.syncAccessHandle.getSize();
    if (fileSize > 0) {
      this.ctx = M._tlw_open(this._fd);
      if (!this.ctx) {
        unregisterHandle(M, this._fd);
        await this.syncAccessHandle.close(); // isOpen never becomes true, so this.close() can't reach it -- must release it here
        throw new Error('Failed to read metadata: no valid metadata found');
      }
      this.diffsPerSnapshot = M._tlw_diffs_per_snapshot(this.ctx);
      this.baseVersion = M._tlw_base_version(this.ctx);
    } else {
      this.ctx = M._tlw_create_at(this._fd, this.diffsPerSnapshot, this.baseVersion);
      if (!this.ctx) {
        unregisterHandle(M, this._fd);
        await this.syncAccessHandle.close();
        throw new Error('Failed to create TextLog');
      }
    }
    this.version = M._tlw_version(this.ctx);
    this.isOpen = true;
  }

  /** fsync the file handle (all writes are already on it). */
  flush() {
    this.syncAccessHandle.flush();
  }

  /** Close the sync handle and release the WASM context. */
  async close() {
    if (!this.isOpen) return;
    if (this.syncAccessHandle) {
      this.flush();
      await this.syncAccessHandle.close();
    }
    if (this.ctx) {
      Module._tlw_free(this.ctx);
      this.ctx = 0;
    }
    unregisterHandle(Module, this._fd);
    this._fd = 0;
    this.isOpen = false;
  }

  /** Read the current output buffer as a UTF-8 string. */
  _readOut(M) {
    const ptr = M._tlw_out_ptr(this.ctx);
    const len = M._tlw_out_len(this.ctx);
    if (len < 0) throw codeError(len, 'textlog');
    if (len === 0) return '';
    return decoder.decode(M.HEAPU8.slice(ptr, ptr + len));
  }

  /**
   * Add a new version of the text.
   * @param {string} text - full text content for this version
   * @returns {number} the new version number
   */
  async addVersion(text) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    if (typeof text !== 'string') {
      throw new Error('Text must be a string');
    }
    const M = requireModule();
    const bytes = encoder.encode(text);
    const ptr = M._malloc(bytes.length || 1);
    if (bytes.length) M.HEAPU8.set(bytes, ptr);
    try {
      const v = M._tlw_add_version(this.ctx, ptr, bytes.length, Date.now());
      if (v < 0) throw codeError(v, 'addVersion');
      this.version = v;
      return v;
    } finally {
      M._free(ptr);
    }
  }

  /**
   * Get the full text at a specific version.
   * @param {number} version - version number to retrieve
   * @returns {string} the text at that version
   */
  async getVersion(version) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    if (version <= this.baseVersion || version > this.version) {
      throw new Error(`Invalid version: ${version}. Valid range: ${this.baseVersion + 1}-${this.version}`);
    }
    const M = requireModule();
    const rc = M._tlw_get_version(this.ctx, version);
    if (rc !== 0) throw codeError(rc, 'getVersion');
    return this._readOut(M);
  }

  /**
   * Get a human-readable diff between two versions.
   * @param {number} fromVersion - starting version
   * @param {number} toVersion - ending version
   * @returns {string} human-readable unified diff
   */
  async getDiff(fromVersion, toVersion) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    if (fromVersion <= this.baseVersion || fromVersion > this.version) {
      throw new Error(`Invalid fromVersion: ${fromVersion}. Valid range: ${this.baseVersion + 1}-${this.version}`);
    }
    if (toVersion <= this.baseVersion || toVersion > this.version) {
      throw new Error(`Invalid toVersion: ${toVersion}. Valid range: ${this.baseVersion + 1}-${this.version}`);
    }
    const M = requireModule();
    const rc = M._tlw_get_diff(this.ctx, fromVersion, toVersion);
    if (rc !== 0) throw codeError(rc, 'getDiff');
    return this._readOut(M);
  }

  /** Get current version number. */
  getCurrentVersion() {
    return this.version;
  }

  /**
   * Get the SHA-256 hash of a specific version.
   * @param {number} version - version number
   * @returns {string} hex string hash
   */
  async getVersionHash(version) {
    if (!this.isOpen) {
      throw new Error('TextLog is not open');
    }
    if (version <= this.baseVersion || version > this.version) {
      throw new Error(`Invalid version: ${version}. Valid range: ${this.baseVersion + 1}-${this.version}`);
    }
    const M = requireModule();
    const rc = M._tlw_get_version_hash(this.ctx, version);
    if (rc !== 0) throw codeError(rc, 'getVersionHash');
    return this._readOut(M);
  }
}

/**
 * A versioned text log spread across multiple append-only tile files, so full
 * history is kept while no single file grows without bound — the space lever
 * for long-lived documents (wiki pages, blog posts) whose old revisions must
 * stay available. Each tile is an ordinary TextLog whose metadata records the
 * global version it continues from (baseVersion), so every tile reconstructs
 * independently: a read opens only the tile owning the requested version, and
 * a cold open scans only the active tile instead of the whole history.
 *
 * Tiling policy lives entirely here, outside the file format. The host passes a
 * `provider` mapping tiles to storage:
 *   - listTiles():          Promise<Array<{id, baseVersion}>>  (no file opens)
 *   - openTile(id):         Promise<syncHandle>                (existing tile)
 *   - createTile(baseVer):  Promise<{id, handle}>              (fresh empty file)
 * The tiles (each identified by its baseVersion) are the manifest; the host may
 * name files however it likes — e.g. by baseVersion — and needs no separate
 * manifest record, since each tile's range is recoverable from its own base and
 * current version.
 */
class TiledTextLog {
  /**
   * @param {object} provider - tile storage provider (see class docs)
   * @param {object} [options]
   * @param {number} [options.diffsPerSnapshot=10] - diffs between snapshots
   * @param {number} [options.maxTileBytes=1048576] - roll to a new tile once
   *   the active tile's file reaches this size (checked before each add)
   * @param {number} [options.maxOpenTiles=4] - open-tile cache cap (the active
   *   tile is always kept open)
   */
  constructor(provider, options = {}) {
    const { diffsPerSnapshot = 10, maxTileBytes = 1 << 20, maxOpenTiles = 4 } = options;
    if (diffsPerSnapshot < 1) throw new Error('diffsPerSnapshot must be at least 1');
    if (maxTileBytes < 1) throw new Error('maxTileBytes must be positive');
    this.provider = provider;
    this.diffsPerSnapshot = diffsPerSnapshot;
    this.maxTileBytes = maxTileBytes;
    this.maxOpenTiles = Math.max(1, maxOpenTiles);
    this.isOpen = false;
    this.version = 0;
    this._tiles = [];            // { id, baseVersion }, ascending by baseVersion
    this._open = new Map();      // id -> { log: TextLog, lru: number }
    this._lruClock = 0;
    this._active = null;         // descriptor of the newest tile
  }

  async open() {
    if (this.isOpen) throw new Error('TiledTextLog is already open');
    await ready();
    let tiles = (await this.provider.listTiles()) || [];
    tiles = tiles.slice().sort((a, b) => a.baseVersion - b.baseVersion);
    if (tiles.length === 0) {
      const { id } = await this.provider.createTile(0);
      tiles = [{ id, baseVersion: 0 }];
    }
    this._tiles = tiles;
    this._active = tiles[tiles.length - 1];
    // Open only the active tile to learn the current global version — cold
    // open scans one tile, not the whole history.
    const active = await this._openTile(this._active);
    this.version = active.version;
    this.isOpen = true;
  }

  // Fetch the tile for `desc` from the open-tile cache, opening it if needed.
  async _openTile(desc) {
    let entry = this._open.get(desc.id);
    if (entry) { entry.lru = ++this._lruClock; return entry.log; }
    const handle = await this.provider.openTile(desc.id);
    const log = new TextLog(handle, this.diffsPerSnapshot, desc.baseVersion);
    await log.open();
    entry = { log, lru: ++this._lruClock };
    this._open.set(desc.id, entry);
    await this._evict();
    return log;
  }

  // Keep at most maxOpenTiles tiles open; never evict the active tile.
  async _evict() {
    while (this._open.size > this.maxOpenTiles) {
      let victimId = null, victimLru = Infinity;
      for (const [id, e] of this._open) {
        if (id === this._active.id) continue;
        if (e.lru < victimLru) { victimLru = e.lru; victimId = id; }
      }
      if (victimId === null) break;
      const e = this._open.get(victimId);
      this._open.delete(victimId);
      await e.log.close();
    }
  }

  // Descriptor of the tile owning global `version` — the one with the largest
  // baseVersion strictly below it (a tile serves versions in (base, current]).
  _tileFor(version) {
    let lo = 0, hi = this._tiles.length - 1, ans = this._tiles[0];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this._tiles[mid].baseVersion < version) { ans = this._tiles[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  async addVersion(text) {
    if (!this.isOpen) throw new Error('TiledTextLog is not open');
    let active = await this._openTile(this._active);
    // Roll to a fresh tile once the active one passes the size threshold. The
    // new tile is anchored by writing version (this.version + 1) as a full
    // snapshot, so no version is duplicated across the boundary. Never roll a
    // tile that has not yet received a version of its own.
    if (this.version > this._active.baseVersion &&
        active.syncAccessHandle.getSize() >= this.maxTileBytes) {
      const { id } = await this.provider.createTile(this.version);
      const desc = { id, baseVersion: this.version };
      this._tiles.push(desc);
      this._active = desc;
      active = await this._openTile(desc);
    }
    const v = await active.addVersion(text);
    this.version = v;
    return v;
  }

  async getVersion(version) {
    this._checkRange(version);
    const log = await this._openTile(this._tileFor(version));
    return log.getVersion(version);
  }

  async getVersionHash(version) {
    this._checkRange(version);
    const log = await this._openTile(this._tileFor(version));
    return log.getVersionHash(version);
  }

  async getDiff(fromVersion, toVersion) {
    this._checkRange(fromVersion);
    this._checkRange(toVersion);
    // Reconstruct both texts (each from whichever tile owns it) and render the
    // unified diff through the same routine TextLog.getDiff uses, so output is
    // byte-identical whether or not the versions fall in the same tile.
    const fromText = await this.getVersion(fromVersion);
    const toText = await this.getVersion(toVersion);
    return unifiedDiff(fromText, toText, fromVersion, toVersion);
  }

  _checkRange(version) {
    if (version < 1 || version > this.version) {
      throw new Error(`Invalid version: ${version}. Valid range: 1-${this.version}`);
    }
  }

  /** Current (highest) global version. */
  getCurrentVersion() { return this.version; }

  /** Number of tiles the history currently spans. */
  get tileCount() { return this._tiles.length; }

  /** fsync the active tile (older tiles are immutable). */
  flush() {
    const e = this._open.get(this._active.id);
    if (e) e.log.flush();
  }

  async close() {
    if (!this.isOpen) return;
    for (const e of this._open.values()) await e.log.close();
    this._open.clear();
    this.isOpen = false;
  }
}

// Entry type constants (mirror the on-disk format).
const ENTRY_TYPE = {
  FULL_SNAPSHOT: 0x01,
  DIFF: 0x02
};

// ---------------------------------------------------------------------------
// Full-text index
// ---------------------------------------------------------------------------

/**
 * WASM full-text index. Mirrors the API of the original (since removed) pure-JS implementation.
 */
class TextIndex {
  constructor(options = {}) {
    const { order = 16, trees, journal } = options;
    this.order = order;
    this.index = trees?.index || null;
    this.documentTerms = trees?.documentTerms || null;
    this.documentLengths = trees?.documentLengths || null;
    // Optional sync access handle for the cross-tree commit journal: with it,
    // every add/remove/clear is atomic across the three tree files (a crash
    // between tree writes is rolled back on the next open). A journal belongs
    // to one set of tree files; give freshly compacted files an empty one.
    this.journal = journal || null;
    this.journalFd = -1;
    this.outCtx = 0;   // per-index query-output slot in the WASM heap
    this.isOpen = false;
  }

  async open() {
    if (this.isOpen) throw new Error('TextIndex is already open');
    if (!this.index || !this.documentTerms || !this.documentLengths) {
      throw new Error('Trees must be initialized before opening');
    }
    if (!this.outCtx) this.outCtx = requireModule()._tixw_out_new();
    if (!this.outCtx) throw new Error('Failed to allocate query output slot');
    await Promise.all([this.index.open(), this.documentTerms.open(), this.documentLengths.open()]);
    if (this.journal) {
      const M = requireModule();
      this.journalFd = registerHandle(M, this.journal);
      const [ix, dt, dl] = this._ctxs();
      const rc = M._tixw_recover(this.journalFd, ix, dt, dl);
      if (rc !== 0) {
        unregisterHandle(M, this.journalFd);
        this.journalFd = -1;
        this.journal.close();
        await Promise.all([this.index.close(), this.documentTerms.close(), this.documentLengths.close()]);
        throw codeError(rc, 'recover');
      }
    }
    this.isOpen = true;
  }

  async close() {
    if (this.outCtx) {
      requireModule()._tixw_out_free(this.outCtx);
      this.outCtx = 0;
    }
    if (!this.isOpen) return;
    if (this.journalFd >= 0) {
      unregisterHandle(requireModule(), this.journalFd);
      this.journalFd = -1;
      this.journal.flush();
      this.journal.close();
    }
    await Promise.all([this.index.close(), this.documentTerms.close(), this.documentLengths.close()]);
    this.isOpen = false;
  }

  _ensureOpen() {
    if (!this.isOpen) throw new Error('TextIndex is not open');
  }

  _ctxs() {
    return [this.index.ctx, this.documentTerms.ctx, this.documentLengths.ctx];
  }

  async add(docId, text) {
    this._ensureOpen();
    if (!docId) throw new Error('Document ID is required');
    const M = requireModule();
    const t = typeof text === 'string' ? text : '';
    const d = allocStr(M, docId);
    const x = allocStr(M, t);
    try {
      const [ix, dt, dl] = this._ctxs();
      const rc = M._tixw_add(ix, dt, dl, this.journalFd, d.ptr, d.len, x.ptr, x.len);
      if (rc !== 0) throw codeError(rc, 'add');
    } finally {
      d.free(); x.free();
    }
  }

  async remove(docId) {
    this._ensureOpen();
    const M = requireModule();
    const d = allocStr(M, String(docId));
    try {
      const [ix, dt, dl] = this._ctxs();
      const rc = M._tixw_remove(ix, dt, dl, this.journalFd, d.ptr, d.len);
      if (rc < 0) throw codeError(rc, 'remove');
      return rc === 1;
    } finally {
      d.free();
    }
  }

  _readOut(M) {
    const ptr = M._tixw_out_ptr(this.outCtx);
    const len = M._tixw_out_len(this.outCtx);
    if (len < 0) throw codeError(len, 'query');
    if (len === 0) return [];
    return decode(M.HEAPU8.slice(ptr, ptr + len));
  }

  async query(queryText, options = { scored: true, requireAll: false }) {
    this._ensureOpen();
    const M = requireModule();
    const q = allocStr(M, typeof queryText === 'string' ? queryText : '');
    try {
      const [ix, dt, dl] = this._ctxs();
      if (options.requireAll) {
        const rc = M._tixw_query_all(this.outCtx, ix, dt, dl, q.ptr, q.len);
        if (rc !== 0) throw codeError(rc, 'query');
        return this._readOut(M); // array of id strings
      }
      const rc = M._tixw_query(this.outCtx, ix, dt, dl, q.ptr, q.len);
      if (rc !== 0) throw codeError(rc, 'query');
      const results = this._readOut(M); // array of { id, score }
      if (options.scored === false) return results.map(r => r.id);
      return results;
    } finally {
      q.free();
    }
  }

  async getTermCount() {
    this._ensureOpen();
    const M = requireModule();
    const n = M._tixw_term_count(this.index.ctx);
    if (n < 0) throw codeError(n, 'getTermCount');
    return n;
  }

  async getDocumentCount() {
    this._ensureOpen();
    return this.documentTerms.size();
  }

  async clear() {
    this._ensureOpen();
    const M = requireModule();
    const [ix, dt, dl] = this._ctxs();
    const rc = M._tixw_clear(ix, dt, dl, this.journalFd);
    if (rc !== 0) throw codeError(rc, 'clear');
  }

  async compact({ index: destIndex, documentTerms: destDocTerms, documentLengths: destDocLengths }) {
    this._ensureOpen();
    if (!destIndex || !destDocTerms || !destDocLengths) {
      throw new Error('Destination trees must be provided for compaction');
    }
    const terms = await this.index.compact(destIndex.syncAccessHandle);
    const documents = await this.documentTerms.compact(destDocTerms.syncAccessHandle);
    const lengths = await this.documentLengths.compact(destDocLengths.syncAccessHandle);
    await this.close();
    this.isOpen = false;
    return { terms, documents, lengths };
  }
}

// ---------------------------------------------------------------------------
// Porter stemmer
// ---------------------------------------------------------------------------

/**
 * Return the Porter stem of `value`. Matches stemmer@2.0.1 byte-for-byte for
 * ASCII words. Requires the module to be instantiated (await ready()).
 */
function stemmer(value) {
  const M = requireModule();
  const bytes = encoder.encode(String(value));
  const len = bytes.length;
  // Worst case the stem length equals the input; +2 for a possible appended
  // 'e'/'i' and the NUL terminator the C side writes.
  const inPtr = M._malloc(len || 1);
  const outPtr = M._malloc(len + 2);
  try {
    if (len) M.HEAPU8.set(bytes, inPtr);
    const outLen = M._stemmer_stem(inPtr, len, outPtr);
    return decoder.decode(M.HEAPU8.slice(outPtr, outPtr + outLen));
  } finally {
    M._free(inPtr);
    M._free(outPtr);
  }
}

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

/** createPatch(fileName, a, b) — full unified diff with INCLUDE_HEADERS. */
function createPatch(fileName, a, b) {
  const M = requireModule();
  const namePtr = writeCString(M, fileName);
  const A = writeBytes(M, a), B = writeBytes(M, b);
  const outPP = M._malloc(4), outLP = M._malloc(4);
  try {
    const rc = M._diff_create_patch(namePtr, A.ptr, A.len, B.ptr, B.len, outPP, outLP);
    if (rc !== 0) throw new Error(`createPatch failed (${rc})`);
    return takeOut(M, outPP, outLP);
  } finally {
    M._free(namePtr); M._free(A.ptr); M._free(B.ptr); M._free(outPP); M._free(outLP);
  }
}

/**
 * The unified diff textlog.js's getDiff renders: `--- <fromLabel>` / `+++
 * <toLabel>` headers followed by `@@`/context/`+`/`-` lines. Labels default to
 * matching textlog's `version 1` / `version 2`.
 */
function unifiedDiff(a, b, fromLabel = 1, toLabel = 2) {
  const M = requireModule();
  const A = writeBytes(M, a), B = writeBytes(M, b);
  const outPP = M._malloc(4), outLP = M._malloc(4);
  try {
    const rc = M._diff_get_diff(fromLabel | 0, toLabel | 0, A.ptr, A.len, B.ptr, B.len, outPP, outLP);
    if (rc !== 0) throw new Error(`unifiedDiff failed (${rc})`);
    return takeOut(M, outPP, outLP);
  } finally {
    M._free(A.ptr); M._free(B.ptr); M._free(outPP); M._free(outLP);
  }
}

/** applyPatch(source, patch) — returns the patched string, or null if it doesn't fit. */
function applyPatch(source, patch) {
  const M = requireModule();
  const S = writeBytes(M, source), P = writeBytes(M, patch);
  const outPP = M._malloc(4), outLP = M._malloc(4), appliedP = M._malloc(4);
  try {
    const rc = M._diff_apply_patch(S.ptr, S.len, P.ptr, P.len, outPP, outLP, appliedP);
    if (rc !== 0) throw new Error(`applyPatch failed (${rc})`);
    if (readU32(M, appliedP) === 0) return null;
    return takeOut(M, outPP, outLP);
  } finally {
    M._free(S.ptr); M._free(P.ptr); M._free(outPP); M._free(outLP); M._free(appliedP);
  }
}

/** Like takeOut, but returns the raw bytes (the delta is binary, not text). */
function takeOutBytes(M, outPP, outLP) {
  const outPtr = readU32(M, outPP);
  const outLen = readU32(M, outLP);
  const bytes = M.HEAPU8.slice(outPtr, outPtr + outLen);
  if (outPtr) M._free(outPtr);
  return bytes;
}

/**
 * Binary copy/insert delta that rebuilds `target` from `source` — the compact
 * format TextLog stores for diffs (diff.h). Returns a Uint8Array; feed it to
 * applyDelta(source, delta) to reconstruct the target.
 */
function createDelta(source, target) {
  const M = requireModule();
  const S = writeBytes(M, source), T = writeBytes(M, target);
  const outPP = M._malloc(4), outLP = M._malloc(4);
  try {
    const rc = M._diff_create_delta(S.ptr, S.len, T.ptr, T.len, outPP, outLP);
    if (rc !== 0) throw new Error(`createDelta failed (${rc})`);
    return takeOutBytes(M, outPP, outLP);
  } finally {
    M._free(S.ptr); M._free(T.ptr); M._free(outPP); M._free(outLP);
  }
}

/** Apply a createDelta delta to `source`; returns the target string, or null
 * if the delta is malformed / out of bounds. */
function applyDelta(source, delta) {
  const M = requireModule();
  const S = writeBytes(M, source);
  const dlen = delta.length;
  const dptr = M._malloc(dlen || 1);
  if (dlen) M.HEAPU8.set(delta, dptr);
  const outPP = M._malloc(4), outLP = M._malloc(4), appliedP = M._malloc(4);
  try {
    const rc = M._diff_apply_delta(S.ptr, S.len, dptr, dlen, outPP, outLP, appliedP);
    if (rc !== 0) throw new Error(`applyDelta failed (${rc})`);
    if (readU32(M, appliedP) === 0) return null;
    return takeOut(M, outPP, outLP);
  } finally {
    M._free(S.ptr); M._free(dptr); M._free(outPP); M._free(outLP); M._free(appliedP);
  }
}

// ---------------------------------------------------------------------------
// Db / Collection — a MongoDB-driver-shaped document database.
//
// A collection is a bpt keyed by the raw 12-byte ObjectId, plus zero or more
// attached secondary indexes (see db.h). CRUD, secondary-index maintenance,
// operator-aware filter matching, sort/skip/limit/projection and the
// equality-index planner are all implemented in C (db.c/db_query.c/db_wasm.c)
// — this layer only marshals bytes across the WASM bridge, the same way
// BPlusTree/RTree/TextIndex above do. A database is a root catalog tree
// (collection name -> backing file name + index list) plus a storage
// provider that turns file names into sync-handle-shaped objects; that
// bookkeeping is plain B+ tree key lookups, already fully served by
// BPlusTree, so it stays here rather than growing new C surface. Collection
// only does two bits of real work of its own: the driver-shaped createIndex
// key-spec validation ({field: 1}, ascending only) and default index naming
// (team_1, team_1_age_1) — pure conventions, not query/index logic.
//
// _id defaulting stays in JS for the same reason ts_ms does for textlog: it
// needs a clock and randomness, neither of which WASM has a portable source
// for. replaceOne's upsert case can't know ahead of the C-side match
// whether a fresh id will actually be needed, so JS always generates one and
// passes it as `default_id`; C only consults it when it decides to upsert.
// ---------------------------------------------------------------------------

const DB_CATALOG_FILE = '__catalog__.bj';
const DB_DEFAULT_ORDER = 32;

function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string') return new ObjectId(id);
  throw new Error(`Invalid _id: ${id}`);
}

function checkCollectionName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('\0')) {
    throw new Error(`Invalid collection name: ${JSON.stringify(name)}`);
  }
}

/** Same constraints as a collection name -- a database name becomes a real path segment (OPFSStorageProvider.subProvider) or a Map key (MemoryStorageProvider.subProvider) either way. */
function checkDbName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('\0')) {
    throw new Error(`Invalid database name: ${JSON.stringify(name)}`);
  }
}

function collectionFileName(name) {
  return `coll-${name}.bj`;
}

function indexFileName(collectionName, indexName) {
  return `idx-${collectionName}-${indexName}.bj`;
}

/** A text index needs the same three files a TextIndex always does. */
function textIndexFileNames(collectionName, indexName) {
  const base = `idx-${collectionName}-${indexName}`;
  return { index: `${base}-terms.bj`, docTerms: `${base}-documents.bj`, docLengths: `${base}-lengths.bj` };
}

/** Cross-file commit journal (milestone 5, docs/db-plan.md): makes every
 * document write atomic across the primary tree + attached index files. */
function journalFileName(collectionName) {
  return `coll-${collectionName}-journal.bj`;
}

/** Default index name mirroring the real driver's convention: "team_1",
 * "team_1_age_1" for a compound index. Only ascending (1) fields are
 * supported so far — descending order only changes scan direction, which a
 * caller can already get by reversing results, so it's deferred rather than
 * plumbed through the composite-key encoding (db_keyenc.h) for no behavioral
 * gain yet. */
function checkIndexKeySpec(keys) {
  const fields = Object.keys(keys);
  if (fields.length === 0) throw new Error('createIndex requires at least one field');
  for (const f of fields) {
    if (keys[f] !== 1) {
      throw new Error(`createIndex: only ascending (1) fields are supported so far (got ${f}: ${keys[f]})`);
    }
  }
  return fields;
}

/**
 * In-memory named-file storage: handles persist for the process lifetime
 * (MemoryHandle.close() is a no-op, so data survives collection/Db close).
 * Intended for tests and embeddings that don't need durability.
 */
class MemoryStorageProvider {
  constructor() {
    this._files = new Map(); // name -> MemoryHandle
    this._children = new Map(); // name -> MemoryStorageProvider, see subProvider()
  }

  async openFile(name, { create = false } = {}) {
    let handle = this._files.get(name);
    if (!handle) {
      if (!create) throw new Error(`File not found: ${name}`);
      handle = new MemoryHandle();
      this._files.set(name, handle);
    }
    return handle;
  }

  async deleteFile(name) {
    this._files.delete(name);
  }

  /** A named, isolated storage scope nested under this one -- Client.db(name)'s equivalent of OPFSStorageProvider.subProvider's real subdirectory, backed by its own independent file map rather than a real filesystem. Cached: repeat calls with the same name return the same instance. */
  async subProvider(name) {
    let child = this._children.get(name);
    if (!child) {
      child = new MemoryStorageProvider();
      this._children.set(name, child);
    }
    return child;
  }
}

/**
 * OPFS-backed named-file storage, rooted at a directory handle (defaults to
 * the OPFS root, resolved lazily so construction works outside a worker).
 */
class OPFSStorageProvider {
  constructor(dirHandle) {
    this._dirHandle = dirHandle || null;
  }

  async _dir() {
    if (!this._dirHandle) this._dirHandle = await navigator.storage.getDirectory();
    return this._dirHandle;
  }

  async openFile(name, { create = false } = {}) {
    const dir = await this._dir();
    const fileHandle = await getFileHandle(dir, name, { create });
    return fileHandle.createSyncAccessHandle();
  }

  async deleteFile(name) {
    await deleteFile(await this._dir(), name);
  }

  /** A real OPFS subdirectory (created if needed) as its own provider -- Client.db(name)'s on-disk unit, one subdirectory per logical database under this provider's own directory, mirroring the cloud service's per-tenant `<tenantId>/<dbName>/` layout (service/tenant-worker.js). */
  async subProvider(name) {
    const dir = await this._dir();
    const childDir = await dir.getDirectoryHandle(name, { create: true });
    return new OPFSStorageProvider(childDir);
  }
}

/**
 * Resolves $currentDate into $set before an update document ever crosses
 * the WASM bridge -- only the JS host has a clock (the same reasoning that
 * already puts _id generation in JS, not C; see c/db_update.h's top
 * comment). Returns `update` unchanged if it has no $currentDate; never
 * mutates the caller's object. Each targeted field must be `true` or
 * `{ $type: 'date' }` (no timestamp wire type exists) and must not already
 * be targeted by another top-level operator.
 */
function resolveCurrentDate(update) {
  if (!update || typeof update !== 'object' || !('$currentDate' in update)) return update;
  const spec = update.$currentDate;
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('$currentDate requires an object mapping field names to true or {$type: "date"}');
  }

  const targetedElsewhere = new Set();
  for (const [key, val] of Object.entries(update)) {
    if (key === '$currentDate' || key[0] !== '$') continue;
    if (val && typeof val === 'object') {
      for (const f of Object.keys(val)) targetedElsewhere.add(f);
    }
  }

  const result = { ...update };
  delete result.$currentDate;
  const set = { ...(update.$set || {}) };
  for (const [field, fieldSpec] of Object.entries(spec)) {
    const isPlainTrue = fieldSpec === true;
    const isDateType = fieldSpec !== null && typeof fieldSpec === 'object' && fieldSpec.$type === 'date';
    if (!isPlainTrue && !isDateType) {
      throw new Error(`$currentDate: field "${field}" must be true or {$type: "date"} (got ${JSON.stringify(fieldSpec)})`);
    }
    if (targetedElsewhere.has(field) || Object.prototype.hasOwnProperty.call(set, field)) {
      throw new Error(`$currentDate: field "${field}" is already targeted by another operator`);
    }
    set[field] = new Date();
  }
  result.$set = set;
  return result;
}

/**
 * A live feed of change events from a Collection (Collection.watch()) or a
 * SharedCollection (db-coordinator.js's Coordinator.watch()) -- both an
 * EventEmitter-lite (.on('change', cb)) and an async iterator (for await),
 * matching the real driver's ChangeStream dual API. `unsubscribe` (called
 * once, on close()) removes this stream from whatever registry created it.
 */
class ChangeStream {
  constructor(unsubscribe) {
    this._listeners = new Set();
    this._queue = [];
    this._waiting = []; // pending next() resolvers, FIFO
    this._closed = false;
    this._unsubscribe = unsubscribe;
  }

  _emit(change) {
    if (this._closed) return;
    for (const cb of this._listeners) cb(change);
    if (this._waiting.length) this._waiting.shift()({ value: change, done: false });
    else this._queue.push(change);
  }

  on(event, cb) {
    if (event !== 'change') throw new Error(`ChangeStream: unsupported event "${event}"`);
    this._listeners.add(cb);
    return this;
  }

  off(cb) {
    this._listeners.delete(cb);
    return this;
  }

  async next() {
    if (this._queue.length) return { value: this._queue.shift(), done: false };
    if (this._closed) return { value: undefined, done: true };
    return new Promise((resolve) => this._waiting.push(resolve));
  }

  [Symbol.asyncIterator]() { return this; }

  async return() {
    this.close();
    return { value: undefined, done: true };
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    const waiting = this._waiting;
    this._waiting = [];
    for (const resolve of waiting) resolve({ value: undefined, done: true });
    if (this._unsubscribe) this._unsubscribe();
  }
}

class Collection {
  constructor(name, tree, { catalog, provider, order }) {
    this.name = name;
    this._tree = tree;       // BPlusTree, opened by Db.collection()
    this._catalog = catalog; // shared Db catalog tree, for this collection's index list
    this._provider = provider;
    this._order = order;
    this._outCtx = 0;        // per-collection query-output slot in the WASM heap
    this._collCtx = 0;       // dc_collection* coordinating the primary tree + indexes
    // indexName -> one of:
    //   { kind: 'equality', fields, tree, file }
    //   { kind: 'text', field, trees: {index,docTerms,docLengths}, files: {...} }
    //   { kind: 'geo', field, rt, file }
    this._indexes = new Map();
    this._journal = null;    // sync access handle for the cross-file commit journal
    this._journalFd = -1;
    this._watchers = new Set(); // open ChangeStreams (see watch())
    this._openCursors = new Set(); // open find() cursors holding a live WASM-side dc_cursor (see find())
  }

  /**
   * A live feed of change events (insert/update/replace/delete) for this
   * collection. Unlike the real driver, `pipeline` stages ($match, etc.)
   * aren't supported yet -- filter inside your own `on('change', cb)`
   * instead -- and there's no `updateDescription` (would need diffing
   * before/after images; skipped as a documented scope limit). Costs
   * nothing when nothing is watching: see _emitChange's fast path and each
   * CRUD method's "only when _watchers.size" extra lookups.
   */
  watch(pipeline = [], options = {}) {
    if (pipeline.length) {
      throw new Error('Collection.watch: pipeline stages are not supported yet');
    }
    const stream = new ChangeStream(() => this._watchers.delete(stream));
    this._watchers.add(stream);
    return stream;
  }

  /** No-op fast path when nothing is watching (the common case). */
  _emitChange(event) {
    if (this._watchers.size === 0) return;
    const change = { ns: { coll: this.name }, ...event };
    for (const stream of this._watchers) stream._emit(change);
  }

  /** Close every already-opened index tree/rtree (not the primary tree or
   * the journal) -- shared by normal close and open()'s failure cleanup. */
  async _closeIndexes() {
    for (const ix of this._indexes.values()) {
      if (ix.kind === 'equality') await ix.tree.close();
      else if (ix.kind === 'text') { for (const role of Object.keys(ix.trees)) await ix.trees[role].close(); }
      else await ix.rt.close();
    }
    this._indexes.clear();
  }

  async _open() {
    await this._tree.open();
    const M = requireModule();
    this._outCtx = M._dcw_out_new();
    if (!this._outCtx) throw new Error('Failed to allocate collection output slot');
    this._collCtx = M._dcw_collection_open(this._tree.ctx);
    if (!this._collCtx) throw new Error('Failed to allocate collection handle');

    const entry = this._catalog.search(this.name);
    for (const def of entry.indexes || []) {
      const kind = def.kind || 'equality'; // pre-milestone-6 catalog entries have no kind
      if (kind === 'equality') {
        const handle = await this._provider.openFile(def.file, { create: false });
        const tree = new BPlusTree(handle, this._order);
        await tree.open();
        const n = allocStr(M, def.name);
        let rc;
        try {
          rc = this._marshalPair(def.fields, def.partialFilterExpression, (M2, fp, flen, pp, plen) =>
            M2._dcw_collection_attach_index(this._collCtx, n.ptr, n.len, tree.ctx, fp, flen,
                                            def.unique ? 1 : 0, def.sparse ? 1 : 0, pp, plen));
        } finally {
          n.free();
        }
        if (rc !== 0) throw codeError(rc, 'attachIndex');
        this._indexes.set(def.name, {
          kind: 'equality', fields: def.fields, tree, file: def.file,
          unique: !!def.unique, sparse: !!def.sparse,
          partialFilterExpression: def.partialFilterExpression || null,
          expireAfterSeconds: def.expireAfterSeconds
        });
      } else if (kind === 'text') {
        const trees = {};
        for (const role of Object.keys(def.files)) {
          const handle = await this._provider.openFile(def.files[role], { create: false });
          trees[role] = new BPlusTree(handle, this._order);
          await trees[role].open();
        }
        const n = allocStr(M, def.name);
        const f = allocStr(M, def.field);
        let rc;
        try {
          rc = M._dcw_collection_attach_text_index(
            this._collCtx, n.ptr, n.len,
            trees.index.ctx, trees.docTerms.ctx, trees.docLengths.ctx,
            f.ptr, f.len
          );
        } finally {
          n.free(); f.free();
        }
        if (rc !== 0) throw codeError(rc, 'attachTextIndex');
        this._indexes.set(def.name, { kind: 'text', field: def.field, trees, files: def.files });
      } else {
        const handle = await this._provider.openFile(def.file, { create: false });
        const rt = new RTree(handle);
        await rt.open();
        const n = allocStr(M, def.name);
        const f = allocStr(M, def.field);
        let rc;
        try {
          rc = M._dcw_collection_attach_geo_index(this._collCtx, n.ptr, n.len, rt.ctx, f.ptr, f.len);
        } finally {
          n.free(); f.free();
        }
        if (rc !== 0) throw codeError(rc, 'attachGeoIndex');
        this._indexes.set(def.name, { kind: 'geo', field: def.field, rt, file: def.file });
      }
    }

    // Cross-file commit journal (milestone 5): must be recovered only after
    // every index above is attached, mirroring TextIndex's tix_recover
    // contract ("right after all trees are open"). Always on -- every
    // collection gets this consistency guarantee automatically.
    this._journal = await this._provider.openFile(journalFileName(this.name), { create: true });
    this._journalFd = registerHandle(M, this._journal);
    const rc = M._dcw_collection_recover(this._collCtx, this._journalFd);
    if (rc !== 0) {
      unregisterHandle(M, this._journalFd);
      this._journalFd = -1;
      this._journal.close();
      this._journal = null;
      await this._closeIndexes();
      requireModule()._dcw_collection_free(this._collCtx);
      this._collCtx = 0;
      requireModule()._dcw_out_free(this._outCtx);
      this._outCtx = 0;
      await this._tree.close();
      throw codeError(rc, 'recover');
    }
  }

  async _close() {
    for (const stream of [...this._watchers]) stream.close();
    for (const fcursor of [...this._openCursors]) await fcursor.close();
    await this._closeIndexes();
    if (this._journalFd >= 0) {
      unregisterHandle(requireModule(), this._journalFd);
      this._journalFd = -1;
      this._journal.flush();
      this._journal.close();
      this._journal = null;
    }
    if (this._collCtx) {
      requireModule()._dcw_collection_free(this._collCtx);
      this._collCtx = 0;
    }
    if (this._outCtx) {
      requireModule()._dcw_out_free(this._outCtx);
      this._outCtx = 0;
    }
    await this._tree.close();
  }

  _readOut(M) {
    const ptr = M._dcw_out_ptr(this._outCtx);
    const len = M._dcw_out_len(this._outCtx);
    if (len < 0) throw codeError(len, 'find');
    if (len === 0) return undefined;
    return decode(M.HEAPU8.slice(ptr, ptr + len));
  }

  _persistIndexes() {
    const entry = this._catalog.search(this.name);
    entry.indexes = [...this._indexes.entries()].map(([name, ix]) => {
      if (ix.kind === 'equality') {
        const def = { name, kind: 'equality', fields: ix.fields, file: ix.file };
        if (ix.unique) def.unique = true;
        if (ix.sparse) def.sparse = true;
        if (ix.partialFilterExpression) def.partialFilterExpression = ix.partialFilterExpression;
        if (ix.expireAfterSeconds !== undefined) def.expireAfterSeconds = ix.expireAfterSeconds;
        return def;
      }
      if (ix.kind === 'text') return { name, kind: 'text', field: ix.field, files: ix.files };
      return { name, kind: 'geo', field: ix.field, file: ix.file };
    });
    this._catalog.add(this.name, entry);
  }

  /**
   * Create a secondary index:
   *   - equality: createIndex({ team: 1 }) or a compound createIndex({ team: 1, age: 1 }).
   *     Options: `unique` (reject a write whose field values collide with
   *     another document's), `sparse` (skip, don't error, a document
   *     missing a field instead of the default all-or-nothing backfill/
   *     maintenance), `partialFilterExpression` (a filter — only matching
   *     documents are indexed), `expireAfterSeconds` (TTL — single-field
   *     only; see pruneExpired()). A document skipped by sparse/
   *     partialFilterExpression can never violate unique on that index.
   *   - text: createIndex({ body: 'text' }) — single field, BM25-scored via $text.
   *     At most one text index per collection (matches MongoDB).
   *   - geo: createIndex({ location: '2dsphere' }) — single field, GeoJSON Point
   *     values, queried via $near/$geoWithin (see docs/db-plan.md milestone 6).
   * Backfills against any existing documents — all-or-nothing for equality/geo
   * indexes (a disqualifying field, or -- for a unique index -- a pre-existing
   * duplicate value, fails the whole call), but a text index tolerates
   * documents missing the field or holding a non-string value (they just
   * aren't text-searchable), matching MongoDB's own behavior for each.
   * Returns the index name (options.name, or a MongoDB-shaped default).
   */
  async createIndex(keys, options = {}) {
    const keyFields = Object.keys(keys);
    const isSpecial = keyFields.length === 1 && (keys[keyFields[0]] === 'text' || keys[keyFields[0]] === '2dsphere');
    if (isSpecial && (options.unique || options.sparse || options.partialFilterExpression || options.expireAfterSeconds !== undefined)) {
      throw new Error('createIndex: unique/sparse/partialFilterExpression/expireAfterSeconds are only supported for equality indexes');
    }
    if (keyFields.length === 1 && keys[keyFields[0]] === 'text') {
      return this._createTextIndex(keyFields[0], options);
    }
    if (keyFields.length === 1 && keys[keyFields[0]] === '2dsphere') {
      return this._createGeoIndex(keyFields[0], options);
    }

    const fields = checkIndexKeySpec(keys);
    if (options.expireAfterSeconds !== undefined && fields.length !== 1) {
      throw new Error('createIndex: expireAfterSeconds requires a single-field index');
    }
    const name = options.name || fields.map(f => `${f}_1`).join('_');
    if (this._indexes.has(name)) throw new Error(`Index already exists: ${name}`);

    const fileName = indexFileName(this.name, name);
    await this._provider.deleteFile(fileName); // clean slate in case a prior attempt was aborted
    const tree = new BPlusTree(await this._provider.openFile(fileName, { create: true }), this._order);
    await tree.open();

    const M = requireModule();
    const n = allocStr(M, name);
    const unique = !!options.unique, sparse = !!options.sparse;
    const partialFilterExpression = options.partialFilterExpression || null;
    let rc;
    try {
      rc = this._marshalPair(fields, partialFilterExpression, (M2, fp, flen, pp, plen) =>
        M2._dcw_collection_add_index(this._collCtx, n.ptr, n.len, tree.ctx, fp, flen,
                                     unique ? 1 : 0, sparse ? 1 : 0, pp, plen));
    } finally {
      n.free();
    }

    if (rc !== 0) {
      await tree.close();
      await this._provider.deleteFile(fileName);
      throw codeError(rc, 'createIndex');
    }

    this._indexes.set(name, {
      kind: 'equality', fields, tree, file: fileName, unique, sparse, partialFilterExpression,
      expireAfterSeconds: options.expireAfterSeconds
    });
    this._persistIndexes();
    return name;
  }

  async _createTextIndex(field, options = {}) {
    const name = options.name || `${field}_text`;
    if (this._indexes.has(name)) throw new Error(`Index already exists: ${name}`);

    const files = textIndexFileNames(this.name, name);
    const trees = {};
    for (const role of Object.keys(files)) {
      await this._provider.deleteFile(files[role]);
      trees[role] = new BPlusTree(await this._provider.openFile(files[role], { create: true }), this._order);
      await trees[role].open();
    }

    const M = requireModule();
    const n = allocStr(M, name);
    const f = allocStr(M, field);
    let rc;
    try {
      rc = M._dcw_collection_add_text_index(
        this._collCtx, n.ptr, n.len,
        trees.index.ctx, trees.docTerms.ctx, trees.docLengths.ctx,
        f.ptr, f.len
      );
    } finally {
      n.free(); f.free();
    }

    if (rc !== 0) {
      for (const role of Object.keys(files)) await trees[role].close();
      for (const role of Object.keys(files)) await this._provider.deleteFile(files[role]);
      throw codeError(rc, 'createIndex');
    }

    this._indexes.set(name, { kind: 'text', field, trees, files });
    this._persistIndexes();
    return name;
  }

  async _createGeoIndex(field, options = {}) {
    const name = options.name || `${field}_2dsphere`;
    if (this._indexes.has(name)) throw new Error(`Index already exists: ${name}`);

    const fileName = indexFileName(this.name, name);
    await this._provider.deleteFile(fileName);
    const rt = new RTree(await this._provider.openFile(fileName, { create: true }));
    await rt.open();

    const M = requireModule();
    const n = allocStr(M, name);
    const f = allocStr(M, field);
    let rc;
    try {
      rc = M._dcw_collection_add_geo_index(this._collCtx, n.ptr, n.len, rt.ctx, f.ptr, f.len);
    } finally {
      n.free(); f.free();
    }

    if (rc !== 0) {
      await rt.close();
      await this._provider.deleteFile(fileName);
      throw codeError(rc, 'createIndex');
    }

    this._indexes.set(name, { kind: 'geo', field, rt, file: fileName });
    this._persistIndexes();
    return name;
  }

  async dropIndex(name) {
    const entry = this._indexes.get(name);
    if (!entry) throw new Error(`Index not found: ${name}`);
    const M = requireModule();
    const n = allocStr(M, name);
    let rc;
    try {
      rc = M._dcw_collection_remove_index(this._collCtx, n.ptr, n.len);
    } finally {
      n.free();
    }
    if (rc !== 0) throw codeError(rc, 'dropIndex');

    if (entry.kind === 'equality') {
      await entry.tree.close();
      await this._provider.deleteFile(entry.file);
    } else if (entry.kind === 'text') {
      for (const role of Object.keys(entry.trees)) await entry.trees[role].close();
      for (const role of Object.keys(entry.files)) await this._provider.deleteFile(entry.files[role]);
    } else {
      await entry.rt.close();
      await this._provider.deleteFile(entry.file);
    }
    this._indexes.delete(name);
    this._persistIndexes();
  }

  async listIndexes() {
    return [...this._indexes.entries()].map(([name, ix]) => {
      if (ix.kind === 'equality') {
        const def = { name, key: Object.fromEntries(ix.fields.map(f => [f, 1])) };
        if (ix.unique) def.unique = true;
        if (ix.sparse) def.sparse = true;
        if (ix.partialFilterExpression) def.partialFilterExpression = ix.partialFilterExpression;
        if (ix.expireAfterSeconds !== undefined) def.expireAfterSeconds = ix.expireAfterSeconds;
        return def;
      }
      if (ix.kind === 'text') return { name, key: { [ix.field]: 'text' } };
      return { name, key: { [ix.field]: '2dsphere' } };
    });
  }

  /**
   * Every document whose indexed fields equal `values` (in the index's
   * field order), via an O(log n + k) index scan of an *equality* index —
   * for $text/$near/$geoWithin, use find()/findOne() with the matching
   * filter operator instead (db.c dispatches to the right index).
   */
  async findByIndex(name, values) {
    const entry = this._indexes.get(name);
    if (!entry) throw new Error(`Index not found: ${name}`);
    if (entry.kind !== 'equality') throw new Error(`findByIndex requires an equality index (got kind: ${entry.kind})`);
    const M = requireModule();
    const n = allocStr(M, name);
    const valuesBytes = encode(values);
    let rc;
    try {
      rc = withBytes(M, valuesBytes, (vp, vlen) =>
        M._dcw_find_by_index(this._outCtx, this._collCtx, n.ptr, n.len, vp, vlen));
    } finally {
      n.free();
    }
    if (rc !== 0) throw codeError(rc, 'findByIndex');
    return this._readOut(M) ?? [];
  }

  async insertOne(doc) {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('insertOne requires a document object');
    }
    const M = requireModule();
    const _id = doc._id !== undefined ? toObjectId(doc._id) : new ObjectId();
    const bytes = encode({ ...doc, _id });
    const rc = withBytes(M, bytes, (p, n) => M._dcw_insert_one(this._collCtx, p, n));
    if (rc !== 0) throw codeError(rc, 'insertOne');
    this._emitChange({ operationType: 'insert', documentKey: { _id }, fullDocument: { ...doc, _id } });
    return { acknowledged: true, insertedId: _id };
  }

  /**
   * Insert every document in `docs`. `ordered` (default true) stops at the
   * first failing document; `false` attempts every document regardless of
   * earlier failures. Each document's _id is assigned client-side up front
   * (same convention as insertOne) so the result's insertedIds can be built
   * directly from ids already known here — dcw_insert_many's out slot only
   * needs to report success/failure per index (see dc_insert_many).
   */
  async insertMany(docs, { ordered = true } = {}) {
    if (!Array.isArray(docs) || docs.length === 0) {
      throw new Error('insertMany requires a non-empty array of documents');
    }
    const M = requireModule();
    const ids = docs.map(doc => doc._id !== undefined ? toObjectId(doc._id) : new ObjectId());
    const bytes = encode(docs.map((doc, i) => ({ ...doc, _id: ids[i] })));
    const rc = withBytes(M, bytes, (p, n) => M._dcw_insert_many(this._outCtx, this._collCtx, p, n, ordered ? 1 : 0));
    if (rc !== 0) throw codeError(rc, 'insertMany');

    const results = this._readOut(M); // one error code per attempted document
    const insertedIds = {};
    let insertedCount = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i] === 0) {
        insertedIds[i] = ids[i];
        insertedCount++;
      } else {
        const err = codeError(results[i], `insertMany (document ${i})`);
        err.result = { acknowledged: true, insertedCount, insertedIds };
        throw err;
      }
    }
    for (let i = 0; i < results.length; i++) {
      if (results[i] === 0) {
        this._emitChange({ operationType: 'insert', documentKey: { _id: ids[i] }, fullDocument: { ...docs[i], _id: ids[i] } });
      }
    }
    return { acknowledged: true, insertedCount, insertedIds };
  }

  /** `options.projection` follows the same inclusion-XOR-exclusion rules as find()'s (`_id` defaults included). */
  async findOne(filter = {}, options = {}) {
    const M = requireModule();
    const fbytes = encode(filter);
    const projBytes = options.projection ? encode(options.projection) : new Uint8Array(0);

    const fp = fbytes.length ? M._malloc(fbytes.length) : 0;
    const pp = projBytes.length ? M._malloc(projBytes.length) : 0;
    if (fbytes.length) M.HEAPU8.set(fbytes, fp);
    if (projBytes.length) M.HEAPU8.set(projBytes, pp);

    let found;
    try {
      found = M._dcw_find_one(this._outCtx, this._collCtx, fp, fbytes.length, pp, projBytes.length);
    } finally {
      if (fp) M._free(fp);
      if (pp) M._free(pp);
    }
    if (found < 0) throw codeError(found, 'findOne');
    return found ? this._readOut(M) : null;
  }

  /**
   * The _id a filter-based mutation (updateOne/deleteOne/etc.) is about to
   * affect, resolved *before* the mutation runs (the filter may no longer
   * match afterward) -- for building a watch() change event. Free when the
   * filter already names `_id` directly; otherwise one extra findOne, only
   * ever called when this collection actually has active watchers.
   */
  async _resolveDocumentKeyForWatch(filter) {
    if (filter && filter._id !== undefined) return toObjectId(filter._id);
    const doc = await this.findOne(filter);
    return doc ? doc._id : null;
  }

  /**
   * Mirrors the driver's find(): returns a cursor, not a promise. Accepts
   * options up front ({ sort, skip, limit, projection }) and/or the
   * driver's chainable .sort()/.skip()/.limit()/.project() — both set the
   * same underlying state, so they can be mixed.
   */
  /**
   * Sorted queries fall back to the eager path below (dcw_find,
   * materializing every match before returning) since an arbitrary
   * in-memory sort fundamentally needs every match before it can emit the
   * first ordered result. An unsorted find() streams instead, in bounded
   * batches, via the WASM-side dc_cursor -- see db.h's comment on it.
   */
  find(filter = {}, options = {}) {
    const collection = this;
    const state = {
      sort: options.sort || null,
      skip: options.skip || 0,
      limit: options.limit || 0,
      projection: options.projection || null
    };
    const BATCH = 100;

    async function eagerToArray() {
      const M = requireModule();
      const fBytes = encode(filter);
      const sortBytes = state.sort ? encode(state.sort) : new Uint8Array(0);
      const projBytes = state.projection ? encode(state.projection) : new Uint8Array(0);

      const fp = fBytes.length ? M._malloc(fBytes.length) : 0;
      const sp = sortBytes.length ? M._malloc(sortBytes.length) : 0;
      const pp = projBytes.length ? M._malloc(projBytes.length) : 0;
      if (fBytes.length) M.HEAPU8.set(fBytes, fp);
      if (sortBytes.length) M.HEAPU8.set(sortBytes, sp);
      if (projBytes.length) M.HEAPU8.set(projBytes, pp);

      let rc;
      try {
        rc = M._dcw_find(
          collection._outCtx, collection._collCtx,
          fp, fBytes.length,
          sp, sortBytes.length,
          state.skip, state.limit,
          pp, projBytes.length
        );
      } finally {
        if (fp) M._free(fp);
        if (sp) M._free(sp);
        if (pp) M._free(pp);
      }
      if (rc !== 0) throw codeError(rc, 'find');
      return collection._readOut(M) ?? [];
    }

    let wasmCursor = 0; // dc_cursor*, once opened
    let exhausted = false;
    let pending = []; // docs fetched but not yet handed out
    let pendingIdx = 0;

    function openWasmCursor() {
      const M = requireModule();
      const fBytes = encode(filter);
      const projBytes = state.projection ? encode(state.projection) : new Uint8Array(0);
      const fp = fBytes.length ? M._malloc(fBytes.length) : 0;
      const pp = projBytes.length ? M._malloc(projBytes.length) : 0;
      const errP = M._malloc(4);
      if (fBytes.length) M.HEAPU8.set(fBytes, fp);
      if (projBytes.length) M.HEAPU8.set(projBytes, pp);
      let ptr;
      try {
        ptr = M._dcw_cursor_open(
          collection._collCtx,
          fp, fBytes.length,
          state.skip, state.limit,
          pp, projBytes.length,
          errP
        );
        if (!ptr) throw codeError(readI32(M, errP), 'find');
      } finally {
        if (fp) M._free(fp);
        if (pp) M._free(pp);
        M._free(errP);
      }
      wasmCursor = ptr;
      collection._openCursors.add(fcursor);
    }

    function closeWasmCursor() {
      if (wasmCursor) {
        requireModule()._dcw_cursor_close(wasmCursor);
        wasmCursor = 0;
        collection._openCursors.delete(fcursor);
      }
    }

    async function fetchBatch(maxCount) {
      const M = requireModule();
      if (!wasmCursor) openWasmCursor();
      const doneP = M._malloc(4);
      let rc, done;
      try {
        rc = M._dcw_cursor_next_batch(collection._outCtx, wasmCursor, maxCount, doneP);
        if (rc !== 0) throw codeError(rc, 'find');
        done = !!readU32(M, doneP);
      } finally {
        M._free(doneP);
      }
      const batch = collection._readOut(M) ?? [];
      if (done) { exhausted = true; closeWasmCursor(); }
      return batch;
    }

    const fcursor = {
      sort(spec) { state.sort = spec; return fcursor; },
      skip(n) { state.skip = n; return fcursor; },
      limit(n) { state.limit = n; return fcursor; },
      project(spec) { state.projection = spec; return fcursor; },

      async toArray() {
        if (state.sort) return eagerToArray();
        const all = pending.slice(pendingIdx);
        pendingIdx = pending.length;
        while (!exhausted) all.push(...(await fetchBatch(BATCH)));
        return all;
      },

      /** Manual pull, `{ value, done }` -- same shape as ChangeStream's. Sorted cursors don't support this: call toArray() instead. */
      async next() {
        if (state.sort) throw new Error('find().next() is not supported with .sort() -- use toArray() or for-await instead');
        if (pendingIdx >= pending.length) {
          if (exhausted) return { value: undefined, done: true };
          pending = await fetchBatch(BATCH);
          pendingIdx = 0;
          if (pending.length === 0) return { value: undefined, done: true };
        }
        return { value: pending[pendingIdx++], done: false };
      },

      [Symbol.asyncIterator]() {
        return state.sort ? eagerIterator() : fcursor;
      },

      /** Releases the underlying WASM cursor if one is open. Safe to call more than once, or on an already-exhausted/sorted cursor. */
      async close() {
        exhausted = true;
        closeWasmCursor();
      },

      /** Invoked by `for await` on early exit (break/throw) -- releases the WASM cursor instead of leaking it. */
      async return() {
        await fcursor.close();
        return { value: undefined, done: true };
      }
    };

    async function* eagerIterator() {
      for (const doc of await eagerToArray()) yield doc;
    }

    return fcursor;
  }

  async deleteOne(filter = {}) {
    const M = requireModule();
    const watching = this._watchers.size > 0;
    const preId = watching ? await this._resolveDocumentKeyForWatch(filter) : null;
    const fbytes = encode(filter);
    const rc = withBytes(M, fbytes, (p, n) => M._dcw_delete_one(this._collCtx, p, n));
    if (rc < 0) throw codeError(rc, 'deleteOne');
    if (watching && rc === 1 && preId) this._emitChange({ operationType: 'delete', documentKey: { _id: preId } });
    return { acknowledged: true, deletedCount: rc };
  }

  /** Delete every document matching `filter`. */
  async deleteMany(filter = {}) {
    const M = requireModule();
    const watching = this._watchers.size > 0;
    const preIds = watching ? (await this.find(filter, { projection: { _id: 1 } }).toArray()).map(d => d._id) : null;
    const fbytes = encode(filter);
    const n = withBytes(M, fbytes, (p, len) => M._dcw_delete_many(this._collCtx, p, len));
    if (n < 0) throw codeError(n, 'deleteMany');
    if (watching) {
      for (const _id of preIds) this._emitChange({ operationType: 'delete', documentKey: { _id } });
    }
    return { acknowledged: true, deletedCount: n };
  }

  /** Atomically find the first document matching `filter` and delete it,
   * returning the deleted document (or null if nothing matched). */
  async findOneAndDelete(filter = {}) {
    const M = requireModule();
    const fbytes = encode(filter);
    const found = withBytes(M, fbytes, (p, n) => M._dcw_find_one_and_delete(this._outCtx, this._collCtx, p, n));
    if (found < 0) throw codeError(found, 'findOneAndDelete');
    if (!found) return null;
    const doc = this._readOut(M);
    this._emitChange({ operationType: 'delete', documentKey: { _id: doc._id } });
    return doc;
  }

  /**
   * Malloc `a`/`b` (encoded; `b` may be null/undefined for "no bytes"),
   * call fn(M, ap, aLen, bp, bLen), free everything, and return the
   * result. Shared by createIndex/reattach-on-open, which both need to
   * pass an equality index's fields plus an optional
   * partialFilterExpression across the bridge.
   */
  _marshalPair(a, b, fn) {
    const M = requireModule();
    const aBytes = encode(a);
    const bBytes = b != null ? encode(b) : new Uint8Array(0);
    const ap = aBytes.length ? M._malloc(aBytes.length) : 0;
    const bp = bBytes.length ? M._malloc(bBytes.length) : 0;
    if (aBytes.length) M.HEAPU8.set(aBytes, ap);
    if (bBytes.length) M.HEAPU8.set(bBytes, bp);
    try {
      return fn(M, ap, aBytes.length, bp, bBytes.length);
    } finally {
      if (ap) M._free(ap);
      if (bp) M._free(bp);
    }
  }

  /**
   * Malloc `a`/`b` (encoded) plus a fresh ObjectId's 12 bytes, call
   * fn(M, aPtr, aLen, bPtr, bLen, idPtr), free everything, and return
   * { rc, defaultId }. Shared by replaceOne/updateOne/updateMany, which all
   * pass a filter + a second document and may need a fresh id for an
   * upsert (see the Db/Collection section's top comment for why JS always
   * generates one rather than C inventing it).
   */
  _marshalTriple(a, b, fn) {
    const M = requireModule();
    const aBytes = encode(a);
    const bBytes = encode(b);
    const defaultId = new ObjectId();
    const idBytes = defaultId.toBytes();

    const ap = aBytes.length ? M._malloc(aBytes.length) : 0;
    const bp = bBytes.length ? M._malloc(bBytes.length) : 0;
    const dp = M._malloc(12);
    if (aBytes.length) M.HEAPU8.set(aBytes, ap);
    if (bBytes.length) M.HEAPU8.set(bBytes, bp);
    M.HEAPU8.set(idBytes, dp);

    try {
      return { rc: fn(M, ap, aBytes.length, bp, bBytes.length, dp), defaultId };
    } finally {
      if (ap) M._free(ap);
      if (bp) M._free(bp);
      M._free(dp);
    }
  }

  async replaceOne(filter, replacement, { upsert = false } = {}) {
    if (replacement === null || typeof replacement !== 'object' || Array.isArray(replacement)) {
      throw new Error('replaceOne requires a replacement document object');
    }
    const watching = this._watchers.size > 0;
    const preId = watching ? await this._resolveDocumentKeyForWatch(filter) : null;
    const { rc, defaultId } = this._marshalTriple(filter, replacement, (M, fp, fn, rp, rn, dp) =>
      M._dcw_replace_one(this._collCtx, fp, fn, rp, rn, dp, upsert ? 1 : 0));
    if (rc < 0) throw codeError(rc, 'replaceOne');

    if (rc === 0) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    if (rc === 2) {
      const upsertedId = replacement._id !== undefined ? toObjectId(replacement._id) : defaultId;
      if (watching) {
        this._emitChange({ operationType: 'insert', documentKey: { _id: upsertedId }, fullDocument: { ...replacement, _id: upsertedId } });
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId };
    }
    if (watching && preId) {
      this._emitChange({ operationType: 'replace', documentKey: { _id: preId }, fullDocument: { ...replacement, _id: preId } });
    }
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }

  /**
   * Atomically find the first document matching `filter` and replace it,
   * returning the pre-image (`returnDocument: 'before'`, the default) or
   * the post-image (`'after'`) — or null if nothing matched and no upsert
   * happened (or `returnDocument: 'before'` with an upsert: no prior state
   * to return, matching real MongoDB).
   */
  async findOneAndReplace(filter, replacement, { upsert = false, returnDocument = 'before' } = {}) {
    if (replacement === null || typeof replacement !== 'object' || Array.isArray(replacement)) {
      throw new Error('findOneAndReplace requires a replacement document object');
    }
    const returnNew = returnDocument === 'after';
    const { rc } = this._marshalTriple(filter, replacement, (M, fp, fn, rp, rn, dp) =>
      M._dcw_find_one_and_replace(this._outCtx, this._collCtx, fp, fn, rp, rn, dp, upsert ? 1 : 0, returnNew ? 1 : 0));
    if (rc < 0) throw codeError(rc, 'findOneAndReplace');
    if (!rc) return null;
    const doc = this._readOut(requireModule());
    // Documented simplification: always 'replace', not distinguishing an
    // upsert-triggered insert (see docs/db-plan.md's change-streams entry).
    this._emitChange({
      operationType: 'replace',
      documentKey: { _id: doc._id },
      fullDocument: returnNew ? doc : { ...replacement, _id: doc._id }
    });
    return doc;
  }

  /**
   * Apply update operators (see c/db_update.h for the exact rules;
   * $currentDate is resolved here into $set before crossing the WASM
   * bridge) to the first document matching `filter`. `update`'s top level
   * must be entirely $-prefixed operators; for a full replacement document
   * use replaceOne instead.
   */
  async updateOne(filter, update, { upsert = false } = {}) {
    if (update === null || typeof update !== 'object' || Array.isArray(update)) {
      throw new Error('updateOne requires an update document object');
    }
    update = resolveCurrentDate(update);
    const watching = this._watchers.size > 0;
    const preId = watching ? await this._resolveDocumentKeyForWatch(filter) : null;
    const { rc, defaultId } = this._marshalTriple(filter, update, (M, fp, fn, up, un, dp) =>
      M._dcw_update_one(this._collCtx, fp, fn, up, un, dp, upsert ? 1 : 0));
    if (rc < 0) throw codeError(rc, 'updateOne');

    if (rc === 0) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    if (rc === 2) {
      if (watching) {
        this._emitChange({ operationType: 'insert', documentKey: { _id: defaultId }, fullDocument: await this.findOne({ _id: defaultId }) });
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: defaultId };
    }
    if (watching && preId) {
      this._emitChange({ operationType: 'update', documentKey: { _id: preId }, fullDocument: await this.findOne({ _id: preId }) });
    }
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }

  /**
   * Atomically find the first document matching `filter` and apply
   * `update` to it, returning the pre-image (`returnDocument: 'before'`,
   * the default) or the post-image (`'after'`) — or null, following
   * findOneAndReplace's exact convention for "nothing to return".
   */
  async findOneAndUpdate(filter, update, { upsert = false, returnDocument = 'before' } = {}) {
    if (update === null || typeof update !== 'object' || Array.isArray(update)) {
      throw new Error('findOneAndUpdate requires an update document object');
    }
    update = resolveCurrentDate(update);
    const returnNew = returnDocument === 'after';
    const { rc } = this._marshalTriple(filter, update, (M, fp, fn, up, un, dp) =>
      M._dcw_find_one_and_update(this._outCtx, this._collCtx, fp, fn, up, un, dp, upsert ? 1 : 0, returnNew ? 1 : 0));
    if (rc < 0) throw codeError(rc, 'findOneAndUpdate');
    if (!rc) return null;
    const doc = this._readOut(requireModule());
    if (this._watchers.size > 0) {
      // Documented simplification: always 'update', not distinguishing an
      // upsert-triggered insert (see docs/db-plan.md's change-streams entry).
      const fullDocument = returnNew ? doc : await this.findOne({ _id: doc._id });
      this._emitChange({ operationType: 'update', documentKey: { _id: doc._id }, fullDocument });
    }
    return doc;
  }

  /**
   * Like updateOne, but applies to every matching document. Does not
   * detect no-op updates (e.g. $set to a field's current value already
   * matching) — modifiedCount always mirrors matchedCount.
   */
  async updateMany(filter, update, { upsert = false } = {}) {
    if (update === null || typeof update !== 'object' || Array.isArray(update)) {
      throw new Error('updateMany requires an update document object');
    }
    update = resolveCurrentDate(update);
    const watching = this._watchers.size > 0;
    const preIds = watching ? (await this.find(filter, { projection: { _id: 1 } }).toArray()).map(d => d._id) : null;
    const { rc, defaultId } = this._marshalTriple(filter, update, (M, fp, fn, up, un, dp) =>
      M._dcw_update_many(this._outCtx, this._collCtx, fp, fn, up, un, dp, upsert ? 1 : 0));
    if (rc !== 0) throw codeError(rc, 'updateMany');

    const result = this._readOut(requireModule());
    if (watching) {
      if (result.upserted) {
        this._emitChange({ operationType: 'insert', documentKey: { _id: defaultId }, fullDocument: await this.findOne({ _id: defaultId }) });
      } else {
        // Documented cost note: with active watchers this is O(matched)
        // extra round trips (one findOne per matched document) -- fine for
        // a demo/observability feature, not a hot path.
        for (const _id of preIds) {
          this._emitChange({ operationType: 'update', documentKey: { _id }, fullDocument: await this.findOne({ _id }) });
        }
      }
    }
    return {
      acknowledged: true,
      matchedCount: result.matchedCount,
      modifiedCount: result.matchedCount,
      upsertedId: result.upserted ? defaultId : null
    };
  }

  async countDocuments(filter = {}) {
    const M = requireModule();
    const fbytes = encode(filter);
    const n = withBytes(M, fbytes, (p, len) => M._dcw_count(this._collCtx, p, len));
    if (n < 0) throw codeError(n, 'countDocuments');
    return n;
  }

  /** Real MongoDB's estimatedDocumentCount() is a metadata-based estimate
   * vs. countDocuments()'s exact scan; here {} is already an O(1)
   * bpt_size lookup on both, so this is a plain alias. */
  async estimatedDocumentCount() {
    return this.countDocuments({});
  }

  /** Unique values of `field` (dot-separated path) across every document
   * matching `filter`. */
  async distinct(field, filter = {}) {
    const M = requireModule();
    const f = allocStr(M, field);
    const fbytes = encode(filter);
    const fp = fbytes.length ? M._malloc(fbytes.length) : 0;
    if (fbytes.length) M.HEAPU8.set(fbytes, fp);
    let rc;
    try {
      rc = M._dcw_distinct(this._outCtx, this._collCtx, f.ptr, f.len, fp, fbytes.length);
    } finally {
      f.free();
      if (fp) M._free(fp);
    }
    if (rc !== 0) throw codeError(rc, 'distinct');
    return this._readOut(M) ?? [];
  }

  /**
   * Mixed-operation bulk write: each element of `operations` is exactly one
   * of {insertOne, updateOne, updateMany, replaceOne, deleteOne,
   * deleteMany}, shaped like the real driver's bulkWrite(). Pure JS
   * orchestration over the already-atomic Collection methods above — no
   * new C logic needed, since each sub-operation is already a complete,
   * atomic unit on its own (same reasoning as updateMany's per-document
   * journal commits). `ordered` (default true) stops at the first failing
   * operation; `false` attempts every operation and throws an aggregate
   * error afterward if any failed.
   */
  async bulkWrite(operations, { ordered = true } = {}) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error('bulkWrite requires a non-empty array of operations');
    }
    const result = {
      acknowledged: true, insertedCount: 0, matchedCount: 0, modifiedCount: 0,
      deletedCount: 0, upsertedCount: 0, insertedIds: {}, upsertedIds: {}
    };
    const errors = [];
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const type = Object.keys(op)[0];
      const spec = op[type];
      try {
        switch (type) {
          case 'insertOne': {
            const { insertedId } = await this.insertOne(spec.document);
            result.insertedIds[i] = insertedId;
            result.insertedCount++;
            break;
          }
          case 'updateOne':
          case 'updateMany':
          case 'replaceOne': {
            const method = type === 'replaceOne' ? spec.replacement : spec.update;
            const r = type === 'updateOne' ? await this.updateOne(spec.filter, method, { upsert: spec.upsert })
              : type === 'updateMany' ? await this.updateMany(spec.filter, method, { upsert: spec.upsert })
              : await this.replaceOne(spec.filter, method, { upsert: spec.upsert });
            result.matchedCount += r.matchedCount;
            result.modifiedCount += r.modifiedCount;
            if (r.upsertedId) { result.upsertedIds[i] = r.upsertedId; result.upsertedCount++; }
            break;
          }
          case 'deleteOne': {
            const r = await this.deleteOne(spec.filter);
            result.deletedCount += r.deletedCount;
            break;
          }
          case 'deleteMany': {
            const r = await this.deleteMany(spec.filter);
            result.deletedCount += r.deletedCount;
            break;
          }
          default:
            throw new Error(`bulkWrite: unknown operation type "${type}"`);
        }
      } catch (err) {
        errors.push({ index: i, error: err });
        if (ordered) break;
      }
    }
    if (errors.length > 0) {
      const err = new Error(
        `bulkWrite: ${errors.length} operation(s) failed (first at index ${errors[0].index}: ${errors[0].error.message})`
      );
      err.result = result;
      err.writeErrors = errors;
      throw err;
    }
    return result;
  }

  /**
   * Delete every document past its TTL cutoff, for every index created
   * with `expireAfterSeconds` (createIndex). There is no OPFS-level cron:
   * the host is responsible for calling this periodically (e.g.
   * setInterval, or only from whichever tab currently holds coordinator
   * leadership — src/db-coordinator.js) rather than this repo starting a
   * background timer on its own. Returns the total number of documents
   * removed across all TTL indexes.
   */
  async pruneExpired() {
    let deletedCount = 0;
    for (const ix of this._indexes.values()) {
      if (ix.kind !== 'equality' || ix.expireAfterSeconds === undefined) continue;
      const cutoff = new Date(Date.now() - ix.expireAfterSeconds * 1000);
      const { deletedCount: n } = await this.deleteMany({ [ix.fields[0]]: { $lt: cutoff } });
      deletedCount += n;
    }
    return deletedCount;
  }
}

class Db {
  constructor(provider, { order = DB_DEFAULT_ORDER } = {}) {
    this._provider = provider;
    this._order = order;
    this._catalog = null;
    this._collections = new Map();
    this.isOpen = false;
  }

  async open() {
    if (this.isOpen) throw new Error('Db is already open');
    const handle = await this._provider.openFile(DB_CATALOG_FILE, { create: true });
    this._catalog = new BPlusTree(handle, this._order);
    await this._catalog.open();
    this.isOpen = true;
  }

  async close() {
    if (!this.isOpen) return;
    for (const collection of this._collections.values()) await collection._close();
    this._collections.clear();
    await this._catalog.close();
    this._catalog = null;
    this.isOpen = false;
  }

  async collection(name) {
    if (!this.isOpen) throw new Error('Db is not open');
    checkCollectionName(name);
    const cached = this._collections.get(name);
    if (cached) return cached;

    let entry = this._catalog.search(name);
    if (!entry) {
      entry = { file: collectionFileName(name) };
      this._catalog.add(name, entry);
    }
    const handle = await this._provider.openFile(entry.file, { create: true });
    const tree = new BPlusTree(handle, this._order);
    const collection = new Collection(name, tree, {
      catalog: this._catalog,
      provider: this._provider,
      order: this._order
    });
    await collection._open();
    this._collections.set(name, collection);
    return collection;
  }

  async listCollections() {
    return this._catalog.toArray().map(({ key }) => key);
  }

  async dropCollection(name) {
    const entry = this._catalog.search(name);
    if (!entry) return false;
    const cached = this._collections.get(name);
    if (cached) {
      await cached._close();
      this._collections.delete(name);
    }
    this._catalog.delete(name);
    for (const def of entry.indexes || []) {
      if (def.kind === 'text') {
        for (const role of Object.keys(def.files)) await this._provider.deleteFile(def.files[role]);
      } else {
        await this._provider.deleteFile(def.file);
      }
    }
    await this._provider.deleteFile(entry.file);
    await this._provider.deleteFile(journalFileName(name));
    return true;
  }
}

async function connect(provider, options) {
  const db = new Db(provider, options);
  await db.open();
  return db;
}

/**
 * `MongoClient`-shaped: one root provider, many logical databases beneath
 * it. Each `db(name)` is a real, isolated storage scope of its own --
 * `provider.subProvider(name)`, a genuine OPFS subdirectory or an
 * independent in-memory file map depending on the provider -- so two
 * different names never share a catalog or collection files, the same
 * guarantee the cloud service's per-tenant `db(name)` routing makes
 * (service/tenant-worker.js's `createProvider(tenantId, dbName)`), just
 * without the tenant axis: here the root provider you hand to
 * `connectClient` already picks the "account". Opened `Db`s are cached
 * per name, same reasoning as `Db.collection()` caching `Collection`s --
 * repeat calls with the same name return the same live instance rather
 * than reopening files.
 */
class Client {
  constructor(provider, options) {
    this._provider = provider;
    this._options = options;
    this._dbs = new Map(); // name -> Db
  }

  async db(name) {
    checkDbName(name);
    const cached = this._dbs.get(name);
    if (cached) return cached;
    const sub = await this._provider.subProvider(name);
    const db = await connect(sub, this._options);
    this._dbs.set(name, db);
    return db;
  }

  async close() {
    for (const db of this._dbs.values()) await db.close();
    this._dbs.clear();
  }
}

async function connectClient(provider, options) {
  return new Client(provider, options);
}


export {
  ready,
  isReady,
  TYPE,
  ObjectId,
  Pointer,
  encode,
  decode,
  valueSize,
  BinJsonFile,
  MemoryHandle,
  exists,
  deleteFile,
  getFileHandle,
  orderedKey,
  compositeKey,
  compositeUpperBound,
  BPlusTree,
  haversineDistance,
  RTree,
  TextLog,
  TiledTextLog,
  ENTRY_TYPE,
  TextIndex,
  stemmer,
  createPatch,
  unifiedDiff,
  applyPatch,
  createDelta,
  applyDelta,
  MemoryStorageProvider,
  OPFSStorageProvider,
  ChangeStream,
  Collection,
  Db,
  connect,
  Client,
  connectClient
};
