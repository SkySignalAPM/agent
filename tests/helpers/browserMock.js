/**
 * Browser global mocks for client-side test files (ErrorTracker, etc.).
 *
 * Call `setupBrowserMocks()` before tests and `teardownBrowserMocks()` after.
 */

const sinon = require('sinon');

const _saved = {};
const _descriptors = {};

function _defineGlobal(name, value) {
  _descriptors[name] = Object.getOwnPropertyDescriptor(global, name);
  _saved[name] = global[name];
  Object.defineProperty(global, name, {
    value,
    writable: true,
    configurable: true
  });
}

function setupBrowserMocks() {
  // window
  _defineGlobal('window', {
    location: { href: 'http://localhost:3000/test', origin: 'http://localhost:3000', pathname: '/test' },
    addEventListener: sinon.stub(),
    removeEventListener: sinon.stub(),
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 }
  });

  // history (for SPA route change detection)
  _defineGlobal('history', {
    pushState: sinon.stub(),
    replaceState: sinon.stub()
  });

  // navigator
  _defineGlobal('navigator', {
    userAgent: 'TestAgent/1.0',
    sendBeacon: sinon.stub().returns(true)
  });

  // document
  _defineGlobal('document', {
    createElement: sinon.stub().returns({ style: {} }),
    body: { appendChild: sinon.stub(), removeChild: sinon.stub() },
    addEventListener: sinon.stub(),
    removeEventListener: sinon.stub(),
    querySelectorAll: sinon.stub().returns([]),
    readyState: 'complete',
    visibilityState: 'visible',
    referrer: ''
  });

  // performance (for RUMCollector)
  _defineGlobal('performance', {
    getEntriesByType: sinon.stub().returns([]),
    now: sinon.stub().returns(0)
  });

  // localStorage
  const store = {};
  _defineGlobal('localStorage', {
    getItem: sinon.stub().callsFake(k => store[k] || null),
    setItem: sinon.stub().callsFake((k, v) => { store[k] = String(v); }),
    removeItem: sinon.stub().callsFake(k => { delete store[k]; }),
    clear: sinon.stub().callsFake(() => { for (const k in store) delete store[k]; })
  });

  // fetch
  _defineGlobal('fetch', sinon.stub().resolves({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => ''
  }));
}

function teardownBrowserMocks() {
  for (const [name, descriptor] of Object.entries(_descriptors)) {
    if (descriptor) {
      Object.defineProperty(global, name, descriptor);
    } else {
      delete global[name];
    }
  }
  // Clear saved state
  for (const key of Object.keys(_saved)) delete _saved[key];
  for (const key of Object.keys(_descriptors)) delete _descriptors[key];
}

module.exports = { setupBrowserMocks, teardownBrowserMocks };
