/**
 * DiagnosticsChannelCollector
 * Uses Node.js diagnostics_channel API (Node 16+) to instrument outbound HTTP
 * client requests WITHOUT monkey-patching http.request.
 *
 * This captures:
 * - Outbound HTTP/HTTPS request timing (DNS, connect, TLS, TTFB, total)
 * - Request/response metadata (method, host, status, content-length)
 * - Error rates for external API calls
 *
 * This is the modern, forward-compatible way to instrument HTTP —
 * used by OpenTelemetry, Undici, and Node's native fetch.
 */

import { percentile } from "../utils/percentile";
import { trimToMaxSize } from "../utils/buffer";

let diagnostics_channel;
try {
  diagnostics_channel = require("diagnostics_channel");
} catch (e) {
  // diagnostics_channel not available (Node < 16)
}

export default class DiagnosticsChannelCollector {
  constructor(options = {}) {
    this.client = options.client;
    this.host = options.host || "unknown-host";
    this.appVersion = options.appVersion || "unknown";
    this.buildHash = options.buildHash || null;
    this.interval = options.interval || 60000;
    this.debug = options.debug || false;

    this.intervalId = null;
    this._subscriptions = [];

    // Buffer for outbound request metrics
    this._requests = [];
    this._maxRequests = 1000;

    // Track in-flight requests by their socket/request reference
    this._inFlight = new WeakMap();
  }

  _log(...args) {
    if (this.debug) {
      console.log("[SkySignal:DiagnosticsChannel]", ...args);
    }
  }

  _warn(...args) {
    console.warn("[SkySignal:DiagnosticsChannel]", ...args);
  }

  start() {
    if (!diagnostics_channel) {
      this._warn("diagnostics_channel not available (requires Node 16+)");
      return;
    }

    if (this.intervalId) {
      this._warn("Already started");
      return;
    }

    this._subscribe();

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
    this._unsubscribe();
    this._log("Stopped");
  }

  _subscribe() {
    // Undici (Node's native fetch) channels
    const undiciChannels = [
      "undici:request:create",
      "undici:request:headers",
      "undici:request:trailers",
      "undici:request:error",
    ];

    // http module channels (Node 20+)
    const httpChannels = [
      "http.client.request.start",
      "http.client.response.finish",
    ];

    const self = this;

    // Subscribe to Undici channels (Node's fetch)
    for (const channelName of undiciChannels) {
      try {
        const channel = diagnostics_channel.channel(channelName);
        if (!channel) continue;

        const handler = (message) => self._handleUndiciEvent(channelName, message);
        channel.subscribe(handler);
        this._subscriptions.push({ channel, handler });
      } catch (e) {
        // Channel not available
      }
    }

    // Subscribe to http module channels
    for (const channelName of httpChannels) {
      try {
        const channel = diagnostics_channel.channel(channelName);
        if (!channel) continue;

        const handler = (message) => self._handleHttpEvent(channelName, message);
        channel.subscribe(handler);
        this._subscriptions.push({ channel, handler });
      } catch (e) {
        // Channel not available
      }
    }

    this._log(`Subscribed to ${this._subscriptions.length} diagnostic channels`);
  }

  _unsubscribe() {
    for (const { channel, handler } of this._subscriptions) {
      try {
        channel.unsubscribe(handler);
      } catch (e) {
        // Ignore
      }
    }
    this._subscriptions = [];
  }

  _handleUndiciEvent(channelName, message) {
    try {
      if (channelName === "undici:request:create") {
        // Request starting
        const req = message.request;
        if (req) {
          this._inFlight.set(req, {
            startTime: Date.now(),
            method: req.method,
            host: req.origin || "unknown",
            path: req.path || "/",
          });
        }
      } else if (channelName === "undici:request:headers") {
        // Response headers received (TTFB)
        const req = message.request;
        const tracked = req ? this._inFlight.get(req) : null;
        if (tracked) {
          tracked.ttfb = Date.now() - tracked.startTime;
          tracked.statusCode = message.response?.statusCode;
        }
      } else if (channelName === "undici:request:trailers") {
        // Request complete
        const req = message.request;
        const tracked = req ? this._inFlight.get(req) : null;
        if (tracked) {
          tracked.totalTime = Date.now() - tracked.startTime;
          this._recordRequest(tracked, false);
          this._inFlight.delete(req);
        }
      } else if (channelName === "undici:request:error") {
        // Request failed
        const req = message.request;
        const tracked = req ? this._inFlight.get(req) : null;
        if (tracked) {
          tracked.totalTime = Date.now() - tracked.startTime;
          tracked.error = message.error?.message || "unknown";
          this._recordRequest(tracked, true);
          this._inFlight.delete(req);
        }
      }
    } catch (e) {
      // Don't let tracking errors affect the application
    }
  }

  _handleHttpEvent(channelName, message) {
    try {
      if (channelName === "http.client.request.start") {
        const req = message.request;
        if (req) {
          this._inFlight.set(req, {
            startTime: Date.now(),
            method: req.method || "GET",
            host: req.getHeader?.("host") || req.hostname || "unknown",
            path: req.path || "/",
          });
        }
      } else if (channelName === "http.client.response.finish") {
        const req = message.request;
        const tracked = req ? this._inFlight.get(req) : null;
        if (tracked) {
          tracked.totalTime = Date.now() - tracked.startTime;
          tracked.statusCode = message.response?.statusCode;
          this._recordRequest(tracked, false);
          this._inFlight.delete(req);
        }
      }
    } catch (e) {
      // Don't let tracking errors affect the application
    }
  }

  _recordRequest(tracked, failed) {
    this._requests.push({
      method: tracked.method,
      host: tracked.host,
      path: tracked.path,
      statusCode: tracked.statusCode || 0,
      ttfb: tracked.ttfb || 0,
      totalTime: tracked.totalTime || 0,
      failed,
      error: tracked.error,
      timestamp: Date.now(),
    });

    // Keep buffer bounded
    trimToMaxSize(this._requests, this._maxRequests);
  }

  _collect() {
    if (this._requests.length === 0) return;

    const requests = this._requests.splice(0);

    // Aggregate by host
    const byHost = {};
    let totalTime = 0;
    let totalTtfb = 0;
    let failCount = 0;
    const times = [];

    for (const r of requests) {
      if (!byHost[r.host]) {
        byHost[r.host] = {
          count: 0, totalTime: 0, totalTtfb: 0, failures: 0,
          statusCodes: {}, maxTime: 0,
        };
      }
      const h = byHost[r.host];
      h.count++;
      h.totalTime += r.totalTime;
      h.totalTtfb += r.ttfb;
      h.maxTime = Math.max(h.maxTime, r.totalTime);
      if (r.failed) { h.failures++; failCount++; }

      const statusGroup = r.statusCode ? `${Math.floor(r.statusCode / 100)}xx` : "err";
      h.statusCodes[statusGroup] = (h.statusCodes[statusGroup] || 0) + 1;

      totalTime += r.totalTime;
      totalTtfb += r.ttfb;
      times.push(r.totalTime);
    }

    // Percentiles
    times.sort((a, b) => a - b);
    const p50 = percentile(times, 0.5);
    const p95 = percentile(times, 0.95);
    const p99 = percentile(times, 0.99);

    // Build top external hosts
    const topHosts = Object.entries(byHost)
      .map(([host, stats]) => ({
        host,
        count: stats.count,
        avgTime: parseFloat((stats.totalTime / stats.count).toFixed(1)),
        avgTtfb: parseFloat((stats.totalTtfb / stats.count).toFixed(1)),
        maxTime: parseFloat(stats.maxTime.toFixed(1)),
        failures: stats.failures,
        statusCodes: stats.statusCodes,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const metric = {
      timestamp: new Date(),
      host: this.host,
      appVersion: this.appVersion,
      buildHash: this.buildHash,
      totalRequests: requests.length,
      totalFailures: failCount,
      avgResponseTime: parseFloat((totalTime / requests.length).toFixed(1)),
      avgTtfb: parseFloat((totalTtfb / requests.length).toFixed(1)),
      p50ResponseTime: parseFloat(p50.toFixed(1)),
      p95ResponseTime: parseFloat(p95.toFixed(1)),
      p99ResponseTime: parseFloat(p99.toFixed(1)),
      uniqueHosts: Object.keys(byHost).length,
      topHosts,
    };

    this.client.addOutboundHttpMetric(metric);
    this._log(`Sent outbound HTTP metrics: ${requests.length} requests to ${metric.uniqueHosts} hosts`);
  }

  getStats() {
    return {
      pendingRequests: this._requests.length,
      subscriptions: this._subscriptions.length,
    };
  }
}
