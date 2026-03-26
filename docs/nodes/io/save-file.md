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

## Properties

### Single File Mode (default)
- **Folder** (*str | env | msg | flow | global*) -- Destination directory. Created if missing.
- **Filename** (*str | msg | flow | global*) -- Optional name without path separators. If left blank, a timestamped name is generated. If you include an extension here, it is respected.
- **File Type** (*auto | image | json | text | binary*) -- Force the save mode or let the node decide. Auto uses the extension, raw image structure, or Sharp metadata for buffers.
- **Image Format** (*jpg | png | webp | bmp*) -- Encoding for image saves.
- **Quality** -- JPEG/WebP quality (1-100, default 90).
- **PNG Compression** -- PNG compression level (0-9, default 0). Level 0 uses a fast raw encoder; higher levels use Sharp for better compression at the cost of speed.
- **WebP Options** -- Lossless mode, smart subsample, and effort level (0-6) for fine-tuned WebP output.
- **JSON Indent** -- Spacing for pretty-printed JSON output.
- **Overwrite protection** -- Enabled by default; adds a numeric suffix when the file already exists.
- **Max Files** (*num | msg | flow | global*) -- Retention limit. When set, the oldest files in the folder are deleted to stay within the limit.
- **Result to** -- Where to store summary metadata `{ path, filename, type, extension, sizeBytes, format? }` (default `msg.savedFile`).

### Multiple Files Mode
Save several files from a single message by switching to *Multiple* mode.

- **Save Config** (*msg | flow | global*) -- Path to an array (or single object) of items to save. Each item is an object containing the image/data and per-file metadata. A single object is automatically wrapped in an array.
- **Image Field** -- Property name within each item that holds the data to save (default `bitmap`).
- **Filename Field** (*item | msg | flow | global*) -- Where to read the filename for each file. When set to `item`, the filename is read from each array element; otherwise a shared value is resolved once from the selected source.
- **Output Dir Field** (*item | msg | flow | global*) -- Where to read the output directory for each file. Same resolution logic as the filename field.

The output metadata is an array of result objects, one per saved file.

## Supported Image Formats

| Format | Notes |
|--------|-------|
| **JPEG** | Lossy, configurable quality. Default format. |
| **PNG** | Lossless, configurable compression level (0-9). |
| **WebP** | Lossy or lossless, with quality, smart subsample, and effort options. |
| **BMP** | Uncompressed bitmap. Supports 8-bit grayscale, 24-bit BGR, and 32-bit BGRA. Uses a fast raw encoder (no Sharp dependency). |

## Behavior
- Raw image inputs are validated and encoded with Sharp; BGR/BGRA channels are auto-swapped.
- BMP encoding uses a native raw encoder that writes pixels in BGR order directly, avoiding Sharp overhead.
- PNG at compression level 0 uses a fast raw encoder with native CRC32 for maximum throughput.
- JSON inputs are pretty-printed; valid JSON strings are kept as-is.
- Text mode writes stringified content; binary mode writes buffers directly (or stringified when not a buffer).
- When overwrite protection is enabled, the node keeps adding `_<n>` until a free filename is found.
- Disk usage is checked before each write; saves are skipped when storage exceeds 90% capacity.
- In multiple mode, failures on individual items are logged as warnings and skipped; the node only errors if all items fail.

## Status
- Shows the final filename, duration, and whether an overwrite was avoided.
- In multiple mode, shows the count of saved files and any skipped items.

## Example Flows
- Save final inference results as `results.json` in `/data/out`.
- Persist camera frames as WebP by setting *File Type = image* and *Image Format = webp*.
- Archive arbitrary payloads by pointing *Input* to `msg.myBuffer` and enabling overwrite protection.
- Save multiple detection crops from a single message by switching to *Multiple* mode and pointing *Save Config* at `msg.detections`.
