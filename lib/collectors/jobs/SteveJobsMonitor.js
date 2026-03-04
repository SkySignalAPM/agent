import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";
import BaseJobMonitor from "./BaseJobMonitor.js";

let methodTraceContextStore = null;
try {
	const mod = require("../MethodTracer.js");
	methodTraceContextStore = mod.methodTraceContextStore || null;
} catch {
	// MethodTracer not available — trace correlation disabled
}

/**
 * SteveJobsMonitor
 * Job monitoring adapter for msavin:sjobs (Steve Jobs) package
 *
 * Steve Jobs stores jobs in a MongoDB collection called "jobs_data"
 * with the following structure:
 * - name: Job name (registered job type)
 * - state: Job state (pending, success, failure, etc.)
 * - due: When the job should run
 * - priority: Job priority (higher = sooner)
 * - created: When job was created
 * - arguments: Job arguments array
 *
 * @see https://github.com/msavin/SteveJobs
 */
export default class SteveJobsMonitor extends BaseJobMonitor {
	constructor(options = {}) {
		super(options);

		// Steve Jobs configuration
		this.jobsCollection = null;
		this.observeHandle = null;

		// Track job execution via collection observer
		this.runningJobsMap = new Map(); // _id -> startTime

		// Stalled job tracking — avoid duplicate emissions
		this._stalledEmitted = new Set();

		// Trace correlation — pending contexts from Jobs.run() calls
		this._pendingTraceContexts = new Map();
		this._pendingTraceContextsByName = new Map();
	}

	/**
	 * Get package name
	 * @returns {String}
	 */
	getPackageName() {
		return "msavin:sjobs";
	}

	/**
	 * Check if Steve Jobs is available
	 * @returns {Boolean}
	 */
	isPackageAvailable() {
		try {
			// Steve Jobs exposes a global Jobs object
			return typeof Jobs !== "undefined" && Jobs.collection;
		} catch (e) {
			return false;
		}
	}

	/**
	 * Get current queue statistics
	 * @returns {Promise<Object>}
	 */
	async getQueueStats() {
		if (!this.jobsCollection) {
			return { queueLength: 0, workersActive: 0, workersTotal: 1 };
		}

		try {
			// Count jobs by state using countAsync for Meteor 3.x compatibility
			const pending = await this.jobsCollection.find({
				state: "pending"
			}).countAsync();

			const running = await this.jobsCollection.find({
				state: { $in: ["pending"] },
				due: { $lte: new Date() }
			}).countAsync();

			// Steve Jobs doesn't have explicit worker count, estimate from config
			const workersTotal = this._getWorkerCount();
			const activeWorkers = Math.min(running, workersTotal);
			const utilization = workersTotal > 0
				? Math.round((activeWorkers / workersTotal) * 100 * 10) / 10
				: 0;

			return {
				queueLength: pending,
				workersActive: activeWorkers,
				workersTotal: workersTotal,
				utilization
			};
		} catch (error) {
			console.error("Error getting queue stats:", error);
			return { queueLength: 0, workersActive: 0, workersTotal: 1 };
		}
	}

	/**
	 * Start monitoring
	 */
	start() {
		this._log("SteveJobsMonitor.start() called");
		this._log(`Jobs global exists: ${typeof Jobs !== "undefined"}`);
		this._log(`Jobs.collection exists: ${typeof Jobs !== "undefined" && !!Jobs?.collection}`);

		if (!this.isPackageAvailable()) {
			this._log("msavin:sjobs not available - job monitoring disabled");
			return;
		}

		this._log("msavin:sjobs detected, setting up monitoring...");

		// Get reference to Jobs collection
		try {
			this.jobsCollection = Jobs.collection;
			this._log(`Jobs collection: ${this.jobsCollection?._name || "unknown"}`);
		} catch (e) {
			console.error("❌ Could not access Jobs.collection:", e.message);
			return;
		}

		// Wrap Jobs.run for trace correlation
		this._wrapJobsRun();

		// Set up hooks (await observer before scanning, since observe() returns
		// a Promise in Meteor 3.x). The initial added callbacks fire during
		// observer setup, so we must NOT scan existing jobs separately — the
		// observer's added handler already covers them.
		this.setupHooks();

		// Call parent start for interval-based stats
		super.start();

		this._log("SteveJobsMonitor fully started");
	}

	/**
	 * Stop monitoring
	 */
	async stop() {
		this._unwrapJobsRun();
		await this.cleanupHooks();
		this._stalledEmitted.clear();
		this._pendingTraceContexts.clear();
		this._pendingTraceContextsByName.clear();
		super.stop();
	}

	/**
	 * Set up MongoDB observer to track job state changes.
	 * In Meteor 3.x, observe() returns a Promise. We must await it so
	 * that initial added callbacks fire and the observer is fully active
	 * before we proceed.
	 */
	async setupHooks() {
		if (!this.jobsCollection) return;

		try {
			// Await the observer — initial added callbacks for all existing docs
			// fire during this await, so _scanExistingJobs() is no longer needed.
			this.observeHandle = await this.jobsCollection.find({}).observe({
				added: (doc) => this._handleJobAdded(doc),
				changed: (newDoc, oldDoc) => this._handleJobChanged(newDoc, oldDoc),
				removed: (doc) => this._handleJobRemoved(doc)
			});

			this._log("Steve Jobs observer started");
		} catch (error) {
			console.error("❌ Failed to set up Steve Jobs observer:", error.message);
		}
	}

	/**
	 * Clean up observer
	 */
	async cleanupHooks() {
		if (this.observeHandle) {
			// observeHandle is the resolved handle (not a Promise) since
			// setupHooks() now awaits observe()
			if (typeof this.observeHandle.stop === "function") {
				this.observeHandle.stop();
			}
			this.observeHandle = null;
		}
	}

	/**
	 * Handle new job added to collection
	 * @private
	 */
	_handleJobAdded(doc) {
		this._log(`Job added: ${doc.name} (${doc._id}) - state: ${doc.state}`);

		// Look up pending trace context for this job
		const originatingTraceId = this._consumeTraceContext(doc._id);

		// Track scheduled/pending jobs
		if (doc.state === "pending") {
			const now = new Date();
			const dueTime = doc.due || doc.created || now;

			// If job is due now or in the past, it will run immediately
			if (dueTime <= now) {
				// Job is executing immediately
				this._markJobRunning(doc, originatingTraceId);
			} else {
				// Job is scheduled for later
				this.trackScheduledJob({
					jobId: doc._id,
					jobName: doc.name,
					queueName: "default",
					scheduledFor: dueTime,
					repeat: this._getRepeatPattern(doc),
					priority: doc.priority || 0,
					originatingTraceId
				});
			}
		} else if (doc.state === "success") {
			// Job was added already completed (rare, but handle it)
			this.trackJobStart({
				jobId: doc._id,
				jobName: doc.name,
				queueName: "default",
				queuedAt: doc.created || new Date(),
				priority: doc.priority || 0,
				data: this._extractJobData(doc),
				attempts: doc.attempts || 1,
				originatingTraceId
			});
			this.trackJobComplete(doc._id, doc.result);
		} else if (doc.state === "failure") {
			// Job was added already failed
			this.trackJobStart({
				jobId: doc._id,
				jobName: doc.name,
				queueName: "default",
				queuedAt: doc.created || new Date(),
				priority: doc.priority || 0,
				data: this._extractJobData(doc),
				attempts: doc.attempts || 1,
				originatingTraceId
			});
			this.trackJobFailed(doc._id, doc.failure || { message: "Job failed" });
		}
	}

	/**
	 * Handle job state change
	 * @private
	 */
	_handleJobChanged(newDoc, oldDoc) {
		this._log(`Job changed: ${newDoc.name} (${newDoc._id}) - ${oldDoc.state} → ${newDoc.state}`);

		// Detect job starting (due time passed and still pending)
		if (this._isJobExecuting(newDoc) && !this.runningJobsMap.has(newDoc._id)) {
			this._markJobRunning(newDoc);
		}

		// Detect job completion
		if (newDoc.state === "success" && oldDoc.state !== "success") {
			this._log(`Job completed: ${newDoc.name} (${newDoc._id})`);
			this._markJobCompleted(newDoc);
		}

		// Detect job failure
		if (newDoc.state === "failure" && oldDoc.state !== "failure") {
			this._log(`Job failed: ${newDoc.name} (${newDoc._id})`);
			this._markJobFailed(newDoc);
		}
	}

	/**
	 * Handle job removed from collection.
	 *
	 * In Steve Jobs, instance.remove() deletes the doc while state is still
	 * "pending" — there is no "success" state transition when using remove().
	 * So a removed doc with state "pending" usually means the job completed
	 * successfully (Steve Jobs removes successful jobs).
	 * @private
	 */
	_handleJobRemoved(doc) {
		const jobId = doc._id;
		this._log(`Job removed: ${doc.name} (${jobId}) - state: ${doc.state}`);

		// Check if job was already completed/failed (state is success/failure)
		// This handles the case where autoPurge removes completed jobs
		if (doc.state === "success") {
			// Job completed successfully and was purged
			if (!this.trackedJobs.has(jobId)) {
				this.trackJobStart({
					jobId: jobId,
					jobName: doc.name,
					queueName: "default",
					queuedAt: doc.created || new Date(),
					priority: doc.priority || 0,
					data: this._extractJobData(doc),
					attempts: doc.attempts || 1
				});
			}
			this.trackJobComplete(jobId, doc.result || { purged: true });
			this.runningJobsMap.delete(jobId);
			return;
		}

		if (doc.state === "failure") {
			// Job failed and was purged
			if (!this.trackedJobs.has(jobId)) {
				this.trackJobStart({
					jobId: jobId,
					jobName: doc.name,
					queueName: "default",
					queuedAt: doc.created || new Date(),
					priority: doc.priority || 0,
					data: this._extractJobData(doc),
					attempts: doc.attempts || 1
				});
			}
			this.trackJobFailed(jobId, doc.failure || { message: "Job failed" });
			this.runningJobsMap.delete(jobId);
			return;
		}

		// If job was tracked as running, mark as completed
		if (this.runningJobsMap.has(jobId)) {
			this.trackJobComplete(jobId, { removedFromQueue: true });
			this.runningJobsMap.delete(jobId);
			return;
		}

		// Job was pending (e.g., a replicated/scheduled job that ran and was
		// removed via instance.remove()). Steve Jobs doesn't set state to
		// "success" before removal, so state is still "pending" here.
		// Treat as completed — emit start + complete so the server record
		// transitions from pending → completed instead of staying orphaned.
		if (doc.state === "pending") {
			if (!this.trackedJobs.has(jobId)) {
				this.trackJobStart({
					jobId: jobId,
					jobName: doc.name,
					queueName: "default",
					queuedAt: doc.created || new Date(),
					priority: doc.priority || 0,
					data: this._extractJobData(doc),
					attempts: doc.attempts || 1
				});
			}
			this.trackJobComplete(jobId, { removedFromQueue: true });
			return;
		}

		// Truly cancelled job
		if (doc.state === "cancelled") {
			this.trackJobCancelled(jobId);
		}
	}

	/**
	 * Check if a job is currently executing
	 * @private
	 */
	_isJobExecuting(doc) {
		// In Steve Jobs, a job is executing when:
		// 1. State is pending
		// 2. Due time has passed
		// 3. Job hasn't completed or failed yet
		if (doc.state !== "pending") return false;

		const now = new Date();
		const dueTime = doc.due || doc.created || now;

		return dueTime <= now;
	}

	/**
	 * Mark job as running
	 * @private
	 */
	_markJobRunning(doc, originatingTraceId = null) {
		const jobId = doc._id;

		// Don't double-track
		if (this.runningJobsMap.has(jobId)) return;

		// Record start time
		this.runningJobsMap.set(jobId, new Date());

		// Track via base class
		this.trackJobStart({
			jobId: jobId,
			jobName: doc.name,
			queueName: "default",
			queuedAt: doc.created || new Date(),
			priority: doc.priority || 0,
			data: this._extractJobData(doc),
			attempts: doc.attempts || 1,
			originatingTraceId
		});
	}

	/**
	 * Mark job as completed
	 * @private
	 */
	_markJobCompleted(doc) {
		const jobId = doc._id;

		// If we were tracking this job
		if (this.runningJobsMap.has(jobId) || this.trackedJobs.has(jobId)) {
			this.trackJobComplete(jobId, doc.result);
			this.runningJobsMap.delete(jobId);
		} else {
			// Job completed but we weren't tracking it (maybe started before monitoring)
			// Still report it with estimated timing and capture job data
			this.trackJobStart({
				jobId: jobId,
				jobName: doc.name,
				queueName: "default",
				queuedAt: doc.created || new Date(),
				priority: doc.priority || 0,
				data: this._extractJobData(doc),
				attempts: doc.attempts || 1
			});
			this.trackJobComplete(jobId, doc.result);
		}
	}

	/**
	 * Mark job as failed
	 * @private
	 */
	_markJobFailed(doc) {
		const jobId = doc._id;

		// If we were tracking this job
		if (this.runningJobsMap.has(jobId) || this.trackedJobs.has(jobId)) {
			this.trackJobFailed(jobId, doc.failure || { message: "Job failed" });
			this.runningJobsMap.delete(jobId);
		} else {
			// Job failed but we weren't tracking it - capture job data
			this.trackJobStart({
				jobId: jobId,
				jobName: doc.name,
				queueName: "default",
				queuedAt: doc.created || new Date(),
				priority: doc.priority || 0,
				data: this._extractJobData(doc),
				attempts: doc.attempts || 1
			});
			this.trackJobFailed(jobId, doc.failure || { message: "Job failed" });
		}
	}

	/**
	 * Extract job data/arguments
	 * @private
	 */
	_extractJobData(doc) {
		if (!doc.arguments || doc.arguments.length === 0) {
			return null;
		}

		// Steve Jobs stores arguments as an array
		if (doc.arguments.length === 1) {
			return doc.arguments[0];
		}

		return { arguments: doc.arguments };
	}

	/**
	 * Get repeat pattern from job config
	 * @private
	 */
	_getRepeatPattern(doc) {
		// Steve Jobs uses singular: 'hour', 'day', etc.
		// or specific dates/times
		if (doc.repeat) {
			return doc.repeat;
		}

		// Check for scheduled pattern
		if (doc.schedule) {
			return doc.schedule;
		}

		return null;
	}

	/**
	 * Get worker count from Steve Jobs config
	 * @private
	 */
	_getWorkerCount() {
		try {
			// Try to get from Jobs configuration
			const config = Jobs.configure ? Jobs.configure() : null;
			if (config && config.maxWorkers) {
				return config.maxWorkers;
			}
		} catch (e) {
			// Ignore
		}

		// Default to 1 worker (Steve Jobs typically uses single worker per server)
		return 1;
	}

	// ============================================
	// Stalled job detection
	// ============================================

	/**
	 * Detect stalled jobs — pending jobs whose due time is >5 minutes in the past.
	 * @private
	 */
	async _detectStalledJobs() {
		if (!this.jobsCollection) return;

		try {
			const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
			const stalledDocs = await this.jobsCollection.find({
				state: "pending",
				due: { $lte: fiveMinutesAgo }
			}).fetchAsync();

			for (const doc of stalledDocs) {
				if (this._stalledEmitted.has(doc._id)) continue;
				this._stalledEmitted.add(doc._id);

				this._sendJobEvent({
					jobId: doc._id,
					jobName: doc.name,
					jobType: this._inferJobType(doc.name),
					queueName: "default",
					status: "stalled",
					stalledAt: new Date(),
					host: this.host,
					appVersion: this.appVersion,
					buildHash: this.buildHash,
					timestamp: new Date(),
					data: this._extractJobData(doc) ? this._sanitizeJobData(this._extractJobData(doc)) : null
				});
			}
		} catch (error) {
			this._log("Error detecting stalled jobs:", error.message);
		}
	}

	/**
	 * Override to include stalled job detection.
	 * @protected
	 */
	async _collectAndSendStats() {
		await this._detectStalledJobs();
		await super._collectAndSendStats();
	}

	// ============================================
	// Trace correlation
	// ============================================

	/**
	 * Wrap Jobs.run() to capture traceId from current method context.
	 * @private
	 */
	_wrapJobsRun() {
		if (typeof Jobs === "undefined" || !methodTraceContextStore) return;

		this._originalJobsRun = Jobs.run;
		const self = this;

		Jobs.run = function (jobName, ...args) {
			// Capture current method trace context
			const store = methodTraceContextStore.getStore();
			if (store && store.methodContext && store.methodContext.traceId) {
				// Store a pending context that will be looked up in _handleJobAdded
				// We key by jobName + a timestamp since we don't have the jobId yet
				const pendingKey = `${jobName}:${Date.now()}`;
				self._pendingTraceContexts.set(pendingKey, {
					traceId: store.methodContext.traceId,
					jobName,
					timestamp: Date.now()
				});

				// Also store by jobName for simpler lookups (last-write-wins for same job name)
				self._pendingTraceContextsByName.set(jobName, {
					traceId: store.methodContext.traceId,
					timestamp: Date.now()
				});
			}

			return self._originalJobsRun.call(this, jobName, ...args);
		};

		this._log("Jobs.run wrapped for trace correlation");
	}

	/**
	 * Consume trace context for a job by looking up recent Jobs.run() calls
	 * matched by job name. Steve Jobs doesn't expose the jobId at .run() time,
	 * so we match by name and consume the most recent pending context (within 5s).
	 * @private
	 */
	_consumeTraceContext(jobId) {
		// Steve Jobs observer fires after Jobs.run() inserts the doc.
		// We can read the doc's name from the observer callback (passed as doc.name in _handleJobAdded).
		// However, _consumeTraceContext is called before we have the doc at hand in the refactored code.
		// Instead, we look at the pending contexts and match any recent one (within 5s).
		const now = Date.now();
		let bestMatch = null;

		for (const [key, ctx] of this._pendingTraceContexts) {
			if (now - ctx.timestamp > 5000) {
				this._pendingTraceContexts.delete(key);
				continue;
			}
			// Take the most recent one
			if (!bestMatch || ctx.timestamp > bestMatch.timestamp) {
				bestMatch = ctx;
			}
		}

		if (bestMatch) {
			// Remove the consumed context
			for (const [key, ctx] of this._pendingTraceContexts) {
				if (ctx === bestMatch) {
					this._pendingTraceContexts.delete(key);
					break;
				}
			}
			return bestMatch.traceId;
		}

		return null;
	}

	/**
	 * Restore original Jobs.run
	 * @private
	 */
	_unwrapJobsRun() {
		if (this._originalJobsRun && typeof Jobs !== "undefined") {
			Jobs.run = this._originalJobsRun;
			this._originalJobsRun = null;
		}
	}

	// _scanExistingJobs() removed — the observer's initial added callbacks
	// (which fire during the awaited observe() call) already handle all
	// existing documents, making a separate scan redundant and racy.
}
