---
title: "Save File"
description: "Write images, JSON, text, or binary data to disk with format detection and overwrite protection for @rosepetal/node-red-contrib-utils."
head:
  - - meta
    - name: "keywords"
      content: "save, file, image, json, text, binary, webp, bmp, png, node-red, rosepetal"
  - - meta
    - property: "og:title"
      content: "Save File - @rosepetal/node-red-contrib-utils"
  - - meta
    - property: "og:description"
      content: "Write images, JSON, text, or binary data to disk with format detection and overwrite protection"
---

# Save File

Write incoming data to disk as an image, JSON, text, or binary file. The node can auto-detect the best mode from the payload or a provided filename/extension.

## Inputs
- **payload** (default): Data to write. Supports raw image objects (`{data,width,height,channels,colorSpace}`), encoded image buffers, plain objects/arrays, strings, or buffers.
- **Alternative path**: Use the *Input* field to read from any `msg`/`flow`/`global` property.

A raw image object has `data` (a Buffer of 8-bit pixels, row after row), `width` and `height`. `channels` is optional (it is worked out from the data length) and `colorSpace` is one of `GRAY`, `RGB`, `RGBA`, `BGR` or `BGRA` (by default `GRAY`, `RGB` or `RGBA` for 1, 3 or 4 channels). `dtype`, when present, must be `uint8`.

## Outputs
One output. After a successful save the incoming message is sent on with:
- the result at **Result to** (`msg.savedFile` by default): `{ path, filename, type, extension, sizeBytes, format }`, where `type` is `image`, `json`, `text` or `binary`, `extension` has no dot and `format` is present for images only. In multiple mode it is an array of these objects;
- the time taken at `msg.performance.rpimage.<name>`: `{ conversion, task, total }` in milliseconds (`conversion` is always `0`; `task` and `total` both hold the time taken), where `<name>` is the node name in lower case with each run of other characters replaced by one `_` and any `_` at the start or end removed (`rp_save_file` when the node has no name).

When the save fails, nothing is sent (see [Errors](#errors)).

## Properties

- **Mode** (*Single file | Multiple files*, default *Single file*) -- One file per message, or several files described by an array.

### Single File Mode (default)
- **Input** (*msg | flow | global*, default `msg.payload`) -- Data to save.
- **Folder** (*str | env | msg | flow | global*) -- Destination directory, required. Created if missing.
- **Filename** (*str | msg | flow | global | JSONata*) -- Optional name without path separators. If left blank, a timestamped name is generated, such as `image_20261122_102530-123Z.jpg` (`data_`, `text_` or `file_` for JSON, text or binary; the time is UTC). If you include an extension here, it is respected.

### Settings for Both Modes
- **File Type** (*Auto-detect | Image | JSON | Text | Binary*, default *Auto-detect*) -- Force the save mode or let the node decide (see [Type Detection](#type-detection)).
- **Image Format** (*JPG | PNG | WebP | BMP*, default JPG) -- Encoding for image saves. An image extension in the filename (`.png`, `.jpg`, ...) takes precedence.
- **Quality** -- JPEG/WebP quality (1-100, default 90).
- **Compression** -- PNG compression level (0-9, default 8). Level 0 writes an uncompressed PNG, with a fast raw encoder for raw image inputs; the other levels use Sharp for better compression at the cost of speed.
- **WebP Lossless**, **WebP Smart Subsample**, **WebP Effort** -- Lossless mode (default off), smart chroma subsampling for lossy WebP (default off) and effort level 0-6 (default 4; higher gives smaller files and slower encoding).
- **JSON Indent** -- Spacing for pretty-printed JSON output (0-8, default 2).
- **Overwrite** (*Avoid overwriting (add suffix)* | *Allow overwrite*, default *Avoid overwriting*) -- When the file already exists, the name gets `_2`, `_3`, ... before the extension (`frame.jpg`, `frame_2.jpg`). When `_2` to `_999` are all taken, the save fails.
- **Max Files** (*num | msg | flow | global*) -- Retention limit. After each save, if the folder holds more files than this, the oldest ones (by modification time) are deleted. Every file in the folder counts, not only the ones this node wrote. 0 or blank keeps all files.
- **Disk Limit** (default 90) -- Disk usage, in percent, at which saving is refused. 0 disables the check.
- **Result to** (*msg | flow | global*) -- Where to store summary metadata `{ path, filename, type, extension, sizeBytes, format? }` (default `msg.savedFile`).

The editor shows Quality, Compression and the WebP fields only for the image format they apply to, and only when File Type is Auto-detect or Image; it shows JSON Indent only when File Type is Auto-detect or JSON.

### Multiple Files Mode
Save several files from a single message by switching to *Multiple files* mode.

- **Save Config** (*msg | flow | global*) -- Path to an array of items to save (default `msg.payload`). A single object is automatically wrapped in a one-item array. An empty or invalid config logs the warning `Save config is empty or invalid — nothing to save.`, sets the status to `empty config` and sends no message.
- **Image field** -- Property name within each item that holds the data to save (default `bitmap`). Despite the name, it accepts anything single mode does -- raw image objects, encoded buffers, JSON, text, or binary -- with auto-detection applied per item.
- **Filename** (*Item field | str | msg | flow | global*) -- Where to read the filename for each file. With *Item field*, it is read from each array element (default key `filename`); otherwise a shared value is resolved once from the selected source. Blank names get a per-item timestamped default; an extension in the name drives type/format detection, as in single mode.
- **Output dir** (*Item field | str | msg | flow | global*) -- Where to read the output directory for each file (default key `outputDir`), with the same resolution logic. Items can target different folders; each folder is created if missing.

Example message with all defaults (*Save Config* = `msg.payload`):

```js
msg.payload = [
  { bitmap: <buffer|raw image>, filename: "crop_1.png", outputDir: "/data/out" },
  { bitmap: <buffer|raw image>, filename: "crop_2.png", outputDir: "/data/out" }
]
```

Notes:
- File Type, Image Format, quality/compression options, JSON Indent, Overwrite, Max Files, and the Disk Limit are node-level settings applied to **every** item; apart from auto-detection, the only per-item way to vary the format is the filename extension.
- Items are first checked and given their filenames one after the other, in item order, so `_<n>` suffixes are deterministic; then they are encoded and written up to 4 at a time.
- An item is skipped with a warning that starts with its index (`Item 2: missing "bitmap" field, skipping.`) when it is not an object, lacks the image field, has no output dir, or fails to save. The other items are still saved; if none is saved, the node raises `All items failed to save.`
- The output metadata is an array of result objects for the **saved** files only, in item order -- skipped items are absent, so do not assume 1:1 correspondence with the input array.

## Type Detection

With File Type *Auto-detect*, the first rule that applies decides:

1. The filename extension: `.jpg` or `.jpeg`, `.png`, `.webp`, `.bmp` give an image in that format; `.json` gives JSON; `.txt` gives text; `.bin` or `.dat` give binary. Other extensions are kept in the filename but do not decide the type.
2. A Buffer that Sharp recognises as JPEG, PNG or WebP is an image, written as is in its own format (Image Format is not applied; set File Type to Image to convert it). Any other Buffer is binary.
3. An object with `data`, `width` and `height` is a raw image, encoded with Image Format.
4. Any other object or array is JSON.
5. A string that starts with `{` and ends with `}`, or starts with `[` and ends with `]`, is JSON; any other string is text.
6. Anything else (a number, a boolean) is binary.

## Supported Image Formats

| Format | Notes |
|--------|-------|
| **JPEG** | Lossy, configurable quality. Default format. |
| **PNG** | Lossless, configurable compression level (0-9, default 8). |
| **WebP** | Lossy or lossless, with quality, smart subsample, and effort options. |
| **BMP** | Uncompressed bitmap, from raw image objects only: an encoded image buffer saved as BMP is written as JPEG data under the `.bmp` name. Supports 8-bit grayscale, 24-bit BGR, and 32-bit BGRA. Uses a fast raw encoder (no Sharp dependency). |

## Behavior
- All filesystem access is asynchronous, Sharp encodes on its own thread pool, and every pure-JavaScript pixel operation runs on a worker thread. JSON serialisation runs on the main thread; a JSON file of 5 MB or more logs the warning `JSON output is large (6.2 MB); this may impact the event loop and memory usage.`
- Raw images of 1 MB or more that go to a worker thread (channel swap, BMP, PNG level 0) are copied once into shared memory, already in the row layout the encoder needs. The copy yields to the event loop whenever it has run for 0.5 ms.
- Raw image inputs are validated first. Except for BMP and PNG level 0, they are encoded with Sharp; BGR/BGRA channels are swapped to RGB beforehand on a worker thread, on a copy. The input data is never modified.
- BMP encoding uses a raw encoder (on a worker thread) that writes pixels in BGR order directly, avoiding Sharp overhead. For images of 1 MB or more the pixel rows are written straight from shared memory, with no further copy.
- PNG at compression level 0 from a raw image uses a raw encoder on a worker thread (uncompressed deflate blocks, CRC32 from `zlib` when the Node.js version provides it). The file is written as parts (header, zlib stream, trailer) so nothing is concatenated.
- One worker thread is always kept warm; more are created lazily up to `min(4, cores - 1)` (override with the `RP_CPU_WORKERS` environment variable) and shut down after 60 s idle. If worker threads cannot be started, the work runs on the main thread and Node.js prints a `RosepetalCpuPool` warning once.
- Encoded image buffers are probed once with Sharp; the detected format is reused by the encoder. With File Type *Image*, a buffer already in the chosen format is written as is; otherwise Sharp converts it.
- In multiple mode, up to 4 items are saved in parallel; results keep the item order.
- Writes to the same path are serialised, so concurrent messages or items can never interleave inside one file. With overwrite protection on, filenames are reserved before writing, so concurrent saves always get unique `_<n>` suffixes.
- Folder creation and folder scans are cached per folder and shared by every Save File node of the Node-RED process; a folder removed externally is recreated on the next save. The list of names used by overwrite protection is read on the first save to a folder, so a file that another program creates there afterwards is not seen and can be overwritten. Disk usage (`statfs`) is cached for 1 s per folder.
- Context reads and writes (`flow` / `global`) use Node-RED's asynchronous context API, so asynchronous context stores are supported.
- JSON inputs are pretty-printed with JSON Indent; a string that is already valid JSON is written as is.
- Text mode writes the value as a string (`null` or `undefined` give an empty file). Binary mode writes a Buffer as is, the Buffer in `value.data` when there is one, a string as UTF-8, and anything else as JSON text.
- Disk usage is checked before each write; the save fails when usage reaches the configured *Disk Limit* (default 90%, 0 disables the check). If the check itself fails, the node logs the warning `Disk usage check failed for "<folder>": ...` once and saves without it.

## Errors

A failed save sets a red `Error` status ring and raises a Node-RED error that a Catch node can handle; no message is sent.

| Error | Cause |
|-------|-------|
| `No data found at configured input path.` | Nothing at Input (single mode) |
| `Folder path is empty.` | Folder resolves to an empty value (single mode) |
| `Filename must not contain path separators.` | The filename contains `/` or `\` |
| `Too many file variations exist in target folder.` | Overwrite protection found `_2` to `_999` taken |
| `Storage at "/data/out" is 93.4% full. Skipping save to avoid exhausting disk space.` | Disk Limit reached |
| `Invalid image structure.` | A raw image failed validation; a warning logged just before says why, for example `Data length mismatch: ...` |
| `All items failed to save.` | Multiple mode, no item saved |

In multiple mode the item errors are warnings that skip the item.

## Status
- Blue dot `saving...` while a message is processed.
- Green dot `saved frame_2.jpg (14ms)` with the final filename and the time taken.
- In multiple mode, `saved 3 files (25ms)`, or `saved 2/3 files (25ms)` when some items were skipped.
- Yellow ring `empty config` (multiple mode, nothing to save); red ring `Error`.

## Example Flows
- Save final inference results as `results.json` in `/data/out`.
- Persist camera frames as WebP by setting *File Type = Image* and *Image Format = WebP*.
- Archive arbitrary payloads by pointing *Input* to `msg.myBuffer` and enabling overwrite protection.
- Save multiple detection crops from a single message by switching to *Multiple files* mode and pointing *Save Config* at `msg.detections`.
