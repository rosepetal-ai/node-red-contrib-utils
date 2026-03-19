/**
 * @file Generic filesystem sink that can write JSON, images, text, or binary data.
 * Designed to accept raw image objects, encoded buffers, or plain JS values.
 */
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const zlib = require('zlib');
const JSON_WARN_BYTES = 5 * 1024 * 1024; // warn when JSON output is larger than 5MB

const _chunkCrc32 = (buf) => zlib.crc32(buf);

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);
  const dirCache = new Map();

  async function getCachedDir(folderPath) {
    if (dirCache.has(folderPath)) return dirCache.get(folderPath);
    const map = new Map();
    try {
      const entries = await fs.readdir(folderPath, { withFileTypes: true });
      const files = entries.filter(e => e.isFile());
      const stats = await Promise.all(
        files.map(async (f) => {
          const st = await fs.stat(path.join(folderPath, f.name));
          return { name: f.name, mtimeMs: st.mtimeMs };
        })
      );
      for (const { name, mtimeMs } of stats) map.set(name, mtimeMs);
    } catch {
      // folder doesn't exist yet — empty cache is fine
    }
    dirCache.set(folderPath, map);
    return map;
  }

  /**
   * Save a single file to disk. Shared by both single and multiple modes.
   * Returns a resultInfo object on success.
   */
  async function saveOneFile(folderPath, incoming, filenameRaw, opts) {
    const { configType, imageFormat: defaultImageFormat, quality, pngCompression, webpOptions,
            jsonIndent, overwriteEnabled, maxFiles, diskWarnState, node } = opts;

    await fs.mkdir(folderPath, { recursive: true });

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
    }

    // Check disk space (skip if 90%+ used)
    const diskInfo = await getDiskUsageInfo(folderPath, node, diskWarnState);
    if (diskInfo && diskInfo.usedRatio >= 0.9) {
      const usedPercent = (diskInfo.usedRatio * 100).toFixed(1);
      throw new Error(`Storage at "${folderPath}" is ${usedPercent}% full. Skipping save to avoid exhausting disk space.`);
    }

    // Prepare data to write
    let payloadToWrite;
    let isText = false;

    if (fileType === 'image') {
      payloadToWrite = await toImageBuffer(incoming, imageFormat, quality, pngCompression, webpOptions, NodeUtils, node);
    } else if (fileType === 'json') {
      if (typeof incoming === 'string') {
        try {
          JSON.parse(incoming);
          payloadToWrite = incoming;
        } catch {
          payloadToWrite = JSON.stringify(incoming, null, jsonIndent);
        }
      } else {
        payloadToWrite = JSON.stringify(incoming, null, jsonIndent);
      }
      isText = true;
    } else if (fileType === 'text') {
      payloadToWrite = incoming === undefined || incoming === null ? '' : String(incoming);
      isText = true;
    } else {
      payloadToWrite = await toBinary(incoming);
    }

    if (isText) {
      await fs.writeFile(filePath, payloadToWrite, 'utf8');
    } else {
      await fs.writeFile(filePath, payloadToWrite);
    }
    dirCache.get(folderPath)?.set(filename, Date.now());

    const sizeBytes = isText
      ? Buffer.byteLength(payloadToWrite, 'utf8')
      : payloadToWrite.length;

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

  function SaveFileNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const diskWarnState = { logged: false };

    node.on('input', async (msg, send, done) => {
      const started = Date.now();
      node.status({ fill: 'blue', shape: 'dot', text: 'saving...' });

      try {
        const evaluateProperty = (value, type, fallback = 'str') =>
          new Promise((resolve, reject) => {
            const actualType = type || fallback;
            try {
              RED.util.evaluateNodeProperty(value, actualType, node, msg, (err, res) => {
                if (err) reject(err);
                else resolve(res);
              });
            } catch (err) {
              reject(err);
            }
          });

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

        const saveOpts = {
          configType, imageFormat: String(config.imageFormat || 'jpg'),
          quality, pngCompression, webpOptions, jsonIndent,
          overwriteEnabled, maxFiles, diskWarnState, node
        };

        // Store output helper
        function storeOutput(outputValue) {
          const outputPath = config.outputPath || 'savedFile';
          const outputPathType = config.outputPathType || 'msg';
          try {
            if (outputPathType === 'msg') {
              RED.util.setMessageProperty(msg, outputPath, outputValue, true);
            } else if (outputPathType === 'flow') {
              node.context().flow.set(outputPath, outputValue);
            } else if (outputPathType === 'global') {
              node.context().global.set(outputPath, outputValue);
            }
          } catch (setErr) {
            node.warn(`Unable to store output metadata: ${setErr.message}`);
          }
        }

        if (config.mode === 'multiple') {
          // --- Multiple files mode ---
          const saveConfigType = config.saveConfigType || 'msg';
          let saveConfig;
          if (saveConfigType === 'msg') {
            saveConfig = RED.util.getMessageProperty(msg, config.saveConfig || 'payload');
          } else {
            saveConfig = await evaluateProperty(config.saveConfig || 'payload', saveConfigType);
          }

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

          const results = [];
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

              const resultInfo = await saveOneFile(folderPath, incoming, filenameRaw, saveOpts);
              results.push(resultInfo);
            } catch (itemErr) {
              node.warn(`Item ${idx}: ${itemErr.message}`);
              skipped++;
            }
          }

          if (results.length === 0) {
            throw new Error('All items failed to save.');
          }

          storeOutput(results);

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
          let rawInput;
          if (inputPathType === 'msg') {
            rawInput = RED.util.getMessageProperty(msg, inputPath);
          } else if (inputPathType === 'flow') {
            rawInput = node.context().flow.get(inputPath);
          } else if (inputPathType === 'global') {
            rawInput = node.context().global.get(inputPath);
          }
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
          storeOutput(resultInfo);

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
      try {
        const meta = await sharp(value).metadata();
        if (meta?.format) {
          const fmt = normalizeSharpFormat(meta.format);
          if (fmt) return { type: 'image', format: fmt };
        }
      } catch {
        // Not an image buffer
      }
      return { type: 'binary' };
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

async function toImageBuffer(imageValue, format, quality, pngCompression, webpOptions, NodeUtils, node) {
  // Encoded buffer path
  if (Buffer.isBuffer(imageValue) && !(imageValue.width && imageValue.height)) {
    let inputFormat;
    try {
      const metadata = await sharp(imageValue).metadata();
      inputFormat = metadata.format;
    } catch {
      inputFormat = null;
    }

    if (inputFormat && (normalizeSharpFormat(inputFormat) === format)) {
      return imageValue;
    }

    const sharpInstance = sharp(imageValue);
    return encodeSharp(sharpInstance, format, quality, pngCompression, webpOptions);
  }

  // Raw image path (uses validator for clear errors)
  const validated = NodeUtils.validateImageStructure(imageValue, node);
  if (!validated) {
    throw new Error('Invalid image structure.');
  }

  const colorSpace = validated.colorSpace;
  const channels = validated.channels;
  let data = validated.data;

  // BMP stores pixels in BGR order natively
  if (format === 'bmp') {
    let nativeData = data;
    if (colorSpace === 'RGB' || colorSpace === 'RGBA') {
      nativeData = Buffer.from(data);
      for (let i = 0; i < nativeData.length; i += channels) {
        const t = nativeData[i]; nativeData[i] = nativeData[i + 2]; nativeData[i + 2] = t;
      }
    }
    const buf = Buffer.isBuffer(nativeData) ? nativeData : Buffer.from(nativeData);
    return encodeBmpRaw(buf, validated.width, validated.height, channels);
  }

  if (colorSpace === 'BGR' || colorSpace === 'BGRA') {
    data = Buffer.from(data);
    for (let i = 0; i < data.length; i += channels) {
      const t = data[i];
      data[i] = data[i + 2];
      data[i + 2] = t;
    }
  }

  // Fast PNG path: raw encoder with native CRC32, no Sharp overhead
  if (format === 'png' && pngCompression === 0) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return encodePngRaw(buf, validated.width, validated.height, channels);
  }

  let sharpInstance = sharp(data, {
    raw: {
      width: validated.width,
      height: validated.height,
      channels: channels
    }
  });

  if (colorSpace === 'GRAY') {
    sharpInstance = sharpInstance.toColourspace('b-w');
  }

  return encodeSharp(sharpInstance, format, quality, pngCompression, webpOptions);
}

function encodeBmpRaw(data, width, height, channels) {
  const bpp = channels * 8;
  const rowBytes = width * channels;
  const rowPadding = (4 - (rowBytes % 4)) % 4;
  const paddedRow = rowBytes + rowPadding;
  const hasPalette = channels === 1;
  const paletteSize = hasPalette ? 1024 : 0; // 256 RGBX entries
  const headerSize = 14 + 40 + paletteSize;
  const pixelDataSize = paddedRow * height;
  const fileSize = headerSize + pixelDataSize;

  const buf = Buffer.allocUnsafe(fileSize);

  // BITMAPFILEHEADER (14 bytes)
  buf[0] = 0x42; buf[1] = 0x4D; // 'BM'
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt16LE(0, 6);  // reserved
  buf.writeUInt16LE(0, 8);  // reserved
  buf.writeUInt32LE(headerSize, 10);

  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22); // negative = top-down
  buf.writeUInt16LE(1, 26);     // planes
  buf.writeUInt16LE(bpp, 28);
  buf.writeUInt32LE(0, 30);     // no compression
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);   // ~72 DPI horizontal
  buf.writeInt32LE(2835, 42);   // ~72 DPI vertical
  buf.writeUInt32LE(hasPalette ? 256 : 0, 46); // colors used
  buf.writeUInt32LE(0, 50);     // important colors

  // Grayscale palette for 1-channel images
  if (hasPalette) {
    for (let i = 0; i < 256; i++) {
      const off = 54 + i * 4;
      buf[off] = i; buf[off + 1] = i; buf[off + 2] = i; buf[off + 3] = 0;
    }
  }

  // Pixel data with row padding
  const padBytes = Buffer.alloc(rowPadding); // zeroed
  for (let y = 0; y < height; y++) {
    const srcOff = y * rowBytes;
    const dstOff = headerSize + y * paddedRow;
    data.copy(buf, dstOff, srcOff, srcOff + rowBytes);
    if (rowPadding > 0) {
      padBytes.copy(buf, dstOff + rowBytes);
    }
  }

  return buf;
}

function encodePngRaw(data, width, height, channels) {
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const stride = width * channels;
  const filtered = Buffer.allocUnsafe(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + stride);
    filtered[rowOffset] = 0; // no filter
    data.copy(filtered, rowOffset + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(filtered, { level: 0 });
  const out = Buffer.allocUnsafe(57 + compressed.length);
  let o = 0;

  // PNG signature
  out[o++] = 137; out[o++] = 80; out[o++] = 78; out[o++] = 71;
  out[o++] = 13;  out[o++] = 10; out[o++] = 26; out[o++] = 10;

  // IHDR chunk
  out.writeUInt32BE(13, o); o += 4;
  const ihdrTypeStart = o;
  out.write('IHDR', o); o += 4;
  out.writeUInt32BE(width, o); o += 4;
  out.writeUInt32BE(height, o); o += 4;
  out[o++] = 8; // bit depth
  out[o++] = colorType;
  out[o++] = 0; // compression
  out[o++] = 0; // filter
  out[o++] = 0; // interlace
  out.writeUInt32BE(_chunkCrc32(out.subarray(ihdrTypeStart, o)), o); o += 4;

  // IDAT chunk
  out.writeUInt32BE(compressed.length, o); o += 4;
  const idatTypeStart = o;
  out.write('IDAT', o); o += 4;
  compressed.copy(out, o); o += compressed.length;
  out.writeUInt32BE(_chunkCrc32(out.subarray(idatTypeStart, o)), o); o += 4;

  // IEND chunk
  out.writeUInt32BE(0, o); o += 4;
  const iendTypeStart = o;
  out.write('IEND', o); o += 4;
  out.writeUInt32BE(_chunkCrc32(out.subarray(iendTypeStart, o)), o);

  return out;
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
      const stats = await Promise.all(
        unknown.map(async (name) => {
          const st = await fs.stat(path.join(folderPath, name));
          return { name, mtimeMs: st.mtimeMs };
        })
      );
      for (const { name, mtimeMs } of stats) cachedMap.set(name, mtimeMs);
    }
  }

  // Build sorted list from cache (or fall back to full stat if no cache)
  let sorted;
  if (cachedMap && cachedMap.size > 0) {
    sorted = Array.from(cachedMap.entries()).map(([name, mtimeMs]) => ({ name, mtimeMs }));
  } else {
    sorted = await Promise.all(
      Array.from(diskFiles).map(async (name) => {
        const st = await fs.stat(path.join(folderPath, name));
        return { name, mtimeMs: st.mtimeMs };
      })
    );
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

async function getDiskUsageInfo(targetPath, node, warnState) {
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
    return {
      totalBytes,
      availableBytes,
      usedRatio
    };
  } catch (err) {
    if (!warnState.logged) {
      node.warn(`Disk usage check failed for "${targetPath}": ${err.message}`);
      warnState.logged = true;
    }
    return null;
  }
}
