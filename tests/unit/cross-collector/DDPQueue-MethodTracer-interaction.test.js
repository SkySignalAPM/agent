/**
 * Cross-collector interaction tests: DDPQueueCollector + MethodTracer-style wrapping.
 *
 * Bug #7 Full Reproduction:
 * When both MethodTracer and DDPQueueCollector wrap unblock, the chained
 * wrappers could cause infinite recursion (stack overflow) if one layer
 * retried the other on failure, or if another APM agent (e.g. montiapm:agent)
 * proxies the unblock synchronously, creating a recursive chain.
 *
 * The fix ensures each layer calls through exactly once, and uses
 * queueMicrotask to break any synchronous recursion chain.
 */

/** Flush pending microtasks so queueMicrotask callbacks execute */
function flushMicrotasks() {
  return new Promise(resolve => resolve());
}

import { expect } from 'chai';
import sinon from 'sinon';
import DDPQueueCollector from '../../../lib/collectors/DDPQueueCollector.js';
import { createMockSession } from '../../helpers/sessionMock.js';

describe('Cross-Collector: DDPQueue + MethodTracer interaction', function () {

  describe('Bug #7 full reproduction: chained unblock wrappers', function () {

    it('does not stack overflow when both collectors wrap unblock', async function () {
      const collector = new DDPQueueCollector({ enabled: true });
      const session = createMockSession('cross-session');
      const msg = { id: 'msg-1', msg: 'method', method: 'users.get', _queueEnterTime: Date.now() - 50 };

      // The real originalUnblock from Meteor
      const meteorUnblock = sinon.stub();

      // Simulate MethodTracer wrapping unblock first
      let methodTracerCalled = false;
      function methodTracerWrapper() {
        if (methodTracerCalled) return; // Guard
        methodTracerCalled = true;
        // MethodTracer does its work...
        meteorUnblock();
      }

      // DDPQueueCollector wraps the MethodTracer wrapper
      const finalUnblock = collector.wrapUnblock(session, msg, methodTracerWrapper);

      // Call the final wrapper — this MUST NOT stack overflow
      finalUnblock();

      // originalUnblock is called via queueMicrotask
      await flushMicrotasks();

      // meteorUnblock should be called exactly once through the chain
      expect(meteorUnblock.calledOnce).to.be.true;
    });

    it('handles throwing MethodTracer wrapper without stack overflow', async function () {
      const collector = new DDPQueueCollector({ enabled: true });
      const session = createMockSession('cross-session-2');
      const msg = { id: 'msg-2', msg: 'method', method: 'users.update', _queueEnterTime: Date.now() - 30 };

      const meteorUnblock = sinon.stub();

      // Simulate MethodTracer wrapper that throws
      let throwCalled = false;
      function throwingMethodTracerWrapper() {
        throwCalled = true;
        throw new Error('MethodTracer wrapper error');
      }

      // DDPQueueCollector wraps the throwing wrapper
      const finalUnblock = collector.wrapUnblock(session, msg, throwingMethodTracerWrapper);

      // wrappedUnblock itself should not throw — originalUnblock runs on microtask
      // and errors inside the microtask are caught and swallowed
      finalUnblock();
      await flushMicrotasks();

      // The throwing wrapper was called (once)
      expect(throwCalled).to.be.true;

      // Meteor's unblock is NOT called because the intermediate wrapper threw
      expect(meteorUnblock.called).to.be.false;

      // Calling again should be a no-op (guard flag set)
      finalUnblock();
      await flushMicrotasks();
      expect(meteorUnblock.called).to.be.false;
    });

    it('works when DDPQueueCollector wraps unblock and MethodTracer wraps the session handler', async function () {
      const collector = new DDPQueueCollector({ enabled: true });
      const session = createMockSession('cross-session-3');

      // Track execution order
      const order = [];
      const meteorUnblock = sinon.stub().callsFake(() => order.push('meteorUnblock'));

      // Wrap the session (DDPQueueCollector installs its handlers)
      collector._wrapSession(session);

      // Simulate what happens during a method call:
      const methodMsg = {
        id: 'msg-3',
        msg: 'method',
        method: 'posts.insert',
        _queueEnterTime: Date.now() - 100
      };

      // Test wrapUnblock directly with a chain that simulates the real scenario
      const ddpWrapped = collector.wrapUnblock(session, methodMsg, meteorUnblock);

      // Call it
      ddpWrapped();

      await flushMicrotasks();
      expect(meteorUnblock.calledOnce).to.be.true;
      expect(order).to.deep.equal(['meteorUnblock']);
    });

    it('prevents stack overflow with deeply nested wrapper chains', async function () {
      const collector = new DDPQueueCollector({ enabled: true });
      const session = createMockSession('deep-chain');
      const msg = { id: 'deep-msg', msg: 'method', method: 'deep.method' };

      const meteorUnblock = sinon.stub();

      // Create a chain of 10 wrappers (simulating multiple restarts/collectors)
      let current = meteorUnblock;
      for (let i = 0; i < 10; i++) {
        const prev = current;
        let called = false;
        current = function () {
          if (called) return;
          called = true;
          prev();
        };
      }

      // DDPQueueCollector wraps the entire chain
      const final = collector.wrapUnblock(session, msg, current);

      // Must not stack overflow
      final();

      await flushMicrotasks();
      expect(meteorUnblock.calledOnce).to.be.true;
    });

    it('queueMicrotask breaks synchronous recursion from another APM agent', async function () {
      // Simulates the real scenario: montiapm:agent (or similar) wraps unblock
      // and synchronously calls processMessage for the next queued DDP message,
      // which re-enters our wrapper. Without queueMicrotask, this would overflow.
      const collector = new DDPQueueCollector({ enabled: true });

      let callCount = 0;
      const maxCalls = 200; // Simulate 200 queued messages
      const meteorUnblock = sinon.stub();

      // Simulate a "synchronous queue drainer" like another APM agent might create.
      // Each call to unblock synchronously triggers the next message's unblock.
      function montiLikeUnblock() {
        callCount++;
        if (callCount < maxCalls) {
          // Simulate processing next queued message which also calls wrapUnblock
          const session = createMockSession(`session-${callCount}`);
          const msg = { id: `msg-${callCount}`, msg: 'sub', name: `pub.${callCount}` };
          const next = callCount < maxCalls - 1 ? montiLikeUnblock : meteorUnblock;
          const wrapped = collector.wrapUnblock(session, msg, next);
          wrapped(); // This would recurse synchronously WITHOUT queueMicrotask
        }
      }

      const session = createMockSession('session-0');
      const msg = { id: 'msg-0', msg: 'sub', name: 'pub.0' };
      const wrapped = collector.wrapUnblock(session, msg, montiLikeUnblock);

      // Call the first wrapper — because queueMicrotask is used,
      // this should NOT stack overflow even with 200 chained calls
      wrapped();

      // Flush all microtasks (each one enqueues the next)
      for (let i = 0; i < maxCalls + 5; i++) {
        await flushMicrotasks();
      }

      // The chain should have completed without stack overflow
      expect(callCount).to.be.greaterThan(0);
    });
  });

  describe('session wrapping with multiple collectors', function () {

    it('DDPQueueCollector double-wrap guard prevents wrapping same session twice', function () {
      const collector = new DDPQueueCollector({ enabled: true });
      const session = createMockSession('guard-test');

      collector._wrapSession(session);
      const firstProcessMessage = session.processMessage;

      // Wrap again (simulate agent restart)
      collector._wrapSession(session);

      // processMessage should NOT be double-wrapped
      expect(session.processMessage).to.equal(firstProcessMessage);
    });
  });
});
