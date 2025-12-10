/**
 * UserActionTracker
 * Tracks user interactions like clicks, form submissions, and input changes
 *
 * Features:
 * - Click tracking with element identification
 * - Form submission tracking
 * - Input interaction tracking
 * - Rage click detection (multiple clicks in short time)
 * - Dead click detection (clicks that produce no result)
 * - Configurable action limits to prevent data overload
 */

export default class UserActionTracker {
	constructor(config = {}) {
		this.config = {
			enabled: config.enabled !== false,
			maxActions: config.maxActions || 50, // Max actions per session
			rageClickThreshold: config.rageClickThreshold || 3, // Clicks in 1 second
			deadClickDelay: config.deadClickDelay || 2000, // 2 seconds
			debug: config.debug || false
		};

		this.actions = [];
		this.lastClickTime = 0;
		this.lastClickElement = null;
		this.clickCount = 0;
		this.pendingDeadClicks = new Map();

		if (this.config.enabled) {
			this._setupListeners();
		}
	}

	/**
	 * Setup event listeners for user actions
	 * @private
	 */
	_setupListeners() {
		// Track clicks
		document.addEventListener('click', (e) => this._handleClick(e), true);

		// Track form submissions
		document.addEventListener('submit', (e) => this._handleFormSubmit(e), true);

		// Track input interactions (focus/change)
		document.addEventListener('focus', (e) => this._handleInputFocus(e), true);
		document.addEventListener('change', (e) => this._handleInputChange(e), true);

		// Track page interactions for dead click detection
		document.addEventListener('DOMSubtreeModified', () => this._handleDOMChange());
		document.addEventListener('load', () => this._handlePageChange(), true);

		if (this.config.debug) {
			console.log('[SkySignal RUM] UserActionTracker initialized', {
				maxActions: this.config.maxActions,
				rageClickThreshold: this.config.rageClickThreshold
			});
		}
	}

	/**
	 * Handle click events
	 * @private
	 */
	_handleClick(event) {
		if (!this._shouldTrack()) return;

		const element = event.target;
		const elementInfo = this._getElementInfo(element);
		const now = Date.now();

		// Detect rage clicks (multiple clicks on same element in short time)
		const isRageClick = this._detectRageClick(element, now);

		// Setup dead click detection
		const deadClickId = this._setupDeadClickDetection(element, now);

		const action = {
			type: 'click',
			timestamp: new Date(now),
			element: elementInfo,
			pageX: event.pageX,
			pageY: event.pageY,
			isRageClick: isRageClick,
			deadClickId: deadClickId // Will be checked later
		};

		this._addAction(action);

		if (this.config.debug && isRageClick) {
			console.warn('[SkySignal RUM] Rage click detected', elementInfo);
		}
	}

	/**
	 * Handle form submission events
	 * @private
	 */
	_handleFormSubmit(event) {
		if (!this._shouldTrack()) return;

		const form = event.target;
		const elementInfo = this._getElementInfo(form);

		const action = {
			type: 'form_submit',
			timestamp: new Date(),
			element: elementInfo,
			formAction: form.action || window.location.href,
			formMethod: form.method || 'GET'
		};

		this._addAction(action);

		if (this.config.debug) {
			console.log('[SkySignal RUM] Form submitted', elementInfo);
		}
	}

	/**
	 * Handle input focus events
	 * @private
	 */
	_handleInputFocus(event) {
		if (!this._shouldTrack()) return;

		const element = event.target;
		if (!this._isFormElement(element)) return;

		const elementInfo = this._getElementInfo(element);

		const action = {
			type: 'input_focus',
			timestamp: new Date(),
			element: elementInfo
		};

		this._addAction(action);
	}

	/**
	 * Handle input change events
	 * @private
	 */
	_handleInputChange(event) {
		if (!this._shouldTrack()) return;

		const element = event.target;
		if (!this._isFormElement(element)) return;

		const elementInfo = this._getElementInfo(element);

		const action = {
			type: 'input_change',
			timestamp: new Date(),
			element: elementInfo,
			inputType: element.type || 'text'
		};

		this._addAction(action);
	}

	/**
	 * Detect rage clicks (multiple rapid clicks on same element)
	 * @private
	 */
	_detectRageClick(element, now) {
		const timeSinceLastClick = now - this.lastClickTime;

		// Check if same element clicked within threshold time
		if (this.lastClickElement === element && timeSinceLastClick < 1000) {
			this.clickCount++;
			if (this.clickCount >= this.config.rageClickThreshold) {
				this.clickCount = 0; // Reset after detecting
				return true;
			}
		} else {
			// Different element or too much time passed
			this.clickCount = 1;
		}

		this.lastClickTime = now;
		this.lastClickElement = element;
		return false;
	}

	/**
	 * Setup dead click detection (clicks that produce no response)
	 * @private
	 */
	_setupDeadClickDetection(element, now) {
		const deadClickId = `${now}_${Math.random()}`;

		this.pendingDeadClicks.set(deadClickId, {
			element: element,
			timestamp: now,
			detected: false
		});

		// Check for DOM changes after delay
		setTimeout(() => {
			const pending = this.pendingDeadClicks.get(deadClickId);
			if (pending && !pending.detected) {
				// No DOM change detected - this was a dead click
				this._markDeadClick(deadClickId);
			}
			this.pendingDeadClicks.delete(deadClickId);
		}, this.config.deadClickDelay);

		return deadClickId;
	}

	/**
	 * Handle DOM changes (cancels dead click detection)
	 * @private
	 */
	_handleDOMChange() {
		// Mark all pending dead clicks as "not dead" since DOM changed
		for (const [id, pending] of this.pendingDeadClicks.entries()) {
			pending.detected = true;
		}
	}

	/**
	 * Handle page changes (cancels dead click detection)
	 * @private
	 */
	_handlePageChange() {
		// Mark all pending dead clicks as "not dead" since page changed
		for (const [id, pending] of this.pendingDeadClicks.entries()) {
			pending.detected = true;
		}
	}

	/**
	 * Mark a click as a dead click
	 * @private
	 */
	_markDeadClick(deadClickId) {
		// Find the action with this deadClickId and mark it
		const action = this.actions.find(a => a.deadClickId === deadClickId);
		if (action) {
			action.isDeadClick = true;

			if (this.config.debug) {
				console.warn('[SkySignal RUM] Dead click detected', action.element);
			}
		}
	}

	/**
	 * Get element information for tracking
	 * @private
	 */
	_getElementInfo(element) {
		return {
			tagName: element.tagName?.toLowerCase(),
			id: element.id || undefined,
			className: element.className || undefined,
			text: this._getElementText(element),
			selector: this._getElementSelector(element)
		};
	}

	/**
	 * Get visible text from element (first 50 chars)
	 * @private
	 */
	_getElementText(element) {
		const text = element.textContent || element.value || element.innerText || '';
		return text.trim().substring(0, 50);
	}

	/**
	 * Generate CSS selector for element
	 * @private
	 */
	_getElementSelector(element) {
		if (element.id) {
			return `#${element.id}`;
		}

		let selector = element.tagName?.toLowerCase() || '';

		if (element.className && typeof element.className === 'string') {
			const classes = element.className.split(' ').filter(c => c).slice(0, 2);
			if (classes.length > 0) {
				selector += '.' + classes.join('.');
			}
		}

		return selector || 'unknown';
	}

	/**
	 * Check if element is a form input
	 * @private
	 */
	_isFormElement(element) {
		const tagName = element.tagName?.toLowerCase();
		return ['input', 'textarea', 'select'].includes(tagName);
	}

	/**
	 * Check if we should track this action
	 * @private
	 */
	_shouldTrack() {
		return this.config.enabled && this.actions.length < this.config.maxActions;
	}

	/**
	 * Add an action to the tracking list
	 * @private
	 */
	_addAction(action) {
		this.actions.push(action);

		if (this.config.debug) {
			console.log('[SkySignal RUM] Action tracked', action);
		}

		// Warn if approaching limit
		if (this.actions.length === this.config.maxActions) {
			console.warn(`[SkySignal RUM] Maximum actions (${this.config.maxActions}) reached. Further actions will not be tracked.`);
		}
	}

	/**
	 * Get all tracked actions
	 * @returns {Array} Array of action objects
	 */
	getActions() {
		return [...this.actions];
	}

	/**
	 * Get action statistics
	 * @returns {Object} Action statistics
	 */
	getStats() {
		const stats = {
			totalActions: this.actions.length,
			clicks: 0,
			formSubmits: 0,
			inputInteractions: 0,
			rageClicks: 0,
			deadClicks: 0
		};

		for (const action of this.actions) {
			switch (action.type) {
				case 'click':
					stats.clicks++;
					if (action.isRageClick) stats.rageClicks++;
					if (action.isDeadClick) stats.deadClicks++;
					break;
				case 'form_submit':
					stats.formSubmits++;
					break;
				case 'input_focus':
				case 'input_change':
					stats.inputInteractions++;
					break;
			}
		}

		return stats;
	}

	/**
	 * Reset tracked actions (for SPA route changes)
	 */
	reset() {
		this.actions = [];
		this.lastClickTime = 0;
		this.lastClickElement = null;
		this.clickCount = 0;
		this.pendingDeadClicks.clear();

		if (this.config.debug) {
			console.log('[SkySignal RUM] UserActionTracker reset');
		}
	}

	/**
	 * Check if tracking is enabled
	 * @returns {Boolean}
	 */
	isEnabled() {
		return this.config.enabled;
	}
}
