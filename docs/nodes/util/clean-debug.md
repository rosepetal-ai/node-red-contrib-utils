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
- **No message output**: The node publishes to the debug sidebar and/or console only.

## Configuration Options

### Output
- **Type**: Typed input (msg/flow/global/env/jsonata/etc.)
- **Default**: `msg.payload`
- **Purpose**: Selects the value to display. Choose the full message object if needed.

### Send to debug sidebar
- **Type**: Boolean
- **Default**: Enabled
- **Purpose**: Shows the sanitized value in the editor sidebar.

### Also log to console
- **Type**: Boolean
- **Default**: Disabled
- **Purpose**: Logs the value to the Node-RED runtime log.

### Clean heavy payloads
- **Type**: Boolean
- **Default**: Enabled
- **Purpose**: Replaces large buffers, typed arrays, data URLs, and long base64 strings with short placeholders.

### Enabled
- **Type**: Boolean (button toggle)
- **Purpose**: Temporarily disable the node without removing it from the flow.

## Behavior Notes

- Cleaning only affects what is displayed; the original message is not modified.
- When cleaning is disabled, the node behaves like the standard Debug node.
- Large arrays/objects are truncated for safety; circular references are handled gracefully.

## Example

```
[Image-In] -> [clean-debug: Output=msg.payload, Clean=on]
```

Use clean mode to inspect image payloads without dumping full binary data.
