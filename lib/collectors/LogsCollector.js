/**
 * LogsCollector - Captures console.* and Meteor Log.* output as structured logs.
 *
 * Wraps:
 * - console.log, console.info, console.warn, console.error, console.debug
 * - Log.info, Log.warn, Log.error, Log.debug (Meteor's logging package)
 *
 * Features:
 * - Level filtering (only capture configured levels)
 * - Sampling support (logSampleRate)
 * - Method context extraction (methodName, traceId from active Meteor Method)
 * - Infinite recursion prevention (3-layer: originals, re-entrancy guard, prefix detection)
 * - Message truncation (logMaxMessageLength)
 */
export default class LogsCollector {
	constructor(options = {}) {
		this.client = options.client;
		this.host = options.host || "unknown";
		this.appVersion = options.appVersion || "unknown";
		this.buildHash = options.buildHash || null;
		this.debug = options.debug || false;

		// Configuration
		this.levels = new Set(options.levels || ["info", "warn", "error", "fatal"]);
		this.sampleRate = options.sampleRate ?? 1.0;
		this.maxMessageLength = options.maxMessageLength || 10000;
		this.captureConsole = options.captureConsole !== false;
		this.captureMeteorLog = options.captureMeteorLog !== false;

		// Stored originals (for restore on stop)
		this._originalConsole = {};
		this._originalMeteorLog = {};

		// Re-entrancy guard
		this._isCapturing = false;

		this._started = false;
	}

	/**
	 * Debug logging helper - uses original console to avoid recursion
	 * @private
	 */
	_log(...args) {
		if (this.debug) {
			const logFn = this._originalConsole.log || console.log;
			logFn.call(console, "[SkySignal:Logs]", ...args);
		}
	}

	/**
	 * Warning logging helper - uses original console to avoid recursion
	 * @private
	 */
	_warn(...args) {
		const warnFn = this._originalConsole.warn || console.warn;
		warnFn.call(console, "[SkySignal:Logs]", ...args);
	}

	/**
	 * Start capturing logs by wrapping console.* and Meteor Log.*
	 */
	start() {
		if (this._started) return;

		if (this.captureConsole) {
			this._wrapConsole();
		}

		if (this.captureMeteorLog) {
			this._wrapMeteorLog();
		}

		this._started = true;
		this._log("Collector started");
	}

	/**
	 * Stop capturing and restore original methods
	 */
	stop() {
		if (!this._started) return;

		this._restoreConsole();
		this._restoreMeteorLog();

		this._started = false;
		this._log("Collector stopped");
	}

	/**
	 * Wrap console.log/info/warn/error/debug
	 * @private
	 */
	_wrapConsole() {
		const methods = {
			log: "info",
			info: "info",
			warn: "warn",
			error: "error",
			debug: "debug"
		};

		for (const [method, level] of Object.entries(methods)) {
			if (typeof console[method] === "function") {
				this._originalConsole[method] = console[method];
				const self = this;
				const originalFn = this._originalConsole[method];

				console[method] = function (...args) {
					// Always call original first so output is never lost
					originalFn.apply(console, args);

					// Layer 2: Re-entrancy guard
					if (self._isCapturing) return;

					// Layer 3: Skip agent's own messages (prefix detection)
					if (args.length > 0 && typeof args[0] === "string" && args[0].startsWith("[SkySignal")) {
						return;
					}

					self._captureLog(level, self._formatArgs(args), "console");
				};
			}
		}
	}

	/**
	 * Wrap Meteor Log.info/warn/error/debug (if available)
	 * @private
	 */
	_wrapMeteorLog() {
		let Log;
		try {
			// Meteor's Log package is a global when the logging package is used
			Log = typeof global !== "undefined" && global.Log;
			if (!Log) {
				// Try Package import
				const pkg = Package && Package["logging"];
				if (pkg) {
					Log = pkg.Log;
				}
			}
		} catch (e) {
			// Log package not available
		}

		if (!Log) {
			this._log("Meteor Log package not found, skipping Meteor Log wrapping");
			return;
		}

		this._meteorLog = Log;

		const methods = {
			info: "info",
			warn: "warn",
			error: "error",
			debug: "debug"
		};

		for (const [method, level] of Object.entries(methods)) {
			if (typeof Log[method] === "function") {
				this._originalMeteorLog[method] = Log[method];
				const self = this;
				const originalFn = this._originalMeteorLog[method];

				Log[method] = function (...args) {
					// Always call original first
					originalFn.apply(Log, args);

					// Re-entrancy guard
					if (self._isCapturing) return;

					// Extract message and metadata from Meteor Log's object format
					const { message, metadata } = self._parseMeteorLogArgs(args);

					// Prefix detection
					if (message.startsWith("[SkySignal")) return;

					self._captureLog(level, message, "meteor-log", metadata);
				};
			}
		}
	}

	/**
	 * Restore original console methods
	 * @private
	 */
	_restoreConsole() {
		for (const [method, original] of Object.entries(this._originalConsole)) {
			if (original) {
				console[method] = original;
			}
		}
		this._originalConsole = {};
	}

	/**
	 * Restore original Meteor Log methods
	 * @private
	 */
	_restoreMeteorLog() {
		if (!this._meteorLog) return;

		for (const [method, original] of Object.entries(this._originalMeteorLog)) {
			if (original) {
				this._meteorLog[method] = original;
			}
		}
		this._originalMeteorLog = {};
		this._meteorLog = null;
	}

	/**
	 * Core capture method - applies filtering, sampling, and sends to client
	 * @private
	 */
	_captureLog(level, message, source, metadata = {}) {
		// Level filter
		if (!this._shouldCapture(level)) return;

		// Set re-entrancy guard
		this._isCapturing = true;

		try {
			// Truncate message
			if (message.length > this.maxMessageLength) {
				message = message.substring(0, this.maxMessageLength) + "...[truncated]";
			}

			// Extract method context if available
			const methodContext = this._getMethodContext();

			const logEntry = {
				level,
				message,
				source,
				host: this.host,
				timestamp: new Date()
			};

			// Add method context fields if present
			if (methodContext.methodName) logEntry.methodName = methodContext.methodName;
			if (methodContext.traceId) logEntry.traceId = methodContext.traceId;
			if (methodContext.userId) logEntry.userId = methodContext.userId;
			if (methodContext.sessionId) logEntry.sessionId = methodContext.sessionId;

			// Add metadata if non-empty
			if (metadata && Object.keys(metadata).length > 0) {
				logEntry.metadata = metadata;
			}

			this.client.addLog(logEntry);
		} finally {
			this._isCapturing = false;
		}
	}

	/**
	 * Check if a log at the given level should be captured
	 * @private
	 */
	_shouldCapture(level) {
		// Level filter
		if (!this.levels.has(level)) return false;

		// Sampling
		if (this.sampleRate < 1.0 && Math.random() > this.sampleRate) return false;

		return true;
	}

	/**
	 * Convert multi-arg console calls to a single string
	 * @private
	 */
	_formatArgs(args) {
		if (args.length === 0) return "";
		if (args.length === 1) {
			return this._argToString(args[0]);
		}
		return args.map(arg => this._argToString(arg)).join(" ");
	}

	/**
	 * Convert a single argument to string
	 * @private
	 */
	_argToString(arg) {
		if (arg === null) return "null";
		if (arg === undefined) return "undefined";
		if (typeof arg === "string") return arg;
		if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
		if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? "\n" + arg.stack : ""}`;

		// Objects and arrays
		try {
			return JSON.stringify(arg);
		} catch (e) {
			// Circular reference or other serialization error
			try {
				return String(arg);
			} catch (e2) {
				return "[unserializable]";
			}
		}
	}

	/**
	 * Parse Meteor Log arguments
	 * Meteor Log accepts either a string or an object with a message field
	 * @private
	 */
	_parseMeteorLogArgs(args) {
		if (args.length === 0) return { message: "", metadata: {} };

		const first = args[0];

		// Meteor Log.info("string message")
		if (typeof first === "string") {
			return { message: first, metadata: {} };
		}

		// Meteor Log.info({ message: "text", key: "val" })
		if (typeof first === "object" && first !== null) {
			const { message, ...rest } = first;
			return {
				message: message ? String(message) : this._argToString(first),
				metadata: rest
			};
		}

		return { message: this._argToString(first), metadata: {} };
	}

	/**
	 * Extract method context from active Meteor Method execution
	 * @private
	 */
	_getMethodContext() {
		const tracer = typeof global !== "undefined" && global.SkySignalTracer;
		if (!tracer) return {};

		const ctx = tracer.getCurrentContext();
		if (!ctx) return {};
		return {
			methodName: ctx.methodName,
			traceId: ctx.traceId,
			userId: ctx.userId,
			sessionId: ctx.sessionId
		};
	}
}
