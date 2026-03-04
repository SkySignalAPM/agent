/**
 * BullMQMonitor
 * Job monitoring adapter for BullMQ (Redis-based) queue package
 *
 * Discovers queues by scanning Redis for BullMQ key patterns (bull:*:meta),
 * then uses QueueEvents for real-time job lifecycle tracking with per-queue metrics.
 *
 * Discovery strategies (in order):
 * 1. Manual queue config (bullmqQueues option)
 * 2. Redis key scanning (bull:*:meta pattern)
 * 3. Periodic re-scan during stats collection (catches new queues)
 *
 * Performance notes:
 * - Job cache reduces Redis round-trips by avoiding redundant Job.fromId() calls
 * - Event payload data (returnvalue, failedReason, progress) used where possible
 * - Stacktrace fetching on failures is optional (detailedTracking config)
 *
 * @see https://docs.bullmq.io/
 */

import BaseJobMonitor from "./BaseJobMonitor.js";

let methodTraceContextStore = null;
try {
	// Lazy import — only available when MethodTracer is active in the same app
	const mod = require("../MethodTracer.js");
	methodTraceContextStore = mod.methodTraceContextStore || null;
} catch {
	// MethodTracer not available — trace correlation disabled
}

// ============================================================
// Module-scope: runtime BullMQ detection
// ============================================================

let bullmq = null;
let OriginalQueue = null;
let OriginalQueueEvents = null;
let BullMQJob = null;

// Try to load at module scope (fast path — works when bullmq is in require resolution path)
try {
	bullmq = require("bullmq");
} catch {
	try {
		bullmq = require(require.resolve("bullmq", { paths: [process.cwd()] }));
	} catch {
		// Will retry lazily in _loadBullMQ() at startup time
	}
}

if (bullmq) {
	OriginalQueue = bullmq.Queue;
	OriginalQueueEvents = bullmq.QueueEvents;
	BullMQJob = bullmq.Job;
}

/**
 * Lazy-load BullMQ — called at startup time when module-scope require may have
 * failed (e.g., Meteor package module resolution) but the app has since loaded
 * bullmq into the require cache.
 * @returns {Boolean}
 */
function _loadBullMQ() {
	if (bullmq) return true;

	const searchPaths = [process.cwd(), process.env.PWD].filter(Boolean);

	try {
		bullmq = require("bullmq");
	} catch {
		for (const p of searchPaths) {
			try {
				bullmq = require(require.resolve("bullmq", { paths: [p] }));
				break;
			} catch {
				continue;
			}
		}
	}

	if (bullmq) {
		OriginalQueue = bullmq.Queue;
		OriginalQueueEvents = bullmq.QueueEvents;
		BullMQJob = bullmq.Job;
		return true;
	}

	return false;
}

// ============================================================
// BullMQMonitor class
// ============================================================

export default class BullMQMonitor extends BaseJobMonitor {
	constructor(options = {}) {
		super(options);

		// Monitor-owned instances (created from originals)
		this.queueEventsMap = new Map();   // name -> QueueEvents instance
		this.monitorQueuesMap = new Map();  // name -> Queue instance (for getJobCounts)

		// Worker concurrency tracking per queue
		this.workerConcurrency = new Map(); // name -> total concurrency

		// Per-queue metrics for the current stats period
		this.perQueueMetrics = new Map();   // name -> { completed, failed, stalled }

		// Stalled job counter per queue (reset each stats period)
		this.stalledJobs = new Map();       // name -> count

		// Manual queue configs from user
		this.bullmqQueues = options.bullmqQueues || [];
		this.bullmqRedis = options.bullmqRedis || null;

		// Job detail cache — avoids redundant Job.fromId() Redis round-trips.
		this._jobCache = new Map();          // compositeId -> { data, ts }
		this._jobCacheMaxSize = options.jobCacheMaxSize || 2000;
		this._jobCacheTTL = options.jobCacheTTL || 120000; // 2 minutes

		// When true, fetch full job details on failure events for stacktrace.
		this.detailedTracking = options.detailedTracking !== false;
	}

	/**
	 * @returns {String}
	 */
	getPackageName() {
		return "bullmq";
	}

	/**
	 * @returns {Boolean}
	 */
	isPackageAvailable() {
		return _loadBullMQ();
	}

	// ============================================
	// Job cache
	// ============================================

	/**
	 * Get a cached job, respecting TTL
	 * @private
	 */
	_getCachedJob(compositeId) {
		const entry = this._jobCache.get(compositeId);
		if (!entry) return null;
		if (Date.now() - entry.ts > this._jobCacheTTL) {
			this._jobCache.delete(compositeId);
			return null;
		}
		return entry.data;
	}

	/**
	 * Cache a job, evicting oldest entry if at capacity
	 * @private
	 */
	_cacheJob(compositeId, jobData) {
		if (this._jobCache.size >= this._jobCacheMaxSize) {
			const firstKey = this._jobCache.keys().next().value;
			this._jobCache.delete(firstKey);
		}
		this._jobCache.set(compositeId, { data: jobData, ts: Date.now() });
	}

	/**
	 * Evict expired cache entries
	 * @private
	 */
	_evictExpiredCache() {
		const now = Date.now();
		for (const [key, entry] of this._jobCache) {
			if (now - entry.ts > this._jobCacheTTL) {
				this._jobCache.delete(key);
			}
		}
	}

	// ============================================
	// Lifecycle
	// ============================================

	/**
	 * Start monitoring BullMQ queues
	 */
	start() {
		if (!_loadBullMQ()) {
			this._log("BullMQ not available - monitoring disabled");
			return;
		}

		this._log("BullMQ detected, setting up monitoring...");

		// Wrap Queue.add for trace correlation
		this._wrapQueueAdd();

		// Register manually-configured queues
		for (const queueConfig of this.bullmqQueues) {
			if (queueConfig.name && !this.queueEventsMap.has(queueConfig.name)) {
				this._onQueueDiscovered(queueConfig.name, {
					name: queueConfig.name,
					queueOpts: { connection: queueConfig.connection },
					workerOpts: null,
					concurrency: 0
				});
			}
		}

		// Discover existing queues from Redis (async — queues appear shortly after start)
		this._discoverQueuesFromRedis().catch(err => {
			this._log("Redis queue discovery error:", err.message);
		});

		// Call parent start for interval-based stats
		super.start();

		this._log("BullMQMonitor started");
	}

	// ============================================
	// Queue discovery
	// ============================================

	/**
	 * Discover BullMQ queues by scanning Redis for bull:*:meta keys.
	 * Safe to call repeatedly — skips already-monitored queues.
	 * @private
	 */
	async _discoverQueuesFromRedis() {
		const connection = this.bullmqRedis || { host: "localhost", port: 6379 };

		let IORedis;
		try {
			IORedis = require("ioredis");
		} catch {
			const searchPaths = [process.cwd(), process.env.PWD].filter(Boolean);
			for (const p of searchPaths) {
				try {
					IORedis = require(require.resolve("ioredis", { paths: [p] }));
					break;
				} catch {
					continue;
				}
			}
		}

		if (!IORedis) {
			this._log("ioredis not available, skipping Redis queue discovery");
			return;
		}

		const redis = new IORedis({ ...connection, maxRetriesPerRequest: 1, lazyConnect: true });

		try {
			await redis.connect();

			// Scan for BullMQ queue metadata keys (pattern: bull:{queueName}:meta)
			const queueNames = new Set();
			let cursor = "0";
			do {
				const [newCursor, keys] = await redis.scan(cursor, "MATCH", "bull:*:meta", "COUNT", 100);
				cursor = newCursor;
				for (const key of keys) {
					const match = key.match(/^bull:(.+):meta$/);
					if (match) {
						queueNames.add(match[1]);
					}
				}
			} while (cursor !== "0");

			let newCount = 0;
			for (const queueName of queueNames) {
				if (!this.queueEventsMap.has(queueName)) {
					this._log(`Discovered queue from Redis: ${queueName}`);
					this._onQueueDiscovered(queueName, {
						name: queueName,
						queueOpts: { connection },
						workerOpts: null,
						concurrency: 0
					});
					newCount++;
				}
			}

			if (newCount > 0) {
				this._log(`Redis discovery: ${newCount} new queue(s), ${this.queueEventsMap.size} total monitored`);
			}
		} catch (error) {
			this._log("Redis queue discovery failed:", error.message);
		} finally {
			try {
				await redis.quit();
			} catch {
				// Ignore quit errors
			}
		}
	}

	/**
	 * Handle a newly discovered queue — create QueueEvents + monitoring Queue
	 * @private
	 */
	_onQueueDiscovered(name, info) {
		// Skip if already monitoring this queue
		if (this.queueEventsMap.has(name)) {
			if (info.concurrency) {
				this.workerConcurrency.set(name, info.concurrency);
			}
			return;
		}

		this._log(`Attaching monitor to queue: ${name}`);

		const connection = this._resolveConnection(name, info);

		try {
			const queueEvents = new OriginalQueueEvents(name, { connection });
			const monitorQueue = new OriginalQueue(name, { connection });

			this.queueEventsMap.set(name, queueEvents);
			this.monitorQueuesMap.set(name, monitorQueue);
			this.workerConcurrency.set(name, info.concurrency || 0);
			this.perQueueMetrics.set(name, { completed: 0, failed: 0, stalled: 0 });
			this.stalledJobs.set(name, 0);

			this._attachQueueListeners(name, queueEvents, monitorQueue);

			this._log(`Monitoring active for queue: ${name}`);
		} catch (error) {
			console.error(`[SkySignal:Jobs] Failed to monitor queue "${name}":`, error.message);
		}
	}

	/**
	 * Resolve Redis connection for a queue
	 * Priority: queue opts > worker opts > manual config > global config > localhost default
	 * @private
	 */
	_resolveConnection(name, info) {
		if (info.queueOpts && info.queueOpts.connection) {
			return { ...info.queueOpts.connection };
		}

		if (info.workerOpts && info.workerOpts.connection) {
			return { ...info.workerOpts.connection };
		}

		const manual = this.bullmqQueues.find(q => q.name === name);
		if (manual && manual.connection) {
			return { ...manual.connection };
		}

		if (this.bullmqRedis) {
			return { ...this.bullmqRedis };
		}

		return { host: "localhost", port: 6379 };
	}

	// ============================================
	// Event listeners
	// ============================================

	/**
	 * Attach QueueEvents listeners to map BullMQ events to base class tracking.
	 * @private
	 */
	_attachQueueListeners(name, queueEvents, monitorQueue) {
		// active — job started processing
		queueEvents.on("active", async ({ jobId }) => {
			try {
				const compositeId = `${name}:${jobId}`;
				const job = await this._fetchJobDetails(name, monitorQueue, jobId);
				if (!job) return;

				this.trackJobStart({
					jobId: compositeId,
					jobName: job.name,
					jobType: this._inferJobType(job.name),
					queueName: name,
					queuedAt: job.timestamp ? new Date(job.timestamp) : new Date(),
					priority: job.opts?.priority || 0,
					data: job.data,
					workerId: null,
					attempts: job.attemptsMade || 1,
					originatingTraceId: this._extractTraceId(job.data)
				});
			} catch (error) {
				this._log(`Error handling active event for ${name}:${jobId}:`, error.message);
			}
		});

		// completed — uses event payload (returnvalue), no fetch for normal flow
		queueEvents.on("completed", async ({ jobId, returnvalue }) => {
			try {
				const compositeId = `${name}:${jobId}`;

				if (!this.trackedJobs.has(compositeId)) {
					const cached = this._getCachedJob(compositeId);
					if (cached) {
						this.trackJobStart({
							jobId: compositeId,
							jobName: cached.name,
							jobType: this._inferJobType(cached.name),
							queueName: name,
							queuedAt: cached.timestamp ? new Date(cached.timestamp) : new Date(),
							priority: cached.opts?.priority || 0,
							data: cached.data,
							attempts: cached.attemptsMade || 1,
							originatingTraceId: this._extractTraceId(cached.data)
						});
					} else {
						await this._bootstrapMissedJob(name, monitorQueue, jobId);
					}
				}

				const result = this._parseReturnValue(returnvalue);
				this.trackJobComplete(compositeId, result);

				this._jobCache.delete(compositeId);

				const metrics = this.perQueueMetrics.get(name);
				if (metrics) metrics.completed++;
			} catch (error) {
				this._log(`Error handling completed event for ${name}:${jobId}:`, error.message);
			}
		});

		// failed — uses event payload (failedReason), stacktrace fetch optional
		queueEvents.on("failed", async ({ jobId, failedReason }) => {
			try {
				const compositeId = `${name}:${jobId}`;

				if (!this.trackedJobs.has(compositeId)) {
					const cached = this._getCachedJob(compositeId);
					if (cached) {
						this.trackJobStart({
							jobId: compositeId,
							jobName: cached.name,
							jobType: this._inferJobType(cached.name),
							queueName: name,
							queuedAt: cached.timestamp ? new Date(cached.timestamp) : new Date(),
							priority: cached.opts?.priority || 0,
							data: cached.data,
							attempts: cached.attemptsMade || 1,
							originatingTraceId: this._extractTraceId(cached.data)
						});
					} else {
						await this._bootstrapMissedJob(name, monitorQueue, jobId);
					}
				}

				let errorInfo = { message: failedReason || "Job failed" };

				if (this.detailedTracking) {
					try {
						const job = await this._fetchJobDetails(name, monitorQueue, jobId);
						if (job) {
							errorInfo = {
								message: failedReason || "Job failed",
								stack: job.stacktrace?.[0] || null,
								attemptsMade: job.attemptsMade || 0
							};
						}
					} catch (fetchErr) {
						this._log(`Could not fetch stacktrace for ${compositeId}:`, fetchErr.message);
					}
				}

				this.trackJobFailed(compositeId, errorInfo);

				this._jobCache.delete(compositeId);

				const metrics = this.perQueueMetrics.get(name);
				if (metrics) metrics.failed++;
			} catch (error) {
				this._log(`Error handling failed event for ${name}:${jobId}:`, error.message);
			}
		});

		// stalled — uses cache first
		queueEvents.on("stalled", async ({ jobId }) => {
			try {
				const compositeId = `${name}:${jobId}`;

				let job = this._getCachedJob(compositeId);
				if (!job) {
					job = await this._fetchJobDetails(name, monitorQueue, jobId);
				}

				const stalledEvent = {
					jobId: compositeId,
					jobName: job?.name || "unknown",
					jobType: this._inferJobType(job?.name),
					queueName: name,
					status: "stalled",
					stalledAt: new Date(),
					host: this.host,
					appVersion: this.appVersion,
					buildHash: this.buildHash,
					timestamp: new Date(),
					data: job?.data ? this._sanitizeJobData(job.data) : null
				};

				this._sendJobEvent(stalledEvent);

				this.stalledJobs.set(name, (this.stalledJobs.get(name) || 0) + 1);
				const metrics = this.perQueueMetrics.get(name);
				if (metrics) metrics.stalled++;
			} catch (error) {
				this._log(`Error handling stalled event for ${name}:${jobId}:`, error.message);
			}
		});

		// progress — uses event payload directly
		queueEvents.on("progress", async ({ jobId, data: progressData }) => {
			try {
				const compositeId = `${name}:${jobId}`;
				const progress = typeof progressData === "number"
					? progressData
					: (progressData?.percentage ?? progressData?.progress ?? 0);
				this.trackJobProgress(compositeId, progress);
			} catch (error) {
				this._log(`Error handling progress event for ${name}:${jobId}:`, error.message);
			}
		});

		// waiting — fetch and cache for later active event
		queueEvents.on("waiting", async ({ jobId }) => {
			try {
				const job = await this._fetchJobDetails(name, monitorQueue, jobId);
				if (!job) return;

				const compositeId = `${name}:${jobId}`;
				this.trackScheduledJob({
					jobId: compositeId,
					jobName: job.name,
					jobType: this._inferJobType(job.name),
					queueName: name,
					scheduledFor: job.opts?.delay
						? new Date(Date.now() + job.opts.delay)
						: new Date(),
					priority: job.opts?.priority || 0,
					originatingTraceId: this._extractTraceId(job.data)
				});
			} catch (error) {
				this._log(`Error handling waiting event for ${name}:${jobId}:`, error.message);
			}
		});

		// delayed — uses delayTs from event payload
		queueEvents.on("delayed", async ({ jobId, delay: delayTs }) => {
			try {
				const job = await this._fetchJobDetails(name, monitorQueue, jobId);
				if (!job) return;

				const compositeId = `${name}:${jobId}`;
				const scheduledFor = delayTs ? new Date(parseInt(delayTs, 10)) : new Date();
				this.trackScheduledJob({
					jobId: compositeId,
					jobName: job.name,
					jobType: this._inferJobType(job.name),
					queueName: name,
					scheduledFor,
					priority: job.opts?.priority || 0,
					originatingTraceId: this._extractTraceId(job.data)
				});
			} catch (error) {
				this._log(`Error handling delayed event for ${name}:${jobId}:`, error.message);
			}
		});
	}

	// ============================================
	// Job fetching with cache
	// ============================================

	/**
	 * Fetch job details with cache to avoid redundant Redis round-trips.
	 * @private
	 */
	async _fetchJobDetails(name, monitorQueue, jobId) {
		const compositeId = `${name}:${jobId}`;

		const cached = this._getCachedJob(compositeId);
		if (cached) return cached;

		try {
			const job = await BullMQJob.fromId(monitorQueue, jobId);
			if (job) {
				this._cacheJob(compositeId, job);
			}
			return job;
		} catch (error) {
			this._log(`Could not fetch job ${compositeId}:`, error.message);
			return null;
		}
	}

	/**
	 * Bootstrap a missed job (started before monitoring began).
	 * @private
	 */
	async _bootstrapMissedJob(name, monitorQueue, jobId) {
		const compositeId = `${name}:${jobId}`;

		let job = this._getCachedJob(compositeId);
		if (!job) {
			job = await this._fetchJobDetails(name, monitorQueue, jobId);
		}

		if (job) {
			this.trackJobStart({
				jobId: compositeId,
				jobName: job.name,
				jobType: this._inferJobType(job.name),
				queueName: name,
				queuedAt: job.timestamp ? new Date(job.timestamp) : new Date(),
				priority: job.opts?.priority || 0,
				data: job.data,
				attempts: job.attemptsMade || 1,
				originatingTraceId: this._extractTraceId(job.data)
			});
		} else {
			this.trackJobStart({
				jobId: compositeId,
				jobName: "unknown",
				queueName: name,
				queuedAt: new Date()
			});
		}
	}

	// ============================================
	// Stats
	// ============================================

	/**
	 * Get current queue statistics across all monitored queues
	 * @returns {Promise<Object>}
	 */
	async getQueueStats() {
		const totals = {
			queueLength: 0,
			activeJobs: 0,
			workersTotal: 0
		};
		const perQueue = {};

		for (const [name, queue] of this.monitorQueuesMap) {
			try {
				const counts = await queue.getJobCounts(
					"waiting", "active", "completed", "failed", "delayed", "prioritized"
				);

				const concurrency = this.workerConcurrency.get(name) || 0;
				const stalledInPeriod = this.stalledJobs.get(name) || 0;
				const metrics = this.perQueueMetrics.get(name) || { completed: 0, failed: 0, stalled: 0 };

				const utilization = concurrency > 0
					? Math.round(((counts.active || 0) / concurrency) * 100 * 10) / 10
					: 0;

				perQueue[name] = {
					waiting: counts.waiting || 0,
					active: counts.active || 0,
					completed: counts.completed || 0,
					failed: counts.failed || 0,
					delayed: counts.delayed || 0,
					prioritized: counts.prioritized || 0,
					concurrency,
					utilization,
					stalledInPeriod,
					completedInPeriod: metrics.completed,
					failedInPeriod: metrics.failed
				};

				totals.queueLength += (counts.waiting || 0) + (counts.delayed || 0) + (counts.prioritized || 0);
				totals.activeJobs += counts.active || 0;
				totals.workersTotal += concurrency;
			} catch (error) {
				this._log(`Error getting stats for queue "${name}":`, error.message);
				perQueue[name] = { error: error.message };
			}
		}

		return { ...totals, perQueue };
	}

	/**
	 * Override to include perQueue breakdown, reset period counters,
	 * and periodically re-discover new queues from Redis.
	 * @protected
	 */
	async _collectAndSendStats() {
		try {
			// Re-discover any new queues added since last check
			await this._discoverQueuesFromRedis().catch(err => {
				this._log("Periodic Redis discovery error:", err.message);
			});

			const queueStats = await this.getQueueStats();

			const recentHistory = this.jobHistory.filter(j =>
				Date.now() - j.completedAt.getTime() < this.interval * 2
			);

			const stats = {
				timestamp: new Date(),
				host: this.host,
				appVersion: this.appVersion,
				buildHash: this.buildHash,
				packageName: this.getPackageName(),

				queueLength: queueStats.queueLength || 0,
				activeJobs: queueStats.activeJobs || 0,
				workersTotal: queueStats.workersTotal || 1,
				runningJobs: this.trackedJobs.size,

				completedInPeriod: recentHistory.filter(j => j.status === "completed").length,
				failedInPeriod: recentHistory.filter(j => j.status === "failed").length,
				avgDurationInPeriod: recentHistory.length > 0
					? recentHistory.reduce((sum, j) => sum + (j.duration || 0), 0) / recentHistory.length
					: 0,

				totalJobsProcessed: this.metrics.totalJobs,
				totalCompleted: this.metrics.completedJobs,
				totalFailed: this.metrics.failedJobs,
				avgDuration: this.metrics.totalJobs > 0
					? this.metrics.totalDuration / this.metrics.totalJobs
					: 0,
				longestDuration: this.metrics.longestDuration,
				workerUtilization: queueStats.workersTotal > 0
					? Math.round((queueStats.activeJobs / queueStats.workersTotal) * 100 * 10) / 10
					: 0,

				perQueue: queueStats.perQueue
			};

			if (this.client) {
				this.client.addCustomMetric({
					name: "job_queue_stats",
					type: "gauge",
					timestamp: stats.timestamp,
					host: this.host,
					value: stats.queueLength,
					tags: {
						package: this.getPackageName()
					},
					metadata: stats
				});
			}

			// Reset period counters
			for (const [name] of this.perQueueMetrics) {
				this.perQueueMetrics.set(name, { completed: 0, failed: 0, stalled: 0 });
			}
			for (const [name] of this.stalledJobs) {
				this.stalledJobs.set(name, 0);
			}

			this._evictExpiredCache();
		} catch (error) {
			console.error("[SkySignal:Jobs] Error collecting BullMQ stats:", error.message);
		}
	}

	/**
	 * Stop monitoring
	 */
	async stop() {
		const closePromises = [];

		for (const [, qe] of this.queueEventsMap) {
			closePromises.push(qe.close().catch((err) => {
				this._log("Error closing QueueEvents:", err.message);
			}));
		}
		for (const [, q] of this.monitorQueuesMap) {
			closePromises.push(q.close().catch((err) => {
				this._log("Error closing monitoring Queue:", err.message);
			}));
		}

		await Promise.allSettled(closePromises);

		this._unwrapQueueAdd();

		this.queueEventsMap.clear();
		this.monitorQueuesMap.clear();
		this.workerConcurrency.clear();
		this.perQueueMetrics.clear();
		this.stalledJobs.clear();
		this._jobCache.clear();

		super.stop();
	}

	/**
	 * Parse BullMQ return values (may be stringified JSON)
	 * @private
	 */
	_parseReturnValue(rv) {
		if (rv === undefined || rv === null) return null;
		if (typeof rv !== "string") return rv;

		try {
			return JSON.parse(rv);
		} catch {
			return rv;
		}
	}

	/**
	 * Extract and strip __skysignal_traceId from job data
	 * @private
	 */
	_extractTraceId(data) {
		if (!data || typeof data !== "object") return null;
		const traceId = data.__skysignal_traceId || null;
		return traceId;
	}

	/**
	 * Wrap Queue.prototype.add/addBulk to inject traceId at enqueue time.
	 * @private
	 */
	_wrapQueueAdd() {
		if (!OriginalQueue || !methodTraceContextStore) return;

		this._originalQueueAdd = OriginalQueue.prototype.add;
		this._originalQueueAddBulk = OriginalQueue.prototype.addBulk;

		const self = this;

		OriginalQueue.prototype.add = function (name, data, opts) {
			const enriched = self._injectTraceId(data);
			return self._originalQueueAdd.call(this, name, enriched, opts);
		};

		OriginalQueue.prototype.addBulk = function (jobs) {
			const enriched = jobs.map(j => ({
				...j,
				data: self._injectTraceId(j.data)
			}));
			return self._originalQueueAddBulk.call(this, enriched);
		};

		this._log("Queue.add/addBulk wrapped for trace correlation");
	}

	/**
	 * Inject __skysignal_traceId from current method context into job data
	 * @private
	 */
	_injectTraceId(data) {
		if (!methodTraceContextStore) return data;

		const store = methodTraceContextStore.getStore();
		if (!store || !store.methodContext) return data;

		const traceId = store.methodContext.traceId;
		if (!traceId) return data;

		return { ...(data || {}), __skysignal_traceId: traceId };
	}

	/**
	 * Restore original Queue.prototype.add/addBulk
	 * @private
	 */
	_unwrapQueueAdd() {
		if (this._originalQueueAdd && OriginalQueue) {
			OriginalQueue.prototype.add = this._originalQueueAdd;
			this._originalQueueAdd = null;
		}
		if (this._originalQueueAddBulk && OriginalQueue) {
			OriginalQueue.prototype.addBulk = this._originalQueueAddBulk;
			this._originalQueueAddBulk = null;
		}
	}

	// Not called by base class but kept for API compatibility
	setupHooks() {}
	cleanupHooks() {}
}
