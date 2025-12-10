import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';

/**
 * MongoPoolCollector
 *
 * Comprehensive MongoDB connection pool monitoring:
 * 1. Event-based tracking: Connection checkout wait times
 * 2. Periodic snapshots: Pool state, configuration, performance metrics
 *
 * Monitors:
 * - Pool configuration (min/max size, timeouts)
 * - Connection counts (total, available, in-use, queue length)
 * - Checkout performance (avg, max, P95 times)
 * - Memory usage (total pool, per-connection estimates)
 * - Errors (timeouts, connection failures)
 */
export default class MongoPoolCollector {
  constructor(options = {}) {
    this.client = options.client;
    this.skySignalClient = options.skySignalClient; // Client for sending metrics
    this.host = options.host || 'unknown';
    this.appVersion = options.appVersion || 'unknown';
    this.buildHash = options.buildHash || null;
    this.enabled = options.enabled !== false;
    this.debug = options.debug || false; // Debug mode for verbose logging

    // Configuration
    this.snapshotInterval = options.snapshotInterval || 60000; // Default: 60s
    this.fixedConnectionMemory = options.fixedConnectionMemory; // Optional: fixed MB per connection

    // Track checkout start times by address (for wait time calculation)
    this.checkoutTimes = new Map();

    // Pool state tracking
    this.poolState = {
      config: {
        minPoolSize: 0,
        maxPoolSize: 100,
        maxIdleTimeMS: null,
        waitQueueTimeoutMS: null
      },
      connections: new Map(), // connectionId -> { created: timestamp }
      // Circular buffer for checkout samples (fixed size, O(1) add)
      checkoutSamples: new Array(1000),
      checkoutSampleIndex: 0,
      checkoutSampleCount: 0,
      errors: {
        checkoutTimeouts: 0,
        connectionErrors: 0
      }
    };

    // Timers
    this.snapshotTimer = null;
    this.started = false;
  }

  /** Debug logging helper */
  _log(...args) {
    if (this.debug) {
      console.log('[SkySignal:MongoPool]', ...args);
    }
  }

  /** Warning logging helper */
  _warn(...args) {
    console.warn('[SkySignal:MongoPool]', ...args);
  }

  start() {
    if (!this.enabled || this.started) {
      return;
    }

    if (!this.client) {
      this._warn('No MongoDB client provided');
      return;
    }

    try {
      // Track pool creation and configuration
      this.client.on('connectionPoolCreated', (event) => {
        this._onPoolCreated(event);
      });

      // Track connection lifecycle
      this.client.on('connectionCreated', (event) => {
        this._onConnectionCreated(event);
      });

      this.client.on('connectionClosed', (event) => {
        this._onConnectionClosed(event);
      });

      // Track when connection checkout starts (wait begins)
      this.client.on('connectionCheckOutStarted', (event) => {
        this._onCheckoutStarted(event);
      });

      // Track when connection is successfully checked out (wait ends)
      this.client.on('connectionCheckedOut', (event) => {
        this._onConnectionCheckedOut(event);
      });

      // Track checkout failures (timeouts, errors)
      this.client.on('connectionCheckOutFailed', (event) => {
        this._onCheckoutFailed(event);
      });

      // Start periodic snapshot collection
      this.snapshotTimer = setInterval(() => {
        this._collectSnapshot();
      }, this.snapshotInterval);

      // Collect initial snapshot
      Meteor.defer(() => this._collectSnapshot());

      this.started = true;
      this._log(`Started (snapshot interval: ${this.snapshotInterval}ms)`);
    } catch (error) {
      this._warn('Failed to start:', error.message);
    }
  }

  stop() {
    if (!this.started) {
      return;
    }

    // Stop periodic snapshots
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    // Remove all event listeners
    if (this.client) {
      this.client.removeAllListeners('connectionPoolCreated');
      this.client.removeAllListeners('connectionCreated');
      this.client.removeAllListeners('connectionClosed');
      this.client.removeAllListeners('connectionCheckOutStarted');
      this.client.removeAllListeners('connectionCheckedOut');
      this.client.removeAllListeners('connectionCheckOutFailed');
    }

    // Clear state
    this.checkoutTimes.clear();
    this.poolState.connections.clear();
    // Reset circular buffer
    this.poolState.checkoutSamples = new Array(1000);
    this.poolState.checkoutSampleIndex = 0;
    this.poolState.checkoutSampleCount = 0;

    this.started = false;
    this._log('Stopped');
  }

  /**
   * Handle connection pool created event
   * Capture pool configuration
   */
  _onPoolCreated(event) {
    try {
      if (!event) return;

      const options = event.options || {};

      this.poolState.config = {
        minPoolSize: options.minPoolSize || 0,
        maxPoolSize: options.maxPoolSize || 100,
        maxIdleTimeMS: options.maxIdleTimeMS || null,
        waitQueueTimeoutMS: options.waitQueueTimeoutMS || null
      };

      this._log('Pool configuration captured');
    } catch (error) {
      this._warn('Error in poolCreated:', error);
    }
  }

  /**
   * Handle connection created event
   * Track active connections
   */
  _onConnectionCreated(event) {
    try {
      if (!event) return;

      if (event.connectionId) {
        this.poolState.connections.set(event.connectionId, {
          created: Date.now(),
          address: event.address
        });
      }
    } catch (error) {
      this._warn('Error in connectionCreated:', error);
    }
  }

  /**
   * Handle connection closed event
   * Remove from tracking
   */
  _onConnectionClosed(event) {
    try {
      if (!event) return;

      if (event.connectionId) {
        this.poolState.connections.delete(event.connectionId);
      }
    } catch (error) {
      this._warn('Error in connectionClosed:', error);
    }
  }

  /**
   * Handle connection checkout start event
   */
  _onCheckoutStarted(event) {
    try {
      if (!event) return;

      const address = event.address || 'unknown';

      // Initialize queue for this address if needed
      if (!this.checkoutTimes.has(address)) {
        this.checkoutTimes.set(address, []);
      }

      // Add checkout start to queue for this address (FIFO)
      const queue = this.checkoutTimes.get(address);

      // Limit queue size to prevent unbounded growth (drop oldest if exceeded)
      const MAX_QUEUE_SIZE = 500;
      if (queue.length >= MAX_QUEUE_SIZE) {
        queue.shift(); // Remove oldest entry
      }

      queue.push({
        startTime: Date.now(),
        address: event.address,
        timestamp: event.time || new Date()
      });

    } catch (error) {
      this._warn('Error in checkoutStarted:', error);
    }
  }

  /**
   * Handle successful connection checkout event
   */
  _onConnectionCheckedOut(event) {
    try {
      if (!event) return;

      const address = event.address || 'unknown';

      // Get queue for this address
      const queue = this.checkoutTimes.get(address);

      if (!queue || queue.length === 0) {
        // No pending checkout for this address
        return;
      }

      // Get first checkout from queue (FIFO)
      const checkout = queue.shift();

      // Calculate wait time
      const waitTime = Date.now() - checkout.startTime;

      // Store checkout sample in circular buffer (O(1) operation)
      this.poolState.checkoutSamples[this.poolState.checkoutSampleIndex] = waitTime;
      this.poolState.checkoutSampleIndex = (this.poolState.checkoutSampleIndex + 1) % 1000;
      if (this.poolState.checkoutSampleCount < 1000) {
        this.poolState.checkoutSampleCount++;
      }

      // Record wait time in current trace context
      this._recordPoolWaitTime(waitTime, {
        connectionId: event.connectionId,
        address: event.address
      });

    } catch (error) {
      this._warn(' Error in checkedOut:', error);
    }
  }

  /**
   * Handle checkout failure event
   */
  _onCheckoutFailed(event) {
    try {
      if (!event) return;

      const address = event.address || 'unknown';

      // Get queue for this address
      const queue = this.checkoutTimes.get(address);

      if (!queue || queue.length === 0) {
        // No pending checkout for this address
        return;
      }

      // Get first checkout from queue (FIFO)
      const checkout = queue.shift();

      const waitTime = Date.now() - checkout.startTime;

      // Track error type
      if (event.reason === 'timeout' || event.reason === 'connectionError') {
        this.poolState.errors.checkoutTimeouts++;
      } else {
        this.poolState.errors.connectionErrors++;
      }

      // Record failed checkout in trace
      this._recordPoolWaitTime(waitTime, {
        failed: true,
        reason: event.reason,
        address: event.address
      });

    } catch (error) {
      this._warn(' Error in checkoutFailed:', error);
    }
  }

  /**
   * Store pool wait time for later retrieval by MethodTracer
   * We can't write to context yet because we don't know which session this belongs to
   * Instead, we accumulate pool wait times globally and let MethodTracer aggregate them
   */
  _recordPoolWaitTime(waitTime, metadata = {}) {
    try {
      // Initialize global storage for pool wait times
      if (!global._skySignalPoolWaitTimes) {
        global._skySignalPoolWaitTimes = [];
      }

      // Store pool wait sample with timestamp
      // MethodTracer will pick up samples that occurred during method execution
      global._skySignalPoolWaitTimes.push({
        waitTime,
        timestamp: Date.now(),
        ...metadata
      });

      // Keep only recent samples (last 1000)
      if (global._skySignalPoolWaitTimes.length > 1000) {
        global._skySignalPoolWaitTimes.shift();
      }

    } catch (error) {
      this._warn(' Error recording pool wait time:', error);
    }
  }

  /**
   * Collect periodic snapshot of pool state
   * Sends comprehensive metrics to SkySignalClient
   */
  _collectSnapshot() {
    try {
      if (!this.skySignalClient) {
        return; // No client to send to
      }

      // Gather all metrics
      const poolStats = this._getPoolStats();
      const checkoutMetrics = this._calculateCheckoutMetrics();
      const memoryMetrics = this._estimateMemoryUsage(poolStats.totalConnections);

      // Build complete metric document
      const metric = {
        timestamp: new Date(),
        host: this.host,
        appVersion: this.appVersion,
        buildHash: this.buildHash,

        // Pool Configuration
        minPoolSize: this.poolState.config.minPoolSize,
        maxPoolSize: this.poolState.config.maxPoolSize,
        maxIdleTimeMS: this.poolState.config.maxIdleTimeMS,
        waitQueueTimeoutMS: this.poolState.config.waitQueueTimeoutMS,

        // Pool Statistics
        totalConnections: poolStats.totalConnections,
        availableConnections: poolStats.availableConnections,
        inUseConnections: poolStats.inUseConnections,
        checkoutQueueLength: poolStats.checkoutQueueLength,

        // Performance Metrics
        avgCheckoutTime: checkoutMetrics.avgCheckoutTime,
        maxCheckoutTime: checkoutMetrics.maxCheckoutTime,
        p95CheckoutTime: checkoutMetrics.p95CheckoutTime,

        // Memory Metrics
        avgConnectionMemory: memoryMetrics.avgConnectionMemory,
        totalPoolMemory: memoryMetrics.totalPoolMemory,

        // Error Metrics
        checkoutTimeouts: this.poolState.errors.checkoutTimeouts,
        connectionErrors: this.poolState.errors.connectionErrors
      };

      // Send to client for batching
      this.skySignalClient.addMongoPoolMetric(metric);

    } catch (error) {
      this._warn(' Error collecting snapshot:', error);
    }
  }

  /**
   * Get current pool statistics from MongoDB driver
   * Accesses driver internals (stable API in driver v4+)
   */
  _getPoolStats() {
    try {
      // Try to access MongoDB driver internals
      const mongoClient = MongoInternals?.defaultRemoteCollectionDriver?.()?.mongo?.client;

      if (!mongoClient || !mongoClient.topology) {
        // Fallback to event-based tracking
        return {
          totalConnections: this.poolState.connections.size,
          availableConnections: 0,
          inUseConnections: 0,
          checkoutQueueLength: 0
        };
      }

      // Access connection pool via topology
      const topology = mongoClient.topology;
      const servers = topology.s?.servers;

      if (!servers || servers.size === 0) {
        return {
          totalConnections: 0,
          availableConnections: 0,
          inUseConnections: 0,
          checkoutQueueLength: 0
        };
      }

      // Aggregate stats from all servers in the topology
      let totalConnections = 0;
      let availableConnections = 0;
      let checkoutQueueLength = 0;

      for (const [, server] of servers) {
        const pool = server.s?.pool;
        if (pool) {
          totalConnections += pool.totalConnectionCount || 0;
          availableConnections += pool.availableConnectionCount || 0;
          checkoutQueueLength += pool.waitQueueSize || 0;
        }
      }

      return {
        totalConnections,
        availableConnections,
        inUseConnections: totalConnections - availableConnections,
        checkoutQueueLength
      };

    } catch (error) {
      this._warn(' Error getting pool stats:', error);

      // Fallback to event-based tracking
      return {
        totalConnections: this.poolState.connections.size,
        availableConnections: 0,
        inUseConnections: 0,
        checkoutQueueLength: 0
      };
    }
  }

  /**
   * Calculate checkout performance metrics from circular buffer samples
   */
  _calculateCheckoutMetrics() {
    const count = this.poolState.checkoutSampleCount;

    if (count === 0) {
      return {
        avgCheckoutTime: 0,
        maxCheckoutTime: 0,
        p95CheckoutTime: 0
      };
    }

    // Extract valid samples from circular buffer
    const samples = this.poolState.checkoutSamples.slice(0, count);

    // Calculate average
    let sum = 0;
    let maxCheckoutTime = 0;
    for (let i = 0; i < count; i++) {
      const val = samples[i];
      sum += val;
      if (val > maxCheckoutTime) maxCheckoutTime = val;
    }
    const avgCheckoutTime = Math.round(sum / count);

    // Calculate P95 (95th percentile) - only sort when needed
    const sorted = samples.slice().sort((a, b) => a - b);
    const p95Index = Math.floor(count * 0.95);
    const p95CheckoutTime = sorted[p95Index] || 0;

    return {
      avgCheckoutTime,
      maxCheckoutTime,
      p95CheckoutTime
    };
  }

  /**
   * Estimate memory usage of connection pool
   * Uses configured fixed value or estimates based on process memory
   */
  _estimateMemoryUsage(connectionCount) {
    if (connectionCount === 0) {
      return {
        avgConnectionMemory: 0,
        totalPoolMemory: 0
      };
    }

    let avgConnectionMemory;

    // Use fixed value if configured
    if (this.fixedConnectionMemory) {
      avgConnectionMemory = this.fixedConnectionMemory;
    } else {
      // Estimate based on process memory usage
      // Rough estimate: ~1-2 MB per connection (conservative)
      try {
        const memUsage = process.memoryUsage();
        // Assume 10% of heap is MongoDB connection overhead
        const estimatedPoolMemory = memUsage.heapUsed * 0.1;
        avgConnectionMemory = Math.round(estimatedPoolMemory / connectionCount);
      } catch (error) {
        // Default estimate: 1 MB per connection
        avgConnectionMemory = 1024 * 1024;
      }
    }

    return {
      avgConnectionMemory,
      totalPoolMemory: avgConnectionMemory * connectionCount
    };
  }

  /**
   * Get collector metrics (for debugging)
   */
  getMetrics() {
    const checkoutMetrics = this._calculateCheckoutMetrics();

    return {
      poolState: {
        config: this.poolState.config,
        activeConnections: this.poolState.connections.size,
        sampleCount: this.poolState.checkoutSampleCount
      },
      performance: checkoutMetrics,
      errors: this.poolState.errors
    };
  }
}
