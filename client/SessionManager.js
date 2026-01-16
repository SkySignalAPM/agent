/**
 * SessionManager - Manages browser session tracking for Real User Monitoring (RUM).
 *
 * This class provides persistent session identification across page loads
 * using localStorage. Sessions automatically expire after 30 minutes of
 * inactivity but are renewed on user interaction.
 *
 * **Session Characteristics:**
 * - Persisted in localStorage for cross-page-load tracking
 * - 30-minute inactivity timeout (configurable via SESSION_DURATION)
 * - Auto-renewed on user activity (click, scroll, keydown)
 * - Activity renewal throttled to once per minute to minimize writes
 * - Unique per browser (shared across tabs for the same origin)
 *
 * **Session ID Format:**
 * `{timestamp}-{random}` (e.g., "1705420800000-abc123def")
 *
 * @class SessionManager
 * @property {string} sessionId - The current session identifier
 * @property {Date} sessionStart - When this SessionManager instance was created
 *
 * @example
 * // Create session manager
 * import SessionManager from 'meteor/skysignal:agent/client/SessionManager';
 *
 * const session = new SessionManager();
 * console.log(`Session: ${session.getSessionId()}`);
 *
 * @example
 * // Include session in RUM measurements
 * const measurement = {
 *   sessionId: session.getSessionId(),
 *   timestamp: new Date(),
 *   type: 'pageLoad',
 *   metrics: { ... }
 * };
 * rumClient.addMeasurement(measurement);
 */
export default class SessionManager {
	/**
	 * Create a new SessionManager instance.
	 *
	 * On construction, attempts to restore an existing session from localStorage.
	 * If no valid session exists (expired or not found), creates a new one.
	 * Sets up activity tracking to keep the session alive during user interaction.
	 */
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
	 * Get the current session ID.
	 *
	 * The session ID is a unique identifier for this user's browsing session.
	 * It persists across page loads until 30 minutes of inactivity.
	 *
	 * @returns {string} Session ID in format "{timestamp}-{random}"
	 *
	 * @example
	 * const sessionId = session.getSessionId();
	 * // "1705420800000-abc123def"
	 *
	 * @example
	 * // Include in RUM measurements
	 * rumClient.addMeasurement({
	 *   sessionId: session.getSessionId(),
	 *   type: 'pageLoad',
	 *   ...metrics
	 * });
	 */
	getSessionId() {
		return this.sessionId;
	}

	/**
	 * Get the session start time.
	 *
	 * This is the time when this SessionManager instance was created,
	 * not necessarily when the session ID was first generated (which
	 * may have been on a previous page load).
	 *
	 * @returns {Date} Timestamp when this SessionManager was instantiated
	 *
	 * @example
	 * const start = session.getSessionStart();
	 * console.log(`Session started at: ${start.toISOString()}`);
	 */
	getSessionStart() {
		return this.sessionStart;
	}

	/**
	 * Get the duration of the current session in milliseconds.
	 *
	 * This measures time since this SessionManager instance was created,
	 * which corresponds to when this page/tab was loaded.
	 *
	 * @returns {number} Session duration in milliseconds
	 *
	 * @example
	 * const durationMs = session.getSessionDuration();
	 * const durationSec = Math.round(durationMs / 1000);
	 * console.log(`Session duration: ${durationSec} seconds`);
	 */
	getSessionDuration() {
		return Date.now() - this.sessionStart.getTime();
	}

	/**
	 * Check if the session is still active (not expired).
	 *
	 * A session is considered active if activity has occurred
	 * within the last 30 minutes (SESSION_DURATION).
	 *
	 * @returns {boolean} True if session is active
	 *
	 * @example
	 * if (session.isActive()) {
	 *   rumClient.addMeasurement({ sessionId: session.getSessionId(), ... });
	 * }
	 */
	isActive() {
		try {
			const stored = localStorage.getItem(this.STORAGE_KEY);
			if (stored) {
				const { timestamp } = JSON.parse(stored);
				const age = Date.now() - timestamp;
				return age < this.SESSION_DURATION;
			}
		} catch (e) {
			// localStorage not available
		}
		return false;
	}
}
