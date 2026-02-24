import { Meteor } from "meteor/meteor";
import { fetch } from "meteor/fetch";
import http from "http";
import https from "https";
import zlib from "zlib";
import { promisify } from "util";
import { estimateObjectSize } from "./sizeEstimator.js";

// Promisify gzip for async compression
const gzipAsync = promisify(zlib.gzip);

// Compression threshold (compress payloads larger than 1KB)
const COMPRESSION_THRESHOLD = 1024;

// Connection pooling agents (keepAlive reduces TCP handshake overhead)
const httpAgent = new http.Agent({
	keepAlive: true,
	keepAliveMsecs: 30000, // 30 seconds
	maxSockets: 5,         // Max connections per host
	maxFreeSockets: 2,     // Free sockets to keep
	freeSocketTimeout: 15000 // Discard idle sockets after 15s to avoid stale socket reuse (#4)
});

const httpsAgent = new https.Agent({
	keepAlive: true,
	keepAliveMsecs: 30000,
	maxSockets: 5,
	maxFreeSockets: 2,
	freeSocketTimeout: 15000
});

/**
 * SkySignalClient - High-performance HTTP client for the SkySignal API.
 *
 * This client is used internally by the SkySignal Agent to send telemetry data
 * to the SkySignal dashboard. It implements several performance optimizations
 * to minimize impact on your application.
 *
 * **Performance Optimizations:**
 * - Fire-and-forget HTTP requests (non-blocking, no await in hot path)
 * - Intelligent batching by count and size (256KB default)
 * - Configurable sampling rates for high-volume data
 * - Exponential backoff with jitter for retries
 * - O(1) incremental size tracking
 *
 * **Batching Behavior:**
 * Data is automatically batched and sent when any of these conditions are met:
 * 1. Batch reaches `batchSize` items (default: 50)
 * 2. Batch reaches `batchSizeBytes` (default: 256KB)
 * 3. `flushInterval` timer fires (default: 10 seconds)
 *
 * @class SkySignalClient
 * @property {string} apiKey - API key for authentication
 * @property {string} endpoint - SkySignal API endpoint URL
 * @property {number} batchSize - Maximum items per batch
 * @property {number} batchSizeBytes - Maximum bytes per batch
 * @property {number} flushInterval - Auto-flush interval in milliseconds
 * @property {Object} stats - Performance statistics (sent, failed, sampled, bytesSent)
 * @property {boolean} stopped - Whether the client has been stopped
 */
export default class SkySignalClient {
	/**
	 * Create a new SkySignalClient instance.
	 *
	 * @param {Object} [options={}] - Client configuration
	 * @param {string} options.apiKey - SkySignal API key (required)
	 * @param {string} [options.endpoint="https://dash.skysignal.app"] - API endpoint URL
	 * @param {number} [options.batchSize=50] - Maximum items per batch before sending
	 * @param {number} [options.batchSizeBytes=262144] - Maximum batch size in bytes (256KB)
	 * @param {number} [options.flushInterval=10000] - Auto-flush interval in milliseconds
	 * @param {number} [options.requestTimeout=15000] - HTTP request timeout in milliseconds
	 * @param {number} [options.maxRetries=3] - Maximum retry attempts for failed requests
	 * @param {number} [options.traceSampleRate=1.0] - Sampling rate for traces (0.0 to 1.0)
	 * @param {number} [options.rumSampleRate=0.5] - Sampling rate for RUM data (0.0 to 1.0)
	 */
	constructor(options = {}) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint || "https://dash.skysignal.app";
		this.batchSize = options.batchSize || 50;
		this.batchSizeBytes = options.batchSizeBytes || 256 * 1024; // 256KB
		this.flushInterval = options.flushInterval || 10000;
		this.requestTimeout = options.requestTimeout || 15000;
		this.maxRetries = options.maxRetries || 3;

		// Sampling rates
		this.traceSampleRate = options.traceSampleRate ?? 1.0;
		this.rumSampleRate = options.rumSampleRate ?? 0.5;

		// Batches for different data types
		this.batches = {
			traces: [],
			systemMetrics: [],
			httpRequests: [],
			customMetrics: [],
			errors: [],
			sessions: [],
			securityEvents: [],
			jobs: [],
			alerts: [],
			dependencies: [],
			mongoPoolMetrics: [],
			collectionStats: [],
			ddpConnections: [],
			subscriptions: [],
			liveQueries: [],
			rum: [],
			logs: [],
			dnsMetrics: [],
			outboundHttp: [],
			cpuProfiles: [],
			deprecatedApis: [],
			publications: [],
			environment: [],
			vulnerabilities: []
		};

		// Track batch sizes incrementally (O(1) add instead of O(n))
		this.batchSizes = {};
		Object.keys(this.batches).forEach(key => {
			this.batchSizes[key] = 0;
		});

		// Retry queues (failed batches)
		this.retryQueues = {};
		Object.keys(this.batches).forEach(key => {
			this.retryQueues[key] = [];
		});

		// Performance tracking
		this.stats = {
			sent: 0,
			failed: 0,
			sampled: 0,
			bytesSent: 0
		};

		// Track pending timers for cleanup on stop()
		this.pendingTimers = new Set();

		// Flag to prevent new timers after stop
		this.stopped = false;

		// Reusable WeakSet for _safeStringify (avoids GC pressure)
		this._stringifySeenSet = new WeakSet();

		// Select agent based on endpoint protocol
		this._agent = this.endpoint.startsWith("https") ? httpsAgent : httpAgent;

		// Start auto-flush interval using setTimeout (not setInterval for better control)
		this._scheduleFlush();
	}

	/**
	 * Add a Meteor Method execution trace to the batch.
	 *
	 * Traces are subject to sampling based on `traceSampleRate`.
	 * If the trace is sampled out, `stats.sampled` is incremented.
	 *
	 * @param {Object} trace - Method execution trace data
	 * @param {string} trace.methodName - Name of the Meteor Method
	 * @param {number} trace.duration - Total execution time in milliseconds
	 * @param {Date} trace.timestamp - When the method was called
	 * @param {string} [trace.userId] - User ID if authenticated
	 * @param {Object} [trace.args] - Sanitized method arguments
	 * @param {Object} [trace.timeline] - Execution timeline breakdown
	 * @param {Object} [trace.indexUsage] - MongoDB explain() results
	 * @returns {void}
	 */
	addTrace(trace) {
		// Sampling: only capture based on sample rate
		if (Math.random() > this.traceSampleRate) {
			this.stats.sampled++;
			return;
		}

		this._addToBatch("traces", trace, "/api/v1/traces");
	}

	/**
	 * Add a system metric snapshot to the batch.
	 *
	 * System metrics are not sampled (low volume, always important).
	 *
	 * @param {Object} metric - System metrics snapshot
	 * @param {Date} metric.timestamp - Measurement timestamp
	 * @param {string} metric.host - Server hostname
	 * @param {number} metric.cpuUsage - CPU usage percentage (0-100)
	 * @param {number} metric.memoryUsage - Memory usage percentage (0-100)
	 * @param {number} metric.memoryUsed - Memory used in bytes
	 * @param {number} metric.memoryTotal - Total memory in bytes
	 * @param {Object} metric.loadAverage - Load averages {1m, 5m, 15m}
	 * @param {number} [metric.eventLoopLag] - Event loop lag in milliseconds
	 * @param {number} [metric.diskUsage] - Disk usage percentage
	 * @param {Object} [metric.processMemory] - Process memory {rss, heapTotal, heapUsed}
	 * @returns {void}
	 */
	addSystemMetric(metric) {
		this._addToBatch("systemMetrics", metric, "/api/v1/metrics/system");
	}

	/**
	 * Add MongoDB connection pool metrics to the batch.
	 *
	 * Pool metrics are not sampled (low volume, important for diagnostics).
	 *
	 * @param {Object} metric - Connection pool metrics
	 * @param {Date} metric.timestamp - Measurement timestamp
	 * @param {string} metric.host - Server hostname
	 * @param {number} metric.totalConnections - Total connections in pool
	 * @param {number} metric.availableConnections - Available connections
	 * @param {number} metric.pendingConnections - Pending connection requests
	 * @param {number} [metric.checkoutWaitTimeMs] - Average checkout wait time
	 * @param {number} [metric.estimatedMemoryBytes] - Estimated memory usage
	 * @returns {void}
	 */
	addMongoPoolMetric(metric) {
		this._addToBatch("mongoPoolMetrics", metric, "/api/v1/metrics/mongopool");
	}

	/**
	 * Add MongoDB collection statistics to the batch.
	 *
	 * Collection stats are not sampled (low volume, collected infrequently).
	 *
	 * @param {Object} stats - Collection statistics
	 * @param {Date} stats.timestamp - Measurement timestamp
	 * @param {string} stats.host - Server hostname
	 * @param {string} stats.database - Database name
	 * @param {string} stats.collection - Collection name
	 * @param {number} stats.documentCount - Number of documents
	 * @param {number} stats.storageSize - Storage size in bytes
	 * @param {number} stats.indexSize - Total index size in bytes
	 * @param {number} stats.avgDocumentSize - Average document size in bytes
	 * @returns {void}
	 */
	addCollectionStats(stats) {
		this._addToBatch("collectionStats", stats, "/api/v1/metrics/collectionstats");
	}

	/**
	 * Add an HTTP request metric to the batch.
	 *
	 * HTTP requests may be sampled based on `httpSampleRate` in the collector.
	 *
	 * @param {Object} request - HTTP request metrics
	 * @param {Date} request.timestamp - Request timestamp
	 * @param {string} request.method - HTTP method (GET, POST, etc.)
	 * @param {string} request.path - Request path
	 * @param {string} [request.route] - Matched route pattern
	 * @param {number} request.statusCode - Response status code
	 * @param {number} request.responseTime - Response time in milliseconds
	 * @param {number} [request.size] - Response size in bytes
	 * @param {string} [request.userId] - User ID if authenticated
	 * @param {string} [request.ip] - Client IP address
	 * @param {string} [request.userAgent] - Client user agent
	 * @returns {void}
	 */
	addHttpRequest(request) {
		this._addToBatch("httpRequests", request, "/api/v1/metrics/http");
	}

	/**
	 * Add a custom business metric to the batch.
	 *
	 * Custom metrics are not sampled (user controls what to track).
	 *
	 * @param {Object} metric - Custom metric data
	 * @param {Date} metric.timestamp - Measurement timestamp
	 * @param {string} metric.name - Metric name (e.g., "orders.completed")
	 * @param {string} metric.metricType - Type: "counter", "timer", or "gauge"
	 * @param {number} metric.value - Metric value
	 * @param {string} [metric.unit] - Unit of measurement (e.g., "ms", "items")
	 * @param {Object} [metric.tags] - Key-value tags for filtering
	 * @param {string} [metric.host] - Server hostname
	 * @param {string} [metric.appVersion] - Application version
	 * @returns {void}
	 */
	addCustomMetric(metric) {
		this._addToBatch("customMetrics", metric, "/api/v1/metrics/custom");
	}

	/**
	 * Add an error to the batch.
	 *
	 * Errors are never sampled (all errors are important for debugging).
	 *
	 * @param {Object} error - Error data
	 * @param {Date} error.timestamp - When the error occurred
	 * @param {string} error.message - Error message
	 * @param {string} [error.stack] - Stack trace
	 * @param {string} [error.type] - Error type/class name
	 * @param {string} [error.context] - Where the error occurred (method name, etc.)
	 * @param {string} [error.userId] - User ID if authenticated
	 * @param {Object} [error.metadata] - Additional context data
	 * @returns {void}
	 */
	addError(error) {
		this._addToBatch("errors", error, "/api/v1/errors");
	}

	/**
	 * Add a log entry to the batch.
	 *
	 * Logs are not sampled at the client level (sampling is handled by LogsCollector).
	 *
	 * @param {Object} log - Log entry data
	 * @param {string} log.level - Log level: "debug", "info", "warn", "error", "fatal"
	 * @param {string} log.message - Log message text
	 * @param {string} log.source - Log source: "console", "meteor-log", or "api"
	 * @param {string} [log.methodName] - Meteor Method name (if captured within a method)
	 * @param {string} [log.traceId] - Trace ID for correlation
	 * @param {Object} [log.metadata] - Additional structured data
	 * @param {string} [log.host] - Server hostname
	 * @param {Date} [log.timestamp] - When the log was captured
	 * @returns {void}
	 */
	addLog(log) {
		this._addToBatch("logs", log, "/api/v1/logs");
	}

	/**
	 * Add a DNS timing metric to the batch.
	 * @param {Object} metric - DNS resolution timing data
	 */
	addDnsMetric(metric) {
		this._addToBatch("dnsMetrics", metric, "/api/v1/metrics/dns");
	}

	/**
	 * Add an outbound HTTP metric to the batch (from diagnostics_channel).
	 * @param {Object} metric - Outbound HTTP request aggregation data
	 */
	addOutboundHttpMetric(metric) {
		this._addToBatch("outboundHttp", metric, "/api/v1/metrics/outbound-http");
	}

	/**
	 * Add a CPU profile summary to the batch.
	 * @param {Object} profile - CPU profile summary with top functions
	 */
	addCpuProfile(profile) {
		this._addToBatch("cpuProfiles", profile, "/api/v1/metrics/cpu-profile");
	}

	/**
	 * Add a deprecated API usage metric to the batch.
	 * @param {Object} metric - Deprecated API usage data (sync vs async call counts)
	 */
	addDeprecatedApiMetric(metric) {
		this._addToBatch("deprecatedApis", metric, "/api/v1/metrics/deprecated-apis");
	}

	/**
	 * Add a publication efficiency metric to the batch.
	 * @param {Object} metric - Publication tracking data (projections, doc counts)
	 */
	addPublicationMetric(metric) {
		this._addToBatch("publications", metric, "/api/v1/metrics/publications");
	}

	/**
	 * Add an environment snapshot to the batch.
	 * @param {Object} metric - Environment metadata (packages, flags, OS info)
	 */
	addEnvironmentMetric(metric) {
		this._addToBatch("environment", metric, "/api/v1/metrics/environment");
	}

	/**
	 * Add a vulnerability scan result to the batch.
	 * @param {Object} metric - Vulnerability data (severity counts, package details)
	 */
	addVulnerabilityMetric(metric) {
		this._addToBatch("vulnerabilities", metric, "/api/v1/metrics/vulnerabilities");
	}

	/**
	 * Add a Real User Monitoring (RUM) measurement to the batch.
	 *
	 * RUM data is subject to sampling based on `rumSampleRate` (default 50%)
	 * due to high volume from client-side measurements.
	 *
	 * @param {Object} measurement - RUM measurement data
	 * @param {Date} measurement.timestamp - Measurement timestamp
	 * @param {string} measurement.sessionId - Client session ID
	 * @param {string} measurement.type - Measurement type (pageLoad, interaction, etc.)
	 * @param {number} [measurement.duration] - Duration in milliseconds
	 * @param {Object} [measurement.metrics] - Web vitals and performance metrics
	 * @param {Object} [measurement.browser] - Browser information
	 * @param {string} [measurement.url] - Page URL
	 * @returns {void}
	 */
	addRUM(measurement) {
		// Sampling: RUM has high volume
		if (Math.random() > this.rumSampleRate) {
			this.stats.sampled++;
			return;
		}

		this._addToBatch("rum", measurement, "/api/v1/rum");
	}

	/**
	 * Send an array of DDP connection snapshots to the batch.
	 *
	 * Called by DDPCollector which manages its own batching interval.
	 * Each connection in the array is added to the batch individually.
	 *
	 * @param {Array<Object>} connections - Array of DDP connection snapshots
	 * @param {string} connections[].sessionId - DDP session ID
	 * @param {Date} connections[].connectedAt - When the connection was established
	 * @param {string} [connections[].userId] - User ID if authenticated
	 * @param {string} [connections[].clientAddress] - Client IP address
	 * @param {number} [connections[].messageCount] - Number of messages sent/received
	 * @returns {void}
	 */
	sendDDPConnections(connections) {
		if (!Array.isArray(connections) || connections.length === 0) {
			return;
		}

		// Add all connections to batch
		connections.forEach(conn => {
			this._addToBatch("ddpConnections", conn, "/api/v1/ddp-connections");
		});
	}

	/**
	 * Send an array of DDP subscription snapshots to the batch.
	 *
	 * Called by DDPCollector which manages its own batching interval.
	 * Each subscription in the array is added to the batch individually.
	 *
	 * @param {Array<Object>} subscriptions - Array of subscription snapshots
	 * @param {string} subscriptions[].name - Publication name
	 * @param {string} subscriptions[].sessionId - DDP session ID
	 * @param {Date} subscriptions[].subscribedAt - When the subscription was created
	 * @param {number} [subscriptions[].documentCount] - Number of documents published
	 * @param {Array} [subscriptions[].params] - Subscription parameters
	 * @returns {void}
	 */
	sendSubscriptions(subscriptions) {
		if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
			return;
		}

		// Add all subscriptions to batch
		subscriptions.forEach(sub => {
			this._addToBatch("subscriptions", sub, "/api/v1/subscriptions");
		});
	}

	/**
	 * Send an array of live query observer snapshots to the batch.
	 *
	 * Called by LiveQueriesCollector which manages its own batching interval.
	 * Each live query in the array is added to the batch individually.
	 *
	 * @param {Array<Object>} liveQueries - Array of live query snapshots
	 * @param {string} liveQueries[].collection - Collection name being observed
	 * @param {string} liveQueries[].type - Observer type: "oplog" or "polling"
	 * @param {number} liveQueries[].observerCount - Number of active observers
	 * @param {boolean} [liveQueries[].isReused] - Whether observer is reused
	 * @param {number} [liveQueries[].documentCount] - Documents being observed
	 * @param {Object} [liveQueries[].selector] - Query selector
	 * @returns {void}
	 */
	sendLiveQueries(liveQueries) {
		if (!Array.isArray(liveQueries) || liveQueries.length === 0) {
			return;
		}

		// Add all live queries to batch
		liveQueries.forEach(lq => {
			this._addToBatch("liveQueries", lq, "/api/v1/live-queries");
		});
	}

	/**
	 * Generic method to add item to batch with size checking
	 * Uses O(1) incremental size tracking instead of O(n) recalculation
	 * @private
	 */
	_addToBatch(batchType, item, endpoint) {
		const batch = this.batches[batchType];

		// Estimate item size once (O(item complexity), not O(batch size))
		const itemSize = estimateObjectSize(item);

		// Check if adding this item would exceed memory budget
		if (this.batchSizes[batchType] + itemSize > this.batchSizeBytes) {
			// Flush current batch first
			this._sendBatch(batchType, endpoint);
		}

		batch.push(item);
		this.batchSizes[batchType] += itemSize;

		// Auto-flush if batch size reached
		if (batch.length >= this.batchSize) {
			this._sendBatch(batchType, endpoint);
		}
	}

	/**
	 * Immediately flush all pending batches to the SkySignal API.
	 *
	 * This method sends all batched data regardless of batch size or flush interval.
	 * Useful before application shutdown or when you need data sent immediately.
	 *
	 * **Note:** This is a fire-and-forget operation. The method returns immediately
	 * while batches are sent asynchronously in the background.
	 *
	 * @returns {void}
	 *
	 * @example
	 * // Force immediate send of all pending data
	 * client.flush();
	 *
	 * @example
	 * // Flush before shutdown
	 * process.on("SIGTERM", () => {
	 *   client.flush();
	 *   process.exit(0);
	 * });
	 */
	flush() {
		Object.keys(this.batches).forEach(batchType => {
			if (this.batches[batchType].length > 0) {
				const endpoint = this._getEndpointForBatchType(batchType);
				this._sendBatch(batchType, endpoint);
			}
		});
	}

	/**
	 * Schedule the next automatic flush using setTimeout.
	 * Uses setTimeout instead of setInterval to prevent queuing multiple flushes.
	 * @private
	 * @returns {void}
	 */
	_scheduleFlush() {
		if (this.flushTimeoutId) {
			return; // Already scheduled
		}

		this.flushTimeoutId = setTimeout(() => {
			this.flushTimeoutId = null;
			this.flush();
			this._scheduleFlush(); // Schedule next flush
		}, this.flushInterval);
	}

	/**
	 * Stop the client and perform graceful cleanup.
	 *
	 * This method:
	 * 1. Sets the `stopped` flag to prevent new timers
	 * 2. Clears the auto-flush timer
	 * 3. Clears all pending retry timers
	 * 4. Performs a final flush of all pending data
	 *
	 * Safe to call multiple times (idempotent).
	 *
	 * @returns {void}
	 *
	 * @example
	 * // Graceful shutdown
	 * client.stop();
	 */
	stop() {
		this.stopped = true;

		if (this.flushTimeoutId) {
			clearTimeout(this.flushTimeoutId);
			this.flushTimeoutId = null;
		}

		// Clear all pending batch/retry timers
		for (const timerId of this.pendingTimers) {
			clearTimeout(timerId);
		}
		this.pendingTimers.clear();

		this.flush(); // Final flush
	}

	/**
	 * Get performance statistics for monitoring client health.
	 *
	 * Use this to monitor how the client is performing and detect issues
	 * like network problems (high failed count) or high-volume applications
	 * (high sampled count).
	 *
	 * @returns {Object} Statistics object
	 * @returns {number} returns.sent - Total items successfully sent
	 * @returns {number} returns.failed - Total items that failed to send (after retries)
	 * @returns {number} returns.sampled - Total items dropped due to sampling
	 * @returns {number} returns.bytesSent - Total bytes sent to the API
	 * @returns {number} returns.pending - Items currently waiting in batches
	 * @returns {number} returns.retrying - Items currently in retry queues
	 *
	 * @example
	 * // Monitor client health
	 * const stats = client.getStats();
	 * console.log(`Sent: ${stats.sent}, Failed: ${stats.failed}, Pending: ${stats.pending}`);
	 *
	 * @example
	 * // Check for problems
	 * const stats = client.getStats();
	 * if (stats.failed > stats.sent * 0.1) {
	 *   console.warn("High failure rate - check network connectivity");
	 * }
	 */
	getStats() {
		return {
			...this.stats,
			pending: Object.keys(this.batches).reduce((sum, key) => {
				return sum + this.batches[key].length;
			}, 0),
			retrying: Object.keys(this.retryQueues).reduce((sum, key) => {
				return sum + this.retryQueues[key].length;
			}, 0)
		};
	}

	/**
	 * Send a batch to the API using fetch (FIRE-AND-FORGET)
	 * Uses JSON for standard REST API compatibility
	 * No await in hot path - fully non-blocking
	 * @private
	 */
	_sendBatch(batchType, endpoint, retryCount = 0) {
		const batch = [...this.batches[batchType]];
		this.batches[batchType] = []; // Clear batch immediately
		this.batchSizes[batchType] = 0; // Reset size counter

		if (batch.length === 0) return;

		// Determine the payload key based on batch type
		const payloadKey = this._getPayloadKey(batchType);
		const payload = {
			[payloadKey]: batch
		};

		// Serialize with JSON (REST API expects standard JSON, not EJSON)
		// Use safe serialization to handle circular references
		const body = this._safeStringify(payload);
		if (!body) {
			console.error(`❌ SkySignal: Failed to serialize ${batchType} batch, skipping`);
			return;
		}
		const bodySize = body.length;

		// Don't send if client is stopped
		if (this.stopped) return;

		// Fire-and-forget: Schedule async send without blocking
		// Use setImmediate for lower latency than setTimeout(0)
		setImmediate(() => {
			if (!this.stopped) {
				this._sendRequest(endpoint, body, batchType, batch, bodySize, retryCount)
					.catch(error => {
						// Prevent unhandled promise rejection from crashing host app
						console.error(`❌ SkySignal: Unhandled error sending ${batchType}:`, error.message);
					});
			}
		});
	}

	/**
	 * Send HTTP request (internal)
	 * Uses connection pooling (keepAlive) and gzip compression for large payloads
	 * @private
	 */
	async _sendRequest(endpoint, body, batchType, batch, bodySize, retryCount) {
		const url = `${this.endpoint}${endpoint}`;
		try {
			// Prepare headers
			const headers = {
				"Content-Type": "application/json",
				"X-SkySignal-Key": this.apiKey
			};

			// Compress large payloads to reduce network bandwidth
			let requestBody = body;
			let actualSize = bodySize;
			if (bodySize > COMPRESSION_THRESHOLD) {
				try {
					const compressed = await gzipAsync(Buffer.from(body));
					// Only use compression if it actually reduces size
					if (compressed.length < bodySize * 0.9) {
						requestBody = compressed;
						actualSize = compressed.length;
						headers["Content-Encoding"] = "gzip";
					}
				} catch (compressError) {
					// Compression failed, use uncompressed body
				}
			}

			const response = await fetch(url, {
				method: "POST",
				headers,
				body: requestBody,
				signal: AbortSignal.timeout(this.requestTimeout),
				agent: this._agent // Reuse TCP connections
			});

			if (response.status === 202) {
				// Success
				this.stats.sent += batch.length;
				this.stats.bytesSent += actualSize;
			} else {
				// Unexpected status
				const responseText = await response.text().catch(() => "");
				console.warn(`⚠️ SkySignal: Unexpected response for ${batchType}:`, response.status, responseText);
				this._handleFailedBatch(batchType, batch, retryCount);
			}
		} catch (error) {
			// Network error, timeout, or other failure
			const isTimeout = error.name === 'TimeoutError' || error.message.includes('timeout');
			const isAbort = error.name === 'AbortError' || error.message.includes('abort');
			if (isTimeout) {
				console.error(`❌ SkySignal: Request timeout for ${batchType} (${this.requestTimeout}ms) to ${url}`);
			} else if (isAbort) {
				// Stale keepAlive socket reuse is a normal transient — retry handles it.
				// Don't spam production logs. See #4.
				if (this.debug) {
					console.warn(`⚠️ SkySignal: Request aborted for ${batchType} to ${url} - ${error.message}`);
				}
			} else {
				console.error(`❌ SkySignal: Failed to send ${batchType} to ${url}:`, error.message);
			}
			this._handleFailedBatch(batchType, batch, retryCount);
		}
	}

	/**
	 * Handle failed batch with retry logic
	 * @private
	 */
	_handleFailedBatch(batchType, batch, retryCount) {
		this.stats.failed += batch.length;

		if (retryCount < this.maxRetries) {
			// Re-queue for retry
			if (!this.retryQueues[batchType]) {
				this.retryQueues[batchType] = [];
			}

			// Enforce maximum retry queue size to prevent memory leak during outages
			const MAX_RETRY_QUEUE_SIZE = 100;
			if (this.retryQueues[batchType].length >= MAX_RETRY_QUEUE_SIZE) {
				// Drop oldest batch to make room
				const dropped = this.retryQueues[batchType].shift();
				console.warn(`⚠️ SkySignal: Retry queue full for ${batchType}, dropping oldest batch (${dropped.batch.length} items)`);
			}

			this.retryQueues[batchType].push({ batch, retryCount: retryCount + 1 });

			// Don't schedule retry if client is stopped
			if (this.stopped) return;

			// Schedule retry with exponential backoff + jitter to prevent thundering herd
			const baseDelay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Max 30s
			const jitter = Math.random() * baseDelay * 0.2; // 20% jitter
			const delay = baseDelay + jitter;
			const timerId = setTimeout(() => {
				this.pendingTimers.delete(timerId);
				if (!this.stopped) {
					this._retryBatch(batchType);
				}
			}, delay);
			this.pendingTimers.add(timerId);
		} else {
			// Max retries exceeded - drop the batch
			console.error(`❌ SkySignal: Dropping ${batch.length} ${batchType} after ${retryCount} retries`);
		}
	}

	/**
	 * Retry a failed batch
	 * @private
	 */
	_retryBatch(batchType) {
		if (this.stopped) return;

		const retryQueue = this.retryQueues[batchType];
		if (!retryQueue || retryQueue.length === 0) return;

		const { batch, retryCount } = retryQueue.shift();
		const endpoint = this._getEndpointForBatchType(batchType);

		// Re-send with incremented retry count
		const payloadKey = this._getPayloadKey(batchType);
		const payload = { [payloadKey]: batch };
		const body = this._safeStringify(payload);
		if (!body) {
			console.error(`❌ SkySignal: Failed to serialize retry ${batchType} batch, skipping`);
			return;
		}
		const bodySize = body.length;

		setImmediate(() => {
			if (!this.stopped) {
				this._sendRequest(endpoint, body, batchType, batch, bodySize, retryCount)
					.catch(error => {
						// Prevent unhandled promise rejection from crashing host app
						console.error(`❌ SkySignal: Unhandled error in retry ${batchType}:`, error.message);
					});
			}
		});
	}

	/**
	 * Safely stringify an object, handling circular references
	 * Reuses WeakSet to reduce GC pressure on high-frequency calls
	 * @private
	 */
	_safeStringify(obj) {
		// Note: WeakSet doesn't have a clear() method, so we create a fresh one
		// per stringify call. This is still efficient since the WeakSet is
		// short-lived and the objects added to it will be GC'd when not referenced.
		// The real optimization here is using WeakSet (vs Set) which allows GC.
		const seen = new WeakSet();
		try {
			return JSON.stringify(obj, (key, value) => {
				if (typeof value === 'object' && value !== null) {
					if (seen.has(value)) {
						return '[Circular]';
					}
					seen.add(value);
				}
				return value;
			});
		} catch (error) {
			console.error('❌ SkySignal: JSON serialization failed:', error.message);
			return null;
		}
	}

	/**
	 * Get the endpoint for a batch type
	 * @private
	 */
	_getEndpointForBatchType(batchType) {
		const endpoints = {
			traces: "/api/v1/traces",
			systemMetrics: "/api/v1/metrics/system",
			httpRequests: "/api/v1/metrics/http",
			customMetrics: "/api/v1/metrics/custom",
			errors: "/api/v1/errors",
			sessions: "/api/v1/sessions",
			securityEvents: "/api/v1/security/events",
			jobs: "/api/v1/jobs",
			alerts: "/api/v1/alerts",
			dependencies: "/api/v1/dependencies",
			mongoPoolMetrics: "/api/v1/metrics/mongopool",
			collectionStats: "/api/v1/metrics/collectionstats",
			ddpConnections: "/api/v1/ddp-connections",
			subscriptions: "/api/v1/subscriptions",
			liveQueries: "/api/v1/live-queries",
			rum: "/api/v1/rum",
			logs: "/api/v1/logs",
			dnsMetrics: "/api/v1/metrics/dns",
			outboundHttp: "/api/v1/metrics/outbound-http",
			cpuProfiles: "/api/v1/metrics/cpu-profile",
			deprecatedApis: "/api/v1/metrics/deprecated-apis",
			publications: "/api/v1/metrics/publications",
			environment: "/api/v1/metrics/environment",
			vulnerabilities: "/api/v1/metrics/vulnerabilities"
		};
		return endpoints[batchType] || "/api/v1/traces";
	}

	/**
	 * Get the payload key for a batch type
	 * @private
	 */
	_getPayloadKey(batchType) {
		const keys = {
			traces: "traces",
			systemMetrics: "metrics",
			httpRequests: "requests",
			customMetrics: "metrics",
			errors: "errors",
			sessions: "sessions",
			securityEvents: "events",
			jobs: "jobs",
			alerts: "alerts",
			dependencies: "dependencies",
			mongoPoolMetrics: "metrics",
			collectionStats: "stats",
			ddpConnections: "connections",
			subscriptions: "subscriptions",
			liveQueries: "liveQueries",
			rum: "measurements",
			logs: "logs",
			dnsMetrics: "metrics",
			outboundHttp: "metrics",
			cpuProfiles: "profiles",
			deprecatedApis: "metrics",
			publications: "metrics",
			environment: "metrics",
			vulnerabilities: "metrics"
		};
		return keys[batchType] || "data";
	}
}
