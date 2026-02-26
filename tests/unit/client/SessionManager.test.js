/**
 * SessionManager tests — session persistence, expiry, and activity tracking.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { setupBrowserMocks, teardownBrowserMocks } from '../../helpers/browserMock.js';
import SessionManager from '../../../client/SessionManager.js';

describe('SessionManager', function () {

  before(function () {
    setupBrowserMocks();
  });

  after(function () {
    teardownBrowserMocks();
  });

  beforeEach(function () {
    // Clear localStorage between tests
    global.localStorage.clear();
  });

  // ==========================================
  // constructor / _getOrCreateSession
  // ==========================================
  describe('constructor', function () {

    it('creates a session ID on first construction', function () {
      const mgr = new SessionManager();
      expect(mgr.getSessionId()).to.be.a('string');
      expect(mgr.getSessionId().length).to.be.greaterThan(5);
    });

    it('generates session ID in timestamp-random format', function () {
      const mgr = new SessionManager();
      const id = mgr.getSessionId();
      const parts = id.split('-');
      // First part should be a numeric timestamp
      expect(Number(parts[0])).to.be.a('number');
      expect(Number(parts[0])).to.be.greaterThan(0);
    });

    it('persists session to localStorage', function () {
      const mgr = new SessionManager();
      const stored = JSON.parse(global.localStorage.getItem('_skysignal_session'));
      expect(stored.sessionId).to.equal(mgr.getSessionId());
      expect(stored.timestamp).to.be.a('number');
    });

    it('reuses existing session if not expired', function () {
      // Create first session
      const mgr1 = new SessionManager();
      const id1 = mgr1.getSessionId();

      // Create second session — should reuse the same ID
      const mgr2 = new SessionManager();
      expect(mgr2.getSessionId()).to.equal(id1);
    });

    it('creates new session if existing one is expired', function () {
      // Store an expired session (31 minutes ago)
      const expiredTimestamp = Date.now() - 31 * 60 * 1000;
      global.localStorage.setItem('_skysignal_session', JSON.stringify({
        sessionId: 'old-session',
        timestamp: expiredTimestamp
      }));

      const mgr = new SessionManager();
      expect(mgr.getSessionId()).to.not.equal('old-session');
    });

    it('creates new session if localStorage data is corrupted', function () {
      global.localStorage.setItem('_skysignal_session', 'invalid-json');
      const mgr = new SessionManager();
      expect(mgr.getSessionId()).to.be.a('string');
      expect(mgr.getSessionId().length).to.be.greaterThan(5);
    });

    it('sets sessionStart to current date', function () {
      const before = new Date();
      const mgr = new SessionManager();
      const after = new Date();
      expect(mgr.getSessionStart()).to.be.an.instanceOf(Date);
      expect(mgr.getSessionStart().getTime()).to.be.at.least(before.getTime());
      expect(mgr.getSessionStart().getTime()).to.be.at.most(after.getTime());
    });
  });

  // ==========================================
  // _generateSessionId
  // ==========================================
  describe('_generateSessionId', function () {

    it('returns string in timestamp-random format', function () {
      const mgr = new SessionManager();
      const id = mgr._generateSessionId();
      const parts = id.split('-');
      expect(parts.length).to.equal(2);
      // First part is numeric timestamp
      expect(Number(parts[0])).to.be.greaterThan(1000000000000);
      // Second part is alphanumeric random string
      expect(parts[1]).to.match(/^[a-z0-9]+$/);
      expect(parts[1].length).to.be.at.most(9);
    });

    it('generates unique IDs on successive calls', function () {
      const mgr = new SessionManager();
      const ids = new Set();
      for (let i = 0; i < 20; i++) {
        ids.add(mgr._generateSessionId());
      }
      // All should be unique (extremely high probability)
      expect(ids.size).to.equal(20);
    });
  });

  // ==========================================
  // _persistSession
  // ==========================================
  describe('_persistSession', function () {

    it('writes sessionId and timestamp to localStorage', function () {
      const mgr = new SessionManager();
      global.localStorage.clear();

      mgr._persistSession('test-session-123');

      const stored = JSON.parse(global.localStorage.getItem('_skysignal_session'));
      expect(stored.sessionId).to.equal('test-session-123');
      expect(stored.timestamp).to.be.a('number');
      expect(stored.timestamp).to.be.closeTo(Date.now(), 100);
    });

    it('silently handles localStorage.setItem failure', function () {
      const mgr = new SessionManager();
      const origSetItem = global.localStorage.setItem;
      global.localStorage.setItem = sinon.stub().throws(new Error('QuotaExceeded'));

      // Should not throw
      expect(() => mgr._persistSession('test')).to.not.throw();

      global.localStorage.setItem = origSetItem;
    });
  });

  // ==========================================
  // getSessionDuration
  // ==========================================
  describe('getSessionDuration', function () {

    it('returns a positive number', function () {
      const mgr = new SessionManager();
      const duration = mgr.getSessionDuration();
      expect(duration).to.be.a('number');
      expect(duration).to.be.at.least(0);
    });

    it('increases over time with fake timers', function () {
      const clock = sinon.useFakeTimers(Date.now());
      try {
        const mgr = new SessionManager();
        const d1 = mgr.getSessionDuration();

        clock.tick(5000); // 5 seconds later

        const d2 = mgr.getSessionDuration();
        expect(d2 - d1).to.be.closeTo(5000, 50);
      } finally {
        clock.restore();
      }
    });
  });

  // ==========================================
  // isActive
  // ==========================================
  describe('isActive', function () {

    it('returns true for a fresh session', function () {
      const mgr = new SessionManager();
      expect(mgr.isActive()).to.be.true;
    });

    it('returns false when session is expired', function () {
      const mgr = new SessionManager();
      // Manually expire the session
      global.localStorage.setItem('_skysignal_session', JSON.stringify({
        sessionId: mgr.getSessionId(),
        timestamp: Date.now() - 31 * 60 * 1000
      }));
      expect(mgr.isActive()).to.be.false;
    });

    it('returns false when localStorage is empty', function () {
      const mgr = new SessionManager();
      global.localStorage.clear();
      expect(mgr.isActive()).to.be.false;
    });

    it('returns false when localStorage data is corrupted', function () {
      const mgr = new SessionManager();
      global.localStorage.setItem('_skysignal_session', 'not-json');
      expect(mgr.isActive()).to.be.false;
    });

    it('returns false when localStorage.getItem throws', function () {
      const mgr = new SessionManager();
      const origGetItem = global.localStorage.getItem;
      global.localStorage.getItem = sinon.stub().throws(new Error('SecurityError'));

      expect(mgr.isActive()).to.be.false;

      global.localStorage.getItem = origGetItem;
    });
  });

  // ==========================================
  // _setupActivityTracking
  // ==========================================
  describe('_setupActivityTracking', function () {

    it('registers event listeners for click, scroll, keydown', function () {
      const addEventCalls = global.window.addEventListener.getCalls();
      const events = addEventCalls.map(c => c.args[0]);
      expect(events).to.include('click');
      expect(events).to.include('scroll');
      expect(events).to.include('keydown');
    });

    it('uses passive: true for event listeners', function () {
      const addEventCalls = global.window.addEventListener.getCalls();
      const activityCalls = addEventCalls.filter(c =>
        ['click', 'scroll', 'keydown'].includes(c.args[0])
      );
      activityCalls.forEach(call => {
        expect(call.args[2]).to.deep.include({ passive: true });
      });
    });

    it('throttles session renewal to once per minute', function () {
      const clock = sinon.useFakeTimers(Date.now());
      try {
        global.localStorage.clear();
        global.window.addEventListener.resetHistory();

        const mgr = new SessionManager();

        // Find the click listener
        const clickCall = global.window.addEventListener.getCalls().find(
          c => c.args[0] === 'click'
        );
        const handler = clickCall.args[1];

        // Record timestamp after initial persist
        const storedAfterConstruct = JSON.parse(
          global.localStorage.getItem('_skysignal_session')
        );
        const initialTimestamp = storedAfterConstruct.timestamp;

        // Simulate click immediately — should persist (first call, lastRenewal is 0)
        clock.tick(100);
        handler();
        const afterFirst = JSON.parse(
          global.localStorage.getItem('_skysignal_session')
        );
        expect(afterFirst.timestamp).to.be.greaterThan(initialTimestamp);

        const firstRenewalTimestamp = afterFirst.timestamp;

        // Simulate click 30 seconds later — should be throttled (no update)
        clock.tick(30000);
        handler();
        const afterThrottled = JSON.parse(
          global.localStorage.getItem('_skysignal_session')
        );
        expect(afterThrottled.timestamp).to.equal(firstRenewalTimestamp);

        // Simulate click 61 seconds after first renewal — should update
        clock.tick(31000); // total 61.1s after first renewal
        handler();
        const afterSecond = JSON.parse(
          global.localStorage.getItem('_skysignal_session')
        );
        expect(afterSecond.timestamp).to.be.greaterThan(firstRenewalTimestamp);
      } finally {
        clock.restore();
      }
    });
  });

  // ==========================================
  // SESSION_DURATION constant
  // ==========================================
  describe('SESSION_DURATION', function () {

    it('defaults to 30 minutes', function () {
      const mgr = new SessionManager();
      expect(mgr.SESSION_DURATION).to.equal(30 * 60 * 1000);
    });
  });
});
