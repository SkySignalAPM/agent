import { Meteor } from "meteor/meteor";
import { WebApp } from "meteor/webapp";

// Pre-compiled regex patterns for route extraction (avoids re-compilation per request)
const MONGODB_OBJECTID_REGEX = /\/[0-9a-f]{24}/g;
const UUID_REGEX = /\/[0-9a-f-]{36}/g;
const NUMERIC_ID_REGEX = /\/\d+/g;
const STATIC_FILE_REGEX = /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|ico|json|xml|txt)$/;

/**
 * HTTPCollector
 * Tracks HTTP request metrics using Express middleware
 *
 * Monitors:
 * - Request method, path, and route
 * - Response status codes and times
 * - Request/response sizes
 * - Client information (IP, user agent)
 */
export default class HTTPCollector {
	constructor(options = {}) {
		this.client = options.client; // SkySignalClient instance
		this.host = options.host || "unknown-host";
		this.appVersion = options.appVersion || "unknown";
		this.buildHash = options.buildHash || null;
		this.interval = options.interval || 10000; // 10 seconds default
		this.sampleRate = options.sampleRate ?? 1.0; // Sample 100% by default
		this.excludePatterns = options.excludePatterns || [
			/^\/sockjs\//,  // SockJS connections
			/^\/meteor_runtime_config\.js/,
			/^\/favicon\.ico$/,
			/^\/__cordova\//,
			/^\/__browser\//
		];

		this.batch = [];
		this.maxBatchSize = options.maxBatchSize || 1000; // Prevent unbounded growth
		this.intervalId = null;
		this.middleware = null;
	}

	/**
	 * Start collecting HTTP request data
	 */
	start() {
		if (this.intervalId) {
			console.warn("⚠️ HTTPCollector already started");
			return;
		}

		// Add Express middleware to track requests
		this._setupMiddleware();

		// Send batched requests at regular intervals
		this.intervalId = setInterval(() => {
			this._sendBatch();
		}, this.interval);

		console.log(`✅ HTTPCollector started (interval: ${this.interval}ms, sampleRate: ${this.sampleRate})`);
	}

	/**
	 * Stop collecting HTTP request data
	 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		// Remove middleware from WebApp handlers to prevent memory leak
		if (this.middleware && WebApp.handlers && WebApp.handlers.stack) {
			WebApp.handlers.stack = WebApp.handlers.stack.filter(
				layer => layer.handle !== this.middleware
			);
			this.middleware = null;
		}

		// Send final batch
		this._sendBatch();

		console.log("⏹️ HTTPCollector stopped");
	}

	/**
	 * Setup Express middleware to track HTTP requests
	 * @private
	 */
	_setupMiddleware() {
		const self = this;

		// Express middleware function
		this.middleware = (req, res, next) => {
			// Check if we should track this request
			if (!self._shouldTrack(req.url)) {
				return next();
			}

			// Apply sampling
			if (Math.random() > self.sampleRate) {
				return next();
			}

			// Capture request start time
			const startTime = Date.now();
			const startHrTime = process.hrtime();

			// Store original methods
			const originalEnd = res.end;
			const originalWrite = res.write;

			// Track response size
			let responseSize = 0;

			// Wrap res.write to track size
			res.write = function(...args) {
				if (args[0]) {
					if (Buffer.isBuffer(args[0])) {
						responseSize += args[0].length;
					} else if (typeof args[0] === 'string') {
						responseSize += Buffer.byteLength(args[0]);
					}
				}
				return originalWrite.apply(res, args);
			};

			// Wrap res.end to capture metrics
			res.end = function(...args) {
				// Calculate response time
				const hrDiff = process.hrtime(startHrTime);
				const responseTime = (hrDiff[0] * 1000) + (hrDiff[1] / 1000000); // Convert to ms

				// Track final chunk size
				if (args[0]) {
					if (Buffer.isBuffer(args[0])) {
						responseSize += args[0].length;
					} else if (typeof args[0] === 'string') {
						responseSize += Buffer.byteLength(args[0]);
					}
				}

				// Extract request data
				const requestData = {
					timestamp: new Date(startTime),
					method: req.method,
					path: req.url,
					route: self._extractRoute(req),
					statusCode: res.statusCode,
					responseTime: Math.round(responseTime),
					size: responseSize,
					userId: req.userId || null, // From Meteor DDP
					ip: self._getClientIP(req),
					userAgent: req.headers['user-agent'] || null,
					referrer: req.headers['referer'] || req.headers['referrer'] || null,
					host: self.host,
					appVersion: self.appVersion,
					buildHash: self.buildHash
				};

				// Add to batch (with size limit to prevent unbounded growth)
				if (self.batch.length >= self.maxBatchSize) {
					// Drop oldest entries to make room
					const dropCount = Math.floor(self.maxBatchSize * 0.1); // Drop 10%
					self.batch.splice(0, dropCount);
					console.warn(`⚠️ HTTPCollector: Batch limit reached (${self.maxBatchSize}), dropped ${dropCount} oldest entries`);
				}
				self.batch.push(requestData);

				// Auto-flush if batch is large
				if (self.batch.length >= 100) {
					self._sendBatch();
				}

				// Call original end
				return originalEnd.apply(res, args);
			};

			// Continue to next middleware
			next();
		};

		// Register middleware with WebApp
		WebApp.handlers.use(this.middleware);
		console.log("✅ HTTP monitoring middleware registered");
	}

	/**
	 * Check if request should be tracked
	 * @private
	 */
	_shouldTrack(url) {
		// Check against exclude patterns
		for (const pattern of this.excludePatterns) {
			if (pattern.test(url)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Extract route pattern from request
	 * @private
	 */
	_extractRoute(req) {
		// Try to get route from Iron Router / Flow Router / Picker
		if (req.route && req.route.path) {
			return req.route.path;
		}

		// Fallback: normalize URL path
		const path = req.url.split('?')[0]; // Remove query string

		// Try to detect common patterns
		// API routes - use pre-compiled regex patterns
		if (path.startsWith('/api/')) {
			return path
				.replace(MONGODB_OBJECTID_REGEX, '/:id') // MongoDB ObjectIDs
				.replace(UUID_REGEX, '/:uuid') // UUIDs
				.replace(NUMERIC_ID_REGEX, '/:id'); // Numeric IDs
		}

		// Static files - use pre-compiled regex
		if (STATIC_FILE_REGEX.test(path)) {
			return path;
		}

		// Default: return the path as-is
		return path;
	}

	/**
	 * Get client IP address
	 * @private
	 */
	_getClientIP(req) {
		// Check for proxy headers first
		const forwarded = req.headers['x-forwarded-for'];
		if (forwarded) {
			// x-forwarded-for can be a comma-separated list
			return forwarded.split(',')[0].trim();
		}

		const realIP = req.headers['x-real-ip'];
		if (realIP) {
			return realIP;
		}

		// Fallback to connection remote address
		return req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
	}

	/**
	 * Send batched requests to platform
	 * @private
	 */
	_sendBatch() {
		if (this.batch.length === 0) {
			return;
		}

		const requests = [...this.batch];
		this.batch = []; // Clear batch immediately

		// Send to platform via SkySignalClient
		if (this.client) {
			requests.forEach(request => {
				this.client.addHttpRequest(request);
			});
			console.log(`📊 HTTPCollector: Batched ${requests.length} HTTP requests`);
		}
	}

	/**
	 * Get current stats (for debugging)
	 */
	getStats() {
		return {
			pendingRequests: this.batch.length,
			sampleRate: this.sampleRate,
			excludePatterns: this.excludePatterns.map(p => p.toString())
		};
	}
}
