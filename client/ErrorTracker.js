/**
 * SkySignal Error Tracker Client
 *
 * Captures client-side errors with optional screenshot capture
 * Integrates with SkySignal error tracking system
 *
 * Configuration via settings.json:
 * {
 *   "public": {
 *     "skysignal": {
 *       "publicKey": "pk_xxx",
 *       "errorTracking": {
 *         "enabled": true,
 *         "attachScreenshots": true,
 *         "screenshotQuality": 0.7,
 *         "screenshotSamplingRate": 10,
 *         "maxScreenshotSize": 500000,
 *         "redactSelectors": [...],
 *         "screenshotOnErrorTypes": ["FatalError", "UnhandledRejection"],
 *         "captureUnhandledRejections": true,
 *         "captureConsoleErrors": true,
 *         "ignoreErrors": [],
 *         "beforeSend": null,
 *         "debug": false
 *       }
 *     }
 *   }
 * }
 */

import ScreenshotCapture from './ScreenshotCapture';

export default class ErrorTracker {
	constructor(config = {}) {
		this.config = {
			enabled: config.enabled !== false,
			publicKey: config.publicKey,
			endpoint: config.endpoint || '/api/v1/errors',
			attachScreenshots: config.attachScreenshots || false,
			captureUnhandledRejections: config.captureUnhandledRejections !== false,
			captureConsoleErrors: config.captureConsoleErrors || false,
			ignoreErrors: config.ignoreErrors || [],
			beforeSend: config.beforeSend || null,
			debug: config.debug || false
		};

		// Initialize screenshot capture
		this.screenshotCapture = null;
		if (this.config.attachScreenshots) {
			this.screenshotCapture = new ScreenshotCapture({
				enabled: true,
				quality: config.screenshotQuality || 0.7,
				maxSize: config.maxScreenshotSize || 500 * 1024, // 500KB
				samplingRate: config.screenshotSamplingRate || 100, // Capture 100% by default, can be reduced
				redactSelectors: config.redactSelectors, // Use defaults if not provided
				screenshotOnErrorTypes: config.screenshotOnErrorTypes || [],
				debug: config.debug
			});
		}

		// Track initialization state
		this.initialized = false;
		this.errorQueue = [];
		this.pendingErrors = new Set();
	}

	/**
	 * Initialize error tracking
	 */
	init() {
		if (this.initialized) {
			console.warn('[SkySignal ErrorTracker] Already initialized');
			return;
		}

		if (!this.config.enabled) {
			if (this.config.debug) {
				console.log('[SkySignal ErrorTracker] Disabled via configuration');
			}
			return;
		}

		if (!this.config.publicKey) {
			console.error('[SkySignal ErrorTracker] Missing required configuration: publicKey');
			return;
		}

		// Setup global error handler
		this._setupGlobalErrorHandler();

		// Setup unhandled rejection handler
		if (this.config.captureUnhandledRejections) {
			this._setupUnhandledRejectionHandler();
		}

		// Setup console error capture
		if (this.config.captureConsoleErrors) {
			this._setupConsoleErrorCapture();
		}

		this.initialized = true;

		if (this.config.debug) {
			console.log('[SkySignal ErrorTracker] Initialized successfully', {
				endpoint: this.config.endpoint,
				attachScreenshots: this.config.attachScreenshots,
				captureUnhandledRejections: this.config.captureUnhandledRejections,
				captureConsoleErrors: this.config.captureConsoleErrors
			});
		}
	}

	/**
	 * Setup global error handler
	 */
	_setupGlobalErrorHandler() {
		window.addEventListener('error', async (event) => {
			try {
				await this._handleError({
					type: event.error?.constructor?.name || 'Error',
					message: event.message,
					stack: event.error?.stack,
					filename: event.filename,
					lineno: event.lineno,
					colno: event.colno,
					timestamp: new Date(),
					url: window.location.href,
					userAgent: navigator.userAgent
				});
			} catch (err) {
				if (this.config.debug) {
					console.error('[SkySignal ErrorTracker] Failed to handle error', err);
				}
			}
		});
	}

	/**
	 * Setup unhandled promise rejection handler
	 */
	_setupUnhandledRejectionHandler() {
		window.addEventListener('unhandledrejection', async (event) => {
			try {
				const reason = event.reason;
				await this._handleError({
					type: 'UnhandledRejection',
					message: reason?.message || String(reason),
					stack: reason?.stack,
					timestamp: new Date(),
					url: window.location.href,
					userAgent: navigator.userAgent
				});
			} catch (err) {
				if (this.config.debug) {
					console.error('[SkySignal ErrorTracker] Failed to handle unhandled rejection', err);
				}
			}
		});
	}

	/**
	 * Setup console error capture
	 */
	_setupConsoleErrorCapture() {
		const originalConsoleError = console.error;
		console.error = async (...args) => {
			// Call original console.error
			originalConsoleError.apply(console, args);

			// Capture error for tracking
			try {
				await this._handleError({
					type: 'ConsoleError',
					message: args.map(arg => String(arg)).join(' '),
					timestamp: new Date(),
					url: window.location.href,
					userAgent: navigator.userAgent
				});
			} catch (err) {
				// Don't throw in console.error override
			}
		};
	}

	/**
	 * Check if error should be ignored
	 */
	_shouldIgnoreError(errorMessage) {
		return this.config.ignoreErrors.some(pattern => {
			if (pattern instanceof RegExp) {
				return pattern.test(errorMessage);
			}
			return errorMessage.includes(pattern);
		});
	}

	/**
	 * Generate error fingerprint for deduplication
	 */
	_generateFingerprint(error) {
		const parts = [
			error.type,
			error.message,
			error.filename || '',
			error.lineno || ''
		];
		return parts.join('|');
	}

	/**
	 * Handle error
	 */
	async _handleError(error) {
		// Check if error should be ignored
		if (this._shouldIgnoreError(error.message)) {
			if (this.config.debug) {
				console.log('[SkySignal ErrorTracker] Ignored error', error.message);
			}
			return;
		}

		// Generate fingerprint for deduplication
		const fingerprint = this._generateFingerprint(error);

		// Check if we're already processing this error
		if (this.pendingErrors.has(fingerprint)) {
			return;
		}

		this.pendingErrors.add(fingerprint);

		try {
			// Capture screenshot if enabled
			let screenshot = null;
			if (this.screenshotCapture) {
				screenshot = await this.screenshotCapture.capture({
					type: error.type,
					message: error.message
				});
			}

			// Build error payload
			const errorPayload = {
				...error,
				screenshot: screenshot,
				capturedAt: new Date().toISOString()
			};

			// Call beforeSend hook if provided
			if (this.config.beforeSend) {
				try {
					const result = this.config.beforeSend(errorPayload);
					if (result === false || result === null) {
						// BeforeSend hook returned false/null, skip sending
						this.pendingErrors.delete(fingerprint);
						return;
					}
					// Use modified payload if returned
					if (result && typeof result === 'object') {
						Object.assign(errorPayload, result);
					}
				} catch (hookError) {
					if (this.config.debug) {
						console.error('[SkySignal ErrorTracker] beforeSend hook error', hookError);
					}
				}
			}

			// Send error to platform
			await this._sendError(errorPayload);
		} finally {
			this.pendingErrors.delete(fingerprint);
		}
	}

	/**
	 * Send error to SkySignal platform
	 */
	async _sendError(error) {
		try {
			const response = await fetch(this.config.endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-SkySignal-Public-Key': this.config.publicKey
				},
				body: JSON.stringify(error)
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			if (this.config.debug) {
				console.log('[SkySignal ErrorTracker] Error sent successfully', {
					type: error.type,
					message: error.message,
					hasScreenshot: !!error.screenshot
				});
			}
		} catch (err) {
			if (this.config.debug) {
				console.error('[SkySignal ErrorTracker] Failed to send error', err);
			}

			// Queue for retry
			this.errorQueue.push(error);
		}
	}

	/**
	 * Manually capture an error
	 * Useful for try/catch blocks
	 */
	async captureError(error, context = {}) {
		if (!this.initialized) {
			console.warn('[SkySignal ErrorTracker] Not initialized');
			return;
		}

		await this._handleError({
			type: error?.constructor?.name || 'Error',
			message: error?.message || String(error),
			stack: error?.stack,
			timestamp: new Date(),
			url: window.location.href,
			userAgent: navigator.userAgent,
			...context
		});
	}

	/**
	 * Get error tracker statistics
	 */
	getStats() {
		const stats = {
			initialized: this.initialized,
			queuedErrors: this.errorQueue.length,
			pendingErrors: this.pendingErrors.size
		};

		if (this.screenshotCapture) {
			stats.screenshots = this.screenshotCapture.getStats();
		}

		return stats;
	}

	/**
	 * Check if error tracking is initialized
	 */
	isInitialized() {
		return this.initialized;
	}
}
