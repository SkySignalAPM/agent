/**
 * Pure JavaScript object size estimator with zero external dependencies.
 *
 * This module provides utilities for estimating memory usage of JavaScript objects.
 * It uses recursive traversal with cycle detection and depth limiting to safely
 * measure objects of any complexity.
 *
 * Used internally by SkySignalClient to enforce memory budgets and prevent
 * unbounded batch growth that could impact application performance.
 *
 * @module sizeEstimator
 */

/**
 * Maximum recursion depth to prevent stack overflow on deeply nested objects.
 * Objects nested deeper than this will be estimated at 100 bytes.
 * @constant {number}
 * @private
 */
const MAX_DEPTH = 20;

/**
 * Estimate the memory size of a JavaScript object in bytes.
 *
 * This function recursively traverses the object structure to estimate its
 * memory footprint. It handles all JavaScript types including primitives,
 * objects, arrays, Dates, RegExps, and TypedArrays.
 *
 * **Size Estimates by Type:**
 * - `null`/`undefined`: 0 bytes
 * - `boolean`: 4 bytes
 * - `number`: 8 bytes
 * - `bigint`: 8 bytes
 * - `string`: 2 bytes per character (UTF-16)
 * - `Date`: 24 bytes
 * - `RegExp`: source length * 2 + 24 bytes
 * - `Array`: 8 bytes + sum of element sizes
 * - `Object`: 8 bytes + sum of key/value sizes
 * - `ArrayBuffer`/`TypedArray`: byteLength
 *
 * **Safety Features:**
 * - Cycle detection using WeakSet (prevents infinite loops)
 * - Depth limiting (MAX_DEPTH = 20) to prevent stack overflow
 * - Array/object key iteration limits (1000 items, 500 keys)
 *
 * @param {*} obj - The object to measure (any JavaScript value)
 * @param {WeakSet} [seen=new WeakSet()] - Internal: tracks visited objects for cycle detection. Do not pass this parameter.
 * @param {number} [depth=0] - Internal: current recursion depth. Do not pass this parameter.
 * @returns {number} Estimated size in bytes
 *
 * @example
 * // Primitive types
 * estimateObjectSize(42);           // 8 (number)
 * estimateObjectSize("hello");      // 10 (5 chars * 2 bytes)
 * estimateObjectSize(true);         // 4 (boolean)
 *
 * @example
 * // Objects and arrays
 * estimateObjectSize({ name: "John", age: 30 });  // ~40 bytes
 * estimateObjectSize([1, 2, 3, 4, 5]);            // ~48 bytes
 *
 * @example
 * // Used by SkySignalClient for batch size tracking
 * const itemSize = estimateObjectSize(traceData);
 * if (currentBatchSize + itemSize > maxBatchBytes) {
 *   flushBatch();
 * }
 */
export function estimateObjectSize(obj, seen = new WeakSet(), depth = 0) {
	// Depth limit to prevent stack overflow
	if (depth > MAX_DEPTH) {
		return 100; // Return a small estimate for deeply nested content
	}

	// Primitives
	if (obj === null || obj === undefined) return 0;

	const type = typeof obj;

	// Numbers, booleans
	if (type === 'number') return 8;
	if (type === 'boolean') return 4;

	// Strings - 2 bytes per character (UTF-16)
	if (type === 'string') return obj.length * 2;

	// Symbols
	if (type === 'symbol') return Symbol.keyFor(obj) ? Symbol.keyFor(obj).length * 2 : 0;

	// BigInt - approximate
	if (type === 'bigint') return 8;

	// Functions - rough estimate
	if (type === 'function') return obj.toString().length * 2;

	// Objects (including arrays)
	if (type === 'object') {
		// Cycle detection
		if (seen.has(obj)) return 0;
		seen.add(obj);

		let size = 0;

		// Arrays
		if (Array.isArray(obj)) {
			size += 8; // Array overhead
			// Limit array iteration to prevent excessive traversal
			const maxItems = Math.min(obj.length, 1000);
			for (let i = 0; i < maxItems; i++) {
				size += estimateObjectSize(obj[i], seen, depth + 1);
			}
			// Estimate remaining items
			if (obj.length > maxItems) {
				const avgItemSize = maxItems > 0 ? size / maxItems : 8;
				size += (obj.length - maxItems) * avgItemSize;
			}
			return size;
		}

		// Date
		if (obj instanceof Date) return 24;

		// RegExp
		if (obj instanceof RegExp) return obj.source.length * 2 + 24;

		// Buffer/TypedArray
		if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
			return obj.byteLength || 0;
		}

		// Plain objects
		size += 8; // Object overhead
		const keys = Object.keys(obj);
		// Limit key iteration to prevent excessive traversal
		const maxKeys = Math.min(keys.length, 500);
		for (let i = 0; i < maxKeys; i++) {
			const key = keys[i];
			// Key size
			size += key.length * 2;
			// Value size
			size += estimateObjectSize(obj[key], seen, depth + 1);
		}
		// Estimate remaining keys
		if (keys.length > maxKeys) {
			const avgKeyValueSize = maxKeys > 0 ? size / maxKeys : 16;
			size += (keys.length - maxKeys) * avgKeyValueSize;
		}

		return size;
	}

	return 0;
}
