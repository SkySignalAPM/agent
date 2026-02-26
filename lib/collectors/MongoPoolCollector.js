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
      configCaptured: false, // Track if we've captured pool config
      connections: new Map(), // connectionId -> { created: timestamp }
      peakConnections: 0, // Track peak connection count
      totalCheckouts: 0, // Track total checkout operations
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

  /**
   * Get MongoClient from various access paths (Meteor driver versions vary)
   * @returns {Object|null} - MongoClient instance or null
   */
  _getMongoClient() {
    try {
      // Method 1: Use the provided client (if it's already a MongoClient)
      if (this.client && typeof this.client.on === 'function') {
        return this.client;
      }

      // Method 2: Access via MongoInternals
      const driver = MongoInternals?.defaultRemoteCollectionDriver?.();
      if (!driver || !driver.mongo) {
        return null;
      }

      const mongo = driver.mongo;

      // The mongo object is Meteor's MongoConnection wrapper
      // Try different paths to get the underlying MongoClient:

      // Path 1: mongo.db.client (MongoDB driver v4+)
      if (mongo.db && mongo.db.client) {
        return mongo.db.client;
      }

      // Path 2: mongo.client (if Meteor exposes it directly)
      if (mongo.client) {
        return mongo.client;
      }

      // Path 3: Access via db.s.client (internal structure)
      if (mongo.db && mongo.db.s && mongo.db.s.client) {
        return mongo.db.s.client;
      }

      // Path 4: Check if mongo itself has topology (older Meteor versions)
      if (mongo.topology) {
        return mongo;
      }

      return null;
    } catch (error) {
      this._warn('Error getting MongoClient:', error.message);
      return null;
    }
  }

  /**
   * Get topology from MongoClient with multiple fallback paths
   * @returns {Object|null} - Topology instance or null
   */
  _getTopology() {
    try {
      const mongoClient = this._getMongoClient();
      if (!mongoClient) {
        return null;
      }

      // Direct topology access (common in newer drivers)
      if (mongoClient.topology) {
        return mongoClient.topology;
      }

      // Via internal state
      if (mongoClient.s && mongoClient.s.topology) {
        return mongoClient.s.topology;
      }

      // Via db object's internal structure
      const driver = MongoInternals?.defaultRemoteCollectionDriver?.();
      if (driver && driver.mongo && driver.mongo.db) {
        const db = driver.mongo.db;
        if (db.s && db.s.topology) {
          return db.s.topology;
        }
      }

      return null;
    } catch (error) {
      this._warn('Error getting topology:', error.message);
      return null;
    }
  }

  /**
   * Capture pool configuration from existing MongoDB connection
   * Called at startup since connectionPoolCreated event already fired
   */
  _capturePoolConfigFromClient() {
    try {
      const topology = this._getTopology();
      if (!topology) {
        this._log('Could not access topology for pool config');
        return;
      }

      // Try to get pool options from topology's connection options
      // or from the topology's internal state
      let poolOptions = null;

      // Method 1: Via topology.s.options
      if (topology.s && topology.s.options) {
        poolOptions = topology.s.options;
      }

      // Method 2: Via topology.options
      if (!poolOptions && topology.options) {
        poolOptions = topology.options;
      }

      // Method 3: Via first server's pool
      if (!poolOptions) {
        const servers = this._getServers(topology);
        if (servers && servers.size > 0) {
          for (const [, server] of servers) {
            if (server.s && server.s.pool && server.s.pool.options) {
              poolOptions = server.s.pool.options;
              break;
            }
            // Alternative: pool.s.options
            if (server.pool && server.pool.s && server.pool.s.options) {
              poolOptions = server.pool.s.options;
              break;
            }
          }
        }
      }

      if (poolOptions) {
        this.poolState.config = {
          minPoolSize: poolOptions.minPoolSize ?? poolOptions.minSize ?? 0,
          maxPoolSize: poolOptions.maxPoolSize ?? poolOptions.maxSize ?? 100,
          maxIdleTimeMS: poolOptions.maxIdleTimeMS ?? null,
          waitQueueTimeoutMS: poolOptions.waitQueueTimeoutMS ?? null
        };
        this.poolState.configCaptured = true;
        this._log('Pool configuration captured from existing connection:', this.poolState.config);
      } else {
        // Fallback: try to get from MONGO_URL environment variable
        this._capturePoolConfigFromUrl();
      }
    } catch (error) {
      this._warn('Error capturing pool config from client:', error.message);
    }
  }

  /**
   * Fallback: Capture pool configuration from MONGO_URL environment variable
   */
  _capturePoolConfigFromUrl() {
    try {
      const mongoUrl = process.env.MONGO_URL;
      if (!mongoUrl) return;

      const url = new URL(mongoUrl);
      const params = url.searchParams;

      if (params.has('minPoolSize') || params.has('maxPoolSize')) {
        this.poolState.config = {
          minPoolSize: parseInt(params.get('minPoolSize')) || 0,
          maxPoolSize: parseInt(params.get('maxPoolSize')) || 100,
          maxIdleTimeMS: params.has('maxIdleTimeMS') ? parseInt(params.get('maxIdleTimeMS')) : null,
          waitQueueTimeoutMS: params.has('waitQueueTimeoutMS') ? parseInt(params.get('waitQueueTimeoutMS')) : null
        };
        this.poolState.configCaptured = true;
        this._log('Pool configuration captured from MONGO_URL:', this.poolState.config);
      }
    } catch (error) {
      // URL parsing might fail, ignore silently
      this._log('Could not parse MONGO_URL for pool config');
    }
  }

  /**
   * Capture existing connections from topology at startup
   * Since connectionCreated events already fired before we started
   */
  _captureExistingConnections() {
    try {
      const stats = this._getPoolStats();

      // If we found actual connections via topology, update our state
      if (stats.totalConnections > 0) {
        // Create synthetic connection entries for tracking
        // We don't have individual connectionIds, but we know the count
        this._log(`Captured ${stats.totalConnections} existing connections from topology`);

        // Update peak if needed
        if (stats.totalConnections > this.poolState.peakConnections) {
          this.poolState.peakConnections = stats.totalConnections;
        }
      }
    } catch (error) {
      this._warn('Error capturing existing connections:', error.message);
    }
  }

  /**
   * Get servers map from topology with multiple fallback paths
   * @param {Object} topology - MongoDB topology
   * @returns {Map|null} - Servers map or null
   */
  _getServers(topology) {
    if (!topology) return null;

    // Method 1: topology.s.servers (common structure)
    if (topology.s && topology.s.servers) {
      return topology.s.servers;
    }

    // Method 2: topology.servers
    if (topology.servers && typeof topology.servers.entries === 'function') {
      return topology.servers;
    }

    // Method 3: topology.description?.servers (for unified topology)
    if (topology.description && topology.description.servers) {
      return topology.description.servers;
    }

    return null;
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
      // Capture pool configuration from the existing connection
      // (connectionPoolCreated event already fired before we started)
      this._capturePoolConfigFromClient();

      // Track pool creation and configuration (for reconnections)
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

      // Track when connection is checked in (returned to pool)
      this.client.on('connectionCheckedIn', (event) => {
        this._onConnectionCheckedIn(event);
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

      // Collect initial snapshot after a short delay to let existing connections be tracked
      Meteor.defer(() => {
        this._captureExistingConnections();
        this._collectSnapshot();
      });

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
      this.client.removeAllListeners('connectionCheckedIn');
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

      if (event.connectionId != null) {
        this.poolState.connections.set(event.connectionId, {
          created: Date.now(),
          address: event.address,
          inUse: false
        });

        // Update peak connections
        const currentCount = this.poolState.connections.size;
        if (currentCount > this.poolState.peakConnections) {
          this.poolState.peakConnections = currentCount;
        }

        this._log(`Connection created: ${event.connectionId} (total: ${currentCount})`);
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

      if (event.connectionId != null) {
        this.poolState.connections.delete(event.connectionId);
        this._log(`Connection closed: ${event.connectionId} (reason: ${event.reason || 'unknown'}, total: ${this.poolState.connections.size})`);
      }
    } catch (error) {
      this._warn('Error in connectionClosed:', error);
    }
  }

  /**
   * Handle connection checked in event
   * Mark connection as available
   */
  _onConnectionCheckedIn(event) {
    try {
      if (!event) return;

      if (event.connectionId != null) {
        const conn = this.poolState.connections.get(event.connectionId);
        if (conn) {
          conn.inUse = false;
        }
      }
    } catch (error) {
      this._warn('Error in connectionCheckedIn:', error);
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

      // Mark connection as in use
      if (event.connectionId != null) {
        const conn = this.poolState.connections.get(event.connectionId);
        if (conn) {
          conn.inUse = true;
        }
      }

      // Increment total checkouts counter
      this.poolState.totalCheckouts++;

      // Get queue for this address
      const queue = this.checkoutTimes.get(address);

      if (!queue || queue.length === 0) {
        // No pending checkout for this address - may have been started before we began monitoring
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
      this._warn('Error in checkedOut:', error);
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

      // Keep only recent samples — batch eviction instead of per-item shift() which is O(n)
      if (global._skySignalPoolWaitTimes.length > 1100) {
        global._skySignalPoolWaitTimes.splice(0, global._skySignalPoolWaitTimes.length - 1000);
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

      // Update peak connections if current is higher
      if (poolStats.totalConnections > this.poolState.peakConnections) {
        this.poolState.peakConnections = poolStats.totalConnections;
      }

      // Calculate pool utilization percentage
      const maxPoolSize = this.poolState.config.maxPoolSize || 100;
      const poolUtilization = maxPoolSize > 0
        ? Math.round((poolStats.inUseConnections / maxPoolSize) * 100)
        : 0;

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
        configCaptured: this.poolState.configCaptured,

        // Pool Statistics
        totalConnections: poolStats.totalConnections,
        availableConnections: poolStats.availableConnections,
        inUseConnections: poolStats.inUseConnections,
        checkoutQueueLength: poolStats.checkoutQueueLength,

        // Peak and utilization metrics
        peakConnections: this.poolState.peakConnections,
        poolUtilization: poolUtilization,
        totalCheckouts: this.poolState.totalCheckouts,

        // Performance Metrics
        avgCheckoutTime: checkoutMetrics.avgCheckoutTime,
        maxCheckoutTime: checkoutMetrics.maxCheckoutTime,
        p95CheckoutTime: checkoutMetrics.p95CheckoutTime,

        // Memory Metrics
        avgConnectionMemory: memoryMetrics.avgConnectionMemory,
        totalPoolMemory: memoryMetrics.totalPoolMemory,

        // Error Metrics
        checkoutTimeouts: this.poolState.errors.checkoutTimeouts,
        connectionErrors: this.poolState.errors.connectionErrors,

        // Data source info (for debugging)
        dataSource: poolStats.totalConnections > 0 && this.poolState.connections.size === 0
          ? 'topology'
          : (this.poolState.connections.size > 0 ? 'events' : 'none')
      };

      this._log(`Snapshot collected: ${poolStats.totalConnections} total, ${poolStats.inUseConnections} in-use, ${poolUtilization}% utilization`);

      // Send to client for batching
      this.skySignalClient.addMongoPoolMetric(metric);

    } catch (error) {
      this._warn('Error collecting snapshot:', error.message);
    }
  }

  /**
   * Get current pool statistics from MongoDB driver
   * Uses multiple strategies to access pool data across different driver versions
   */
  _getPoolStats() {
    try {
      const topology = this._getTopology();

      if (!topology) {
        // Fallback to event-based tracking
        return this._getPoolStatsFromEvents();
      }

      const servers = this._getServers(topology);

      if (!servers || servers.size === 0) {
        // Try alternative: single server topology
        return this._getPoolStatsFromSingleServer(topology);
      }

      // Aggregate stats from all servers in the topology
      let totalConnections = 0;
      let availableConnections = 0;
      let checkoutQueueLength = 0;
      let foundStats = false;

      for (const [, server] of servers) {
        const poolStats = this._extractPoolStatsFromServer(server);
        if (poolStats.found) {
          totalConnections += poolStats.totalConnections;
          availableConnections += poolStats.availableConnections;
          checkoutQueueLength += poolStats.checkoutQueueLength;
          foundStats = true;
        }
      }

      if (!foundStats) {
        // Fallback to event-based tracking
        return this._getPoolStatsFromEvents();
      }

      return {
        totalConnections,
        availableConnections,
        inUseConnections: totalConnections - availableConnections,
        checkoutQueueLength
      };

    } catch (error) {
      this._warn('Error getting pool stats:', error.message);

      // Fallback to event-based tracking
      return this._getPoolStatsFromEvents();
    }
  }

  /**
   * Extract pool statistics from a server object
   * Handles different MongoDB driver versions
   * @param {Object} server - Server object
   * @returns {Object} - Pool stats with found flag
   */
  _extractPoolStatsFromServer(server) {
    const result = {
      found: false,
      totalConnections: 0,
      availableConnections: 0,
      checkoutQueueLength: 0
    };

    if (!server) return result;

    // Try different paths to access pool stats

    // Path 1: server.s.pool (common in driver v5+)
    const pool = server.s?.pool || server.pool;
    if (pool) {
      // Try different property names across versions
      const total = pool.totalConnectionCount
        ?? pool.size
        ?? pool.connections?.size
        ?? 0;

      const available = pool.availableConnectionCount
        ?? pool.available
        ?? pool.availableConnections
        ?? 0;

      const queueLength = pool.waitQueueSize
        ?? pool.pendingConnectionCount
        ?? pool.waitQueue?.length
        ?? 0;

      if (total > 0 || available > 0 || queueLength > 0) {
        result.found = true;
        result.totalConnections = total;
        result.availableConnections = available;
        result.checkoutQueueLength = queueLength;
        return result;
      }

      // Try pool.s for internal state (older drivers)
      if (pool.s) {
        const s = pool.s;
        const sTotal = s.totalConnectionCount ?? s.size ?? 0;
        const sAvailable = s.availableConnectionCount ?? s.available ?? 0;
        const sQueue = s.waitQueueSize ?? 0;

        if (sTotal > 0 || sAvailable > 0 || sQueue > 0) {
          result.found = true;
          result.totalConnections = sTotal;
          result.availableConnections = sAvailable;
          result.checkoutQueueLength = sQueue;
          return result;
        }
      }
    }

    return result;
  }

  /**
   * Get pool stats for single-server topology (standalone MongoDB)
   * @param {Object} topology - Topology object
   * @returns {Object} - Pool statistics
   */
  _getPoolStatsFromSingleServer(topology) {
    try {
      // Try to access pool directly on topology
      const pool = topology.s?.pool
        ?? topology.pool
        ?? topology.connectionPool;

      if (pool) {
        const stats = this._extractPoolStatsFromServer({ pool });
        if (stats.found) {
          return {
            totalConnections: stats.totalConnections,
            availableConnections: stats.availableConnections,
            inUseConnections: stats.totalConnections - stats.availableConnections,
            checkoutQueueLength: stats.checkoutQueueLength
          };
        }
      }
    } catch (error) {
      this._log('Error getting single server stats:', error.message);
    }

    return this._getPoolStatsFromEvents();
  }

  /**
   * Fallback: Get pool statistics from event-based tracking
   * @returns {Object} - Pool statistics from tracked events
   */
  _getPoolStatsFromEvents() {
    const connections = this.poolState.connections;

    // Count in-use connections from our tracking
    let inUseCount = 0;
    for (const [, conn] of connections) {
      if (conn.inUse) {
        inUseCount++;
      }
    }

    const totalConnections = connections.size;
    const availableConnections = totalConnections - inUseCount;

    // Queue length from pending checkouts
    let queueLength = 0;
    for (const [, queue] of this.checkoutTimes) {
      queueLength += queue.length;
    }

    return {
      totalConnections,
      availableConnections,
      inUseConnections: inUseCount,
      checkoutQueueLength: queueLength
    };
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
    const poolStats = this._getPoolStats();

    return {
      poolState: {
        config: this.poolState.config,
        configCaptured: this.poolState.configCaptured,
        trackedConnections: this.poolState.connections.size,
        peakConnections: this.poolState.peakConnections,
        totalCheckouts: this.poolState.totalCheckouts,
        sampleCount: this.poolState.checkoutSampleCount
      },
      currentStats: poolStats,
      performance: checkoutMetrics,
      errors: this.poolState.errors,
      status: {
        started: this.started,
        enabled: this.enabled,
        hasClient: !!this.client,
        hasSkySignalClient: !!this.skySignalClient,
        hasTopology: !!this._getTopology()
      }
    };
  }
}
