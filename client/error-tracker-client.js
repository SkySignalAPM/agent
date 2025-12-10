/**
 * SkySignal Error Tracker Client - Main Entry Point
 *
 * Auto-initializes from Meteor.settings.public.skysignal
 * Captures client-side errors with optional screenshot capture
 *
 * Configuration via settings.json:
 * {
 *   "public": {
 *     "skysignal": {
 *       "publicKey": "pk_xxx",             // Public key for error tracking
 *       "errorTracking": {
 *         "enabled": true,                  // Enable/disable error tracking (default: true)
 *         "attachScreenshots": true,        // Enable screenshot capture (default: false)
 *         "screenshotQuality": 0.7,         // JPEG quality 0-1 (default: 0.7)
 *         "screenshotSamplingRate": 10,     // % of errors to capture screenshots for (default: 100)
 *         "maxScreenshotSize": 500000,      // Max screenshot size in bytes (default: 500KB)
 *         "redactSelectors": [],            // Additional CSS selectors to redact (optional)
 *         "screenshotOnErrorTypes": [       // Error types to capture screenshots for (optional)
 *           "FatalError",
 *           "UnhandledRejection"
 *         ],
 *         "captureUnhandledRejections": true,  // Capture unhandled promise rejections (default: true)
 *         "captureConsoleErrors": false,    // Capture console.error calls (default: false)
 *         "ignoreErrors": [],               // Error messages/patterns to ignore (optional)
 *         "debug": false                    // Enable debug logging (default: false)
 *       }
 *     }
 *   }
 * }
 *
 * Example redaction configuration:
 * "redactSelectors": [
 *   ".my-sensitive-class",
 *   "#my-sensitive-id",
 *   "[data-my-sensitive-attr]"
 * ]
 *
 * Example ignore errors:
 * "ignoreErrors": [
 *   "ResizeObserver loop limit exceeded",
 *   /Network error/i
 * ]
 */

import ErrorTracker from './ErrorTracker';

// Create singleton instance
const errorTrackerInstance = new ErrorTracker();

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
		const errorTrackingSettings = settings.errorTracking || {};

		// Check if error tracking is enabled (default to true)
		const enabled = errorTrackingSettings.enabled !== false;

		if (enabled && settings.publicKey) {
			// Build endpoint URL
			let endpoint = '/api/v1/errors';
			if (settings.endpoint) {
				endpoint = `${settings.endpoint}/api/v1/errors`;
			}

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
			console.log('[SkySignal ErrorTracker] Disabled via settings');
		} else {
			console.warn('[SkySignal ErrorTracker] Auto-initialization failed - missing publicKey in Meteor.settings.public.skysignal');
		}
	};

	initWhenReady();
}

// Export singleton instance
export default errorTrackerInstance;
