/**
 * Trim an array to maxSize by dropping the oldest (first) entries in-place.
 * Only triggers when the array exceeds maxSize, and drops the excess plus a
 * small batch margin (10%) to avoid triggering on every single push.
 *
 * @param {Array} array - The array to trim (mutated in place)
 * @param {number} maxSize - Maximum allowed length
 */
export function trimToMaxSize(array, maxSize) {
  if (array.length > maxSize) {
    array.splice(0, array.length - maxSize);
  }
}
