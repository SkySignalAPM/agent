import { Meteor } from "meteor/meteor";
import { check, Match } from "meteor/check";
import { MongoInternals } from "meteor/mongo";
import SystemMetricsCollector from "./lib/collectors/SystemMetricsCollector.js";
import MethodTracer from "./lib/collectors/MethodTracer.js";
import MongoPoolCollector from "./lib/collectors/MongoPoolCollector.js";
import MongoCollectionStatsCollector from "./lib/collectors/MongoCollectionStatsCollector.js";
import DDPCollector from "./lib/collectors/DDPCollector.js";
import HTTPCollector from "./lib/collectors/HTTPCollector.js";
import LiveQueriesCollector from "./lib/collectors/LiveQueriesCollector.js";
import JobCollector from "./lib/collectors/jobs/index.js";
import SkySignalClient from "./lib/SkySignalClient.js";
import { mergeConfig } from "./lib/config.js";
import { trackAsync, trackAsyncBatch, makeTrackable, makeTrackableClass } from "./lib/utils/trackAsync.js";

/**
 * SkySignalAgent - Main APM agent for Meteor applications.
 *
 * The SkySignal Agent automatically monitors your Meteor application and sends
 * performance data to the SkySignal dashboard. It collects metrics with minimal
 * overhead using non-blocking, fire-and-forget batching.
 *
 * **Monitored Data:**
 * - System metrics (CPU, memory, disk, network, event loop lag)
 * - Meteor Method execution traces with timing breakdowns
 * - Publication performance and subscription tracking
 * - MongoDB queries with index usage analysis
 * - HTTP request/response metrics
 * - Client and server errors with stack traces
 * - DDP/WebSocket connections and messages
 * - Live query observers (oplog vs polling)
 * - Background jobs (msavin:sjobs support)
 *
 * **Quick Start:**
 * The agent auto-starts if `Meteor.settings.skysignal.apiKey` is configured.
 * For manual control, use `configure()` and `start()`.
 *
 * @class SkySignalAgentClass
 * @property {Object} config - Current agent configuration
 * @property {SkySignalClient|null} client - HTTP client for API communication
 * @property {Object} collectors - Active collector instances
 * @property {boolean} started - Whether the agent is currently running
 *
 * @example
 * // Auto-start via Meteor settings (recommended)
 * // In settings.json:
 * {
 *   "skysignal": {
 *     "apiKey": "your-api-key",
 *     "debug": false
 *   }
 * }
 *
 * @example
 * // Manual configuration and start
 * import { SkySignalAgent } from "meteor/skysignal:agent";
 *
 * SkySignalAgent.configure({
 *   apiKey: "your-api-key",
 *   appVersion: "1.2.3",
 *   debug: true
 * });
 * SkySignalAgent.start();
 *
 * @example
 * // Track custom business metrics
 * SkySignalAgent.counter("orders.completed", 1, { region: "US" });
 * SkySignalAgent.timer("payment.processing", 1250, { provider: "stripe" });
 * SkySignalAgent.gauge("cart.value", 99.99, { currency: "USD" });
 */
class SkySignalAgentClass {
	constructor() {
		this.config = {
			apiKey: null,
			endpoint: process.env.SKYSIGNAL_ENDPOINT || "https://dash.skysignal.app",
			enabled: true,
			debug: false, // Debug mode for verbose console logging
			batchSize: 50,
			flushInterval: 10000,
			host: null,
			appVersion: null, // App version from package.json for performance tracking
			buildHash: null, // Build hash for source map lookup (Git SHA or timestamp)
			collectSystemMetrics: true,
			systemMetricsInterval: 60000,
			collectTraces: true,
			collectErrors: true,
			collectMongoPool: true,
			mongoPoolInterval: 60000, // 60s default
			mongoPoolFixedConnectionMemory: null, // Optional: fixed bytes per connection
			collectCollectionStats: true,
			collectionStatsInterval: 300000, // 5 min default
			collectDDPConnections: true,
			ddpConnectionsInterval: 30000, // 30s default (send updates every 30s)
			collectHttpRequests: true,
			httpRequestsInterval: 10000, // 10s default (send batches every 10s)
			httpSampleRate: 1.0, // Track 100% of HTTP requests by default
			httpExcludePatterns: null, // Optional: custom exclude patterns (uses defaults if null)
			collectLiveQueries: true,
			liveQueriesInterval: 60000, // 60s default (send live query stats every minute)
			liveQueriesPerformanceThresholds: null, // Optional: custom performance thresholds
			captureIndexUsage: true, // Enable MongoDB explain() capture
			indexUsageSampleRate: 0.05, // Explain 5% of queries by default
			explainVerbosity: 'executionStats', // queryPlanner | executionStats | allPlansExecution
			explainSlowQueriesOnly: false, // Only explain queries > slowQueryThreshold
			// Job monitoring
			collectJobs: true, // Enable background job monitoring
			jobsInterval: 30000, // 30s default (send job stats every 30s)
			jobsPackage: null // Auto-detect by default, or specify: "msavin:sjobs"
		};

		this.client = null;
		this.collectors = {};
		this.started = false;

		// Stagger offset for collector starts to avoid CPU spikes
		this._staggerIndex = 0;
	}

	/**
	 * Get staggered delay for collector initialization.
	 * Spreads collector starts over time to avoid simultaneous CPU spikes.
	 * @private
	 * @returns {number} Delay in milliseconds
	 */
	_getStaggerDelay() {
		const STAGGER_INTERVAL = 500; // 500ms between each collector start
		return (this._staggerIndex++) * STAGGER_INTERVAL;
	}

	/**
	 * Debug logging helper - only logs when debug mode is enabled
	 */
	_log(...args) {
		if (this.config.debug) {
			console.log('[SkySignal]', ...args);
		}
	}

	/**
	 * Warning logging helper - always logs warnings
	 * @private
	 */
	_warn(...args) {
		console.warn('[SkySignal]', ...args);
	}

	/**
	 * Configure the SkySignal agent with your API key and options.
	 *
	 * Call this method before `start()` to customize agent behavior.
	 * If using Meteor settings, this is called automatically on startup.
	 *
	 * @param {Object} [options={}] - Configuration options
	 * @param {string} options.apiKey - **Required.** Your SkySignal API key from the dashboard
	 * @param {string} [options.endpoint="https://dash.skysignal.app"] - SkySignal API endpoint
	 * @param {boolean} [options.enabled=true] - Enable/disable the agent entirely
	 * @param {boolean} [options.debug=false] - Enable verbose console logging for troubleshooting
	 * @param {string} [options.host] - Server hostname (auto-detected if not provided)
	 * @param {string} [options.appVersion] - Application version for tracking deployments (auto-detected from package.json)
	 * @param {string} [options.buildHash] - Git SHA or build hash for source map lookup (reads BUILD_HASH or GIT_SHA env vars)
	 *
	 * @param {number} [options.batchSize=50] - Maximum items per batch before sending
	 * @param {number} [options.batchSizeBytes=262144] - Maximum batch size in bytes (256KB default)
	 * @param {number} [options.flushInterval=10000] - Milliseconds between automatic batch flushes
	 * @param {number} [options.requestTimeout=3000] - HTTP request timeout in milliseconds
	 * @param {number} [options.maxBatchRetries=3] - Maximum retry attempts for failed batches
	 *
	 * @param {boolean} [options.collectSystemMetrics=true] - Collect CPU, memory, disk, network metrics
	 * @param {number} [options.systemMetricsInterval=60000] - System metrics collection interval (ms)
	 *
	 * @param {boolean} [options.collectTraces=true] - Trace Meteor Method execution
	 * @param {number} [options.traceSampleRate=1.0] - Sampling rate for traces (0.0 to 1.0)
	 *
	 * @param {boolean} [options.collectErrors=true] - Capture server-side errors
	 *
	 * @param {boolean} [options.collectMongoPool=true] - Monitor MongoDB connection pool
	 * @param {number} [options.mongoPoolInterval=60000] - Pool metrics collection interval (ms)
	 *
	 * @param {boolean} [options.collectCollectionStats=true] - Collect MongoDB collection statistics
	 * @param {number} [options.collectionStatsInterval=300000] - Collection stats interval (5 min default)
	 *
	 * @param {boolean} [options.collectDDPConnections=true] - Monitor WebSocket/DDP connections
	 * @param {number} [options.ddpConnectionsInterval=30000] - DDP metrics interval (ms)
	 *
	 * @param {boolean} [options.collectHttpRequests=true] - Track HTTP request/response metrics
	 * @param {number} [options.httpRequestsInterval=10000] - HTTP metrics batch interval (ms)
	 * @param {number} [options.httpSampleRate=1.0] - Sampling rate for HTTP requests (0.0 to 1.0)
	 * @param {RegExp[]} [options.httpExcludePatterns] - URL patterns to exclude from tracking
	 *
	 * @param {boolean} [options.collectLiveQueries=true] - Monitor reactive query observers
	 * @param {number} [options.liveQueriesInterval=60000] - Live queries metrics interval (ms)
	 *
	 * @param {boolean} [options.captureIndexUsage=true] - Run explain() to capture index usage
	 * @param {number} [options.indexUsageSampleRate=0.05] - Sampling rate for explain() (5% default)
	 * @param {string} [options.explainVerbosity="executionStats"] - MongoDB explain verbosity level
	 *
	 * @param {boolean} [options.collectJobs=true] - Monitor background jobs
	 * @param {number} [options.jobsInterval=30000] - Job metrics interval (ms)
	 * @param {string} [options.jobsPackage] - Job package to monitor (auto-detected: "msavin:sjobs")
	 *
	 * @returns {void}
	 *
	 * @example
	 * // Minimal configuration
	 * SkySignalAgent.configure({
	 *   apiKey: "sk_live_abc123"
	 * });
	 *
	 * @example
	 * // Full configuration with custom intervals
	 * SkySignalAgent.configure({
	 *   apiKey: "sk_live_abc123",
	 *   appVersion: "2.1.0",
	 *   debug: true,
	 *   collectSystemMetrics: true,
	 *   systemMetricsInterval: 30000,  // Every 30 seconds
	 *   traceSampleRate: 0.5,          // Sample 50% of traces
	 *   httpSampleRate: 0.1,           // Sample 10% of HTTP requests
	 *   indexUsageSampleRate: 0.01     // Explain 1% of queries
	 * });
	 *
	 * @example
	 * // Disable specific collectors
	 * SkySignalAgent.configure({
	 *   apiKey: "sk_live_abc123",
	 *   collectMongoPool: false,
	 *   collectCollectionStats: false,
	 *   collectJobs: false
	 * });
	 */
	configure(options = {}) {
		this.config = mergeConfig(options);

		if (!this.config.host) {
			this.config.host = this._detectHost();
		}

		// Auto-detect appVersion from package.json if not explicitly set
		if (!this.config.appVersion) {
			this.config.appVersion = this._detectAppVersion();
		}

		// Auto-detect buildHash from environment if not explicitly set
		if (!this.config.buildHash) {
			this.config.buildHash = this._detectBuildHash();
		}

		this.client = new SkySignalClient({
			apiKey: this.config.apiKey,
			endpoint: this.config.endpoint,
			batchSize: this.config.batchSize,
			batchSizeBytes: this.config.batchSizeBytes,
			flushInterval: this.config.flushInterval,
			traceSampleRate: this.config.traceSampleRate,
			rumSampleRate: this.config.rumSampleRate,
			requestTimeout: this.config.requestTimeout,
			maxBatchRetries: this.config.maxBatchRetries,
			debug: this.config.debug
		});

		this._log("Agent configured for host:", this.config.host);
		if (this.config.appVersion && this.config.appVersion !== "unknown") {
			this._log("App version:", this.config.appVersion);
		}
		if (this.config.buildHash) {
			this._log("Build hash:", this.config.buildHash.substring(0, 12) + "...");
		}
	}

	/**
	 * Start the SkySignal agent and begin collecting metrics.
	 *
	 * This method initializes all enabled collectors and starts sending data
	 * to the SkySignal dashboard. You must call `configure()` first to set
	 * your API key, or configure via `Meteor.settings.skysignal`.
	 *
	 * **Prerequisites:**
	 * - `configure()` must be called first (or use Meteor settings for auto-config)
	 * - `apiKey` must be set in the configuration
	 * - `enabled` must be true (default)
	 *
	 * **Collector Initialization Order:**
	 * 1. System Metrics (CPU, memory, disk, network)
	 * 2. Method Tracer (Meteor Method execution)
	 * 3. MongoDB Pool Monitor (connection pool metrics)
	 * 4. Collection Stats (database statistics)
	 * 5. DDP Connections (WebSocket monitoring)
	 * 6. HTTP Requests (REST API tracking)
	 * 7. Live Queries (reactive observer monitoring)
	 * 8. Jobs (background job monitoring - deferred to after Meteor.startup)
	 *
	 * @returns {void}
	 * @throws {Meteor.Error} Throws "skysignal-no-api-key" if apiKey is not configured
	 *
	 * @example
	 * // Manual start after configure
	 * import { SkySignalAgent } from "meteor/skysignal:agent";
	 *
	 * SkySignalAgent.configure({ apiKey: "sk_live_abc123" });
	 * SkySignalAgent.start();
	 *
	 * @example
	 * // Check if already started before calling
	 * if (!SkySignalAgent.started) {
	 *   SkySignalAgent.configure({ apiKey: process.env.SKYSIGNAL_API_KEY });
	 *   SkySignalAgent.start();
	 * }
	 *
	 * @example
	 * // Wrap in try-catch for error handling
	 * try {
	 *   SkySignalAgent.configure({ apiKey: "sk_live_abc123" });
	 *   SkySignalAgent.start();
	 *   console.log("SkySignal monitoring active");
	 * } catch (error) {
	 *   console.error("Failed to start SkySignal:", error.message);
	 * }
	 */
	start() {
		if (!this.config.apiKey) {
			throw new Meteor.Error("skysignal-no-api-key", "SkySignal API key is required");
		}

		if (!this.config.enabled) {
			this._log("Agent is disabled");
			return;
		}

		if (this.started) {
			this._log("Agent already started");
			return;
		}

		// Reset stagger index for clean start
		this._staggerIndex = 0;

		if (this.config.collectSystemMetrics) {
			this.collectors.systemMetrics = new SystemMetricsCollector({
				client: this.client,
				host: this.config.host,
				appVersion: this.config.appVersion,
				buildHash: this.config.buildHash,
				interval: this.config.systemMetricsInterval,
				debug: this.config.debug
			});
			// Stagger collector start to avoid CPU spikes
			setTimeout(() => {
				if (this.started && this.collectors.systemMetrics) {
					this.collectors.systemMetrics.start();
					this._log("System metrics collector started");
				}
			}, this._getStaggerDelay());
		}

		if (this.config.collectTraces) {
			this.collectors.methodTracer = new MethodTracer({
				client: this.client,
				host: this.config.host,
				appVersion: this.config.appVersion,
				buildHash: this.config.buildHash,
				enabled: this.config.collectTraces,
				maxArgLength: this.config.maxArgLength,
				captureIndexUsage: this.config.captureIndexUsage,
				indexUsageSampleRate: this.config.indexUsageSampleRate,
				explainVerbosity: this.config.explainVerbosity,
				explainSlowQueriesOnly: this.config.explainSlowQueriesOnly,
				debug: this.config.debug
			});
			// Method tracer starts immediately (wraps Methods synchronously)
			this.collectors.methodTracer.start();
			this._log("Method tracer started");
		}

		if (this.config.collectMongoPool) {
			try {
				// Get MongoDB client from MongoInternals
				const mongoClient = MongoInternals.defaultRemoteCollectionDriver()?.mongo?.client;

				if (mongoClient) {
					this.collectors.mongoPool = new MongoPoolCollector({
						client: mongoClient,
						skySignalClient: this.client,
						host: this.config.host,
						appVersion: this.config.appVersion,
						buildHash: this.config.buildHash,
						enabled: this.config.collectMongoPool,
						snapshotInterval: this.config.mongoPoolInterval,
						fixedConnectionMemory: this.config.mongoPoolFixedConnectionMemory,
						debug: this.config.debug
					});
					setTimeout(() => {
						if (this.started && this.collectors.mongoPool) {
							this.collectors.mongoPool.start();
							this._log("MongoDB connection pool monitoring started");
						}
					}, this._getStaggerDelay());
				} else {
					this._warn("MongoDB client not available - pool monitoring disabled");
				}
			} catch (error) {
				this._warn("Failed to start MongoDB pool monitoring:", error.message);
			}
		}

		if (this.config.collectCollectionStats) {
			try {
				// Get MongoDB client from MongoInternals
				const mongoClient = MongoInternals.defaultRemoteCollectionDriver()?.mongo?.client;

				if (mongoClient) {
					this.collectors.collectionStats = new MongoCollectionStatsCollector({
						client: mongoClient,
						skySignalClient: this.client,
						host: this.config.host,
						appVersion: this.config.appVersion,
						buildHash: this.config.buildHash,
						enabled: this.config.collectCollectionStats,
						collectionInterval: this.config.collectionStatsInterval,
						debug: this.config.debug
					});
					setTimeout(() => {
						if (this.started && this.collectors.collectionStats) {
							this.collectors.collectionStats.start();
							this._log("MongoDB collection statistics monitoring started");
						}
					}, this._getStaggerDelay());
				} else {
					this._warn("MongoDB client not available - collection stats monitoring disabled");
				}
			} catch (error) {
				this._warn("Failed to start collection stats monitoring:", error.message);
			}
		}

		if (this.config.collectDDPConnections) {
			try {
				this.collectors.ddpConnections = new DDPCollector({
					client: this.client,
					appVersion: this.config.appVersion,
					buildHash: this.config.buildHash,
					interval: this.config.ddpConnectionsInterval,
					debug: this.config.debug
				});
				setTimeout(() => {
					if (this.started && this.collectors.ddpConnections) {
						this.collectors.ddpConnections.start();
						this._log("DDP/WebSocket connection monitoring started");
					}
				}, this._getStaggerDelay());
			} catch (error) {
				this._warn("Failed to start DDP connection monitoring:", error.message);
			}
		}

		if (this.config.collectHttpRequests) {
			try {
				const httpCollectorOptions = {
					client: this.client,
					host: this.config.host,
					appVersion: this.config.appVersion,
					buildHash: this.config.buildHash,
					interval: this.config.httpRequestsInterval,
					sampleRate: this.config.httpSampleRate,
					debug: this.config.debug
				};

				// Add custom exclude patterns if provided
				if (this.config.httpExcludePatterns) {
					httpCollectorOptions.excludePatterns = this.config.httpExcludePatterns;
				}

				this.collectors.httpRequests = new HTTPCollector(httpCollectorOptions);
				// HTTP collector starts immediately (middleware needs to be registered early)
				this.collectors.httpRequests.start();
				this._log("HTTP request monitoring started");
			} catch (error) {
				this._warn("Failed to start HTTP request monitoring:", error.message);
			}
		}

		if (this.config.collectLiveQueries) {
			try {
				const liveQueriesCollectorOptions = {
					client: this.client,
					host: this.config.host,
					appVersion: this.config.appVersion,
					buildHash: this.config.buildHash,
					interval: this.config.liveQueriesInterval,
					debug: this.config.debug
				};

				// Add custom performance thresholds if provided
				if (this.config.liveQueriesPerformanceThresholds) {
					liveQueriesCollectorOptions.performanceThresholds = this.config.liveQueriesPerformanceThresholds;
				}

				this.collectors.liveQueries = new LiveQueriesCollector(liveQueriesCollectorOptions);
				setTimeout(() => {
					if (this.started && this.collectors.liveQueries) {
						this.collectors.liveQueries.start();
						this._log("Live Queries monitoring started");
					}
				}, this._getStaggerDelay());
			} catch (error) {
				this._warn("Failed to start Live Queries monitoring:", error.message);
			}
		}

		if (this.config.collectJobs) {
			// Defer job monitoring to after all Meteor.startup callbacks have run
			// Job packages like msavin:sjobs register their own Meteor.startup callbacks
			// which may run after ours, so we use setTimeout to ensure they've initialized
			this._log("Job monitoring enabled - will initialize after startup");
			Meteor.startup(() => {
				// Use setTimeout to run after all other Meteor.startup callbacks
				setTimeout(() => {
					this._log("Initializing job monitoring (post-startup)...");
					try {
						const jobCollector = JobCollector.create({
							client: this.client,
							host: this.config.host,
							appVersion: this.config.appVersion,
							buildHash: this.config.buildHash,
							interval: this.config.jobsInterval,
							preferredPackage: this.config.jobsPackage,
							debug: this.config.debug
						});

						if (jobCollector) {
							this.collectors.jobs = jobCollector;
							this.collectors.jobs.start();
							this._log(`Background job monitoring started (${jobCollector.getPackageName()})`);
						} else {
							this._log("No job collector created - no supported job package found");
						}
					} catch (error) {
						this._warn("Failed to start job monitoring:", error.message);
					}
				}, 100); // Small delay to ensure all startup callbacks have completed
			});
		}

		this.started = true;
		this._log("Agent started successfully");
	}

	/**
	 * Stop the SkySignal agent and flush any pending data.
	 *
	 * This method gracefully shuts down all collectors, flushes any pending
	 * batched data to the API, and cleans up resources. Safe to call multiple
	 * times (subsequent calls are no-ops if already stopped).
	 *
	 * **Cleanup Actions:**
	 * 1. Stops all active collectors (system metrics, traces, etc.)
	 * 2. Flushes any pending batched data to the SkySignal API
	 * 3. Clears collector references
	 * 4. Sets `started` flag to false
	 *
	 * **When to Use:**
	 * - Before application shutdown for graceful cleanup
	 * - When temporarily disabling monitoring
	 * - During testing to reset agent state
	 *
	 * @returns {void}
	 *
	 * @example
	 * // Graceful shutdown on SIGTERM
	 * process.on("SIGTERM", () => {
	 *   console.log("Shutting down...");
	 *   SkySignalAgent.stop();
	 *   process.exit(0);
	 * });
	 *
	 * @example
	 * // Temporarily disable and re-enable monitoring
	 * SkySignalAgent.stop();
	 * // ... do something without monitoring ...
	 * SkySignalAgent.start();  // Resume monitoring
	 *
	 * @example
	 * // Test cleanup
	 * afterEach(() => {
	 *   SkySignalAgent.stop();
	 * });
	 */
	stop() {
		if (!this.started) {
			return;
		}

		Object.values(this.collectors).forEach(collector => {
			if (collector && collector.stop) {
				collector.stop();
			}
		});

		if (this.client) {
			this.client.flush();
		}

		this.started = false;
		this._log("Agent stopped");
	}

	// ============================================================
	// Custom Metrics API
	// ============================================================

	/**
	 * Track a custom metric of any type (counter, timer, or gauge).
	 *
	 * Use this method when you need full control over the metric object,
	 * or use the convenience methods `counter()`, `timer()`, and `gauge()`.
	 *
	 * @param {Object} options - The metric configuration
	 * @param {string} options.name - Metric name using dot notation (e.g., "orders.completed", "payment.processing")
	 * @param {("counter"|"timer"|"gauge")} options.type - The type of metric:
	 *   - "counter": Incremental values that only go up (e.g., requests processed, orders placed)
	 *   - "timer": Duration measurements in milliseconds (e.g., API response time, job duration)
	 *   - "gauge": Point-in-time values that can go up or down (e.g., queue size, active users)
	 * @param {number} options.value - The metric value (count for counters, milliseconds for timers, current value for gauges)
	 * @param {string} [options.unit] - Optional unit of measurement (e.g., "ms", "bytes", "items", "percent")
	 * @param {Object} [options.tags] - Optional key-value pairs for filtering and grouping in the dashboard
	 * @param {Date} [options.timestamp] - Optional timestamp (defaults to now)
	 *
	 * @returns {boolean} True if the metric was queued successfully, false if agent not started
	 *
	 * @example
	 * // Track a counter metric
	 * SkySignalAgent.trackMetric({
	 *   name: "orders.completed",
	 *   type: "counter",
	 *   value: 1,
	 *   tags: { region: "US", paymentMethod: "credit_card" }
	 * });
	 *
	 * @example
	 * // Track a timer metric
	 * SkySignalAgent.trackMetric({
	 *   name: "payment.processing",
	 *   type: "timer",
	 *   value: 1250,
	 *   unit: "ms",
	 *   tags: { provider: "stripe" }
	 * });
	 *
	 * @example
	 * // Track a gauge metric
	 * SkySignalAgent.trackMetric({
	 *   name: "queue.size",
	 *   type: "gauge",
	 *   value: 42,
	 *   unit: "items"
	 * });
	 */
	trackMetric(options = {}) {
		if (!this.started || !this.client) {
			this._warn("Cannot track metric - agent not started");
			return false;
		}

		const { name, type, value, unit, tags, timestamp } = options;

		// Validate required fields
		if (!name || typeof name !== "string") {
			this._warn("trackMetric requires a 'name' string");
			return false;
		}

		if (!type || !["counter", "timer", "gauge"].includes(type)) {
			this._warn("trackMetric requires 'type' to be one of: counter, timer, gauge");
			return false;
		}

		if (typeof value !== "number" || isNaN(value)) {
			this._warn("trackMetric requires a numeric 'value'");
			return false;
		}

		const metric = {
			timestamp: timestamp instanceof Date ? timestamp : new Date(),
			name,
			metricType: type,
			value,
			host: this.config.host,
			appVersion: this.config.appVersion,
			buildHash: this.config.buildHash
		};

		if (unit) {
			metric.unit = unit;
		}

		if (tags && typeof tags === "object") {
			metric.tags = tags;
		}

		this.client.addCustomMetric(metric);
		this._log(`Custom metric tracked: ${name} (${type}) = ${value}`);
		return true;
	}

	/**
	 * Track a counter metric - use for values that only increment.
	 *
	 * Counters are ideal for tracking events that accumulate over time,
	 * such as the number of orders placed, API requests handled, or emails sent.
	 *
	 * @param {string} name - Metric name using dot notation (e.g., "orders.completed", "emails.sent")
	 * @param {number} [value=1] - The increment value (defaults to 1)
	 * @param {Object} [options] - Additional options
	 * @param {string} [options.unit] - Optional unit (e.g., "requests", "orders")
	 * @param {Object} [options.tags] - Optional tags for filtering (e.g., { region: "US" })
	 * @param {Date} [options.timestamp] - Optional timestamp (defaults to now)
	 *
	 * @returns {boolean} True if the metric was queued successfully
	 *
	 * @example
	 * // Simple counter increment
	 * SkySignalAgent.counter("orders.completed");
	 *
	 * @example
	 * // Counter with custom value and tags
	 * SkySignalAgent.counter("items.sold", 5, {
	 *   tags: { category: "electronics", store: "NYC" }
	 * });
	 *
	 * @example
	 * // Track API requests by endpoint
	 * SkySignalAgent.counter("api.requests", 1, {
	 *   tags: { endpoint: "/users", method: "GET", status: "200" }
	 * });
	 */
	counter(name, value = 1, options = {}) {
		return this.trackMetric({
			name,
			type: "counter",
			value,
			unit: options.unit,
			tags: options.tags,
			timestamp: options.timestamp
		});
	}

	/**
	 * Track a timer metric - use for measuring durations.
	 *
	 * Timers are ideal for tracking how long operations take,
	 * such as API response times, database query durations, or job execution times.
	 * The dashboard will calculate min, max, avg, p95, and p99 percentiles.
	 *
	 * @param {string} name - Metric name using dot notation (e.g., "payment.processing", "db.query")
	 * @param {number} duration - Duration in milliseconds
	 * @param {Object} [options] - Additional options
	 * @param {string} [options.unit="ms"] - Unit of measurement (defaults to "ms")
	 * @param {Object} [options.tags] - Optional tags for filtering (e.g., { endpoint: "/checkout" })
	 * @param {Date} [options.timestamp] - Optional timestamp (defaults to now)
	 *
	 * @returns {boolean} True if the metric was queued successfully
	 *
	 * @example
	 * // Track payment processing time
	 * const start = Date.now();
	 * await processPayment(order);
	 * SkySignalAgent.timer("payment.processing", Date.now() - start, {
	 *   tags: { provider: "stripe", currency: "USD" }
	 * });
	 *
	 * @example
	 * // Track external API call duration
	 * const start = Date.now();
	 * const result = await fetch("https://api.example.com/data");
	 * SkySignalAgent.timer("external.api.call", Date.now() - start, {
	 *   tags: { service: "example", endpoint: "/data", status: result.status }
	 * });
	 *
	 * @example
	 * // Track database query time
	 * SkySignalAgent.timer("db.query.users", 45, {
	 *   tags: { collection: "users", operation: "find" }
	 * });
	 */
	timer(name, duration, options = {}) {
		return this.trackMetric({
			name,
			type: "timer",
			value: duration,
			unit: options.unit || "ms",
			tags: options.tags,
			timestamp: options.timestamp
		});
	}

	/**
	 * Track a gauge metric - use for point-in-time values that can go up or down.
	 *
	 * Gauges are ideal for tracking current state values like queue depths,
	 * active user counts, memory usage, or inventory levels.
	 * The dashboard will show the latest value along with min/max/avg over time.
	 *
	 * @param {string} name - Metric name using dot notation (e.g., "queue.size", "users.active")
	 * @param {number} value - Current value of the gauge
	 * @param {Object} [options] - Additional options
	 * @param {string} [options.unit] - Optional unit (e.g., "users", "bytes", "percent")
	 * @param {Object} [options.tags] - Optional tags for filtering (e.g., { queue: "emails" })
	 * @param {Date} [options.timestamp] - Optional timestamp (defaults to now)
	 *
	 * @returns {boolean} True if the metric was queued successfully
	 *
	 * @example
	 * // Track queue depth
	 * const queueSize = await getQueueSize("email-queue");
	 * SkySignalAgent.gauge("queue.size", queueSize, {
	 *   unit: "items",
	 *   tags: { queue: "email" }
	 * });
	 *
	 * @example
	 * // Track active users
	 * const activeUsers = Meteor.server.sessions.size;
	 * SkySignalAgent.gauge("users.active", activeUsers, {
	 *   unit: "users"
	 * });
	 *
	 * @example
	 * // Track inventory levels
	 * SkySignalAgent.gauge("inventory.stock", 150, {
	 *   unit: "items",
	 *   tags: { product: "widget-123", warehouse: "NYC" }
	 * });
	 *
	 * @example
	 * // Track cache hit rate
	 * SkySignalAgent.gauge("cache.hitRate", 0.85, {
	 *   unit: "percent",
	 *   tags: { cache: "redis" }
	 * });
	 */
	gauge(name, value, options = {}) {
		return this.trackMetric({
			name,
			type: "gauge",
			value,
			unit: options.unit,
			tags: options.tags,
			timestamp: options.timestamp
		});
	}

	/**
	 * Auto-detect the server hostname.
	 * Uses Node.js os.hostname() to get the machine name.
	 * @private
	 * @returns {string} The detected hostname or "unknown-host" on failure
	 */
	_detectHost() {
		try {
			const os = require("os");
			return os.hostname();
		} catch (error) {
			this._warn("Could not detect hostname:", error.message);
			return "unknown-host";
		}
	}

	/**
	 * Auto-detect the build hash from environment variables.
	 * Checks BUILD_HASH and GIT_SHA environment variables in order.
	 * Used for source map lookup and deployment tracking.
	 * @private
	 * @returns {string|null} The build hash or null if not available
	 */
	_detectBuildHash() {
		// Try to detect build hash from environment variables
		// Priority: BUILD_HASH > GIT_SHA > null
		const buildHash = process.env.BUILD_HASH || process.env.GIT_SHA;

		if (buildHash) {
			return buildHash;
		}

		// Build hash not available - this is OK for development
		// In production, set BUILD_HASH or GIT_SHA environment variable
		return null;
	}

	/**
	 * Auto-detect the application version from various sources.
	 *
	 * Detection priority:
	 * 1. APP_VERSION environment variable
	 * 2. Meteor.settings.skysignal.appVersion
	 * 3. Meteor.settings.public.appVersion
	 * 4. Meteor Assets (private/package.json)
	 * 5. Walk up directory tree to find package.json
	 *
	 * @private
	 * @returns {string} The detected version or "unknown" if not found
	 */
	_detectAppVersion() {
		// Priority 1: Environment variable (useful for CI/CD pipelines)
		if (process.env.APP_VERSION) {
			return process.env.APP_VERSION;
		}

		// Priority 2: Check Meteor.settings for appVersion
		try {
			const settings = Meteor.settings?.skysignal || Meteor.settings?.SkySignal || {};
			if (settings.appVersion) {
				return settings.appVersion;
			}
			// Also check top-level settings
			if (Meteor.settings?.public?.appVersion) {
				return Meteor.settings.public.appVersion;
			}
		} catch (e) {
			// Settings not available
		}

		// Priority 3: Try to read from Meteor Assets (package.json in private/)
		try {
			if (typeof Assets !== "undefined" && Assets.getText) {
				const packageJsonStr = Assets.getText("package.json");
				if (packageJsonStr) {
					const packageJson = JSON.parse(packageJsonStr);
					if (packageJson.version) {
						return packageJson.version;
					}
				}
			}
		} catch (e) {
			// Assets may not be available or file doesn't exist
		}

		// Priority 4: Walk up directory tree to find package.json
		// In Meteor, process.cwd() is typically .meteor/local/build/programs/server
		try {
			const fs = require("fs");
			const path = require("path");

			let currentDir = process.cwd();
			const root = path.parse(currentDir).root;

			// Walk up the directory tree looking for package.json
			while (currentDir !== root) {
				const packageJsonPath = path.join(currentDir, "package.json");
				try {
					if (fs.existsSync(packageJsonPath)) {
						const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
						// Make sure this is the app's package.json, not a dependency
						// Check if it has typical Meteor app indicators
						if (packageJson.version && (packageJson.meteor || packageJson.scripts?.start?.includes("meteor"))) {
							return packageJson.version;
						}
					}
				} catch (readError) {
					// Skip this location
				}
				currentDir = path.dirname(currentDir);
			}

			// Also try specific Meteor paths
			const meteorPaths = [
				process.env.PWD ? path.join(process.env.PWD, "package.json") : null,
				process.env.METEOR_SHELL_DIR ? path.join(process.env.METEOR_SHELL_DIR, "..", "..", "..", "package.json") : null
			].filter(Boolean);

			for (const loc of meteorPaths) {
				try {
					if (fs.existsSync(loc)) {
						const packageJson = JSON.parse(fs.readFileSync(loc, "utf8"));
						if (packageJson.version) {
							return packageJson.version;
						}
					}
				} catch (readError) {
					// Skip this location
				}
			}
		} catch (e) {
			// File system access may not be available
		}

		// Fallback: version unknown
		return "unknown";
	}
}

const agent = new SkySignalAgentClass();

if (Meteor.isServer) {
	const config = Meteor.settings?.skysignal || Meteor.settings?.SkySignal;

	if (config && config.apiKey) {
		try {
			agent.configure(config);
			agent.start();
			// Single startup message - only shows in production to confirm agent is running
			if (!config.debug) {
				console.log("[SkySignal] Agent started - host:", agent.config.host);
			}
		} catch (error) {
			console.error("[SkySignal] Failed to auto-start:", error.message);
		}
	}
}

export {
  agent as SkySignalAgent,
  trackAsync,
  trackAsyncBatch,
  makeTrackable,
  makeTrackableClass
};
export default agent;
