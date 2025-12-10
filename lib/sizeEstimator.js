/**
 * Pure JavaScript object size estimator
 * Zero external dependencies - uses recursive traversal with cycle detection
 *
 * Used to ensure we stay within memory budget (<0.5% RSS)
 */

// Maximum recursion depth to prevent stack overflow on deeply nested objects
const MAX_DEPTH = 20;

/**
 * Estimate the memory size of a JavaScript object in bytes
 * @param {*} obj - Object to measure
 * @param {WeakSet} [seen] - Internal cycle detection (do not pass)
 * @param {number} [depth] - Current recursion depth (do not pass)
 * @returns {number} Estimated size in bytes
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

/**
 * Estimate batch size to ensure we stay within budget
 * @param {Array} batch - Array of items
 * @returns {number} Estimated total size in bytes
 */
export function estimateBatchSize(batch) {
	let total = 0;
	const seen = new WeakSet();

	for (const item of batch) {
		total += estimateObjectSize(item, seen);
	}

	return total;
}

/**
 * Check if adding an item would exceed the size budget
 * @param {Array} batch - Current batch
 * @param {*} item - Item to add
 * @param {number} maxBytes - Maximum allowed bytes
 * @returns {boolean} True if item can be added
 */
export function canAddToBatch(batch, item, maxBytes) {
	const currentSize = estimateBatchSize(batch);
	const itemSize = estimateObjectSize(item);

	return (currentSize + itemSize) <= maxBytes;
}

/**
 * Get memory usage of current process
 * @returns {Object} Memory usage stats
 */
export function getProcessMemory() {
	const usage = process.memoryUsage();

	return {
		rss: usage.rss,              // Resident Set Size (total memory)
		heapTotal: usage.heapTotal,  // Total heap allocated
		heapUsed: usage.heapUsed,    // Heap actually used
		external: usage.external,    // C++ objects bound to JS
		arrayBuffers: usage.arrayBuffers || 0
	};
}

/**
 * Calculate percentage of memory used by agent relative to total process
 * @param {number} agentBytes - Bytes used by agent
 * @returns {number} Percentage of RSS
 */
export function getMemoryPercentage(agentBytes) {
	const { rss } = getProcessMemory();
	return (agentBytes / rss) * 100;
}
