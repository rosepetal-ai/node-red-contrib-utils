---
title: "Utility Nodes for Node-RED"
description: "Utility and I/O nodes for Node-RED: array assembly, queueing, rate limiting, file saving, promise aggregation, debugging, and event loop monitoring. Part of @rosepetal/node-red-contrib-utils."
head:
  - - meta
    - name: "keywords"
      content: "node-red, utility nodes, array, queue, rate limit, save file, promise reader, debug, event loop, rosepetal"
  - - meta
    - property: "og:title"
      content: "Utility Nodes - @rosepetal/node-red-contrib-utils"
  - - meta
    - property: "og:description"
      content: "Utility and I/O nodes for Node-RED: array assembly, queueing, rate limiting, file saving, promise aggregation, and debugging."
---

# Utility Nodes for Node-RED

`@rosepetal/node-red-contrib-utils` provides 9 utility nodes for array assembly, message queueing, rate limiting, file saving, promise aggregation, safe debugging, and event loop monitoring.

## Installation

```bash
cd ~/.node-red
npm install @rosepetal/node-red-contrib-utils
```

Or search `@rosepetal/node-red-contrib-utils` in the Node-RED Palette Manager.

## Requirements

- Node.js >= 16
- Node-RED >= 1.0.0
- `sharp` native addon (fetched via npm)

## Nodes

All node types are prefixed with `rp-` and appear under the **RP Utils** category in the editor.

### I/O and Array Tools

| Node | Purpose |
|------|---------|
| **[rp-array-in](./nodes/io/array-in.md)** | Tag incoming data with a position index for ordered array assembly |
| **[rp-array-out](./nodes/io/array-out.md)** | Collect indexed data into ordered arrays with timeout handling |
| **[rp-array-select](./nodes/io/array-select.md)** | Select array elements using index and slice syntax |
| **[rp-queue](./nodes/io/queue.md)** | Buffer messages, enforce output intervals, drop stale or overflow items |
| **[rp-save-file](./nodes/io/save-file.md)** | Save payloads to disk as image (JPEG, PNG, WebP, BMP), JSON, text, or binary |
| **[rp-rate-limit](./nodes/io/rate-limit.md)** | Enforce minimum interval between outputs based on external timestamps |

### Async and Workflow

| Node | Purpose |
|------|---------|
| **[rp-promise-reader](./nodes/promise-reader/promise-reader.md)** | Resolve arrays of promises, merge results, and record timing |

### Utilities

| Node | Purpose |
|------|---------|
| **[rp-clean-debug](./nodes/util/clean-debug.md)** | Debug output that sanitizes large payloads to keep the sidebar responsive |
| **[rp-block-detect](./nodes/util/block-detect.md)** | Event loop delay watchdog with live status and log warnings |
