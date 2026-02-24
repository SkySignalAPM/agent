import dns from "dns";
import { performance } from "perf_hooks";

/**
 * DnsTimingCollector
 * Wraps Node.js dns.lookup and dns.resolve to measure DNS resolution latency.
 * Helps identify slow DNS resolvers or misconfigured DNS in Docker/K8s environments.
 *
 * Collects:
 * - Per-hostname resolution times
 * - Top slowest resolutions
 * - Average/P95/max latency
 * - Failure counts
 */
export default class DnsTimingCollector {
  constructor(options = {}) {
    this.client = options.client;
    this.host = options.host || "unknown-host";
    this.appVersion = options.appVersion || "unknown";
    this.buildHash = options.buildHash || null;
    this.interval = options.interval || 60000;
    this.debug = options.debug || false;

    this.intervalId = null;
    this._originalLookup = null;
    this._originalResolve = null;

    // Ring buffer for DNS timing samples (keep last 500)
    this._samples = [];
    this._maxSamples = 500;
  }

  _log(...args) {
    if (this.debug) {
      console.log("[SkySignal:DnsTiming]", ...args);
    }
  }

  _warn(...args) {
    console.warn("[SkySignal:DnsTiming]", ...args);
  }

  start() {
    if (this.intervalId) {
      this._warn("Already started");
      return;
    }

    this._wrapDns();

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
    this._unwrapDns();
    this._log("Stopped");
  }

  _wrapDns() {
    // Wrap dns.lookup
    this._originalLookup = dns.lookup;
    const self = this;

    dns.lookup = function (hostname, options, callback) {
      // Handle optional options argument
      if (typeof options === "function") {
        callback = options;
        options = {};
      }

      const start = performance.now();

      self._originalLookup.call(dns, hostname, options, function (err, address, family) {
        const duration = performance.now() - start;
        self._recordSample(hostname, "lookup", duration, !!err);

        if (callback) {
          callback(err, address, family);
        }
      });
    };

    // Wrap dns.resolve (if used)
    this._originalResolve = dns.resolve;
    dns.resolve = function (hostname, rrtype, callback) {
      if (typeof rrtype === "function") {
        callback = rrtype;
        rrtype = "A";
      }

      const start = performance.now();

      self._originalResolve.call(dns, hostname, rrtype, function (err, records) {
        const duration = performance.now() - start;
        self._recordSample(hostname, "resolve", duration, !!err);

        if (callback) {
          callback(err, records);
        }
      });
    };
  }

  _unwrapDns() {
    if (this._originalLookup) {
      dns.lookup = this._originalLookup;
      this._originalLookup = null;
    }
    if (this._originalResolve) {
      dns.resolve = this._originalResolve;
      this._originalResolve = null;
    }
  }

  _recordSample(hostname, method, durationMs, failed) {
    this._samples.push({
      hostname,
      method,
      duration: parseFloat(durationMs.toFixed(3)),
      failed,
      timestamp: Date.now(),
    });

    // Keep buffer bounded
    if (this._samples.length > this._maxSamples) {
      this._samples = this._samples.slice(-this._maxSamples);
    }
  }

  _collect() {
    if (this._samples.length === 0) return;

    // Take all samples since last collection
    const samples = this._samples.splice(0);

    // Aggregate by hostname
    const byHostname = {};
    let totalDuration = 0;
    let failCount = 0;
    const durations = [];

    for (const s of samples) {
      if (!byHostname[s.hostname]) {
        byHostname[s.hostname] = { count: 0, totalDuration: 0, failures: 0, maxDuration: 0 };
      }
      byHostname[s.hostname].count++;
      byHostname[s.hostname].totalDuration += s.duration;
      byHostname[s.hostname].maxDuration = Math.max(byHostname[s.hostname].maxDuration, s.duration);
      if (s.failed) {
        byHostname[s.hostname].failures++;
        failCount++;
      }
      totalDuration += s.duration;
      durations.push(s.duration);
    }

    // Calculate percentiles
    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
    const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
    const p99 = durations[Math.floor(durations.length * 0.99)] || 0;

    // Build top hostnames by count
    const topHostnames = Object.entries(byHostname)
      .map(([hostname, stats]) => ({
        hostname,
        count: stats.count,
        avgDuration: parseFloat((stats.totalDuration / stats.count).toFixed(3)),
        maxDuration: parseFloat(stats.maxDuration.toFixed(3)),
        failures: stats.failures,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const metric = {
      timestamp: new Date(),
      host: this.host,
      appVersion: this.appVersion,
      buildHash: this.buildHash,
      totalLookups: samples.length,
      totalFailures: failCount,
      avgDuration: parseFloat((totalDuration / samples.length).toFixed(3)),
      p50Duration: parseFloat(p50.toFixed(3)),
      p95Duration: parseFloat(p95.toFixed(3)),
      p99Duration: parseFloat(p99.toFixed(3)),
      maxDuration: parseFloat(durations[durations.length - 1].toFixed(3)),
      uniqueHostnames: Object.keys(byHostname).length,
      topHostnames,
    };

    this.client.addDnsMetric(metric);
    this._log(`Sent DNS metrics: ${samples.length} lookups, avg ${metric.avgDuration}ms`);
  }

  getStats() {
    return {
      pendingSamples: this._samples.length,
    };
  }
}
