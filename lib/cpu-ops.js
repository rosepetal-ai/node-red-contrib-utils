/**
 * @file Pure CPU-bound helpers: pixel channel reordering and raw BMP / PNG encoding.
 *
 * Everything in this file is synchronous *by design*: it is executed inside a
 * worker thread (see cpu-worker.js / cpu-pool.js) so the Node-RED event loop is
 * never blocked. Do not call these functions directly from the main thread —
 * go through cpu-pool.js instead.
 *
 * Zero-copy design
 * ----------------
 * The pool lays the pixels out in a SharedArrayBuffer *already in the shape the
 * encoder needs* (see rowLayout: a zero prefix byte per row for PNG filters, zero
 * padding bytes per row for BMP). The ops then work in place on that shared
 * memory: channel swaps mutate it, BMP returns [header, sharedPixels], PNG feeds
 * it straight to zlib. No 33 MB intermediates, no page-fault storms.
 *
 * Every op returns an array of "parts" (Buffers) that are written to disk one
 * after the other. Parts backed by a SharedArrayBuffer are posted as-is; other
 * parts are transferred to the main thread with zero copies.
 */
'use strict';

const zlib = require('zlib');

const HAS_SAB = typeof SharedArrayBuffer === 'function';
const IDAT_TYPE = Buffer.from('IDAT');

const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : makeJsCrc32();

/** Table-based CRC32 fallback for Node versions without zlib.crc32 (< 20.15 / 22.2). */
function makeJsCrc32() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return function jsCrc32(buf, initial = 0) {
    let crc = ~initial;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (~crc) >>> 0;
  };
}

function isShared(view) {
  return HAS_SAB && view && view.buffer instanceof SharedArrayBuffer;
}

/** Normalise whatever the structured clone delivered into a Buffer view (no copy when possible). */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer || (HAS_SAB && value instanceof SharedArrayBuffer)) return Buffer.from(value);
  return Buffer.from(value);
}

/**
 * Describe a row-based memory layout: every row is `prefix` zero bytes,
 * `rowBytes` pixel bytes and `suffix` zero bytes.
 */
function rowLayout(rows, rowBytes, prefix, suffix) {
  const stride = prefix + rowBytes + suffix;
  return { rows, rowBytes, prefix, suffix, stride, total: rows * stride };
}

/**
 * Return `args.data` laid out as `want` and safe to mutate.
 *
 * - If the pool already produced this layout and the job owns the memory, the
 *   very same buffer is returned (zero copies).
 * - Otherwise the rows are copied into a fresh zero-filled buffer. This only
 *   happens for small inputs (structured-clone path) or the inline fallback.
 */
function materialize(args, want) {
  const src = toBuffer(args.data);
  const have = args.layout || { prefix: 0, suffix: 0 };
  const sameLayout = have.prefix === want.prefix && have.suffix === want.suffix;

  if (sameLayout && src.length === want.total) {
    if (args.owned) return src;
    const copy = Buffer.allocUnsafeSlow(src.length);
    src.copy(copy);
    return copy;
  }

  const srcStride = have.prefix + want.rowBytes + have.suffix;
  if (src.length < want.rows * srcStride) {
    throw new RangeError(`Image data has ${src.length} bytes, expected at least ${want.rows * srcStride}`);
  }
  const out = Buffer.alloc(want.total); // zero-filled: prefix / suffix bytes must be 0
  for (let y = 0; y < want.rows; y++) {
    const s = y * srcStride + have.prefix;
    src.copy(out, y * want.stride + want.prefix, s, s + want.rowBytes);
  }
  return out;
}

/** Swap channel 0 and channel 2 (RGB<->BGR, RGBA<->BGRA) in place, row by row. */
function swapInPlace(buf, layout, channels) {
  if (channels < 3) return;
  for (let y = 0; y < layout.rows; y++) {
    const start = y * layout.stride + layout.prefix;
    const end = start + layout.rowBytes - (layout.rowBytes % channels);
    for (let i = start; i < end; i += channels) {
      const t = buf[i];
      buf[i] = buf[i + 2];
      buf[i + 2] = t;
    }
  }
}

/**
 * Swap R and B channels of a contiguous pixel buffer.
 * @param {{data, channels, layout?, owned?}} args
 * @returns {Buffer[]} a single part
 */
function swapRB(args) {
  const src = toBuffer(args.data);
  const want = rowLayout(1, src.length, 0, 0);
  const buf = materialize(args, want);
  swapInPlace(buf, want, args.channels);
  return [buf];
}

/**
 * Encode raw pixels as an uncompressed BMP (top-down, 8-bit gray / 24-bit BGR / 32-bit BGRA).
 * Pass swapRB=true for RGB/RGBA input (BMP stores BGR natively).
 * @returns {Buffer[]} [header, pixelRows]
 */
function encodeBmp({ data, width, height, channels, swapRB: doSwap, layout, owned }) {
  const rowBytes = width * channels;
  const rowPadding = (4 - (rowBytes % 4)) % 4;
  const want = rowLayout(height, rowBytes, 0, rowPadding);
  const pixels = materialize({ data, layout, owned }, want);
  if (doSwap) swapInPlace(pixels, want, channels);

  const hasPalette = channels === 1;
  const paletteSize = hasPalette ? 1024 : 0; // 256 RGBX entries
  const headerSize = 14 + 40 + paletteSize;
  const fileSize = headerSize + want.total;
  const header = Buffer.allocUnsafeSlow(headerSize);

  // BITMAPFILEHEADER (14 bytes)
  header[0] = 0x42; header[1] = 0x4D; // 'BM'
  header.writeUInt32LE(fileSize, 2);
  header.writeUInt16LE(0, 6);  // reserved
  header.writeUInt16LE(0, 8);  // reserved
  header.writeUInt32LE(headerSize, 10);

  // BITMAPINFOHEADER (40 bytes)
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(-height, 22); // negative = top-down
  header.writeUInt16LE(1, 26);      // planes
  header.writeUInt16LE(channels * 8, 28);
  header.writeUInt32LE(0, 30);      // no compression
  header.writeUInt32LE(want.total, 34);
  header.writeInt32LE(2835, 38);    // ~72 DPI horizontal
  header.writeInt32LE(2835, 42);    // ~72 DPI vertical
  header.writeUInt32LE(hasPalette ? 256 : 0, 46); // colors used
  header.writeUInt32LE(0, 50);      // important colors

  // Grayscale palette for 1-channel images
  if (hasPalette) {
    for (let i = 0; i < 256; i++) {
      const off = 54 + i * 4;
      header[off] = i; header[off + 1] = i; header[off + 2] = i; header[off + 3] = 0;
    }
  }

  return [header, pixels];
}

/**
 * Encode raw pixels as a PNG with stored (level 0) deflate blocks.
 * Pass swapRB=true for BGR/BGRA input (PNG stores RGB).
 * @returns {Buffer[]} [signature+IHDR+IDAT header, zlib stream, IDAT crc+IEND]
 */
function encodePng({ data, width, height, channels, swapRB: doSwap, layout, owned }) {
  const want = rowLayout(height, width * channels, 1, 0); // one filter byte (0 = none) per row
  const filtered = materialize({ data, layout, owned }, want);
  if (doSwap) swapInPlace(filtered, want, channels);

  const compressed = zlib.deflateSync(filtered, { level: 0 });
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;

  // Signature + IHDR chunk + IDAT length/type
  const head = Buffer.allocUnsafeSlow(8 + 25 + 8);
  let o = 0;
  head[o++] = 137; head[o++] = 80; head[o++] = 78; head[o++] = 71;
  head[o++] = 13;  head[o++] = 10; head[o++] = 26; head[o++] = 10;
  head.writeUInt32BE(13, o); o += 4;
  const ihdrTypeStart = o;
  head.write('IHDR', o); o += 4;
  head.writeUInt32BE(width, o); o += 4;
  head.writeUInt32BE(height, o); o += 4;
  head[o++] = 8; // bit depth
  head[o++] = colorType;
  head[o++] = 0; // compression
  head[o++] = 0; // filter
  head[o++] = 0; // interlace
  head.writeUInt32BE(crc32(head.subarray(ihdrTypeStart, o)), o); o += 4;
  head.writeUInt32BE(compressed.length, o); o += 4;
  head.write('IDAT', o);

  // IDAT crc (running crc over type + data) + IEND chunk
  const tail = Buffer.allocUnsafeSlow(4 + 12);
  tail.writeUInt32BE(crc32(compressed, crc32(IDAT_TYPE)), 0);
  tail.writeUInt32BE(0, 4);
  tail.write('IEND', 8);
  tail.writeUInt32BE(crc32(tail.subarray(8, 12)), 12);

  return [head, compressed, tail];
}

module.exports = { swapRB, encodeBmp, encodePng, rowLayout, isShared, toBuffer };
