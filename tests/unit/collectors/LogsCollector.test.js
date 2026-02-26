/**
 * LogsCollector tests — console wrapping, re-entrancy, and serialization.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import LogsCollector from '../../../lib/collectors/LogsCollector.js';
import { createMockClient } from '../../helpers/clientMock.js';

describe('LogsCollector', function () {

  let client;
  let collector;
  let originalConsole;

  beforeEach(function () {
    client = createMockClient();
    // Save original console methods
    originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug
    };
  });

  afterEach(function () {
    if (collector && collector._started) {
      collector.stop();
    }
    // Restore console
    Object.assign(console, originalConsole);
  });

  describe('constructor', function () {

    it('sets default configuration', function () {
      collector = new LogsCollector({ client });
      expect(collector.levels).to.be.an.instanceOf(Set);
      expect(collector.levels.has('info')).to.be.true;
      expect(collector.levels.has('error')).to.be.true;
      expect(collector.levels.has('debug')).to.be.false; // Not in default levels
      expect(collector.sampleRate).to.equal(1.0);
      expect(collector.maxMessageLength).to.equal(10000);
    });
  });

  describe('start / stop', function () {

    it('wraps console methods on start', function () {
      collector = new LogsCollector({ client });
      const origLog = console.log;
      collector.start();
      expect(console.log).to.not.equal(origLog);
    });

    it('restores console methods on stop', function () {
      collector = new LogsCollector({ client });
      const origLog = console.log;
      collector.start();
      collector.stop();
      expect(console.log).to.equal(origLog);
    });

    it('is idempotent (double start/stop)', function () {
      collector = new LogsCollector({ client });
      collector.start();
      collector.start(); // no-op
      expect(collector._started).to.be.true;
      collector.stop();
      collector.stop(); // no-op
      expect(collector._started).to.be.false;
    });
  });

  describe('console wrapping', function () {

    it('calls original console method first', function () {
      const spy = sinon.spy();
      console.log = spy;
      collector = new LogsCollector({ client });
      collector.start();

      console.log('test message');
      expect(spy.calledOnce).to.be.true;
      expect(spy.firstCall.args[0]).to.equal('test message');
    });

    it('captures log and sends to client', function () {
      collector = new LogsCollector({ client });
      collector.start();

      console.log('hello world');

      expect(client.recorded.logs).to.have.lengthOf(1);
      expect(client.recorded.logs[0].message).to.equal('hello world');
      expect(client.recorded.logs[0].level).to.equal('info'); // console.log maps to "info"
      expect(client.recorded.logs[0].source).to.equal('console');
    });

    it('maps console.error to "error" level', function () {
      collector = new LogsCollector({ client });
      collector.start();

      console.error('something failed');

      expect(client.recorded.logs).to.have.lengthOf(1);
      expect(client.recorded.logs[0].level).to.equal('error');
    });

    it('maps console.warn to "warn" level', function () {
      collector = new LogsCollector({ client });
      collector.start();

      console.warn('deprecation warning');

      expect(client.recorded.logs).to.have.lengthOf(1);
      expect(client.recorded.logs[0].level).to.equal('warn');
    });
  });

  describe('re-entrancy guard', function () {

    it('prevents recursive capture when client.addLog triggers console output', function () {
      const recursiveClient = createMockClient();
      let callCount = 0;
      const origAddLog = recursiveClient.addLog;
      recursiveClient.addLog = function (entry) {
        callCount++;
        origAddLog.call(recursiveClient, entry);
        // This console.log inside addLog should NOT trigger another capture
        originalConsole.log.call(console, 'inner log from addLog');
      };

      collector = new LogsCollector({ client: recursiveClient });
      collector.start();

      console.log('trigger');

      // addLog should be called exactly once (no recursion)
      expect(callCount).to.equal(1);
    });
  });

  describe('[SkySignal prefix detection', function () {

    it('skips messages starting with [SkySignal', function () {
      collector = new LogsCollector({ client });
      collector.start();

      console.log('[SkySignal:DDPQueue] internal message');

      expect(client.recorded.logs).to.have.lengthOf(0);
    });

    it('captures messages that do NOT start with [SkySignal', function () {
      collector = new LogsCollector({ client });
      collector.start();

      console.log('regular message');

      expect(client.recorded.logs).to.have.lengthOf(1);
    });
  });

  describe('level filtering', function () {

    it('skips levels not in configured set', function () {
      collector = new LogsCollector({
        client,
        levels: ['error', 'warn'] // Only error and warn
      });
      collector.start();

      console.log('info message');    // console.log → "info" → filtered out
      console.error('error message'); // "error" → captured

      expect(client.recorded.logs).to.have.lengthOf(1);
      expect(client.recorded.logs[0].level).to.equal('error');
    });
  });

  describe('_argToString', function () {

    beforeEach(function () {
      collector = new LogsCollector({ client });
    });

    it('returns "null" for null', function () {
      expect(collector._argToString(null)).to.equal('null');
    });

    it('returns "undefined" for undefined', function () {
      expect(collector._argToString(undefined)).to.equal('undefined');
    });

    it('returns strings as-is', function () {
      expect(collector._argToString('hello')).to.equal('hello');
    });

    it('converts numbers to string', function () {
      expect(collector._argToString(42)).to.equal('42');
    });

    it('converts booleans to string', function () {
      expect(collector._argToString(true)).to.equal('true');
    });

    it('serializes Error instances with name, message, and stack', function () {
      const err = new Error('test');
      const result = collector._argToString(err);
      expect(result).to.include('Error');
      expect(result).to.include('test');
    });

    it('uses JSON.stringify for objects, NOT String()', function () {
      const obj = { key: 'value', num: 42 };
      const result = collector._argToString(obj);
      expect(result).to.equal('{"key":"value","num":42}');
      expect(result).to.not.include('[object Object]');
    });

    it('handles circular objects gracefully', function () {
      const obj = { a: 1 };
      obj.self = obj;
      // Should not throw
      const result = collector._argToString(obj);
      expect(result).to.be.a('string');
    });
  });

  describe('_formatArgs', function () {

    beforeEach(function () {
      collector = new LogsCollector({ client });
    });

    it('returns empty string for no args', function () {
      expect(collector._formatArgs([])).to.equal('');
    });

    it('returns single arg as string', function () {
      expect(collector._formatArgs(['hello'])).to.equal('hello');
    });

    it('joins multiple args with space', function () {
      expect(collector._formatArgs(['hello', 42, true])).to.equal('hello 42 true');
    });

    it('serializes object args in multi-arg calls', function () {
      const result = collector._formatArgs(['message', { a: 1 }]);
      expect(result).to.equal('message {"a":1}');
      expect(result).to.not.include('[object Object]');
    });
  });

  describe('message truncation', function () {

    it('truncates messages longer than maxMessageLength', function () {
      collector = new LogsCollector({ client, maxMessageLength: 50 });
      collector.start();

      console.log('x'.repeat(100));

      expect(client.recorded.logs).to.have.lengthOf(1);
      expect(client.recorded.logs[0].message.length).to.be.at.most(65); // 50 + "...[truncated]"
      expect(client.recorded.logs[0].message).to.include('...[truncated]');
    });
  });

  describe('sampling', function () {

    it('respects sampleRate=0 (drops all)', function () {
      collector = new LogsCollector({ client, sampleRate: 0 });
      collector.start();

      for (let i = 0; i < 100; i++) {
        console.log(`message ${i}`);
      }

      expect(client.recorded.logs).to.have.lengthOf(0);
    });

    it('respects sampleRate=1 (captures all)', function () {
      collector = new LogsCollector({ client, sampleRate: 1.0 });
      collector.start();

      for (let i = 0; i < 10; i++) {
        console.log(`message ${i}`);
      }

      expect(client.recorded.logs).to.have.lengthOf(10);
    });
  });

  // ==========================================
  // _parseMeteorLogArgs
  // ==========================================
  describe('_parseMeteorLogArgs', function () {

    beforeEach(function () {
      collector = new LogsCollector({ client });
    });

    it('returns empty message for no args', function () {
      const result = collector._parseMeteorLogArgs([]);
      expect(result.message).to.equal('');
      expect(result.metadata).to.deep.equal({});
    });

    it('extracts string first arg as message', function () {
      const result = collector._parseMeteorLogArgs(['Hello world']);
      expect(result.message).to.equal('Hello world');
      expect(result.metadata).to.deep.equal({});
    });

    it('extracts message from object with message field', function () {
      const result = collector._parseMeteorLogArgs([{ message: 'Server started', port: 3000 }]);
      expect(result.message).to.equal('Server started');
      expect(result.metadata).to.deep.equal({ port: 3000 });
    });

    it('falls back to _argToString for object without message field', function () {
      const result = collector._parseMeteorLogArgs([{ port: 3000, host: 'localhost' }]);
      expect(result.message).to.include('port');
      expect(result.message).to.include('3000');
      // message is undefined in destructure, so rest = { port, host }
      expect(result.metadata).to.deep.equal({ port: 3000, host: 'localhost' });
    });

    it('handles non-string/non-object first arg', function () {
      const result = collector._parseMeteorLogArgs([42]);
      expect(result.message).to.equal('42');
      expect(result.metadata).to.deep.equal({});
    });

    it('handles null first arg', function () {
      const result = collector._parseMeteorLogArgs([null]);
      expect(result.message).to.equal('null');
    });
  });

  // ==========================================
  // _getMethodContext
  // ==========================================
  describe('_getMethodContext', function () {

    beforeEach(function () {
      collector = new LogsCollector({ client });
    });

    afterEach(function () {
      delete global.SkySignalTracer;
    });

    it('returns empty object when no tracer', function () {
      delete global.SkySignalTracer;
      expect(collector._getMethodContext()).to.deep.equal({});
    });

    it('returns empty object when tracer has no current context', function () {
      global.SkySignalTracer = { getCurrentContext: () => null };
      expect(collector._getMethodContext()).to.deep.equal({});
    });

    it('extracts method context fields from active tracer', function () {
      global.SkySignalTracer = {
        getCurrentContext: () => ({
          methodName: 'users.find',
          traceId: 'trace-abc',
          userId: 'user-123',
          sessionId: 'sess-456',
          extraField: 'ignored'
        })
      };

      const ctx = collector._getMethodContext();
      expect(ctx.methodName).to.equal('users.find');
      expect(ctx.traceId).to.equal('trace-abc');
      expect(ctx.userId).to.equal('user-123');
      expect(ctx.sessionId).to.equal('sess-456');
      expect(ctx).to.not.have.property('extraField');
    });
  });

  // ==========================================
  // _captureLog (method context and metadata)
  // ==========================================
  describe('_captureLog metadata', function () {

    beforeEach(function () {
      collector = new LogsCollector({ client });
    });

    afterEach(function () {
      delete global.SkySignalTracer;
    });

    it('includes method context fields in log entry', function () {
      global.SkySignalTracer = {
        getCurrentContext: () => ({
          methodName: 'orders.create',
          traceId: 'tr-1',
          userId: 'u-1',
          sessionId: 's-1'
        })
      };

      collector._captureLog('info', 'Order created', 'console');

      expect(client.recorded.logs).to.have.lengthOf(1);
      const entry = client.recorded.logs[0];
      expect(entry.methodName).to.equal('orders.create');
      expect(entry.traceId).to.equal('tr-1');
    });

    it('includes metadata when non-empty', function () {
      collector._captureLog('info', 'test', 'meteor-log', { port: 3000 });

      const entry = client.recorded.logs[0];
      expect(entry.metadata).to.deep.equal({ port: 3000 });
    });

    it('omits metadata when empty', function () {
      collector._captureLog('info', 'test', 'console', {});

      const entry = client.recorded.logs[0];
      expect(entry).to.not.have.property('metadata');
    });

    it('resets _isCapturing flag even on error', function () {
      // Make addLog throw
      client.addLog = sinon.stub().throws(new Error('boom'));

      expect(() => collector._captureLog('info', 'test', 'console')).to.throw();
      // Flag should be reset
      expect(collector._isCapturing).to.be.false;
    });
  });

  // ==========================================
  // captureConsole / captureMeteorLog false options
  // ==========================================
  describe('start with disabled options', function () {

    it('does not wrap console when captureConsole=false', function () {
      const origLog = console.log;
      collector = new LogsCollector({ client, captureConsole: false });
      collector.start();
      // console.log should still be the original
      expect(console.log).to.equal(origLog);
      collector.stop();
    });

    it('does not wrap Meteor Log when captureMeteorLog=false', function () {
      collector = new LogsCollector({ client, captureMeteorLog: false });
      // _wrapMeteorLog should not be called; no errors
      expect(() => collector.start()).to.not.throw();
      collector.stop();
    });
  });
});
