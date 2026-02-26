/**
 * Mock for web-vitals library.
 * Stores callbacks so tests can trigger metric reports manually.
 */

const _callbacks = {
  cls: [],
  fid: [],
  lcp: [],
  fcp: [],
  ttfb: []
};

function onCLS(cb) { _callbacks.cls.push(cb); }
function onFID(cb) { _callbacks.fid.push(cb); }
function onLCP(cb) { _callbacks.lcp.push(cb); }
function onFCP(cb) { _callbacks.fcp.push(cb); }
function onTTFB(cb) { _callbacks.ttfb.push(cb); }

// Test helper to trigger a metric callback
function _triggerMetric(name, value) {
  const cbs = _callbacks[name] || [];
  cbs.forEach(cb => cb({ name, value, delta: value, id: `v1-${Date.now()}` }));
}

// Test helper to reset all callbacks
function _reset() {
  for (const key of Object.keys(_callbacks)) {
    _callbacks[key] = [];
  }
}

module.exports = { onCLS, onFID, onLCP, onFCP, onTTFB, _triggerMetric, _reset, _callbacks };
