/**
 * Screenshot Capture with Privacy Redaction
 *
 * Captures screenshots of the browser window when errors occur,
 * with extensive redaction of sensitive information for privacy protection.
 *
 * Features:
 * - Automatic PII/sensitive data redaction
 * - Configurable quality and size limits
 * - Sampling support
 * - Element-level privacy controls
 */

export default class ScreenshotCapture {
	constructor(config = {}) {
		this.config = {
			enabled: config.enabled !== false,
			quality: config.quality || 0.7, // JPEG quality 0-1
			maxSize: config.maxSize || 500 * 1024, // Max 500KB
			samplingRate: config.samplingRate || 100, // Percentage of errors to capture
			redactSelectors: config.redactSelectors || this._getDefaultRedactionSelectors(),
			screenshotOnErrorTypes: config.screenshotOnErrorTypes || [
				'Error',
				'TypeError',
				'ReferenceError',
				'RangeError',
				'URIError',
				'EvalError',
				'SyntaxError',
				'UnhandledRejection',
				'FatalError'
			],
			debug: config.debug || false
		};

		// Track screenshot count for sampling
		this.screenshotCount = 0;
		this.totalErrors = 0;
	}

	/**
	 * Default extensive redaction selectors for privacy protection
	 * Redacts elements that commonly contain sensitive information
	 */
	_getDefaultRedactionSelectors() {
		return [
			// Explicit sensitive data markers
			'[data-sensitive]',
			'[data-private]',
			'[data-confidential]',
			'[data-redact]',
			'[data-pii]',

			// Form fields - passwords, credit cards, SSN, etc.
			'input[type="password"]',
			'input[type="hidden"]',
			'input[autocomplete="cc-number"]',
			'input[autocomplete="cc-csc"]',
			'input[autocomplete="cc-exp"]',
			'input[autocomplete="cc-exp-month"]',
			'input[autocomplete="cc-exp-year"]',
			'input[autocomplete="new-password"]',
			'input[autocomplete="current-password"]',
			'input[name*="password"]',
			'input[name*="pwd"]',
			'input[name*="pass"]',
			'input[name*="credit"]',
			'input[name*="card"]',
			'input[name*="cvv"]',
			'input[name*="cvc"]',
			'input[name*="ssn"]',
			'input[name*="social"]',
			'input[name*="tax"]',
			'input[name*="routing"]',
			'input[name*="account"]',
			'input[name*="bank"]',
			'input[id*="password"]',
			'input[id*="pwd"]',
			'input[id*="pass"]',
			'input[id*="credit"]',
			'input[id*="card"]',
			'input[id*="cvv"]',
			'input[id*="cvc"]',
			'input[id*="ssn"]',
			'input[id*="social"]',

			// Textareas that might contain sensitive information
			'textarea[name*="private"]',
			'textarea[name*="secret"]',
			'textarea[name*="confidential"]',

			// Common class names for sensitive fields
			'.password',
			'.password-field',
			'.pwd',
			'.pass',
			'.credit-card',
			'.card-number',
			'.cvv',
			'.cvc',
			'.ssn',
			'.social-security',
			'.bank-account',
			'.routing-number',
			'.tax-id',
			'.ein',
			'.secret',
			'.private',
			'.confidential',
			'.sensitive',

			// Email fields (may contain PII)
			'input[type="email"]',
			'input[autocomplete="email"]',
			'input[name*="email"]',
			'input[id*="email"]',

			// Phone number fields
			'input[type="tel"]',
			'input[autocomplete="tel"]',
			'input[name*="phone"]',
			'input[name*="mobile"]',
			'input[name*="tel"]',
			'input[id*="phone"]',
			'input[id*="mobile"]',

			// Address fields
			'input[autocomplete="street-address"]',
			'input[autocomplete="address-line1"]',
			'input[autocomplete="address-line2"]',
			'input[autocomplete="postal-code"]',
			'input[name*="address"]',
			'input[name*="street"]',
			'input[name*="zip"]',
			'input[name*="postal"]',

			// Name fields (PII)
			'input[autocomplete="name"]',
			'input[autocomplete="given-name"]',
			'input[autocomplete="family-name"]',
			'input[name*="firstname"]',
			'input[name*="lastname"]',
			'input[name*="fullname"]',

			// Authentication tokens and API keys
			'input[name*="token"]',
			'input[name*="api"]',
			'input[name*="key"]',
			'input[name*="secret"]',
			'input[name*="auth"]',
			'[data-token]',
			'[data-api-key]',
			'[data-auth-token]',

			// User profile sections
			'.user-profile',
			'.profile-info',
			'.personal-info',
			'.account-details',
			'.billing-info',
			'.payment-method',

			// Chat and messaging (may contain private conversations)
			'.chat-message',
			'.message-content',
			'.conversation',
			'.dm',
			'.direct-message',

			// Medical/health information (HIPAA)
			'[data-hipaa]',
			'input[name*="diagnosis"]',
			'input[name*="medical"]',
			'input[name*="health"]',
			'input[name*="prescription"]',
			'.medical-record',
			'.health-info',
			'.patient-info',

			// Financial information
			'[data-financial]',
			'.balance',
			'.account-balance',
			'.transaction-amount',
			'.salary',
			'.income',
			'.revenue',

			// Legal/compliance
			'[data-legal]',
			'[data-attorney-client]',
			'.legal-document',
			'.contract-details',

			// Video and audio elements (privacy)
			'video',
			'audio',
			'iframe[src*="zoom"]',
			'iframe[src*="meet"]',
			'iframe[src*="webex"]',

			// Canvas elements (may contain rendered sensitive content)
			'canvas',

			// Third-party embeds that might contain user data
			'iframe[src*="stripe"]',
			'iframe[src*="plaid"]',
			'iframe[src*="paypal"]',
			'iframe[src*="venmo"]',

			// Session/debug info that shouldn't be exposed
			'.debug-panel',
			'.dev-tools',
			'[data-debug]'
		];
	}

	/**
	 * Determine if a screenshot should be captured based on sampling rate
	 */
	_shouldCapture() {
		if (!this.config.enabled) {
			return false;
		}

		this.totalErrors++;

		// Apply sampling rate
		const shouldSample = Math.random() * 100 < this.config.samplingRate;

		if (this.config.debug && !shouldSample) {
			console.log('[SkySignal ScreenshotCapture] Skipped due to sampling', {
				samplingRate: this.config.samplingRate,
				totalErrors: this.totalErrors,
				screenshots: this.screenshotCount
			});
		}

		return shouldSample;
	}

	/**
	 * Check if error type should trigger screenshot
	 */
	_shouldCaptureErrorType(errorType) {
		if (this.config.screenshotOnErrorTypes.length === 0) {
			return true; // Capture all if no filter specified
		}

		return this.config.screenshotOnErrorTypes.some(type =>
			errorType.includes(type)
		);
	}

	/**
	 * Redact sensitive elements before screenshot
	 * Creates temporary overlays to hide sensitive content
	 */
	_redactSensitiveElements() {
		const redactedElements = [];
		const selectors = this.config.redactSelectors;

		selectors.forEach(selector => {
			try {
				const elements = document.querySelectorAll(selector);
				elements.forEach(element => {
					const rect = element.getBoundingClientRect();

					// Create redaction overlay
					const overlay = document.createElement('div');
					overlay.style.position = 'fixed';
					overlay.style.top = `${rect.top}px`;
					overlay.style.left = `${rect.left}px`;
					overlay.style.width = `${rect.width}px`;
					overlay.style.height = `${rect.height}px`;
					overlay.style.backgroundColor = '#000';
					overlay.style.zIndex = '999999';
					overlay.style.pointerEvents = 'none';
					overlay.className = 'skysignal-redaction-overlay';

					document.body.appendChild(overlay);
					redactedElements.push(overlay);
				});
			} catch (err) {
				if (this.config.debug) {
					console.warn(`[SkySignal ScreenshotCapture] Failed to redact selector: ${selector}`, err);
				}
			}
		});

		return redactedElements;
	}

	/**
	 * Remove redaction overlays
	 */
	_removeRedactionOverlays(overlays) {
		overlays.forEach(overlay => {
			try {
				overlay.remove();
			} catch (err) {
				// Ignore removal errors
			}
		});
	}

	/**
	 * Capture screenshot using html2canvas
	 * Returns base64 data URL or null if capture fails
	 */
	async _captureScreenshot() {
		try {
			// Check if html2canvas is available
			if (typeof html2canvas === 'undefined') {
				console.warn('[SkySignal ScreenshotCapture] html2canvas library not loaded');
				return null;
			}

			// Capture screenshot
			const canvas = await html2canvas(document.body, {
				useCORS: true,
				allowTaint: false,
				logging: false,
				scale: 1 // Use device pixel ratio for clarity
			});

			// Convert to blob with quality compression
			return new Promise((resolve) => {
				canvas.toBlob(
					(blob) => {
						if (!blob) {
							resolve(null);
							return;
						}

						// Check size limit
						if (blob.size > this.config.maxSize) {
							if (this.config.debug) {
								console.warn('[SkySignal ScreenshotCapture] Screenshot exceeds max size', {
									size: blob.size,
									maxSize: this.config.maxSize
								});
							}
							resolve(null);
							return;
						}

						// Convert blob to base64
						const reader = new FileReader();
						reader.onloadend = () => {
							resolve(reader.result);
						};
						reader.onerror = () => {
							resolve(null);
						};
						reader.readAsDataURL(blob);
					},
					'image/jpeg',
					this.config.quality
				);
			});
		} catch (error) {
			if (this.config.debug) {
				console.error('[SkySignal ScreenshotCapture] Failed to capture screenshot', error);
			}
			return null;
		}
	}

	/**
	 * Capture screenshot with redaction
	 * Main public method
	 *
	 * @param {Object} errorInfo - Error information
	 * @param {String} errorInfo.type - Error type (e.g., 'TypeError', 'ReferenceError')
	 * @param {String} errorInfo.message - Error message
	 * @returns {Promise<String|null>} Base64 screenshot data URL or null
	 */
	async capture(errorInfo = {}) {
		// Check if we should capture based on sampling
		if (!this._shouldCapture()) {
			return null;
		}

		// Check if error type should trigger screenshot
		if (errorInfo.type && !this._shouldCaptureErrorType(errorInfo.type)) {
			if (this.config.debug) {
				console.log('[SkySignal ScreenshotCapture] Skipped - error type not in filter', {
					errorType: errorInfo.type,
					filter: this.config.screenshotOnErrorTypes
				});
			}
			return null;
		}

		let redactionOverlays = [];

		try {
			// Redact sensitive elements
			redactionOverlays = this._redactSensitiveElements();

			if (this.config.debug) {
				console.log('[SkySignal ScreenshotCapture] Redacted elements', {
					count: redactionOverlays.length,
					errorType: errorInfo.type
				});
			}

			// Small delay to ensure overlays are rendered
			await new Promise(resolve => setTimeout(resolve, 50));

			// Capture screenshot
			const screenshot = await this._captureScreenshot();

			// Remove overlays
			this._removeRedactionOverlays(redactionOverlays);

			if (screenshot) {
				this.screenshotCount++;

				if (this.config.debug) {
					console.log('[SkySignal ScreenshotCapture] Screenshot captured', {
						size: screenshot.length,
						errorType: errorInfo.type,
						totalScreenshots: this.screenshotCount
					});
				}
			}

			return screenshot;
		} catch (error) {
			// Ensure overlays are removed even if capture fails
			this._removeRedactionOverlays(redactionOverlays);

			if (this.config.debug) {
				console.error('[SkySignal ScreenshotCapture] Capture failed', error);
			}

			return null;
		}
	}

	/**
	 * Get capture statistics
	 */
	getStats() {
		return {
			enabled: this.config.enabled,
			totalErrors: this.totalErrors,
			screenshotsCaptured: this.screenshotCount,
			samplingRate: this.config.samplingRate,
			captureRate: this.totalErrors > 0 ? (this.screenshotCount / this.totalErrors) * 100 : 0
		};
	}
}
