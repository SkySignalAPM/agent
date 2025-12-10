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
 * SkySignalAgent
 * Main APM agent for Meteor applications
 *
 * Monitors:
 * - System metrics (CPU, memory, disk, network)
 * - Method performance traces
 * - Publication performance
 * - Database queries
 * - HTTP requests
 * - Errors and exceptions
 * - Background jobs (msavin:sjobs, etc.)
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
	 */
	_warn(...args) {
		console.warn('[SkySignal]', ...args);
	}

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

		if (this.config.collectSystemMetrics) {
			this.collectors.systemMetrics = new SystemMetricsCollector({
				client: this.client,
				host: this.config.host,
				appVersion: this.config.appVersion,
				buildHash: this.config.buildHash,
				interval: this.config.systemMetricsInterval,
				debug: this.config.debug
			});
			this.collectors.systemMetrics.start();
			this._log("System metrics collector started");
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
					this.collectors.mongoPool.start();
					this._log("MongoDB connection pool monitoring started");
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
					this.collectors.collectionStats.start();
					this._log("MongoDB collection statistics monitoring started");
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
				this.collectors.ddpConnections.start();
				this._log("DDP/WebSocket connection monitoring started");
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
				this.collectors.liveQueries.start();
				this._log("Live Queries monitoring started");
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

	_detectHost() {
		try {
			const os = require("os");
			return os.hostname();
		} catch (error) {
			this._warn("Could not detect hostname:", error.message);
			return "unknown-host";
		}
	}

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
