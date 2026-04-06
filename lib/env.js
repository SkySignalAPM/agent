/**
 * Environment variable configuration for SkySignal Agent.
 *
 * Provides a declarative mapping between environment variables and config keys.
 * Adding a new env var requires only one new line in ENV_MAP.
 *
 * Priority: DEFAULT_CONFIG (lowest) < env vars < Meteor.settings (highest)
 */

// --- Type coercers ---

function coerceString(val) {
	return String(val);
}

function coerceBool(val) {
	const lower = val.toLowerCase();
	if (lower === 'true' || lower === '1' || lower === 'yes') return true;
	if (lower === 'false' || lower === '0' || lower === 'no') return false;
	throw new Error(`Expected "true" or "false", got "${val}"`);
}

function coerceInt(val) {
	const n = parseInt(val, 10);
	if (isNaN(n)) throw new Error(`Cannot coerce "${val}" to integer`);
	return n;
}

function coerceFloat(val) {
	const n = parseFloat(val);
	if (isNaN(n)) throw new Error(`Cannot coerce "${val}" to float`);
	return n;
}

function coerceArray(val) {
	return val.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Declarative mapping from environment variables to config keys.
 *
 * Each entry: { env, key, type }
 *   - env:  environment variable name
 *   - key:  corresponding config key in DEFAULT_CONFIG
 *   - type: 'string' | 'bool' | 'int' | 'float' | 'array'
 */
export const ENV_MAP = [
	// Core
	{ env: 'SKYSIGNAL_API_KEY',                  key: 'apiKey',                    type: 'string' },
	{ env: 'SKYSIGNAL_ENDPOINT',                 key: 'endpoint',                  type: 'string' },
	{ env: 'SKYSIGNAL_ENABLED',                  key: 'enabled',                   type: 'bool'   },
	{ env: 'SKYSIGNAL_DEBUG',                    key: 'debug',                     type: 'bool'   },

	// Identity
	{ env: 'SKYSIGNAL_HOST',                     key: 'host',                      type: 'string' },
	{ env: 'SKYSIGNAL_APP_VERSION',              key: 'appVersion',                type: 'string' },

	// Batching
	{ env: 'SKYSIGNAL_BATCH_SIZE',               key: 'batchSize',                 type: 'int'    },
	{ env: 'SKYSIGNAL_BATCH_SIZE_BYTES',         key: 'batchSizeBytes',            type: 'int'    },
	{ env: 'SKYSIGNAL_FLUSH_INTERVAL',           key: 'flushInterval',             type: 'int'    },

	// Sample rates
	{ env: 'SKYSIGNAL_TRACE_SAMPLE_RATE',        key: 'traceSampleRate',            type: 'float'  },
	{ env: 'SKYSIGNAL_RUM_SAMPLE_RATE',          key: 'rumSampleRate',              type: 'float'  },
	{ env: 'SKYSIGNAL_INDEX_USAGE_SAMPLE_RATE',  key: 'indexUsageSampleRate',       type: 'float'  },
	{ env: 'SKYSIGNAL_LOG_SAMPLE_RATE',          key: 'logSampleRate',              type: 'float'  },

	// Collection intervals
	{ env: 'SKYSIGNAL_SYSTEM_METRICS_INTERVAL',  key: 'systemMetricsInterval',      type: 'int'    },
	{ env: 'SKYSIGNAL_MONGO_POOL_INTERVAL',      key: 'mongoPoolInterval',          type: 'int'    },
	{ env: 'SKYSIGNAL_COLLECTION_STATS_INTERVAL',key: 'collectionStatsInterval',    type: 'int'    },
	{ env: 'SKYSIGNAL_DDP_CONNECTIONS_INTERVAL', key: 'ddpConnectionsInterval',     type: 'int'    },
	{ env: 'SKYSIGNAL_JOBS_INTERVAL',            key: 'jobsInterval',               type: 'int'    },
	{ env: 'SKYSIGNAL_DNS_TIMINGS_INTERVAL',     key: 'dnsTimingsInterval',         type: 'int'    },
	{ env: 'SKYSIGNAL_OUTBOUND_HTTP_INTERVAL',   key: 'outboundHttpInterval',       type: 'int'    },
	{ env: 'SKYSIGNAL_LIVE_QUERIES_INTERVAL',    key: 'liveQueriesInterval',        type: 'int'    },

	// Feature flags
	{ env: 'SKYSIGNAL_COLLECT_SYSTEM_METRICS',   key: 'collectSystemMetrics',       type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_TRACES',           key: 'collectTraces',              type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_ERRORS',           key: 'collectErrors',              type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_HTTP',             key: 'collectHttpRequests',        type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_MONGO_POOL',       key: 'collectMongoPool',           type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_COLLECTION_STATS', key: 'collectCollectionStats',     type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_DDP',              key: 'collectDDPConnections',      type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_RUM',              key: 'collectRUM',                 type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_JOBS',             key: 'collectJobs',                type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_LOGS',             key: 'collectLogs',                type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_DNS_TIMINGS',      key: 'collectDnsTimings',          type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_OUTBOUND_HTTP',    key: 'collectOutboundHttp',        type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_CPU_PROFILES',     key: 'collectCpuProfiles',         type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_LIVE_QUERIES',     key: 'collectLiveQueries',         type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_PUBLICATIONS',     key: 'collectPublications',        type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_ENVIRONMENT',      key: 'collectEnvironment',         type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_VULNERABILITIES',  key: 'collectVulnerabilities',     type: 'bool'   },
	{ env: 'SKYSIGNAL_COLLECT_DEPRECATED_APIS',  key: 'collectDeprecatedApis',      type: 'bool'   },

	// Log config
	{ env: 'SKYSIGNAL_LOG_LEVELS',               key: 'logLevels',                  type: 'array'  },
	{ env: 'SKYSIGNAL_LOG_MAX_MESSAGE_LENGTH',   key: 'logMaxMessageLength',        type: 'int'    },
	{ env: 'SKYSIGNAL_LOG_CAPTURE_CONSOLE',      key: 'logCaptureConsole',          type: 'bool'   },
	{ env: 'SKYSIGNAL_LOG_CAPTURE_METEOR_LOG',   key: 'logCaptureMeteorLog',        type: 'bool'   },

	// CPU profiling
	{ env: 'SKYSIGNAL_CPU_PROFILE_THRESHOLD',    key: 'cpuProfileThreshold',        type: 'float'  },
	{ env: 'SKYSIGNAL_CPU_PROFILE_DURATION',     key: 'cpuProfileDuration',         type: 'int'    },
	{ env: 'SKYSIGNAL_CPU_PROFILE_COOLDOWN',     key: 'cpuProfileCooldown',         type: 'int'    },

	// Performance safeguards
	{ env: 'SKYSIGNAL_MAX_BATCH_RETRIES',        key: 'maxBatchRetries',            type: 'int'    },
	{ env: 'SKYSIGNAL_REQUEST_TIMEOUT',          key: 'requestTimeout',             type: 'int'    },
	{ env: 'SKYSIGNAL_MAX_MEMORY_MB',            key: 'maxMemoryMB',               type: 'int'    },

	// Live queries
	{ env: 'SKYSIGNAL_LIVE_QUERIES_MAX_OBSERVERS', key: 'liveQueriesMaxObservers',  type: 'int'    },

	// Worker
	{ env: 'SKYSIGNAL_USE_WORKER_THREAD',        key: 'useWorkerThread',            type: 'bool'   },
	{ env: 'SKYSIGNAL_WORKER_THRESHOLD',         key: 'workerThreshold',            type: 'int'    },
];

const COERCERS = {
	string: coerceString,
	bool:   coerceBool,
	int:    coerceInt,
	float:  coerceFloat,
	array:  coerceArray,
};

/**
 * Resolve configuration from environment variables.
 *
 * Returns only keys whose env vars are actually set (non-empty), so the
 * result can be safely spread as a middle layer between DEFAULT_CONFIG
 * and Meteor.settings without clobbering defaults for unset keys.
 *
 * Invalid values are warned and skipped — the APM agent should never
 * crash the host application due to a misconfigured env var.
 *
 * @returns {Object} Partial config containing only env-sourced values.
 */
export function resolveEnvConfig() {
	const result = {};
	for (const { env, key, type } of ENV_MAP) {
		const raw = process.env[env];
		if (raw === undefined || raw === '') continue;
		const coerce = COERCERS[type];
		try {
			result[key] = coerce(raw);
		} catch (err) {
			console.warn(`[SkySignal] Ignoring invalid env var ${env}="${raw}": ${err.message}`);
		}
	}
	return result;
}
