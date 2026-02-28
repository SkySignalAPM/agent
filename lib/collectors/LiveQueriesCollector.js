import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";
import { Random } from "meteor/random";

/**
 * LiveQueriesCollector
 * Tracks Meteor's reactive observers (Live Queries) to monitor oplog vs polling usage
 *
 * Monitors:
 * - Observer type (changeStream, oplog tailing, or polling)
 * - Number of active observers per collection
 * - Observer performance and efficiency
 * - Document update rates
 *
 * Hooks into MongoInternals.Connection.prototype._observeChanges — the single
 * bottleneck ALL server-side observe/observeChanges calls pass through.
 * This is more reliable than wrapping Mongo.Collection.prototype.find because:
 * - It is already async (no Promise confusion)
 * - It receives the real ObserveHandle directly
 * - It captures ALL observers regardless of how the cursor was created
 */
export default class LiveQueriesCollector {
	constructor(options = {}) {
		this.client = options.client; // SkySignalClient instance
		this.host = options.host || "unknown-host";
		this.appVersion = options.appVersion || "unknown";
		this.buildHash = options.buildHash || null;
		this.interval = options.interval || 60000; // 60 seconds default

		// Performance thresholds (can be overridden via config)
		this.thresholds = {
			changeStream: {
				optimal: { maxProcessingTime: 20 },
				good: { maxProcessingTime: 50 },
				slow: { maxProcessingTime: Infinity }
			},
			oplog: {
				optimal: { maxBacklog: 50, maxProcessingTime: 20 },
				good: { maxBacklog: 100, maxProcessingTime: 50 },
				slow: { maxBacklog: Infinity, maxProcessingTime: Infinity }
			},
			polling: {
				optimal: { maxUpdatesPerMin: 5 },
				good: { maxUpdatesPerMin: 10 },
				inefficient: { maxUpdatesPerMin: 60 }
			},
			...(options.performanceThresholds || {})
		};

		this.debug = options.debug || false;
		this.observers = new Map(); // observerId -> observer data
		this.maxObservers = options.maxObservers || 5000; // Prevent unbounded growth
		this.intervalId = null;
		this.wrappingApplied = false;
		this._originalObserveChanges = null;
	}

	/** @private */
	_log(...args) {
		if (this.debug) {
			console.log('[SkySignal:LiveQueries]', ...args);
		}
	}

	start() {
		if (this.intervalId) {
			return;
		}

		this._setupObserverTracking();

		this.intervalId = setInterval(() => {
			this._sendUpdates();
		}, this.interval);

		this._log(`Started (interval: ${this.interval}ms, wrappingApplied: ${this.wrappingApplied})`);
	}

	/**
	 * Stop collecting live query data
	 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		// Restore original _observeChanges if we wrapped it
		if (this._originalObserveChanges && typeof MongoInternals !== 'undefined' && MongoInternals.Connection) {
			MongoInternals.Connection.prototype._observeChanges = this._originalObserveChanges;
			this._originalObserveChanges = null;
		}

		// Send final batch
		this._sendUpdates();

		this.observers.clear();
		this.wrappingApplied = false;
		this._log('Stopped');
	}

	/**
	 * Setup observer tracking by wrapping MongoInternals.Connection.prototype._observeChanges.
	 *
	 * This is the single async method ALL server-side observe/observeChanges calls
	 * funnel through (including calls from Meteor's _publishCursor).
	 * It receives (cursorDescription, ordered, callbacks, nonMutatingCallbacks)
	 * and returns a Promise<ObserveHandle>.
	 *
	 * Fallback: if MongoInternals is unavailable, wraps Mongo.Collection.prototype.find
	 * to patch individual cursor instances.
	 * @private
	 */
	_setupObserverTracking() {
		if (this.wrappingApplied) {
			console.warn("⚠️ LiveQueriesCollector: Observer tracking already setup");
			return;
		}

		const self = this;

		const hasMongoInternals = typeof MongoInternals !== 'undefined';
		const hasConnection = hasMongoInternals && !!MongoInternals.Connection;
		const hasPrototype = hasConnection && !!MongoInternals.Connection.prototype;
		const hasObserveChanges = hasPrototype && typeof MongoInternals.Connection.prototype._observeChanges === 'function';

		this._log('Setup diagnostics:', { hasMongoInternals, hasConnection, hasObserveChanges });

		try {
			// Primary approach: wrap MongoInternals.Connection.prototype._observeChanges
			if (hasObserveChanges) {
				const originalObserveChanges = MongoInternals.Connection.prototype._observeChanges;
				this._originalObserveChanges = originalObserveChanges;

				MongoInternals.Connection.prototype._observeChanges = async function(
					cursorDescription, ordered, callbacks, nonMutatingCallbacks
				) {
					const collectionName = cursorDescription?.collectionName || '(unknown)';

					// Create a provisional observer data object BEFORE calling the
					// original so that wrapped callbacks can count initial documents.
					// The 'added' callbacks fire during the await (as the initial
					// document set is fetched), so the ref must be live by then.
					const observerRef = { data: null };
					if (cursorDescription?.collectionName) {
						observerRef.data = self._createObserverData(collectionName);
						observerRef.data.query = self._sanitizeQuery(cursorDescription.selector);
						// Store static cursor metadata (limit, sort, projection)
						self._extractCursorMetadata(observerRef.data, cursorDescription);
					}
					const wrappedCallbacks = self._wrapCallbacks(callbacks, observerRef);

					// Time the initial query
					const startTime = Date.now();
					let handle;
					try {
						handle = await originalObserveChanges.call(
							this, cursorDescription, ordered, wrappedCallbacks, nonMutatingCallbacks
						);
					} catch (err) {
						if (observerRef.data) {
							self.observers.delete(observerRef.data.observerId);
						}
						throw err;
					}
					const initialQueryMs = Date.now() - startTime;

					try {
						if (cursorDescription?.collectionName) {
							const driverType = self._detectDriverType(handle);
							if (observerRef.data) {
								observerRef.data.initialQueryMs = initialQueryMs;
							}
							self._finalizeObserver(observerRef.data, handle, driverType);
							self._wrapHandle(handle);
							self._log(`Observer tracked: "${collectionName}" driver=${driverType}, initialQuery=${initialQueryMs}ms, total=${self.observers.size}`);
						}
					} catch (e) {
						console.error('[SkySignal:LiveQueries] Error tracking observer:', e.message);
					}

					return handle;
				};

				this.wrappingApplied = true;
				this._log('Wrapping applied to MongoInternals.Connection.prototype._observeChanges');
				return;
			}

			this._log('MongoInternals._observeChanges not available, trying fallback...');
			this._setupFallbackTracking();
		} catch (error) {
			console.error("⚠️ Failed to setup observer tracking:", error.message);
		}
	}

	/**
	 * Wrap observeChanges callbacks to count added/changed/removed events.
	 * The observerRef.data is set by _createObserverData before the await,
	 * so event counting begins immediately (including the initial document
	 * set fetched during _observeChanges).
	 * @private
	 */
	_wrapCallbacks(callbacks, observerRef) {
		if (!callbacks || typeof callbacks !== 'object') return callbacks;

		const wrapped = {};

		// Copy all existing callback properties
		for (const key of Object.keys(callbacks)) {
			wrapped[key] = callbacks[key];
		}

		// Wrap 'added' / 'addedBefore' to count documents
		const addedKey = typeof callbacks.addedBefore === 'function' ? 'addedBefore' : 'added';
		if (typeof callbacks[addedKey] === 'function') {
			const originalAdded = callbacks[addedKey];
			wrapped[addedKey] = function(...args) {
				const data = observerRef.data;
				if (data) {
					if (!data._initialLoadComplete) {
						data.addedInitially++;
						data.documentCount++;
					} else {
						data.addedCount++;
						data.documentCount++;
						data.liveUpdateCount++;
						data.lastActivityAt = Date.now();
					}
				}
				return originalAdded.apply(this, args);
			};
		}

		// Wrap 'changed' to count updates
		if (typeof callbacks.changed === 'function') {
			const originalChanged = callbacks.changed;
			wrapped.changed = function(...args) {
				const data = observerRef.data;
				if (data) {
					data.changedCount++;
					data.liveUpdateCount++;
					data.lastActivityAt = Date.now();
				}
				return originalChanged.apply(this, args);
			};
		}

		// Wrap 'removed' to count removals
		if (typeof callbacks.removed === 'function') {
			const originalRemoved = callbacks.removed;
			wrapped.removed = function(...args) {
				const data = observerRef.data;
				if (data) {
					data.removedCount++;
					data.documentCount = Math.max(0, data.documentCount - 1);
					data.liveUpdateCount++;
					data.lastActivityAt = Date.now();
				}
				return originalRemoved.apply(this, args);
			};
		}

		return wrapped;
	}

	/**
	 * Fallback tracking via Mongo.Collection.prototype.find wrapping.
	 * Used when MongoInternals is not available (unlikely on server).
	 * @private
	 */
	_setupFallbackTracking() {
		const self = this;
		const originalFind = Mongo.Collection.prototype.find;

		Mongo.Collection.prototype.find = function(...args) {
			const cursor = originalFind.apply(this, args);
			const collectionName = this._name;

			if (!collectionName) {
				return cursor;
			}

			const originalObserveChanges = cursor.observeChanges;

			cursor.observeChanges = function(callbacks, ...rest) {
				const observerRef = { data: null };
				observerRef.data = self._createObserverData(collectionName);
				observerRef.data.query = self._sanitizeQuery(args[0]);
				const wrappedCallbacks = self._wrapCallbacks(callbacks, observerRef);

				const result = originalObserveChanges.call(this, wrappedCallbacks, ...rest);

				if (result && typeof result.then === 'function') {
					return result.then(handle => {
						const driverType = self._detectDriverType(handle);
						self._finalizeObserver(observerRef.data, handle, driverType);
						self._wrapHandle(handle);
						return handle;
					}).catch(err => {
						self.observers.delete(observerRef.data.observerId);
						throw err;
					});
				}
				const driverType = self._detectDriverType(result);
				self._finalizeObserver(observerRef.data, result, driverType);
				self._wrapHandle(result);
				return result;
			};

			return cursor;
		};

		this.wrappingApplied = true;
		this._log('Fallback wrapping applied to Mongo.Collection.prototype.find');
	}

	/**
	 * Detect which observe driver is being used for a given handle.
	 * Inspects Meteor internals on the observe handle/multiplexer to determine
	 * if the observer is using Change Streams (Meteor 3.5+), Oplog, or Polling.
	 * Falls back gracefully for older Meteor versions.
	 * @private
	 * @returns {"changeStream"|"oplog"|"polling"}
	 */
	_detectDriverType(handle) {
		try {
			// The observe handle has a _multiplexer which has an _observeDriver
			// Meteor names these: ChangeStreamObserveDriver, OplogObserveDriver, PollingObserveDriver
			const multiplexer = handle._multiplexer;
			if (multiplexer) {
				const driver = multiplexer._observeDriver;
				if (driver) {
					const constructorName = driver.constructor?.name || "";

					if (constructorName.includes("ChangeStream")) {
						return "changeStream";
					}
					if (constructorName.includes("Oplog")) {
						return "oplog";
					}
					if (constructorName.includes("Polling")) {
						return "polling";
					}

					// Fallback: check for driver-specific properties
					// ChangeStreamObserveDriver uses a MongoDB change stream cursor
					if (driver._changeStream || driver._pipeline !== undefined) {
						return "changeStream";
					}
					// OplogObserveDriver has _needToFetch / _usesOplog properties
					if (driver._usesOplog || driver._needToFetch !== undefined) {
						return "oplog";
					}
				}
			}
		} catch (_e) {
			// Swallow introspection errors silently
		}

		// Fallback for pre-3.5 or when introspection fails:
		// use the global MONGO_OPLOG_URL heuristic
		return process.env.MONGO_OPLOG_URL ? "oplog" : "polling";
	}

	/**
	 * Create a provisional observer data object.
	 * Called BEFORE _observeChanges so that wrapped callbacks can count
	 * initial documents arriving during the await.
	 * @private
	 */
	_createObserverData(collectionName) {
		const now = Date.now();
		const observerId = Random.id();

		const observerData = {
			observerId,
			collectionName,
			query: {},
			publicationName: null,
			observerType: "unknown",
			isOplogEfficient: false,
			observerCount: 1,
			handlersSharing: 1,
			documentCount: 0,
			fetchedDocuments: 0,
			liveUpdateCount: 0,
			updatesPerMinute: 0,
			addedCount: 0,
			addedInitially: 0,
			changedCount: 0,
			removedCount: 0,
			avgProcessingTime: null,
			backlogSize: 0,
			observerLifespan: 0,
			createdAt: now,
			stoppedAt: null,
			lastActivityAt: now,
			timestamp: now,
			status: "active",
			performance: null,
			host: this.host,
			// Tier 1: Driver health metrics (snapshotted each send interval)
			initialQueryMs: null,
			oplogPhase: null,        // "STEADY" | "QUERYING" | "FETCHING" (oplog only)
			phaseAge: null,          // ms in current phase
			fetchBacklog: 0,         // _needToFetch.size() (oplog only)
			activeFetches: 0,        // _currentlyFetching.size() (oplog only)
			blockedWrites: 0,        // writes blocked on this observer
			// Tier 2: Efficiency & memory metrics
			publishedCount: 0,       // driver._published.size() or cache docs
			pollingIntervalMs: null,  // polling interval (polling only)
			pollingThrottleMs: null,  // polling throttle (polling only)
			pendingPolls: 0,         // polls backing up (polling only)
			hasLimit: false,
			queryLimit: 0,
			bufferCount: 0,          // _unpublishedBuffer.size() (limited oplog only)
			// Tier 3: Query shape
			hasProjection: false,
			// Internal tracking (not transmitted)
			_multiplexerRef: null,
			_handleRef: null,
			_lastUpdateCount: 0,
			_lastUpdateTime: now,
			_processingTimes: [],
			_initialLoadComplete: false
		};

		// Enforce max observers limit
		if (this.observers.size >= this.maxObservers) {
			this._evictOldestObservers();
		}

		this.observers.set(observerId, observerData);
		return observerData;
	}

	/**
	 * Finalize observer after _observeChanges returns.
	 *
	 * Deduplication: Meteor reuses ObserveMultiplexers for identical queries.
	 * If the handle's multiplexer matches an existing tracked observer, we
	 * merge into it (incrementing handlersSharing) and discard the provisional
	 * data. This ensures observer count matches actual server-side resources.
	 * @private
	 */
	_finalizeObserver(observerData, handle, driverType) {
		const multiplexer = handle?._multiplexer;

		// Check if another observer already tracks this multiplexer
		if (multiplexer) {
			for (const [id, obs] of this.observers.entries()) {
				if (obs !== observerData && obs._multiplexerRef === multiplexer && obs.status === "active") {
					// Merge: fold the provisional data's initial counts into the existing observer
					obs.handlersSharing++;
					obs.addedInitially += observerData.addedInitially;
					obs.documentCount += observerData.documentCount;

					// Remove the provisional entry
					this.observers.delete(observerData.observerId);

					handle._skySignalObserverId = obs.observerId;
					handle._skySignalHandlerId = Random.id();
					this._log(`Reusing observer: ${obs.collectionName} (${obs.handlersSharing} handlers) - ${id}`);
					return;
				}
			}
		}

		// No duplicate — finalize the provisional data with handle info
		observerData._multiplexerRef = multiplexer || null;
		observerData._handleRef = handle;
		observerData.observerType = driverType;
		observerData.isOplogEfficient = driverType !== "polling";

		// Take initial driver snapshot (polling interval, etc.)
		this._snapshotDriverMetrics(observerData);

		// Mark initial load as complete after a short delay.
		// Initial 'added' callbacks fired during the await, but there may
		// be a small async tail. 200ms grace period handles that.
		observerData._initialLoadTimer = setTimeout(() => {
			observerData._initialLoadTimer = null;
			observerData._initialLoadComplete = true;
			observerData.fetchedDocuments = observerData.addedInitially;
		}, 200);

		handle._skySignalObserverId = observerData.observerId;
		handle._skySignalHandlerId = Random.id();
	}

	/**
	 * Extract static cursor metadata (limit, projection, polling config).
	 * Called once when the observer is first created.
	 * @private
	 */
	_extractCursorMetadata(observerData, cursorDescription) {
		try {
			const opts = cursorDescription?.options || {};
			observerData.hasLimit = (opts.limit || 0) > 0;
			observerData.queryLimit = opts.limit || 0;
			observerData.hasProjection = !!(opts.fields || opts.projection);

			// Polling interval overrides (from cursor options or env)
			if (opts.pollingIntervalMs || opts._pollingInterval) {
				observerData.pollingIntervalMs = opts.pollingIntervalMs || opts._pollingInterval;
			}
			if (opts.pollingThrottleMs) {
				observerData.pollingThrottleMs = opts.pollingThrottleMs;
			}
		} catch (_e) {
			// Non-critical — swallow introspection errors
		}
	}

	/**
	 * Snapshot point-in-time driver metrics from the live handle.
	 * Called on each _sendUpdates tick for active observers to capture
	 * the current state of the oplog/polling driver internals.
	 * @private
	 */
	_snapshotDriverMetrics(observerData) {
		try {
			const multiplexer = observerData._multiplexerRef;
			if (!multiplexer) return;

			const driver = multiplexer._observeDriver;
			if (!driver) return;

			// Multiplexer-level: published doc count from cache
			if (multiplexer._cache?.docs) {
				const docs = multiplexer._cache.docs;
				observerData.publishedCount = typeof docs.size === 'function' ? docs.size() : 0;
			}

			if (observerData.observerType === "oplog") {
				// OplogObserveDriver internals
				if (driver._phase) {
					observerData.oplogPhase = driver._phase;
				}
				if (driver._phaseStartTime) {
					observerData.phaseAge = Date.now() - driver._phaseStartTime.getTime();
				}
				// Fetch backlog: docs waiting to be re-fetched from MongoDB
				if (driver._needToFetch) {
					observerData.fetchBacklog = typeof driver._needToFetch.size === 'function'
						? driver._needToFetch.size() : 0;
				}
				// Active fetches in flight
				if (driver._currentlyFetching) {
					observerData.activeFetches = typeof driver._currentlyFetching.size === 'function'
						? driver._currentlyFetching.size() : 0;
				}
				// Writes blocked waiting for STEADY phase
				if (driver._writesToCommitWhenWeReachSteady) {
					observerData.blockedWrites = driver._writesToCommitWhenWeReachSteady.length;
				}
				// Published doc set size
				if (driver._published) {
					observerData.publishedCount = typeof driver._published.size === 'function'
						? driver._published.size() : 0;
				}
				// Unpublished buffer (limited queries only)
				if (driver._unpublishedBuffer) {
					observerData.bufferCount = typeof driver._unpublishedBuffer.size === 'function'
						? driver._unpublishedBuffer.size() : 0;
				}
				// Populate backlogSize for performance rating calculation
				observerData.backlogSize = observerData.fetchBacklog;
			} else if (observerData.observerType === "polling") {
				// PollingObserveDriver internals
				if (typeof driver._pollsScheduledButNotStarted === 'number') {
					observerData.pendingPolls = driver._pollsScheduledButNotStarted;
				}
				if (driver._pendingWrites) {
					observerData.blockedWrites = driver._pendingWrites.length;
				}
				// Result set size
				if (driver._results) {
					observerData.publishedCount = typeof driver._results.size === 'function'
						? driver._results.size()
						: Array.isArray(driver._results) ? driver._results.length : 0;
				}
				// Polling config from env defaults if not set from cursor options
				if (!observerData.pollingIntervalMs) {
					observerData.pollingIntervalMs = parseInt(process.env.METEOR_POLLING_INTERVAL_MS, 10) || 10000;
				}
				if (!observerData.pollingThrottleMs) {
					observerData.pollingThrottleMs = parseInt(process.env.METEOR_POLLING_THROTTLE_MS, 10) || 50;
				}
			}
		} catch (_e) {
			// Non-critical — swallow introspection errors
		}
	}

	/**
	 * Wrap observer handle to track when it's stopped
	 * @private
	 */
	_wrapHandle(handle) {
		const self = this;
		const originalStop = handle.stop;

		handle.stop = function() {
			const observerId = handle._skySignalObserverId;
			if (observerId) {
				const observer = self.observers.get(observerId);
				if (observer) {
					// Clear initial load timer if still pending
					if (observer._initialLoadTimer) {
						clearTimeout(observer._initialLoadTimer);
						observer._initialLoadTimer = null;
					}
					observer.status = "stopped";
					observer.stoppedAt = Date.now();
					observer.observerLifespan = Math.round((observer.stoppedAt - observer.createdAt) / 1000);
					self._log(`Observer stopped: ${observer.collectionName} - ${observerId}`);
				}
			}
			return originalStop.call(this);
		};

		return handle;
	}

	/**
	 * Update activity rate (updates per minute)
	 * @private
	 */
	_updateActivityRate(observerData) {
		const now = Date.now();
		const timeSinceLastUpdate = now - observerData._lastUpdateTime;
		const totalUpdates = observerData.addedCount + observerData.changedCount + observerData.removedCount;
		const newUpdates = totalUpdates - observerData._lastUpdateCount;

		if (timeSinceLastUpdate > 0) {
			// Calculate updates per minute
			const updatesPerMs = newUpdates / timeSinceLastUpdate;
			observerData.updatesPerMinute = Math.round(updatesPerMs * 60 * 1000);

			observerData._lastUpdateCount = totalUpdates;
			observerData._lastUpdateTime = now;
		}
	}

	/**
	 * Evict oldest observers when limit is reached
	 * Prioritizes stopped observers, then oldest active observers
	 * @private
	 */
	_evictOldestObservers() {
		const evictCount = Math.floor(this.maxObservers * 0.1); // Evict 10%

		// Collect all observers with their age
		const observerList = Array.from(this.observers.entries()).map(([id, obs]) => ({
			id,
			obs,
			isStopped: obs.status === "stopped",
			createdAt: obs.createdAt
		}));

		// Sort: stopped first, then by age (oldest first)
		observerList.sort((a, b) => {
			if (a.isStopped !== b.isStopped) {
				return a.isStopped ? -1 : 1; // Stopped observers first
			}
			return a.createdAt - b.createdAt; // Then by age
		});

		// Evict the first N observers
		let evicted = 0;
		for (const { id } of observerList) {
			if (evicted >= evictCount) break;
			this.observers.delete(id);
			evicted++;
		}

		if (evicted > 0) {
			console.warn(`⚠️ LiveQueriesCollector: Observer limit reached (${this.maxObservers}), evicted ${evicted} oldest observers`);
		}
	}

	/**
	 * Sanitize query to remove sensitive data
	 * @private
	 */
	_sanitizeQuery(query) {
		if (!query || typeof query !== "object") {
			return {};
		}

		const sanitized = { ...query };

		// Remove sensitive fields
		const sensitiveFields = ["password", "token", "secret", "apiKey", "accessToken", "refreshToken"];
		sensitiveFields.forEach(field => {
			if (sanitized[field]) {
				sanitized[field] = "[REDACTED]";
			}
		});

		return sanitized;
	}

	/**
	 * Calculate performance rating based on thresholds
	 * @private
	 */
	_calculatePerformance(observer) {
		if (observer.observerType === "changeStream") {
			const { avgProcessingTime } = observer;
			const { optimal, good } = this.thresholds.changeStream;

			if (avgProcessingTime === null || avgProcessingTime <= optimal.maxProcessingTime) {
				return "optimal";
			}
			if (avgProcessingTime <= good.maxProcessingTime) {
				return "good";
			}
			return "slow";
		} else if (observer.observerType === "oplog") {
			const backlog = observer.fetchBacklog || observer.backlogSize || 0;
			const { optimal, good } = this.thresholds.oplog;

			// Immediate red flag: driver not in STEADY phase or has blocked writes
			if (observer.blockedWrites > 0 || observer.oplogPhase === "QUERYING") {
				return "slow";
			}

			if (
				backlog <= optimal.maxBacklog &&
				(observer.avgProcessingTime === null || observer.avgProcessingTime <= optimal.maxProcessingTime)
			) {
				return "optimal";
			}

			if (
				backlog <= good.maxBacklog &&
				(observer.avgProcessingTime === null || observer.avgProcessingTime <= good.maxProcessingTime)
			) {
				return "good";
			}

			return "slow";
		} else {
			// Polling observer
			const { updatesPerMinute, pendingPolls } = observer;
			const { optimal, good } = this.thresholds.polling;

			// Pending polls backing up = definitely inefficient
			if (pendingPolls > 1 || observer.blockedWrites > 0) {
				return "inefficient";
			}

			if (updatesPerMinute <= optimal.maxUpdatesPerMin) {
				return "optimal";
			}

			if (updatesPerMinute <= good.maxUpdatesPerMin) {
				return "good";
			}

			return "inefficient";
		}
	}

	/**
	 * Send updates to platform
	 * @private
	 */
	_sendUpdates() {

		if (this.observers.size === 0) {
			return;
		}

		const observers = Array.from(this.observers.values())
			.map(obs => {
				// Recalculate activity rate before sending
				this._updateActivityRate(obs);
				// Snapshot live driver metrics for active observers
				if (obs.status === "active") {
					this._snapshotDriverMetrics(obs);
				}

				const lifespan = Math.round((Date.now() - obs.createdAt) / 1000);
				const performance = this._calculatePerformance(obs);

				return {
					observerId: obs.observerId,
					collectionName: obs.collectionName,
					query: obs.query,
					publicationName: obs.publicationName,
					observerType: obs.observerType,
					isOplogEfficient: obs.isOplogEfficient,
					observerCount: obs.observerCount,
					handlersSharing: obs.handlersSharing,
					documentCount: obs.documentCount,
					updatesPerMinute: obs.updatesPerMinute,
					addedCount: obs.addedCount,
					changedCount: obs.changedCount,
					removedCount: obs.removedCount,
					avgProcessingTime: obs.avgProcessingTime,
					backlogSize: obs.backlogSize,
					observerLifespan: lifespan,
					createdAt: obs.createdAt,
					stoppedAt: obs.stoppedAt,
					lastActivityAt: obs.lastActivityAt,
					timestamp: Date.now(),
					status: obs.status,
					performance,
					host: obs.host,
					appVersion: this.appVersion,
					buildHash: this.buildHash,
					// Tier 1: Driver health
					initialQueryMs: obs.initialQueryMs,
					oplogPhase: obs.oplogPhase,
					phaseAge: obs.phaseAge,
					fetchBacklog: obs.fetchBacklog,
					activeFetches: obs.activeFetches,
					blockedWrites: obs.blockedWrites,
					// Tier 2: Efficiency
					publishedCount: obs.publishedCount,
					pollingIntervalMs: obs.pollingIntervalMs,
					pollingThrottleMs: obs.pollingThrottleMs,
					pendingPolls: obs.pendingPolls,
					hasLimit: obs.hasLimit,
					queryLimit: obs.queryLimit,
					bufferCount: obs.bufferCount,
					// Tier 3: Query shape
					hasProjection: obs.hasProjection
				};
			});

		// Send to platform
		if (this.client && observers.length > 0) {
			this.client.sendLiveQueries(observers);
			this._log(`Sent ${observers.length} observer records`);
		}

		// Clean up stopped observers older than 5 minutes
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		this.observers.forEach((obs, id) => {
			if (obs.status === "stopped" && obs.stoppedAt && obs.stoppedAt < fiveMinutesAgo) {
				this.observers.delete(id);
			}
		});
	}

	/**
	 * Get current stats (for debugging)
	 */
	getStats() {
		const activeObservers = Array.from(this.observers.values()).filter(o => o.status === "active");
		const changeStreamObservers = activeObservers.filter(o => o.observerType === "changeStream");
		const oplogObservers = activeObservers.filter(o => o.observerType === "oplog");
		const pollingObservers = activeObservers.filter(o => o.observerType === "polling");
		const efficientCount = changeStreamObservers.length + oplogObservers.length;

		return {
			totalObservers: activeObservers.length,
			changeStreamObservers: changeStreamObservers.length,
			oplogObservers: oplogObservers.length,
			pollingObservers: pollingObservers.length,
			reactiveEfficiency:
				activeObservers.length > 0 ? Math.round((efficientCount / activeObservers.length) * 100) : 100,
			collections: [...new Set(activeObservers.map(o => o.collectionName))],
			observers: activeObservers.map(o => ({
				id: o.observerId,
				collection: o.collectionName,
				type: o.observerType,
				documents: o.documentCount,
				performance: this._calculatePerformance(o)
			}))
		};
	}
}
