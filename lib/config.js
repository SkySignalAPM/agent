import { check, Match } from "meteor/check";

/**
 * Default configuration for the SkySignal Agent.
 *
 * These defaults are optimized for minimal performance impact (<1% CPU, <0.5% memory).
 * Override any value by passing it to `SkySignalAgent.configure()` or via `Meteor.settings.skysignal`.
 *
 * @constant {Object} DEFAULT_CONFIG
 *
 * @property {string|null} apiKey - Your SkySignal API key (required to start agent)
 * @property {string} endpoint - SkySignal API endpoint URL
 * @property {boolean} enabled - Enable/disable the agent entirely
 * @property {boolean} debug - Enable verbose console logging for troubleshooting
 *
 * @property {string|null} host - Server hostname (auto-detected from os.hostname())
 * @property {string|null} appVersion - Application version (auto-detected from package.json)
 *
 * @property {number} batchSize - Maximum items per batch before auto-flush (default: 50)
 * @property {number} batchSizeBytes - Maximum batch size in bytes (default: 256KB)
 * @property {number} flushInterval - Auto-flush interval in milliseconds (default: 10000)
 *
 * @property {number} traceSampleRate - Sampling rate for traces, 0.0-1.0 (default: 1.0 = 100%)
 * @property {number} rumSampleRate - Sampling rate for RUM data, 0.0-1.0 (default: 0.5 = 50%)
 *
 * @property {number} systemMetricsInterval - System metrics collection interval in ms (default: 60000)
 * @property {number} mongoPoolInterval - MongoDB pool metrics interval in ms (default: 60000)
 * @property {number} collectionStatsInterval - Collection stats interval in ms (default: 300000)
 * @property {number} ddpConnectionsInterval - DDP connection metrics interval in ms (default: 30000)
 *
 * @property {boolean} collectSystemMetrics - Enable CPU, memory, disk, network metrics
 * @property {boolean} collectTraces - Enable Meteor Method execution tracing
 * @property {boolean} collectErrors - Enable error capture
 * @property {boolean} collectHttpRequests - Enable HTTP request/response tracking
 * @property {boolean} collectMongoPool - Enable MongoDB connection pool monitoring
 * @property {boolean} collectCollectionStats - Enable MongoDB collection statistics
 * @property {boolean} collectDDPConnections - Enable WebSocket/DDP connection monitoring
 * @property {boolean} collectRUM - Enable Real User Monitoring (client-side, disabled by default)
 *
 * @property {number|null} mongoPoolFixedConnectionMemory - Fixed memory estimate per connection in bytes
 *
 * @property {boolean} traceMethodArguments - Capture sanitized method arguments in traces
 * @property {number} maxArgLength - Maximum string length for captured arguments (default: 1000)
 * @property {boolean} traceMethodOperations - Capture detailed operation timeline in traces
 *
 * @property {boolean} captureIndexUsage - Enable MongoDB explain() for index usage analysis
 * @property {number} indexUsageSampleRate - Sampling rate for explain(), 0.0-1.0 (default: 0.05 = 5%)
 * @property {string} explainVerbosity - MongoDB explain verbosity: "queryPlanner" | "executionStats" | "allPlansExecution"
 * @property {boolean} explainSlowQueriesOnly - Only run explain() on slow queries
 *
 * @property {number} maxBatchRetries - Maximum retry attempts for failed batches (default: 3)
 * @property {number} requestTimeout - HTTP request timeout in milliseconds (default: 3000)
 * @property {number} maxMemoryMB - Maximum memory for batch queues in MB (default: 50)
 *
 * @property {boolean} useWorkerThread - Enable worker thread for large connection pools
 * @property {number} workerThreshold - Pool size threshold to spawn worker (default: 50)
 *
 * @property {boolean} collectJobs - Enable background job monitoring
 * @property {number} jobsInterval - Job metrics collection interval in ms (default: 30000)
 * @property {string|null} jobsPackage - Job package to monitor (auto-detected, or specify: "msavin:sjobs")
 *
 * @example
 * // Access default values
 * import { DEFAULT_CONFIG } from "meteor/skysignal:agent/lib/config";
 * console.log(DEFAULT_CONFIG.flushInterval); // 10000
 *
 * @example
 * // Override defaults via Meteor settings
 * // settings.json:
 * {
 *   "skysignal": {
 *     "apiKey": "sk_live_abc123",
 *     "traceSampleRate": 0.1,
 *     "systemMetricsInterval": 30000
 *   }
 * }
 */
export const DEFAULT_CONFIG = {
	// API Configuration
	apiKey: null,
	endpoint: process.env.SKYSIGNAL_ENDPOINT || "https://dash.skysignal.app",
	enabled: true,

	// Debug Mode (logs verbose output to console)
	debug: false,

	// Host Identification
	host: null, // Auto-detected from os.hostname()

	// App Version Tracking
	appVersion: null, // Auto-detected from package.json or manually configured

	// Batching Configuration (Performance-critical)
	batchSize: 50,                    // Max items before auto-flush
	batchSizeBytes: 256 * 1024,       // Max 256KB per batch
	flushInterval: 10000,             // Flush every 10 seconds

	// Sampling (Reduces CPU/Network usage)
	traceSampleRate: 1.0,             // 100% by default (set to 0.1 for 10%)
	rumSampleRate: 0.5,               // 50% for RUM (high volume)

	// Collection Intervals (Longer = less CPU)
	systemMetricsInterval: 60000,     // 1 minute
	mongoPoolInterval: 60000,         // 1 minute (changed from 30s to match spec)
	collectionStatsInterval: 300000,    // 5 minutes
	ddpConnectionsInterval: 30000,    // 30 seconds (DDP connection updates)

	// Feature Flags
	collectSystemMetrics: true,
	collectTraces: true,
	collectErrors: true,
	collectHttpRequests: true,
	collectMongoPool: true,           // Enabled by default
	collectCollectionStats: true,        // Enabled by default
	collectDDPConnections: true,      // Enabled by default
	collectRUM: false,                // Disabled by default (client-side)

	// MongoDB Pool Configuration
	mongoPoolFixedConnectionMemory: null,  // Optional: fixed bytes per connection

	// Method Tracing Configuration
	traceMethodArguments: true,       // Capture method arguments (sanitized)
	maxArgLength: 1000,               // Max string length for arguments
	traceMethodOperations: true,      // Capture detailed operation timeline

	// Index Usage Tracking Configuration
	captureIndexUsage: true,          // Capture MongoDB index usage via explain()
	indexUsageSampleRate: 0.05,       // Sample 5% of queries for explain()
	explainVerbosity: 'executionStats', // queryPlanner | executionStats | allPlansExecution
	explainSlowQueriesOnly: false,    // Only explain queries exceeding slowQueryThreshold

	// Performance Safeguards
	maxBatchRetries: 3,               // Max retries for failed batches
	requestTimeout: 3000,             // 3 second timeout for API requests
	maxMemoryMB: 50,                  // Max 50MB memory for batches

	// Worker Offload (for large Mongo pools)
	useWorkerThread: false,           // Enable for pools >50 connections
	workerThreshold: 50,              // Spawn worker if pool size exceeds this

	// Background Job Monitoring
	collectJobs: true,                // Enable background job monitoring
	jobsInterval: 30000,              // 30 seconds (job stats interval)
	jobsPackage: null                 // Auto-detect, or specify: "msavin:sjobs"
};

/**
 * Validate user configuration against the expected schema.
 *
 * This function checks that all configuration values are of the correct type
 * and within valid ranges. It uses Meteor's `check` package for type validation.
 *
 * **Validated Ranges:**
 * - `traceSampleRate`: Must be between 0.0 and 1.0
 * - `rumSampleRate`: Must be between 0.0 and 1.0
 * - `indexUsageSampleRate`: Must be between 0.0 and 1.0
 * - `explainVerbosity`: Must be "queryPlanner", "executionStats", or "allPlansExecution"
 * - `batchSize`: Must be at least 1
 * - `flushInterval`: Must be at least 1000ms
 *
 * @param {Object} config - User configuration object to validate
 * @param {string} config.apiKey - **Required.** SkySignal API key
 * @param {string} [config.endpoint] - API endpoint URL
 * @param {boolean} [config.enabled] - Enable/disable agent
 * @param {boolean} [config.debug] - Enable debug logging
 * @param {string} [config.host] - Server hostname
 * @param {string|null} [config.appVersion] - Application version
 * @param {number} [config.batchSize] - Max items per batch
 * @param {number} [config.flushInterval] - Flush interval in ms
 * @param {number} [config.traceSampleRate] - Trace sampling rate (0.0-1.0)
 * @param {number} [config.rumSampleRate] - RUM sampling rate (0.0-1.0)
 * @param {number} [config.indexUsageSampleRate] - Explain sampling rate (0.0-1.0)
 * @param {string} [config.explainVerbosity] - MongoDB explain verbosity level
 *
 * @returns {void}
 * @throws {Match.Error} If any configuration value has an invalid type
 * @throws {Error} If any configuration value is outside its valid range
 *
 * @example
 * // Valid configuration
 * validateConfig({
 *   apiKey: "sk_live_abc123",
 *   traceSampleRate: 0.5
 * }); // No error
 *
 * @example
 * // Invalid - missing required apiKey
 * validateConfig({});
 * // Throws: Match error: Missing key 'apiKey'
 *
 * @example
 * // Invalid - sample rate out of range
 * validateConfig({
 *   apiKey: "sk_live_abc123",
 *   traceSampleRate: 1.5
 * });
 * // Throws: Error: traceSampleRate must be between 0 and 1
 */
export function validateConfig(config) {
	check(config, {
		apiKey: String,
		endpoint: Match.Optional(String),
		enabled: Match.Optional(Boolean),
		debug: Match.Optional(Boolean),
		host: Match.Optional(String),
		appVersion: Match.Optional(Match.OneOf(String, null)),

		batchSize: Match.Optional(Match.Integer),
		batchSizeBytes: Match.Optional(Match.Integer),
		flushInterval: Match.Optional(Match.Integer),

		traceSampleRate: Match.Optional(Number),
		rumSampleRate: Match.Optional(Number),

		systemMetricsInterval: Match.Optional(Match.Integer),
		mongoPoolInterval: Match.Optional(Match.Integer),
		collectionStatsInterval: Match.Optional(Match.Integer),
		ddpConnectionsInterval: Match.Optional(Match.Integer),

		collectSystemMetrics: Match.Optional(Boolean),
		collectTraces: Match.Optional(Boolean),
		collectErrors: Match.Optional(Boolean),
		collectHttpRequests: Match.Optional(Boolean),
		collectMongoPool: Match.Optional(Boolean),
		collectRUM: Match.Optional(Boolean),
		collectCollectionStats: Match.Optional(Boolean),
		collectDDPConnections: Match.Optional(Boolean),

		mongoPoolFixedConnectionMemory: Match.Optional(Match.OneOf(Number, null)),

		traceMethodArguments: Match.Optional(Boolean),
		maxArgLength: Match.Optional(Match.Integer),
		traceMethodOperations: Match.Optional(Boolean),

		captureIndexUsage: Match.Optional(Boolean),
		indexUsageSampleRate: Match.Optional(Number),
		explainVerbosity: Match.Optional(String),
		explainSlowQueriesOnly: Match.Optional(Boolean),

		maxBatchRetries: Match.Optional(Match.Integer),
		requestTimeout: Match.Optional(Match.Integer),
		maxMemoryMB: Match.Optional(Match.Integer),

		useWorkerThread: Match.Optional(Boolean),
		workerThreshold: Match.Optional(Match.Integer),

		collectJobs: Match.Optional(Boolean),
		jobsInterval: Match.Optional(Match.Integer),
		jobsPackage: Match.Optional(Match.OneOf(String, null))
	});

	// Validate ranges
	if (config.traceSampleRate !== undefined && (config.traceSampleRate < 0 || config.traceSampleRate > 1)) {
		throw new Error("traceSampleRate must be between 0 and 1");
	}

	if (config.rumSampleRate !== undefined && (config.rumSampleRate < 0 || config.rumSampleRate > 1)) {
		throw new Error("rumSampleRate must be between 0 and 1");
	}

	if (config.indexUsageSampleRate !== undefined && (config.indexUsageSampleRate < 0 || config.indexUsageSampleRate > 1)) {
		throw new Error("indexUsageSampleRate must be between 0 and 1");
	}

	if (config.explainVerbosity !== undefined) {
		const validVerbosities = ['queryPlanner', 'executionStats', 'allPlansExecution'];
		if (!validVerbosities.includes(config.explainVerbosity)) {
			throw new Error(`explainVerbosity must be one of: ${validVerbosities.join(', ')}`);
		}
	}

	if (config.batchSize && config.batchSize < 1) {
		throw new Error("batchSize must be at least 1");
	}

	if (config.flushInterval && config.flushInterval < 1000) {
		throw new Error("flushInterval must be at least 1000ms");
	}
}

/**
 * Merge user configuration with default values.
 *
 * This function validates the user configuration, then merges it with
 * `DEFAULT_CONFIG`. User values override defaults. This is the primary
 * function used by `SkySignalAgent.configure()`.
 *
 * **Behavior:**
 * 1. Validates `userConfig` using `validateConfig()`
 * 2. Merges with `DEFAULT_CONFIG` (user values take precedence)
 * 3. Returns the complete merged configuration
 *
 * @param {Object} [userConfig={}] - User configuration to merge with defaults
 * @param {string} userConfig.apiKey - **Required.** SkySignal API key
 * @param {string} [userConfig.endpoint] - Override API endpoint
 * @param {boolean} [userConfig.enabled] - Enable/disable agent
 * @param {boolean} [userConfig.debug] - Enable debug logging
 * @param {number} [userConfig.traceSampleRate] - Override trace sampling rate
 * @param {number} [userConfig.flushInterval] - Override flush interval
 *
 * @returns {Object} Complete configuration with defaults applied
 *
 * @throws {Match.Error} If userConfig contains invalid types
 * @throws {Error} If userConfig contains values outside valid ranges
 *
 * @example
 * // Minimal config - all defaults applied
 * const config = mergeConfig({ apiKey: "sk_live_abc123" });
 * console.log(config.flushInterval); // 10000 (default)
 * console.log(config.apiKey);        // "sk_live_abc123" (user value)
 *
 * @example
 * // Override specific defaults
 * const config = mergeConfig({
 *   apiKey: "sk_live_abc123",
 *   traceSampleRate: 0.1,        // Override: sample 10%
 *   flushInterval: 5000,         // Override: flush every 5s
 *   collectMongoPool: false      // Override: disable pool monitoring
 * });
 *
 * @example
 * // Used internally by SkySignalAgent
 * class SkySignalAgentClass {
 *   configure(options) {
 *     this.config = mergeConfig(options);
 *   }
 * }
 */
export function mergeConfig(userConfig = {}) {
	validateConfig(userConfig);

	return {
		...DEFAULT_CONFIG,
		...userConfig
	};
}
