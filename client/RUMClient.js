/**
 * RUMClient - Real User Monitoring client for browser-side performance tracking.
 *
 * This class handles batching and HTTP transmission of RUM measurements to the
 * SkySignal server. It's designed for minimal impact on page performance with
 * fire-and-forget HTTP requests and reliable page unload handling.
 *
 * **Features:**
 * - Batches measurements to reduce HTTP requests (default: 10 items or 5 seconds)
 * - Fire-and-forget HTTP with `keepalive` for reliability during page unload
 * - Public key authentication (pk_ prefix keys)
 * - Automatic flush on visibility change, beforeunload, and freeze events
 * - Graceful error handling (never throws, never blocks)
 *
 * **Sampling:**
 * Sampling is controlled server-side via site configuration (Configs.rum.samplingRate).
 * The client always collects 100% of measurements and sends to server,
 * which applies sampling based on the configured rate.
 *
 * @class RUMClient
 *
 * @example
 * // Initialize RUM client
 * import RUMClient from 'meteor/skysignal:agent/client/RUMClient';
 *
 * const rum = new RUMClient({
 *   publicKey: 'pk_xxx',
 *   batchSize: 10,
 *   flushInterval: 5000
 * });
 *
 * @example
 * // Track a page load measurement
 * rum.addMeasurement({
 *   type: 'pageLoad',
 *   timestamp: new Date(),
 *   url: window.location.href,
 *   metrics: {
 *     domContentLoaded: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart,
 *     loadComplete: performance.timing.loadEventEnd - performance.timing.navigationStart
 *   }
 * });
 *
 * @example
 * // Track Web Vitals
 * rum.addMeasurement({
 *   type: 'webVitals',
 *   timestamp: new Date(),
 *   url: window.location.href,
 *   metrics: {
 *     LCP: 2500,  // Largest Contentful Paint
 *     FID: 100,   // First Input Delay
 *     CLS: 0.1    // Cumulative Layout Shift
 *   }
 * });
 */

export default class RUMClient {
	/**
	 * Create a new RUMClient instance.
	 *
	 * @param {Object} [config={}] - Configuration options
	 * @param {string} config.publicKey - **Required.** SkySignal public API key (pk_xxx)
	 * @param {string} [config.endpoint="/api/v1/rum"] - API endpoint for RUM data
	 * @param {number} [config.batchSize=10] - Maximum measurements per batch before auto-flush
	 * @param {number} [config.flushInterval=5000] - Auto-flush interval in milliseconds
	 * @param {boolean} [config.debug=false] - Enable debug logging
	 */
	constructor(config = {}) {
		this.config = {
			publicKey: config.publicKey,
			endpoint: config.endpoint || '/api/v1/rum',
			batchSize: config.batchSize || 10,
			flushInterval: config.flushInterval || 5000, // 5 seconds
			debug: config.debug || false
		};

		this.batch = [];
		this.flushTimer = null;
		// NOTE: Sampling is now handled server-side via Configs.rum.samplingRate
		// Client always collects 100% and sends to server
		// Server applies sampling based on site configuration
		this.enabled = !!this.config.publicKey;

		// Setup auto-flush on visibility change
		this._setupAutoFlush();

		if (this.config.debug) {
			console.log('[SkySignal RUM] Client initialized', {
				enabled: this.enabled,
				note: 'Sampling is controlled server-side via site configuration'
			});
		}

		if (!this.config.publicKey) {
			console.warn('[SkySignal RUM] No public key configured - RUM collection disabled');
		}
	}

	/**
	 * Setup auto-flush triggers
	 * @private
	 */
	_setupAutoFlush() {
		// Flush on visibility change (user leaving page)
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				this.flush();
			}
		});

		// Flush on page unload (backup)
		window.addEventListener('beforeunload', () => {
			this.flush();
		});

		// Flush on page freeze (mobile browsers)
		window.addEventListener('freeze', () => {
			this.flush();
		});
	}

	/**
	 * Add a RUM measurement to the batch for sending.
	 *
	 * Measurements are batched and sent either when the batch reaches
	 * `batchSize` or after `flushInterval` milliseconds, whichever comes first.
	 *
	 * @param {Object} measurement - RUM measurement data
	 * @param {string} measurement.type - Measurement type (e.g., "pageLoad", "webVitals", "interaction")
	 * @param {Date|string} measurement.timestamp - When the measurement was taken
	 * @param {string} [measurement.url] - Page URL
	 * @param {string} [measurement.sessionId] - Client session identifier
	 * @param {Object} [measurement.metrics] - Performance metrics (LCP, FID, CLS, etc.)
	 * @param {Object} [measurement.browser] - Browser information
	 * @param {Object} [measurement.device] - Device information
	 * @returns {void}
	 *
	 * @example
	 * // Track page load timing
	 * rum.addMeasurement({
	 *   type: 'pageLoad',
	 *   timestamp: new Date(),
	 *   url: window.location.href,
	 *   metrics: {
	 *     ttfb: 120,           // Time to First Byte
	 *     fcp: 800,            // First Contentful Paint
	 *     domInteractive: 1200,
	 *     loadComplete: 2500
	 *   }
	 * });
	 *
	 * @example
	 * // Track user interaction
	 * rum.addMeasurement({
	 *   type: 'interaction',
	 *   timestamp: new Date(),
	 *   url: window.location.href,
	 *   metrics: {
	 *     interactionType: 'click',
	 *     target: 'button.submit',
	 *     latency: 50
	 *   }
	 * });
	 */
	addMeasurement(measurement) {
		if (!this.enabled) {
			if (this.config.debug) {
				console.log('[SkySignal RUM] Measurement skipped (sampling)', measurement);
			}
			return;
		}

		// No need to add customerId/siteId - these will be derived from publicKey on server
		this.batch.push(measurement);

		if (this.config.debug) {
			console.log('[SkySignal RUM] Measurement added to batch', measurement);
		}

		// Flush if batch is full
		if (this.batch.length >= this.config.batchSize) {
			this.flush();
		} else {
			// Schedule flush if not already scheduled
			if (!this.flushTimer) {
				this.flushTimer = setTimeout(() => {
					this.flush();
				}, this.config.flushInterval);
			}
		}
	}

	/**
	 * Immediately flush all pending measurements to the server.
	 *
	 * This is called automatically on:
	 * - Batch reaching `batchSize`
	 * - `flushInterval` timer firing
	 * - Page visibility change (hidden)
	 * - Page beforeunload event
	 * - Page freeze event (mobile browsers)
	 *
	 * Safe to call manually when you need immediate transmission.
	 *
	 * @returns {void}
	 *
	 * @example
	 * // Force immediate send before navigation
	 * rum.flush();
	 * window.location.href = '/new-page';
	 */
	flush() {
		// Clear scheduled flush
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		// Nothing to send
		if (this.batch.length === 0) {
			return;
		}

		const measurements = [...this.batch];
		this.batch = [];

		this._send(measurements);
	}

	/**
	 * Send measurements to SkySignal server
	 * @private
	 */
	_send(measurements) {
		// Build payload
		const payload = {
			measurements: measurements.map(m => ({
				...m,
				// Ensure timestamp is ISO string
				timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp
			}))
		};

		// Determine URL (relative or absolute)
		const url = this.config.endpoint.startsWith('http')
			? this.config.endpoint
			: `${window.location.origin}${this.config.endpoint}`;

		if (this.config.debug) {
			console.log('[SkySignal RUM] Sending measurements', {
				count: measurements.length,
				url: url,
				measurements
			});
		}

		// Fire-and-forget HTTP request with keepalive
		// keepalive ensures the request completes even if the page is unloaded
		try {
			fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-SkySignal-Public-Key': this.config.publicKey
				},
				body: JSON.stringify(payload),
				keepalive: true // Critical for page unload scenarios
			}).then(response => {
				if (this.config.debug) {
					if (response.ok) {
						console.log('[SkySignal RUM] Measurements sent successfully');
					} else {
						console.warn('[SkySignal RUM] Server returned error:', response.status);
					}
				}
			}).catch(error => {
				// Silently fail - we don't want RUM collection to break the app
				if (this.config.debug) {
					console.error('[SkySignal RUM] Failed to send measurements:', error);
				}
			});
		} catch (error) {
			// Fetch not available or other error
			if (this.config.debug) {
				console.error('[SkySignal RUM] Failed to send measurements:', error);
			}
		}
	}

	/**
	 * Update client configuration at runtime.
	 *
	 * Useful for Single Page Applications (SPAs) where configuration
	 * may need to change during navigation without reinitializing the client.
	 *
	 * @param {Object} newConfig - Configuration values to update
	 * @param {number} [newConfig.batchSize] - New batch size
	 * @param {number} [newConfig.flushInterval] - New flush interval
	 * @param {boolean} [newConfig.debug] - Enable/disable debug mode
	 * @returns {void}
	 *
	 * @example
	 * // Increase batch size for high-traffic pages
	 * rum.updateConfig({ batchSize: 20 });
	 *
	 * @example
	 * // Enable debug mode temporarily
	 * rum.updateConfig({ debug: true });
	 */
	updateConfig(newConfig) {
		Object.assign(this.config, newConfig);
	}

	/**
	 * Get the number of measurements currently in the batch.
	 *
	 * Useful for monitoring and debugging to see how many measurements
	 * are waiting to be sent.
	 *
	 * @returns {number} Number of measurements in current batch
	 *
	 * @example
	 * console.log(`Pending RUM measurements: ${rum.getBatchSize()}`);
	 */
	getBatchSize() {
		return this.batch.length;
	}

	/**
	 * Check if the RUM client is enabled and collecting measurements.
	 *
	 * The client is disabled if no `publicKey` was provided during construction.
	 *
	 * @returns {boolean} True if client is collecting measurements
	 *
	 * @example
	 * if (rum.isEnabled()) {
	 *   rum.addMeasurement({ type: 'custom', ... });
	 * }
	 */
	isEnabled() {
		return this.enabled;
	}
}
