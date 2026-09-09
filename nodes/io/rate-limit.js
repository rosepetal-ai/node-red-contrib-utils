/**
 * @file Rate-limit node that uses external timestamps (hardware/sensor)
 * instead of internal Date.now() for more precise timing decisions.
 */

module.exports = function (RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);

  function RateLimitNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    /* ────────────────────────────
       ░░ 1.  Read configuration ░░
       ──────────────────────────── */
    node.timestampPath     = config.timestampPath     || 'timestamp';
    node.timestampPathType = config.timestampPathType  || 'msg';
    node.intervalType      = config.intervalType       || 'num';
    node.intervalValue     = config.intervalValue !== undefined ? config.intervalValue : 250;
    node.windowSizeType    = config.windowSizeType     || 'num';
    node.windowSizeValue   = config.windowSizeValue !== undefined ? config.windowSizeValue : 5000;
    node.outputPath        = config.outputPath         || '';
    node.outputPathType    = config.outputPathType     || 'msg';

    /* ────────────────────────────
       ░░ 2.  Internal state      ░░
       ──────────────────────────── */
    const state = {
      lastTimestamp: null,
      history: []
    };

    setStatusIdle();

    /* ────────────────────────────
       ░░ 3.  Helper functions    ░░
       ──────────────────────────── */
    function setStatusIdle() {
      node.status({ fill: 'blue', shape: 'dot', text: 'Idle' });
    }

    function setStatusPass(timingData) {
      const avg = Math.round(timingData.avgTimeBetween);
      const tb = timingData.timeBetween === -1 ? 'first' : `${timingData.timeBetween}ms`;
      node.status({
        fill: 'green',
        shape: 'dot',
        text: `Pass: ${tb} (avg ${avg}ms)`
      });
    }

    function setStatusThrottled(timingData, interval) {
      node.status({
        fill: 'yellow',
        shape: 'dot',
        text: `Throttled: ${timingData.timeBetween}ms < ${interval}ms`
      });
    }

    function setStatusError(text) {
      node.status({ fill: 'red', shape: 'ring', text: text });
    }

    function parseTimestamp(raw) {
      if (raw === null || raw === undefined) return NaN;
      if (typeof raw === 'number') return raw;
      const ms = new Date(raw).getTime();
      return ms;
    }

    function pruneHistory(currentTs, windowMs) {
      const cutoff = currentTs - windowMs;
      state.history = state.history.filter(function (ts) {
        return ts > cutoff;
      });
    }

    function computeTimingData(currentTs) {
      var timeBetween = state.lastTimestamp !== null
        ? currentTs - state.lastTimestamp
        : -1;

      var avgTimeBetween = 0;
      if (state.history.length > 1) {
        var totalDuration = state.history[state.history.length - 1] - state.history[0];
        avgTimeBetween = totalDuration / (state.history.length - 1);
      }

      return {
        timeBetween: timeBetween,
        avgTimeBetween: Math.round(avgTimeBetween),
        messageCount: state.history.length
      };
    }

    /* All property / context access is async so async context stores are supported. */
    async function resolveConfigValue(type, value, msg) {
      if (type === 'num') {
        return parseFloat(value);
      }
      return NodeUtils.evaluateProperty(node, value, type, msg);
    }

    function readTimestamp(msg) {
      return NodeUtils.getProperty(node, node.timestampPathType, node.timestampPath, msg);
    }

    function attachTimingData(msg, timingData) {
      if (!node.outputPath) return Promise.resolve();
      return NodeUtils.setProperty(node, node.outputPathType, node.outputPath, timingData, msg);
    }

    /* ────────────────────────────
       ░░ 4.  Input handler       ░░
       ──────────────────────────── */
    node.on('input', async function (msg, send, done) {
      try {
        // 4.1 Resolve interval and window size (may be dynamic per-message)
        var interval = await resolveConfigValue(node.intervalType, node.intervalValue, msg);
        var windowMs = await resolveConfigValue(node.windowSizeType, node.windowSizeValue, msg);

        // 4.2 Validate resolved values
        if (isNaN(interval) || interval < 0) {
          node.warn('Invalid interval value: ' + node.intervalValue);
          setStatusError('Invalid interval');
          return done?.();
        }
        if (isNaN(windowMs) || windowMs <= 0) {
          node.warn('Invalid window size: ' + node.windowSizeValue);
          setStatusError('Invalid window');
          return done?.();
        }

        // 4.3 Read and parse timestamp
        var rawTimestamp = await readTimestamp(msg);
        var currentTs = parseTimestamp(rawTimestamp);
        if (isNaN(currentTs)) {
          node.warn('Invalid timestamp: ' + rawTimestamp);
          setStatusError('Invalid timestamp');
          return done?.();
        }

        // 4.4 Update rolling window history
        state.history.push(currentTs);
        pruneHistory(currentTs, windowMs);

        // 4.5 Compute timing data
        var timingData = computeTimingData(currentTs);

        // 4.6 Attach timing data to message (both outputs)
        await attachTimingData(msg, timingData);

        // 4.7 Rate limit decision
        if (timingData.timeBetween === -1 || timingData.timeBetween >= interval) {
          state.lastTimestamp = currentTs;
          setStatusPass(timingData);
          send([msg, null]);
        } else {
          setStatusThrottled(timingData, interval);
          send([null, msg]);
        }

        done?.();
      } catch (err) {
        setStatusError('Error');
        done ? done(err) : node.error(err, msg);
      }
    });

    /* ────────────────────────────
       ░░ 5.  Cleanup             ░░
       ──────────────────────────── */
    node.on('close', function () {
      state.lastTimestamp = null;
      state.history.length = 0;
      setStatusIdle();
    });
  }

  RED.nodes.registerType('rp-rate-limit', RateLimitNode);
};
