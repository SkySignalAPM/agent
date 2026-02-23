/**
 * BaseJobMonitor
 * Abstract base class for monitoring background job systems
 *
 * This class provides the foundation for monitoring different job queue packages.
 * Extend this class and implement the abstract methods for specific packages:
 * - msavin:sjobs (Steve Jobs)
 * - littledata:synced-cron
 * - wildhart:jobs
 * - percolate:synced-cron
 *
 * @abstract
 */
export default class BaseJobMonitor {
	constructor(options = {}) {
		this.client = options.client; // SkySignalClient instance
		this.host = options.host || "unknown-host";
		this.appVersion = options.appVersion || "unknown";
		this.buildHash = options.buildHash || null;
		this.enabled = options.enabled !== false;
		this.debug = options.debug || false;
		this.interval = options.interval || 30000; // Default: 30 seconds

		// State tracking
		this.intervalId = null;
		this.started = false;

		// Job tracking maps
		this.trackedJobs = new Map(); // jobId -> job start info
		this.jobHistory = []; // Recent job completions for metrics
		this.maxHistorySize = options.maxHistorySize || 1000;

		// Metrics accumulator
		this.metrics = {
			totalJobs: 0,
			completedJobs: 0,
			failedJobs: 0,
			totalDuration: 0,
			longestDuration: 0
		};
	}

	/**
	 * Start monitoring jobs
	 * Subclasses should call super.start() and then set up their specific hooks
	 */
	/** @private */
	_log(...args) {
		if (this.debug) {
			console.log(`[SkySignal:Jobs]`, ...args);
		}
	}

	start() {
		if (!this.enabled) {
			this._log(`${this.constructor.name} disabled`);
			return;
		}

		if (this.started) {
			console.warn(`⚠️ ${this.constructor.name} already started`);
			return;
		}

		// Start periodic stats collection
		this.intervalId = setInterval(() => {
			this._collectAndSendStats();
		}, this.interval);

		this.started = true;
		this._log(`${this.constructor.name} started (interval: ${this.interval}ms)`);
	}

	/**
	 * Stop monitoring jobs
	 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		// Flush any pending jobs
		this._flushPendingJobs();

		this.started = false;
		this._log(`${this.constructor.name} stopped`);
	}

	/**
	 * Track when a job starts execution
	 * Call this from your adapter when a job begins
	 *
	 * @param {Object} jobInfo - Job information
	 * @param {String} jobInfo.jobId - Unique job identifier
	 * @param {String} jobInfo.jobName - Name of the job type
	 * @param {String} [jobInfo.jobType] - Optional job category
	 * @param {Date} [jobInfo.queuedAt] - When the job was queued
	 * @param {Number} [jobInfo.priority] - Job priority
	 * @param {Object} [jobInfo.data] - Job payload data (will be sanitized)
	 * @param {String} [jobInfo.workerId] - Worker ID processing this job
	 */
	trackJobStart(jobInfo) {
		const now = new Date();
		const job = {
			jobId: jobInfo.jobId,
			jobName: jobInfo.jobName,
			jobType: jobInfo.jobType || this._inferJobType(jobInfo.jobName),
			status: "running",
			queuedAt: jobInfo.queuedAt || now,
			startedAt: now,
			priority: jobInfo.priority || 0,
			data: this._sanitizeJobData(jobInfo.data),
			workerId: jobInfo.workerId,
			host: this.host,
			appVersion: this.appVersion,
			buildHash: this.buildHash,
			attempts: jobInfo.attempts || 1,
			progress: 0
		};

		// Calculate delay (time in queue)
		job.delay = job.startedAt.getTime() - job.queuedAt.getTime();

		// Store for duration calculation on completion
		this.trackedJobs.set(jobInfo.jobId, job);

		// Send job start event immediately
		this._sendJobEvent(job);
	}

	/**
	 * Track when a job completes successfully
	 *
	 * @param {String} jobId - Job identifier
	 * @param {Object} [result] - Job result (will be sanitized)
	 */
	trackJobComplete(jobId, result = null) {
		const job = this.trackedJobs.get(jobId);
		if (!job) {
			console.warn(`⚠️ Job ${jobId} not found in tracked jobs`);
			return;
		}

		const now = new Date();
		job.status = "completed";
		job.completedAt = now;
		job.duration = now.getTime() - job.startedAt.getTime();
		job.result = this._sanitizeJobData(result);
		job.progress = 100;

		// Update metrics
		this.metrics.completedJobs++;
		this.metrics.totalJobs++;
		this.metrics.totalDuration += job.duration;
		this.metrics.longestDuration = Math.max(this.metrics.longestDuration, job.duration);

		// Add to history
		this._addToHistory(job);

		// Remove from tracked
		this.trackedJobs.delete(jobId);

		// Send completion event
		this._sendJobEvent(job);
	}

	/**
	 * Track when a job fails
	 *
	 * @param {String} jobId - Job identifier
	 * @param {Error|Object} error - Error information
	 */
	trackJobFailed(jobId, error) {
		const job = this.trackedJobs.get(jobId);
		if (!job) {
			console.warn(`⚠️ Job ${jobId} not found in tracked jobs`);
			return;
		}

		const now = new Date();
		job.status = "failed";
		job.completedAt = now;
		job.duration = now.getTime() - job.startedAt.getTime();
		job.error = this._formatError(error);

		// Update metrics
		this.metrics.failedJobs++;
		this.metrics.totalJobs++;
		this.metrics.totalDuration += job.duration;

		// Add to history
		this._addToHistory(job);

		// Remove from tracked
		this.trackedJobs.delete(jobId);

		// Send failure event
		this._sendJobEvent(job);
	}

	/**
	 * Track job progress (for long-running jobs)
	 *
	 * @param {String} jobId - Job identifier
	 * @param {Number} progress - Progress percentage (0-100)
	 */
	trackJobProgress(jobId, progress) {
		const job = this.trackedJobs.get(jobId);
		if (job) {
			job.progress = Math.min(100, Math.max(0, progress));
		}
	}

	/**
	 * Track a scheduled/pending job
	 *
	 * @param {Object} jobInfo - Job information
	 * @param {String} jobInfo.jobId - Unique job identifier
	 * @param {String} jobInfo.jobName - Name of the job type
	 * @param {Date} jobInfo.scheduledFor - When the job is scheduled to run
	 * @param {String} [jobInfo.repeat] - Repeat pattern (e.g., "every 5 minutes")
	 * @param {Number} [jobInfo.priority] - Job priority
	 */
	trackScheduledJob(jobInfo) {
		const job = {
			jobId: jobInfo.jobId,
			jobName: jobInfo.jobName,
			jobType: jobInfo.jobType || this._inferJobType(jobInfo.jobName),
			status: "pending",
			queuedAt: new Date(),
			scheduledFor: jobInfo.scheduledFor,
			repeat: jobInfo.repeat,
			priority: jobInfo.priority || 0,
			host: this.host,
			appVersion: this.appVersion,
			buildHash: this.buildHash
		};

		this._sendJobEvent(job);
	}

	/**
	 * Track when a job is cancelled
	 *
	 * @param {String} jobId - Job identifier
	 */
	trackJobCancelled(jobId) {
		const job = this.trackedJobs.get(jobId);
		if (job) {
			job.status = "cancelled";
			job.completedAt = new Date();
			this.trackedJobs.delete(jobId);
			this._sendJobEvent(job);
		}
	}

	// ============================================
	// Abstract methods - MUST be implemented by subclasses
	// ============================================

	/**
	 * Get the name of the job package being monitored
	 * @abstract
	 * @returns {String} Package name (e.g., "msavin:sjobs")
	 */
	getPackageName() {
		throw new Error("getPackageName() must be implemented by subclass");
	}

	/**
	 * Check if the job package is available/installed
	 * @abstract
	 * @returns {Boolean} True if package is available
	 */
	isPackageAvailable() {
		throw new Error("isPackageAvailable() must be implemented by subclass");
	}

	/**
	 * Get current queue statistics from the job package
	 * @abstract
	 * @returns {Promise<Object>} Queue stats { queueLength, workersActive, workersTotal }
	 */
	async getQueueStats() {
		throw new Error("getQueueStats() must be implemented by subclass");
	}

	/**
	 * Set up hooks/observers for the specific job package
	 * Called during start() - implement package-specific monitoring
	 * @abstract
	 */
	setupHooks() {
		throw new Error("setupHooks() must be implemented by subclass");
	}

	/**
	 * Clean up hooks/observers
	 * Called during stop()
	 * @abstract
	 */
	cleanupHooks() {
		// Optional - override if needed
	}

	// ============================================
	// Protected helper methods
	// ============================================

	/**
	 * Infer job type from job name
	 * @protected
	 */
	_inferJobType(jobName) {
		if (!jobName) return "unknown";

		// Common patterns
		if (jobName.includes("email") || jobName.includes("mail")) return "email";
		if (jobName.includes("report")) return "report";
		if (jobName.includes("cleanup") || jobName.includes("purge")) return "maintenance";
		if (jobName.includes("sync")) return "sync";
		if (jobName.includes("import") || jobName.includes("export")) return "data-transfer";
		if (jobName.includes("notification") || jobName.includes("notify")) return "notification";
		if (jobName.includes("process")) return "processing";

		return "general";
	}

	/**
	 * Sanitize job data to prevent sensitive info leakage
	 * @protected
	 */
	_sanitizeJobData(data) {
		if (!data) return null;

		try {
			const sanitized = JSON.parse(JSON.stringify(data));

			// Remove common sensitive fields
			const sensitiveKeys = [
				"password", "secret", "token", "apiKey", "api_key",
				"authorization", "auth", "credential", "private"
			];

			const sanitizeObj = (obj) => {
				if (typeof obj !== "object" || obj === null) return obj;

				for (const key of Object.keys(obj)) {
					const lowerKey = key.toLowerCase();
					if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
						obj[key] = "[REDACTED]";
					} else if (typeof obj[key] === "object") {
						sanitizeObj(obj[key]);
					}
				}
				return obj;
			};

			return sanitizeObj(sanitized);
		} catch (e) {
			return { error: "Could not serialize job data" };
		}
	}

	/**
	 * Format error for transmission
	 * @protected
	 */
	_formatError(error) {
		if (!error) return null;

		if (error instanceof Error) {
			return {
				message: error.message,
				name: error.name,
				stack: error.stack?.split("\n").slice(0, 10).join("\n") // Limit stack trace
			};
		}

		if (typeof error === "string") {
			return { message: error };
		}

		return {
			message: error.message || "Unknown error",
			...error
		};
	}

	/**
	 * Send a job event to SkySignal
	 * @protected
	 */
	_sendJobEvent(job) {
		if (!this.client) {
			console.warn("⚠️ No SkySignal client configured for job monitoring");
			return;
		}

		this._log(`Sending job event: ${job.jobName} (${job.jobId}) - status: ${job.status}`);

		// Add the job to the jobs batch
		this.client._addToBatch("jobs", job, "/api/v1/jobs");
	}

	/**
	 * Add job to history for metrics calculation
	 * @protected
	 */
	_addToHistory(job) {
		this.jobHistory.push({
			jobName: job.jobName,
			jobType: job.jobType,
			status: job.status,
			duration: job.duration,
			completedAt: job.completedAt
		});

		// Trim history if needed
		if (this.jobHistory.length > this.maxHistorySize) {
			this.jobHistory = this.jobHistory.slice(-this.maxHistorySize);
		}
	}

	/**
	 * Collect and send periodic stats
	 * @protected
	 */
	async _collectAndSendStats() {
		try {
			const queueStats = await this.getQueueStats();

			// Calculate metrics from history
			const recentHistory = this.jobHistory.filter(j =>
				Date.now() - j.completedAt.getTime() < this.interval * 2
			);

			const stats = {
				timestamp: new Date(),
				host: this.host,
				appVersion: this.appVersion,
				buildHash: this.buildHash,
				packageName: this.getPackageName(),

				// Queue state
				queueLength: queueStats.queueLength || 0,
				workersActive: queueStats.workersActive || 0,
				workersTotal: queueStats.workersTotal || 1,
				runningJobs: this.trackedJobs.size,

				// Period metrics
				completedInPeriod: recentHistory.filter(j => j.status === "completed").length,
				failedInPeriod: recentHistory.filter(j => j.status === "failed").length,
				avgDurationInPeriod: recentHistory.length > 0
					? recentHistory.reduce((sum, j) => sum + (j.duration || 0), 0) / recentHistory.length
					: 0,

				// Cumulative metrics
				totalJobsProcessed: this.metrics.totalJobs,
				totalCompleted: this.metrics.completedJobs,
				totalFailed: this.metrics.failedJobs,
				avgDuration: this.metrics.totalJobs > 0
					? this.metrics.totalDuration / this.metrics.totalJobs
					: 0,
				longestDuration: this.metrics.longestDuration
			};

			// Send stats (we can use a custom metric for aggregated stats)
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
		} catch (error) {
			console.error(`❌ Error collecting job stats:`, error.message);
		}
	}

	/**
	 * Flush any pending tracked jobs (called on stop)
	 * @protected
	 */
	_flushPendingJobs() {
		// Mark any still-running jobs as unknown state
		for (const [jobId, job] of this.trackedJobs) {
			job.status = "unknown";
			job.completedAt = new Date();
			this._sendJobEvent(job);
		}
		this.trackedJobs.clear();
	}
}
