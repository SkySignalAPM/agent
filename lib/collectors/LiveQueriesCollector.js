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

		this.observers = new Map(); // observerId -> observer data
		this.maxObservers = options.maxObservers || 5000; // Prevent unbounded growth
		this.intervalId = null;
		this.wrappingApplied = false;
	}

	/**
	 * Start collecting live query data
	 */
	start() {
		if (this.intervalId) {
			console.warn("⚠️ LiveQueriesCollector already started");
			return;
		}

		// Setup observer tracking
		this._setupObserverTracking();

		// Send updates at regular intervals
		this.intervalId = setInterval(() => {
			this._sendUpdates();
		}, this.interval);

		console.log(`✅ LiveQueriesCollector started (interval: ${this.interval}ms)`);
	}

	/**
	 * Stop collecting live query data
	 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		// Send final batch
		this._sendUpdates();

		this.observers.clear();
		console.log("⏹️ LiveQueriesCollector stopped");
	}

	/**
	 * Setup observer tracking by wrapping Mongo.Collection.prototype.find
	 * @private
	 */
	_setupObserverTracking() {
		if (this.wrappingApplied) {
			console.warn("⚠️ Observer tracking already setup");
			return;
		}

		const self = this;

		try {
			// Store original find method
			const originalFind = Mongo.Collection.prototype.find;

			// Wrap Mongo.Collection.prototype.find to intercept cursors
			Mongo.Collection.prototype.find = function(...args) {
				// Call original find to get the cursor
				const cursor = originalFind.apply(this, args);
				const collectionName = this._name;

				// Only track if collection has a name (skip local collections)
				if (!collectionName) {
					return cursor;
				}

				// Store original observe methods
				const originalObserve = cursor.observe;
				const originalObserveChanges = cursor.observeChanges;

				// Wrap cursor.observe
				cursor.observe = function(callbacks) {
					const handle = originalObserve.call(this, callbacks);
					const driverType = self._detectDriverType(handle);
					self._trackObserver(collectionName, args[0], args[1], "observe", handle, driverType, callbacks);
					return self._wrapHandle(handle);
				};

				// Wrap cursor.observeChanges
				cursor.observeChanges = function(callbacks) {
					const handle = originalObserveChanges.call(this, callbacks);
					const driverType = self._detectDriverType(handle);
					self._trackObserver(collectionName, args[0], args[1], "observeChanges", handle, driverType, callbacks);
					return self._wrapHandle(handle);
				};

				return cursor;
			};

			this.wrappingApplied = true;
			console.log("✅ Observer tracking enabled (driver detection: per-observer)");
		} catch (error) {
			console.error("⚠️ Failed to setup observer tracking:", error.message);
		}
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
	 * Generate a query signature for detecting observer reuse
	 * @private
	 */
	_generateQuerySignature(collectionName, selector, options) {
		// Create a stable string representation of the query
		const queryString = JSON.stringify({
			collection: collectionName,
			selector: selector || {},
			options: options || {}
		});

		// Simple hash function (FNV-1a)
		let hash = 2166136261;
		for (let i = 0; i < queryString.length; i++) {
			hash ^= queryString.charCodeAt(i);
			hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
		}
		return (hash >>> 0).toString(36);
	}

	/**
	 * Track a new observer/handler
	 * @private
	 */
	_trackObserver(collectionName, selector, options, type, handle, driverType, callbacks) {
		const handlerId = Random.id();
		const now = new Date();

		// Generate query signature for detecting reuse
		const querySignature = this._generateQuerySignature(collectionName, selector, options);

		// Sanitize query to remove sensitive data
		const sanitizedQuery = this._sanitizeQuery(selector);

		// Check if an observer with this query signature already exists
		let existingObserver = null;
		for (const [id, obs] of this.observers.entries()) {
			if (obs.querySignature === querySignature && obs.status === "active") {
				existingObserver = obs;
				break;
			}
		}

		if (existingObserver) {
			// Reusing existing observer - increment handler count
			existingObserver.handlersSharing++;
			console.log(`♻️ Reusing observer: ${collectionName} (${existingObserver.handlersSharing} handlers) - ${existingObserver.observerId}`);

			// Store reference for this handler
			handle._skySignalObserverId = existingObserver.observerId;
			handle._skySignalHandlerId = handlerId;
			return;
		}

		// Create new observer tracking data
		const observerId = Random.id();
		const observerData = {
			observerId,
			handlerId,
			querySignature,
			collectionName,
			query: sanitizedQuery,
			publicationName: null, // Not easily available without hacks
			observerType: driverType, // "changeStream", "oplog", or "polling"
			isOplogEfficient: driverType !== "polling",
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
			// Internal tracking
			_lastUpdateCount: 0,
			_lastUpdateTime: Date.now(),
			_processingTimes: [],
			_initialLoadComplete: false // Track when initial fetch is done
		};

		// Wrap callbacks to track activity
		if (type === "observe") {
			observerData._wrappedCallbacks = this._wrapObserveCallbacks(observerData, callbacks);
		} else if (type === "observeChanges") {
			observerData._wrappedCallbacks = this._wrapObserveChangesCallbacks(observerData, callbacks);
		}

		// Enforce max observers limit before adding new one
		if (this.observers.size >= this.maxObservers) {
			this._evictOldestObservers();
		}

		this.observers.set(observerId, observerData);

		const driverLabel = { changeStream: "change stream", oplog: "oplog", polling: "polling" };
		console.log(`📡 Tracking new observer: ${collectionName} (${driverLabel[observerData.observerType] || observerData.observerType}) - ${observerId}`);

		// Mark initial load as complete after a short delay
		// Initial documents come synchronously, live updates come asynchronously
		// Store timer ID for cleanup if observer stops before timer fires
		observerData._initialLoadTimer = setTimeout(() => {
			observerData._initialLoadTimer = null;
			observerData._initialLoadComplete = true;
			observerData.fetchedDocuments = observerData.addedInitially;
		}, 200);

		// Store observerId and handlerId on the handle for cleanup
		handle._skySignalObserverId = observerId;
		handle._skySignalHandlerId = handlerId;
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
					observer.stoppedAt = new Date();
					observer.observerLifespan = Math.round((observer.stoppedAt - observer.createdAt) / 1000);
					console.log(`🛑 Observer stopped: ${observer.collectionName} - ${observerId}`);
				}
			}
			return originalStop.call(this);
		};

		return handle;
	}

	/**
	 * Wrap observe callbacks to track document changes
	 * @private
	 */
	_wrapObserveCallbacks(observerData, callbacks) {
		const self = this;
		const wrapped = {};

		if (callbacks.added) {
			const originalAdded = callbacks.added;
			wrapped.added = function(document) {
				observerData.addedCount++;
				observerData.documentCount++;
				observerData.lastActivityAt = new Date();

				// Track initial fetch vs live updates
				if (!observerData._initialLoadComplete) {
					observerData.addedInitially++;
				} else {
					observerData.liveUpdateCount++;
				}

				self._updateActivityRate(observerData);
				return originalAdded.call(this, document);
			};
		}

		if (callbacks.changed) {
			const originalChanged = callbacks.changed;
			wrapped.changed = function(newDocument, oldDocument) {
				observerData.changedCount++;
				observerData.liveUpdateCount++; // Changes are always live updates
				observerData.lastActivityAt = new Date();
				self._updateActivityRate(observerData);
				return originalChanged.call(this, newDocument, oldDocument);
			};
		}

		if (callbacks.removed) {
			const originalRemoved = callbacks.removed;
			wrapped.removed = function(oldDocument) {
				observerData.removedCount++;
				observerData.liveUpdateCount++; // Removes are always live updates
				observerData.documentCount = Math.max(0, observerData.documentCount - 1);
				observerData.lastActivityAt = new Date();
				self._updateActivityRate(observerData);
				return originalRemoved.call(this, oldDocument);
			};
		}

		return wrapped;
	}

	/**
	 * Wrap observeChanges callbacks to track document changes
	 * @private
	 */
	_wrapObserveChangesCallbacks(observerData, callbacks) {
		const self = this;
		const wrapped = {};

		if (callbacks.added) {
			const originalAdded = callbacks.added;
			wrapped.added = function(id, fields) {
				observerData.addedCount++;
				observerData.documentCount++;
				observerData.lastActivityAt = new Date();

				// Track initial fetch vs live updates
				if (!observerData._initialLoadComplete) {
					observerData.addedInitially++;
				} else {
					observerData.liveUpdateCount++;
				}

				self._updateActivityRate(observerData);
				return originalAdded.call(this, id, fields);
			};
		}

		if (callbacks.changed) {
			const originalChanged = callbacks.changed;
			wrapped.changed = function(id, fields) {
				observerData.changedCount++;
				observerData.liveUpdateCount++; // Changes are always live updates
				observerData.lastActivityAt = new Date();
				self._updateActivityRate(observerData);
				return originalChanged.call(this, id, fields);
			};
		}

		if (callbacks.removed) {
			const originalRemoved = callbacks.removed;
			wrapped.removed = function(id) {
				observerData.removedCount++;
				observerData.liveUpdateCount++; // Removes are always live updates
				observerData.documentCount = Math.max(0, observerData.documentCount - 1);
				observerData.lastActivityAt = new Date();
				self._updateActivityRate(observerData);
				return originalRemoved.call(this, id);
			};
		}

		return wrapped;
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
			createdAt: obs.createdAt.getTime()
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
			// Change streams process data as it flows — no backlog accumulation.
			// Performance is measured solely by processing time.
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
			const { backlogSize, avgProcessingTime } = observer;
			const { optimal, good } = this.thresholds.oplog;

			if (
				backlogSize <= optimal.maxBacklog &&
				(avgProcessingTime === null || avgProcessingTime <= optimal.maxProcessingTime)
			) {
				return "optimal";
			}

			if (
				backlogSize <= good.maxBacklog &&
				(avgProcessingTime === null || avgProcessingTime <= good.maxProcessingTime)
			) {
				return "good";
			}

			return "slow";
		} else {
			// Polling observer
			const { updatesPerMinute } = observer;
			const { optimal, good } = this.thresholds.polling;

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
				// Calculate current lifespan
				const lifespan = Math.round((Date.now() - obs.createdAt.getTime()) / 1000);

				// Calculate performance rating
				const performance = this._calculatePerformance(obs);

				// Return observer data for transmission
				return {
					observerId: obs.observerId,
					collectionName: obs.collectionName,
					query: obs.query,
					publicationName: obs.publicationName,
					observerType: obs.observerType,
					isOplogEfficient: obs.isOplogEfficient,
					observerCount: obs.observerCount,
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
					timestamp: new Date(),
					status: obs.status,
					performance,
					host: obs.host,
					appVersion: this.appVersion,
					buildHash: this.buildHash
				};
			});

		// Send to platform
		if (this.client && observers.length > 0) {
			this.client.sendLiveQueries(observers);
			console.log(`📊 LiveQueriesCollector: Sent ${observers.length} observer records`);
		}

		// Clean up stopped observers older than 5 minutes
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		this.observers.forEach((obs, id) => {
			if (obs.status === "stopped" && obs.stoppedAt && obs.stoppedAt.getTime() < fiveMinutesAgo) {
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
