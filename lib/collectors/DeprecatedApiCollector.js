/**
 * DeprecatedApiCollector
 * Detects usage of deprecated synchronous Meteor APIs by wrapping
 * Mongo.Collection prototype methods to count sync vs async calls.
 *
 * Reports a summary once per collection interval (default 5 minutes).
 * This is lightweight — just increment counters per call.
 *
 * Tracked deprecated patterns:
 * - Collection.find().fetch() instead of fetchAsync()
 * - Collection.findOne() instead of findOneAsync()
 * - Collection.insert/update/remove() instead of async variants
 * - Meteor.call() instead of Meteor.callAsync()
 */
export default class DeprecatedApiCollector {
  constructor(options = {}) {
    this.client = options.client;
    this.host = options.host || "unknown-host";
    this.appVersion = options.appVersion || "unknown";
    this.interval = options.interval || 300000; // 5 minutes
    this.debug = options.debug || false;

    this.intervalId = null;
    this._wrapped = false;

    // Counters: { "collectionName.method": { sync: N, async: N } }
    this._counters = {};
  }

  _log(...args) {
    if (this.debug) {
      console.log("[SkySignal:DeprecatedApi]", ...args);
    }
  }

  _warn(...args) {
    console.warn("[SkySignal:DeprecatedApi]", ...args);
  }

  start() {
    if (this.intervalId) {
      this._warn("Already started");
      return;
    }

    this._wrapApis();

    this.intervalId = setInterval(() => {
      this._collect();
    }, this.interval);

    this._log(`Started (interval: ${this.interval}ms)`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this._log("Stopped");
  }

  _wrapApis() {
    if (this._wrapped) return;
    this._wrapped = true;

    const self = this;

    try {
      const { Mongo } = require("meteor/mongo");
      const { Meteor } = require("meteor/meteor");

      if (!Mongo || !Mongo.Collection) {
        this._warn("Mongo.Collection not available");
        return;
      }

      const proto = Mongo.Collection.prototype;

      // Sync methods (deprecated)
      const syncMethods = ["findOne", "insert", "update", "remove", "upsert"];
      syncMethods.forEach(method => {
        const original = proto[method];
        if (typeof original !== "function") return;

        // Only wrap if the async variant exists
        const asyncName = method + "Async";
        if (typeof proto[asyncName] !== "function") return;

        const originalDescriptor = Object.getOwnPropertyDescriptor(proto, method);
        // Don't re-wrap if already wrapped by MethodTracer
        // Instead, chain: increment counter then call existing wrapper
        const currentFn = proto[method];

        proto[method] = function (...args) {
          const collectionName = this._name || "unknown";
          self._increment(collectionName, method, "sync");
          return currentFn.apply(this, args);
        };
      });

      // Async methods (preferred)
      const asyncMethods = ["findOneAsync", "insertAsync", "updateAsync", "removeAsync", "upsertAsync"];
      asyncMethods.forEach(method => {
        const currentFn = proto[method];
        if (typeof currentFn !== "function") return;

        proto[method] = function (...args) {
          const collectionName = this._name || "unknown";
          const baseMethod = method.replace("Async", "");
          self._increment(collectionName, baseMethod, "async");
          return currentFn.apply(this, args);
        };
      });

      // Track Meteor.call vs Meteor.callAsync
      if (typeof Meteor.call === "function") {
        const originalCall = Meteor.call;
        Meteor.call = function (...args) {
          self._increment("Meteor", "call", "sync");
          return originalCall.apply(this, args);
        };
      }

      if (typeof Meteor.callAsync === "function") {
        const originalCallAsync = Meteor.callAsync;
        Meteor.callAsync = function (...args) {
          self._increment("Meteor", "call", "async");
          return originalCallAsync.apply(this, args);
        };
      }

      this._log("API wrappers installed");
    } catch (error) {
      this._warn("Failed to wrap APIs:", error.message);
    }
  }

  _increment(collection, method, type) {
    const key = `${collection}.${method}`;
    if (!this._counters[key]) {
      this._counters[key] = { sync: 0, async: 0 };
    }
    this._counters[key][type]++;
  }

  _collect() {
    try {
      const entries = Object.entries(this._counters);
      if (entries.length === 0) return;

      const syncCalls = [];
      const asyncCalls = [];
      let totalSync = 0;
      let totalAsync = 0;

      for (const [key, counts] of entries) {
        const [collection, method] = key.split(".");
        if (counts.sync > 0) {
          syncCalls.push({ method, collection, count: counts.sync });
          totalSync += counts.sync;
        }
        if (counts.async > 0) {
          asyncCalls.push({ method, collection, count: counts.async });
          totalAsync += counts.async;
        }
      }

      const total = totalSync + totalAsync;
      const syncPercentage = total > 0 ? Math.round((totalSync / total) * 100) : 0;

      // Only report if there's actual usage
      if (total === 0) return;

      const metric = {
        timestamp: new Date(),
        host: this.host,
        appVersion: this.appVersion,
        syncCalls,
        asyncCalls,
        syncPercentage,
        totalSync,
        totalAsync
      };

      if (this.client) {
        this.client.addDeprecatedApiMetric(metric);
      }

      this._log(`Collected: ${totalSync} sync, ${totalAsync} async calls (${syncPercentage}% deprecated)`);

      // Reset counters
      this._counters = {};
    } catch (error) {
      this._warn("Collection error:", error.message);
    }
  }
}
