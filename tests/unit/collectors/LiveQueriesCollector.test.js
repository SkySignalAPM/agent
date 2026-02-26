/**
 * LiveQueriesCollector tests — _detectDriverType, _generateQuerySignature,
 * _sanitizeQuery, _calculatePerformance, _updateActivityRate,
 * _evictOldestObservers, getStats.
 *
 * Does NOT wrap real Mongo.Collection.prototype — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import LiveQueriesCollector from '../../../lib/collectors/LiveQueriesCollector.js';

describe('LiveQueriesCollector', function () {

  let collector;
  let mockClient;

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
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      expect(collector.host).to.equal('test-host');
      expect(collector.interval).to.equal(60000);
      expect(collector.observers).to.be.instanceOf(Map);
      expect(collector.maxObservers).to.equal(5000);
      expect(collector.wrappingApplied).to.be.false;
    });

    it('has default performance thresholds', function () {
      expect(collector.thresholds.changeStream.optimal.maxProcessingTime).to.equal(20);
      expect(collector.thresholds.oplog.good.maxBacklog).to.equal(100);
      expect(collector.thresholds.polling.optimal.maxUpdatesPerMin).to.equal(5);
    });

    it('allows custom thresholds via merge', function () {
      const custom = new LiveQueriesCollector({
        performanceThresholds: {
          polling: { optimal: { maxUpdatesPerMin: 2 } }
        }
      });
      expect(custom.thresholds.polling.optimal.maxUpdatesPerMin).to.equal(2);
      // Others remain default
      expect(custom.thresholds.oplog.good.maxBacklog).to.equal(100);
    });
  });

  // ==========================================
  // _detectDriverType
  // ==========================================
  describe('_detectDriverType', function () {

    it('detects ChangeStreamObserveDriver', function () {
      const handle = {
        _multiplexer: {
          _observeDriver: {
            constructor: { name: 'ChangeStreamObserveDriver' }
          }
        }
      };
      expect(collector._detectDriverType(handle)).to.equal('changeStream');
    });

    it('detects OplogObserveDriver', function () {
      const handle = {
        _multiplexer: {
          _observeDriver: {
            constructor: { name: 'OplogObserveDriver' }
          }
        }
      };
      expect(collector._detectDriverType(handle)).to.equal('oplog');
    });

    it('detects PollingObserveDriver', function () {
      const handle = {
        _multiplexer: {
          _observeDriver: {
            constructor: { name: 'PollingObserveDriver' }
          }
        }
      };
      expect(collector._detectDriverType(handle)).to.equal('polling');
    });

    it('falls back to property detection: _changeStream', function () {
      const handle = {
        _multiplexer: {
          _observeDriver: {
            constructor: { name: 'SomeUnknownDriver' },
            _changeStream: {}
          }
        }
      };
      expect(collector._detectDriverType(handle)).to.equal('changeStream');
    });

    it('falls back to property detection: _pipeline', function () {
      const handle = {
        _multiplexer: {
          _observeDriver: {
            constructor: { name: 'SomeUnknownDriver' },
            _pipeline: []
          }
        }
      };
      expect(collector._detectDriverType(handle)).to.equal('changeStream');
    });

    it('falls back to property detection: _usesOplog', function () {
      const handle = {
        _multiplexer: {
          _observeDriver: {
            constructor: { name: 'SomeUnknownDriver' },
            _usesOplog: true
          }
        }
      };
      expect(collector._detectDriverType(handle)).to.equal('oplog');
    });

    it('falls back to property detection: _needToFetch', function () {
      const handle = {
        _multiplexer: {
          _observeDriver: {
            constructor: { name: '' },
            _needToFetch: new Map()
          }
        }
      };
      expect(collector._detectDriverType(handle)).to.equal('oplog');
    });

    it('falls back to MONGO_OPLOG_URL when introspection fails', function () {
      const original = process.env.MONGO_OPLOG_URL;
      process.env.MONGO_OPLOG_URL = 'mongodb://localhost:27017/local';

      const handle = { _multiplexer: null };
      expect(collector._detectDriverType(handle)).to.equal('oplog');

      if (original !== undefined) {
        process.env.MONGO_OPLOG_URL = original;
      } else {
        delete process.env.MONGO_OPLOG_URL;
      }
    });

    it('returns polling when no oplog URL and introspection fails', function () {
      const original = process.env.MONGO_OPLOG_URL;
      delete process.env.MONGO_OPLOG_URL;

      const handle = {};
      expect(collector._detectDriverType(handle)).to.equal('polling');

      if (original !== undefined) {
        process.env.MONGO_OPLOG_URL = original;
      }
    });
  });

  // ==========================================
  // _generateQuerySignature
  // ==========================================
  describe('_generateQuerySignature', function () {

    it('returns a string', function () {
      const sig = collector._generateQuerySignature('users', {}, {});
      expect(sig).to.be.a('string');
      expect(sig.length).to.be.greaterThan(0);
    });

    it('returns same signature for same inputs', function () {
      const sig1 = collector._generateQuerySignature('users', { active: true }, { limit: 10 });
      const sig2 = collector._generateQuerySignature('users', { active: true }, { limit: 10 });
      expect(sig1).to.equal(sig2);
    });

    it('returns different signatures for different collections', function () {
      const sig1 = collector._generateQuerySignature('users', {}, {});
      const sig2 = collector._generateQuerySignature('posts', {}, {});
      expect(sig1).to.not.equal(sig2);
    });

    it('returns different signatures for different selectors', function () {
      const sig1 = collector._generateQuerySignature('users', { active: true }, {});
      const sig2 = collector._generateQuerySignature('users', { active: false }, {});
      expect(sig1).to.not.equal(sig2);
    });

    it('handles null/undefined inputs gracefully', function () {
      const sig1 = collector._generateQuerySignature('users', null, null);
      const sig2 = collector._generateQuerySignature('users', undefined, undefined);
      expect(sig1).to.be.a('string');
      expect(sig2).to.be.a('string');
    });
  });

  // ==========================================
  // _sanitizeQuery
  // ==========================================
  describe('_sanitizeQuery', function () {

    it('returns empty object for falsy input', function () {
      expect(collector._sanitizeQuery(null)).to.deep.equal({});
      expect(collector._sanitizeQuery(undefined)).to.deep.equal({});
      expect(collector._sanitizeQuery('')).to.deep.equal({});
    });

    it('returns empty object for non-object input', function () {
      expect(collector._sanitizeQuery(42)).to.deep.equal({});
      expect(collector._sanitizeQuery('string')).to.deep.equal({});
    });

    it('redacts sensitive fields', function () {
      const query = {
        userId: '123',
        password: 'secret123',
        token: 'abc',
        secret: 'shhh',
        apiKey: 'key123',
        accessToken: 'at_xxx',
        refreshToken: 'rt_xxx'
      };

      const sanitized = collector._sanitizeQuery(query);

      expect(sanitized.userId).to.equal('123');
      expect(sanitized.password).to.equal('[REDACTED]');
      expect(sanitized.token).to.equal('[REDACTED]');
      expect(sanitized.secret).to.equal('[REDACTED]');
      expect(sanitized.apiKey).to.equal('[REDACTED]');
      expect(sanitized.accessToken).to.equal('[REDACTED]');
      expect(sanitized.refreshToken).to.equal('[REDACTED]');
    });

    it('leaves non-sensitive fields untouched', function () {
      const query = { name: 'test', status: 'active', $gt: 5 };
      const sanitized = collector._sanitizeQuery(query);
      expect(sanitized).to.deep.equal(query);
    });

    it('does not redact falsy sensitive fields', function () {
      const query = { password: '', token: null, apiKey: 0 };
      const sanitized = collector._sanitizeQuery(query);
      // Falsy values pass the `if (sanitized[field])` check as false
      expect(sanitized.password).to.equal('');
      expect(sanitized.token).to.be.null;
      expect(sanitized.apiKey).to.equal(0);
    });
  });

  // ==========================================
  // _calculatePerformance
  // ==========================================
  describe('_calculatePerformance', function () {

    // --- changeStream ---
    it('changeStream: returns optimal for null processing time', function () {
      expect(collector._calculatePerformance({
        observerType: 'changeStream',
        avgProcessingTime: null
      })).to.equal('optimal');
    });

    it('changeStream: returns optimal for low processing time', function () {
      expect(collector._calculatePerformance({
        observerType: 'changeStream',
        avgProcessingTime: 10
      })).to.equal('optimal');
    });

    it('changeStream: returns good for moderate processing time', function () {
      expect(collector._calculatePerformance({
        observerType: 'changeStream',
        avgProcessingTime: 30
      })).to.equal('good');
    });

    it('changeStream: returns slow for high processing time', function () {
      expect(collector._calculatePerformance({
        observerType: 'changeStream',
        avgProcessingTime: 100
      })).to.equal('slow');
    });

    // --- oplog ---
    it('oplog: returns optimal for low backlog and processing time', function () {
      expect(collector._calculatePerformance({
        observerType: 'oplog',
        backlogSize: 10,
        avgProcessingTime: 5
      })).to.equal('optimal');
    });

    it('oplog: returns optimal when processing time is null', function () {
      expect(collector._calculatePerformance({
        observerType: 'oplog',
        backlogSize: 10,
        avgProcessingTime: null
      })).to.equal('optimal');
    });

    it('oplog: returns good for moderate backlog', function () {
      expect(collector._calculatePerformance({
        observerType: 'oplog',
        backlogSize: 80,
        avgProcessingTime: 30
      })).to.equal('good');
    });

    it('oplog: returns slow for high backlog', function () {
      expect(collector._calculatePerformance({
        observerType: 'oplog',
        backlogSize: 200,
        avgProcessingTime: 100
      })).to.equal('slow');
    });

    // --- polling ---
    it('polling: returns optimal for low update rate', function () {
      expect(collector._calculatePerformance({
        observerType: 'polling',
        updatesPerMinute: 3
      })).to.equal('optimal');
    });

    it('polling: returns good for moderate update rate', function () {
      expect(collector._calculatePerformance({
        observerType: 'polling',
        updatesPerMinute: 8
      })).to.equal('good');
    });

    it('polling: returns inefficient for high update rate', function () {
      expect(collector._calculatePerformance({
        observerType: 'polling',
        updatesPerMinute: 100
      })).to.equal('inefficient');
    });
  });

  // ==========================================
  // _updateActivityRate
  // ==========================================
  describe('_updateActivityRate', function () {

    it('calculates updates per minute', function () {
      const observer = {
        addedCount: 10,
        changedCount: 5,
        removedCount: 3,
        updatesPerMinute: 0,
        _lastUpdateCount: 0,
        _lastUpdateTime: Date.now() - 60000 // 1 minute ago
      };

      collector._updateActivityRate(observer);

      // 18 updates in 60s = 18/min
      expect(observer.updatesPerMinute).to.equal(18);
      expect(observer._lastUpdateCount).to.equal(18);
    });

    it('handles zero time delta', function () {
      const now = Date.now();
      const observer = {
        addedCount: 5,
        changedCount: 0,
        removedCount: 0,
        updatesPerMinute: 0,
        _lastUpdateCount: 0,
        _lastUpdateTime: now
      };

      // Should not throw and not divide by zero
      collector._updateActivityRate(observer);
      // updatesPerMinute is updated since timeSinceLastUpdate > 0 is checked
    });
  });

  // ==========================================
  // _evictOldestObservers
  // ==========================================
  describe('_evictOldestObservers', function () {

    it('evicts 10% of maxObservers', function () {
      collector.maxObservers = 10;

      // Add 10 observers
      for (let i = 0; i < 10; i++) {
        collector.observers.set(`obs${i}`, {
          observerId: `obs${i}`,
          status: 'active',
          createdAt: new Date(Date.now() - (10 - i) * 1000) // Oldest first
        });
      }

      collector._evictOldestObservers();

      // Should evict floor(10 * 0.1) = 1
      expect(collector.observers.size).to.equal(9);
      // Oldest should be evicted
      expect(collector.observers.has('obs0')).to.be.false;
    });

    it('evicts stopped observers first', function () {
      collector.maxObservers = 10;

      // Add observers: some active, some stopped
      collector.observers.set('active1', {
        observerId: 'active1',
        status: 'active',
        createdAt: new Date(Date.now() - 100000) // Very old but active
      });
      collector.observers.set('stopped1', {
        observerId: 'stopped1',
        status: 'stopped',
        createdAt: new Date(Date.now() - 1000) // Recent but stopped
      });

      for (let i = 0; i < 8; i++) {
        collector.observers.set(`obs${i}`, {
          observerId: `obs${i}`,
          status: 'active',
          createdAt: new Date(Date.now() - i * 1000)
        });
      }

      collector._evictOldestObservers();

      // Stopped observer should be evicted first
      expect(collector.observers.has('stopped1')).to.be.false;
      // Old active observer should still be there
      expect(collector.observers.has('active1')).to.be.true;
    });

    it('handles empty observers gracefully', function () {
      collector.maxObservers = 10;
      expect(() => collector._evictOldestObservers()).to.not.throw();
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns default stats when empty', function () {
      const stats = collector.getStats();
      expect(stats.totalObservers).to.equal(0);
      expect(stats.changeStreamObservers).to.equal(0);
      expect(stats.oplogObservers).to.equal(0);
      expect(stats.pollingObservers).to.equal(0);
      expect(stats.reactiveEfficiency).to.equal(100);
      expect(stats.collections).to.be.an('array').that.is.empty;
    });

    it('counts observers by type', function () {
      collector.observers.set('o1', {
        observerId: 'o1',
        collectionName: 'users',
        observerType: 'changeStream',
        status: 'active',
        documentCount: 10,
        avgProcessingTime: null,
        backlogSize: 0,
        updatesPerMinute: 0
      });
      collector.observers.set('o2', {
        observerId: 'o2',
        collectionName: 'posts',
        observerType: 'oplog',
        status: 'active',
        documentCount: 5,
        avgProcessingTime: null,
        backlogSize: 0,
        updatesPerMinute: 0
      });
      collector.observers.set('o3', {
        observerId: 'o3',
        collectionName: 'comments',
        observerType: 'polling',
        status: 'active',
        documentCount: 3,
        avgProcessingTime: null,
        backlogSize: 0,
        updatesPerMinute: 0
      });

      const stats = collector.getStats();
      expect(stats.totalObservers).to.equal(3);
      expect(stats.changeStreamObservers).to.equal(1);
      expect(stats.oplogObservers).to.equal(1);
      expect(stats.pollingObservers).to.equal(1);
    });

    it('calculates reactive efficiency', function () {
      // 2 efficient (changeStream + oplog) out of 3 total = 67%
      collector.observers.set('o1', {
        observerId: 'o1', collectionName: 'a', observerType: 'changeStream',
        status: 'active', documentCount: 0, avgProcessingTime: null, backlogSize: 0, updatesPerMinute: 0
      });
      collector.observers.set('o2', {
        observerId: 'o2', collectionName: 'b', observerType: 'oplog',
        status: 'active', documentCount: 0, avgProcessingTime: null, backlogSize: 0, updatesPerMinute: 0
      });
      collector.observers.set('o3', {
        observerId: 'o3', collectionName: 'c', observerType: 'polling',
        status: 'active', documentCount: 0, avgProcessingTime: null, backlogSize: 0, updatesPerMinute: 0
      });

      const stats = collector.getStats();
      expect(stats.reactiveEfficiency).to.equal(67);
    });

    it('excludes stopped observers from stats', function () {
      collector.observers.set('o1', {
        observerId: 'o1', collectionName: 'a', observerType: 'oplog',
        status: 'active', documentCount: 0, avgProcessingTime: null, backlogSize: 0, updatesPerMinute: 0
      });
      collector.observers.set('o2', {
        observerId: 'o2', collectionName: 'b', observerType: 'polling',
        status: 'stopped', documentCount: 0, avgProcessingTime: null, backlogSize: 0, updatesPerMinute: 0
      });

      const stats = collector.getStats();
      expect(stats.totalObservers).to.equal(1);
    });

    it('lists unique collections', function () {
      collector.observers.set('o1', {
        observerId: 'o1', collectionName: 'users', observerType: 'oplog',
        status: 'active', documentCount: 0, avgProcessingTime: null, backlogSize: 0, updatesPerMinute: 0
      });
      collector.observers.set('o2', {
        observerId: 'o2', collectionName: 'users', observerType: 'oplog',
        status: 'active', documentCount: 0, avgProcessingTime: null, backlogSize: 0, updatesPerMinute: 0
      });
      collector.observers.set('o3', {
        observerId: 'o3', collectionName: 'posts', observerType: 'oplog',
        status: 'active', documentCount: 0, avgProcessingTime: null, backlogSize: 0, updatesPerMinute: 0
      });

      const stats = collector.getStats();
      expect(stats.collections).to.have.lengthOf(2);
      expect(stats.collections).to.include('users');
      expect(stats.collections).to.include('posts');
    });
  });
});
