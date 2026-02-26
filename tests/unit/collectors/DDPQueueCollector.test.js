/**
 * DDPQueueCollector tests — includes Bug #7 regression tests.
 *
 * Bug #7: Stack overflow from wrapUnblock. The original code would retry
 * originalUnblock on failure, and when combined with MethodTracer's own
 * unblock wrapper, this created infinite mutual recursion.
 *
 * Fix: wrapUnblock calls originalUnblock exactly once, never retries,
 * uses a guard flag, and metrics failures don't prevent unblock.
 */

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

    it('calls originalUnblock exactly once', function () {
      const session = createMockSession();
      const msg = { id: '1', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);
      wrappedUnblock();

      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('does NOT retry if originalUnblock throws', function () {
      const session = createMockSession();
      const msg = { id: '2', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub().throws(new Error('unblock failed'));

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);

      // Should throw the error from originalUnblock, but only call it once
      expect(() => wrappedUnblock()).to.throw('unblock failed');
      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('sets unblocked flag immediately (guard prevents double-call)', function () {
      const session = createMockSession();
      const msg = { id: '3', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);

      // Call twice
      wrappedUnblock();
      wrappedUnblock();

      // originalUnblock should be called only once
      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('metrics failure does not prevent originalUnblock from being called', function () {
      const session = createMockSession();
      const msg = { id: '4', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      // Make calculateWaitedOn throw to simulate metrics failure
      sinon.stub(collector, 'calculateWaitedOn').throws(new Error('metrics boom'));

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);
      wrappedUnblock();

      // originalUnblock should still be called despite metrics error
      expect(originalUnblock.calledOnce).to.be.true;
    });

    it('clears currentProcessing on unblock', function () {
      const session = createMockSession('session-A');
      const msg = { id: '5', msg: 'method', method: 'test.method' };
      const originalUnblock = sinon.stub();

      const wrappedUnblock = collector.wrapUnblock(session, msg, originalUnblock);

      // Before unblock, msg is marked as currently processing
      expect(collector.currentProcessing['session-A']).to.equal(msg);

      wrappedUnblock();

      // After unblock, cleared
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
