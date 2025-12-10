/**
 * RUMClient
 * Handles batching and HTTP transmission of RUM measurements to SkySignal server
 *
 * Features:
 * - Batches measurements to reduce HTTP requests
 * - Fire-and-forget HTTP with keepalive for reliability during page unload
 * - Public key authentication (pk_ prefix)
 * - Graceful error handling
 *
 * Note: Sampling is controlled server-side via Configs.rum.samplingRate
 * Client always collects 100% and server applies sampling based on site configuration
 */

export default class RUMClient {
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
	 * Add a measurement to the batch
	 * @param {Object} measurement - RUM measurement data
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
	 * Flush all pending measurements to the server
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
	 * Update configuration (useful for SPA route changes)
	 * @param {Object} newConfig - New configuration values
	 */
	updateConfig(newConfig) {
		Object.assign(this.config, newConfig);
	}

	/**
	 * Get current batch size (for debugging)
	 * @returns {Number} Number of measurements in current batch
	 */
	getBatchSize() {
		return this.batch.length;
	}

	/**
	 * Check if client is enabled (for debugging)
	 * @returns {Boolean} Whether client is collecting samples
	 */
	isEnabled() {
		return this.enabled;
	}
}
