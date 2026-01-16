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

/**
 * Estimate the total memory size of a batch (array) of items.
 *
 * This function uses a shared WeakSet for cycle detection across all items,
 * which is more efficient than calling `estimateObjectSize` on each item
 * separately when items may share object references.
 *
 * @param {Array} batch - Array of items to measure
 * @returns {number} Estimated total size in bytes
 *
 * @example
 * const batch = [
 *   { type: "trace", method: "users.get", duration: 45 },
 *   { type: "trace", method: "posts.list", duration: 120 }
 * ];
 * const size = estimateBatchSize(batch);
 * console.log(`Batch size: ${size} bytes`);
 *
 * @example
 * // Check if batch is getting too large
 * const MAX_BATCH_BYTES = 256 * 1024; // 256KB
 * if (estimateBatchSize(batch) > MAX_BATCH_BYTES) {
 *   sendBatch(batch);
 *   batch.length = 0;
 * }
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
 * Check if adding an item to a batch would exceed the size budget.
 *
 * This is a convenience function that combines `estimateBatchSize` and
 * `estimateObjectSize` to make a single decision about whether an item
 * can be safely added to a batch.
 *
 * **Note:** For high-performance scenarios, consider using incremental
 * size tracking (like SkySignalClient does) instead of recalculating
 * the full batch size on each add operation.
 *
 * @param {Array} batch - Current batch of items
 * @param {*} item - Item to potentially add
 * @param {number} maxBytes - Maximum allowed batch size in bytes
 * @returns {boolean} True if item can be added without exceeding budget
 *
 * @example
 * const batch = [];
 * const maxBytes = 256 * 1024; // 256KB
 *
 * const newTrace = { method: "users.get", duration: 45 };
 *
 * if (canAddToBatch(batch, newTrace, maxBytes)) {
 *   batch.push(newTrace);
 * } else {
 *   sendBatch(batch);
 *   batch.length = 0;
 *   batch.push(newTrace);
 * }
 */
export function canAddToBatch(batch, item, maxBytes) {
	const currentSize = estimateBatchSize(batch);
	const itemSize = estimateObjectSize(item);

	return (currentSize + itemSize) <= maxBytes;
}

/**
 * Get current process memory usage statistics.
 *
 * This is a wrapper around Node.js `process.memoryUsage()` that returns
 * a consistent object structure with all memory metrics.
 *
 * **Memory Metrics:**
 * - `rss`: Resident Set Size - total memory allocated for the process
 * - `heapTotal`: Total size of the V8 heap
 * - `heapUsed`: Amount of V8 heap actually being used
 * - `external`: Memory used by C++ objects bound to JavaScript
 * - `arrayBuffers`: Memory used by ArrayBuffers and SharedArrayBuffers
 *
 * @returns {Object} Memory usage statistics
 * @returns {number} returns.rss - Resident Set Size in bytes
 * @returns {number} returns.heapTotal - Total heap size in bytes
 * @returns {number} returns.heapUsed - Used heap size in bytes
 * @returns {number} returns.external - External memory in bytes
 * @returns {number} returns.arrayBuffers - ArrayBuffer memory in bytes
 *
 * @example
 * const mem = getProcessMemory();
 * console.log(`RSS: ${(mem.rss / 1024 / 1024).toFixed(2)} MB`);
 * console.log(`Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
 *
 * @example
 * // Monitor memory usage over time
 * setInterval(() => {
 *   const { rss, heapUsed } = getProcessMemory();
 *   console.log(`Memory - RSS: ${rss}, Heap: ${heapUsed}`);
 * }, 60000);
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
 * Calculate the percentage of process memory used by a given byte count.
 *
 * This is useful for monitoring whether the agent's memory usage stays
 * within acceptable bounds (the target is <0.5% of RSS).
 *
 * @param {number} agentBytes - Bytes used by the agent (e.g., batch queues)
 * @returns {number} Percentage of RSS (0-100)
 *
 * @example
 * const batchMemory = estimateBatchSize(allBatches);
 * const percentage = getMemoryPercentage(batchMemory);
 *
 * if (percentage > 0.5) {
 *   console.warn(`Agent using ${percentage.toFixed(2)}% of RSS - consider flushing`);
 * }
 *
 * @example
 * // Include in health metrics
 * const stats = {
 *   batchMemory: estimateBatchSize(batches),
 *   memoryPercent: getMemoryPercentage(estimateBatchSize(batches))
 * };
 */
export function getMemoryPercentage(agentBytes) {
	const { rss } = getProcessMemory();
	return (agentBytes / rss) * 100;
}
