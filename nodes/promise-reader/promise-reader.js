module.exports = function(RED) {
    function PromiseReaderNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        function deleteNestedProperty(obj, path) {
            const parts = path.split('.');
            const last = parts.pop();
            const ref = parts.reduce((acc, part) => acc && acc[part], obj);

            if (ref && last in ref) {
                delete ref[last];
            }
        }

        function deepMerge(target, source) {
            const result = { ...target };
            for (const key in source) {
                if (source.hasOwnProperty(key)) {
                    if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]) &&
                        typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
                        result[key] = deepMerge(result[key], source[key]);
                    } else {
                        result[key] = source[key];
                    }
                }
            }
            return result;
        }

        function extractPerformanceEntries(obj, entries = []) {
            if (!obj || typeof obj !== 'object') return entries;

            if (obj.startTime && obj.endTime) {
                entries.push(obj);
            } else {
                for (const key in obj) {
                    if (obj.hasOwnProperty(key)) {
                        extractPerformanceEntries(obj[key], entries);
                    }
                }
            }
            return entries;
        }

        node.on('input', function(msg) {
            const promisesPath = config.fieldToRead || 'promises';
            const fieldPath = promisesPath.split('.');
            const promises = fieldPath.reduce((obj, key) => obj && obj[key], msg);

            if (!promises || !Array.isArray(promises)) {
                node.warn(`msg.${promisesPath} must be an array of promises`);
                node.send(msg)
                return;
            }
            const allArePromises = promises.every(promise => 
                promise instanceof Promise || 
                (promise && typeof promise.then === 'function' && typeof promise.catch === 'function')
            );
            if (!allArePromises) {
                node.error(`All elements in msg.${promisesPath} must be promises`);
                return;
            }

            let aggregatedPerformance = {
                startTime: null,
                endTime: null
            };

            Promise.all(promises)
                .then(resolvedValues => {
                    resolvedValues.forEach(value => {
                        if (value && value.performance) {
                            const performanceEntries = extractPerformanceEntries(value.performance);
                            performanceEntries.forEach(entry => {
                                if (aggregatedPerformance.startTime === null || entry.startTime < aggregatedPerformance.startTime) {
                                    aggregatedPerformance.startTime = entry.startTime;
                                }
                                if (aggregatedPerformance.endTime === null || entry.endTime > aggregatedPerformance.endTime) {
                                    aggregatedPerformance.endTime = entry.endTime;
                                }
                            });
                        }

                        if (value && typeof value === 'object') {
                            Object.keys(value).forEach(key => {
                                if (msg[key] === undefined) {
                                    msg[key] = value[key];
                                } else if (typeof msg[key] === 'object' && msg[key] !== null && !Array.isArray(msg[key]) &&
                                           typeof value[key] === 'object' && value[key] !== null && !Array.isArray(value[key])) {
                                    msg[key] = deepMerge(msg[key], value[key]);
                                } else {
                                    msg[key] = value[key];
                                }
                            });
                        }
                    });

                    if (aggregatedPerformance.startTime !== null && aggregatedPerformance.endTime !== null) {
                        aggregatedPerformance.milliseconds = new Date(aggregatedPerformance.endTime) - new Date(aggregatedPerformance.startTime);
                    } else {
                        aggregatedPerformance.milliseconds = null;
                    }

                    msg.performance = msg.performance || {};
                    msg.performance[node.name] = aggregatedPerformance;

                    deleteNestedProperty(msg, promisesPath);

                    node.send(msg);
                })
                .catch(e => node.warn(e));
        });
    }


    RED.nodes.registerType("rp-promise-reader", PromiseReaderNode);
};
