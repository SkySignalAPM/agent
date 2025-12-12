import { Meteor } from "meteor/meteor";
import { fetch } from "meteor/fetch";
import { estimateObjectSize } from "./sizeEstimator.js";

/**
 * SkySignalClient
 * High-performance HTTP client for SkySignal API
 *
 * Performance optimizations:
 * - Uses JSON for standard REST API compatibility
 * - Fire-and-forget HTTP (non-blocking)
 * - Sampling to reduce volume
 * - Size-based batching to stay within memory budget
 * - No await in hot path
 */
export default class SkySignalClient {
	constructor(options = {}) {
		this.apiKey = options.apiKey;
		this.endpoint = options.endpoint || "https://dash.skysignal.app";
		this.batchSize = options.batchSize || 50;
		this.batchSizeBytes = options.batchSizeBytes || 256 * 1024; // 256KB
		this.flushInterval = options.flushInterval || 10000;
		this.requestTimeout = options.requestTimeout || 3000;
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
			rum: []
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

		// Start auto-flush interval using setTimeout (not setInterval for better control)
		this._scheduleFlush();
	}

	/**
	 * Add trace to batch (with sampling)
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
	 * Add system metric to batch (no sampling - low volume)
	 */
	addSystemMetric(metric) {
		this._addToBatch("systemMetrics", metric, "/api/v1/metrics/system");
	}

	/**
	 * Add MongoDB pool metric to batch (no sampling - low volume)
	 */
	addMongoPoolMetric(metric) {
		this._addToBatch("mongoPoolMetrics", metric, "/api/v1/metrics/mongopool");
	}

	/**
	 * Add MongoDB collection stats to batch (no sampling - low volume)
	 */
	addCollectionStats(stats) {
		this._addToBatch("collectionStats", stats, "/api/v1/metrics/collectionstats");
	}

	/**
	 * Add HTTP request to batch
	 */
	addHttpRequest(request) {
		this._addToBatch("httpRequests", request, "/api/v1/metrics/http");
	}

	/**
	 * Add custom metric to batch
	 */
	addCustomMetric(metric) {
		this._addToBatch("customMetrics", metric, "/api/v1/metrics/custom");
	}

	/**
	 * Add error to batch (no sampling - errors are important)
	 */
	addError(error) {
		this._addToBatch("errors", error, "/api/v1/errors");
	}

	/**
	 * Add RUM measurement to batch (with sampling)
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
	 * Send DDP connections (called by DDPCollector)
	 * Sends immediately without batching since DDPCollector manages its own batching
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
	 * Send DDP subscriptions (called by DDPCollector)
	 * Sends immediately without batching since DDPCollector manages its own batching
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
	 * Send Live Queries data (called by LiveQueriesCollector)
	 * Sends immediately without batching since LiveQueriesCollector manages its own batching
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
	 * Flush all pending batches
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
	 * Schedule next flush using setTimeout (not setInterval)
	 * This ensures we don't queue up multiple flushes
	 * @private
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
	 * Stop the client and clear timeouts
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
	 * Get performance statistics
	 * @returns {Object} Stats object
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
		// Use setTimeout instead of Meteor.defer for better control
		setTimeout(() => {
			if (!this.stopped) {
				this._sendRequest(endpoint, body, batchType, batch, bodySize, retryCount)
					.catch(error => {
						// Prevent unhandled promise rejection from crashing host app
						console.error(`❌ SkySignal: Unhandled error sending ${batchType}:`, error.message);
					});
			}
		}, 0);
	}

	/**
	 * Send HTTP request (internal)
	 * @private
	 */
	async _sendRequest(endpoint, body, batchType, batch, bodySize, retryCount) {
		try {
			const response = await fetch(`${this.endpoint}${endpoint}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-SkySignal-Key": this.apiKey
				},
				body: body,
				signal: AbortSignal.timeout(this.requestTimeout)
			});

			if (response.status === 202) {
				// Success
				this.stats.sent += batch.length;
				this.stats.bytesSent += bodySize;
			} else {
				// Unexpected status
				const responseText = await response.text().catch(() => "");
				console.warn(`⚠️ SkySignal: Unexpected response for ${batchType}:`, response.status, responseText);
				this._handleFailedBatch(batchType, batch, retryCount);
			}
		} catch (error) {
			// Network error, timeout, or other failure
			console.error(`❌ SkySignal: Failed to send ${batchType}:`, error.message);
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

		setTimeout(() => {
			if (!this.stopped) {
				this._sendRequest(endpoint, body, batchType, batch, bodySize, retryCount)
					.catch(error => {
						// Prevent unhandled promise rejection from crashing host app
						console.error(`❌ SkySignal: Unhandled error in retry ${batchType}:`, error.message);
					});
			}
		}, 0);
	}

	/**
	 * Safely stringify an object, handling circular references
	 * @private
	 */
	_safeStringify(obj) {
		try {
			const seen = new WeakSet();
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
			rum: "/api/v1/rum"
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
			rum: "measurements"
		};
		return keys[batchType] || "data";
	}
}
