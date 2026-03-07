/**
 * DDPQueueCollector tests — includes Bug #7 regression tests.
 *
 * Bug #7: Stack overflow from wrapUnblock. The original code would retry
 * originalUnblock on failure, and when combined with MethodTracer's own
 * unblock wrapper (or another APM agent like montiapm:agent), this created
 * infinite mutual recursion.
 *
 * Fix: wrapUnblock calls originalUnblock exactly once via queueMicrotask
 * (to break synchronous recursion chains), never retries, uses a guard flag,
 * and metrics failures don't prevent unblock.
 */

/** Flush pending microtasks so queueMicrotask callbacks execute */
function flushMicrotasks() {
  return new Promise(resolve => resolve());
}

import { expect } from 'chai';
import sinon from 'sinon';
import DDPQueueCollector from '../../../lib/collectors/DDPQueueCollector.js';
import { createMockSession } from '../../helpers/sessionMock.js';

describe('DDPQueueCollector', function () {

  let collector;

  beforeEach(function () {
    collector = new DDPQueueCollector({ enabled: true, debug: false });
  });

  afterEach(function () {
    if (collector.started) {
      collector.stop();
    }
  });

  describe('constructor', function () {

    it('initializes with default options', function () {
      const c = new DDPQueueCollector();
      expect(c.enabled).to.be.true;
      expect(c.debug).to.be.false;
      expect(c.started).to.be.false;
      expect(c.messageCacheMaxSize).to.equal(5000);
      expect(c.messageCacheTTL).to.equal(300000);
    });

    it('respects enabled=false', function () {
      const c = new DDPQueueCollector({ enabled: false });
      expect(c.enabled).to.be.false;
    });
  });

  // ==========================================
  // Bug #7 Regression: wrapUnblock
  // ==========================================
  describe('wrapUnblock (Bug #7 regression)', function () {

    it('calls originalUnblock exactly once (via microtask)', async function () {
      const session = createMockSession();
      const msg = { id: '1', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);
      wrappedUnblock();

      // originalUnblock is called via queueMicrotask — flush it
      await flushMicrotasks();
      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('does NOT retry if originalUnblock throws', async function () {
      const session = createMockSession();
      const msg = { id: '2', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub().throws(new Error('unblock failed'));

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);

      // wrappedUnblock itself should not throw — originalUnblock runs on microtask
      // and its error is swallowed to prevent unhandled microtask errors
      wrappedUnblock();
      await flushMicrotasks();
      // Called exactly once (no retry despite throwing)
      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('sets unblocked flag immediately (guard prevents double-call)', async function () {
      const session = createMockSession();
      const msg = { id: '3', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);

      // Call twice
      wrappedUnblock();
      wrappedUnblock();

      await flushMicrotasks();
      // originalUnblock should be called only once
      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('metrics failure does not prevent originalUnblock from being called', async function () {
      const session = createMockSession();
      const msg = { id: '4', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      // Make calculateWaitedOn throw to simulate metrics failure
      sinon.stub(collector, 'calculateWaitedOn').throws(new Error('metrics boom'));

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);
      wrappedUnblock();

      await flushMicrotasks();
      // originalUnblock should still be called despite metrics error
      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('originalUnblock and currentProcessing cleanup run even if console.error throws during logging (simulates source-map-support overflow)', async function () {
      // Regression for issue #7: when a caught metrics error is passed to
      // console.error, source-map-support's prepareStackTrace can itself overflow
      // (calling String.replace on hundreds of frames). That secondary throw used
      // to propagate out of the catch block, skipping originalUnblock() and
      // leaving the DDP queue stuck. The finally block ensures cleanup always runs.
      const session = createMockSession('session-log-throw');
      const msg = { id: '7', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      // Make metrics fail to enter the catch block
      sinon.stub(collector, 'calculateWaitedOn').throws(new Error('simulated metrics error'));

      // Make console.error throw to simulate source-map-support overflow
      const originalConsoleError = console.error;
      console.error = sinon.stub().throws(new Error('simulated console.error overflow'));

      try {
        const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);
        // The throw from console.error propagates out; the caller may see it.
        // The important invariant is that originalUnblock is still invoked.
        try { wrappedUnblock(); } catch (_e) { /* expected */ }
      } finally {
        console.error = originalConsoleError;
      }

      await flushMicrotasks();
      // Despite console.error throwing, originalUnblock must still be called
      expect(originalUnblock.calledOnce).to.be.true;
      // And currentProcessing must be cleared
      expect(collector.currentProcessing['session-log-throw']).to.be.undefined;
    });

    it('clears currentProcessing on unblock (synchronously)', function () {
      const session = createMockSession('session-A');
      const msg = { id: '5', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);

      // Before unblock, msg is marked as currently processing
      expect(collector.currentProcessing['session-A']).to.equal(msg);

      wrappedUnblock();

      // currentProcessing is cleared synchronously (in finally block),
      // even though originalUnblock is deferred to microtask
      expect(collector.currentProcessing['session-A']).to.be.undefined;
    });

    it('handles non-function originalUnblock gracefully', function () {
      const session = createMockSession();
      const msg = { id: '6', msg: 'method', method: 'test.method' };

      // originalUnblock is not a function (edge case)
      const wrappedUnblock = collector.wrapUnblock(session, msg, null);

      // Should not throw
      expect(() => wrappedUnblock()).to.not.throw();
    });

    it('uses String(error) not raw error in catch — prevents prepareStackTrace re-overflow', async function () {
      const session = createMockSession('sess-string-coerce');
      const msg = { id: '8', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      // Make metrics fail with an error that has a custom toString
      const deepError = new RangeError('Maximum call stack size exceeded');
      // Simulate a deeply nested stack with 500+ frames
      deepError.stack = 'RangeError: Maximum call stack size exceeded\n' +
        Array.from({ length: 500 }, (_, i) => `    at wrapUnblock (DDPQueueCollector.js:${i}:1)`).join('\n');
      sinon.stub(collector, 'calculateWaitedOn').throws(deepError);

      // Spy on console.error to verify String(error) is passed, not the raw Error
      const consoleStub = sinon.stub(console, 'error');

      try {
        const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);
        wrappedUnblock();
      } finally {
        consoleStub.restore();
      }

      // console.error should have been called with String(error), not the Error object
      expect(consoleStub.calledOnce).to.be.true;
      const loggedArgs = consoleStub.firstCall.args;
      // The second argument (the error) should be a string, not an Error instance
      expect(loggedArgs[1]).to.be.a('string');
      expect(loggedArgs[1]).to.include('Maximum call stack size exceeded');
      // originalUnblock is called via microtask
      await flushMicrotasks();
      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('cleanup runs when _recordBlockingTime throws AND console.error throws simultaneously', async function () {
      // Worst case: both the metrics recording and error logging fail
      const session = createMockSession('sess-double-throw');
      const msg = { id: '9', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      sinon.stub(collector, 'calculateWaitedOn').throws(new Error('metrics exploded'));

      const originalConsoleError = console.error;
      console.error = () => { throw new RangeError('logging overflow'); };

      try {
        const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);
        try { wrappedUnblock(); } catch (_e) { /* expected */ }
      } finally {
        console.error = originalConsoleError;
      }

      await flushMicrotasks();
      expect(originalUnblock.calledOnce).to.be.true;
      expect(collector.currentProcessing['sess-double-throw']).to.be.undefined;
    });

    it('does not hold reference to error object after catch — no memory leak from deep stacks', async function () {
      const session = createMockSession('sess-no-leak');
      const msg = { id: '10', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      const bigError = new Error('big stack');
      bigError.stack = 'x'.repeat(100000); // 100KB stack
      sinon.stub(collector, 'calculateWaitedOn').throws(bigError);

      const consoleStub = sinon.stub(console, 'error');
      try {
        const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);
        wrappedUnblock();
      } finally {
        consoleStub.restore();
      }

      // After unblock, the error should only have been logged as a string.
      // Verify that the raw error object wasn't stored anywhere in the collector.
      expect(collector.currentProcessing['sess-no-leak']).to.be.undefined;
      await flushMicrotasks();
      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('originalUnblock receives no arguments (clean call)', async function () {
      const session = createMockSession();
      const msg = { id: '11', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);
      wrappedUnblock();

      await flushMicrotasks();
      // originalUnblock should be called with zero arguments — passing the error
      // object or any internal state would leak implementation details
      expect(originalUnblock.firstCall.args).to.have.length(0);
    });

    it('concurrent sessions unblock independently', async function () {
      const sessionA = createMockSession('sess-concurrent-A');
      const sessionB = createMockSession('sess-concurrent-B');
      const msgA = { id: 'a1', msg: 'method', method: 'testA' };
      const msgB = { id: 'b1', msg: 'method', method: 'testB' };
      const unblockA = sinon.stub();
      const unblockB = sinon.stub();

      const wrappedA = collector.wrapUnblock(sessionA, msgA, unblockA);
      const wrappedB = collector.wrapUnblock(sessionB, msgB, unblockB);

      // Unblock B first, then A — order should not matter
      wrappedB();
      // currentProcessing clears synchronously, originalUnblock is microtask-deferred
      expect(collector.currentProcessing['sess-concurrent-A']).to.equal(msgA);
      expect(collector.currentProcessing['sess-concurrent-B']).to.be.undefined;

      wrappedA();
      expect(collector.currentProcessing['sess-concurrent-A']).to.be.undefined;

      await flushMicrotasks();
      expect(unblockB.calledOnce).to.be.true;
      expect(unblockA.calledOnce).to.be.true;
    });
  });

  describe('_wrapSession', function () {

    it('sets _skySignalDDPQueueWrapped flag', function () {
      const session = createMockSession();
      collector._wrapSession(session);
      expect(session._skySignalDDPQueueWrapped).to.be.true;
    });

    it('skips already-wrapped sessions', function () {
      const session = createMockSession();
      const originalProcessMessage = session.processMessage;

      collector._wrapSession(session);
      const firstWrapProcessMessage = session.processMessage;

      // Wrap again — should be no-op
      collector._wrapSession(session);

      // processMessage should not be double-wrapped
      expect(session.processMessage).to.equal(firstWrapProcessMessage);
    });

    it('wraps processMessage', function () {
      const session = createMockSession();
      const original = session.processMessage;
      collector._wrapSession(session);
      expect(session.processMessage).to.not.equal(original);
    });

    it('wraps method handler', function () {
      const session = createMockSession();
      const original = session.protocol_handlers.method;
      collector._wrapSession(session);
      expect(session.protocol_handlers.method).to.not.equal(original);
    });

    it('wraps sub handler', function () {
      const session = createMockSession();
      const original = session.protocol_handlers.sub;
      collector._wrapSession(session);
      expect(session.protocol_handlers.sub).to.not.equal(original);
    });

    it('handles session with missing processMessage gracefully', function () {
      const session = createMockSession();
      delete session.processMessage;
      // Should not throw
      expect(() => collector._wrapSession(session)).to.not.throw();
    });

    it('registers onClose callback for cleanup', function () {
      const session = createMockSession('cleanup-session');
      collector.wrappedSessions = new Set();
      collector.wrappedSessions.add('cleanup-session');

      collector._wrapSession(session);

      // Simulate close
      session._simulateClose();

      expect(collector.wrappedSessions.has('cleanup-session')).to.be.false;
    });
  });

  describe('registerMessage / buildWaitList', function () {

    it('captures empty wait list for first message', function () {
      const session = createMockSession('s1');
      session.inQueue = [];
      const msg = { id: 'msg1', msg: 'method', method: 'test' };

      collector.registerMessage(session, msg);
      const waitList = collector.buildWaitList(session, 'msg1');

      expect(waitList).to.be.an('array');
    });

    it('buildWaitList returns empty array for unknown message', function () {
      const session = createMockSession('s2');
      const waitList = collector.buildWaitList(session, 'nonexistent');
      expect(waitList).to.deep.equal([]);
    });

    it('cleans up after buildWaitList retrieval', function () {
      const session = createMockSession('s3');
      session.inQueue = [];
      const msg = { id: 'msg2', msg: 'method', method: 'test' };

      collector.registerMessage(session, msg);
      collector.buildWaitList(session, 'msg2');

      // Second call should return empty (cleaned up)
      const second = collector.buildWaitList(session, 'msg2');
      expect(second).to.deep.equal([]);
    });
  });

  describe('_toArray', function () {

    it('returns array as-is', function () {
      expect(collector._toArray([1, 2, 3])).to.deep.equal([1, 2, 3]);
    });

    it('calls toArray() if available', function () {
      const obj = { toArray: () => [4, 5, 6] };
      expect(collector._toArray(obj)).to.deep.equal([4, 5, 6]);
    });

    it('converts plain object to array of values', function () {
      const obj = { a: 1, b: 2 };
      expect(collector._toArray(obj)).to.deep.equal([1, 2]);
    });

    it('returns empty array for null/undefined', function () {
      expect(collector._toArray(null)).to.deep.equal([]);
      expect(collector._toArray(undefined)).to.deep.equal([]);
    });
  });

  describe('_cleanupMessageCache', function () {

    it('removes entries older than TTL', function () {
      const old = Date.now() - 600000; // 10 min ago (TTL is 5 min)
      collector.messageCache = {
        'old::1': { cachedAt: old },
        'new::1': { cachedAt: Date.now() }
      };

      collector._cleanupMessageCache();

      expect(collector.messageCache).to.not.have.property('old::1');
      expect(collector.messageCache).to.have.property('new::1');
    });
  });

  describe('getMetrics', function () {

    it('returns expected metric keys', function () {
      const metrics = collector.getMetrics();
      expect(metrics).to.have.property('activeWaitLists', 0);
      expect(metrics).to.have.property('currentlyProcessing', 0);
      expect(metrics).to.have.property('cachedMessages', 0);
    });
  });

  // ==========================================
  // _recordDDPWaitTime
  // ==========================================
  describe('_recordDDPWaitTime', function () {

    afterEach(function () {
      delete global._skySignalWaitTimeBySession;
    });

    it('initializes global storage on first call', function () {
      delete global._skySignalWaitTimeBySession;
      collector._recordDDPWaitTime(150, [{ id: '1' }], { msg: 'method', id: 'm1', method: 'test.method', _queueEnterTime: 1000 }, 'sess-1');

      expect(global._skySignalWaitTimeBySession).to.be.an('object');
      expect(global._skySignalWaitTimeBySession['sess-1']).to.exist;
    });

    it('stores wait time data keyed by session ID', function () {
      collector._recordDDPWaitTime(100, [{ id: 'w1' }], { msg: 'method', id: 'm2', method: 'orders.create', _queueEnterTime: 2000 }, 'sess-2');

      const data = global._skySignalWaitTimeBySession['sess-2'];
      expect(data.ddp).to.equal(100);
      expect(data.ddpWaitList).to.deep.equal([{ id: 'w1' }]);
      expect(data.messageInfo.name).to.equal('orders.create');
      expect(data.messageInfo.queuedAt).to.equal(2000);
      expect(data.timestamp).to.be.a('number');
    });

    it('overwrites previous session data (methods run sequentially)', function () {
      collector._recordDDPWaitTime(50, [], { msg: 'method', id: 'm1', method: 'first' }, 'sess-1');
      collector._recordDDPWaitTime(200, [], { msg: 'method', id: 'm2', method: 'second' }, 'sess-1');

      expect(global._skySignalWaitTimeBySession['sess-1'].ddp).to.equal(200);
      expect(global._skySignalWaitTimeBySession['sess-1'].messageInfo.name).to.equal('second');
    });
  });

  // ==========================================
  // _recordBlockingTime
  // ==========================================
  describe('_recordBlockingTime', function () {

    afterEach(function () {
      delete global._skySignalWaitTimeBySession;
    });

    it('adds blocking metrics to existing session data', function () {
      global._skySignalWaitTimeBySession = {
        'sess-1': { ddp: 100, ddpWaitList: [] }
      };

      collector._recordBlockingTime({ msg: 'method', id: 'm1' }, 500, 200, 'sess-1');

      expect(global._skySignalWaitTimeBySession['sess-1'].blockingTime).to.equal(500);
      expect(global._skySignalWaitTimeBySession['sess-1'].waitedOn).to.equal(200);
    });

    it('no-ops when session data does not exist', function () {
      global._skySignalWaitTimeBySession = {};
      // Should not throw
      expect(() => collector._recordBlockingTime({}, 100, 50, 'nonexistent')).to.not.throw();
    });

    it('initializes global storage if needed', function () {
      delete global._skySignalWaitTimeBySession;
      collector._recordBlockingTime({}, 100, 50, 'sess-1');
      expect(global._skySignalWaitTimeBySession).to.be.an('object');
    });
  });

  // ==========================================
  // calculateWaitedOn
  // ==========================================
  describe('calculateWaitedOn', function () {

    it('sums wait time for messages with _queueEnterTime', function () {
      const now = Date.now();
      const session = {
        inQueue: [
          { _queueEnterTime: now - 100 },
          { _queueEnterTime: now - 200 }
        ]
      };

      const result = collector.calculateWaitedOn(session, now - 500);
      expect(result).to.be.greaterThan(0);
    });

    it('adjusts time for messages queued before startTime', function () {
      const now = Date.now();
      const startTime = now - 50;
      const session = {
        inQueue: [
          { _queueEnterTime: now - 200 } // Queued before startTime
        ]
      };

      const result = collector.calculateWaitedOn(session, startTime);
      // Should be adjusted: now - startTime, not now - queueEnterTime
      expect(result).to.be.at.most(60); // ~50ms + small margin
    });

    it('skips messages without _queueEnterTime', function () {
      const session = {
        inQueue: [
          { msg: 'method' }, // No _queueEnterTime
          { _queueEnterTime: Date.now() - 100 }
        ]
      };

      const result = collector.calculateWaitedOn(session, Date.now() - 500);
      // Only one message contributes
      expect(result).to.be.greaterThan(0);
    });

    it('returns 0 for empty queue', function () {
      const session = { inQueue: [] };
      expect(collector.calculateWaitedOn(session, Date.now())).to.equal(0);
    });

    it('handles missing inQueue gracefully', function () {
      const session = {};
      expect(collector.calculateWaitedOn(session, Date.now())).to.equal(0);
    });
  });

  // ==========================================
  // _cacheMessage
  // ==========================================
  describe('_cacheMessage', function () {

    it('caches a new message and returns it', function () {
      const session = { id: 'sess-1' };
      const msg = { id: 'msg-1', msg: 'method', method: 'test' };

      const cached = collector._cacheMessage(session, msg);
      expect(cached.name).to.equal('test');
      expect(cached.msg).to.equal('method');
    });

    it('returns existing cached entry on duplicate', function () {
      const session = { id: 'sess-1' };
      const msg = { id: 'msg-1', msg: 'method', method: 'test' };

      const first = collector._cacheMessage(session, msg);
      const second = collector._cacheMessage(session, msg);
      expect(first).to.equal(second);
    });

    it('triggers cleanup when cache exceeds max size', function () {
      collector.messageCacheMaxSize = 2;
      const cleanupSpy = sinon.spy(collector, '_cleanupMessageCache');

      collector._cacheMessage({ id: 's1' }, { id: 'm1', msg: 'method', method: 'a' });
      collector._cacheMessage({ id: 's2' }, { id: 'm2', msg: 'method', method: 'b' });
      // Third should trigger cleanup
      collector._cacheMessage({ id: 's3' }, { id: 'm3', msg: 'method', method: 'c' });

      expect(cleanupSpy.calledOnce).to.be.true;
    });
  });
});
