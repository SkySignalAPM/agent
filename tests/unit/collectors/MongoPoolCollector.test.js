/**
 * MongoPoolCollector tests — event handlers, checkout metrics,
 * memory estimation, pool stats from events, pool config from URL.
 *
 * Does NOT connect to real MongoDB — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import MongoPoolCollector from '../../../lib/collectors/MongoPoolCollector.js';

describe('MongoPoolCollector', function () {

  let collector;
  let mockClient;
  let mockSkySignalClient;

  beforeEach(function () {
    mockClient = {
      on: sinon.stub(),
      removeAllListeners: sinon.stub()
    };
    mockSkySignalClient = { addMongoPoolMetric: sinon.stub() };
    collector = new MongoPoolCollector({
      client: mockClient,
      skySignalClient: mockSkySignalClient,
      host: 'test-host',
      appVersion: '1.0.0'
    });
  });

  afterEach(function () {
    // Manual cleanup without calling stop() which may require real client
    if (collector.snapshotTimer) {
      clearInterval(collector.snapshotTimer);
      collector.snapshotTimer = null;
    }
    collector.started = false;
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      expect(collector.host).to.equal('test-host');
      expect(collector.enabled).to.be.true;
      expect(collector.snapshotInterval).to.equal(60000);
      expect(collector.started).to.be.false;
      expect(collector.poolState.config.maxPoolSize).to.equal(100);
      expect(collector.poolState.peakConnections).to.equal(0);
      expect(collector.poolState.totalCheckouts).to.equal(0);
      expect(collector.poolState.checkoutSampleCount).to.equal(0);
    });

    it('respects disabled flag', function () {
      const c = new MongoPoolCollector({ enabled: false });
      expect(c.enabled).to.be.false;
    });

    it('accepts fixedConnectionMemory', function () {
      const c = new MongoPoolCollector({ fixedConnectionMemory: 2048000 });
      expect(c.fixedConnectionMemory).to.equal(2048000);
    });
  });

  // ==========================================
  // _onPoolCreated
  // ==========================================
  describe('_onPoolCreated', function () {

    it('captures pool configuration from event', function () {
      collector._onPoolCreated({
        options: {
          minPoolSize: 5,
          maxPoolSize: 50,
          maxIdleTimeMS: 30000,
          waitQueueTimeoutMS: 10000
        }
      });

      expect(collector.poolState.config.minPoolSize).to.equal(5);
      expect(collector.poolState.config.maxPoolSize).to.equal(50);
      expect(collector.poolState.config.maxIdleTimeMS).to.equal(30000);
      expect(collector.poolState.config.waitQueueTimeoutMS).to.equal(10000);
    });

    it('uses defaults for missing options', function () {
      collector._onPoolCreated({ options: {} });
      expect(collector.poolState.config.minPoolSize).to.equal(0);
      expect(collector.poolState.config.maxPoolSize).to.equal(100);
    });

    it('handles null event gracefully', function () {
      expect(() => collector._onPoolCreated(null)).to.not.throw();
    });
  });

  // ==========================================
  // _onConnectionCreated
  // ==========================================
  describe('_onConnectionCreated', function () {

    it('adds connection to tracking', function () {
      collector._onConnectionCreated({
        connectionId: 1,
        address: 'localhost:27017'
      });

      expect(collector.poolState.connections.size).to.equal(1);
      const conn = collector.poolState.connections.get(1);
      expect(conn.address).to.equal('localhost:27017');
      expect(conn.inUse).to.be.false;
    });

    it('updates peak connections', function () {
      collector._onConnectionCreated({ connectionId: 1, address: 'a' });
      collector._onConnectionCreated({ connectionId: 2, address: 'a' });
      collector._onConnectionCreated({ connectionId: 3, address: 'a' });

      expect(collector.poolState.peakConnections).to.equal(3);
    });

    it('ignores events with null connectionId', function () {
      collector._onConnectionCreated({ connectionId: null });
      expect(collector.poolState.connections.size).to.equal(0);
    });

    it('handles null event', function () {
      expect(() => collector._onConnectionCreated(null)).to.not.throw();
    });
  });

  // ==========================================
  // _onConnectionClosed
  // ==========================================
  describe('_onConnectionClosed', function () {

    it('removes connection from tracking', function () {
      collector._onConnectionCreated({ connectionId: 1, address: 'a' });
      collector._onConnectionClosed({ connectionId: 1 });
      expect(collector.poolState.connections.size).to.equal(0);
    });

    it('ignores unknown connectionId', function () {
      expect(() => collector._onConnectionClosed({ connectionId: 999 })).to.not.throw();
    });

    it('handles null event', function () {
      expect(() => collector._onConnectionClosed(null)).to.not.throw();
    });
  });

  // ==========================================
  // _onConnectionCheckedIn
  // ==========================================
  describe('_onConnectionCheckedIn', function () {

    it('marks connection as not in use', function () {
      collector._onConnectionCreated({ connectionId: 1, address: 'a' });
      collector.poolState.connections.get(1).inUse = true;

      collector._onConnectionCheckedIn({ connectionId: 1 });
      expect(collector.poolState.connections.get(1).inUse).to.be.false;
    });

    it('handles unknown connectionId', function () {
      expect(() => collector._onConnectionCheckedIn({ connectionId: 999 })).to.not.throw();
    });
  });

  // ==========================================
  // _onCheckoutStarted
  // ==========================================
  describe('_onCheckoutStarted', function () {

    it('adds checkout to queue for address', function () {
      collector._onCheckoutStarted({ address: 'localhost:27017' });

      const queue = collector.checkoutTimes.get('localhost:27017');
      expect(queue).to.have.lengthOf(1);
      expect(queue[0].startTime).to.be.a('number');
    });

    it('creates new queue for new address', function () {
      collector._onCheckoutStarted({ address: 'host1:27017' });
      collector._onCheckoutStarted({ address: 'host2:27017' });

      expect(collector.checkoutTimes.size).to.equal(2);
    });

    it('limits queue size to 500', function () {
      for (let i = 0; i < 510; i++) {
        collector._onCheckoutStarted({ address: 'localhost:27017' });
      }

      const queue = collector.checkoutTimes.get('localhost:27017');
      expect(queue.length).to.be.at.most(500);
    });

    it('handles null event', function () {
      expect(() => collector._onCheckoutStarted(null)).to.not.throw();
    });
  });

  // ==========================================
  // _onConnectionCheckedOut
  // ==========================================
  describe('_onConnectionCheckedOut', function () {

    it('calculates wait time and stores in circular buffer', function () {
      // First start a checkout
      collector._onCheckoutStarted({ address: 'localhost:27017' });

      // Create a tracked connection
      collector._onConnectionCreated({ connectionId: 1, address: 'localhost:27017' });

      // Then complete it
      collector._onConnectionCheckedOut({
        connectionId: 1,
        address: 'localhost:27017'
      });

      expect(collector.poolState.checkoutSampleCount).to.equal(1);
      expect(collector.poolState.totalCheckouts).to.equal(1);
    });

    it('marks connection as in use', function () {
      collector._onConnectionCreated({ connectionId: 1, address: 'a' });
      collector._onCheckoutStarted({ address: 'a' });

      collector._onConnectionCheckedOut({ connectionId: 1, address: 'a' });

      expect(collector.poolState.connections.get(1).inUse).to.be.true;
    });

    it('handles no pending checkout', function () {
      expect(() => {
        collector._onConnectionCheckedOut({ connectionId: 1, address: 'localhost:27017' });
      }).to.not.throw();
      expect(collector.poolState.checkoutSampleCount).to.equal(0);
    });

    it('wraps circular buffer at 1000', function () {
      // Simulate 1000 checkouts
      for (let i = 0; i < 1005; i++) {
        collector._onCheckoutStarted({ address: 'a' });
        collector._onConnectionCheckedOut({ connectionId: 1, address: 'a' });
      }

      expect(collector.poolState.checkoutSampleCount).to.equal(1000);
      // Index should have wrapped around
      expect(collector.poolState.checkoutSampleIndex).to.equal(5);
    });
  });

  // ==========================================
  // _onCheckoutFailed
  // ==========================================
  describe('_onCheckoutFailed', function () {

    it('increments checkoutTimeouts for timeout reason', function () {
      collector._onCheckoutStarted({ address: 'a' });
      collector._onCheckoutFailed({ address: 'a', reason: 'timeout' });
      expect(collector.poolState.errors.checkoutTimeouts).to.equal(1);
    });

    it('increments checkoutTimeouts for connectionError reason', function () {
      collector._onCheckoutStarted({ address: 'a' });
      collector._onCheckoutFailed({ address: 'a', reason: 'connectionError' });
      expect(collector.poolState.errors.checkoutTimeouts).to.equal(1);
    });

    it('increments connectionErrors for other reasons', function () {
      collector._onCheckoutStarted({ address: 'a' });
      collector._onCheckoutFailed({ address: 'a', reason: 'poolClosed' });
      expect(collector.poolState.errors.connectionErrors).to.equal(1);
    });

    it('handles no pending checkout', function () {
      expect(() => {
        collector._onCheckoutFailed({ address: 'a', reason: 'timeout' });
      }).to.not.throw();
      // No error should be counted since there was no pending checkout
      expect(collector.poolState.errors.checkoutTimeouts).to.equal(0);
    });
  });

  // ==========================================
  // _calculateCheckoutMetrics
  // ==========================================
  describe('_calculateCheckoutMetrics', function () {

    it('returns zeros when no samples', function () {
      const metrics = collector._calculateCheckoutMetrics();
      expect(metrics.avgCheckoutTime).to.equal(0);
      expect(metrics.maxCheckoutTime).to.equal(0);
      expect(metrics.p95CheckoutTime).to.equal(0);
    });

    it('calculates avg, max, p95 from samples', function () {
      // Manually populate circular buffer with known values
      for (let i = 0; i < 100; i++) {
        collector.poolState.checkoutSamples[i] = i + 1; // 1-100
      }
      collector.poolState.checkoutSampleCount = 100;
      collector.poolState.checkoutSampleIndex = 100;

      const metrics = collector._calculateCheckoutMetrics();

      // Average of 1-100 = 50.5 → rounded = 51
      expect(metrics.avgCheckoutTime).to.equal(51);
      expect(metrics.maxCheckoutTime).to.equal(100);
      // p95: Math.floor(100 * 0.95) = 95 → sorted[95] = 96
      expect(metrics.p95CheckoutTime).to.equal(96);
    });

    it('handles single sample', function () {
      collector.poolState.checkoutSamples[0] = 42;
      collector.poolState.checkoutSampleCount = 1;
      collector.poolState.checkoutSampleIndex = 1;

      const metrics = collector._calculateCheckoutMetrics();
      expect(metrics.avgCheckoutTime).to.equal(42);
      expect(metrics.maxCheckoutTime).to.equal(42);
    });
  });

  // ==========================================
  // _estimateMemoryUsage
  // ==========================================
  describe('_estimateMemoryUsage', function () {

    it('returns zeros for zero connections', function () {
      const mem = collector._estimateMemoryUsage(0);
      expect(mem.avgConnectionMemory).to.equal(0);
      expect(mem.totalPoolMemory).to.equal(0);
    });

    it('uses fixedConnectionMemory when configured', function () {
      collector.fixedConnectionMemory = 2000000; // 2MB
      const mem = collector._estimateMemoryUsage(5);
      expect(mem.avgConnectionMemory).to.equal(2000000);
      expect(mem.totalPoolMemory).to.equal(10000000);
    });

    it('estimates from heap when no fixed value', function () {
      const mem = collector._estimateMemoryUsage(10);
      expect(mem.avgConnectionMemory).to.be.a('number');
      expect(mem.avgConnectionMemory).to.be.greaterThan(0);
      expect(mem.totalPoolMemory).to.equal(mem.avgConnectionMemory * 10);
    });
  });

  // ==========================================
  // _getPoolStatsFromEvents
  // ==========================================
  describe('_getPoolStatsFromEvents', function () {

    it('returns zeros when no connections', function () {
      const stats = collector._getPoolStatsFromEvents();
      expect(stats.totalConnections).to.equal(0);
      expect(stats.availableConnections).to.equal(0);
      expect(stats.inUseConnections).to.equal(0);
      expect(stats.checkoutQueueLength).to.equal(0);
    });

    it('counts in-use vs available connections', function () {
      collector.poolState.connections.set(1, { inUse: true });
      collector.poolState.connections.set(2, { inUse: false });
      collector.poolState.connections.set(3, { inUse: true });

      const stats = collector._getPoolStatsFromEvents();
      expect(stats.totalConnections).to.equal(3);
      expect(stats.inUseConnections).to.equal(2);
      expect(stats.availableConnections).to.equal(1);
    });

    it('counts checkout queue length', function () {
      collector.checkoutTimes.set('host1:27017', [{ startTime: Date.now() }, { startTime: Date.now() }]);
      collector.checkoutTimes.set('host2:27017', [{ startTime: Date.now() }]);

      const stats = collector._getPoolStatsFromEvents();
      expect(stats.checkoutQueueLength).to.equal(3);
    });
  });

  // ==========================================
  // _capturePoolConfigFromUrl
  // ==========================================
  describe('_capturePoolConfigFromUrl', function () {

    it('parses pool config from MONGO_URL', function () {
      const original = process.env.MONGO_URL;
      process.env.MONGO_URL = 'mongodb://localhost:27017/test?minPoolSize=5&maxPoolSize=50&maxIdleTimeMS=30000';

      collector._capturePoolConfigFromUrl();

      expect(collector.poolState.config.minPoolSize).to.equal(5);
      expect(collector.poolState.config.maxPoolSize).to.equal(50);
      expect(collector.poolState.config.maxIdleTimeMS).to.equal(30000);
      expect(collector.poolState.configCaptured).to.be.true;

      if (original !== undefined) {
        process.env.MONGO_URL = original;
      } else {
        delete process.env.MONGO_URL;
      }
    });

    it('skips when no pool params in URL', function () {
      const original = process.env.MONGO_URL;
      process.env.MONGO_URL = 'mongodb://localhost:27017/test';

      const configBefore = { ...collector.poolState.config };
      collector._capturePoolConfigFromUrl();
      expect(collector.poolState.config).to.deep.equal(configBefore);

      if (original !== undefined) {
        process.env.MONGO_URL = original;
      } else {
        delete process.env.MONGO_URL;
      }
    });

    it('handles missing MONGO_URL', function () {
      const original = process.env.MONGO_URL;
      delete process.env.MONGO_URL;

      expect(() => collector._capturePoolConfigFromUrl()).to.not.throw();

      if (original !== undefined) {
        process.env.MONGO_URL = original;
      }
    });

    it('handles invalid MONGO_URL', function () {
      const original = process.env.MONGO_URL;
      process.env.MONGO_URL = 'not-a-valid-url';

      expect(() => collector._capturePoolConfigFromUrl()).to.not.throw();

      if (original !== undefined) {
        process.env.MONGO_URL = original;
      } else {
        delete process.env.MONGO_URL;
      }
    });
  });

  // ==========================================
  // _extractPoolStatsFromServer
  // ==========================================
  describe('_extractPoolStatsFromServer', function () {

    it('returns not-found for null server', function () {
      const result = collector._extractPoolStatsFromServer(null);
      expect(result.found).to.be.false;
    });

    it('extracts stats from server.s.pool', function () {
      const server = {
        s: {
          pool: {
            totalConnectionCount: 10,
            availableConnectionCount: 6,
            waitQueueSize: 2
          }
        }
      };

      const result = collector._extractPoolStatsFromServer(server);
      expect(result.found).to.be.true;
      expect(result.totalConnections).to.equal(10);
      expect(result.availableConnections).to.equal(6);
      expect(result.checkoutQueueLength).to.equal(2);
    });

    it('extracts stats from server.pool with size/available', function () {
      const server = {
        pool: {
          size: 8,
          available: 3,
          waitQueueSize: 1
        }
      };

      const result = collector._extractPoolStatsFromServer(server);
      expect(result.found).to.be.true;
      expect(result.totalConnections).to.equal(8);
      expect(result.availableConnections).to.equal(3);
    });

    it('tries pool.s for older drivers', function () {
      const server = {
        pool: {
          totalConnectionCount: 0,
          availableConnectionCount: 0,
          waitQueueSize: 0,
          s: {
            totalConnectionCount: 5,
            availableConnectionCount: 2,
            waitQueueSize: 1
          }
        }
      };

      const result = collector._extractPoolStatsFromServer(server);
      expect(result.found).to.be.true;
      expect(result.totalConnections).to.equal(5);
    });
  });

  // ==========================================
  // _recordPoolWaitTime
  // ==========================================
  describe('_recordPoolWaitTime', function () {

    beforeEach(function () {
      delete global._skySignalPoolWaitTimes;
    });

    afterEach(function () {
      delete global._skySignalPoolWaitTimes;
    });

    it('initializes global array and stores sample', function () {
      collector._recordPoolWaitTime(42, { connectionId: 1 });

      expect(global._skySignalPoolWaitTimes).to.be.an('array').with.lengthOf(1);
      expect(global._skySignalPoolWaitTimes[0].waitTime).to.equal(42);
      expect(global._skySignalPoolWaitTimes[0].connectionId).to.equal(1);
    });

    it('limits samples via batch eviction', function () {
      // Eviction triggers at 1100, trims back to 1000
      for (let i = 0; i < 1150; i++) {
        collector._recordPoolWaitTime(i);
      }
      expect(global._skySignalPoolWaitTimes.length).to.be.at.most(1050);
    });
  });

  // ==========================================
  // stop
  // ==========================================
  describe('stop', function () {

    it('clears state and removes listeners', function () {
      collector.started = true;
      collector.snapshotTimer = setInterval(() => {}, 100000);
      collector.poolState.connections.set(1, {});
      collector.checkoutTimes.set('a', []);

      collector.stop();

      expect(collector.snapshotTimer).to.be.null;
      expect(collector.started).to.be.false;
      expect(collector.poolState.connections.size).to.equal(0);
      expect(collector.checkoutTimes.size).to.equal(0);
      expect(collector.poolState.checkoutSampleCount).to.equal(0);
    });

    it('safe to call when not started', function () {
      expect(() => collector.stop()).to.not.throw();
    });
  });
});
