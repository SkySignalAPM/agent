/**
 * Reduce a URL to origin + pathname before it leaves the browser.
 * Query strings and hashes routinely carry secrets (Meteor's
 * `/#/reset-password/<token>`, signed S3 `X-Amz-Signature` URLs).
 * Non-http(s) URLs (data:, blob:, about:) collapse to their scheme.
 *
 * @param {*} url - Absolute or relative URL; non-strings yield ''
 * @returns {string}
 */
export default function stripUrl(url) {
	if (typeof url !== 'string' || !url) return '';
	try {
		const u = new URL(url, window.location.href);
		return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : u.protocol;
	} catch (e) {
		// Invalid URL or no URL constructor (IE11)
		return url.split(/[?#]/)[0];
	}
}
