import { randomUUID } from "crypto";
import BaseJobMonitor from "./BaseJobMonitor.js";
import { methodTraceContextStore } from "../MethodTracer.js";

/** Execution adapter for quave:synced-cron; scheduling and locking stay upstream. */
export default class SyncedCronMonitor extends BaseJobMonitor {
	constructor(options = {}) {
		super(options);
		this._wrappedEntries = new Map();
		this._generation = 0;
	}

	getPackageName() {
		return "quave:synced-cron";
	}

	_getCron() {
		return typeof Package !== "undefined" ? Package["quave:synced-cron"]?.SyncedCron : null;
	}

	isPackageAvailable() {
		const cron = this._getCron();
		return !!(cron && cron._entries && typeof cron._entryWrapper === "function");
	}

	start() {
		if (!this.enabled || this.started || !this.isPackageAvailable()) return;
		this._cron = this._getCron();
		this._generation++;
		super.start();
		this.setupHooks();
	}

	setupHooks() {
		const monitor = this;
		const generation = this._generation;
		const original = this._cron._entryWrapper;
		this._originalEntryWrapper = original;
		this._entryWrapper = function (entry, ...args) {
			if (monitor.started && monitor._generation === generation) {
				monitor._safely(() => monitor._wrapEntry(entry));
			}
			return original.call(this, entry, ...args);
		};
		this._cron._entryWrapper = this._entryWrapper;
		// Existing timer closures retain entry objects and read entry.job at execution.
		for (const entry of Object.values(this._cron._entries)) {
			this._safely(() => this._wrapEntry(entry));
		}
	}

	_safely(callback) {
		try {
			return callback();
		} catch {
			// Monitoring must never change job execution, results, or scheduler errors.
			return undefined;
		}
	}

	_wrapEntry(entry) {
		if (!entry || typeof entry.job !== "function") return;
		const existing = this._wrappedEntries.get(entry);
		if (existing?.wrapped === entry.job) return;
		const original = entry.job;
		const monitor = this;
		const generation = this._generation;
		const wrapped = function (...args) {
			if (!monitor.started || monitor._generation !== generation) {
				return original.apply(this, args);
			}
			// A fresh identifier per invocation also covers concurrent and manual runs.
			const jobId = monitor._safely(() => randomUUID());
			monitor._safely(() => monitor.trackJobStart({
				jobId,
				jobName: entry.name,
				queueName: "synced-cron",
				queuedAt: args[0] instanceof Date && Number.isFinite(args[0].getTime()) ? args[0] : new Date(),
				workerId: monitor.host,
				originatingTraceId: methodTraceContextStore.getStore()?.methodContext?.traceId || null
			}));
			const finish = (failed, value) => {
				if (monitor.started && monitor._generation === generation && monitor.trackedJobs.has(jobId)) {
					monitor._safely(() => failed
						? monitor.trackJobFailed(jobId, value)
						: monitor.trackJobComplete(jobId, value));
					monitor.trackedJobs.delete(jobId);
				}
				if (failed) throw value;
				return value;
			};
			let result;
			try {
				result = original.apply(this, args);
				if (result && typeof result.then === "function") {
					return Promise.resolve(result).then(value => finish(false, value), error => finish(true, error));
				}
			} catch (error) {
				return finish(true, error);
			}
			return finish(false, result);
		};
		entry.job = wrapped;
		this._wrappedEntries.set(entry, { original, wrapped });
	}

	async getQueueStats() {
		// Cron has no queue of pending executions. Registered recurring definitions
		// are not queued jobs; report only executions actually running on this host.
		const registered = new Set(Object.values(this._cron?._entries || {}));
		for (const [entry, record] of this._wrappedEntries) {
			if (!registered.has(entry)) {
				if (entry.job === record.wrapped) entry.job = record.original;
				this._wrappedEntries.delete(entry);
			}
		}
		return { queueLength: 0, workersActive: this.trackedJobs.size ? 1 : 0, workersTotal: 1 };
	}

	cleanupHooks() {
		if (this._cron && this._entryWrapper && this._cron._entryWrapper === this._entryWrapper) {
			this._cron._entryWrapper = this._originalEntryWrapper;
		}
		for (const [entry, record] of this._wrappedEntries) {
			if (entry.job === record.wrapped) entry.job = record.original;
		}
		this._wrappedEntries.clear();
	}

	stop() {
		this._generation++;
		this.started = false;
		this.cleanupHooks();
		// Preserve the shared unknown-on-stop behavior, even if telemetry throws.
		this._safely(() => super.stop());
		this.trackedJobs.clear();
	}
}
