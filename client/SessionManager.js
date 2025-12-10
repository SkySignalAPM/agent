/**
 * SessionManager
 * Manages user session tracking for RUM metrics
 *
 * Sessions are:
 * - Stored in localStorage for persistence across page loads
 * - Valid for 30 minutes of inactivity
 * - Renewed on activity within the 30-minute window
 * - Unique per browser tab/window
 */
export default class SessionManager {
	constructor() {
		this.STORAGE_KEY = '_skysignal_session';
		this.SESSION_DURATION = 30 * 60 * 1000; // 30 minutes
		this.sessionId = this._getOrCreateSession();
		this.sessionStart = new Date();

		// Renew session on activity
		this._setupActivityTracking();
	}

	/**
	 * Get existing session or create a new one
	 * @private
	 */
	_getOrCreateSession() {
		try {
			const stored = localStorage.getItem(this.STORAGE_KEY);
			if (stored) {
				const { sessionId, timestamp } = JSON.parse(stored);
				const age = Date.now() - timestamp;

				// Reuse if session is less than 30 minutes old
				if (age < this.SESSION_DURATION) {
					return sessionId;
				}
			}
		} catch (e) {
			// LocalStorage not available or corrupted
			console.warn('[SkySignal RUM] Session storage not available:', e.message);
		}

		// Generate new session ID
		const newSessionId = this._generateSessionId();
		this._persistSession(newSessionId);
		return newSessionId;
	}

	/**
	 * Generate a unique session ID
	 * Format: timestamp-random (e.g., 1234567890-abc123def)
	 * @private
	 */
	_generateSessionId() {
		return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}

	/**
	 * Persist session to localStorage
	 * @private
	 */
	_persistSession(sessionId) {
		try {
			localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
				sessionId,
				timestamp: Date.now()
			}));
		} catch (e) {
			// LocalStorage not available
		}
	}

	/**
	 * Setup activity tracking to renew session on user interaction
	 * @private
	 */
	_setupActivityTracking() {
		const renewSession = () => {
			this._persistSession(this.sessionId);
		};

		// Renew session on user activity (throttled to max once per minute)
		let lastRenewal = 0;
		const throttledRenew = () => {
			const now = Date.now();
			if (now - lastRenewal > 60000) { // 1 minute throttle
				lastRenewal = now;
				renewSession();
			}
		};

		// Listen for user activity
		['click', 'scroll', 'keydown'].forEach(event => {
			window.addEventListener(event, throttledRenew, { passive: true });
		});
	}

	/**
	 * Get the current session ID
	 * @returns {String} Session ID
	 */
	getSessionId() {
		return this.sessionId;
	}

	/**
	 * Get the session start time
	 * @returns {Date} Session start timestamp
	 */
	getSessionStart() {
		return this.sessionStart;
	}
}
