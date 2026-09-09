/**
 * @file Small worker-thread pool for CPU-bound work (pixel reordering, raw
 * BMP / PNG encoding). Keeps the Node-RED event loop free and the number of
 * large copies at the bare minimum:
 *
 * - Large inputs are copied once into a SharedArrayBuffer, already in the row
 *   layout the encoder needs. The copy is time-budgeted: it yields to the event
 *   loop every TICK_BUDGET_MS, so no tick is blocked for more than that,
 *   regardless of image size. Small inputs are posted directly (their
 *   structured-clone cost is negligible).
 * - The worker mutates the shared memory in place and returns parts that are
 *   either views of that shared memory or transferred buffers: zero copies back.
 * - One worker is kept warm at all times; more are spawned lazily up to
 *   RP_CPU_WORKERS (default: min(4, cores - 1)) and terminated after IDLE_TTL_MS.
 * - Idle workers are unref'd, so they never keep the process alive.
 * - If worker threads cannot be created at all, the pool degrades to running the
 *   job inline (still async from the caller's point of view) and warns once.
 */
'use strict';

const { Worker } = require('worker_threads');
const { performance } = require('perf_hooks');
const os = require('os');
const path = require('path');
const ops = require('./cpu-ops.js');

const WORKER_FILE = path.join(__dirname, 'cpu-worker.js');
const IDLE_TTL_MS = 60 * 1000;
const MIN_WARM_WORKERS = 1;
const SHARED_THRESHOLD = 1024 * 1024;  // inputs >= 1 MB go through a SharedArrayBuffer
const SUB_SLICE = 256 * 1024;          // bytes copied between time-budget checks
const TICK_BUDGET_MS = 0.5;            // max main-thread time spent copying per event-loop turn
const HAS_SAB = typeof SharedArrayBuffer === 'function';

const hwThreads = typeof os.availableParallelism === 'function'
  ? os.availableParallelism()
  : (os.cpus() || []).length || 1;
const envMax = parseInt(process.env.RP_CPU_WORKERS, 10);
const MAX_WORKERS = Number.isInteger(envMax) && envMax > 0
  ? envMax
  : Math.max(1, Math.min(4, hwThreads - 1));

const workers = new Set(); // every live worker
const idle = [];           // workers waiting for a job
const pending = [];        // jobs waiting for a worker
let inlineFallback = false;
let nextJobId = 1;

function makeError(info) {
  const err = new Error(info && info.message ? info.message : 'CPU worker job failed');
  if (info && info.stack) err.stack = info.stack;
  return err;
}

function viewToBuffer(view) {
  if (Buffer.isBuffer(view)) return view;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Copy `src` into a fresh SharedArrayBuffer using the row layout `want`
 * (zero prefix / suffix bytes per row), never spending more than
 * TICK_BUDGET_MS of main-thread time per event-loop turn.
 */
async function copyToShared(src, want) {
  const rows = want ? want.rows : 1;
  const rowBytes = want ? want.rowBytes : src.byteLength;
  const prefix = want ? want.prefix : 0;
  const stride = want ? want.stride : src.byteLength;
  if (src.byteLength < rows * rowBytes) {
    throw new RangeError(`Image data has ${src.byteLength} bytes, expected at least ${rows * rowBytes}`);
  }
  const shared = new Uint8Array(new SharedArrayBuffer(rows * stride)); // zero-filled
  let tickStart = performance.now();
  for (let y = 0; y < rows; y++) {
    const s = y * rowBytes;
    const d = y * stride + prefix;
    for (let off = 0; off < rowBytes; off += SUB_SLICE) {
      const n = Math.min(SUB_SLICE, rowBytes - off);
      shared.set(src.subarray(s + off, s + off + n), d + off);
      if (performance.now() - tickStart >= TICK_BUDGET_MS) {
        await yieldToLoop();
        tickStart = performance.now();
      }
    }
  }
  return shared;
}

/**
 * Prepare `data` for a job without blocking the event loop.
 * @returns {Promise<{data: *, shared: boolean, layout: {prefix:number, suffix:number}|null}>}
 */
async function prepareInput(data, want) {
  if (!ArrayBuffer.isView(data)) return { data, shared: false, layout: null };
  const src = viewToBuffer(data);

  if (HAS_SAB && src.byteLength >= SHARED_THRESHOLD) {
    const shared = await copyToShared(src, want);
    return { data: shared, shared: true, layout: want ? { prefix: want.prefix, suffix: want.suffix } : null };
  }

  // Structured clone copies the *whole* underlying ArrayBuffer of a view, so a
  // small window into a much larger arena is compacted first.
  const total = data.buffer.byteLength;
  if (data.byteLength === total || total <= data.byteLength * 2 + 16384) {
    return { data, shared: false, layout: null };
  }
  const compact = Buffer.allocUnsafeSlow(data.byteLength);
  src.copy(compact);
  return { data: compact, shared: false, layout: null };
}

function spawnWorker() {
  const worker = new Worker(WORKER_FILE);
  worker._job = null;
  worker._idleTimer = null;
  worker.unref();

  worker.on('message', (reply) => {
    const job = worker._job;
    worker._job = null;
    if (job) {
      if (reply && reply.ok) job.resolve(reply.parts.map(viewToBuffer));
      else job.reject(makeError(reply && reply.error));
    }
    release(worker);
  });
  worker.on('error', (err) => dropWorker(worker, err));
  worker.on('exit', (code) => dropWorker(worker, new Error(`CPU worker exited with code ${code}`)));

  workers.add(worker);
  return worker;
}

function dropWorker(worker, err) {
  if (!workers.has(worker)) return;
  workers.delete(worker);
  const i = idle.indexOf(worker);
  if (i >= 0) idle.splice(i, 1);
  if (worker._idleTimer) clearTimeout(worker._idleTimer);
  const job = worker._job;
  worker._job = null;
  if (job) job.reject(err);
  pump();
}

function dispatch(worker, job) {
  if (worker._idleTimer) {
    clearTimeout(worker._idleTimer);
    worker._idleTimer = null;
  }
  worker._job = job;
  worker.ref(); // keep the process alive while work is in flight
  worker.postMessage({ id: job.id, op: job.op, args: job.args });
}

function release(worker) {
  if (!workers.has(worker)) return;
  const job = pending.shift();
  if (job) {
    dispatch(worker, job);
    return;
  }
  worker.unref();
  idle.push(worker);
  worker._idleTimer = setTimeout(() => {
    worker._idleTimer = null;
    if (workers.size <= MIN_WARM_WORKERS) return; // keep the last worker warm
    const i = idle.indexOf(worker);
    if (i < 0) return;
    idle.splice(i, 1);
    workers.delete(worker);
    worker.terminate().catch(() => {});
  }, IDLE_TTL_MS);
  worker._idleTimer.unref();
}

function pump() {
  while (pending.length > 0) {
    let worker = idle.pop();
    if (!worker) {
      if (workers.size >= MAX_WORKERS) return;
      try {
        worker = spawnWorker();
      } catch (err) {
        enableInlineFallback(err);
        return;
      }
    }
    dispatch(worker, pending.shift());
  }
}

function enableInlineFallback(err) {
  if (!inlineFallback) {
    inlineFallback = true;
    process.emitWarning(
      `Worker threads unavailable (${err && err.message ? err.message : err}); ` +
      'image encoding will run on the main thread.',
      'RosepetalCpuPool'
    );
  }
  while (pending.length > 0) {
    const job = pending.shift();
    runInline(job.op, job.args).then(job.resolve, job.reject);
  }
}

function runInline(op, args) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(ops[op](args).map(viewToBuffer));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** @returns {Promise<Buffer[]>} the parts produced by the op */
async function run(op, args, want) {
  const prepared = await prepareInput(args.data, want);
  args.data = prepared.data;
  args.layout = prepared.layout;
  if (inlineFallback) {
    args.owned = prepared.shared; // only our own copy may be mutated on the main thread
    return runInline(op, args);
  }
  args.owned = true; // a shared copy or a structured clone: private to this job
  return new Promise((resolve, reject) => {
    pending.push({ id: nextJobId++, op, args, resolve, reject });
    pump();
  });
}

// Keep one worker warm so the first image does not pay the thread start-up cost.
const warmUp = setImmediate(() => {
  if (inlineFallback || workers.size > 0 || MIN_WARM_WORKERS < 1) return;
  try {
    release(spawnWorker());
  } catch (err) {
    enableInlineFallback(err);
  }
});
if (warmUp && typeof warmUp.unref === 'function') warmUp.unref();

module.exports = {
  /** Swap R and B channels (RGB<->BGR, RGBA<->BGRA). Resolves with a Buffer (may be SharedArrayBuffer-backed). */
  async swapRB(data, channels) {
    const parts = await run('swapRB', { data, channels }, null);
    return parts[0];
  },
  /**
   * Encode raw pixels as BMP. Set swapRB when the input is RGB/RGBA (BMP is BGR native).
   * Resolves with the file parts [header, pixelRows] to be written in order.
   */
  encodeBmp(data, width, height, channels, swapRB = false) {
    const rowBytes = width * channels;
    const want = ops.rowLayout(height, rowBytes, 0, (4 - (rowBytes % 4)) % 4);
    return run('encodeBmp', { data, width, height, channels, swapRB }, want);
  },
  /**
   * Encode raw pixels as an uncompressed PNG. Set swapRB when the input is BGR/BGRA.
   * Resolves with the file parts [head, zlibStream, tail] to be written in order.
   */
  encodePng(data, width, height, channels, swapRB = false) {
    const want = ops.rowLayout(height, width * channels, 1, 0);
    return run('encodePng', { data, width, height, channels, swapRB }, want);
  },
  /** Diagnostics. */
  stats() {
    return { maxWorkers: MAX_WORKERS, workers: workers.size, idle: idle.length, pending: pending.length, inline: inlineFallback };
  }
};
