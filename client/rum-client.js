/**
 * SkySignal RUM Client - Main Entry Point
 *
 * Auto-initializes from Meteor.settings.public.skysignal
 * Collects Real User Monitoring (RUM) metrics for browser performance
 *
 * Configuration via settings.json:
 * {
 *   "public": {
 *     "skysignal": {
 *       "publicKey": "pk_xxx",             // Public key for RUM collection
 *       "rum": {
 *         "enabled": true,                  // Enable/disable RUM collection
 *         "trackUserActions": true,         // Track user clicks, form submits, etc. (default: true)
 *         "trackPageViews": true,           // Track page navigation (default: true)
 *         "debug": false                    // Enable debug logging
 *       }
 *     }
 *   }
 * }
 *
 * NOTE: Sampling rate is controlled server-side via Configs.rum.samplingRate
 * The client always collects 100% of data and the server applies sampling.
 */

import SessionManager from './SessionManager';
import BrowserContext from './BrowserContext';
import RUMCollector from './RUMCollector';
import RUMClient from './RUMClient';
import ErrorTracker from './ErrorTracker';

class SkySignalRUM {
	constructor() {
		this.initialized = false;
		this.sessionManager = null;
		this.browserContext = null;
		this.collector = null;
		this.client = null;
		this.currentRoute = null;
		this.pageViews = []; // Track page view history
		this.config = null; // Store config for later use
	}

	/**
	 * Initialize RUM collection
	 * @param {Object} config - Configuration object
	 * @param {String} config.publicKey - SkySignal public key (pk_ prefix, for client-side use)
	 * @param {String} config.endpoint - API endpoint URL (default: '/api/v1/rum')
	 * @param {Boolean} config.trackUserActions - Enable user action tracking (default: true)
	 * @param {Boolean} config.trackPageViews - Enable page view tracking (default: true)
	 * @param {Boolean} config.debug - Enable debug logging
	 * @note Sampling is controlled server-side via Configs.rum.samplingRate
	 */
	init(config) {
		if (this.initialized) {
			console.warn('[SkySignal RUM] Already initialized');
			return;
		}

		if (!config.publicKey) {
			console.error('[SkySignal RUM] Missing required configuration: publicKey');
			return;
		}

		// Store config for later use
		this.config = {
			trackUserActions: config.trackUserActions !== false,
			trackPageViews: config.trackPageViews !== false,
			debug: config.debug || false
		};

		try {
			// Initialize session manager
			this.sessionManager = new SessionManager();

			// Initialize browser context (static class, no instantiation needed)
			this.browserContext = BrowserContext;

			// Initialize RUM client
			// NOTE: No sampleRate - sampling is controlled server-side
			this.client = new RUMClient({
				publicKey: config.publicKey,
				endpoint: config.endpoint,
				debug: config.debug || false
			});

			// Initialize RUM collector with config
			this.collector = new RUMCollector(this.sessionManager, this.browserContext, {
				trackUserActions: this.config.trackUserActions,
				debug: this.config.debug
			});

			// Connect collector to client
			this.collector.onMeasurement((measurement) => {
				this.client.addMeasurement(measurement);
			});

			// Track current route
			this.currentRoute = window.location.pathname;

			// Track initial page view
			if (this.config.trackPageViews) {
				this._trackPageView(this.currentRoute, document.referrer || null);
			}

			// Setup SPA route change detection
			this._setupRouteChangeDetection();

			this.initialized = true;

			if (config.debug) {
				console.log('[SkySignal RUM] Initialized successfully', {
					sessionId: this.sessionManager.getSessionId(),
					endpoint: config.endpoint || '/api/v1/rum',
					route: this.currentRoute,
					trackUserActions: this.config.trackUserActions,
					trackPageViews: this.config.trackPageViews,
					note: 'Sampling controlled server-side'
				});
			}
		} catch (error) {
			console.error('[SkySignal RUM] Initialization failed:', error);
		}
	}

	/**
	 * Setup SPA route change detection
	 * Detects route changes in single-page applications and collects new metrics
	 * @private
	 */
	_setupRouteChangeDetection() {
		// Save original pushState and replaceState
		const originalPushState = history.pushState;
		const originalReplaceState = history.replaceState;

		// Override pushState to detect route changes
		history.pushState = (...args) => {
			originalPushState.apply(history, args);
			this._handleRouteChange();
		};

		// Override replaceState to detect route changes
		history.replaceState = (...args) => {
			originalReplaceState.apply(history, args);
			this._handleRouteChange();
		};

		// Listen for popstate (browser back/forward)
		window.addEventListener('popstate', () => {
			this._handleRouteChange();
		});

		// Listen for hashchange (hash-based routing)
		window.addEventListener('hashchange', () => {
			this._handleRouteChange();
		});
	}

	/**
	 * Track a page view
	 * @private
	 */
	_trackPageView(path, referrer) {
		if (!this.config.trackPageViews) return;

		const pageView = {
			path: path,
			referrer: referrer,
			timestamp: new Date(),
			sessionId: this.sessionManager.getSessionId()
		};

		this.pageViews.push(pageView);

		if (this.config.debug) {
			console.log('[SkySignal RUM] Page view tracked', pageView);
		}
	}

	/**
	 * Handle route change in SPA
	 * Sends previous route metrics and starts collecting for new route
	 * @private
	 */
	_handleRouteChange() {
		const newRoute = window.location.pathname;

		// Only handle if route actually changed
		if (newRoute === this.currentRoute) {
			return;
		}

		if (this.client.config.debug) {
			console.log('[SkySignal RUM] Route change detected', {
				from: this.currentRoute,
				to: newRoute
			});
		}

		// Flush any pending measurements for the previous route
		this.client.flush();

		// Track page view for new route
		if (this.config.trackPageViews) {
			this._trackPageView(newRoute, this.currentRoute); // Previous route is the referrer
		}

		// Update current route
		this.currentRoute = newRoute;

		// Reset collector to start fresh metrics for new route
		// Create new collector instance for the new route with config
		this.collector = new RUMCollector(this.sessionManager, this.browserContext, {
			trackUserActions: this.config.trackUserActions,
			debug: this.config.debug
		});

		// Re-connect collector to client
		this.collector.onMeasurement((measurement) => {
			this.client.addMeasurement(measurement);
		});
	}

	/**
	 * Manually track a page view (for custom routing implementations)
	 * @param {String} route - Route path
	 */
	trackPageView(route) {
		if (!this.initialized) {
			console.warn('[SkySignal RUM] Not initialized');
			return;
		}

		const newRoute = route || window.location.pathname;

		// Track page view
		if (this.config.trackPageViews) {
			this._trackPageView(newRoute, this.currentRoute);
		}

		// Update current route
		this.currentRoute = newRoute;

		// Reset collector for new page with config
		this.collector = new RUMCollector(this.sessionManager, this.browserContext, {
			trackUserActions: this.config.trackUserActions,
			debug: this.config.debug
		});
		this.collector.onMeasurement((measurement) => {
			this.client.addMeasurement(measurement);
		});
	}

	/**
	 * Get current session ID (for debugging or correlation)
	 * @returns {String|null} Session ID
	 */
	getSessionId() {
		return this.sessionManager ? this.sessionManager.getSessionId() : null;
	}

	/**
	 * Get current metrics (for debugging)
	 * @returns {Object|null} Current metrics
	 */
	getMetrics() {
		return this.collector ? this.collector.getMetrics() : null;
	}

	/**
	 * Get current warnings (for debugging)
	 * @returns {Array|null} Current warnings
	 */
	getWarnings() {
		return this.collector ? this.collector.getWarnings() : null;
	}

	/**
	 * Get page view history (for debugging)
	 * @returns {Array} Page view history
	 */
	getPageViews() {
		return [...this.pageViews];
	}

	/**
	 * Check if RUM is initialized
	 * @returns {Boolean} Initialization status
	 */
	isInitialized() {
		return this.initialized;
	}
}

// Create singleton instance
const rumInstance = new SkySignalRUM();

// Auto-initialize from Meteor.settings if available
if (typeof Meteor !== 'undefined' && Meteor.settings && Meteor.settings.public && Meteor.settings.public.skysignal) {
	// Wait for DOM to be ready
	const initWhenReady = () => {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => {
				autoInit();
			});
		} else {
			autoInit();
		}
	};

	const autoInit = () => {
		const settings = Meteor.settings.public.skysignal;
		const rumSettings = settings.rum || {};

		// Check if RUM is enabled (default to true)
		const enabled = rumSettings.enabled !== false;

		if (enabled && settings.publicKey) {
			// Build endpoint URL
			// If endpoint is configured, use it; otherwise default to SkySignal production
			const baseEndpoint = settings.endpoint || 'https://dash.skysignal.app';
			const endpoint = `${baseEndpoint}/api/v1/rum`;

			// NOTE: No sampleRate - sampling is controlled server-side via Configs.rum.samplingRate
			// Client always collects 100% and server applies sampling based on site configuration
			rumInstance.init({
				publicKey: settings.publicKey,
				endpoint: endpoint,
				trackUserActions: rumSettings.trackUserActions !== false, // Default: true
				trackPageViews: rumSettings.trackPageViews !== false,     // Default: true
				debug: rumSettings.debug || false
			});

			if (rumSettings.debug) {
				console.log('[SkySignal RUM] Auto-initialized from Meteor.settings', {
					endpoint: endpoint,
					environment: window.location.hostname === 'localhost' ? 'development' : 'production',
					trackUserActions: rumSettings.trackUserActions !== false,
					trackPageViews: rumSettings.trackPageViews !== false,
					note: 'Sampling controlled server-side via site configuration'
				});
			}
		} else if (!enabled) {
			console.log('[SkySignal RUM] Disabled via settings');
		} else {
			console.warn('[SkySignal RUM] Auto-initialization failed - missing publicKey in Meteor.settings.public.skysignal');
		}
	};

	initWhenReady();
}

// Initialize ErrorTracker if configured
const errorTrackerInstance = new ErrorTracker();

if (typeof Meteor !== 'undefined' && Meteor.settings && Meteor.settings.public && Meteor.settings.public.skysignal) {
	const initErrorTrackerWhenReady = () => {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => {
				autoInitErrorTracker();
			});
		} else {
			autoInitErrorTracker();
		}
	};

	const autoInitErrorTracker = () => {
		const settings = Meteor.settings.public.skysignal;
		const errorTrackingSettings = settings.errorTracking || {};

		// Check if error tracking is enabled (default to true)
		const enabled = errorTrackingSettings.enabled !== false;

		if (enabled && settings.publicKey) {
			// Build endpoint URL (default to SkySignal production)
			const baseEndpoint = settings.endpoint || 'https://dash.skysignal.app';
			const endpoint = `${baseEndpoint}/api/v1/errors`;

			// Configure error tracker
			const config = {
				publicKey: settings.publicKey,
				endpoint: endpoint,
				enabled: true,
				attachScreenshots: errorTrackingSettings.attachScreenshots || false,
				screenshotQuality: errorTrackingSettings.screenshotQuality || 0.7,
				screenshotSamplingRate: errorTrackingSettings.screenshotSamplingRate !== undefined
					? errorTrackingSettings.screenshotSamplingRate
					: 100,
				maxScreenshotSize: errorTrackingSettings.maxScreenshotSize || 500 * 1024,
				redactSelectors: errorTrackingSettings.redactSelectors,
				screenshotOnErrorTypes: errorTrackingSettings.screenshotOnErrorTypes,
				captureUnhandledRejections: errorTrackingSettings.captureUnhandledRejections !== false,
				captureConsoleErrors: errorTrackingSettings.captureConsoleErrors || false,
				ignoreErrors: errorTrackingSettings.ignoreErrors || [],
				beforeSend: errorTrackingSettings.beforeSend,
				debug: errorTrackingSettings.debug || false
			};

			// Initialize ErrorTracker
			const tracker = new ErrorTracker(config);
			tracker.init();

			// Replace singleton instance with configured instance
			Object.assign(errorTrackerInstance, tracker);

			if (config.debug) {
				console.log('[SkySignal ErrorTracker] Auto-initialized from Meteor.settings', {
					endpoint: endpoint,
					attachScreenshots: config.attachScreenshots,
					screenshotSamplingRate: config.screenshotSamplingRate,
					captureUnhandledRejections: config.captureUnhandledRejections,
					captureConsoleErrors: config.captureConsoleErrors
				});
			}
		} else if (!enabled) {
			if (errorTrackingSettings.debug) {
				console.log('[SkySignal ErrorTracker] Disabled via settings');
			}
		}
	};

	initErrorTrackerWhenReady();
}

// Export singleton instances
export default rumInstance;
export { errorTrackerInstance as SkySignalErrorTracker };
