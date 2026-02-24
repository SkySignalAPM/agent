/**
 * WorkerPool
 * Manages a pool of worker threads for offloading CPU-intensive tasks
 * (compression, aggregation) away from the host application's event loop.
 *
 * Features:
 * - Lazy initialization (only starts workers when first used)
 * - Graceful fallback to main thread if worker_threads unavailable
 * - Auto-restart crashed workers
 * - Request ID tracking for async responses
 */

let Worker;
try {
  Worker = require("worker_threads").Worker;
} catch (e) {
  // worker_threads not available
}

export default class WorkerPool {
  constructor(options = {}) {
    this.workerScript = options.workerScript;
    this.poolSize = options.poolSize || 1;
    this.debug = options.debug || false;

    this._workers = [];
    this._nextWorker = 0;
    this._requestId = 0;
    this._pending = new Map(); // id -> { resolve, reject, timeout }
    this._started = false;
    this._available = !!Worker;
  }

  _log(...args) {
    if (this.debug) {
      console.log("[SkySignal:WorkerPool]", ...args);
    }
  }

  _warn(...args) {
    console.warn("[SkySignal:WorkerPool]", ...args);
  }

  /**
   * Check if worker threads are available
   */
  get isAvailable() {
    return this._available;
  }

  /**
   * Initialize the worker pool
   */
  start() {
    if (!this._available) {
      this._log("worker_threads not available, will use main thread fallback");
      return;
    }

    if (this._started) return;

    for (let i = 0; i < this.poolSize; i++) {
      this._spawnWorker(i);
    }

    this._started = true;
    this._log(`Started with ${this.poolSize} worker(s)`);
  }

  _spawnWorker(index) {
    try {
      const worker = new Worker(this.workerScript);

      worker.on("message", (msg) => {
        const pending = this._pending.get(msg.id);
        if (!pending) return;

        clearTimeout(pending.timeout);
        this._pending.delete(msg.id);

        if (msg.type === "error") {
          pending.reject(new Error(msg.message));
        } else {
          pending.resolve(msg);
        }
      });

      worker.on("error", (err) => {
        this._warn(`Worker ${index} error:`, err.message);
        // Replace crashed worker
        setTimeout(() => {
          if (this._started) {
            this._workers[index] = null;
            this._spawnWorker(index);
          }
        }, 1000);
      });

      worker.on("exit", (code) => {
        if (code !== 0 && this._started) {
          this._warn(`Worker ${index} exited with code ${code}, restarting...`);
          setTimeout(() => {
            if (this._started) {
              this._spawnWorker(index);
            }
          }, 1000);
        }
      });

      this._workers[index] = worker;
    } catch (error) {
      this._warn(`Failed to spawn worker ${index}:`, error.message);
      this._workers[index] = null;
    }
  }

  /**
   * Send a task to a worker thread
   * @param {Object} task - The task to execute
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<Object>} Worker response
   */
  execute(task, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this._started || !this._available) {
        return reject(new Error("WorkerPool not available"));
      }

      const id = this._requestId++;
      const worker = this._getNextWorker();

      if (!worker) {
        return reject(new Error("No workers available"));
      }

      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error("Worker timeout"));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timeout });
      worker.postMessage({ ...task, id });
    });
  }

  _getNextWorker() {
    // Round-robin selection
    for (let i = 0; i < this.poolSize; i++) {
      const idx = (this._nextWorker + i) % this.poolSize;
      if (this._workers[idx]) {
        this._nextWorker = (idx + 1) % this.poolSize;
        return this._workers[idx];
      }
    }
    return null;
  }

  /**
   * Stop the worker pool and terminate all workers
   */
  stop() {
    this._started = false;

    // Reject all pending requests
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WorkerPool stopped"));
    }
    this._pending.clear();

    // Terminate all workers
    for (const worker of this._workers) {
      if (worker) {
        try { worker.terminate(); } catch (e) {}
      }
    }
    this._workers = [];
    this._log("Stopped");
  }

  getStats() {
    return {
      available: this._available,
      started: this._started,
      workers: this._workers.filter(w => w !== null).length,
      pendingRequests: this._pending.size,
    };
  }
}
