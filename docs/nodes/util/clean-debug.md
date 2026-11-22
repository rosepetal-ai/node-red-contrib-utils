---
title: "Clean Debug"
description: "Debug node that sanitizes heavy payloads to keep the editor sidebar responsive for @rosepetal/node-red-contrib-utils."
head:
  - - meta
    - name: "keywords"
      content: "debug, sanitize, buffer, image, base64, sidebar, node-red, rosepetal"
  - - meta
    - property: "og:title"
      content: "Clean Debug - @rosepetal/node-red-contrib-utils"
  - - meta
    - property: "og:description"
      content: "Debug node that sanitizes heavy payloads to keep the editor sidebar responsive"
---

# Clean Debug Node

## Purpose & Use Cases

The `clean-debug` node is a drop-in replacement for the core Debug node that keeps the editor sidebar responsive by sanitizing heavy payloads (buffers, images, base64 strings) before display.

**Typical scenarios:**
- Inspecting image or binary flows without freezing the sidebar
- Logging large messages safely during development
- Keeping debug output readable in production flows

## Input/Output Specification

### Inputs
- **Incoming Message**: Any Node-RED message.

### Outputs
- **No message output**: The node publishes to the debug sidebar and/or console only. It shows no status.

## Configuration Options

### Output
- **Type**: Typed input: `msg`, `flow`, `global`, string, number, boolean, JSON, buffer, timestamp, JSONata, environment variable, or *complete msg object*
- **Default**: `msg.payload`
- **Purpose**: Selects the value to display. Choose *complete msg object* to see the whole message.

### Send to debug sidebar
- **Type**: Boolean
- **Default**: Enabled
- **Purpose**: Shows the sanitized value in the editor sidebar.

### Also log to console
- **Type**: Boolean
- **Default**: Disabled
- **Purpose**: Logs the value to the Node-RED runtime log, at info level, formatted with `util.inspect` (5 levels deep, 10 array items). With cleaning on it logs the cleaned value, with cleaning off the original one.

### Clean heavy payloads
- **Type**: Boolean
- **Default**: Enabled
- **Purpose**: Replaces buffers, typed arrays, data URLs, and long base64 strings with short placeholders (see [Cleaning Rules](#cleaning-rules)). The node label reads `debug` instead of `clean debug` when it is off.

### Enabled
- **Type**: Boolean (button toggle)
- **Default**: Enabled
- **Purpose**: Temporarily disable the node without removing it from the flow. The button takes effect at once, through the runtime admin endpoint `POST /rp-clean-debug/<node id>` (body `{ "active": true }` or `false`; it needs the `flows.write` permission). The flow is marked as changed: deploy to keep the new state after a restart.

## Cleaning Rules

With **Clean heavy payloads** on:

| Value | Shown as |
|-------|----------|
| Buffer, of any size (also the serialised form `{ type: "Buffer", data: [...] }`) | `[Buffer withheld: 5242880 bytes]` |
| Typed array or `ArrayBuffer` | `[Uint8Array withheld: 1024 items]`, with the type of the array |
| String starting with `data:image/` | `[DataImage withheld: 81234 chars]` |
| String of 512 characters or more, length a multiple of 4, that looks like base64 | `[Base64 withheld: 65536 chars]` |
| Other string longer than 2048 characters | The first 2048 characters and `… [truncated N chars]` |
| Array longer than 50 items | The first 50 items and `… N more items` |
| Object with more than 60 keys | The first 60 keys and `__cleanDebugNote: "N more keys not shown"` |
| Anything nested deeper than 6 levels | `[Array(N)]` or `[Object with N keys]` |
| Circular reference | `[Circular ~path]` |

With it off the value is still bounded, with wider limits: 100 array items, 120 keys, 6 levels, strings and buffer previews cut at the `debugMaxLength` of the Node-RED settings (1000 by default; buffer previews show at least 512 bytes).

## Behavior Notes

- Cleaning only affects what is displayed; the original message is not modified, and it is not cloned.
- When cleaning is disabled, buffers are shown with a preview of their first bytes, and the wider limits above still apply.
- Large arrays/objects are truncated for safety; circular references are handled gracefully.

## Example

```
[Image-In] -> [clean-debug: Output=msg.payload, Clean=on]
```

Use clean mode to inspect image payloads without dumping full binary data. A raw 1920x1080 RGB image then shows as `{ data: "[Buffer withheld: 6220800 bytes]", width: 1920, height: 1080, ... }`.
