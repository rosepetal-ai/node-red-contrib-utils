---
title: "Queue"
description: "Buffer and rate-limit messages with FIFO ordering, timeout, and overflow protection for @rosepetal/node-red-contrib-utils."
head:
  - - meta
    - name: "keywords"
      content: "queue, buffer, throttle, rate-limit, FIFO, timeout, overflow, node-red, rosepetal"
  - - meta
    - property: "og:title"
      content: "Queue - @rosepetal/node-red-contrib-utils"
  - - meta
    - property: "og:description"
      content: "Buffer and rate-limit messages with FIFO ordering, timeout, and overflow protection"
---

# Queue Node

## Purpose & Use Cases

The `queue` node buffers incoming messages, enforces a minimum interval between outputs, and discards stale entries. It helps coordinate bursty producers with slower consumers by smoothing throughput and avoiding overload.

**Common Scenarios:**
- Throttle high-frequency image sources before storage or slow analysis stages
- Prevent downstream rate limits from being exceeded when batch processing arrays
- Provide simple back-pressure where only a fixed number of messages can be buffered
- Drop stale detections or frames that are no longer relevant after a timeout

## Input/Output Specification

### Inputs
- **Incoming Message**: Any Node-RED message to be enqueued.

### Outputs
- **Output 1**: Messages forwarded in FIFO order while respecting the configured interval. They are the incoming messages, unchanged.
- **Output 2**: Messages dropped due to timeout or overflow, with metadata:
  - `msg.meta.queueDropped` - Always `true`
  - `msg.meta.queueDropReason` - Either `"timeout"` or `"overflow"`
  - `msg.meta.queuedDuration` - Time spent in queue before timeout (timeout drops only)
  - `msg.meta.queueTimeout` - Configured timeout value in ms (timeout drops only)
  - `msg.meta.queueSize` - Number of messages waiting when overflow occurred (overflow drops only)
  - `msg.meta.queueMaxSize` - Configured max queue size (overflow drops only)

## Configuration Options

### Mode
- **Type**: Dropdown (`Queue Size Limit` / `Timeout`)
- **Default**: `Queue Size Limit`
- **Purpose**: Select whether the node enforces a hard buffer capacity or lets messages expire after a timeout; the controls shown below change depending on the selected mode.

### Max Queue Size
- **Type**: Number (integer)
- **Default**: `0` (no limit)
- **Purpose**: Available only in queue-size mode. Controls how many messages may wait in the queue; while it is full, each new message goes to output 2 with `queueDropReason: "overflow"` and the warning `Queue node at capacity (5). Incoming message dropped.` (for a size of 5) is logged.

### Timeout (ms)
- **Type**: Number (integer)
- **Default**: `0` (no timeout)
- **Purpose**: Available only in timeout mode, where the queue has no size limit. Messages that stay longer than this duration are removed before they reach output 1 and sent to output 2.

### Interval (ms)
- **Type**: Number (integer)
- **Default**: `0` (no enforced delay)
- **Purpose**: Minimum time that must elapse between forwarded messages. When set to 0, messages flow out as soon as they are available.

Messages only wait when **Interval** is greater than 0. With an interval of 0 every message leaves as soon as it arrives, so the queue never fills and nothing expires.

## Behavior & Status

- Messages are processed in first-in-first-out order.
- The node emits messages immediately when the interval requirement has already been satisfied.
- If necessary, the node waits the remaining interval before releasing the next message.
- When messages expire due to timeout (and timeout mode is active) they are sent to output 2 with metadata and the warning `Queue node dropped 2 message(s) due to timeout.` is logged. Expiry is checked when a message arrives and each time a message is due to be sent, so `queuedDuration` can be longer than the timeout, by up to one Interval.
- When the queue overflows (queue-size mode) excess messages are sent to output 2 with metadata and a warning.
- On redeploy or stop, the messages still waiting are discarded; they are not sent to output 2.
- A node saved before the Mode field existed (no `mode` in its configuration) applies both the size limit and the timeout.
- Node status: blue dot `Idle`, yellow dot `Queued: 3` while messages wait, green dot `Sending (remaining 2)` when one is released, red ring `Error`.

## Example

A camera sends frames faster than the inference stage can take them:

```
[Camera] → [Queue: Mode=Queue Size Limit, Max Queue Size=5, Interval=200] → [Inference]
                                                              output 2 → [Debug]
```

At most one frame every 200 ms reaches the inference node. Up to 5 frames wait their turn; while 5 are waiting, new frames go to output 2 with `msg.meta.queueDropReason = "overflow"`. To keep only fresh frames instead of a fixed number, use Mode=Timeout with, for example, Timeout=1000: frames that waited 1 second or more go to output 2 with `queueDropReason = "timeout"`.

## Best Practices

- Pair with Array nodes to control the rate of batch processing pipelines.
- Use timeouts to keep sensor readings or camera frames current.
- Connect output 2 to logging, alerting, or fallback processing to handle dropped messages.
- Use `msg.meta.queueDropReason` to differentiate between timeout and overflow scenarios in downstream logic.
