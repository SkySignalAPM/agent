/**
 * SteveJobsMonitor tests — _extractJobData, _getRepeatPattern,
 * _isJobExecuting, _handleJobAdded state routing, _handleJobChanged
 * state transitions, _handleJobRemoved cleanup.
 *
 * Does NOT require real msavin:sjobs — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import SteveJobsMonitor from '../../../../lib/collectors/jobs/SteveJobsMonitor.js';

describe('SteveJobsMonitor', function () {

  let monitor;
  let mockClient;

  beforeEach(function () {
    mockClient = { sendJobEvent: sinon.stub(), _addToBatch: sinon.stub() };
    monitor = new SteveJobsMonitor({
      client: mockClient,
      host: 'test-host',
      appVersion: '1.0.0'
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

    it('sets defaults', function () {
      expect(monitor.jobsCollection).to.be.null;
      expect(monitor.observeHandle).to.be.null;
      expect(monitor.runningJobsMap).to.be.instanceOf(Map);
    });

    it('inherits from BaseJobMonitor', function () {
      expect(monitor.host).to.equal('test-host');
      expect(monitor.trackedJobs).to.be.instanceOf(Map);
      expect(monitor.jobHistory).to.be.an('array');
    });
  });

  // ==========================================
  // getPackageName
  // ==========================================
  describe('getPackageName', function () {

    it('returns msavin:sjobs', function () {
      expect(monitor.getPackageName()).to.equal('msavin:sjobs');
    });
  });

  // ==========================================
  // _extractJobData
  // ==========================================
  describe('_extractJobData', function () {

    it('returns null for empty arguments', function () {
      expect(monitor._extractJobData({ arguments: [] })).to.be.null;
    });

    it('returns null for missing arguments', function () {
      expect(monitor._extractJobData({})).to.be.null;
    });

    it('returns single argument directly', function () {
      const result = monitor._extractJobData({ arguments: [{ userId: '123' }] });
      expect(result).to.deep.equal({ userId: '123' });
    });

    it('wraps multiple arguments in object', function () {
      const result = monitor._extractJobData({ arguments: ['arg1', 'arg2', 'arg3'] });
      expect(result).to.deep.equal({ arguments: ['arg1', 'arg2', 'arg3'] });
    });

    it('handles primitive single argument', function () {
      expect(monitor._extractJobData({ arguments: ['hello'] })).to.equal('hello');
      expect(monitor._extractJobData({ arguments: [42] })).to.equal(42);
    });
  });

  // ==========================================
  // _getRepeatPattern
  // ==========================================
  describe('_getRepeatPattern', function () {

    it('returns repeat field if present', function () {
      expect(monitor._getRepeatPattern({ repeat: 'hour' })).to.equal('hour');
      expect(monitor._getRepeatPattern({ repeat: { every: '5m' } })).to.deep.equal({ every: '5m' });
    });

    it('falls back to schedule field', function () {
      expect(monitor._getRepeatPattern({ schedule: '0 * * * *' })).to.equal('0 * * * *');
    });

    it('returns null when neither present', function () {
      expect(monitor._getRepeatPattern({})).to.be.null;
    });

    it('prefers repeat over schedule', function () {
      expect(monitor._getRepeatPattern({ repeat: 'day', schedule: '0 0 * * *' })).to.equal('day');
    });
  });

  // ==========================================
  // _isJobExecuting
  // ==========================================
  describe('_isJobExecuting', function () {

    it('returns false for non-pending state', function () {
      expect(monitor._isJobExecuting({ state: 'success' })).to.be.false;
      expect(monitor._isJobExecuting({ state: 'failure' })).to.be.false;
    });

    it('returns true when pending and due time passed', function () {
      const pastTime = new Date(Date.now() - 60000);
      expect(monitor._isJobExecuting({ state: 'pending', due: pastTime })).to.be.true;
    });

    it('returns false when pending but due time is in future', function () {
      const futureTime = new Date(Date.now() + 60000);
      expect(monitor._isJobExecuting({ state: 'pending', due: futureTime })).to.be.false;
    });

    it('uses created time as fallback', function () {
      const pastTime = new Date(Date.now() - 60000);
      expect(monitor._isJobExecuting({ state: 'pending', created: pastTime })).to.be.true;
    });

    it('defaults to now when no due/created', function () {
      // Due defaults to now, and now <= now is true
      expect(monitor._isJobExecuting({ state: 'pending' })).to.be.true;
    });
  });

  // ==========================================
  // _handleJobAdded
  // ==========================================
  describe('_handleJobAdded', function () {

    it('routes pending+due-now to _markJobRunning', function () {
      sinon.spy(monitor, '_markJobRunning');
      sinon.stub(monitor, 'trackScheduledJob');

      const doc = {
        _id: 'j1',
        name: 'sendEmail',
        state: 'pending',
        due: new Date(Date.now() - 1000), // Due in the past
        created: new Date(),
        priority: 1,
        arguments: [{ to: 'user@test.com' }]
      };

      monitor._handleJobAdded(doc);
      expect(monitor._markJobRunning.calledOnce).to.be.true;
      expect(monitor.trackScheduledJob.called).to.be.false;
    });

    it('routes pending+future-due to trackScheduledJob', function () {
      sinon.spy(monitor, '_markJobRunning');
      sinon.stub(monitor, 'trackScheduledJob');

      const doc = {
        _id: 'j2',
        name: 'cleanupData',
        state: 'pending',
        due: new Date(Date.now() + 60000), // Future
        created: new Date(),
        priority: 0
      };

      monitor._handleJobAdded(doc);
      expect(monitor._markJobRunning.called).to.be.false;
      expect(monitor.trackScheduledJob.calledOnce).to.be.true;
    });

    it('handles already-completed job (success)', function () {
      sinon.stub(monitor, 'trackJobStart');
      sinon.stub(monitor, 'trackJobComplete');

      const doc = {
        _id: 'j3',
        name: 'processReport',
        state: 'success',
        created: new Date(),
        result: { ok: true },
        arguments: [{ reportId: 'r1' }]
      };

      monitor._handleJobAdded(doc);
      expect(monitor.trackJobStart.calledOnce).to.be.true;
      expect(monitor.trackJobComplete.calledOnce).to.be.true;
    });

    it('handles already-failed job (failure)', function () {
      sinon.stub(monitor, 'trackJobStart');
      sinon.stub(monitor, 'trackJobFailed');

      const doc = {
        _id: 'j4',
        name: 'sendNotification',
        state: 'failure',
        created: new Date(),
        failure: { message: 'SMTP timeout' },
        arguments: []
      };

      monitor._handleJobAdded(doc);
      expect(monitor.trackJobStart.calledOnce).to.be.true;
      expect(monitor.trackJobFailed.calledOnce).to.be.true;
    });
  });

  // ==========================================
  // _handleJobChanged
  // ==========================================
  describe('_handleJobChanged', function () {

    it('detects job starting to execute', function () {
      sinon.spy(monitor, '_markJobRunning');

      const newDoc = {
        _id: 'j1',
        name: 'test',
        state: 'pending',
        due: new Date(Date.now() - 1000),
        created: new Date()
      };
      const oldDoc = {
        _id: 'j1',
        name: 'test',
        state: 'pending',
        due: new Date(Date.now() + 60000)
      };

      monitor._handleJobChanged(newDoc, oldDoc);
      expect(monitor._markJobRunning.calledOnce).to.be.true;
    });

    it('does not double-track running jobs', function () {
      sinon.spy(monitor, '_markJobRunning');
      monitor.runningJobsMap.set('j1', new Date());

      const newDoc = {
        _id: 'j1', name: 'test', state: 'pending',
        due: new Date(Date.now() - 1000), created: new Date()
      };
      const oldDoc = { _id: 'j1', state: 'pending' };

      monitor._handleJobChanged(newDoc, oldDoc);
      expect(monitor._markJobRunning.called).to.be.false;
    });

    it('detects job completion', function () {
      sinon.spy(monitor, '_markJobCompleted');

      const newDoc = { _id: 'j1', name: 'test', state: 'success', created: new Date() };
      const oldDoc = { _id: 'j1', state: 'pending' };

      monitor._handleJobChanged(newDoc, oldDoc);
      expect(monitor._markJobCompleted.calledOnce).to.be.true;
    });

    it('does not fire completion if already success', function () {
      sinon.spy(monitor, '_markJobCompleted');

      const newDoc = { _id: 'j1', name: 'test', state: 'success' };
      const oldDoc = { _id: 'j1', state: 'success' };

      monitor._handleJobChanged(newDoc, oldDoc);
      expect(monitor._markJobCompleted.called).to.be.false;
    });

    it('detects job failure', function () {
      sinon.spy(monitor, '_markJobFailed');

      const newDoc = { _id: 'j1', name: 'test', state: 'failure', created: new Date() };
      const oldDoc = { _id: 'j1', state: 'pending' };

      monitor._handleJobChanged(newDoc, oldDoc);
      expect(monitor._markJobFailed.calledOnce).to.be.true;
    });
  });

  // ==========================================
  // _handleJobRemoved
  // ==========================================
  describe('_handleJobRemoved', function () {

    it('handles success state purge', function () {
      sinon.stub(monitor, 'trackJobStart');
      sinon.stub(monitor, 'trackJobComplete');

      const doc = {
        _id: 'j1', name: 'test', state: 'success',
        created: new Date(), result: { ok: true }, arguments: [{ a: 1 }]
      };

      monitor._handleJobRemoved(doc);
      // Should track start (since not previously tracked) and complete
      expect(monitor.trackJobStart.calledOnce).to.be.true;
      expect(monitor.trackJobComplete.calledOnce).to.be.true;
    });

    it('skips trackJobStart if already tracked for success purge', function () {
      sinon.stub(monitor, 'trackJobStart');
      sinon.stub(monitor, 'trackJobComplete');
      monitor.trackedJobs.set('j1', { jobName: 'test' });

      const doc = {
        _id: 'j1', name: 'test', state: 'success',
        created: new Date()
      };

      monitor._handleJobRemoved(doc);
      expect(monitor.trackJobStart.called).to.be.false;
      expect(monitor.trackJobComplete.calledOnce).to.be.true;
    });

    it('handles failure state purge', function () {
      sinon.stub(monitor, 'trackJobStart');
      sinon.stub(monitor, 'trackJobFailed');

      const doc = {
        _id: 'j2', name: 'test', state: 'failure',
        created: new Date(), failure: { message: 'crash' }
      };

      monitor._handleJobRemoved(doc);
      expect(monitor.trackJobStart.calledOnce).to.be.true;
      expect(monitor.trackJobFailed.calledOnce).to.be.true;
    });

    it('assumes success for running job removed', function () {
      sinon.stub(monitor, 'trackJobComplete');
      monitor.runningJobsMap.set('j3', new Date());

      const doc = { _id: 'j3', name: 'test', state: 'pending' };
      monitor._handleJobRemoved(doc);

      expect(monitor.trackJobComplete.calledOnce).to.be.true;
      expect(monitor.runningJobsMap.has('j3')).to.be.false;
    });

    it('tracks cancellation for pending job', function () {
      sinon.stub(monitor, 'trackJobCancelled');

      const doc = { _id: 'j4', name: 'test', state: 'pending' };
      monitor._handleJobRemoved(doc);

      expect(monitor.trackJobCancelled.calledOnce).to.be.true;
    });

    it('tracks cancellation for cancelled state', function () {
      sinon.stub(monitor, 'trackJobCancelled');

      const doc = { _id: 'j5', name: 'test', state: 'cancelled' };
      monitor._handleJobRemoved(doc);

      expect(monitor.trackJobCancelled.calledOnce).to.be.true;
    });

    it('cleans up runningJobsMap on success purge', function () {
      sinon.stub(monitor, 'trackJobStart');
      sinon.stub(monitor, 'trackJobComplete');
      monitor.runningJobsMap.set('j1', new Date());

      const doc = { _id: 'j1', name: 'test', state: 'success', created: new Date() };
      monitor._handleJobRemoved(doc);

      expect(monitor.runningJobsMap.has('j1')).to.be.false;
    });
  });

  // ==========================================
  // cleanupHooks
  // ==========================================
  describe('cleanupHooks', function () {

    it('stops observer handle', function () {
      monitor.observeHandle = { stop: sinon.stub() };
      monitor.cleanupHooks();
      expect(monitor.observeHandle).to.be.null;
    });

    it('safe when no handle', function () {
      expect(() => monitor.cleanupHooks()).to.not.throw();
    });
  });
});
