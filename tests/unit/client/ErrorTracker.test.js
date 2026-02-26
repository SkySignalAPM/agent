/**
 * ErrorTracker tests — includes Bug #10 regression tests.
 *
 * Bug #10: _serializeArg was using String(obj) which produced "[object Object]"
 * instead of JSON-serialized content. Fixed to use depth-limited JSON.stringify.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { setupBrowserMocks, teardownBrowserMocks } from '../../helpers/browserMock.js';
import ErrorTracker from '../../../client/ErrorTracker.js';

describe('ErrorTracker', function () {

  before(function () {
    setupBrowserMocks();
  });

  after(function () {
    teardownBrowserMocks();
  });

  describe('constructor', function () {

    it('sets default config values', function () {
      const tracker = new ErrorTracker();
      expect(tracker.config.enabled).to.be.true;
      expect(tracker.config.captureUnhandledRejections).to.be.true;
      expect(tracker.config.captureConsoleErrors).to.be.false;
      expect(tracker.config.ignoreErrors).to.deep.equal([]);
    });

    it('respects disabled flag', function () {
      const tracker = new ErrorTracker({ enabled: false });
      expect(tracker.config.enabled).to.be.false;
    });
  });

  describe('init', function () {

    it('does not initialize without publicKey', function () {
      const tracker = new ErrorTracker({});
      tracker.init();
      expect(tracker.initialized).to.be.false;
    });

    it('does not initialize when disabled', function () {
      const tracker = new ErrorTracker({ enabled: false, publicKey: 'pk_test' });
      tracker.init();
      expect(tracker.initialized).to.be.false;
    });

    it('initializes with valid publicKey', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      tracker.init();
      expect(tracker.initialized).to.be.true;
    });

    it('is idempotent (second call is no-op)', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      tracker.init();
      // Second call should warn but not throw
      tracker.init();
      expect(tracker.initialized).to.be.true;
    });
  });

  // ==========================================
  // Bug #10 Regression: _serializeArg
  // ==========================================
  describe('_serializeArg (Bug #10 regression)', function () {

    let tracker;

    beforeEach(function () {
      tracker = new ErrorTracker({ publicKey: 'pk_test' });
    });

    it('serializes plain objects to JSON, NOT [object Object]', function () {
      const result = tracker._serializeArg({ a: 1, b: 'two' });
      expect(result).to.equal('{"a":1,"b":"two"}');
      expect(result).to.not.include('[object Object]');
    });

    it('serializes nested objects with depth limiting', function () {
      const deep = { l1: { l2: { l3: { l4: { l5: { l6: 'deep' } } } } } };
      const result = tracker._serializeArg(deep, 5);
      expect(result).to.be.a('string');
      // At depth 5, l6 should be replaced with [Object]
      expect(result).to.include('[Object]');
      expect(result).to.not.include('[object Object]');
    });

    it('handles circular references with [Circular] marker', function () {
      const obj = { name: 'test' };
      obj.self = obj;
      const result = tracker._serializeArg(obj);
      expect(result).to.include('[Circular]');
      expect(result).to.not.include('[object Object]');
    });

    it('truncates large objects at maxLength', function () {
      const big = {};
      for (let i = 0; i < 500; i++) {
        big[`key_${i}`] = `value_${i}_${'x'.repeat(20)}`;
      }
      const result = tracker._serializeArg(big, 5, 5120);
      expect(result.length).to.be.at.most(5120 + 15); // +15 for "...[truncated]"
      if (result.length > 5120) {
        expect(result).to.include('...[truncated]');
      }
    });

    it('serializes Error instances to stack trace string', function () {
      const err = new Error('test error');
      const result = tracker._serializeArg(err);
      expect(result).to.include('test error');
      // Should use stack if available
      if (err.stack) {
        expect(result).to.include('Error:');
      }
    });

    it('passes through primitives unchanged', function () {
      expect(tracker._serializeArg('hello')).to.equal('hello');
      expect(tracker._serializeArg(42)).to.equal('42');
      expect(tracker._serializeArg(true)).to.equal('true');
      expect(tracker._serializeArg(null)).to.equal('null');
      expect(tracker._serializeArg(undefined)).to.equal('undefined');
    });

    it('serializes arrays as JSON', function () {
      const result = tracker._serializeArg([1, 'two', { three: 3 }]);
      expect(result).to.equal('[1,"two",{"three":3}]');
    });
  });

  describe('_truncateDepth', function () {

    let tracker;

    beforeEach(function () {
      tracker = new ErrorTracker({ publicKey: 'pk_test' });
    });

    it('returns primitives unchanged', function () {
      expect(tracker._truncateDepth(42, 5, new WeakSet())).to.equal(42);
      expect(tracker._truncateDepth('str', 5, new WeakSet())).to.equal('str');
      expect(tracker._truncateDepth(null, 5, new WeakSet())).to.be.null;
    });

    it('replaces objects at depth 0 with [Object]', function () {
      expect(tracker._truncateDepth({ a: 1 }, 0, new WeakSet())).to.equal('[Object]');
    });

    it('replaces arrays at depth 0 with [Array(n)]', function () {
      expect(tracker._truncateDepth([1, 2, 3], 0, new WeakSet())).to.equal('[Array(3)]');
    });

    it('detects circular references', function () {
      const obj = { a: 1 };
      obj.self = obj;
      const seen = new WeakSet();
      const result = tracker._truncateDepth(obj, 5, seen);
      expect(result.self).to.equal('[Circular]');
    });

    it('recursively truncates nested objects', function () {
      const nested = { a: { b: { c: 'leaf' } } };
      const result = tracker._truncateDepth(nested, 2, new WeakSet());
      expect(result.a.b).to.equal('[Object]');
    });
  });

  describe('_shouldIgnoreError', function () {

    it('matches string patterns', function () {
      const tracker = new ErrorTracker({
        publicKey: 'pk_test',
        ignoreErrors: ['ResizeObserver loop']
      });
      expect(tracker._shouldIgnoreError('ResizeObserver loop limit exceeded')).to.be.true;
      expect(tracker._shouldIgnoreError('TypeError: undefined')).to.be.false;
    });

    it('matches RegExp patterns', function () {
      const tracker = new ErrorTracker({
        publicKey: 'pk_test',
        ignoreErrors: [/Script error/i]
      });
      expect(tracker._shouldIgnoreError('script error.')).to.be.true;
      expect(tracker._shouldIgnoreError('ReferenceError: x')).to.be.false;
    });
  });

  describe('_generateFingerprint', function () {

    it('combines type, message, filename, lineno', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      const fp = tracker._generateFingerprint({
        type: 'TypeError',
        message: 'x is not a function',
        filename: 'app.js',
        lineno: 42
      });
      expect(fp).to.equal('TypeError|x is not a function|app.js|42');
    });

    it('handles missing optional fields', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      const fp = tracker._generateFingerprint({
        type: 'Error',
        message: 'oops'
      });
      expect(fp).to.equal('Error|oops||');
    });
  });

  // ==========================================
  // Bug #10 Regression: console.error capture
  // ==========================================
  describe('_setupConsoleErrorCapture (Bug #10 regression)', function () {

    let tracker;
    let originalConsoleError;

    beforeEach(function () {
      originalConsoleError = console.error;
      tracker = new ErrorTracker({
        publicKey: 'pk_test',
        captureConsoleErrors: true
      });
    });

    afterEach(function () {
      // Restore console.error
      console.error = originalConsoleError;
    });

    it('wraps console.error and calls original first', function () {
      const spy = sinon.spy();
      console.error = spy;

      tracker._setupConsoleErrorCapture();
      console.error('test message');

      expect(spy.calledOnce).to.be.true;
      expect(spy.firstCall.args[0]).to.equal('test message');
    });

    it('serializes object args as JSON in captured message, not [object Object]', function (done) {
      // Stub _handleError to inspect the captured message
      tracker._handleError = async function (error) {
        try {
          expect(error.message).to.include('"a":1');
          expect(error.message).to.not.include('[object Object]');
          done();
        } catch (e) {
          done(e);
        }
      };

      console.error = function () {}; // suppress output
      tracker._setupConsoleErrorCapture();
      console.error('test', { a: 1 });
    });
  });

  // ==========================================
  // Bug #10 Regression: unhandled rejection
  // ==========================================
  describe('_setupUnhandledRejectionHandler (Bug #10 regression)', function () {

    let tracker;

    beforeEach(function () {
      tracker = new ErrorTracker({
        publicKey: 'pk_test',
        captureUnhandledRejections: true
      });
    });

    it('uses reason.message for Error rejections', async function () {
      let capturedError = null;
      tracker._handleError = async function (error) {
        capturedError = error;
      };

      // Reset the addEventListener stub to clear history from prior tests
      global.window.addEventListener.resetHistory();

      tracker._setupUnhandledRejectionHandler();

      // Find the handler that was registered
      const calls = global.window.addEventListener.getCalls();
      const addEventCall = calls.find(c => c.args[0] === 'unhandledrejection');

      expect(addEventCall, 'unhandledrejection handler not registered').to.exist;

      // Invoke the registered async handler directly
      await addEventCall.args[1]({ reason: new Error('async failure') });

      expect(capturedError).to.not.be.null;
      expect(capturedError.message).to.equal('async failure');
    });

    it('uses _serializeArg for non-Error rejections (not String())', async function () {
      let capturedError = null;
      tracker._handleError = async function (error) {
        capturedError = error;
      };

      // Reset the addEventListener stub to clear history from prior tests
      global.window.addEventListener.resetHistory();

      tracker._setupUnhandledRejectionHandler();

      const addEventCall = global.window.addEventListener
        .getCalls()
        .find(c => c.args[0] === 'unhandledrejection');

      expect(addEventCall, 'unhandledrejection handler not registered').to.exist;

      await addEventCall.args[1]({
        reason: { code: 'NETWORK_ERROR', details: { host: 'api.example.com' } }
      });

      expect(capturedError).to.not.be.null;
      expect(capturedError.message).to.include('NETWORK_ERROR');
      expect(capturedError.message).to.include('api.example.com');
      expect(capturedError.message).to.not.include('[object Object]');
    });
  });

  describe('getStats', function () {

    it('returns stats object with expected keys', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      const stats = tracker.getStats();
      expect(stats).to.have.property('initialized', false);
      expect(stats).to.have.property('queuedErrors', 0);
      expect(stats).to.have.property('pendingErrors', 0);
    });

    it('includes screenshot stats when screenshots enabled', function () {
      const tracker = new ErrorTracker({
        publicKey: 'pk_test',
        attachScreenshots: true
      });
      const stats = tracker.getStats();
      expect(stats).to.have.property('screenshots');
      expect(stats.screenshots).to.have.property('enabled');
    });
  });

  // ==========================================
  // isInitialized
  // ==========================================
  describe('isInitialized', function () {

    it('returns false before init', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      expect(tracker.isInitialized()).to.be.false;
    });

    it('returns true after init', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      tracker.init();
      expect(tracker.isInitialized()).to.be.true;
    });
  });

  // ==========================================
  // _getBeaconUrl
  // ==========================================
  describe('_getBeaconUrl', function () {

    it('builds URL with pk query param for relative endpoint', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test_123', endpoint: '/api/v1/errors' });
      const url = tracker._getBeaconUrl();
      expect(url).to.include('http://localhost:3000/api/v1/errors');
      expect(url).to.include('pk=pk_test_123');
    });

    it('uses absolute endpoint as-is', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test', endpoint: 'https://custom.example.com/api/v1/errors' });
      const url = tracker._getBeaconUrl();
      expect(url).to.include('https://custom.example.com/api/v1/errors');
      expect(url).to.include('pk=pk_test');
    });

    it('caches URL after first call', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      const url1 = tracker._getBeaconUrl();
      const url2 = tracker._getBeaconUrl();
      expect(url1).to.equal(url2);
      expect(tracker._beaconUrl).to.equal(url1);
    });
  });

  // ==========================================
  // _handleError
  // ==========================================
  describe('_handleError', function () {

    let tracker;

    beforeEach(function () {
      tracker = new ErrorTracker({ publicKey: 'pk_test' });
      // Stub _sendError to avoid actual network calls
      tracker._sendError = sinon.stub().resolves();
    });

    it('skips ignored errors', async function () {
      tracker.config.ignoreErrors = ['ResizeObserver'];
      await tracker._handleError({ message: 'ResizeObserver loop limit exceeded', type: 'Error' });
      expect(tracker._sendError.called).to.be.false;
    });

    it('deduplicates concurrent identical errors', async function () {
      const error = { type: 'TypeError', message: 'x is not a fn', filename: 'app.js', lineno: 10 };

      // Simulate concurrent calls — first call blocks on _sendError
      let resolveFirst;
      tracker._sendError = sinon.stub().returns(new Promise(r => { resolveFirst = r; }));

      const p1 = tracker._handleError({ ...error });
      // Same fingerprint should be skipped while first is pending
      const p2 = tracker._handleError({ ...error });

      resolveFirst();
      await p1;
      await p2;

      // Only one call to _sendError
      expect(tracker._sendError.calledOnce).to.be.true;
    });

    it('clears pendingErrors in finally block', async function () {
      await tracker._handleError({ type: 'Error', message: 'test' });
      expect(tracker.pendingErrors.size).to.equal(0);
    });

    it('calls beforeSend hook and skips when it returns false', async function () {
      tracker.config.beforeSend = sinon.stub().returns(false);
      await tracker._handleError({ type: 'Error', message: 'test' });
      expect(tracker._sendError.called).to.be.false;
    });

    it('calls beforeSend hook and skips when it returns null', async function () {
      tracker.config.beforeSend = sinon.stub().returns(null);
      await tracker._handleError({ type: 'Error', message: 'test' });
      expect(tracker._sendError.called).to.be.false;
    });

    it('merges beforeSend result into payload when it returns object', async function () {
      tracker.config.beforeSend = sinon.stub().returns({ extra: 'data' });
      await tracker._handleError({ type: 'Error', message: 'test' });
      expect(tracker._sendError.calledOnce).to.be.true;
      const payload = tracker._sendError.firstCall.args[0];
      expect(payload.extra).to.equal('data');
    });

    it('still sends when beforeSend throws', async function () {
      tracker.config.beforeSend = sinon.stub().throws(new Error('hook broke'));
      await tracker._handleError({ type: 'Error', message: 'test' });
      expect(tracker._sendError.calledOnce).to.be.true;
    });

    it('attaches capturedAt timestamp', async function () {
      await tracker._handleError({ type: 'Error', message: 'test' });
      const payload = tracker._sendError.firstCall.args[0];
      expect(payload.capturedAt).to.be.a('string');
    });
  });

  // ==========================================
  // _sendError
  // ==========================================
  describe('_sendError', function () {

    let tracker;

    beforeEach(function () {
      // Re-stub navigator.sendBeacon and fetch since sinon.restore() clears them between tests
      navigator.sendBeacon = sinon.stub().returns(true);
      global.fetch = sinon.stub().resolves({ ok: true, status: 200 });
      tracker = new ErrorTracker({ publicKey: 'pk_test' });
    });

    it('uses sendBeacon for small payloads without screenshots', async function () {
      navigator.sendBeacon.returns(true);
      await tracker._sendError({ type: 'Error', message: 'small' });
      expect(navigator.sendBeacon.calledOnce).to.be.true;
    });

    it('falls back to fetch when sendBeacon returns false', async function () {
      navigator.sendBeacon.returns(false);
      await tracker._sendError({ type: 'Error', message: 'small' });
      expect(fetch.calledOnce).to.be.true;
    });

    it('uses fetch for payloads with screenshots', async function () {
      await tracker._sendError({ type: 'Error', message: 'test', screenshot: 'data:image/png;base64,...' });
      expect(fetch.calledOnce).to.be.true;
    });

    it('queues error on fetch failure', async function () {
      navigator.sendBeacon.returns(false);
      fetch.rejects(new Error('network down'));

      await tracker._sendError({ type: 'Error', message: 'test' });
      expect(tracker.errorQueue).to.have.lengthOf(1);
    });

    it('queues error on non-ok response', async function () {
      navigator.sendBeacon.returns(false);
      fetch.resolves({ ok: false, status: 500, statusText: 'Internal Server Error' });

      await tracker._sendError({ type: 'Error', message: 'test' });
      expect(tracker.errorQueue).to.have.lengthOf(1);
    });
  });

  // ==========================================
  // captureError
  // ==========================================
  describe('captureError', function () {

    it('warns and returns when not initialized', async function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      // Not calling init()
      tracker._handleError = sinon.stub().resolves();
      await tracker.captureError(new Error('test'));
      expect(tracker._handleError.called).to.be.false;
    });

    it('captures Error objects with type, message, stack', async function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      tracker.init();
      let captured = null;
      tracker._handleError = async function (error) { captured = error; };

      await tracker.captureError(new TypeError('bad arg'));

      expect(captured.type).to.equal('TypeError');
      expect(captured.message).to.equal('bad arg');
      expect(captured.stack).to.be.a('string');
    });

    it('captures string errors', async function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      tracker.init();
      let captured = null;
      tracker._handleError = async function (error) { captured = error; };

      await tracker.captureError('something went wrong');

      expect(captured.message).to.equal('something went wrong');
    });

    it('merges context into error payload', async function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      tracker.init();
      let captured = null;
      tracker._handleError = async function (error) { captured = error; };

      await tracker.captureError(new Error('test'), { userId: 'u123', component: 'Cart' });

      expect(captured.userId).to.equal('u123');
      expect(captured.component).to.equal('Cart');
    });
  });

  // ==========================================
  // _setupGlobalErrorHandler
  // ==========================================
  describe('_setupGlobalErrorHandler', function () {

    it('registers a window error event listener', function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      global.window.addEventListener.resetHistory();

      tracker._setupGlobalErrorHandler();

      const errorCall = global.window.addEventListener.getCalls().find(c => c.args[0] === 'error');
      expect(errorCall).to.exist;
    });

    it('calls _handleError with error event data', async function () {
      const tracker = new ErrorTracker({ publicKey: 'pk_test' });
      let captured = null;
      tracker._handleError = async function (error) { captured = error; };

      global.window.addEventListener.resetHistory();
      tracker._setupGlobalErrorHandler();

      const errorCall = global.window.addEventListener.getCalls().find(c => c.args[0] === 'error');
      await errorCall.args[1]({
        message: 'Uncaught TypeError',
        error: new TypeError('x is undefined'),
        filename: 'app.js',
        lineno: 42,
        colno: 10
      });

      expect(captured).to.not.be.null;
      expect(captured.type).to.equal('TypeError');
      expect(captured.message).to.equal('Uncaught TypeError');
      expect(captured.filename).to.equal('app.js');
      expect(captured.lineno).to.equal(42);
    });
  });
});
