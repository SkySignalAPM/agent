import { expect } from 'chai';
import sinon from 'sinon';
import JobCollector from '../../../../lib/collectors/jobs/index.js';
import { methodTraceContextStore } from '../../../../lib/collectors/MethodTracer.js';

describe('SyncedCronMonitor', function () {
  let cron, monitor, client, previousPackage;
  const events = () => client._addToBatch.getCalls().map(call => call.args[1]);
  beforeEach(function () {
    previousPackage = global.Package;
    // Mirrors the upstream boundary: locking precedes entry.job; errors are swallowed
    // by the scheduler after its onError hook receives the original rejection.
    cron = {
      _entries: {}, running: true,
      add(entry) { this._entries[entry.name] = entry; return this._entryWrapper(entry); },
      _entryWrapper(entry) {
        return async intendedAt => {
          if (entry.skip) return;
          try { return await entry.job(intendedAt, entry.name); }
          catch (error) { if (entry.onError) await entry.onError({ error }); }
        };
      }
    };
    global.Package = { 'quave:synced-cron': { SyncedCron: cron } };
    client = { _addToBatch: sinon.spy(), addCustomMetric: sinon.spy() };
    monitor = JobCollector.create({ client, host: 'host', preferredPackage: 'quave:synced-cron' });
  });
  afterEach(function () {
    if (monitor) monitor.stop();
    if (previousPackage === undefined) delete global.Package;
    else global.Package = previousPackage;
  });
  it('auto-detects the package and supports explicit preference', function () {
    expect(monitor, 'registered synced-cron adapter').not.to.equal(null);
    expect(monitor.getPackageName()).to.equal('quave:synced-cron');
    expect(JobCollector.create({ client }).getPackageName()).to.equal('quave:synced-cron');
    delete global.Package['quave:synced-cron'];
    expect(monitor.isPackageAvailable()).to.equal(false);
  });
  it('captures existing callbacks, async results, receiver, arguments and elapsed duration', async function () {
    const intendedAt = new Date(Date.now() - 100);
    const entry = { name: 'report', async job(date, name) {
      expect(this).to.equal(entry);
      expect(date).to.equal(intendedAt);
      expect(name).to.equal('report');
      await new Promise(resolve => setTimeout(resolve, 5));
      return { count: 3, token: 'private' };
    } };
    cron._entries.report = entry;
    const scheduled = cron._entryWrapper(entry);
    monitor.start();
    expect(await scheduled(intendedAt)).to.deep.equal({ count: 3, token: 'private' });
    expect(events().map(event => event.status)).to.deep.equal(['running', 'completed']);
    expect(events()[1]).to.include({ jobName: 'report', jobsPackage: 'quave:synced-cron', queueName: 'synced-cron', host: 'host' });
    expect(events()[1].duration).to.be.at.least(5);
    expect(events()[1].result.token).to.equal('[REDACTED]');
  });
  it('tracks new nonpersistent jobs and gives repeated and concurrent executions distinct IDs', async function () {
    monitor.start();
    const scheduled = cron.add({ name: 'repeat', persist: false, job: async () => 42 });
    await Promise.all([scheduled(new Date()), scheduled(new Date())]);
    await scheduled(new Date());
    const completed = events().filter(event => event.status === 'completed');
    expect(completed).to.have.length(3);
    expect(new Set(completed.map(event => event.jobId)).size).to.equal(3);
    await monitor._collectAndSendStats();
    expect(client.addCustomMetric.lastCall.args[0].metadata).to.include({ totalCompleted: 3, totalJobsProcessed: 3 });
  });
  for (const asyncFailure of [false, true]) {
    it(`preserves ${asyncFailure ? 'async rejection' : 'sync throw'} for scheduler error handling`, async function () {
      const error = new Error('failed');
      const onError = sinon.spy();
      monitor.start();
      const scheduled = cron.add({ name: 'fail', onError, job: asyncFailure ? async () => { throw error; } : () => { throw error; } });
      await scheduled(new Date());
      expect(onError.firstCall.args[0].error).to.equal(error);
      expect(events().map(event => event.status)).to.deep.equal(['running', 'failed']);
      expect(events()[1].error.message).to.equal('failed');
    });
  }
  it('does not report executions skipped by scheduler locking', async function () {
    monitor.start();
    await cron.add({ name: 'skipped', skip: true, job: sinon.spy() })(new Date());
    expect(events()).to.have.length(0);
  });
  it('retains originating method trace correlation for an explicit run', async function () {
    monitor.start();
    const scheduled = cron.add({ name: 'manual', job: () => 1 });
    await methodTraceContextStore.run({ methodContext: { traceId: 'trace-123' } }, () => scheduled(new Date()));
    expect(events()[1].originatingTraceId).to.equal('trace-123');
  });
  it('does not let telemetry failure change a successful job or its error', async function () {
    monitor.start();
    client._addToBatch = sinon.stub().throws(new Error('telemetry failed'));
    const entry = { name: 'success', job: () => 9 };
    const scheduled = cron.add(entry);
    expect(await scheduled(new Date())).to.equal(9);
    expect(monitor.trackedJobs.size).to.equal(0);
    const error = new Error('original');
    const onError = sinon.spy();
    await cron.add({ name: 'fail', job: () => { throw error; }, onError })(new Date());
    expect(onError.firstCall.args[0].error).to.equal(error);
    expect(monitor.trackedJobs.size).to.equal(0);
  });
  it('restores hooks, avoids double wrapping, and can restart', async function () {
    const factory = cron._entryWrapper;
    const original = () => 'ok';
    const entry = { name: 'cleanup', job: original };
    cron._entries.cleanup = entry;
    monitor.start();
    monitor.start();
    const scheduled = cron._entryWrapper(entry);
    await scheduled(new Date());
    expect(events()).to.have.length(2);
    monitor.stop();
    expect(cron._entryWrapper).to.equal(factory);
    expect(entry.job).to.equal(original);
    await scheduled(new Date());
    expect(events()).to.have.length(2);
    monitor.start();
    await scheduled(new Date());
    expect(events()).to.have.length(4);
  });
  it('does not start when disabled', function () {
    monitor.enabled = false;
    const original = cron._entryWrapper;
    monitor.start();
    expect(monitor.started).to.equal(false);
    expect(cron._entryWrapper).to.equal(original);
  });
  it('finishes stopped executions as unknown without corrupting a restarted monitor', async function () {
    let finish;
    monitor.start();
    const scheduled = cron.add({ name: 'active', job: () => new Promise(resolve => { finish = resolve; }) });
    const pending = scheduled(new Date());
    monitor.stop();
    monitor.start();
    finish('done');
    expect(await pending).to.equal('done');
    expect(events().map(event => event.status)).to.deep.equal(['running', 'unknown']);
    expect(monitor.trackedJobs.size).to.equal(0);
    expect(monitor.metrics.totalJobs).to.equal(0);
  });
  it('leaves wrappers installed by another instrumentor untouched on cleanup', function () {
    monitor.start();
    const entry = { name: 'other', job: () => 1 };
    cron.add(entry);
    const replacementJob = () => 2;
    const replacementFactory = () => 3;
    entry.job = replacementJob;
    cron._entryWrapper = replacementFactory;
    monitor.stop();
    expect(entry.job).to.equal(replacementJob);
    expect(cron._entryWrapper).to.equal(replacementFactory);
  });
  it('releases removed job definitions during stats collection', async function () {
    monitor.start();
    const job = () => 1;
    const entry = { name: 'removed', job };
    cron.add(entry);
    delete cron._entries.removed;
    await monitor.getQueueStats();
    expect(entry.job).to.equal(job);
    expect(monitor._wrappedEntries.size).to.equal(0);
  });
});
