/**
 * BrowserContext
 * Collects browser, device, OS, and network information
 *
 * Used to enrich RUM measurements with contextual data about
 * the user's environment for performance analysis by segment.
 */
export default class BrowserContext {
	/**
	 * Collect all browser context information
	 * @returns {Object} Context data
	 */
	static collect() {
		const ua = navigator.userAgent;

		return {
			browser: this._detectBrowser(ua),
			browserVersion: this._detectBrowserVersion(ua),
			device: this._detectDevice(ua),
			os: this._detectOS(ua),
			viewport: {
				width: window.innerWidth,
				height: window.innerHeight
			},
			screen: {
				width: window.screen.width,
				height: window.screen.height,
				pixelRatio: window.devicePixelRatio || 1
			},
			...this._getNetworkInfo()
		};
	}

	/**
	 * Detect browser name from user agent
	 * @private
	 */
	static _detectBrowser(ua) {
		if (ua.includes('Chrome') && !ua.includes('Edg') && !ua.includes('OPR')) return 'Chrome';
		if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari';
		if (ua.includes('Firefox')) return 'Firefox';
		if (ua.includes('Edg')) return 'Edge';
		if (ua.includes('OPR') || ua.includes('Opera')) return 'Opera';
		if (ua.includes('MSIE') || ua.includes('Trident')) return 'Internet Explorer';
		return 'Other';
	}

	/**
	 * Detect browser version from user agent
	 * @private
	 */
	static _detectBrowserVersion(ua) {
		let match;

		// Chrome
		if (ua.includes('Chrome') && !ua.includes('Edg')) {
			match = ua.match(/Chrome\/(\d+)/);
			return match ? match[1] : 'Unknown';
		}

		// Safari
		if (ua.includes('Safari') && !ua.includes('Chrome')) {
			match = ua.match(/Version\/(\d+)/);
			return match ? match[1] : 'Unknown';
		}

		// Firefox
		if (ua.includes('Firefox')) {
			match = ua.match(/Firefox\/(\d+)/);
			return match ? match[1] : 'Unknown';
		}

		// Edge
		if (ua.includes('Edg')) {
			match = ua.match(/Edg\/(\d+)/);
			return match ? match[1] : 'Unknown';
		}

		return 'Unknown';
	}

	/**
	 * Detect device type from user agent
	 * @private
	 */
	static _detectDevice(ua) {
		const mobile = /mobile/i.test(ua);
		const tablet = /tablet|ipad/i.test(ua);

		if (tablet) return 'tablet';
		if (mobile) return 'mobile';
		return 'desktop';
	}

	/**
	 * Detect operating system from user agent
	 * @private
	 */
	static _detectOS(ua) {
		if (ua.includes('Win')) return 'Windows';
		if (ua.includes('Mac') && !ua.includes('iPhone') && !ua.includes('iPad')) return 'macOS';
		if (ua.includes('Linux') && !ua.includes('Android')) return 'Linux';
		if (ua.includes('Android')) return 'Android';
		if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
		if (ua.includes('CrOS')) return 'Chrome OS';
		return 'Other';
	}

	/**
	 * Get network information from Navigator API
	 * @private
	 */
	static _getNetworkInfo() {
		const nav = navigator;
		const conn = nav.connection || nav.mozConnection || nav.webkitConnection;

		if (!conn) {
			return {
				connection: 'unknown',
				effectiveConnectionType: null,
				downlink: null,
				rtt: null
			};
		}

		return {
			connection: conn.type || conn.effectiveType || 'unknown',
			effectiveConnectionType: conn.effectiveType || null,
			downlink: conn.downlink || null,
			rtt: conn.rtt || null
		};
	}

	/**
	 * Get user ID from Meteor (if available)
	 * Returns null for anonymous users
	 * @returns {String|null} User ID
	 */
	static getUserId() {
		try {
			// Check if Meteor is available and user is logged in
			if (typeof Meteor !== 'undefined' && Meteor.userId) {
				return Meteor.userId();
			}
		} catch (e) {
			// Meteor not available
		}
		return null;
	}
}
