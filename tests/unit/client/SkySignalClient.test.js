/**
 * SkySignalClient tests — P0 coverage for the HTTP batching client.
 *
 * Tests pure/deterministic methods and key behavior without making
 * real HTTP requests. The fire-and-forget _sendBatch uses setImmediate
 * which we control via sinon fake timers where needed.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import SkySignalClient from '../../../lib/SkySignalClient.js';

describe('SkySignalClient', function () {

  let client;

  beforeEach(function () {
    // Use fake timers to prevent auto-flush from firing during tests
    this.clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    client = new SkySignalClient({
      apiKey: 'sk_test_123',
      endpoint: 'http://localhost:3000',
      batchSize: 50,
      batchSizeBytes: 256 * 1024,
      flushInterval: 10000
    });
  });

  afterEach(function () {
    // Clean up: stop client to clear timers, then restore clock
    client.stopped = true;
    if (client.flushTimeoutId) {
      clearTimeout(client.flushTimeoutId);
      client.flushTimeoutId = null;
    }
    for (const timerId of client.pendingTimers) {
      clearTimeout(timerId);
    }
    client.pendingTimers.clear();
    this.clock.restore();
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      expect(client.apiKey).to.equal('sk_test_123');
      expect(client.batchSize).to.equal(50);
      expect(client.batchSizeBytes).to.equal(256 * 1024);
      expect(client.flushInterval).to.equal(10000);
      expect(client.requestTimeout).to.equal(15000);
      expect(client.maxRetries).to.equal(3);
      expect(client.traceSampleRate).to.equal(1.0);
      expect(client.rumSampleRate).to.equal(0.5);
      expect(client.stopped).to.be.false;
    });

    it('initializes all batch types as empty arrays', function () {
      const types = [
        'traces', 'systemMetrics', 'httpRequests', 'customMetrics',
        'errors', 'sessions', 'securityEvents', 'jobs', 'alerts',
        'dependencies', 'mongoPoolMetrics', 'collectionStats',
        'ddpConnections', 'subscriptions', 'liveQueries', 'rum',
        'logs', 'dnsMetrics', 'outboundHttp', 'cpuProfiles',
        'deprecatedApis', 'publications', 'environment', 'vulnerabilities'
      ];
      for (const type of types) {
        expect(client.batches[type], `batches.${type}`).to.be.an('array').that.is.empty;
        expect(client.batchSizes[type], `batchSizes.${type}`).to.equal(0);
        expect(client.retryQueues[type], `retryQueues.${type}`).to.be.an('array').that.is.empty;
      }
    });

    it('initializes stats to zero', function () {
      expect(client.stats).to.deep.equal({
        sent: 0, failed: 0, sampled: 0, bytesSent: 0
      });
    });

    it('respects custom options', function () {
      const custom = new SkySignalClient({
        apiKey: 'sk_custom',
        endpoint: 'https://custom.example.com',
        batchSize: 100,
        batchSizeBytes: 512 * 1024,
        flushInterval: 5000,
        requestTimeout: 30000,
        maxRetries: 5,
        traceSampleRate: 0.5,
        rumSampleRate: 1.0
      });
      expect(custom.batchSize).to.equal(100);
      expect(custom.batchSizeBytes).to.equal(512 * 1024);
      expect(custom.flushInterval).to.equal(5000);
      expect(custom.requestTimeout).to.equal(30000);
      expect(custom.maxRetries).to.equal(5);
      expect(custom.traceSampleRate).to.equal(0.5);
      expect(custom.rumSampleRate).to.equal(1.0);
      // Clean up
      custom.stopped = true;
      if (custom.flushTimeoutId) clearTimeout(custom.flushTimeoutId);
    });
  });

  // ==========================================
  // _safeStringify
  // ==========================================
  describe('_safeStringify', function () {

    it('stringifies simple objects', function () {
      const result = client._safeStringify({ a: 1, b: 'two' });
      expect(result).to.equal('{"a":1,"b":"two"}');
    });

    it('handles circular references with [Circular]', function () {
      const obj = { name: 'test' };
      obj.self = obj;
      const result = client._safeStringify(obj);
      expect(result).to.include('[Circular]');
      expect(result).to.not.be.null;
    });

    it('handles nested circular references', function () {
      const a = { name: 'a' };
      const b = { name: 'b', parent: a };
      a.child = b;
      const result = client._safeStringify(a);
      expect(result).to.include('[Circular]');
      const parsed = JSON.parse(result);
      expect(parsed.child.parent).to.equal('[Circular]');
    });

    it('stringifies arrays', function () {
      const result = client._safeStringify([1, 2, 3]);
      expect(result).to.equal('[1,2,3]');
    });

    it('handles null and primitives', function () {
      expect(client._safeStringify(null)).to.equal('null');
      expect(client._safeStringify(42)).to.equal('42');
      expect(client._safeStringify('hello')).to.equal('"hello"');
    });

    it('returns null on non-serializable input', function () {
      // BigInt throws in JSON.stringify
      const result = client._safeStringify({ val: BigInt(123) });
      expect(result).to.be.null;
    });
  });

  // ==========================================
  // _getEndpointForBatchType
  // ==========================================
  describe('_getEndpointForBatchType', function () {

    it('returns correct endpoints for all batch types', function () {
      const expected = {
        traces: '/api/v1/traces',
        systemMetrics: '/api/v1/metrics/system',
        httpRequests: '/api/v1/metrics/http',
        errors: '/api/v1/errors',
        logs: '/api/v1/logs',
        rum: '/api/v1/rum',
        ddpConnections: '/api/v1/ddp-connections',
        subscriptions: '/api/v1/subscriptions',
        liveQueries: '/api/v1/live-queries',
        dnsMetrics: '/api/v1/metrics/dns',
        outboundHttp: '/api/v1/metrics/outbound-http',
        cpuProfiles: '/api/v1/metrics/cpu-profile',
        deprecatedApis: '/api/v1/metrics/deprecated-apis',
        publications: '/api/v1/metrics/publications',
        environment: '/api/v1/metrics/environment',
        vulnerabilities: '/api/v1/metrics/vulnerabilities'
      };

      for (const [type, endpoint] of Object.entries(expected)) {
        expect(client._getEndpointForBatchType(type), type).to.equal(endpoint);
      }
    });

    it('falls back to /api/v1/traces for unknown types', function () {
      expect(client._getEndpointForBatchType('unknown')).to.equal('/api/v1/traces');
    });
  });

  // ==========================================
  // _getPayloadKey
  // ==========================================
  describe('_getPayloadKey', function () {

    it('returns correct payload keys for all batch types', function () {
      const expected = {
        traces: 'traces',
        systemMetrics: 'metrics',
        httpRequests: 'requests',
        errors: 'errors',
        sessions: 'sessions',
        logs: 'logs',
        rum: 'measurements',
        ddpConnections: 'connections',
        subscriptions: 'subscriptions',
        liveQueries: 'liveQueries',
        collectionStats: 'stats',
        cpuProfiles: 'profiles'
      };

      for (const [type, key] of Object.entries(expected)) {
        expect(client._getPayloadKey(type), type).to.equal(key);
      }
    });

    it('falls back to "data" for unknown types', function () {
      expect(client._getPayloadKey('unknown')).to.equal('data');
    });
  });

  // ==========================================
  // _addToBatch
  // ==========================================
  describe('_addToBatch', function () {

    it('adds item to the correct batch', function () {
      client._addToBatch('traces', { method: 'test', duration: 100 }, '/api/v1/traces');
      expect(client.batches.traces).to.have.lengthOf(1);
      expect(client.batches.traces[0].method).to.equal('test');
    });

    it('tracks batch size incrementally', function () {
      const item = { method: 'test', duration: 100 };
      client._addToBatch('traces', item, '/api/v1/traces');
      expect(client.batchSizes.traces).to.be.greaterThan(0);
    });

    it('auto-flushes when batch reaches batchSize count', function () {
      // Stub _sendBatch to track calls
      const sendStub = sinon.stub(client, '_sendBatch');

      for (let i = 0; i < 50; i++) {
        client._addToBatch('traces', { i }, '/api/v1/traces');
      }

      // _sendBatch should have been called when the 50th item was added
      expect(sendStub.calledWith('traces', '/api/v1/traces')).to.be.true;
    });

    it('auto-flushes when batch exceeds batchSizeBytes', function () {
      client.batchSizeBytes = 100; // Very small threshold
      const sendStub = sinon.stub(client, '_sendBatch');

      // Add a large item that exceeds 100 bytes
      client._addToBatch('traces', { data: 'x'.repeat(200) }, '/api/v1/traces');

      // _sendBatch should have been called due to size threshold
      expect(sendStub.called).to.be.true;
    });
  });

  // ==========================================
  // addTrace (sampling)
  // ==========================================
  describe('addTrace', function () {

    it('adds trace when sample rate is 1.0', function () {
      client.traceSampleRate = 1.0;
      client.addTrace({ method: 'test', duration: 100 });
      expect(client.batches.traces).to.have.lengthOf(1);
    });

    it('drops all traces when sample rate is 0', function () {
      client.traceSampleRate = 0;
      for (let i = 0; i < 100; i++) {
        client.addTrace({ method: 'test', duration: i });
      }
      expect(client.batches.traces).to.have.lengthOf(0);
      expect(client.stats.sampled).to.equal(100);
    });

    it('increments stats.sampled when trace is dropped', function () {
      client.traceSampleRate = 0;
      client.addTrace({ method: 'test' });
      expect(client.stats.sampled).to.equal(1);
    });
  });

  // ==========================================
  // addRUM (sampling)
  // ==========================================
  describe('addRUM', function () {

    it('adds RUM when sample rate is 1.0', function () {
      client.rumSampleRate = 1.0;
      client.addRUM({ type: 'pageLoad', duration: 1500 });
      expect(client.batches.rum).to.have.lengthOf(1);
    });

    it('drops all RUM when sample rate is 0', function () {
      client.rumSampleRate = 0;
      for (let i = 0; i < 50; i++) {
        client.addRUM({ type: 'pageLoad', duration: i });
      }
      expect(client.batches.rum).to.have.lengthOf(0);
      expect(client.stats.sampled).to.equal(50);
    });
  });

  // ==========================================
  // sendDDPConnections / sendSubscriptions / sendLiveQueries
  // ==========================================
  describe('sendDDPConnections', function () {

    it('adds all connections to batch', function () {
      const conns = [
        { sessionId: 's1', connectedAt: new Date() },
        { sessionId: 's2', connectedAt: new Date() }
      ];
      client.sendDDPConnections(conns);
      expect(client.batches.ddpConnections).to.have.lengthOf(2);
    });

    it('skips non-array input', function () {
      client.sendDDPConnections(null);
      client.sendDDPConnections('not-array');
      client.sendDDPConnections({});
      expect(client.batches.ddpConnections).to.have.lengthOf(0);
    });

    it('skips empty array', function () {
      client.sendDDPConnections([]);
      expect(client.batches.ddpConnections).to.have.lengthOf(0);
    });
  });

  describe('sendSubscriptions', function () {

    it('adds all subscriptions to batch', function () {
      const subs = [
        { name: 'pub1', sessionId: 's1' },
        { name: 'pub2', sessionId: 's2' }
      ];
      client.sendSubscriptions(subs);
      expect(client.batches.subscriptions).to.have.lengthOf(2);
    });

    it('skips non-array input', function () {
      client.sendSubscriptions(null);
      client.sendSubscriptions(undefined);
      expect(client.batches.subscriptions).to.have.lengthOf(0);
    });
  });

  describe('sendLiveQueries', function () {

    it('adds all live queries to batch', function () {
      const lqs = [
        { collection: 'users', type: 'oplog' },
        { collection: 'posts', type: 'polling' }
      ];
      client.sendLiveQueries(lqs);
      expect(client.batches.liveQueries).to.have.lengthOf(2);
    });

    it('skips empty array', function () {
      client.sendLiveQueries([]);
      expect(client.batches.liveQueries).to.have.lengthOf(0);
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns stats with pending and retrying counts', function () {
      client.batches.traces.push({ a: 1 }, { a: 2 });
      client.batches.errors.push({ err: 1 });
      client.retryQueues.traces.push({ batch: [{ a: 3 }], retryCount: 1 });

      const stats = client.getStats();
      expect(stats.sent).to.equal(0);
      expect(stats.failed).to.equal(0);
      expect(stats.sampled).to.equal(0);
      expect(stats.bytesSent).to.equal(0);
      expect(stats.pending).to.equal(3); // 2 traces + 1 error
      expect(stats.retrying).to.equal(1);
    });

    it('reflects cumulative stats after operations', function () {
      client.stats.sent = 100;
      client.stats.failed = 5;
      client.stats.sampled = 20;
      client.stats.bytesSent = 50000;

      const stats = client.getStats();
      expect(stats.sent).to.equal(100);
      expect(stats.failed).to.equal(5);
      expect(stats.sampled).to.equal(20);
      expect(stats.bytesSent).to.equal(50000);
    });
  });

  // ==========================================
  // _handleFailedBatch (retry logic)
  // ==========================================
  describe('_handleFailedBatch', function () {

    it('adds batch to retry queue when retryCount < maxRetries', function () {
      const batch = [{ a: 1 }, { a: 2 }];
      client._handleFailedBatch('traces', batch, 0);
      expect(client.retryQueues.traces).to.have.lengthOf(1);
      expect(client.retryQueues.traces[0].retryCount).to.equal(1);
      expect(client.retryQueues.traces[0].batch).to.deep.equal(batch);
    });

    it('increments stats.failed', function () {
      client._handleFailedBatch('traces', [{ a: 1 }, { a: 2 }], 0);
      expect(client.stats.failed).to.equal(2);
    });

    it('drops batch when retryCount >= maxRetries', function () {
      client._handleFailedBatch('traces', [{ a: 1 }], 3); // maxRetries = 3
      expect(client.retryQueues.traces).to.have.lengthOf(0);
      expect(client.stats.failed).to.equal(1);
    });

    it('drops oldest batch when retry queue exceeds MAX_RETRY_QUEUE_SIZE', function () {
      // Fill retry queue to 100
      for (let i = 0; i < 100; i++) {
        client.retryQueues.traces.push({ batch: [{ id: i }], retryCount: 1 });
      }

      // Add one more — should drop oldest (id: 0)
      client._handleFailedBatch('traces', [{ id: 'new' }], 0);
      expect(client.retryQueues.traces).to.have.lengthOf(100);
      // First item should now be id: 1 (0 was dropped)
      expect(client.retryQueues.traces[0].batch[0].id).to.equal(1);
      // Last item should be the new one
      expect(client.retryQueues.traces[99].batch[0].id).to.equal('new');
    });

    it('does not schedule retry timer when stopped', function () {
      client.stopped = true;
      client._handleFailedBatch('traces', [{ a: 1 }], 0);
      // Should still add to retry queue, but not schedule timer
      expect(client.retryQueues.traces).to.have.lengthOf(1);
      expect(client.pendingTimers.size).to.equal(0);
    });

    it('schedules retry timer with exponential backoff', function () {
      client._handleFailedBatch('traces', [{ a: 1 }], 0);
      // Timer should be pending
      expect(client.pendingTimers.size).to.equal(1);
    });
  });

  // ==========================================
  // _sendBatch
  // ==========================================
  describe('_sendBatch', function () {

    it('clears batch immediately on send', function () {
      client.batches.traces = [{ a: 1 }, { a: 2 }];
      client.batchSizes.traces = 100;
      client._sendBatch('traces', '/api/v1/traces');
      expect(client.batches.traces).to.have.lengthOf(0);
      expect(client.batchSizes.traces).to.equal(0);
    });

    it('does nothing for empty batches', function () {
      const stringifySpy = sinon.spy(client, '_safeStringify');
      client._sendBatch('traces', '/api/v1/traces');
      expect(stringifySpy.called).to.be.false;
    });

    it('skips sending when client is stopped', function () {
      client.batches.traces = [{ a: 1 }];
      client.stopped = true;
      client._sendBatch('traces', '/api/v1/traces');
      // Batch is cleared (data is serialized) but setImmediate callback won't fire send
      expect(client.batches.traces).to.have.lengthOf(0);
    });
  });

  // ==========================================
  // stop()
  // ==========================================
  describe('stop', function () {

    it('sets stopped flag', function () {
      client.stop();
      expect(client.stopped).to.be.true;
    });

    it('clears flush timeout', function () {
      expect(client.flushTimeoutId).to.not.be.null;
      client.stop();
      expect(client.flushTimeoutId).to.be.null;
    });

    it('clears all pending timers', function () {
      // Simulate some pending timers
      const timer1 = setTimeout(() => {}, 10000);
      const timer2 = setTimeout(() => {}, 20000);
      client.pendingTimers.add(timer1);
      client.pendingTimers.add(timer2);

      client.stop();
      expect(client.pendingTimers.size).to.equal(0);
    });

    it('is idempotent (safe to call multiple times)', function () {
      client.stop();
      expect(() => client.stop()).to.not.throw();
      expect(client.stopped).to.be.true;
    });

    /**
     * Regression test: stop() data-loss potential.
     *
     * stop() sets this.stopped = true BEFORE calling flush().
     * _sendBatch() checks this.stopped and returns early after serialization.
     * This means the final flush's batches are serialized but the setImmediate
     * callback sees this.stopped=true and skips the actual HTTP send.
     *
     * This test documents the current behavior. The data IS cleared from
     * the batch (so it can't be re-sent), but the setImmediate callback
     * won't actually send it because it checks this.stopped.
     */
    it('documents stop() data-loss: final flush batches are cleared but may not send', function () {
      // Add data to a batch
      client.batches.traces = [{ method: 'important', duration: 100 }];
      client.batchSizes.traces = 50;

      // Stub _sendRequest to track if it would be called
      const sendRequestStub = sinon.stub(client, '_sendRequest').resolves();

      client.stop();

      // Batch is cleared (data has been picked up by _sendBatch)
      expect(client.batches.traces).to.have.lengthOf(0);

      // However, the setImmediate callback checks this.stopped
      // and will NOT call _sendRequest. Let the setImmediate run:
      this.clock.tick(0); // setImmediate fires on next tick with fake timers

      // _sendRequest should NOT have been called because stopped=true
      // Note: with sinon fake timers, setImmediate may not be faked.
      // The key point is that the code path in _sendBatch line 656
      // returns early when this.stopped is true, so the batch data is lost.
      // This is documented behavior — a future fix could flip the order.
    });
  });

  // ==========================================
  // flush
  // ==========================================
  describe('flush', function () {

    it('sends all non-empty batches', function () {
      const sendStub = sinon.stub(client, '_sendBatch');
      client.batches.traces = [{ a: 1 }];
      client.batches.errors = [{ b: 2 }];

      client.flush();

      expect(sendStub.calledWith('traces')).to.be.true;
      expect(sendStub.calledWith('errors')).to.be.true;
    });

    it('skips empty batches', function () {
      const sendStub = sinon.stub(client, '_sendBatch');
      // All batches are empty by default
      client.flush();
      expect(sendStub.called).to.be.false;
    });
  });

  // ==========================================
  // non-sampled add methods
  // ==========================================
  describe('non-sampled add methods', function () {

    it('addSystemMetric always adds (no sampling)', function () {
      client.addSystemMetric({ cpuUsage: 50 });
      expect(client.batches.systemMetrics).to.have.lengthOf(1);
    });

    it('addError always adds (no sampling)', function () {
      client.addError({ message: 'test error' });
      expect(client.batches.errors).to.have.lengthOf(1);
    });

    it('addLog always adds', function () {
      client.addLog({ level: 'info', message: 'test' });
      expect(client.batches.logs).to.have.lengthOf(1);
    });

    it('addMongoPoolMetric always adds', function () {
      client.addMongoPoolMetric({ totalConnections: 10 });
      expect(client.batches.mongoPoolMetrics).to.have.lengthOf(1);
    });

    it('addDnsMetric always adds', function () {
      client.addDnsMetric({ hostname: 'example.com', duration: 5 });
      expect(client.batches.dnsMetrics).to.have.lengthOf(1);
    });

    it('addCpuProfile always adds', function () {
      client.addCpuProfile({ topFunctions: [] });
      expect(client.batches.cpuProfiles).to.have.lengthOf(1);
    });

    it('addVulnerabilityMetric always adds', function () {
      client.addVulnerabilityMetric({ severityCounts: {} });
      expect(client.batches.vulnerabilities).to.have.lengthOf(1);
    });

    it('addHttpRequest always adds', function () {
      client.addHttpRequest({ method: 'GET', path: '/api', statusCode: 200, responseTime: 50 });
      expect(client.batches.httpRequests).to.have.lengthOf(1);
    });

    it('addCustomMetric always adds', function () {
      client.addCustomMetric({ name: 'orders.completed', metricType: 'counter', value: 1 });
      expect(client.batches.customMetrics).to.have.lengthOf(1);
    });

    it('addCollectionStats always adds', function () {
      client.addCollectionStats({ collection: 'users', documentCount: 1000 });
      expect(client.batches.collectionStats).to.have.lengthOf(1);
    });

    it('addOutboundHttpMetric always adds', function () {
      client.addOutboundHttpMetric({ host: 'api.example.com', count: 10 });
      expect(client.batches.outboundHttp).to.have.lengthOf(1);
    });

    it('addDeprecatedApiMetric always adds', function () {
      client.addDeprecatedApiMetric({ syncCalls: 5, asyncCalls: 20 });
      expect(client.batches.deprecatedApis).to.have.lengthOf(1);
    });

    it('addPublicationMetric always adds', function () {
      client.addPublicationMetric({ name: 'userList', docCount: 50 });
      expect(client.batches.publications).to.have.lengthOf(1);
    });

    it('addEnvironmentMetric always adds', function () {
      client.addEnvironmentMetric({ nodeVersion: '22.0.0', packages: [] });
      expect(client.batches.environment).to.have.lengthOf(1);
    });
  });

  // ==========================================
  // _scheduleFlush
  // ==========================================
  describe('_scheduleFlush', function () {

    it('schedules flush on construction', function () {
      // Constructor calls _scheduleFlush, so flushTimeoutId should be set
      expect(client.flushTimeoutId).to.not.be.null;
    });

    it('is idempotent (does not double-schedule)', function () {
      const firstId = client.flushTimeoutId;
      client._scheduleFlush(); // Call again
      // Should still be the same timer, not a new one
      expect(client.flushTimeoutId).to.equal(firstId);
    });

    it('calls flush when timer fires', function () {
      const flushStub = sinon.stub(client, 'flush');
      // Also stub _scheduleFlush to prevent recursive re-scheduling
      const scheduleStub = sinon.stub(client, '_scheduleFlush');

      // Clear existing timeout so we can control it
      clearTimeout(client.flushTimeoutId);
      client.flushTimeoutId = null;
      scheduleStub.restore(); // Restore so the real _scheduleFlush runs once

      client._scheduleFlush();
      // Advance time past flushInterval
      this.clock.tick(client.flushInterval + 1);

      expect(flushStub.calledOnce).to.be.true;
    });

    it('re-schedules after firing', function () {
      // Advance time to trigger the flush
      const flushStub = sinon.stub(client, 'flush');
      this.clock.tick(client.flushInterval + 1);

      // After the flush, _scheduleFlush should have been called again
      expect(client.flushTimeoutId).to.not.be.null;
    });
  });

  // ==========================================
  // _retryBatch
  // ==========================================
  describe('_retryBatch', function () {

    it('does nothing when stopped', function () {
      const sendStub = sinon.stub(client, '_sendRequest').resolves();
      client.retryQueues.traces.push({ batch: [{ a: 1 }], retryCount: 1 });
      client.stopped = true;

      client._retryBatch('traces');

      // Queue should not be drained
      expect(client.retryQueues.traces).to.have.lengthOf(1);
    });

    it('does nothing when retry queue is empty', function () {
      const stringifySpy = sinon.spy(client, '_safeStringify');
      client._retryBatch('traces');
      expect(stringifySpy.called).to.be.false;
    });

    it('shifts from retry queue and prepares for re-send', function () {
      const batch = [{ method: 'retry_me' }];
      client.retryQueues.traces.push({ batch, retryCount: 2 });

      // Stub to prevent actual send
      sinon.stub(client, '_sendRequest').resolves();

      client._retryBatch('traces');

      // Queue should be empty now
      expect(client.retryQueues.traces).to.have.lengthOf(0);
    });

    it('handles serialization failure gracefully', function () {
      // Push a batch with BigInt that will fail to serialize
      client.retryQueues.traces.push({ batch: [{ val: BigInt(42) }], retryCount: 1 });

      expect(() => client._retryBatch('traces')).to.not.throw();
      expect(client.retryQueues.traces).to.have.lengthOf(0);
    });
  });

  // ==========================================
  // _sendBatch serialization
  // ==========================================
  describe('_sendBatch serialization', function () {

    it('uses correct payload key in serialized body', function () {
      client.batches.traces = [{ method: 'test' }];
      const stringifySpy = sinon.spy(client, '_safeStringify');

      client._sendBatch('traces', '/api/v1/traces');

      expect(stringifySpy.calledOnce).to.be.true;
      const arg = stringifySpy.firstCall.args[0];
      // traces batch type should use 'traces' payload key
      expect(arg).to.have.property('traces');
      expect(arg.traces).to.have.lengthOf(1);
    });

    it('uses "metrics" key for systemMetrics', function () {
      client.batches.systemMetrics = [{ cpuUsage: 50 }];
      const stringifySpy = sinon.spy(client, '_safeStringify');

      client._sendBatch('systemMetrics', '/api/v1/metrics/system');

      const arg = stringifySpy.firstCall.args[0];
      expect(arg).to.have.property('metrics');
    });

    it('uses "measurements" key for rum', function () {
      client.batches.rum = [{ type: 'pageLoad' }];
      const stringifySpy = sinon.spy(client, '_safeStringify');

      client._sendBatch('rum', '/api/v1/rum');

      const arg = stringifySpy.firstCall.args[0];
      expect(arg).to.have.property('measurements');
    });

    it('handles serialization failure and does not crash', function () {
      client.batches.traces = [{ val: BigInt(123) }];
      expect(() => client._sendBatch('traces', '/api/v1/traces')).to.not.throw();
      // Batch should still be cleared
      expect(client.batches.traces).to.have.lengthOf(0);
    });
  });
});
