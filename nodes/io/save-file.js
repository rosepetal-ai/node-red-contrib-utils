/**
 * @file Generic filesystem sink that can write JSON, images, text, or binary data.
 * Designed to accept raw image objects, encoded buffers, or plain JS values.
 */
const fs = require('fs').promises;
const { createWriteStream } = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const path = require('path');
const sharp = require('sharp');
const cpuPool = require('../../lib/cpu-pool.js');
const JSON_WARN_BYTES = 5 * 1024 * 1024; // warn when JSON output is larger than 5MB
const STAT_CONCURRENCY = 64;             // concurrent fs.stat calls while scanning a folder
const SAVE_CONCURRENCY = 4;              // items saved in parallel in multiple mode
const DISK_INFO_TTL_MS = 1000;           // statfs results are reused for this long per folder
const WRITE_HIGH_WATER_MARK = 4 * 1024 * 1024;

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);
  const dirCache = new Map();       // folderPath -> Map(filename -> mtimeMs)
  const dirLoading = new Map();     // folderPath -> promise of the scan in progress
  const knownDirs = new Set();      // folders already created by this process
  const dirCreating = new Map();    // folderPath -> promise of the mkdir in progress
  const inFlightWrites = new Map(); // filePath -> promise of the write currently in progress

  /**
   * One shared Map per folder. Concurrent callers wait for the same scan so
   * filename reservations made by one save are visible to every other one.
   */
  function getCachedDir(folderPath) {
    const cached = dirCache.get(folderPath);
    if (cached) return Promise.resolve(cached);
    let loading = dirLoading.get(folderPath);
    if (loading) return loading;
    loading = (async () => {
      const map = new Map();
      try {
        const entries = await fs.readdir(folderPath, { withFileTypes: true });
        const names = entries.filter(e => e.isFile()).map(e => e.name);
        for (const { name, mtimeMs } of await statEntries(folderPath, names)) map.set(name, mtimeMs);
      } catch {
        // folder doesn't exist yet — empty cache is fine
      }
      dirCache.set(folderPath, map);
      return map;
    })();
    dirLoading.set(folderPath, loading);
    return loading.finally(() => dirLoading.delete(folderPath));
  }

  /** mkdir once per folder; concurrent callers share the same in-flight call. */
  function ensureDir(folderPath) {
    if (knownDirs.has(folderPath)) return Promise.resolve();
    let creating = dirCreating.get(folderPath);
    if (creating) return creating;
    creating = fs.mkdir(folderPath, { recursive: true }).then(() => { knownDirs.add(folderPath); });
    dirCreating.set(folderPath, creating);
    return creating.finally(() => dirCreating.delete(folderPath));
  }

  /** Write, recreating the folder once if it was removed behind our back. */
  async function writeWithRetry(folderPath, filePath, parts) {
    try {
      await writeParts(filePath, parts);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      knownDirs.delete(folderPath);
      dirCache.delete(folderPath);
      await ensureDir(folderPath);
      await writeParts(filePath, parts);
    }
  }

  /**
   * Writes to the same path are serialised so concurrent messages (or items of a
   * multiple-mode batch) can never interleave inside one file. Different paths
   * proceed fully in parallel.
   */
  function writeSerialized(folderPath, filePath, parts) {
    const previous = inFlightWrites.get(filePath) || Promise.resolve();
    const mine = previous.catch(() => {}).then(() => writeWithRetry(folderPath, filePath, parts));
    inFlightWrites.set(filePath, mine);
    return mine.finally(() => {
      if (inFlightWrites.get(filePath) === mine) inFlightWrites.delete(filePath);
    });
  }

  /**
   * Phase 1: resolve type, format and a unique filename, and reserve it.
   * Cheap (everything is cached after the first call per folder) and run in
   * item order so `_<n>` suffixes stay deterministic even when writes run in parallel.
   */
  async function planFile(folderPath, incoming, filenameRaw, opts) {
    const { configType, imageFormat: defaultImageFormat, overwriteEnabled } = opts;

    await ensureDir(folderPath);

    if (/[\\/]/.test(filenameRaw)) {
      throw new Error('Filename must not contain path separators.');
    }
    const parsedName = path.parse(filenameRaw);
    let baseName = parsedName.name || '';
    let extFromName = parsedName.ext ? parsedName.ext.replace(/^\./, '') : '';

    // Determine file type and format
    let imageFormat = String(defaultImageFormat).toLowerCase();
    const extInfo = mapExtension(extFromName);

    let fileType = configType;
    if (fileType === 'auto' && extInfo?.type) {
      fileType = extInfo.type;
      if (extInfo.format) imageFormat = extInfo.format;
    }

    const inferred = fileType === 'auto'
      ? await inferFileType(incoming, extInfo)
      : { type: fileType, format: imageFormat };

    fileType = inferred.type;
    if (fileType === 'image' && inferred.format) imageFormat = inferred.format;
    if (fileType === 'image' && extInfo?.format) imageFormat = extInfo.format;

    if (!['image', 'json', 'text', 'binary'].includes(fileType)) {
      throw new Error(`Unsupported file type: ${fileType}`);
    }

    // Finalize extension and name
    let extension = extFromName || defaultExtension(fileType, imageFormat);
    if (!extension) {
      throw new Error('Unable to determine file extension.');
    }
    if (!baseName) {
      baseName = defaultBaseName(fileType);
    }
    let filename = `${baseName}.${extension}`;
    let filePath = path.join(folderPath, filename);

    let reservedIn = null;
    if (overwriteEnabled) {
      const dirMap = await getCachedDir(folderPath);
      let counter = 2;
      while (dirMap.has(filename)) {
        filename = `${baseName}_${counter}.${extension}`;
        filePath = path.join(folderPath, filename);
        counter += 1;
        if (counter > 1000) {
          throw new Error('Too many file variations exist in target folder.');
        }
      }
      // Reserve the name right away so concurrent saves never pick the same one.
      dirMap.set(filename, Date.now());
      reservedIn = dirMap;
    }

    return { folderPath, filePath, filename, fileType, imageFormat, extension, inferred, reservedIn };
  }

  /**
   * Phase 2: encode and write a planned file. Safe to run for several plans concurrently.
   */
  async function writePlanned(plan, incoming, opts) {
    const { quality, pngCompression, webpOptions, jsonIndent, maxFiles, diskWarnState, diskThreshold, node } = opts;
    const { folderPath, filePath, filename, fileType, imageFormat, extension, inferred, reservedIn } = plan;

    // Check disk space
    const diskInfo = diskThreshold > 0 ? await getDiskUsageInfo(folderPath, node, diskWarnState) : null;
    if (diskInfo && diskInfo.usedRatio >= diskThreshold) {
      const usedPercent = (diskInfo.usedRatio * 100).toFixed(1);
      throw new Error(`Storage at "${folderPath}" is ${usedPercent}% full. Skipping save to avoid exhausting disk space.`);
    }

    // Prepare the file as an ordered list of Buffer parts (images may come back
    // from the worker as [header, pixels] so nothing has to be concatenated).
    let parts;
    try {
      if (fileType === 'image') {
        parts = await toImageParts(incoming, imageFormat, quality, pngCompression, webpOptions,
                                   NodeUtils, node, inferred.inputFormat);
      } else if (fileType === 'json') {
        let text;
        if (typeof incoming === 'string') {
          try {
            JSON.parse(incoming);
            text = incoming;
          } catch {
            text = JSON.stringify(incoming, null, jsonIndent);
          }
        } else {
          text = JSON.stringify(incoming, null, jsonIndent);
        }
        parts = [Buffer.from(text, 'utf8')];
      } else if (fileType === 'text') {
        const text = incoming === undefined || incoming === null ? '' : String(incoming);
        parts = [Buffer.from(text, 'utf8')];
      } else {
        parts = [await toBinary(incoming)];
      }

      await writeSerialized(folderPath, filePath, parts);
    } catch (err) {
      reservedIn?.delete(filename);
      throw err;
    }
    dirCache.get(folderPath)?.set(filename, Date.now());

    let sizeBytes = 0;
    for (const part of parts) sizeBytes += part.length;

    // Enforce max files retention policy
    if (maxFiles > 0) {
      try {
        await enforceMaxFiles(folderPath, maxFiles, dirCache.get(folderPath));
      } catch (policyErr) {
        node.warn(`Max files enforcement failed: ${policyErr.message}`);
      }
    }

    if (fileType === 'json' && sizeBytes >= JSON_WARN_BYTES) {
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
      node.warn(`JSON output is large (${sizeMB} MB); this may impact the event loop and memory usage.`);
    }

    const resultInfo = {
      path: filePath,
      filename,
      type: fileType,
      extension,
      sizeBytes
    };
    if (fileType === 'image') {
      resultInfo.format = imageFormat;
    }
    return resultInfo;
  }

  /**
   * Save a single file to disk. Shared by both single and multiple modes.
   * Returns a resultInfo object on success.
   */
  async function saveOneFile(folderPath, incoming, filenameRaw, opts) {
    const plan = await planFile(folderPath, incoming, filenameRaw, opts);
    return writePlanned(plan, incoming, opts);
  }

  function SaveFileNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const diskWarnState = { logged: false };

    node.on('input', async (msg, send, done) => {
      const started = Date.now();
      node.status({ fill: 'blue', shape: 'dot', text: 'saving...' });

      try {
        const evaluateProperty = (value, type, fallback = 'str') =>
          NodeUtils.evaluateProperty(node, value, type || fallback, msg);

        // Resolve max files retention limit
        let maxFiles = 0;
        const maxFilesType = config.maxFilesType || 'num';
        if (config.maxFiles !== undefined && config.maxFiles !== '') {
          const maxFilesRaw = maxFilesType === 'num'
            ? config.maxFiles
            : await evaluateProperty(config.maxFiles, maxFilesType);
          maxFiles = parseInt(maxFilesRaw, 10);
          if (isNaN(maxFiles) || maxFiles < 0) maxFiles = 0;
        }

        // Shared image/format config
        const quality = parseInt(config.imageQuality, 10) || 90;
        const pngCompression = Math.max(0, Math.min(9, parseInt(config.pngCompression, 10) || 0));
        const webpLossless = config.webpLossless === true || config.webpLossless === 'true';
        const webpSmartSubsample = config.webpSmartSubsample === true || config.webpSmartSubsample === 'true';
        const webpEffort = parseInt(config.webpEffort, 10);
        const webpOptions = { lossless: webpLossless, smartSubsample: webpSmartSubsample, effort: webpEffort };
        const jsonIndent = Number.isInteger(parseInt(config.jsonIndent, 10))
          ? parseInt(config.jsonIndent, 10)
          : 2;
        const overwriteEnabled = String(config.overwriteProtection) !== 'false';
        const configType = String(config.fileType || 'auto').toLowerCase();

        const diskThresholdPct = parseInt(config.diskThreshold, 10);
        const diskThreshold = (Number.isInteger(diskThresholdPct) && diskThresholdPct > 0 && diskThresholdPct <= 100)
          ? diskThresholdPct / 100
          : 0;

        const saveOpts = {
          configType, imageFormat: String(config.imageFormat || 'jpg'),
          quality, pngCompression, webpOptions, jsonIndent,
          overwriteEnabled, maxFiles, diskWarnState, diskThreshold, node
        };

        // Store output helper (context writes are async so async stores are supported)
        async function storeOutput(outputValue) {
          const outputPath = config.outputPath || 'savedFile';
          const outputPathType = config.outputPathType || 'msg';
          try {
            await NodeUtils.setProperty(node, outputPathType, outputPath, outputValue, msg);
          } catch (setErr) {
            node.warn(`Unable to store output metadata: ${setErr.message}`);
          }
        }

        if (config.mode === 'multiple') {
          // --- Multiple files mode ---
          const saveConfigType = config.saveConfigType || 'msg';
          let saveConfig = await evaluateProperty(config.saveConfig || 'payload', saveConfigType);

          // Wrap single object in array
          if (saveConfig && typeof saveConfig === 'object' && !Array.isArray(saveConfig)) {
            saveConfig = [saveConfig];
          }

          if (!Array.isArray(saveConfig) || saveConfig.length === 0) {
            node.warn('Save config is empty or invalid — nothing to save.');
            node.status({ fill: 'yellow', shape: 'ring', text: 'empty config' });
            done && done();
            return;
          }

          const imageField = config.imageField || 'bitmap';
          const filenameField = config.filenameField || 'filename';
          const filenameFieldType = config.filenameFieldType || 'item';
          const outputDirField = config.outputDirField || 'outputDir';
          const outputDirFieldType = config.outputDirFieldType || 'item';

          // Resolve shared values when type is msg/flow/global
          const sharedFilename = filenameFieldType !== 'item'
            ? await evaluateProperty(filenameField, filenameFieldType) : undefined;
          const sharedOutputDir = outputDirFieldType !== 'item'
            ? await evaluateProperty(outputDirField, outputDirFieldType) : undefined;

          // Phase 1 (sequential, in item order): validate items and reserve filenames.
          const plans = [];
          let skipped = 0;

          for (let idx = 0; idx < saveConfig.length; idx++) {
            try {
              const item = saveConfig[idx];
              if (!item || typeof item !== 'object') {
                node.warn(`Item ${idx}: not an object, skipping.`);
                skipped++;
                continue;
              }

              const incoming = item[imageField];
              if (incoming === undefined) {
                node.warn(`Item ${idx}: missing "${imageField}" field, skipping.`);
                skipped++;
                continue;
              }

              const folderPath = outputDirFieldType === 'item'
                ? String(item[outputDirField] ?? '').trim()
                : String(sharedOutputDir ?? '').trim();
              if (!folderPath) {
                node.warn(`Item ${idx}: missing or empty output dir, skipping.`);
                skipped++;
                continue;
              }

              const filenameRaw = filenameFieldType === 'item'
                ? (item[filenameField] !== undefined && item[filenameField] !== null
                    ? String(item[filenameField]).trim() : '')
                : (sharedFilename !== undefined && sharedFilename !== null
                    ? String(sharedFilename).trim() : '');

              plans.push({ idx, incoming, plan: await planFile(folderPath, incoming, filenameRaw, saveOpts) });
            } catch (itemErr) {
              node.warn(`Item ${idx}: ${itemErr.message}`);
              skipped++;
            }
          }

          // Phase 2 (bounded concurrency): encode and write. Results keep the item order.
          const slots = new Array(saveConfig.length);
          await mapLimit(plans, SAVE_CONCURRENCY, async ({ idx, incoming, plan }) => {
            try {
              slots[idx] = await writePlanned(plan, incoming, saveOpts);
            } catch (itemErr) {
              node.warn(`Item ${idx}: ${itemErr.message}`);
              skipped++;
            }
          });

          const results = slots.filter(r => r !== undefined);

          if (results.length === 0) {
            throw new Error('All items failed to save.');
          }

          await storeOutput(results);

          const elapsed = Date.now() - started;
          const total = results.length + skipped;
          const statusText = skipped > 0
            ? `saved ${results.length}/${total} files (${elapsed}ms)`
            : `saved ${results.length} files (${elapsed}ms)`;
          node.status({ fill: 'green', shape: 'dot', text: statusText });
          NodeUtils.recordPerformanceMetrics(node, msg, { taskMs: elapsed }, elapsed);

        } else {
          // --- Single file mode ---
          const folderPathType = config.folderPathType || 'str';
          const rawFolder = await evaluateProperty(config.folderPath, folderPathType);

          const inputPath = config.inputPath || 'payload';
          const inputPathType = config.inputPathType || 'msg';
          const rawInput = await NodeUtils.getProperty(node, inputPathType, inputPath, msg);
          if (rawInput === undefined) {
            throw new Error('No data found at configured input path.');
          }

          const filenameType = config.filenameType || 'str';
          const rawFilename = await evaluateProperty(config.filename, filenameType);

          const folderPath = String(rawFolder ?? '').trim();
          if (!folderPath) {
            throw new Error('Folder path is empty.');
          }

          const filenameRaw = rawFilename !== undefined && rawFilename !== null
            ? String(rawFilename).trim() : '';

          const resultInfo = await saveOneFile(folderPath, rawInput, filenameRaw, saveOpts);
          await storeOutput(resultInfo);

          const elapsed = Date.now() - started;
          node.status({ fill: 'green', shape: 'dot', text: `saved ${resultInfo.filename} (${elapsed}ms)` });
          NodeUtils.recordPerformanceMetrics(node, msg, { taskMs: elapsed }, elapsed);
        }

        send(msg);
        done && done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'Error' });
        node.error(err.message, msg);
        done && done(err);
      }
    });
  }

  RED.nodes.registerType('rp-save-file', SaveFileNode);
};

// Helpers

/** Run `fn` over `items` with at most `limit` in flight; results keep item order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = [];
  for (let l = 0; l < Math.min(limit, items.length); l++) {
    lanes.push((async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(lanes);
  return results;
}

/** stat many files with bounded concurrency, ignoring ones removed meanwhile. */
async function statEntries(folderPath, names) {
  const entries = await mapLimit(names, STAT_CONCURRENCY, async (name) => {
    try {
      const st = await fs.stat(path.join(folderPath, name));
      return { name, mtimeMs: st.mtimeMs };
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  });
  return entries.filter(Boolean);
}

/** Write an ordered list of Buffer parts to `filePath` without concatenating them. */
function writeParts(filePath, parts) {
  if (parts.length === 1) return fs.writeFile(filePath, parts[0]);
  return pipeline(Readable.from(parts), createWriteStream(filePath, { highWaterMark: WRITE_HIGH_WATER_MARK }));
}

function mapExtension(ext) {
  if (!ext) return null;
  const lower = ext.toLowerCase();
  if (lower === 'jpg' || lower === 'jpeg') return { type: 'image', format: 'jpg' };
  if (lower === 'png') return { type: 'image', format: 'png' };
  if (lower === 'webp') return { type: 'image', format: 'webp' };
  if (lower === 'bmp') return { type: 'image', format: 'bmp' };
  if (lower === 'json') return { type: 'json' };
  if (lower === 'txt') return { type: 'text' };
  if (lower === 'bin' || lower === 'dat') return { type: 'binary' };
  return null;
}

function defaultExtension(type, imageFormat) {
  if (type === 'image') return imageFormat || 'jpg';
  if (type === 'json') return 'json';
  if (type === 'text') return 'txt';
  if (type === 'binary') return 'bin';
  return '';
}

function defaultBaseName(type) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '-$1Z')
    .replace('T', '_');
  switch (type) {
    case 'image': return `image_${timestamp}`;
    case 'json': return `data_${timestamp}`;
    case 'text': return `text_${timestamp}`;
    default: return `file_${timestamp}`;
  }
}

async function inferFileType(value, extInfo) {
  if (extInfo?.type) {
    return { type: extInfo.type, format: extInfo.format };
  }

  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) {
      // The detected format is passed along so the encoder does not parse the header twice.
      let inputFormat = null;
      try {
        const meta = await sharp(value).metadata();
        inputFormat = meta?.format || null;
        const fmt = normalizeSharpFormat(inputFormat);
        if (fmt) return { type: 'image', format: fmt, inputFormat };
      } catch {
        // Not an image buffer
      }
      return { type: 'binary', inputFormat };
    }

    if (isRawImageLike(value)) {
      return { type: 'image' };
    }

    return { type: 'json' };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      return { type: 'json' };
    }
    return { type: 'text' };
  }

  return { type: 'binary' };
}

function normalizeSharpFormat(fmt) {
  if (!fmt) return null;
  if (fmt === 'jpeg' || fmt === 'jpg') return 'jpg';
  if (fmt === 'png') return 'png';
  if (fmt === 'webp') return 'webp';
  return null;
}

function isRawImageLike(obj) {
  return obj &&
    typeof obj === 'object' &&
    !Buffer.isBuffer(obj) &&
    Object.prototype.hasOwnProperty.call(obj, 'data') &&
    Object.prototype.hasOwnProperty.call(obj, 'width') &&
    Object.prototype.hasOwnProperty.call(obj, 'height');
}

async function toBinary(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === 'object' && Buffer.isBuffer(value.data)) {
    return Buffer.from(value.data);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  return Buffer.from(JSON.stringify(value ?? ''), 'utf8');
}

/**
 * Encode an image into an ordered list of Buffer parts.
 * @param {string|null|undefined} knownInputFormat - sharp format already detected
 *   for encoded buffers (undefined = not probed yet, null = not an image).
 * @returns {Promise<Buffer[]>}
 */
async function toImageParts(imageValue, format, quality, pngCompression, webpOptions, NodeUtils, node, knownInputFormat) {
  // Encoded buffer path
  if (Buffer.isBuffer(imageValue) && !(imageValue.width && imageValue.height)) {
    let inputFormat = knownInputFormat;
    if (inputFormat === undefined) {
      try {
        const metadata = await sharp(imageValue).metadata();
        inputFormat = metadata.format;
      } catch {
        inputFormat = null;
      }
    }

    if (inputFormat && (normalizeSharpFormat(inputFormat) === format)) {
      return [imageValue];
    }

    const sharpInstance = sharp(imageValue);
    return [await encodeSharp(sharpInstance, format, quality, pngCompression, webpOptions)];
  }

  // Raw image path (uses validator for clear errors)
  const validated = NodeUtils.validateImageStructure(imageValue, node);
  if (!validated) {
    throw new Error('Invalid image structure.');
  }

  const colorSpace = validated.colorSpace;
  const channels = validated.channels;
  const isBgr = colorSpace === 'BGR' || colorSpace === 'BGRA';
  const isRgb = colorSpace === 'RGB' || colorSpace === 'RGBA';
  const width = validated.width;
  const height = validated.height;

  // BMP stores pixels in BGR order natively: raw encoder on a worker thread,
  // swapping channels when the source is RGB/RGBA. Returns [header, pixels].
  if (format === 'bmp') {
    return cpuPool.encodeBmp(validated.data, width, height, channels, isRgb);
  }

  // Fast PNG path (compression 0): raw encoder on a worker thread, no Sharp
  // overhead. Returns [head, zlib stream, tail].
  if (format === 'png' && pngCompression === 0) {
    return cpuPool.encodePng(validated.data, width, height, channels, isBgr);
  }

  // Sharp expects RGB/RGBA; reorder BGR/BGRA on a worker thread (returns a copy).
  const data = isBgr
    ? await cpuPool.swapRB(validated.data, channels)
    : validated.data;

  let sharpInstance = sharp(data, {
    raw: { width, height, channels }
  });

  if (colorSpace === 'GRAY') {
    sharpInstance = sharpInstance.toColourspace('b-w');
  }

  return [await encodeSharp(sharpInstance, format, quality, pngCompression, webpOptions)];
}

function encodeSharp(sharpInstance, format, quality, pngCompression, webpOptions) {
  if (format === 'png') {
    return sharpInstance.png({ compressionLevel: pngCompression }).toBuffer();
  }
  if (format === 'webp') {
    const opts = { quality };
    if (webpOptions) {
      if (webpOptions.lossless) opts.lossless = true;
      if (webpOptions.smartSubsample) opts.smartSubsample = true;
      if (typeof webpOptions.effort === 'number' && webpOptions.effort >= 0 && webpOptions.effort <= 6) {
        opts.effort = webpOptions.effort;
      }
    }
    return sharpInstance.webp(opts).toBuffer();
  }
  return sharpInstance.jpeg({ quality }).toBuffer();
}

async function enforceMaxFiles(folderPath, maxCount, cachedMap) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const diskFiles = new Set();
  for (const e of entries) {
    if (e.isFile()) diskFiles.add(e.name);
  }
  if (diskFiles.size <= maxCount) {
    // Prune cache entries for files removed externally
    if (cachedMap) {
      for (const name of cachedMap.keys()) {
        if (!diskFiles.has(name)) cachedMap.delete(name);
      }
    }
    return;
  }

  // Stat only files not yet in cache
  if (cachedMap) {
    // Remove stale cache entries
    for (const name of cachedMap.keys()) {
      if (!diskFiles.has(name)) cachedMap.delete(name);
    }
    // Stat new/unknown files
    const unknown = [];
    for (const name of diskFiles) {
      if (!cachedMap.has(name)) unknown.push(name);
    }
    if (unknown.length > 0) {
      for (const { name, mtimeMs } of await statEntries(folderPath, unknown)) cachedMap.set(name, mtimeMs);
    }
  }

  // Build sorted list from cache (or fall back to full stat if no cache)
  let sorted;
  if (cachedMap && cachedMap.size > 0) {
    sorted = Array.from(cachedMap.entries()).map(([name, mtimeMs]) => ({ name, mtimeMs }));
  } else {
    sorted = await statEntries(folderPath, Array.from(diskFiles));
  }
  sorted.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const toRemove = sorted.length - maxCount;
  for (let i = 0; i < toRemove; i++) {
    try {
      await fs.unlink(path.join(folderPath, sorted[i].name));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    cachedMap?.delete(sorted[i].name);
  }
}

const diskInfoCache = new Map(); // targetPath -> { at, info }

async function getDiskUsageInfo(targetPath, node, warnState) {
  const cached = diskInfoCache.get(targetPath);
  if (cached && Date.now() - cached.at < DISK_INFO_TTL_MS) return cached.info;
  try {
    const stats = await fs.statfs(targetPath);
    const blockSize = Number(stats.bsize) || 0;
    const totalBlocks = Number(stats.blocks) || 0;
    const availableBlocks = Number(
      stats.bavail !== undefined ? stats.bavail :
      stats.bfree !== undefined ? stats.bfree : 0
    );

    const totalBytes = totalBlocks * blockSize;
    const availableBytes = availableBlocks * blockSize;

    if (totalBytes <= 0) {
      return null;
    }

    const usedRatio = 1 - (availableBytes / totalBytes);
    const info = { totalBytes, availableBytes, usedRatio };
    if (diskInfoCache.size > 1000) diskInfoCache.clear();
    diskInfoCache.set(targetPath, { at: Date.now(), info });
    return info;
  } catch (err) {
    if (!warnState.logged) {
      node.warn(`Disk usage check failed for "${targetPath}": ${err.message}`);
      warnState.logged = true;
    }
    return null;
  }
}
