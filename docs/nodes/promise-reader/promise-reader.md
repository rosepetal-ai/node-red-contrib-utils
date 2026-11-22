---
title: "Promise Reader"
description: "Resolve an array of promises and merge results into a single message for @rosepetal/node-red-contrib-utils."
head:
  - - meta
    - name: "keywords"
      content: "promise, async, resolve, merge, parallel, performance, node-red, rosepetal"
  - - meta
    - property: "og:title"
      content: "Promise Reader - @rosepetal/node-red-contrib-utils"
  - - meta
    - property: "og:description"
      content: "Resolve an array of promises and merge results into a single message"
---

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
On success, the node merges resolved values into the original message and removes the promise array. The timing goes under `msg.performance`, keyed by the node's **Name** (`rp-promise-reader` by default):

```javascript
{
  ...originalMessage,
  // resolved values merged into the message
  resultA: {...},
  resultB: {...},
  performance: {
    "rp-promise-reader": {
      startTime: Date,      // Date object
      endTime: Date,        // Date object
      milliseconds: 500
    }
  }
}
```

If the configured field is missing or not an array, the node warns (`msg.promises must be an array of promises`) and passes the message through unchanged.

## Configuration Options

### Name
- **Default**: `rp-promise-reader`
- **Purpose**: Label of the node and key of its entry in `msg.performance`. The editor flags an empty Name as invalid.

### Field to read
- **Default**: `promises`
- **Type**: Message path (`msg` only, dot notation supported)
- **Purpose**: Location of the promise array (e.g. `inference.promises`).

## Behavior

- Validates that the field is an array.
- Ensures every entry is a Promise or an object with `then` and `catch` methods; otherwise logs the error `All elements in msg.promises must be promises` and sends nothing.
- Resolves all promises in parallel using `Promise.all()`.
- Merges resolved objects into the message, key by key, in array order. If both sides are plain objects, it deep-merges; otherwise later values overwrite earlier ones. Resolved values that are not objects (numbers, strings) are ignored.
- Aggregates timing from the objects with `startTime` and `endTime` fields found at any depth inside the `performance` property of each resolved value: `startTime` is the earliest of those start times and the moment the node received the message, `endTime` is the latest of those end times and the moment all promises resolved, and `milliseconds` is the difference.
- Deletes the original promise array from the message before sending.

If any promise rejects, the node logs a warning with the rejection reason and does not send an output message. The node shows no status.

## Example

A Function node starts two asynchronous tasks and hands their promises on:

```javascript
const delay = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));
msg.promises = [
    delay(100, { resultA: { score: 0.9 } }),
    delay(200, { resultB: { score: 0.7 } })
];
return msg;
```

In `[Function] → [rp-promise-reader] → [Debug]`, the Debug node receives the message after about 200 ms with `msg.resultA`, `msg.resultB` and `msg.performance["rp-promise-reader"].milliseconds` close to 200; `msg.promises` is gone.

## Common Issues & Troubleshooting

- **Non-array field**: Ensure `msg.promises` (or your configured path) is an array.
- **Non-promise entries**: Verify each element is a promise, or an object with `then` and `catch` methods.
- **Rejected promise**: Handle errors upstream or add retries so Promise.all can resolve.
