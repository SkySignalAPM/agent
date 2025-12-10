import { check, Match } from "meteor/check";

/**
 * Default configuration for SkySignal Agent
 * Optimized for <1% CPU and <0.5% RSS impact
 */
export const DEFAULT_CONFIG = {
	// API Configuration
	apiKey: null,
	endpoint: process.env.SKYSIGNAL_ENDPOINT || "https://skysignal.app",
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
 * Validate user configuration
 * @param {Object} config - User configuration
 * @throws {Match.Error} If validation fails
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
 * Merge user config with defaults
 * @param {Object} userConfig - User configuration
 * @returns {Object} Merged configuration
 */
export function mergeConfig(userConfig = {}) {
	validateConfig(userConfig);

	return {
		...DEFAULT_CONFIG,
		...userConfig
	};
}
