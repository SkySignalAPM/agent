import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";
import BaseJobMonitor from "./BaseJobMonitor.js";

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

			return {
				queueLength: pending,
				workersActive: Math.min(running, workersTotal),
				workersTotal: workersTotal
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
		console.log("🔍 SteveJobsMonitor.start() called");
		console.log(`   Jobs global exists: ${typeof Jobs !== "undefined"}`);
		console.log(`   Jobs.collection exists: ${typeof Jobs !== "undefined" && !!Jobs?.collection}`);

		if (!this.isPackageAvailable()) {
			console.log("⏸️  msavin:sjobs not available - job monitoring disabled");
			return;
		}

		console.log("✅ msavin:sjobs detected, setting up monitoring...");

		// Get reference to Jobs collection
		try {
			this.jobsCollection = Jobs.collection;
			console.log(`   Jobs collection: ${this.jobsCollection?._name || "unknown"}`);
		} catch (e) {
			console.error("❌ Could not access Jobs.collection:", e.message);
			return;
		}

		// Set up hooks
		this.setupHooks();

		// Call parent start for interval-based stats
		super.start();

		// Initial scan of existing jobs
		this._scanExistingJobs();

		console.log("✅ SteveJobsMonitor fully started");
	}

	/**
	 * Stop monitoring
	 */
	stop() {
		this.cleanupHooks();
		super.stop();
	}

	/**
	 * Set up MongoDB observer to track job state changes
	 */
	setupHooks() {
		if (!this.jobsCollection) return;

		try {
			// Observe job collection for changes
			this.observeHandle = this.jobsCollection.find({}).observe({
				added: (doc) => this._handleJobAdded(doc),
				changed: (newDoc, oldDoc) => this._handleJobChanged(newDoc, oldDoc),
				removed: (doc) => this._handleJobRemoved(doc)
			});

			console.log("✅ Steve Jobs observer started");
		} catch (error) {
			console.error("❌ Failed to set up Steve Jobs observer:", error.message);
		}
	}

	/**
	 * Clean up observer
	 */
	cleanupHooks() {
		if (this.observeHandle) {
			this.observeHandle.stop();
			this.observeHandle = null;
		}
	}

	/**
	 * Handle new job added to collection
	 * @private
	 */
	_handleJobAdded(doc) {
		console.log(`📋 Job added: ${doc.name} (${doc._id}) - state: ${doc.state}`);

		// Track scheduled/pending jobs
		if (doc.state === "pending") {
			const now = new Date();
			const dueTime = doc.due || doc.created || now;

			// If job is due now or in the past, it will run immediately
			if (dueTime <= now) {
				// Job is executing immediately
				this._markJobRunning(doc);
			} else {
				// Job is scheduled for later
				this.trackScheduledJob({
					jobId: doc._id,
					jobName: doc.name,
					scheduledFor: dueTime,
					repeat: this._getRepeatPattern(doc),
					priority: doc.priority || 0
				});
			}
		} else if (doc.state === "success") {
			// Job was added already completed (rare, but handle it)
			this.trackJobStart({
				jobId: doc._id,
				jobName: doc.name,
				queuedAt: doc.created || new Date(),
				priority: doc.priority || 0,
				data: this._extractJobData(doc),
				attempts: doc.attempts || 1
			});
			this.trackJobComplete(doc._id, doc.result);
		} else if (doc.state === "failure") {
			// Job was added already failed
			this.trackJobStart({
				jobId: doc._id,
				jobName: doc.name,
				queuedAt: doc.created || new Date(),
				priority: doc.priority || 0,
				data: this._extractJobData(doc),
				attempts: doc.attempts || 1
			});
			this.trackJobFailed(doc._id, doc.failure || { message: "Job failed" });
		}
	}

	/**
	 * Handle job state change
	 * @private
	 */
	_handleJobChanged(newDoc, oldDoc) {
		console.log(`🔄 Job changed: ${newDoc.name} (${newDoc._id}) - ${oldDoc.state} → ${newDoc.state}`);

		// Detect job starting (due time passed and still pending)
		if (this._isJobExecuting(newDoc) && !this.runningJobsMap.has(newDoc._id)) {
			this._markJobRunning(newDoc);
		}

		// Detect job completion
		if (newDoc.state === "success" && oldDoc.state !== "success") {
			console.log(`✅ Job completed: ${newDoc.name} (${newDoc._id})`);
			this._markJobCompleted(newDoc);
		}

		// Detect job failure
		if (newDoc.state === "failure" && oldDoc.state !== "failure") {
			console.log(`❌ Job failed: ${newDoc.name} (${newDoc._id})`);
			this._markJobFailed(newDoc);
		}
	}

	/**
	 * Handle job removed from collection
	 * @private
	 */
	_handleJobRemoved(doc) {
		const jobId = doc._id;
		console.log(`🗑️  Job removed: ${doc.name} (${jobId}) - state: ${doc.state}`);

		// Check if job was already completed/failed (state is success/failure)
		// This handles the case where autoPurge removes completed jobs
		if (doc.state === "success") {
			// Job completed successfully and was purged
			if (!this.trackedJobs.has(jobId)) {
				// We never tracked this job starting - track both start and completion with full data
				this.trackJobStart({
					jobId: jobId,
					jobName: doc.name,
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

		// If job was running (pending but due time passed), mark as completed
		if (this.runningJobsMap.has(jobId)) {
			// Assume success if removed while running (Steve Jobs removes successful jobs)
			this.trackJobComplete(jobId, { removedFromQueue: true });
			this.runningJobsMap.delete(jobId);
			return;
		}

		// If job was pending and cancelled
		if (doc.state === "pending" || doc.state === "cancelled") {
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
	_markJobRunning(doc) {
		const jobId = doc._id;

		// Don't double-track
		if (this.runningJobsMap.has(jobId)) return;

		// Record start time
		this.runningJobsMap.set(jobId, new Date());

		// Track via base class
		this.trackJobStart({
			jobId: jobId,
			jobName: doc.name,
			queuedAt: doc.created || new Date(),
			priority: doc.priority || 0,
			data: this._extractJobData(doc),
			attempts: doc.attempts || 1
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

	/**
	 * Scan existing jobs on startup
	 * @private
	 */
	_scanExistingJobs() {
		if (!this.jobsCollection) return;

		try {
			// Find all pending jobs and report them
			const pendingJobs = this.jobsCollection.find({
				state: "pending"
			}).fetch();

			console.log(`📊 Found ${pendingJobs.length} pending jobs in queue`);

			// Report scheduled jobs
			pendingJobs.forEach(doc => {
				const now = new Date();
				const dueTime = doc.due || doc.created || now;

				if (dueTime > now) {
					// Future scheduled job
					this.trackScheduledJob({
						jobId: doc._id,
						jobName: doc.name,
						scheduledFor: dueTime,
						repeat: this._getRepeatPattern(doc),
						priority: doc.priority || 0
					});
				} else {
					// Job is due/running
					this._markJobRunning(doc);
				}
			});
		} catch (error) {
			console.error("❌ Error scanning existing jobs:", error.message);
		}
	}
}
