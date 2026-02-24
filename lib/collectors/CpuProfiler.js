import inspector from "inspector";

/**
 * CpuProfiler
 * On-demand CPU profiling using the Node.js inspector module.
 *
 * Automatically triggers a short CPU profile when CPU usage exceeds a threshold,
 * then sends the profile summary (top functions, hot paths) to the dashboard.
 *
 * This is the same mechanism used by Datadog's Continuous Profiler and Sentry Profiling.
 * The inspector module is built into Node.js — zero dependencies.
 *
 * Features:
 * - Automatic threshold-based profiling
 * - Configurable duration and cooldown
 * - Extracts top functions by self-time (no raw profile transfer — just the summary)
 * - Minimal overhead when not actively profiling
 */
export default class CpuProfiler {
  constructor(options = {}) {
    this.client = options.client;
    this.host = options.host || "unknown-host";
    this.appVersion = options.appVersion || "unknown";
    this.buildHash = options.buildHash || null;
    this.interval = options.interval || 60000;
    this.debug = options.debug || false;

    // Profiling configuration
    this.cpuThreshold = options.cpuThreshold || 80;       // CPU % to trigger profiling
    this.profileDuration = options.profileDuration || 10000; // 10s profile
    this.cooldownPeriod = options.cooldownPeriod || 300000;  // 5 min between profiles

    this.intervalId = null;
    this._session = null;
    this._isProfiling = false;
    this._lastProfileTime = 0;
    this._lastCpuUsage = 0;

    // Track CPU usage for threshold detection
    this._previousCpuStats = null;
  }

  _log(...args) {
    if (this.debug) {
      console.log("[SkySignal:CpuProfiler]", ...args);
    }
  }

  _warn(...args) {
    console.warn("[SkySignal:CpuProfiler]", ...args);
  }

  start() {
    if (this.intervalId) {
      this._warn("Already started");
      return;
    }

    // Check CPU periodically and trigger profiling if threshold exceeded
    this.intervalId = setInterval(() => {
      this._checkAndProfile();
    }, this.interval);

    this._log(`Started (threshold: ${this.cpuThreshold}%, duration: ${this.profileDuration}ms)`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this._stopProfiling();
    this._log("Stopped");
  }

  /**
   * Get current CPU usage for threshold detection
   */
  _getCpuUsage() {
    const cpus = require("os").cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;

    if (this._previousCpuStats) {
      const idleDiff = idle - this._previousCpuStats.idle;
      const totalDiff = total - this._previousCpuStats.total;
      this._previousCpuStats = { idle, total };
      if (totalDiff > 0) {
        return Math.max(0, Math.min(100, 100 - (100 * idleDiff / totalDiff)));
      }
    }

    this._previousCpuStats = { idle, total };
    return 0;
  }

  async _checkAndProfile() {
    const cpuUsage = this._getCpuUsage();
    this._lastCpuUsage = cpuUsage;

    // Skip if already profiling or in cooldown
    if (this._isProfiling) return;
    if (Date.now() - this._lastProfileTime < this.cooldownPeriod) return;

    // Only profile if CPU exceeds threshold
    if (cpuUsage < this.cpuThreshold) return;

    this._log(`CPU at ${cpuUsage.toFixed(1)}% (threshold: ${this.cpuThreshold}%), starting profile...`);

    try {
      const profile = await this._captureProfile();
      if (profile) {
        this._sendProfileSummary(profile, cpuUsage);
      }
    } catch (error) {
      this._warn("Profiling error:", error.message);
    }
  }

  _captureProfile() {
    return new Promise((resolve, reject) => {
      this._isProfiling = true;

      try {
        this._session = new inspector.Session();
        this._session.connect();

        this._session.post("Profiler.enable", (err) => {
          if (err) {
            this._isProfiling = false;
            this._session.disconnect();
            this._session = null;
            return reject(err);
          }

          this._session.post("Profiler.start", (err) => {
            if (err) {
              this._isProfiling = false;
              this._session.disconnect();
              this._session = null;
              return reject(err);
            }

            // Stop after profileDuration
            setTimeout(() => {
              this._session.post("Profiler.stop", (err, { profile }) => {
                this._session.post("Profiler.disable", () => {
                  this._session.disconnect();
                  this._session = null;
                  this._isProfiling = false;
                  this._lastProfileTime = Date.now();

                  if (err) return reject(err);
                  resolve(profile);
                });
              });
            }, this.profileDuration);
          });
        });
      } catch (error) {
        this._isProfiling = false;
        if (this._session) {
          try { this._session.disconnect(); } catch (e) {}
          this._session = null;
        }
        reject(error);
      }
    });
  }

  _stopProfiling() {
    if (this._session) {
      try {
        this._session.post("Profiler.stop", () => {});
        this._session.post("Profiler.disable", () => {});
        this._session.disconnect();
      } catch (e) {
        // Ignore cleanup errors
      }
      this._session = null;
    }
    this._isProfiling = false;
  }

  /**
   * Extract a summary from the CPU profile (top functions by self-time)
   * We do NOT send the raw profile — just actionable insights.
   */
  _sendProfileSummary(profile, triggerCpu) {
    if (!profile || !profile.nodes || !profile.samples) return;

    // Build a map of nodeId -> node for quick lookup
    const nodeMap = new Map();
    for (const node of profile.nodes) {
      nodeMap.set(node.id, node);
    }

    // Count samples per node (each sample = 1 tick of CPU time)
    const sampleCounts = {};
    for (const nodeId of profile.samples) {
      sampleCounts[nodeId] = (sampleCounts[nodeId] || 0) + 1;
    }

    const totalSamples = profile.samples.length;
    const profileDurationMs = (profile.endTime - profile.startTime) / 1000; // microseconds to ms

    // Build function list with self-time percentages
    const functions = [];
    for (const [nodeId, count] of Object.entries(sampleCounts)) {
      const node = nodeMap.get(parseInt(nodeId));
      if (!node || !node.callFrame) continue;

      const { functionName, url, lineNumber } = node.callFrame;

      // Skip internal V8/Node functions
      if (!url || url.startsWith("node:") || url === "" || functionName === "(idle)") continue;

      functions.push({
        functionName: functionName || "(anonymous)",
        url: this._shortenUrl(url),
        lineNumber,
        selfTime: parseFloat(((count / totalSamples) * 100).toFixed(2)),
        sampleCount: count,
      });
    }

    // Sort by self-time (most CPU-intensive first)
    functions.sort((a, b) => b.selfTime - a.selfTime);

    // Take top 25 functions
    const topFunctions = functions.slice(0, 25);

    const metric = {
      timestamp: new Date(),
      host: this.host,
      appVersion: this.appVersion,
      buildHash: this.buildHash,
      triggerCpu: parseFloat(triggerCpu.toFixed(1)),
      profileDurationMs: parseFloat(profileDurationMs.toFixed(0)),
      totalSamples,
      totalNodes: profile.nodes.length,
      topFunctions,
      // Summary stats
      appCodePercentage: parseFloat(
        functions.reduce((sum, f) => sum + f.selfTime, 0).toFixed(1)
      ),
    };

    this.client.addCpuProfile(metric);
    this._log(
      `Profile captured: ${totalSamples} samples, ${profileDurationMs.toFixed(0)}ms, ` +
      `top function: ${topFunctions[0]?.functionName || "N/A"} (${topFunctions[0]?.selfTime || 0}%)`
    );
  }

  /**
   * Shorten file URLs for readability (remove absolute paths, keep package-relative)
   */
  _shortenUrl(url) {
    if (!url) return "";
    // Remove absolute path prefix, keep from packages/ or imports/ onwards
    const markers = ["/imports/", "/packages/", "/node_modules/", "/server/", "/client/"];
    for (const marker of markers) {
      const idx = url.indexOf(marker);
      if (idx !== -1) return url.substring(idx);
    }
    // Fallback: just the filename
    const parts = url.split("/");
    return parts.slice(-2).join("/");
  }

  getStats() {
    return {
      isProfiling: this._isProfiling,
      lastCpuUsage: this._lastCpuUsage,
      lastProfileTime: this._lastProfileTime ? new Date(this._lastProfileTime) : null,
      cooldownRemaining: Math.max(0, this.cooldownPeriod - (Date.now() - this._lastProfileTime)),
    };
  }
}
