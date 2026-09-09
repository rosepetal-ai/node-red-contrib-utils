/**
 * @file Worker-thread entry point. Receives one CPU job at a time from
 * cpu-pool.js, runs it with cpu-ops.js and hands the resulting parts back:
 * SharedArrayBuffer-backed parts are posted as-is, everything else is
 * transferred (zero copies).
 */
'use strict';

const { parentPort } = require('worker_threads');
const ops = require('./cpu-ops.js');

/** A part can only be transferred if it owns its whole ArrayBuffer (never a pool slice). */
function transferable(part) {
  if (ops.isShared(part)) return part;
  if (part.byteOffset === 0 && part.byteLength === part.buffer.byteLength) return part;
  const copy = Buffer.allocUnsafeSlow(part.byteLength);
  part.copy(copy);
  return copy;
}

parentPort.on('message', (job) => {
  try {
    const fn = ops[job.op];
    if (typeof fn !== 'function') {
      throw new Error(`Unknown CPU op: ${job.op}`);
    }
    const parts = fn(job.args).map(transferable);
    const transfer = new Set();
    for (const part of parts) {
      if (!ops.isShared(part)) transfer.add(part.buffer);
    }
    parentPort.postMessage({ id: job.id, ok: true, parts }, Array.from(transfer));
  } catch (err) {
    parentPort.postMessage({
      id: job.id,
      ok: false,
      error: { message: err && err.message ? err.message : String(err), stack: err && err.stack }
    });
  }
});
