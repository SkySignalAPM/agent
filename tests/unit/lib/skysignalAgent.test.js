import { expect } from 'chai';
import sinon from 'sinon';
import { SkySignalAgent } from '../../../skysignal-agent.js';
import { DEFAULT_CONFIG } from '../../../lib/config.js';
import MethodTracer from '../../../lib/collectors/MethodTracer.js';

// Every collector off, so start() doesn't wrap console/methods/etc. in tests.
const ALL_OFF = Object.fromEntries(
  Object.keys(DEFAULT_CONFIG).filter(k => /^collect[A-Z]/.test(k)).map(k => [k, false])
);

describe('SkySignalAgent', function () {

  afterEach(function () {
    SkySignalAgent.stop();
    if (SkySignalAgent.client) SkySignalAgent.client.stop();
    SkySignalAgent.client = null;
    SkySignalAgent.collectors = {};
  });

  it('uses DEFAULT_CONFIG as its only source of defaults', function () {
    const fresh = new SkySignalAgent.constructor();
    expect(fresh.config).to.deep.equal(DEFAULT_CONFIG);
  });

  it('passes traceMethodArguments and collectErrors to MethodTracer', function () {
    sinon.stub(MethodTracer.prototype, 'start');
    SkySignalAgent.configure({
      apiKey: 'sk_test', ...ALL_OFF, collectTraces: true,
      traceMethodArguments: false, collectErrors: false
    });
    SkySignalAgent.start();
    expect(SkySignalAgent.collectors.methodTracer.traceMethodArguments).to.equal(false);
    expect(SkySignalAgent.collectors.methodTracer.collectErrors).to.equal(false);
  });

  it('sends again after stop() then start()', function () {
    SkySignalAgent.configure({ apiKey: 'sk_test', ...ALL_OFF });
    SkySignalAgent.start();
    SkySignalAgent.stop();
    expect(SkySignalAgent.client.stopped).to.equal(true);

    SkySignalAgent.start();
    expect(SkySignalAgent.client.stopped).to.equal(false);
    expect(SkySignalAgent.counter('restarted')).to.equal(true);
    expect(SkySignalAgent.client.batches.customMetrics).to.have.lengthOf(1);
  });

  it('configure() stops the previous client instead of orphaning it', function () {
    SkySignalAgent.configure({ apiKey: 'sk_test', ...ALL_OFF });
    const first = SkySignalAgent.client;
    SkySignalAgent.configure({ apiKey: 'sk_test', ...ALL_OFF });
    expect(first.stopped).to.equal(true);
    expect(first.flushTimeoutId).to.equal(null);
    expect(SkySignalAgent.client).to.not.equal(first);
  });

  it('configure() is refused while running (collectors hold the client)', function () {
    sinon.stub(console, 'warn');
    SkySignalAgent.configure({ apiKey: 'sk_test', ...ALL_OFF });
    SkySignalAgent.start();
    const running = SkySignalAgent.client;
    SkySignalAgent.configure({ apiKey: 'sk_other', ...ALL_OFF });
    expect(SkySignalAgent.client).to.equal(running);
    expect(SkySignalAgent.config.apiKey).to.equal('sk_test');
  });

  describe('_handleShutdownSignal', function () {

    function fakeProcess(listeners) {
      return { pid: 4242, listenerCount: () => listeners, kill: sinon.spy() };
    }

    it('re-raises the signal when the agent was the only listener', async function () {
      const proc = fakeProcess(0);
      await SkySignalAgent._handleShutdownSignal('SIGTERM', proc, 0);
      expect(proc.kill.calledOnceWithExactly(4242, 'SIGTERM')).to.equal(true);
    });

    it('waits (capped) for in-flight sends before re-raising', async function () {
      const proc = fakeProcess(0);
      SkySignalAgent.client = { inFlightBytes: 10, stop() {} };
      const started = Date.now();
      await SkySignalAgent._handleShutdownSignal('SIGINT', proc, 60);
      expect(Date.now() - started).to.be.at.least(50);
      expect(proc.kill.calledOnceWithExactly(4242, 'SIGINT')).to.equal(true);
    });

    it('leaves exiting to the host app when it has its own handler', async function () {
      const proc = fakeProcess(1);
      await SkySignalAgent._handleShutdownSignal('SIGTERM', proc, 0);
      expect(proc.kill.called).to.equal(false);
    });

    it('still re-raises when stop() throws', async function () {
      sinon.stub(console, 'warn');
      const stop = sinon.stub(SkySignalAgent, 'stop').throws(new Error('collector blew up'));
      SkySignalAgent.started = true;
      const proc = fakeProcess(0);
      await SkySignalAgent._handleShutdownSignal('SIGTERM', proc, 0);
      stop.restore();
      SkySignalAgent.started = false;
      expect(proc.kill.calledOnce).to.equal(true);
    });

    it('stops the agent', async function () {
      sinon.stub(console, 'log');
      SkySignalAgent.configure({ apiKey: 'sk_test', ...ALL_OFF });
      SkySignalAgent.start();
      await SkySignalAgent._handleShutdownSignal('SIGTERM', fakeProcess(1), 0);
      expect(SkySignalAgent.started).to.equal(false);
    });
  });
});
