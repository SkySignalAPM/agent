/**
 * Meteor 3.6+ `instrumentation` core package detection.
 *
 * Read lazily (at collector start) — ddp-server weakly depends on
 * `instrumentation`, so when the app has added it, it is loaded before us.
 * Returns null on older Meteor or when the package isn't added; callers fall
 * back to their wrapper-only behavior.
 */
export function getInstrumentation() {
  try {
    const pkg = typeof Package !== "undefined" ? Package["instrumentation"] : null;
    const I = pkg && pkg.Instrumentation;
    return I && typeof I.on === "function" && typeof I.currentContext === "function" ? I : null;
  } catch (_) {
    return null;
  }
}
