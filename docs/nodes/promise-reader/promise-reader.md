# Promise Reader Node

## Purpose & Use Cases

The `promise-reader` node resolves an array of promises stored on the message, merges their results into the message, and records simple performance timing. It is useful when upstream nodes perform parallel async work (for example, multiple inference calls) and return promises instead of immediate results.

**Typical scenarios:**
- Collect results from multiple asynchronous HTTP or inference requests
- Merge parallel processing outputs into one message
- Aggregate timing data across async tasks

## Input/Output Specification

### Inputs
- **Promise Array**: An array of promises at the configured message path (default `msg.promises`).

### Outputs
On success, the node merges resolved values into the original message and removes the promise array:

```javascript
{
  ...originalMessage,
  // resolved values merged into the message
  resultA: {...},
  resultB: {...},
  performance: {
    "promise-reader": {
      startTime: 1680000000000,
      endTime: 1680000000500,
      milliseconds: 500
    }
  }
}
```

If the configured field is missing or not an array, the node warns and passes the message through unchanged.

## Configuration Options

### Field to read
- **Default**: `promises`
- **Type**: Message path (dot notation supported)
- **Purpose**: Location of the promise array (e.g. `inference.promises`).

## Behavior

- Validates that the field is an array.
- Ensures every entry is a promise/thenable; otherwise logs an error and stops.
- Resolves all promises in parallel using `Promise.all()`.
- Merges resolved objects into the message. If both sides are plain objects, it deep-merges; otherwise later values overwrite earlier ones.
- Aggregates timing from any resolved value that contains a `performance` object with `startTime` and `endTime` fields.
- Deletes the original promise array from the message before sending.

If any promise rejects, the node logs a warning and does not send an output message.

## Common Issues & Troubleshooting

- **Non-array field**: Ensure `msg.promises` (or your configured path) is an array.
- **Non-promise entries**: Verify each element is a promise or thenable object.
- **Rejected promise**: Handle errors upstream or add retries so Promise.all can resolve.
