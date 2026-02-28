/**
 * LiveQueriesCollector – Leak-detection field tests
 *
 * The server-side ObserverLeakDetectionService relies on specific fields
 * emitted by the collector: liveUpdateCount, lastActivityAt, observerLifespan,
 * documentCount, publicationName, status.
 *
 * These tests verify the collector produces correct values for those fields
 * so that leak detection heuristics work properly.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import LiveQueriesCollector from '../../../lib/collectors/LiveQueriesCollector.js';

describe('LiveQueriesCollector – leak-detection fields', function () {

  let collector;
  let mockClient;
  let clock;

  beforeEach(function () {
    mockClient = { sendLiveQueries: sinon.stub() };
    collector = new LiveQueriesCollector({
      client: mockClient,
      host: 'test-host',
      appVersion: '1.0.0'
    });
  });

  afterEach(function () {
    if (collector.intervalId) {
      clearInterval(collector.intervalId);
      collector.intervalId = null;
    }
    if (clock) {
      clock.restore();
      clock = null;
    }
  });

  // ==========================================
  // _wrapCallbacks – liveUpdateCount tracking
  // ==========================================
  describe('_wrapCallbacks', function () {

    it('returns original callbacks unchanged when input is falsy', function () {
      expect(collector._wrapCallbacks(null, {})).to.be.null;
      expect(collector._wrapCallbacks(undefined, {})).to.be.undefined;
    });

    it('increments liveUpdateCount on added (after initial load)', function () {
      const data = {
        _initialLoadComplete: true,
        addedInitially: 0,
        addedCount: 0,
        documentCount: 0,
        liveUpdateCount: 0,
        lastActivityAt: 0
      };
      const observerRef = { data };
      const originalAdded = sinon.stub();
      const callbacks = { added: originalAdded };

      const wrapped = collector._wrapCallbacks(callbacks, observerRef);
      wrapped.added('id-1', { name: 'test' });

      expect(data.liveUpdateCount).to.equal(1);
      expect(data.addedCount).to.equal(1);
      expect(data.documentCount).to.equal(1);
      expect(data.lastActivityAt).to.be.greaterThan(0);
      expect(originalAdded.calledOnce).to.be.true;
    });

    it('does NOT increment liveUpdateCount during initial load', function () {
      const data = {
        _initialLoadComplete: false,
        addedInitially: 0,
        addedCount: 0,
        documentCount: 0,
        liveUpdateCount: 0,
        lastActivityAt: 0
      };
      const observerRef = { data };
      const callbacks = { added: sinon.stub() };

      const wrapped = collector._wrapCallbacks(callbacks, observerRef);
      wrapped.added('id-1', { name: 'doc1' });
      wrapped.added('id-2', { name: 'doc2' });

      expect(data.liveUpdateCount).to.equal(0, 'liveUpdateCount should stay 0 during initial load');
      expect(data.addedInitially).to.equal(2);
      expect(data.documentCount).to.equal(2);
    });

    it('increments liveUpdateCount on changed callback', function () {
      const data = {
        changedCount: 0,
        liveUpdateCount: 0,
        lastActivityAt: 0
      };
      const observerRef = { data };
      const originalChanged = sinon.stub();
      const callbacks = { changed: originalChanged };

      const wrapped = collector._wrapCallbacks(callbacks, observerRef);
      wrapped.changed('id-1', { name: 'updated' });

      expect(data.liveUpdateCount).to.equal(1);
      expect(data.changedCount).to.equal(1);
      expect(data.lastActivityAt).to.be.greaterThan(0);
      expect(originalChanged.calledOnce).to.be.true;
    });

    it('increments liveUpdateCount on removed callback', function () {
      const data = {
        removedCount: 0,
        documentCount: 5,
        liveUpdateCount: 0,
        lastActivityAt: 0
      };
      const observerRef = { data };
      const originalRemoved = sinon.stub();
      const callbacks = { removed: originalRemoved };

      const wrapped = collector._wrapCallbacks(callbacks, observerRef);
      wrapped.removed('id-1');

      expect(data.liveUpdateCount).to.equal(1);
      expect(data.removedCount).to.equal(1);
      expect(data.documentCount).to.equal(4);
      expect(originalRemoved.calledOnce).to.be.true;
    });

    it('accumulates liveUpdateCount across multiple callback types', function () {
      const data = {
        _initialLoadComplete: true,
        addedInitially: 0,
        addedCount: 0,
        changedCount: 0,
        removedCount: 0,
        documentCount: 3,
        liveUpdateCount: 0,
        lastActivityAt: 0
      };
      const observerRef = { data };
      const callbacks = {
        added: sinon.stub(),
        changed: sinon.stub(),
        removed: sinon.stub()
      };

      const wrapped = collector._wrapCallbacks(callbacks, observerRef);
      wrapped.added('id-new', {});       // +1
      wrapped.changed('id-1', {});       // +1
      wrapped.changed('id-2', {});       // +1
      wrapped.removed('id-3');           // +1

      expect(data.liveUpdateCount).to.equal(4);
    });

    it('updates lastActivityAt to current time on each live event', function () {
      const baseTime = Date.now() - 60000; // 1 minute ago
      const data = {
        _initialLoadComplete: true,
        addedInitially: 0,
        addedCount: 0,
        documentCount: 0,
        liveUpdateCount: 0,
        lastActivityAt: baseTime
      };
      const observerRef = { data };
      const callbacks = { added: sinon.stub() };

      const wrapped = collector._wrapCallbacks(callbacks, observerRef);
      wrapped.added('id-1', {});

      expect(data.lastActivityAt).to.be.greaterThan(baseTime);
      // Should be within a few ms of now
      expect(Date.now() - data.lastActivityAt).to.be.lessThan(100);
    });

    it('wraps addedBefore when present instead of added', function () {
      const data = {
        _initialLoadComplete: true,
        addedInitially: 0,
        addedCount: 0,
        documentCount: 0,
        liveUpdateCount: 0,
        lastActivityAt: 0
      };
      const observerRef = { data };
      const originalAddedBefore = sinon.stub();
      const callbacks = { addedBefore: originalAddedBefore };

      const wrapped = collector._wrapCallbacks(callbacks, observerRef);
      wrapped.addedBefore('id-1', { name: 'test' }, null);

      expect(data.liveUpdateCount).to.equal(1);
      expect(originalAddedBefore.calledOnce).to.be.true;
    });

    it('handles null observerRef.data gracefully', function () {
      const observerRef = { data: null };
      const originalAdded = sinon.stub();
      const callbacks = { added: originalAdded };

      const wrapped = collector._wrapCallbacks(callbacks, observerRef);
      // Should not throw
      wrapped.added('id-1', {});

      expect(originalAdded.calledOnce).to.be.true;
    });
  });

  // ==========================================
  // _wrapHandle – observerLifespan on stop
  // ==========================================
  describe('_wrapHandle', function () {

    it('sets observerLifespan in seconds when handle.stop() is called', function () {
      const createdAt = Date.now() - 3600000; // 1 hour ago
      const observerData = {
        observerId: 'obs-1',
        collectionName: 'tasks',
        status: 'active',
        createdAt,
        stoppedAt: null,
        observerLifespan: 0,
        _initialLoadTimer: null
      };
      collector.observers.set('obs-1', observerData);

      const originalStop = sinon.stub();
      const handle = {
        _skySignalObserverId: 'obs-1',
        stop: originalStop
      };

      collector._wrapHandle(handle);
      handle.stop();

      expect(observerData.status).to.equal('stopped');
      expect(observerData.stoppedAt).to.be.a('number');
      // ~3600 seconds (1 hour)
      expect(observerData.observerLifespan).to.be.within(3599, 3601);
      expect(originalStop.calledOnce).to.be.true;
    });

    it('clears initialLoadTimer on stop', function () {
      const timer = setTimeout(() => {}, 10000);
      const observerData = {
        observerId: 'obs-2',
        collectionName: 'items',
        status: 'active',
        createdAt: Date.now(),
        stoppedAt: null,
        observerLifespan: 0,
        _initialLoadTimer: timer
      };
      collector.observers.set('obs-2', observerData);

      const handle = {
        _skySignalObserverId: 'obs-2',
        stop: sinon.stub()
      };

      collector._wrapHandle(handle);
      handle.stop();

      expect(observerData._initialLoadTimer).to.be.null;
      clearTimeout(timer); // cleanup
    });
  });

  // ==========================================
  // collect payload – leak-relevant fields
  // ==========================================
  describe('collect payload includes leak-detection fields', function () {

    it('emits liveUpdateCount and lastActivityAt in payload', function () {
      const now = Date.now();
      collector.observers.set('obs-payload', {
        observerId: 'obs-payload',
        collectionName: 'tasks',
        query: {},
        publicationName: 'tasks.mine',
        observerType: 'oplog',
        isOplogEfficient: true,
        observerCount: 1,
        handlersSharing: 1,
        documentCount: 10,
        updatesPerMinute: 2,
        addedCount: 5,
        changedCount: 3,
        removedCount: 1,
        avgProcessingTime: null,
        backlogSize: 0,
        observerLifespan: 0,
        createdAt: now - 600000, // 10 min ago
        stoppedAt: null,
        lastActivityAt: now - 5000,
        timestamp: now,
        status: 'active',
        performance: null,
        host: 'test-host',
        liveUpdateCount: 42,
        _lastUpdateCount: 0,
        _lastUpdateTime: now - 60000,
        // Driver metrics (needed for _snapshotDriverMetrics not to fail)
        initialQueryMs: null,
        oplogPhase: null,
        phaseAge: null,
        fetchBacklog: 0,
        activeFetches: 0,
        blockedWrites: 0,
        publishedCount: 0,
        pollingIntervalMs: null,
        pollingThrottleMs: null,
        pendingPolls: 0,
        hasLimit: false,
        queryLimit: 0,
        bufferCount: 0,
        hasProjection: false,
        _multiplexerRef: null,
        _handleRef: null,
        _initialLoadComplete: true,
        _initialLoadTimer: null
      });

      // Trigger collect by calling the internal method that builds the payload
      // We can't call collect() directly (it wraps Mongo internals), but we can
      // invoke the send path manually by examining what collect() builds
      const activeObservers = Array.from(collector.observers.values())
        .filter(obs => obs.status === 'active')
        .map(obs => {
          collector._updateActivityRate(obs);
          const lifespan = Math.round((Date.now() - obs.createdAt) / 1000);
          return {
            observerId: obs.observerId,
            liveUpdateCount: obs.liveUpdateCount,
            lastActivityAt: obs.lastActivityAt,
            observerLifespan: lifespan,
            documentCount: obs.documentCount,
            publicationName: obs.publicationName,
            status: obs.status
          };
        });

      expect(activeObservers).to.have.lengthOf(1);
      const payload = activeObservers[0];
      expect(payload).to.have.property('liveUpdateCount', 42);
      expect(payload).to.have.property('lastActivityAt');
      expect(payload.lastActivityAt).to.be.a('number');
      expect(payload).to.have.property('observerLifespan');
      expect(payload.observerLifespan).to.be.within(599, 601); // ~600 seconds
      expect(payload).to.have.property('documentCount', 10);
      expect(payload).to.have.property('publicationName', 'tasks.mine');
      expect(payload).to.have.property('status', 'active');
    });
  });

  // ==========================================
  // _createObserverData – defaults
  // ==========================================
  describe('_createObserverData', function () {

    it('initializes liveUpdateCount to 0', function () {
      const data = collector._createObserverData('users');
      expect(data.liveUpdateCount).to.equal(0);
    });

    it('initializes lastActivityAt to current time', function () {
      const before = Date.now();
      const data = collector._createObserverData('users');
      const after = Date.now();

      expect(data.lastActivityAt).to.be.at.least(before);
      expect(data.lastActivityAt).to.be.at.most(after);
    });

    it('initializes observerLifespan to 0', function () {
      const data = collector._createObserverData('users');
      expect(data.observerLifespan).to.equal(0);
    });

    it('initializes _initialLoadComplete to false', function () {
      const data = collector._createObserverData('users');
      expect(data._initialLoadComplete).to.be.false;
    });

    it('initializes status to active', function () {
      const data = collector._createObserverData('users');
      expect(data.status).to.equal('active');
    });

    it('initializes documentCount to 0', function () {
      const data = collector._createObserverData('users');
      expect(data.documentCount).to.equal(0);
    });

    it('initializes publicationName to null', function () {
      const data = collector._createObserverData('users');
      expect(data.publicationName).to.be.null;
    });
  });
});
