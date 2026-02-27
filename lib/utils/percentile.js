/**
 * Calculate a percentile value from a sorted array.
 * Uses the ceiling method: index = ceil(count * p) - 1
 *
 * @param {number[]} sorted - Pre-sorted array of numeric values (ascending)
 * @param {number} p - Percentile as a fraction (e.g., 0.95 for P95)
 * @returns {number} The percentile value, or 0 if array is empty
 */
export function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)] || 0;
}

/**
 * Calculate common percentiles (P50, P95, P99) from an unsorted array.
 * Sorts a copy of the input array.
 *
 * @param {number[]} values - Array of numeric values (will not be mutated)
 * @returns {{ p50: number, p95: number, p99: number }}
 */
export function percentiles(values) {
  if (!values || values.length === 0) {
    return { p50: 0, p95: 0, p99: 0 };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}
