/**
 * RUMCollector
 * Collects Core Web Vitals and performance metrics using web-vitals library
 * and native Performance API
 *
 * Core Web Vitals:
 * - LCP (Largest Contentful Paint) - Good: <2.5s, Needs Improvement: 2.5-4s, Poor: >4s
 * - FID (First Input Delay) - Good: <100ms, Needs Improvement: 100-300ms, Poor: >300ms
 * - CLS (Cumulative Layout Shift) - Good: <0.1, Needs Improvement: 0.1-0.25, Poor: >0.25
 * - TTFB (Time to First Byte) - Good: <800ms, Needs Improvement: 800-1800ms, Poor: >1800ms
 * - FCP (First Contentful Paint) - Good: <1.8s, Needs Improvement: 1.8-3s, Poor: >3s
 * - TTI (Time to Interactive) - Good: <3.8s, Needs Improvement: 3.8-7.3s, Poor: >7.3s
 */

import { onCLS, onFID, onLCP, onFCP, onTTFB } from 'web-vitals';
import UserActionTracker from './UserActionTracker';

export default class RUMCollector {
	constructor(sessionManager, browserContext, config = {}) {
		this.sessionManager = sessionManager;
		this.browserContext = browserContext;
		this.metrics = {};
		this.callbacks = [];
		this.sent = false;
		this.warnings = [];

		// Performance thresholds (PageSpeed-style)
		this.thresholds = {
			lcp: { good: 2500, poor: 4000 },
			fid: { good: 100, poor: 300 },
			cls: { good: 0.1, poor: 0.25 },
			ttfb: { good: 800, poor: 1800 },
			fcp: { good: 1800, poor: 3000 },
			tti: { good: 3800, poor: 7300 }
		};

		// Initialize user action tracker if enabled
		this.userActionTracker = config.trackUserActions !== false
			? new UserActionTracker({
					enabled: true,
					debug: config.debug || false
			  })
			: null;

		this._startCollection();
	}

	/**
	 * Start collecting Core Web Vitals
	 * @private
	 */
	_startCollection() {
		// Collect Core Web Vitals from web-vitals library
		onCLS((metric) => this._handleMetric('cls', metric));
		onFID((metric) => this._handleMetric('fid', metric));
		onLCP((metric) => this._handleMetric('lcp', metric));
		onFCP((metric) => this._handleMetric('fcp', metric));
		onTTFB((metric) => this._handleMetric('ttfb', metric));

		// Collect TTI from Performance API
		this._collectTTI();

		// Collect resource timing
		this._collectResourceTiming();

		// Send measurements on visibility change or after timeout
		this._setupSendTriggers();
	}

	/**
	 * Handle metric from web-vitals library
	 * @private
	 */
	_handleMetric(name, metric) {
		const value = metric.value;
		this.metrics[name] = value;

		// Generate warnings for poor performance
		this._checkThreshold(name, value);

		// Check if we have enough metrics to send
		this._checkReadyToSend();
	}

	/**
	 * Collect Time to Interactive (TTI) from Performance API
	 * @private
	 */
	_collectTTI() {
		// Wait for page to be fully loaded
		if (document.readyState === 'complete') {
			this._calculateTTI();
		} else {
			window.addEventListener('load', () => {
				// Give the browser a moment to settle
				setTimeout(() => this._calculateTTI(), 100);
			});
		}
	}

	/**
	 * Calculate TTI using Performance API
	 * Simplified heuristic: domContentLoadedEventEnd + main thread quiet period
	 * @private
	 */
	_calculateTTI() {
		try {
			const perfData = performance.getEntriesByType('navigation')[0];
			if (!perfData) return;

			// Use domContentLoadedEventEnd as a proxy for TTI
			// In production, you might use a more sophisticated algorithm
			const tti = perfData.domContentLoadedEventEnd;
			this.metrics.tti = Math.round(tti);

			// Check threshold
			this._checkThreshold('tti', tti);
		} catch (e) {
			console.warn('[SkySignal RUM] Failed to calculate TTI:', e);
		}
	}

	/**
	 * Collect top 10 slowest resources
	 * @private
	 */
	_collectResourceTiming() {
		try {
			const resources = performance.getEntriesByType('resource');

			// Calculate duration for each resource and sort by slowest
			const slowestResources = resources
				.map(resource => ({
					name: resource.name,
					duration: resource.duration,
					type: resource.initiatorType,
					size: resource.transferSize || 0
				}))
				.sort((a, b) => b.duration - a.duration)
				.slice(0, 10); // Top 10 slowest

			this.metrics.slowestResources = slowestResources;

			// Calculate total resource load time
			const totalResourceTime = resources.reduce((sum, r) => sum + r.duration, 0);
			this.metrics.totalResourceTime = Math.round(totalResourceTime);
		} catch (e) {
			console.warn('[SkySignal RUM] Failed to collect resource timing:', e);
		}
	}

	/**
	 * Check if metric value exceeds performance threshold
	 * @private
	 */
	_checkThreshold(metricName, value) {
		const threshold = this.thresholds[metricName];
		if (!threshold) return;

		let rating = 'good';
		let message = null;

		if (value > threshold.poor) {
			rating = 'poor';
			message = this._getWarningMessage(metricName, value, 'poor');
		} else if (value > threshold.good) {
			rating = 'needs-improvement';
			message = this._getWarningMessage(metricName, value, 'needs-improvement');
		}

		// Store rating
		this.metrics[`${metricName}Rating`] = rating;

		// Add warning if performance is not good
		if (message) {
			this.warnings.push({
				metric: metricName,
				value,
				rating,
				message,
				timestamp: new Date()
			});

			// Log to console (PageSpeed-style warning)
			console.warn(`[SkySignal RUM] ${message}`);
		}
	}

	/**
	 * Generate PageSpeed-style warning message
	 * @private
	 */
	_getWarningMessage(metric, value, rating) {
		const formatValue = (m, v) => {
			if (m === 'cls') return v.toFixed(3);
			return `${Math.round(v)}ms`;
		};

		const messages = {
			lcp: {
				'poor': `Largest Contentful Paint (LCP) is slow: ${formatValue(metric, value)}. LCP should be under 2.5s for good user experience. Consider optimizing images, removing render-blocking resources, and improving server response times.`,
				'needs-improvement': `Largest Contentful Paint (LCP) needs improvement: ${formatValue(metric, value)}. Target: <2.5s. Consider optimizing critical rendering path.`
			},
			fid: {
				'poor': `First Input Delay (FID) is slow: ${formatValue(metric, value)}. FID should be under 100ms. Consider reducing JavaScript execution time and breaking up long tasks.`,
				'needs-improvement': `First Input Delay (FID) needs improvement: ${formatValue(metric, value)}. Target: <100ms. Consider optimizing event handlers.`
			},
			cls: {
				'poor': `Cumulative Layout Shift (CLS) is high: ${formatValue(metric, value)}. CLS should be under 0.1. Always include size attributes on images/videos, avoid inserting content above existing content, and use transform animations.`,
				'needs-improvement': `Cumulative Layout Shift (CLS) needs improvement: ${formatValue(metric, value)}. Target: <0.1. Review layout stability.`
			},
			ttfb: {
				'poor': `Time to First Byte (TTFB) is slow: ${formatValue(metric, value)}. TTFB should be under 800ms. Consider using a CDN, optimizing server processing, or implementing caching.`,
				'needs-improvement': `Time to First Byte (TTFB) needs improvement: ${formatValue(metric, value)}. Target: <800ms. Review server performance.`
			},
			fcp: {
				'poor': `First Contentful Paint (FCP) is slow: ${formatValue(metric, value)}. FCP should be under 1.8s. Consider removing render-blocking resources and optimizing critical rendering path.`,
				'needs-improvement': `First Contentful Paint (FCP) needs improvement: ${formatValue(metric, value)}. Target: <1.8s. Optimize initial rendering.`
			},
			tti: {
				'poor': `Time to Interactive (TTI) is slow: ${formatValue(metric, value)}. TTI should be under 3.8s. Consider code splitting, deferring non-critical JavaScript, and removing unused code.`,
				'needs-improvement': `Time to Interactive (TTI) needs improvement: ${formatValue(metric, value)}. Target: <3.8s. Reduce JavaScript execution time.`
			}
		};

		return messages[metric]?.[rating] || `${metric.toUpperCase()} needs improvement: ${formatValue(metric, value)}`;
	}

	/**
	 * Setup triggers to send measurements
	 * @private
	 */
	_setupSendTriggers() {
		// Send on visibility change (user leaving page)
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				this._sendMeasurements();
			}
		});

		// Send on page unload (backup)
		window.addEventListener('beforeunload', () => {
			this._sendMeasurements();
		});

		// Send after 10 seconds if we have core metrics
		setTimeout(() => {
			if (this._hasMinimumMetrics() && !this.sent) {
				this._sendMeasurements();
			}
		}, 10000);
	}

	/**
	 * Check if we have minimum metrics to send
	 * @private
	 */
	_hasMinimumMetrics() {
		// We need at least TTFB and one other Core Web Vital
		return this.metrics.ttfb && (this.metrics.lcp || this.metrics.fcp || this.metrics.fid);
	}

	/**
	 * Check if ready to send (all metrics collected or timeout)
	 * @private
	 */
	_checkReadyToSend() {
		// If we have all Core Web Vitals, send immediately
		const hasCoreMetrics = this.metrics.lcp && this.metrics.fid && this.metrics.cls &&
		                       this.metrics.ttfb && this.metrics.fcp;

		if (hasCoreMetrics && !this.sent) {
			// Small delay to allow TTI to be calculated
			setTimeout(() => this._sendMeasurements(), 200);
		}
	}

	/**
	 * Send measurements to callbacks
	 * @private
	 */
	_sendMeasurements() {
		if (this.sent) return; // Already sent
		if (!this._hasMinimumMetrics()) return; // Not enough data

		this.sent = true;

		// Collect browser context
		const context = this.browserContext.collect();

		// Collect user actions if tracker is enabled
		const userActions = this.userActionTracker ? this.userActionTracker.getActions() : [];
		const userActionStats = this.userActionTracker ? this.userActionTracker.getStats() : null;

		// Build measurement object
		const measurement = {
			// Core Web Vitals
			lcp: this.metrics.lcp,
			fid: this.metrics.fid,
			cls: this.metrics.cls,
			ttfb: this.metrics.ttfb,
			fcp: this.metrics.fcp,
			tti: this.metrics.tti,

			// Ratings
			lcpRating: this.metrics.lcpRating,
			fidRating: this.metrics.fidRating,
			clsRating: this.metrics.clsRating,
			ttfbRating: this.metrics.ttfbRating,
			fcpRating: this.metrics.fcpRating,
			ttiRating: this.metrics.ttiRating,

			// Resource timing
			slowestResources: this.metrics.slowestResources,
			totalResourceTime: this.metrics.totalResourceTime,

			// User actions (if tracking enabled)
			userActions: userActions.length > 0 ? userActions : undefined,
			userActionStats: userActionStats,

			// Context
			...context,
			userId: this.browserContext.getUserId(),
			sessionId: this.sessionManager.getSessionId(),
			page: window.location.pathname,
			referrer: document.referrer || null,

			// Warnings
			warnings: this.warnings.length > 0 ? this.warnings : undefined,

			// Timestamp
			timestamp: new Date()
		};

		// Call all registered callbacks
		this.callbacks.forEach(callback => {
			try {
				callback(measurement);
			} catch (e) {
				console.error('[SkySignal RUM] Error in measurement callback:', e);
			}
		});
	}

	/**
	 * Register a callback to receive measurements
	 * @param {Function} callback - Function to call with measurement data
	 */
	onMeasurement(callback) {
		this.callbacks.push(callback);
	}

	/**
	 * Get current metrics (for debugging)
	 * @returns {Object} Current metrics
	 */
	getMetrics() {
		return { ...this.metrics };
	}

	/**
	 * Get current warnings (for debugging)
	 * @returns {Array} Current warnings
	 */
	getWarnings() {
		return [...this.warnings];
	}

	/**
	 * Reset collector for SPA route changes
	 * This allows collecting new metrics for the new route
	 */
	reset() {
		this.metrics = {};
		this.warnings = [];
		this.sent = false;

		// Reset user action tracker
		if (this.userActionTracker) {
			this.userActionTracker.reset();
		}

		// Re-collect metrics for new route
		this._collectTTI();
		this._collectResourceTiming();
	}
}
