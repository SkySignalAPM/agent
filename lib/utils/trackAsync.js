/**
 * Helper utility for tracking async function execution in Meteor methods
 *
 * This utility provides both explicit tracking (trackAsync) and automatic
 * tracking (makeTrackable) for user-defined async functions.
 *
 * @module trackAsync
 */

/**
 * Make an async function automatically trackable
 *
 * Wrap your function definition once, then every call is automatically tracked.
 *
 * @param {string} label - Descriptive label for the operation
 * @param {Function} asyncFunction - The async function to wrap
 * @returns {Function} - Wrapped function that tracks execution automatically
 *
 * @example
 * // Define once with tracking
 * export const profitCalculator = makeTrackable('profitCalculator', async (order) => {
 *   const costs = await calculateCosts(order);
 *   const revenue = await calculateRevenue(order);
 *   return revenue - costs;
 * });
 *
 * // Use anywhere - automatically tracked!
 * const profit = await profitCalculator(order);
 *
 * @example
 * // Works with any async function
 * const fetchUserData = makeTrackable('fetchUserData', async (userId) => {
 *   const response = await fetch(`/api/users/${userId}`);
 *   return await response.json();
 * });
 */
export function makeTrackable(label, asyncFunction) {
  if (typeof asyncFunction !== 'function') {
    throw new Error('makeTrackable: Second argument must be a function');
  }

  return async function(...args) {
    const operationStart = Date.now();

    try {
      const result = await asyncFunction.apply(this, args);

      const duration = Date.now() - operationStart;

      // Track if tracer is available and we're in a method context
      if (global.SkySignalTracer && global.SkySignalTracer._currentMethodContext) {
        global.SkySignalTracer.addOperation({
          type: "async",
          label: label,
          duration
        });
      }

      return result;
    } catch (error) {
      const duration = Date.now() - operationStart;

      // Track error if tracer is available
      if (global.SkySignalTracer && global.SkySignalTracer._currentMethodContext) {
        global.SkySignalTracer.addOperation({
          type: "async",
          label: label,
          duration,
          error: error.message
        });
      }

      throw error;
    }
  };
}

/**
 * Make all methods in a class trackable
 *
 * Wraps all async methods of a class for automatic tracking.
 *
 * @param {string} prefix - Prefix for all method labels (usually the class name)
 * @param {Object} classOrObject - Class or object with methods to wrap
 * @returns {Object} - New object with wrapped methods
 *
 * @example
 * class OrderService {
 *   async calculateProfit(order) { ... }
 *   async updateInventory(items) { ... }
 * }
 *
 * export default makeTrackableClass('OrderService', new OrderService());
 *
 * // All methods automatically tracked as "OrderService.calculateProfit", etc.
 */
export function makeTrackableClass(prefix, classOrObject) {
  const wrapped = {};

  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(classOrObject))) {
    const prop = classOrObject[key];

    if (typeof prop === 'function' && key !== 'constructor') {
      const isAsync = prop.constructor.name === 'AsyncFunction';

      if (isAsync) {
        wrapped[key] = makeTrackable(`${prefix}.${key}`, prop.bind(classOrObject));
      } else {
        wrapped[key] = prop.bind(classOrObject);
      }
    }
  }

  // Also check own properties (for arrow functions, etc.)
  for (const key of Object.keys(classOrObject)) {
    const prop = classOrObject[key];

    if (typeof prop === 'function') {
      const isAsync = prop.constructor.name === 'AsyncFunction';

      if (isAsync) {
        wrapped[key] = makeTrackable(`${prefix}.${key}`, prop.bind(classOrObject));
      } else {
        wrapped[key] = prop.bind(classOrObject);
      }
    }
  }

  return wrapped;
}

/**
 * Track an async function's execution time (explicit tracking)
 *
 * @param {string} label - Descriptive label for the operation (e.g., 'profitCalculator', 'fetchUserData')
 * @param {Promise|Function} asyncOperationOrPromise - Either a Promise or an async function to execute
 * @returns {Promise<*>} - The result of the async operation
 *
 * @example
 * // Track a Promise
 * const result = await trackAsync('profitCalculator', profitCalculator(input));
 *
 * @example
 * // Track an inline async function
 * const result = await trackAsync('calculateProfit', async () => {
 *   const data = await fetchData();
 *   return processData(data);
 * });
 *
 * @example
 * // Track with error handling
 * try {
 *   const result = await trackAsync('riskyOperation', riskyAsyncFunction());
 * } catch (error) {
 *   console.error('Operation failed:', error);
 * }
 */
export async function trackAsync(label, asyncOperationOrPromise) {
  // Check if tracer is available
  if (!global.SkySignalTracer) {
    console.warn('⚠️ SkySignal tracer not available. Make sure the agent is running.');
    // Execute without tracking
    return typeof asyncOperationOrPromise === 'function'
      ? await asyncOperationOrPromise()
      : await asyncOperationOrPromise;
  }

  // Use the tracer's trackAsyncFunction method
  return await global.SkySignalTracer.trackAsyncFunction(label, asyncOperationOrPromise);
}

/**
 * Track multiple async operations in parallel
 *
 * @param {Object} operations - Object with labels as keys and Promises as values
 * @returns {Promise<Object>} - Object with same keys and resolved values
 *
 * @example
 * const results = await trackAsyncBatch({
 *   'fetchUsers': fetchUsers(),
 *   'fetchPosts': fetchPosts(),
 *   'fetchComments': fetchComments()
 * });
 * // results = { fetchUsers: [...], fetchPosts: [...], fetchComments: [...] }
 */
export async function trackAsyncBatch(operations) {
  const entries = Object.entries(operations);
  const trackedPromises = entries.map(([label, promise]) =>
    trackAsync(label, promise)
  );

  const results = await Promise.all(trackedPromises);

  // Reconstruct object with original keys
  return entries.reduce((acc, [label], index) => {
    acc[label] = results[index];
    return acc;
  }, {});
}
