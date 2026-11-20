/**
 * rum-client entry point tests — exports, auto-init appVersion resolution,
 * one collector per page load across SPA route changes, immediate flush.
 *
 * The module auto-initializes on import from global Meteor.settings, so each
 * test sets globals and re-requires it.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { setupBrowserMocks, teardownBrowserMocks } from '../../helpers/browserMock.js';

const MODULE = require.resolve('../../../client/rum-client.js');

function loadRum(skysignal) {
  global.Meteor = { settings: { public: { skysignal: { publicKey: 'pk_test', ...skysignal } } } };
  delete require.cache[MODULE];
  return require(MODULE);
}

describe('rum-client', function () {

  beforeEach(function () {
    setupBrowserMocks();
  });

  afterEach(function () {
    delete global.Meteor;
    delete global.__meteor_runtime_config__;
    delete require.cache[MODULE];
    teardownBrowserMocks();
  });

  it('exports SkySignalRUM as a named export (README import form)', function () {
    const mod = loadRum({});
    expect(mod.SkySignalRUM).to.equal(mod.default);
    expect(mod.SkySignalRUM.isInitialized()).to.be.true;
  });

  describe('ErrorTracker appVersion', function () {

    it('prefers errorTracking.appVersion', function () {
      const { SkySignalErrorTracker } = loadRum({ appVersion: '1.0.0', errorTracking: { appVersion: '2.0.0' } });
      expect(SkySignalErrorTracker.config.appVersion).to.equal('2.0.0');
    });

    it('falls back to public.skysignal.appVersion', function () {
      const { SkySignalErrorTracker } = loadRum({ appVersion: '1.0.0' });
      expect(SkySignalErrorTracker.config.appVersion).to.equal('1.0.0');
    });

    it('falls back to __meteor_runtime_config__.appVersion', function () {
      global.__meteor_runtime_config__ = { appVersion: 'abc123' };
      const { SkySignalErrorTracker } = loadRum({});
      expect(SkySignalErrorTracker.config.appVersion).to.equal('abc123');
    });
  });

  it('reports failed error sends on the exported SkySignalErrorTracker', async function () {
    const { SkySignalErrorTracker } = loadRum({});
    navigator.sendBeacon.returns(false);
    fetch.rejects(new Error('network down'));

    const onError = window.addEventListener.getCalls().find(c => c.args[0] === 'error').args[1];
    await onError({ message: 'boom', error: new Error('boom') });

    expect(SkySignalErrorTracker.getStats().failedErrors).to.equal(1);
  });

  describe('SPA route changes', function () {

    it('keeps the same collector instead of re-subscribing web-vitals per route', function () {
      const rum = loadRum({}).default;
      const collector = rum.collector;

      window.location.pathname = '/next';
      history.pushState({}, '', '/next');
      rum.trackPageView('/manual');

      expect(rum.currentRoute).to.equal('/manual');
      expect(rum.collector).to.equal(collector);
    });

    it('flushes a measurement as soon as the collector emits it', function () {
      const rum = loadRum({}).default;
      const flush = sinon.spy(rum.client, 'flush');

      rum.collector.callbacks.forEach(cb => cb({ ttfb: 100, timestamp: new Date() }));

      expect(flush.calledOnce).to.be.true;
      expect(rum.client.getBatchSize()).to.equal(0);
      expect(navigator.sendBeacon.calledOnce).to.be.true;
    });
  });
});
