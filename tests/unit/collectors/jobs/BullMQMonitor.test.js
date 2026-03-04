/**
 * BullMQMonitor tests — constructor defaults, option handling,
 * BaseJobMonitor inheritance, _parseReturnValue, composite ID
 * namespacing, event handler mapping, stop() cleanup, manual
 * queue registration, _bootstrapMissedJob, per-queue stats,
 * job cache, detailedTracking option, Redis discovery.
 *
 * Does NOT require real BullMQ/Redis — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import BullMQMonitor from '../../../../lib/collectors/jobs/BullMQMonitor.js';
import BaseJobMonitor from '../../../../lib/collectors/jobs/BaseJobMonitor.js';

describe('BullMQMonitor', function () {

  let monitor;
  let mockClient;

  beforeEach(function () {
    mockClient = {
      _addToBatch: sinon.stub(),
      addCustomMetric: sinon.stub()
    };
    monitor = new BullMQMonitor({
      client: mockClient,
      host: 'test-host',
      appVersion: '1.0.0',
      buildHash: 'abc123'
    });
  });

  afterEach(function () {
    if (monitor.intervalId) {
      clearInterval(monitor.intervalId);
      monitor.intervalId = null;
    }
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      expect(monitor.queueEventsMap).to.be.instanceOf(Map);
      expect(monitor.monitorQueuesMap).to.be.instanceOf(Map);
      expect(monitor.workerConcurrency).to.be.instanceOf(Map);
      expect(monitor.perQueueMetrics).to.be.instanceOf(Map);
      expect(monitor.stalledJobs).to.be.instanceOf(Map);
      expect(monitor.bullmqQueues).to.deep.equal([]);
      expect(monitor.bullmqRedis).to.be.null;
    });

    it('inherits from BaseJobMonitor', function () {
      expect(monitor).to.be.instanceOf(BaseJobMonitor);
      expect(monitor.host).to.equal('test-host');
      expect(monitor.appVersion).to.equal('1.0.0');
      expect(monitor.buildHash).to.equal('abc123');
      expect(monitor.trackedJobs).to.be.instanceOf(Map);
      expect(monitor.jobHistory).to.be.an('array');
    });

    it('accepts bullmqQueues option', function () {
      const queues = [{ name: 'emailQueue', connection: { host: '10.0.0.1', port: 6380 } }];
      const m = new BullMQMonitor({ bullmqQueues: queues });
      expect(m.bullmqQueues).to.deep.equal(queues);
    });

    it('accepts bullmqRedis option', function () {
      const redis = { host: 'redis.example.com', port: 6379 };
      const m = new BullMQMonitor({ bullmqRedis: redis });
      expect(m.bullmqRedis).to.deep.equal(redis);
    });

    it('initializes job cache with defaults', function () {
      expect(monitor._jobCache).to.be.instanceOf(Map);
      expect(monitor._jobCache.size).to.equal(0);
      expect(monitor._jobCacheMaxSize).to.equal(2000);
      expect(monitor._jobCacheTTL).to.equal(120000);
    });

    it('accepts custom cache options', function () {
      const m = new BullMQMonitor({ jobCacheMaxSize: 500, jobCacheTTL: 60000 });
      expect(m._jobCacheMaxSize).to.equal(500);
      expect(m._jobCacheTTL).to.equal(60000);
    });

    it('defaults detailedTracking to true', function () {
      expect(monitor.detailedTracking).to.be.true;
    });

    it('accepts detailedTracking: false', function () {
      const m = new BullMQMonitor({ detailedTracking: false });
      expect(m.detailedTracking).to.be.false;
    });
  });

  // ==========================================
  // getPackageName
  // ==========================================
  describe('getPackageName', function () {

    it('returns bullmq', function () {
      expect(monitor.getPackageName()).to.equal('bullmq');
    });
  });

  // ==========================================
  // isPackageAvailable
  // ==========================================
  describe('isPackageAvailable', function () {

    it('returns a boolean', function () {
      expect(typeof monitor.isPackageAvailable()).to.equal('boolean');
    });
  });

  // ==========================================
  // Job cache
  // ==========================================
  describe('job cache', function () {

    it('_cacheJob stores and _getCachedJob retrieves', function () {
      const jobData = { name: 'sendEmail', data: { to: 'test@test.com' } };
      monitor._cacheJob('email:1', jobData);
      expect(monitor._getCachedJob('email:1')).to.equal(jobData);
    });

    it('_getCachedJob returns null for missing keys', function () {
      expect(monitor._getCachedJob('nonexistent:99')).to.be.null;
    });

    it('_getCachedJob returns null for expired entries', function () {
      const jobData = { name: 'old' };
      monitor._cacheJob('q:1', jobData);
      monitor._jobCache.get('q:1').ts = Date.now() - monitor._jobCacheTTL - 1;
      expect(monitor._getCachedJob('q:1')).to.be.null;
      expect(monitor._jobCache.has('q:1')).to.be.false;
    });

    it('_cacheJob evicts oldest entry when at capacity', function () {
      monitor._jobCacheMaxSize = 3;
      monitor._cacheJob('q:1', { name: 'first' });
      monitor._cacheJob('q:2', { name: 'second' });
      monitor._cacheJob('q:3', { name: 'third' });

      monitor._cacheJob('q:4', { name: 'fourth' });

      expect(monitor._jobCache.size).to.equal(3);
      expect(monitor._getCachedJob('q:1')).to.be.null;
      expect(monitor._getCachedJob('q:4').name).to.equal('fourth');
    });

    it('_evictExpiredCache removes only expired entries', function () {
      monitor._cacheJob('fresh:1', { name: 'fresh' });
      monitor._cacheJob('stale:1', { name: 'stale' });

      monitor._jobCache.get('stale:1').ts = Date.now() - monitor._jobCacheTTL - 1;

      monitor._evictExpiredCache();

      expect(monitor._jobCache.has('fresh:1')).to.be.true;
      expect(monitor._jobCache.has('stale:1')).to.be.false;
    });
  });

  // ==========================================
  // _parseReturnValue
  // ==========================================
  describe('_parseReturnValue', function () {

    it('returns null for null input', function () {
      expect(monitor._parseReturnValue(null)).to.be.null;
    });

    it('returns null for undefined input', function () {
      expect(monitor._parseReturnValue(undefined)).to.be.null;
    });

    it('parses valid JSON string', function () {
      const result = monitor._parseReturnValue('{"status":"ok","count":42}');
      expect(result).to.deep.equal({ status: 'ok', count: 42 });
    });

    it('returns raw string when JSON parsing fails', function () {
      const result = monitor._parseReturnValue('not json');
      expect(result).to.equal('not json');
    });

    it('passes through non-string values', function () {
      expect(monitor._parseReturnValue(42)).to.equal(42);
      expect(monitor._parseReturnValue(true)).to.be.true;
      const obj = { key: 'val' };
      expect(monitor._parseReturnValue(obj)).to.equal(obj);
    });

    it('handles JSON arrays', function () {
      const result = monitor._parseReturnValue('[1,2,3]');
      expect(result).to.deep.equal([1, 2, 3]);
    });

    it('handles empty string', function () {
      const result = monitor._parseReturnValue('');
      expect(result).to.equal('');
    });
  });

  // ==========================================
  // _resolveConnection
  // ==========================================
  describe('_resolveConnection', function () {

    it('prefers queue opts connection', function () {
      const conn = monitor._resolveConnection('test', {
        queueOpts: { connection: { host: 'queue-host', port: 6380 } },
        workerOpts: { connection: { host: 'worker-host', port: 6381 } }
      });
      expect(conn.host).to.equal('queue-host');
      expect(conn.port).to.equal(6380);
    });

    it('falls back to worker opts connection', function () {
      const conn = monitor._resolveConnection('test', {
        queueOpts: {},
        workerOpts: { connection: { host: 'worker-host', port: 6381 } }
      });
      expect(conn.host).to.equal('worker-host');
    });

    it('falls back to manual config connection', function () {
      monitor.bullmqQueues = [{ name: 'test', connection: { host: 'manual-host', port: 6382 } }];
      const conn = monitor._resolveConnection('test', {
        queueOpts: {},
        workerOpts: null
      });
      expect(conn.host).to.equal('manual-host');
    });

    it('falls back to global bullmqRedis', function () {
      monitor.bullmqRedis = { host: 'global-host', port: 6383 };
      const conn = monitor._resolveConnection('test', {
        queueOpts: {},
        workerOpts: null
      });
      expect(conn.host).to.equal('global-host');
    });

    it('defaults to localhost:6379', function () {
      const conn = monitor._resolveConnection('test', {
        queueOpts: {},
        workerOpts: null
      });
      expect(conn.host).to.equal('localhost');
      expect(conn.port).to.equal(6379);
    });
  });

  // ==========================================
  // Composite job ID namespacing
  // ==========================================
  describe('composite job IDs', function () {

    it('trackJobStart uses queueName:jobId format', function () {
      monitor.trackJobStart({
        jobId: 'emailQueue:123',
        jobName: 'sendEmail',
        queuedAt: new Date()
      });

      expect(monitor.trackedJobs.has('emailQueue:123')).to.be.true;
    });

    it('different queues with same numeric jobId are distinct', function () {
      monitor.trackJobStart({
        jobId: 'queueA:1',
        jobName: 'taskA',
        queuedAt: new Date()
      });
      monitor.trackJobStart({
        jobId: 'queueB:1',
        jobName: 'taskB',
        queuedAt: new Date()
      });

      expect(monitor.trackedJobs.size).to.equal(2);
      expect(monitor.trackedJobs.get('queueA:1').jobName).to.equal('taskA');
      expect(monitor.trackedJobs.get('queueB:1').jobName).to.equal('taskB');
    });
  });

  // ==========================================
  // Event handler tracking integration
  // ==========================================
  describe('event handler tracking', function () {

    it('trackJobStart + trackJobComplete lifecycle', function () {
      const compositeId = 'myQueue:42';

      monitor.trackJobStart({
        jobId: compositeId,
        jobName: 'processOrder',
        queuedAt: new Date(Date.now() - 1000)
      });

      expect(monitor.trackedJobs.has(compositeId)).to.be.true;
      expect(mockClient._addToBatch.calledOnce).to.be.true;

      const startEvent = mockClient._addToBatch.firstCall.args[1];
      expect(startEvent.status).to.equal('running');
      expect(startEvent.jobName).to.equal('processOrder');

      monitor.trackJobComplete(compositeId, { orderId: '123' });

      expect(monitor.trackedJobs.has(compositeId)).to.be.false;
      expect(mockClient._addToBatch.calledTwice).to.be.true;

      const completeEvent = mockClient._addToBatch.secondCall.args[1];
      expect(completeEvent.status).to.equal('completed');
      expect(completeEvent.duration).to.be.a('number');
    });

    it('trackJobStart + trackJobFailed lifecycle', function () {
      const compositeId = 'myQueue:99';

      monitor.trackJobStart({
        jobId: compositeId,
        jobName: 'sendEmail',
        queuedAt: new Date()
      });

      monitor.trackJobFailed(compositeId, {
        message: 'SMTP timeout',
        stack: 'Error: SMTP timeout\n  at sendMail',
        attemptsMade: 3
      });

      expect(monitor.trackedJobs.has(compositeId)).to.be.false;
      expect(monitor.metrics.failedJobs).to.equal(1);

      const failEvent = mockClient._addToBatch.secondCall.args[1];
      expect(failEvent.status).to.equal('failed');
      expect(failEvent.error.message).to.equal('SMTP timeout');
    });

    it('trackJobProgress updates tracked job', function () {
      monitor.trackJobStart({
        jobId: 'q:1',
        jobName: 'import',
        queuedAt: new Date()
      });

      monitor.trackJobProgress('q:1', 50);
      expect(monitor.trackedJobs.get('q:1').progress).to.equal(50);

      monitor.trackJobProgress('q:1', 150);
      expect(monitor.trackedJobs.get('q:1').progress).to.equal(100);

      monitor.trackJobProgress('q:1', -10);
      expect(monitor.trackedJobs.get('q:1').progress).to.equal(0);
    });
  });

  // ==========================================
  // stop() cleanup
  // ==========================================
  describe('stop', function () {

    it('clears all maps including job cache', async function () {
      monitor.workerConcurrency.set('q1', 5);
      monitor.perQueueMetrics.set('q1', { completed: 0, failed: 0, stalled: 0 });
      monitor.stalledJobs.set('q1', 2);
      monitor._cacheJob('q1:1', { name: 'test' });

      await monitor.stop();

      expect(monitor.queueEventsMap.size).to.equal(0);
      expect(monitor.monitorQueuesMap.size).to.equal(0);
      expect(monitor.workerConcurrency.size).to.equal(0);
      expect(monitor.perQueueMetrics.size).to.equal(0);
      expect(monitor.stalledJobs.size).to.equal(0);
      expect(monitor._jobCache.size).to.equal(0);
      expect(monitor.started).to.be.false;
    });

    it('calls close on all QueueEvents and Queues', async function () {
      const mockQE = { close: sinon.stub().resolves(), on: sinon.stub() };
      const mockQ = { close: sinon.stub().resolves() };

      monitor.queueEventsMap.set('q1', mockQE);
      monitor.monitorQueuesMap.set('q1', mockQ);

      await monitor.stop();

      expect(mockQE.close.calledOnce).to.be.true;
      expect(mockQ.close.calledOnce).to.be.true;
    });

    it('handles close errors gracefully', async function () {
      const mockQE = { close: sinon.stub().rejects(new Error('conn reset')), on: sinon.stub() };
      const mockQ = { close: sinon.stub().rejects(new Error('already closed')) };

      monitor.queueEventsMap.set('q1', mockQE);
      monitor.monitorQueuesMap.set('q1', mockQ);

      await monitor.stop();

      expect(monitor.queueEventsMap.size).to.equal(0);
    });
  });

  // ==========================================
  // _bootstrapMissedJob
  // ==========================================
  describe('_bootstrapMissedJob', function () {

    it('creates a start event for a job found via fromId', async function () {
      const mockQueue = {};
      const mockJob = {
        name: 'processPayment',
        timestamp: Date.now() - 5000,
        opts: { priority: 5 },
        data: { amount: 100 },
        attemptsMade: 2
      };

      sinon.stub(monitor, '_fetchJobDetails').resolves(mockJob);

      await monitor._bootstrapMissedJob('payments', mockQueue, '77');

      expect(monitor.trackedJobs.has('payments:77')).to.be.true;
      const tracked = monitor.trackedJobs.get('payments:77');
      expect(tracked.jobName).to.equal('processPayment');
      expect(tracked.status).to.equal('running');

      monitor._fetchJobDetails.restore();
    });

    it('uses cache before falling back to fetch', async function () {
      const mockQueue = {};
      const cachedJob = {
        name: 'cachedTask',
        timestamp: Date.now() - 3000,
        opts: { priority: 2 },
        data: { cached: true },
        attemptsMade: 1
      };

      monitor._cacheJob('email:55', cachedJob);

      const fetchStub = sinon.stub(monitor, '_fetchJobDetails').resolves(null);

      await monitor._bootstrapMissedJob('email', mockQueue, '55');

      expect(fetchStub.called).to.be.false;
      expect(monitor.trackedJobs.has('email:55')).to.be.true;
      expect(monitor.trackedJobs.get('email:55').jobName).to.equal('cachedTask');

      fetchStub.restore();
    });

    it('creates a minimal start event when job is not found', async function () {
      sinon.stub(monitor, '_fetchJobDetails').resolves(null);

      await monitor._bootstrapMissedJob('orphan', {}, '999');

      expect(monitor.trackedJobs.has('orphan:999')).to.be.true;
      expect(monitor.trackedJobs.get('orphan:999').jobName).to.equal('unknown');

      monitor._fetchJobDetails.restore();
    });
  });

  // ==========================================
  // Redis queue discovery
  // ==========================================
  describe('_discoverQueuesFromRedis', function () {

    it('handles ioredis not available gracefully', async function () {
      // _discoverQueuesFromRedis tries require("ioredis") — in test env it may
      // or may not be available. Either way, it should not throw.
      await monitor._discoverQueuesFromRedis();
      // No assertion needed — just verifying no exception
    });
  });

  // ==========================================
  // Per-queue stats aggregation
  // ==========================================
  describe('getQueueStats', function () {

    it('returns empty totals when no queues are monitored', async function () {
      const stats = await monitor.getQueueStats();
      expect(stats.queueLength).to.equal(0);
      expect(stats.activeJobs).to.equal(0);
      expect(stats.workersTotal).to.equal(0);
      expect(stats.perQueue).to.deep.equal({});
    });

    it('aggregates counts from multiple queues', async function () {
      const mockQ1 = {
        getJobCounts: sinon.stub().resolves({
          waiting: 10, active: 2, completed: 100, failed: 5, delayed: 3, prioritized: 1
        })
      };
      const mockQ2 = {
        getJobCounts: sinon.stub().resolves({
          waiting: 5, active: 1, completed: 50, failed: 2, delayed: 0, prioritized: 0
        })
      };

      monitor.monitorQueuesMap.set('q1', mockQ1);
      monitor.monitorQueuesMap.set('q2', mockQ2);
      monitor.workerConcurrency.set('q1', 4);
      monitor.workerConcurrency.set('q2', 2);
      monitor.stalledJobs.set('q1', 1);
      monitor.stalledJobs.set('q2', 0);
      monitor.perQueueMetrics.set('q1', { completed: 10, failed: 1, stalled: 1 });
      monitor.perQueueMetrics.set('q2', { completed: 5, failed: 0, stalled: 0 });

      const stats = await monitor.getQueueStats();

      expect(stats.queueLength).to.equal(19);
      expect(stats.activeJobs).to.equal(3);
      expect(stats.workersTotal).to.equal(6);

      expect(stats.perQueue.q1.waiting).to.equal(10);
      expect(stats.perQueue.q1.active).to.equal(2);
      expect(stats.perQueue.q1.stalledInPeriod).to.equal(1);
      expect(stats.perQueue.q1.concurrency).to.equal(4);
      expect(stats.perQueue.q1.completedInPeriod).to.equal(10);

      expect(stats.perQueue.q2.waiting).to.equal(5);
      expect(stats.perQueue.q2.failedInPeriod).to.equal(0);
    });

    it('handles getJobCounts errors gracefully', async function () {
      const mockQ = {
        getJobCounts: sinon.stub().rejects(new Error('Redis down'))
      };

      monitor.monitorQueuesMap.set('broken', mockQ);
      monitor.workerConcurrency.set('broken', 1);
      monitor.stalledJobs.set('broken', 0);
      monitor.perQueueMetrics.set('broken', { completed: 0, failed: 0, stalled: 0 });

      const stats = await monitor.getQueueStats();

      expect(stats.perQueue.broken.error).to.equal('Redis down');
      expect(stats.queueLength).to.equal(0);
    });
  });

  // ==========================================
  // _collectAndSendStats
  // ==========================================
  describe('_collectAndSendStats', function () {

    it('sends stats with perQueue metadata and resets counters', async function () {
      const mockQ = {
        getJobCounts: sinon.stub().resolves({
          waiting: 5, active: 1, completed: 20, failed: 2, delayed: 0, prioritized: 0
        })
      };

      monitor.monitorQueuesMap.set('q1', mockQ);
      monitor.workerConcurrency.set('q1', 2);
      monitor.stalledJobs.set('q1', 3);
      monitor.perQueueMetrics.set('q1', { completed: 8, failed: 1, stalled: 3 });

      // Stub Redis discovery to no-op (no real Redis in tests)
      sinon.stub(monitor, '_discoverQueuesFromRedis').resolves();

      await monitor._collectAndSendStats();

      expect(mockClient.addCustomMetric.calledOnce).to.be.true;
      const metric = mockClient.addCustomMetric.firstCall.args[0];
      expect(metric.name).to.equal('job_queue_stats');
      expect(metric.tags.package).to.equal('bullmq');
      expect(metric.metadata.perQueue.q1).to.exist;
      expect(metric.metadata.activeJobs).to.be.a('number');

      expect(monitor.perQueueMetrics.get('q1').completed).to.equal(0);
      expect(monitor.perQueueMetrics.get('q1').failed).to.equal(0);
      expect(monitor.stalledJobs.get('q1')).to.equal(0);

      monitor._discoverQueuesFromRedis.restore();
    });

    it('evicts expired cache entries during stats collection', async function () {
      const mockQ = {
        getJobCounts: sinon.stub().resolves({
          waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, prioritized: 0
        })
      };
      monitor.monitorQueuesMap.set('q1', mockQ);
      monitor.workerConcurrency.set('q1', 1);
      monitor.stalledJobs.set('q1', 0);
      monitor.perQueueMetrics.set('q1', { completed: 0, failed: 0, stalled: 0 });

      sinon.stub(monitor, '_discoverQueuesFromRedis').resolves();

      monitor._cacheJob('q1:fresh', { name: 'fresh' });
      monitor._cacheJob('q1:stale', { name: 'stale' });
      monitor._jobCache.get('q1:stale').ts = Date.now() - monitor._jobCacheTTL - 1;

      await monitor._collectAndSendStats();

      expect(monitor._jobCache.has('q1:fresh')).to.be.true;
      expect(monitor._jobCache.has('q1:stale')).to.be.false;

      monitor._discoverQueuesFromRedis.restore();
    });
  });

  // ==========================================
  // setupHooks / cleanupHooks compatibility
  // ==========================================
  describe('abstract method stubs', function () {

    it('setupHooks does not throw', function () {
      expect(() => monitor.setupHooks()).to.not.throw();
    });

    it('cleanupHooks does not throw', function () {
      expect(() => monitor.cleanupHooks()).to.not.throw();
    });
  });
});
