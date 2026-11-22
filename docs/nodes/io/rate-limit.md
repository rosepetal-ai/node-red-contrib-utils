---
title: "Rate Limit"
description: "Enforce minimum intervals between messages using external timestamps for @rosepetal/node-red-contrib-utils."
head:
  - - meta
    - name: "keywords"
      content: "rate-limit, throttle, timestamp, interval, cadence, timing, node-red, rosepetal"
  - - meta
    - property: "og:title"
      content: "Rate Limit - @rosepetal/node-red-contrib-utils"
  - - meta
    - property: "og:description"
      content: "Enforce minimum intervals between messages using external timestamps"
---

# Rate Limit Node

## Purpose & Use Cases

The `rate-limit` node enforces a minimum interval between output messages based on external timestamps (from hardware, sensors, or other sources) rather than internal `Date.now()` timing. This makes rate decisions immune to event-loop drift and more accurate for real-time data streams.

**Typical scenarios:**
- Throttle high-frequency sensor or camera data to a manageable rate
- Deduplicate rapid-fire hardware triggers that arrive faster than processing can handle
- Control output cadence for downstream systems with rate constraints
- Monitor message timing statistics across a rolling window

## Input/Output Specification

### Inputs
- **Incoming Message**: Any Node-RED message containing a timestamp at the configured path.

### Outputs
- **Output 1 (passed)**: Messages that meet or exceed the minimum interval since the last accepted message. The first message always passes.
- **Output 2 (throttled)**: Messages that arrived sooner than the configured interval since the last accepted message.

Both outputs send the incoming message itself, with the timing data written to the configured output path (when set; with `flow` or `global` the timing data goes to the context instead of the message).

### Timing Data
```javascript
{
  timeBetween: number,      // ms since last accepted message (-1 for first message)
  avgTimeBetween: number,   // average ms between messages in the rolling window (rounded)
  messageCount: number      // number of messages currently in the rolling window
}
```

## Configuration Options

### Timestamp
- **Type**: Typed input (`msg` | `flow` | `global`)
- **Default**: `msg.timestamp`
- **Purpose**: Path to the external timestamp value. Accepts ISO 8601 strings, epoch milliseconds, or Date objects. A number is used as is, in milliseconds; any other value goes through `new Date(value)`, so epoch milliseconds must be a number, not a string (`"1700000000000"` is an invalid timestamp).

### Interval (ms)
- **Type**: Typed input (`num` | `msg` | `flow` | `global`)
- **Default**: `250`
- **Purpose**: Minimum milliseconds between passed messages. Messages arriving sooner are sent to the throttled output. Must be `0` or more; `0` passes every message.

### Window (ms)
- **Type**: Typed input (`num` | `msg` | `flow` | `global`)
- **Default**: `5000`
- **Purpose**: Rolling time window for average cadence calculation. Messages older than this are dropped from the history. Must be greater than `0`.

### Output to
- **Type**: Typed input (`msg` | `flow` | `global`)
- **Default**: *(empty -- no timing data attached)*
- **Purpose**: Where to write the timing data object on each message.

## Behavior

- The first message always passes (timeBetween = -1).
- Subsequent messages pass only if the external timestamp difference from the last *accepted* message meets or exceeds the interval.
- All messages (passed and throttled) are added to the rolling window history for cadence calculation.
- The rolling window is pruned on each message to remove entries older than the window size.
- Invalid timestamps cause the message to be dropped with the warning `Invalid timestamp: ...`.
- Invalid interval or window values cause the message to be dropped with the warning `Invalid interval value: ...` or `Invalid window size: ...`.
- Interval and window size can be set dynamically per-message when using `msg`, `flow`, or `global` types.
- If the timestamps go backwards (for example, the source restarts its clock), every message is throttled until a timestamp reaches the last accepted one plus the interval. Redeploying the node clears its state.

## Status

- **Blue dot** `Idle` -- No messages received yet.
- **Green dot** `Pass: 104ms (avg 98ms)` -- Last message passed. Shows time since previous and rolling average (`Pass: first (avg 0ms)` for the first message).
- **Yellow dot** `Throttled: 40ms < 100ms` -- Last message was throttled. Shows the interval comparison.
- **Red ring** `Invalid timestamp`, `Invalid interval`, `Invalid window` or `Error`.

## Example Flows

### Throttle Camera Frames
```
[Camera] → [Rate Limit: interval=100, timestamp=msg.captureTime] → [Process Frame]
```
Accept at most one frame every 100ms based on the camera's own capture timestamp.

### Monitor Sensor Cadence
```
[Sensor] → [Rate Limit: interval=0, output=msg.timing] → [Dashboard]
```
Pass all messages through (interval=0) while attaching rolling timing statistics for monitoring.
