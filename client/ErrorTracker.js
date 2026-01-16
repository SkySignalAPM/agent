/**
 * SkySignal Error Tracker - Client-side error capture with optional screenshots.
 *
 * This class automatically captures JavaScript errors, unhandled promise rejections,
 * and optionally console.error calls from the browser. Errors are sent to the
 * SkySignal platform for tracking and analysis.
 *
 * **Features:**
 * - Automatic capture of window.onerror events
 * - Unhandled promise rejection tracking
 * - Optional console.error interception
 * - Screenshot capture on errors (with redaction support)
 * - Error deduplication via fingerprinting
 * - Configurable error filtering (ignore patterns)
 * - beforeSend hook for error modification
 *
 * **Configuration via Meteor.settings:**
 * ```json
 * {
 *   "public": {
 *     "skysignal": {
 *       "publicKey": "pk_xxx",
 *       "errorTracking": {
 *         "enabled": true,
 *         "attachScreenshots": true,
 *         "screenshotQuality": 0.7,
 *         "screenshotSamplingRate": 100,
 *         "maxScreenshotSize": 500000,
 *         "redactSelectors": [".sensitive", "[data-private]"],
 *         "screenshotOnErrorTypes": ["FatalError", "UnhandledRejection"],
 *         "captureUnhandledRejections": true,
 *         "captureConsoleErrors": false,
 *         "ignoreErrors": ["ResizeObserver loop"],
 *         "debug": false
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * @class ErrorTracker
 * @example
 * // Initialize error tracking
 * import ErrorTracker from 'meteor/skysignal:agent/client/ErrorTracker';
 *
 * const tracker = new ErrorTracker({
 *   publicKey: 'pk_xxx',
 *   enabled: true,
 *   captureUnhandledRejections: true
 * });
 * tracker.init();
 *
 * @example
 * // Manually capture errors in try/catch blocks
 * try {
 *   riskyOperation();
 * } catch (error) {
 *   tracker.captureError(error, {
 *     context: 'checkout',
 *     userId: currentUser.id
 *   });
 * }
 */

import ScreenshotCapture from './ScreenshotCapture';

export default class ErrorTracker {
	/**
	 * Create a new ErrorTracker instance.
	 *
	 * @param {Object} [config={}] - Configuration options
	 * @param {boolean} [config.enabled=true] - Enable/disable error tracking
	 * @param {string} config.publicKey - **Required.** SkySignal public API key (pk_xxx)
	 * @param {string} [config.endpoint="/api/v1/errors"] - API endpoint for error submission
	 * @param {boolean} [config.attachScreenshots=false] - Capture screenshots on errors
	 * @param {number} [config.screenshotQuality=0.7] - JPEG quality for screenshots (0.0-1.0)
	 * @param {number} [config.maxScreenshotSize=512000] - Maximum screenshot size in bytes
	 * @param {number} [config.screenshotSamplingRate=100] - Percentage of errors to screenshot
	 * @param {string[]} [config.redactSelectors] - CSS selectors for elements to redact in screenshots
	 * @param {string[]} [config.screenshotOnErrorTypes] - Only screenshot these error types
	 * @param {boolean} [config.captureUnhandledRejections=true] - Capture unhandled Promise rejections
	 * @param {boolean} [config.captureConsoleErrors=false] - Intercept console.error calls
	 * @param {Array<string|RegExp>} [config.ignoreErrors=[]] - Patterns for errors to ignore
	 * @param {Function} [config.beforeSend] - Hook to modify errors before sending (return false to skip)
	 * @param {boolean} [config.debug=false] - Enable debug logging
	 */
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
	 * Initialize error tracking and set up event listeners.
	 *
	 * This method must be called before errors will be captured. It sets up:
	 * 1. Global `window.onerror` handler for uncaught exceptions
	 * 2. `unhandledrejection` handler for Promise rejections (if enabled)
	 * 3. `console.error` interception (if enabled)
	 *
	 * **Prerequisites:**
	 * - `publicKey` must be configured
	 * - `enabled` must be true (default)
	 *
	 * Safe to call multiple times (subsequent calls are no-ops).
	 *
	 * @returns {void}
	 *
	 * @example
	 * // Standard initialization
	 * const tracker = new ErrorTracker({
	 *   publicKey: 'pk_xxx'
	 * });
	 * tracker.init();
	 *
	 * @example
	 * // Initialize with Meteor startup
	 * Meteor.startup(() => {
	 *   const config = Meteor.settings.public?.skysignal?.errorTracking;
	 *   if (config?.enabled) {
	 *     const tracker = new ErrorTracker(config);
	 *     tracker.init();
	 *   }
	 * });
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
	 * Set up the global window.onerror handler.
	 * @private
	 * @returns {void}
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
	 * Set up the unhandledrejection event handler for Promise rejections.
	 * @private
	 * @returns {void}
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
	 * Set up console.error interception to capture logged errors.
	 * @private
	 * @returns {void}
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
	 * Check if an error message matches any ignore patterns.
	 * @private
	 * @param {string} errorMessage - The error message to check
	 * @returns {boolean} True if error should be ignored
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
	 * Generate a unique fingerprint for error deduplication.
	 * Combines type, message, filename, and line number.
	 * @private
	 * @param {Object} error - Error object
	 * @returns {string} Fingerprint string
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
	 * Process and send an error to the SkySignal platform.
	 * Handles deduplication, screenshot capture, and beforeSend hooks.
	 * @private
	 * @param {Object} error - Error data to process
	 * @returns {Promise<void>}
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
	 * Send an error payload to the SkySignal API.
	 * Failed requests are queued for retry.
	 * @private
	 * @param {Object} error - Complete error payload to send
	 * @returns {Promise<void>}
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
	 * Manually capture and report an error.
	 *
	 * Use this method to capture errors from try/catch blocks or other
	 * situations where automatic capture doesn't apply. The error will
	 * be processed through the same pipeline as automatic captures,
	 * including deduplication, screenshot capture, and beforeSend hooks.
	 *
	 * @param {Error|string} error - The error to capture (Error object or string message)
	 * @param {Object} [context={}] - Additional context to attach to the error
	 * @param {string} [context.userId] - User ID for attribution
	 * @param {string} [context.component] - Component or module name
	 * @param {Object} [context.metadata] - Any additional metadata
	 * @returns {Promise<void>}
	 *
	 * @example
	 * // Capture error from try/catch
	 * try {
	 *   await processPayment(order);
	 * } catch (error) {
	 *   await tracker.captureError(error, {
	 *     component: 'PaymentProcessor',
	 *     orderId: order.id
	 *   });
	 *   // Handle error gracefully for user
	 *   showErrorMessage('Payment failed, please try again');
	 * }
	 *
	 * @example
	 * // Capture a warning condition as an error
	 * if (unusualCondition) {
	 *   await tracker.captureError(new Error('Unusual condition detected'), {
	 *     severity: 'warning',
	 *     conditionValue: someValue
	 *   });
	 * }
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
	 * Get statistics about the error tracker's state.
	 *
	 * Use this to monitor the health of error tracking and detect
	 * issues like queued errors (network problems) or high pending
	 * counts (processing bottlenecks).
	 *
	 * @returns {Object} Statistics object
	 * @returns {boolean} returns.initialized - Whether init() has been called
	 * @returns {number} returns.queuedErrors - Errors waiting to be retried
	 * @returns {number} returns.pendingErrors - Errors currently being processed
	 * @returns {Object} [returns.screenshots] - Screenshot capture stats (if enabled)
	 *
	 * @example
	 * const stats = tracker.getStats();
	 * console.log(`Queued errors: ${stats.queuedErrors}`);
	 *
	 * if (stats.queuedErrors > 10) {
	 *   console.warn('Error queue growing - check network connectivity');
	 * }
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
	 * Check if the error tracker has been initialized.
	 *
	 * @returns {boolean} True if init() has been successfully called
	 *
	 * @example
	 * if (!tracker.isInitialized()) {
	 *   tracker.init();
	 * }
	 */
	isInitialized() {
		return this.initialized;
	}
}
