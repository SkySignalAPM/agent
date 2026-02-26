import { Meteor } from "meteor/meteor";
import os from "os";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { PerformanceObserver, performance } from "perf_hooks";
import v8 from "v8";

// Promisified exec for non-blocking command execution
const execAsync = promisify(exec);

// Agent version - must be updated alongside package.js on each release
const AGENT_VERSION = '1.0.17';

/**
 * SystemMetricsCollector
 * Production-ready system metrics collector with zero external dependencies
 * Supports Linux, macOS, and Windows with platform-specific implementations
 */
export default class SystemMetricsCollector {
  constructor(options = {}) {
    this.client = options.client;
    this.host = options.host || "unknown-host";
    this.appVersion = options.appVersion || "unknown";
    this.buildHash = options.buildHash || null; // Build hash for source map lookup
    this.interval = options.interval || 60000; // 1 minute default
    this.debug = options.debug || false; // Debug mode for verbose logging
    this.intervalId = null;

    // State tracking for delta calculations
    this.previousCpuStats = null;
    this.previousNetworkStats = null;
    this.previousNetworkTime = null;

    // Platform detection
    this.platform = os.platform(); // 'linux', 'darwin', 'win32'

    // Disk stats caching (disk stats don't change frequently, avoid blocking execSync)
    this.cachedDiskStats = null;
    this.diskStatsCacheTime = 0;
    this.diskStatsCacheTTL = 300000; // Cache for 5 minutes (disk changes slowly)

    // Event loop lag measurement
    this.eventLoopLag = 0;
    this._startEventLoopMonitoring();

    // Event Loop Utilization (Node 14.10+)
    this._previousELU = null;
    try {
      if (typeof performance.eventLoopUtilization === "function") {
        this._previousELU = performance.eventLoopUtilization();
      }
    } catch (e) {
      // ELU not available
    }

    // Garbage Collection tracking
    this.gcStats = {
      count: 0,
      totalDuration: 0,
      totalPauseTime: 0,
    };
    this._startGCMonitoring();
  }

  /** Debug logging helper */
  _log(...args) {
    if (this.debug) {
      console.log('[SkySignal:SystemMetrics]', ...args);
    }
  }

  /** Warning logging helper */
  _warn(...args) {
    console.warn('[SkySignal:SystemMetrics]', ...args);
  }

  /**
   * Start collecting system metrics
   */
  async start() {
    if (this.intervalId) {
      this._warn("Already started");
      return;
    }

    // Initialize baseline (don't send on first collection)
    try {
      await this._collect(true); // skipSend = true
    } catch (error) {
      this._warn("Failed to initialize:", error.message);
    }

    // Then collect at regular intervals
    this.intervalId = setInterval(async () => {
      try {
        await this._collect(false); // skipSend = false
      } catch (error) {
        this._warn("Collection error:", error.message);
      }
    }, this.interval);

    this._log(`Started (interval: ${this.interval}ms)`);
  }

  /**
   * Stop collecting system metrics
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.eventLoopIntervalId) {
      clearInterval(this.eventLoopIntervalId);
      this.eventLoopIntervalId = null;
    }
    if (this.gcObserver) {
      this.gcObserver.disconnect();
      this.gcObserver = null;
    }
    this._log("Stopped");
  }

  /**
   * Collect system metrics
   * @param {boolean} skipSend - Skip sending (for baseline initialization)
   * @private
   */
  async _collect(skipSend = false) {
    try {
      const timestamp = new Date();

      // CPU metrics
      const cpuUsage = this._getCpuUsage();
      const cpuCores = os.availableParallelism();
      const loadAverage = os.loadavg();

      // Memory metrics
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memoryUsage = (usedMem / totalMem) * 100;

      // Process memory
      const processMemory = process.memoryUsage();

      // Async metrics collection (non-blocking)
      const [diskStats, networkStats, processCount] = await Promise.all([
        this._getDiskStats(),
        this._getNetworkStats(),
        this._getProcessCount()
      ]);

      const meteorVersion = Meteor.release?.split("@")[1] || "unknown";

      const nodeVersion = process.version;

      // V8 Heap Statistics
      const heapStats = v8.getHeapStatistics();
      const heapSpaceStats = this._getHeapSpaceStats();

      // Event Loop Utilization (0-1 ratio of how busy the event loop is)
      let eventLoopUtilization = 0;
      if (this._previousELU && typeof performance.eventLoopUtilization === "function") {
        const currentELU = performance.eventLoopUtilization(this._previousELU);
        eventLoopUtilization = parseFloat(currentELU.utilization.toFixed(4));
        this._previousELU = performance.eventLoopUtilization();
      }

      // Process resource usage (libuv metrics)
      const resourceUsage = this._getResourceUsage();

      // Active handles/requests info (Node 17+)
      const activeResources = this._getActiveResources();

      // Constrained memory (cgroup limit, Node 19+)
      const constrainedMemory = this._getConstrainedMemory();

      // Build metric object
      const metric = {
        timestamp,
        host: this.host,
        cpuUsage: parseFloat(cpuUsage.toFixed(2)),
        cpuCores,
        loadAverage: {
          "1m": parseFloat(loadAverage[0].toFixed(2)),
          "5m": parseFloat(loadAverage[1].toFixed(2)),
          "15m": parseFloat(loadAverage[2].toFixed(2)),
        },
        memoryUsage: parseFloat(memoryUsage.toFixed(2)),
        memoryTotal: totalMem,
        memoryUsed: usedMem,
        memoryFree: freeMem,
        processMemory: {
          rss: processMemory.rss,
          heapTotal: processMemory.heapTotal,
          heapUsed: processMemory.heapUsed,
          external: processMemory.external,
        },
        eventLoopLag: parseFloat(this.eventLoopLag.toFixed(2)),
        eventLoopUtilization,
        // V8 Heap Statistics
        v8Heap: {
          totalHeapSize: heapStats.total_heap_size,
          totalHeapSizeExecutable: heapStats.total_heap_size_executable,
          totalPhysicalSize: heapStats.total_physical_size,
          usedHeapSize: heapStats.used_heap_size,
          heapSizeLimit: heapStats.heap_size_limit,
          mallocedMemory: heapStats.malloced_memory,
          externalMemory: heapStats.external_memory,
          peakMallocedMemory: heapStats.peak_malloced_memory,
          numberOfNativeContexts: heapStats.number_of_native_contexts,
          numberOfDetachedContexts: heapStats.number_of_detached_contexts,
        },
        v8HeapSpaces: heapSpaceStats,
        // Process Resource Usage
        resourceUsage,
        // Active handles/requests
        activeResources,
        // Container memory limit
        constrainedMemory,
        ...diskStats,
        ...networkStats,
        processCount,
        appVersion: this.appVersion,
        buildHash: this.buildHash,
        meteorVersion,
        nodeVersion,
        agentVersion: AGENT_VERSION,
        // Garbage Collection metrics
        gcCount: this.gcStats.count,
        gcDuration: parseFloat((this.gcStats.totalDuration).toFixed(2)),
        gcPauseTime: parseFloat((this.gcStats.totalPauseTime).toFixed(2)),
      };

      // Reset GC stats for next interval
      this.gcStats = {
        count: 0,
        totalDuration: 0,
        totalPauseTime: 0,
      };

      // Send to client (unless initializing baseline)
      if (!skipSend) {
        this.client.addSystemMetric(metric);
      }
    } catch (error) {
      this._warn("Collection error:", error.message);
    }
  }

  /**
   * Calculate CPU usage percentage (delta from previous sample)
   * @private
   */
  _getCpuUsage() {
    const cpus = os.cpus();

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

    // Calculate usage based on previous stats
    if (this.previousCpuStats) {
      const idleDiff = idle - this.previousCpuStats.idle;
      const totalDiff = total - this.previousCpuStats.total;

      if (totalDiff > 0) {
        const usage = 100 - (100 * idleDiff) / totalDiff;
        this.previousCpuStats = { idle, total };
        return Math.max(0, Math.min(100, usage)); // Clamp between 0-100
      }
    }

    // First run or no change, store stats and return 0
    this.previousCpuStats = { idle, total };
    return 0;
  }

  /**
   * Get disk usage statistics (production-ready, platform-specific)
   * Uses caching to reduce async command calls (disk stats change slowly)
   * @private
   */
  async _getDiskStats() {
    const now = Date.now();

    // Return cached stats if still valid
    if (this.cachedDiskStats && (now - this.diskStatsCacheTime) < this.diskStatsCacheTTL) {
      return this.cachedDiskStats;
    }

    try {
      let stats = null;

      if (this.platform === "linux" || this.platform === "darwin") {
        // Linux/macOS: Read from df command (async)
        const { stdout } = await execAsync("df -k /", { timeout: 2000 });
        const lines = stdout.trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          const total = parseInt(parts[1]) * 1024; // Convert KB to bytes
          const used = parseInt(parts[2]) * 1024;
          const available = parseInt(parts[3]) * 1024;
          const usagePercent = parseFloat(parts[4]);

          stats = {
            diskUsage: usagePercent,
            diskTotal: total,
            diskUsed: used,
            diskFree: available,
          };
        }
      } else if (this.platform === "win32") {
        // Windows: Use wmic command (async)
        const drive = process.cwd().charAt(0);
        const { stdout } = await execAsync(
          `wmic logicaldisk where "DeviceID='${drive}:'" get Size,FreeSpace /format:csv`,
          { timeout: 2000 }
        );
        const lines = stdout
          .trim()
          .split("\n")
          .filter((line) => line.trim());
        if (lines.length >= 2) {
          const parts = lines[1].split(",");
          const free = parseInt(parts[1]);
          const total = parseInt(parts[2]);
          const used = total - free;
          const usagePercent = (used / total) * 100;

          stats = {
            diskUsage: parseFloat(usagePercent.toFixed(2)),
            diskTotal: total,
            diskUsed: used,
            diskFree: free,
          };
        }
      }

      // Cache and return stats (or fallback zeros)
      this.cachedDiskStats = stats || {
        diskUsage: 0,
        diskTotal: 0,
        diskUsed: 0,
        diskFree: 0,
      };
      this.diskStatsCacheTime = now;
      return this.cachedDiskStats;

    } catch (error) {
      // Silent fallback on error (don't spam logs)
      // Don't update cache on error - keep old valid data if available
      return this.cachedDiskStats || {
        diskUsage: 0,
        diskTotal: 0,
        diskUsed: 0,
        diskFree: 0,
      };
    }
  }

  /**
   * Get network statistics (bytes in/out per second)
   * @private
   */
  async _getNetworkStats() {
    try {
      const now = Date.now();
      let currentStats = null;

      if (this.platform === "linux") {
        // Linux: Read from /proc/net/dev
        const data = await fs.readFile("/proc/net/dev", "utf8");
        const lines = data.split("\n");

        let totalRx = 0;
        let totalTx = 0;

        for (let i = 2; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          const parts = line.split(/\s+/);
          if (parts.length < 10) continue;

          // Skip loopback
          if (parts[0].startsWith("lo:")) continue;

          // bytes received: parts[1], bytes transmitted: parts[9]
          totalRx += parseInt(parts[1]) || 0;
          totalTx += parseInt(parts[9]) || 0;
        }

        currentStats = { rx: totalRx, tx: totalTx };
      } else if (this.platform === "darwin") {
        // macOS: Use netstat command (async)
        const { stdout } = await execAsync("netstat -ib -I en0", { timeout: 2000 });
        const lines = stdout.trim().split("\n");

        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          // Ibytes: parts[6], Obytes: parts[9]
          currentStats = {
            rx: parseInt(parts[6]) || 0,
            tx: parseInt(parts[9]) || 0,
          };
        }
      } else if (this.platform === "win32") {
        // Windows: Use netsh to get per-interface statistics (async)
        try {
          const { stdout } = await execAsync("netsh interface ip show subinterfaces", {
            timeout: 2000,
          });
          const lines = stdout.trim().split("\n");

          let totalRx = 0;
          let totalTx = 0;

          // Skip first 2 lines (header and separator)
          // Format: MTU  MediaSenseState  Bytes In  Bytes Out  Interface
          for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const parts = line.split(/\s+/);
            // Columns: [0]=MTU [1]=MediaSenseState [2]=BytesIn [3]=BytesOut [4+]=Interface
            if (parts.length >= 4) {
              const bytesIn = parseInt(parts[2]) || 0;
              const bytesOut = parseInt(parts[3]) || 0;
              totalRx += bytesIn;
              totalTx += bytesOut;
            }
          }

          currentStats = { rx: totalRx, tx: totalTx };
        } catch (err) {
          // netsh might fail, return zeros
          currentStats = { rx: 0, tx: 0 };
        }
      }

      // Calculate rate (bytes per second)
      if (
        this.previousNetworkStats &&
        this.previousNetworkTime &&
        currentStats
      ) {
        const timeDiff = (now - this.previousNetworkTime) / 1000; // seconds

        if (timeDiff > 0) {
          const rxDiff = currentStats.rx - this.previousNetworkStats.rx;
          const txDiff = currentStats.tx - this.previousNetworkStats.tx;

          this.previousNetworkStats = currentStats;
          this.previousNetworkTime = now;

          return {
            networkIn: Math.max(0, Math.round(rxDiff / timeDiff)),
            networkOut: Math.max(0, Math.round(txDiff / timeDiff)),
          };
        }
      }

      // First run: store baseline
      if (currentStats) {
        this.previousNetworkStats = currentStats;
        this.previousNetworkTime = now;
      }

      return {
        networkIn: 0,
        networkOut: 0,
      };
    } catch (error) {
      // Silent fallback
      return {
        networkIn: 0,
        networkOut: 0,
      };
    }
  }

  /**
   * Get process count (platform-specific)
   * @private
   */
  async _getProcessCount() {
    try {
      if (this.platform === "linux") {
        // Linux: Count numeric entries in /proc
        const entries = await fs.readdir("/proc");
        return entries.filter((name) => /^\d+$/.test(name)).length;
      } else if (this.platform === "darwin") {
        // macOS: Use ps command (async)
        const { stdout } = await execAsync("ps ax | wc -l", { timeout: 2000 });
        return parseInt(stdout.trim()) - 1; // Subtract header line
      } else if (this.platform === "win32") {
        // Windows: Use tasklist (async)
        const { stdout } = await execAsync('tasklist | find /c /v ""', { timeout: 2000 });
        return parseInt(stdout.trim()) - 3; // Subtract header lines
      }

      return 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Start monitoring event loop lag
   * Uses high-resolution timer to measure scheduling delays
   * @private
   */
  _startEventLoopMonitoring() {
    const INTERVAL = 1000; // Check every second
    let lastCheck = process.hrtime.bigint();

    this.eventLoopIntervalId = setInterval(() => {
      const now = process.hrtime.bigint();
      const elapsed = Number(now - lastCheck) / 1e6; // Convert to milliseconds
      const lag = elapsed - INTERVAL;

      // Smooth the lag value (exponential moving average)
      this.eventLoopLag = this.eventLoopLag * 0.7 + lag * 0.3;

      lastCheck = now;
    }, INTERVAL);
  }

  /**
   * Get V8 heap space statistics (per-space breakdown)
   * @private
   */
  _getHeapSpaceStats() {
    try {
      const spaces = v8.getHeapSpaceStatistics();
      const result = {};
      for (const space of spaces) {
        result[space.space_name] = {
          size: space.space_size,
          used: space.space_used_size,
          available: space.space_available_size,
          physical: space.physical_space_size,
        };
      }
      return result;
    } catch (e) {
      return {};
    }
  }

  /**
   * Get process resource usage from libuv (user/system CPU time, page faults, I/O)
   * @private
   */
  _getResourceUsage() {
    try {
      if (typeof process.resourceUsage !== "function") return null;
      const ru = process.resourceUsage();
      return {
        userCPUTime: ru.userCPUTime,           // microseconds
        systemCPUTime: ru.systemCPUTime,       // microseconds
        maxRSS: ru.maxRSS,                     // kilobytes
        voluntaryContextSwitches: ru.voluntaryContextSwitches,
        involuntaryContextSwitches: ru.involuntaryContextSwitches,
        fsRead: ru.fsRead,                     // file system reads
        fsWrite: ru.fsWrite,                   // file system writes
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Get active handles/requests breakdown (Node 17+)
   * Counts by type (Timer, TCPWrap, FSReqCallback, etc.) to detect resource leaks
   * @private
   */
  _getActiveResources() {
    try {
      if (typeof process.getActiveResourcesInfo !== "function") return null;
      const resources = process.getActiveResourcesInfo();
      // Count by type
      const counts = {};
      for (const type of resources) {
        counts[type] = (counts[type] || 0) + 1;
      }
      return {
        total: resources.length,
        byType: counts,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Get cgroup memory limit (Node 19+, important for containerized apps)
   * @private
   */
  _getConstrainedMemory() {
    try {
      if (typeof process.constrainedMemory !== "function") return null;
      const limit = process.constrainedMemory();
      return limit > 0 ? limit : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Start monitoring garbage collection events
   * Uses Node.js PerformanceObserver to track GC activity
   * @private
   */
  _startGCMonitoring() {
    try {
      // Create a PerformanceObserver to watch for GC events
      this.gcObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();

        entries.forEach((entry) => {
          // entry.kind: 'major', 'minor', 'incremental', 'weakcb', etc.
          // entry.duration: Duration in milliseconds

          this.gcStats.count++;
          this.gcStats.totalDuration += entry.duration;

          // For pause time, we use the duration since GC pauses the main thread
          // Some GC types are incremental and have lower pause times
          if (entry.kind === 'major' || entry.kind === 'minor') {
            this.gcStats.totalPauseTime += entry.duration;
          } else if (entry.kind === 'incremental') {
            // Incremental GC has lower pause times (typically 10-20% of duration)
            this.gcStats.totalPauseTime += entry.duration * 0.15;
          } else {
            // For other types, use half the duration as an estimate
            this.gcStats.totalPauseTime += entry.duration * 0.5;
          }
        });
      });

      // Start observing GC events
      this.gcObserver.observe({ entryTypes: ['gc'] });

      this._log("GC monitoring started");
    } catch (error) {
      // GC monitoring might not be available in all Node.js versions
      this._warn("GC monitoring not available:", error.message);
    }
  }
}
