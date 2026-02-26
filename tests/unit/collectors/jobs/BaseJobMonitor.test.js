/**
 * BaseJobMonitor tests — job tracking lifecycle, type inference,
 * data sanitization, error formatting, history management, metrics.
 *
 * JobCollector factory — adapter registration, getSupportedPackages.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import BaseJobMonitor from '../../../../lib/collectors/jobs/BaseJobMonitor.js';

describe('BaseJobMonitor', function () {

  let monitor;
  let mockClient;

  beforeEach(function () {
    mockClient = {
      _addToBatch: sinon.stub(),
      addCustomMetric: sinon.stub()
    };
    monitor = new BaseJobMonitor({
      client: mockClient,
      host: 'test-host',
      appVersion: '1.0.0',
      buildHash: 'abc123'
    });
  });

  afterEach(function () {
    if (monitor.started) monitor.stop();
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      const m = new BaseJobMonitor({});
      expect(m.host).to.equal('unknown-host');
      expect(m.appVersion).to.equal('unknown');
      expect(m.buildHash).to.be.null;
      expect(m.enabled).to.be.true;
      expect(m.debug).to.be.false;
      expect(m.interval).to.equal(30000);
      expect(m.maxHistorySize).to.equal(1000);
      expect(m.started).to.be.false;
      expect(m.trackedJobs).to.be.instanceOf(Map);
      expect(m.jobHistory).to.be.an('array').that.is.empty;
    });

    it('respects custom options', function () {
      const m = new BaseJobMonitor({
        host: 'my-host',
        appVersion: '2.0',
        buildHash: 'xyz',
        enabled: false,
        debug: true,
        interval: 60000,
        maxHistorySize: 500
      });
      expect(m.host).to.equal('my-host');
      expect(m.appVersion).to.equal('2.0');
      expect(m.enabled).to.be.false;
      expect(m.debug).to.be.true;
      expect(m.interval).to.equal(60000);
      expect(m.maxHistorySize).to.equal(500);
    });

    it('initializes metrics accumulator', function () {
      expect(monitor.metrics).to.deep.equal({
        totalJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        totalDuration: 0,
        longestDuration: 0
      });
    });
  });

  // ==========================================
  // start / stop lifecycle
  // ==========================================
  describe('start / stop', function () {

    it('does not start when disabled', function () {
      const m = new BaseJobMonitor({ enabled: false });
      m.start();
      expect(m.started).to.be.false;
      expect(m.intervalId).to.be.null;
    });

    it('starts and sets interval', function () {
      monitor.start();
      expect(monitor.started).to.be.true;
      expect(monitor.intervalId).to.not.be.null;
      monitor.stop();
    });

    it('is idempotent (second start is no-op)', function () {
      monitor.start();
      const firstId = monitor.intervalId;
      monitor.start(); // should warn and no-op
      expect(monitor.intervalId).to.equal(firstId);
      monitor.stop();
    });

    it('stop clears interval and flushes pending jobs', function () {
      monitor.start();
      // Add a tracked job
      monitor.trackedJobs.set('j1', {
        jobId: 'j1', jobName: 'test', status: 'running', host: 'h'
      });
      monitor.stop();
      expect(monitor.started).to.be.false;
      expect(monitor.intervalId).to.be.null;
      expect(monitor.trackedJobs.size).to.equal(0);
    });

    it('flushPendingJobs marks running jobs as unknown', function () {
      monitor.trackedJobs.set('j1', {
        jobId: 'j1', jobName: 'test', status: 'running'
      });
      monitor._flushPendingJobs();
      // Should have sent one event with status 'unknown'
      expect(mockClient._addToBatch.calledOnce).to.be.true;
      const job = mockClient._addToBatch.firstCall.args[1];
      expect(job.status).to.equal('unknown');
    });
  });

  // ==========================================
  // abstract methods
  // ==========================================
  describe('abstract methods', function () {

    it('getPackageName throws', function () {
      expect(() => monitor.getPackageName()).to.throw('must be implemented');
    });

    it('isPackageAvailable throws', function () {
      expect(() => monitor.isPackageAvailable()).to.throw('must be implemented');
    });

    it('getQueueStats throws', async function () {
      try {
        await monitor.getQueueStats();
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.message).to.include('must be implemented');
      }
    });

    it('setupHooks throws', function () {
      expect(() => monitor.setupHooks()).to.throw('must be implemented');
    });

    it('cleanupHooks does not throw (optional)', function () {
      expect(() => monitor.cleanupHooks()).to.not.throw();
    });
  });

  // ==========================================
  // _inferJobType
  // ==========================================
  describe('_inferJobType', function () {

    it('returns "email" for email-related names', function () {
      expect(monitor._inferJobType('sendEmail')).to.equal('email');
      expect(monitor._inferJobType('mail-dispatch')).to.equal('email');
    });

    it('returns "report" for report names', function () {
      expect(monitor._inferJobType('generate-report')).to.equal('report');
      expect(monitor._inferJobType('dailyreport')).to.equal('report');
    });

    it('returns "maintenance" for cleanup/purge', function () {
      expect(monitor._inferJobType('cleanup-old-data')).to.equal('maintenance');
      expect(monitor._inferJobType('purgeExpired')).to.equal('maintenance');
    });

    it('returns "sync" for sync names', function () {
      expect(monitor._inferJobType('syncUsers')).to.equal('sync');
    });

    it('returns "data-transfer" for import/export', function () {
      expect(monitor._inferJobType('importCSV')).to.equal('data-transfer');
      expect(monitor._inferJobType('exportData')).to.equal('data-transfer');
    });

    it('returns "notification" for notification/notify', function () {
      expect(monitor._inferJobType('send-notification')).to.equal('notification');
      expect(monitor._inferJobType('notify-admin')).to.equal('notification');
    });

    it('returns "processing" for process names', function () {
      expect(monitor._inferJobType('processPayment')).to.equal('processing');
    });

    it('returns "general" for unrecognized names', function () {
      expect(monitor._inferJobType('doSomething')).to.equal('general');
    });

    it('returns "unknown" for null/undefined', function () {
      expect(monitor._inferJobType(null)).to.equal('unknown');
      expect(monitor._inferJobType(undefined)).to.equal('unknown');
    });
  });

  // ==========================================
  // _sanitizeJobData
  // ==========================================
  describe('_sanitizeJobData', function () {

    it('returns null for null/undefined', function () {
      expect(monitor._sanitizeJobData(null)).to.be.null;
      expect(monitor._sanitizeJobData(undefined)).to.be.null;
    });

    it('redacts sensitive keys', function () {
      const data = {
        userId: '123',
        password: 'secret123',
        api_key: 'key-abc',
        token: 'tok-xyz',
        name: 'Test'
      };
      const result = monitor._sanitizeJobData(data);
      expect(result.userId).to.equal('123');
      expect(result.name).to.equal('Test');
      expect(result.password).to.equal('[REDACTED]');
      expect(result.api_key).to.equal('[REDACTED]');
      expect(result.token).to.equal('[REDACTED]');
    });

    it('does NOT redact camelCase apiKey (case-sensitive matching bug)', function () {
      // The sensitive keys list has "apiKey" but comparison lowercases the data key,
      // so "apikey".includes("apiKey") is false. This documents actual behavior.
      const data = { apiKey: 'key-abc' };
      const result = monitor._sanitizeJobData(data);
      expect(result.apiKey).to.equal('key-abc');
    });

    it('redacts nested sensitive keys', function () {
      const data = {
        config: {
          secret: 'hidden',
          endpoint: 'https://example.com'
        }
      };
      const result = monitor._sanitizeJobData(data);
      expect(result.config.secret).to.equal('[REDACTED]');
      expect(result.config.endpoint).to.equal('https://example.com');
    });

    it('does not mutate original data', function () {
      const data = { password: 'original' };
      monitor._sanitizeJobData(data);
      expect(data.password).to.equal('original');
    });

    it('handles circular references gracefully', function () {
      const data = { a: 1 };
      data.self = data;
      const result = monitor._sanitizeJobData(data);
      // JSON.parse(JSON.stringify) will throw, caught by try/catch
      expect(result).to.deep.equal({ error: 'Could not serialize job data' });
    });
  });

  // ==========================================
  // _formatError
  // ==========================================
  describe('_formatError', function () {

    it('returns null for null/undefined', function () {
      expect(monitor._formatError(null)).to.be.null;
      expect(monitor._formatError(undefined)).to.be.null;
    });

    it('formats Error instances with message, name, stack', function () {
      const err = new Error('something broke');
      const result = monitor._formatError(err);
      expect(result.message).to.equal('something broke');
      expect(result.name).to.equal('Error');
      expect(result.stack).to.be.a('string');
    });

    it('limits stack trace to 10 lines', function () {
      const err = new Error('test');
      // Create a long fake stack
      err.stack = Array.from({ length: 20 }, (_, i) => `  at line ${i}`).join('\n');
      const result = monitor._formatError(err);
      expect(result.stack.split('\n')).to.have.lengthOf(10);
    });

    it('formats string errors', function () {
      const result = monitor._formatError('something went wrong');
      expect(result).to.deep.equal({ message: 'something went wrong' });
    });

    it('formats plain objects', function () {
      const result = monitor._formatError({ code: 500, details: 'fail' });
      expect(result.message).to.equal('Unknown error');
      expect(result.code).to.equal(500);
      expect(result.details).to.equal('fail');
    });

    it('uses message from object if available', function () {
      const result = monitor._formatError({ message: 'explicit msg' });
      expect(result.message).to.equal('explicit msg');
    });
  });

  // ==========================================
  // trackJobStart
  // ==========================================
  describe('trackJobStart', function () {

    it('adds job to trackedJobs map', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'sendEmail' });
      expect(monitor.trackedJobs.has('j1')).to.be.true;
      const job = monitor.trackedJobs.get('j1');
      expect(job.status).to.equal('running');
      expect(job.jobType).to.equal('email');
      expect(job.host).to.equal('test-host');
    });

    it('sends job event via client._addToBatch', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      expect(mockClient._addToBatch.calledOnce).to.be.true;
      expect(mockClient._addToBatch.firstCall.args[0]).to.equal('jobs');
    });

    it('calculates queue delay from queuedAt', function () {
      const queuedAt = new Date(Date.now() - 5000);
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test', queuedAt });
      const job = monitor.trackedJobs.get('j1');
      expect(job.delay).to.be.at.least(4900); // allow small timing variance
    });

    it('sanitizes job data', function () {
      monitor.trackJobStart({
        jobId: 'j1', jobName: 'test',
        data: { userId: '123', password: 'secret' }
      });
      const job = monitor.trackedJobs.get('j1');
      expect(job.data.userId).to.equal('123');
      expect(job.data.password).to.equal('[REDACTED]');
    });

    it('uses provided jobType over inferred', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'doStuff', jobType: 'custom' });
      expect(monitor.trackedJobs.get('j1').jobType).to.equal('custom');
    });
  });

  // ==========================================
  // trackJobComplete
  // ==========================================
  describe('trackJobComplete', function () {

    it('marks job as completed with duration', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      monitor.trackJobComplete('j1', { ok: true });
      // Job should be removed from tracked
      expect(monitor.trackedJobs.has('j1')).to.be.false;
    });

    it('updates metrics on completion', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      monitor.trackJobComplete('j1');
      expect(monitor.metrics.completedJobs).to.equal(1);
      expect(monitor.metrics.totalJobs).to.equal(1);
      expect(monitor.metrics.totalDuration).to.be.at.least(0);
    });

    it('adds to history', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      monitor.trackJobComplete('j1');
      expect(monitor.jobHistory).to.have.lengthOf(1);
      expect(monitor.jobHistory[0].status).to.equal('completed');
    });

    it('warns and returns for unknown jobId', function () {
      // Should not throw
      monitor.trackJobComplete('nonexistent');
      expect(mockClient._addToBatch.called).to.be.false;
    });

    it('tracks longestDuration', function () {
      // We can't control real time easily, but complete two jobs and verify
      monitor.trackJobStart({ jobId: 'j1', jobName: 'a' });
      monitor.trackJobComplete('j1');
      const first = monitor.metrics.longestDuration;
      monitor.trackJobStart({ jobId: 'j2', jobName: 'b' });
      monitor.trackJobComplete('j2');
      expect(monitor.metrics.longestDuration).to.be.at.least(first);
    });
  });

  // ==========================================
  // trackJobFailed
  // ==========================================
  describe('trackJobFailed', function () {

    it('marks job as failed', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      monitor.trackJobFailed('j1', new Error('boom'));
      expect(monitor.trackedJobs.has('j1')).to.be.false;
      expect(monitor.metrics.failedJobs).to.equal(1);
      expect(monitor.metrics.totalJobs).to.equal(1);
    });

    it('formats error in job event', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      monitor.trackJobFailed('j1', new Error('boom'));
      // Second call (first was trackJobStart)
      const failEvent = mockClient._addToBatch.secondCall.args[1];
      expect(failEvent.error.message).to.equal('boom');
    });

    it('adds to history', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      monitor.trackJobFailed('j1', 'error string');
      expect(monitor.jobHistory).to.have.lengthOf(1);
      expect(monitor.jobHistory[0].status).to.equal('failed');
    });

    it('warns for unknown jobId', function () {
      monitor.trackJobFailed('nonexistent', new Error('x'));
      expect(mockClient._addToBatch.called).to.be.false;
    });
  });

  // ==========================================
  // trackJobProgress
  // ==========================================
  describe('trackJobProgress', function () {

    it('updates progress on tracked job', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      monitor.trackJobProgress('j1', 50);
      expect(monitor.trackedJobs.get('j1').progress).to.equal(50);
    });

    it('clamps progress to 0-100', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      monitor.trackJobProgress('j1', 150);
      expect(monitor.trackedJobs.get('j1').progress).to.equal(100);
      monitor.trackJobProgress('j1', -10);
      expect(monitor.trackedJobs.get('j1').progress).to.equal(0);
    });

    it('no-ops for unknown jobId', function () {
      expect(() => monitor.trackJobProgress('nonexistent', 50)).to.not.throw();
    });
  });

  // ==========================================
  // trackScheduledJob
  // ==========================================
  describe('trackScheduledJob', function () {

    it('sends event with pending status', function () {
      monitor.trackScheduledJob({
        jobId: 's1',
        jobName: 'syncUsers',
        scheduledFor: new Date(Date.now() + 60000)
      });
      expect(mockClient._addToBatch.calledOnce).to.be.true;
      const job = mockClient._addToBatch.firstCall.args[1];
      expect(job.status).to.equal('pending');
      expect(job.jobType).to.equal('sync');
    });
  });

  // ==========================================
  // trackJobCancelled
  // ==========================================
  describe('trackJobCancelled', function () {

    it('cancels and removes tracked job', function () {
      monitor.trackJobStart({ jobId: 'j1', jobName: 'test' });
      monitor.trackJobCancelled('j1');
      expect(monitor.trackedJobs.has('j1')).to.be.false;
      // Second call should have status 'cancelled'
      const cancelEvent = mockClient._addToBatch.secondCall.args[1];
      expect(cancelEvent.status).to.equal('cancelled');
    });

    it('no-ops for unknown jobId', function () {
      const callsBefore = mockClient._addToBatch.callCount;
      monitor.trackJobCancelled('nonexistent');
      expect(mockClient._addToBatch.callCount).to.equal(callsBefore);
    });
  });

  // ==========================================
  // _addToHistory
  // ==========================================
  describe('_addToHistory', function () {

    it('trims history when exceeding maxHistorySize', function () {
      monitor.maxHistorySize = 5;
      for (let i = 0; i < 10; i++) {
        monitor._addToHistory({
          jobName: `job${i}`, jobType: 'general',
          status: 'completed', duration: 100,
          completedAt: new Date()
        });
      }
      expect(monitor.jobHistory).to.have.lengthOf(5);
      // Should keep the most recent entries
      expect(monitor.jobHistory[0].jobName).to.equal('job5');
    });
  });

  // ==========================================
  // _sendJobEvent
  // ==========================================
  describe('_sendJobEvent', function () {

    it('sends via client._addToBatch with "jobs" type', function () {
      monitor._sendJobEvent({ jobId: 'j1', status: 'running' });
      expect(mockClient._addToBatch.calledOnce).to.be.true;
      expect(mockClient._addToBatch.firstCall.args[0]).to.equal('jobs');
      expect(mockClient._addToBatch.firstCall.args[2]).to.equal('/api/v1/jobs');
    });

    it('warns when no client configured', function () {
      monitor.client = null;
      // Should not throw
      expect(() => monitor._sendJobEvent({ jobId: 'j1' })).to.not.throw();
    });
  });
});


// ============================================================
// JobCollector factory
// ============================================================
import { JobCollector } from '../../../../lib/collectors/jobs/index.js';

describe('JobCollector', function () {

  describe('getSupportedPackages', function () {

    it('returns array of package names', function () {
      const packages = JobCollector.getSupportedPackages();
      expect(packages).to.be.an('array');
      expect(packages).to.include('msavin:sjobs');
    });
  });

  describe('registerAdapter', function () {

    afterEach(function () {
      // Clean up any registered test adapters
      delete JobCollector.ADAPTERS['test:package'];
    });

    it('registers a valid adapter', function () {
      class TestMonitor extends BaseJobMonitor {
        getPackageName() { return 'test:package'; }
        isPackageAvailable() { return false; }
        async getQueueStats() { return {}; }
        setupHooks() {}
      }
      JobCollector.registerAdapter('test:package', TestMonitor);
      expect(JobCollector.ADAPTERS['test:package']).to.equal(TestMonitor);
    });

    it('throws for non-BaseJobMonitor class', function () {
      class NotAMonitor {}
      expect(() => JobCollector.registerAdapter('bad', NotAMonitor))
        .to.throw('must extend BaseJobMonitor');
    });
  });

  describe('create', function () {

    it('returns null when no package is available', function () {
      // All adapters will report unavailable in test env
      const result = JobCollector.create({ client: null });
      expect(result).to.be.null;
    });

    it('tries preferredPackage first', function () {
      class TestMonitor extends BaseJobMonitor {
        getPackageName() { return 'test:preferred'; }
        isPackageAvailable() { return true; }
        async getQueueStats() { return {}; }
        setupHooks() {}
      }
      JobCollector.ADAPTERS['test:preferred'] = TestMonitor;

      const result = JobCollector.create({
        client: null,
        preferredPackage: 'test:preferred'
      });
      expect(result).to.be.instanceOf(TestMonitor);

      delete JobCollector.ADAPTERS['test:preferred'];
    });

    it('falls back to auto-detect when preferred unavailable', function () {
      const result = JobCollector.create({
        client: null,
        preferredPackage: 'nonexistent:package'
      });
      // No package available in test → null
      expect(result).to.be.null;
    });
  });
});
