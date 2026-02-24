import os from "os";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * EnvironmentCollector
 * Collects environment metadata once at startup + periodic refresh (every 30 min).
 *
 * Captures:
 * - Installed package versions from process.versions and package.json
 * - Node.js flags (process.execArgv)
 * - Environment variable keys (NOT values — security)
 * - OS info (platform, release, CPUs, total memory)
 */
export default class EnvironmentCollector {
  constructor(options = {}) {
    this.client = options.client;
    this.host = options.host || "unknown-host";
    this.appVersion = options.appVersion || "unknown";
    this.interval = options.interval || 1800000; // 30 minutes
    this.debug = options.debug || false;

    this.intervalId = null;
    this._lastSnapshot = null;
  }

  _log(...args) {
    if (this.debug) {
      console.log("[SkySignal:Environment]", ...args);
    }
  }

  _warn(...args) {
    console.warn("[SkySignal:Environment]", ...args);
  }

  start() {
    if (this.intervalId) {
      this._warn("Already started");
      return;
    }

    // Collect immediately on start
    this._collect();

    // Then periodically
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

  _collect() {
    try {
      const packages = this._getPackageVersions();
      const nodeFlags = process.execArgv || [];
      const envKeys = this._getEnvKeys();
      const osInfo = this._getOsInfo();

      const metric = {
        timestamp: new Date(),
        host: this.host,
        appVersion: this.appVersion,
        packages,
        nodeFlags,
        envKeys,
        os: osInfo
      };

      // Only send if something changed (or first time)
      const fingerprint = JSON.stringify({ packages, nodeFlags, envKeys });
      if (fingerprint !== this._lastSnapshot) {
        this._lastSnapshot = fingerprint;

        if (this.client) {
          this.client.addEnvironmentMetric(metric);
        }

        this._log(`Collected: ${Object.keys(packages).length} packages, ${envKeys.length} env keys`);
      } else {
        this._log("No environment changes detected, skipping");
      }
    } catch (error) {
      this._warn("Collection error:", error.message);
    }
  }

  /**
   * Get package versions from process.versions and attempt to read package.json
   */
  _getPackageVersions() {
    const versions = { ...process.versions };

    // Try to read the app's package.json for dependency versions
    try {
      const cwd = process.cwd();
      const pkgPath = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

      if (pkg.dependencies) {
        for (const [name, version] of Object.entries(pkg.dependencies)) {
          // Store dependency versions under "dep:" prefix to distinguish from runtime
          versions[`dep:${name}`] = version;
        }
      }
    } catch (_) {
      // package.json may not be accessible in production bundles
      this._log("Could not read package.json (expected in bundled deployments)");
    }

    // Try to get Meteor version
    try {
      const { Meteor } = require("meteor/meteor");
      if (Meteor.release) {
        versions.meteor = Meteor.release;
      }
    } catch (_) {
      // Not in Meteor context
    }

    return versions;
  }

  /**
   * Get environment variable keys (never values for security)
   */
  _getEnvKeys() {
    return Object.keys(process.env).sort();
  }

  /**
   * Get OS information
   */
  _getOsInfo() {
    return {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || "unknown",
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      hostname: os.hostname(),
      uptime: os.uptime()
    };
  }
}
