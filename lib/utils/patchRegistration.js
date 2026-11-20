/**
 * Patch a registration function (e.g. Meteor.methods, Meteor.server.publish)
 * so `after()` runs after every call. Idempotent per object; returns the
 * original so the caller can restore it.
 */
export function patchRegistration(obj, key, after) {
  const original = obj && obj[key];
  if (typeof original !== "function" || original._skySignalPatched) return null;
  const patched = function (...args) {
    const result = original.apply(this, args);
    after();
    return result;
  };
  patched._skySignalPatched = true;
  obj[key] = patched;
  return original;
}
