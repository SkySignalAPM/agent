/**
 * ScreenshotCapture tests — constructor defaults, default redaction selectors,
 * sampling/filtering, lazy loading, redaction, encoding, and statistics.
 *
 * Browser rendering is mocked; the asynchronous capture flow is real.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { execFileSync } from 'child_process';
import path from 'path';
import ScreenshotCapture from '../../../client/ScreenshotCapture.js';
import { setupScreenshotFixture } from '../../helpers/screenshotFixture.js';

describe('ScreenshotCapture', function () {

  let capture;

  beforeEach(function () {
    capture = new ScreenshotCapture();
  });

  it('does not evaluate html2canvas when imported or constructed', function () {
    // A fresh process avoids another test's previously loaded module cache.
    const output = execFileSync(process.execPath, ['-e', `
      require('./tests/setup.js');
      const Capture = require('./client/ScreenshotCapture.js').default;
      new Capture();
      const renderer = require.resolve('./tests/helpers/html2canvasMock.js');
      process.stdout.write(JSON.stringify(Boolean(require.cache[renderer])));
    `], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' });
    expect(JSON.parse(output)).to.equal(false);
  });

  describe('lazy capture', function () {
    let fixture;
    let load;

    beforeEach(function () {
      fixture = setupScreenshotFixture();
      capture = new ScreenshotCapture({ redactSelectors: ['.secret'], quality: 0.5, maxSize: 256 });
      // Assigning this boundary also lets the tests expose the old eager path.
      load = capture._loadHtml2Canvas = sinon.stub().resolves(fixture.renderer);
    });

    afterEach(function () {
      fixture.restore();
    });

    for (const reason of ['disabled', 'sampling', 'error type']) {
      it(`does not load or redact when rejected by ${reason}`, async function () {
        if (reason === 'disabled') capture.config.enabled = false;
        if (reason === 'sampling') {
          capture.config.samplingRate = 25;
          sinon.stub(Math, 'random').returns(0.5);
        }
        if (reason === 'error type') capture.config.screenshotOnErrorTypes = ['FatalError'];
        expect(await capture.capture({ type: 'TypeError' })).to.equal(null);
        expect(load.called).to.equal(false);
        expect(fixture.overlays).to.have.length(0);
      });
    }

    it('waits for the renderer before redacting and preserves the render delay', async function () {
      let resolveLoad;
      load.returns(new Promise(resolve => { resolveLoad = resolve; }));
      const result = capture.capture({ type: 'TypeError' });
      await fixture.clock.tickAsync(1000);
      expect(fixture.overlays).to.have.length(0);
      expect(fixture.renderer.called).to.equal(false);
      resolveLoad(fixture.renderer);
      await fixture.clock.tickAsync(0);
      expect(fixture.activeOverlays.size).to.equal(1);
      await fixture.clock.tickAsync(49);
      expect(fixture.renderer.called).to.equal(false);
      await fixture.clock.tickAsync(1);
      expect(await result).to.equal('data:image/jpeg;base64,capture');
      expect(fixture.activeOverlays.size).to.equal(0);
    });

    it('preserves rendering options, JPEG quality, redaction, and success counts', async function () {
      const result = capture.capture({ type: 'TypeError' });
      await fixture.clock.tickAsync(50);
      expect(await result).to.equal('data:image/jpeg;base64,capture');
      expect(fixture.renderer.calledOnceWithExactly(fixture.document.body, {
        useCORS: true, allowTaint: false, logging: false, scale: 1
      })).to.equal(true);
      expect(fixture.canvas.toBlob.firstCall.args.slice(1)).to.deep.equal(['image/jpeg', 0.5]);
      expect(fixture.overlays[0].style.backgroundColor).to.equal('#000');
      expect(fixture.overlays[0].remove.calledOnce).to.equal(true);
      expect(capture.getStats()).to.include({ totalErrors: 1, screenshotsCaptured: 1 });
    });

    for (const failure of ['null blob', 'oversized blob', 'render rejection', 'reader error']) {
      it(`returns null and removes overlays for ${failure}`, async function () {
        if (failure === 'null blob') fixture.canvas.toBlob.callsFake(callback => callback(null));
        if (failure === 'oversized blob') fixture.blob.size = 257;
        if (failure === 'render rejection') fixture.renderer.rejects(new Error('render failed'));
        if (failure === 'reader error') sinon.stub(global.FileReader.prototype, 'readAsDataURL').callsFake(function () { this.onerror(); });
        const result = capture.capture({ type: 'TypeError' });
        await fixture.clock.tickAsync(50);
        expect(await result).to.equal(null);
        expect(fixture.activeOverlays.size).to.equal(0);
        expect(fixture.overlays[0].remove.calledOnce).to.equal(true);
        expect(capture.screenshotCount).to.equal(0);
      });
    }

    it('allows a later capture after load rejection without creating overlays for the failure', async function () {
      load.onFirstCall().rejects(new Error('download failed'));
      const first = capture.capture({ type: 'TypeError' });
      await fixture.clock.tickAsync(50);
      expect(await first).to.equal(null);
      expect(fixture.overlays).to.have.length(0);
      const second = capture.capture({ type: 'TypeError' });
      await fixture.clock.tickAsync(50);
      expect(await second).to.equal('data:image/jpeg;base64,capture');
      expect(capture.screenshotCount).to.equal(1);
    });

    it('keeps overlapping capture results and overlay cleanup independent', async function () {
      fixture.renderer.onFirstCall().resolves({ toBlob: callback => callback({ size: 10, dataURL: 'first' }) });
      fixture.renderer.onSecondCall().resolves({ toBlob: callback => callback({ size: 10, dataURL: 'second' }) });
      const results = [capture.capture({ type: 'TypeError' }), capture.capture({ type: 'ReferenceError' })];
      await fixture.clock.tickAsync(50);
      expect(await Promise.all(results)).to.deep.equal(['first', 'second']);
      expect(capture.screenshotCount).to.equal(2);
      expect(fixture.overlays).to.have.length(2);
      expect(fixture.overlays.every(overlay => overlay.remove.calledOnce)).to.equal(true);
      expect(fixture.activeOverlays.size).to.equal(0);
    });

    it('resolves the real dynamic import default export and encodes its canvas', async function () {
      delete capture._loadHtml2Canvas;
      const result = capture.capture({ type: 'TypeError' });
      await fixture.clock.tickAsync(50);
      expect(await result).to.equal('data:image/jpeg;base64,mock');
      expect(capture.screenshotCount).to.equal(1);
    });
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default config', function () {
      expect(capture.config.enabled).to.be.true;
      expect(capture.config.quality).to.equal(0.7);
      expect(capture.config.maxSize).to.equal(500 * 1024);
      expect(capture.config.samplingRate).to.equal(100);
      expect(capture.config.debug).to.be.false;
    });

    it('initializes counters', function () {
      expect(capture.screenshotCount).to.equal(0);
      expect(capture.totalErrors).to.equal(0);
    });

    it('respects custom config', function () {
      const c = new ScreenshotCapture({
        quality: 0.5,
        maxSize: 100000,
        samplingRate: 50,
        debug: true
      });
      expect(c.config.quality).to.equal(0.5);
      expect(c.config.maxSize).to.equal(100000);
      expect(c.config.samplingRate).to.equal(50);
      expect(c.config.debug).to.be.true;
    });

    it('allows custom redactSelectors', function () {
      const c = new ScreenshotCapture({
        redactSelectors: ['.my-custom-class']
      });
      expect(c.config.redactSelectors).to.deep.equal(['.my-custom-class']);
    });

    it('allows custom screenshotOnErrorTypes', function () {
      const c = new ScreenshotCapture({
        screenshotOnErrorTypes: ['FatalError']
      });
      expect(c.config.screenshotOnErrorTypes).to.deep.equal(['FatalError']);
    });

    it('disabled=false prevents capture', function () {
      const c = new ScreenshotCapture({ enabled: false });
      expect(c.config.enabled).to.be.false;
    });
  });

  // ==========================================
  // _getDefaultRedactionSelectors
  // ==========================================
  describe('_getDefaultRedactionSelectors', function () {

    it('returns array of selectors', function () {
      const selectors = capture._getDefaultRedactionSelectors();
      expect(selectors).to.be.an('array');
      expect(selectors.length).to.be.greaterThan(50);
    });

    it('includes password fields', function () {
      const selectors = capture._getDefaultRedactionSelectors();
      expect(selectors).to.include('input[type="password"]');
      expect(selectors).to.include('input[name*="password"]');
    });

    it('includes credit card fields', function () {
      const selectors = capture._getDefaultRedactionSelectors();
      expect(selectors).to.include('input[autocomplete="cc-number"]');
      expect(selectors).to.include('input[autocomplete="cc-csc"]');
    });

    it('includes email and phone fields', function () {
      const selectors = capture._getDefaultRedactionSelectors();
      expect(selectors).to.include('input[type="email"]');
      expect(selectors).to.include('input[type="tel"]');
    });

    it('includes data-sensitive markers', function () {
      const selectors = capture._getDefaultRedactionSelectors();
      expect(selectors).to.include('[data-sensitive]');
      expect(selectors).to.include('[data-private]');
      expect(selectors).to.include('[data-pii]');
    });

    it('includes HIPAA/medical fields', function () {
      const selectors = capture._getDefaultRedactionSelectors();
      expect(selectors).to.include('[data-hipaa]');
      expect(selectors).to.include('.medical-record');
    });

    it('includes financial fields', function () {
      const selectors = capture._getDefaultRedactionSelectors();
      expect(selectors).to.include('.account-balance');
      expect(selectors).to.include('.salary');
    });

    it('includes media elements', function () {
      const selectors = capture._getDefaultRedactionSelectors();
      expect(selectors).to.include('video');
      expect(selectors).to.include('audio');
      expect(selectors).to.include('canvas');
    });

    it('includes third-party payment iframes', function () {
      const selectors = capture._getDefaultRedactionSelectors();
      expect(selectors).to.include('iframe[src*="stripe"]');
      expect(selectors).to.include('iframe[src*="paypal"]');
    });
  });

  // ==========================================
  // _shouldCapture
  // ==========================================
  describe('_shouldCapture', function () {

    it('returns false when disabled', function () {
      capture.config.enabled = false;
      expect(capture._shouldCapture()).to.be.false;
    });

    it('increments totalErrors on each call', function () {
      capture.config.samplingRate = 100;
      capture._shouldCapture();
      capture._shouldCapture();
      expect(capture.totalErrors).to.equal(2);
    });

    it('returns true at 100% sampling rate', function () {
      capture.config.samplingRate = 100;
      // With 100% rate, should always return true
      let trueCount = 0;
      for (let i = 0; i < 20; i++) {
        if (capture._shouldCapture()) trueCount++;
      }
      expect(trueCount).to.equal(20);
    });

    it('returns false at 0% sampling rate', function () {
      capture.config.samplingRate = 0;
      let trueCount = 0;
      for (let i = 0; i < 20; i++) {
        if (capture._shouldCapture()) trueCount++;
      }
      expect(trueCount).to.equal(0);
    });
  });

  // ==========================================
  // _shouldCaptureErrorType
  // ==========================================
  describe('_shouldCaptureErrorType', function () {

    it('returns true for matching error types', function () {
      expect(capture._shouldCaptureErrorType('TypeError')).to.be.true;
      expect(capture._shouldCaptureErrorType('ReferenceError')).to.be.true;
      expect(capture._shouldCaptureErrorType('UnhandledRejection')).to.be.true;
    });

    it('returns false for non-matching error types', function () {
      // Note: _shouldCaptureErrorType uses .includes(), so 'NetworkError' matches 'Error'.
      // Only truly non-matching types return false.
      expect(capture._shouldCaptureErrorType('CustomWarning')).to.be.false;
      expect(capture._shouldCaptureErrorType('Timeout')).to.be.false;
    });

    it('returns true when error type list is empty (capture all)', function () {
      capture.config.screenshotOnErrorTypes = [];
      expect(capture._shouldCaptureErrorType('AnyError')).to.be.true;
    });

    it('matches partial type names', function () {
      // _shouldCaptureErrorType uses .includes() per element
      expect(capture._shouldCaptureErrorType('TypeError: undefined is not a function')).to.be.true;
    });

    it('uses custom error types when configured', function () {
      capture.config.screenshotOnErrorTypes = ['FatalError', 'CriticalError'];
      expect(capture._shouldCaptureErrorType('FatalError')).to.be.true;
      expect(capture._shouldCaptureErrorType('TypeError')).to.be.false;
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns initial stats', function () {
      const stats = capture.getStats();
      expect(stats.enabled).to.be.true;
      expect(stats.totalErrors).to.equal(0);
      expect(stats.screenshotsCaptured).to.equal(0);
      expect(stats.samplingRate).to.equal(100);
      expect(stats.captureRate).to.equal(0);
    });

    it('calculates captureRate correctly', function () {
      capture.totalErrors = 10;
      capture.screenshotCount = 3;

      const stats = capture.getStats();
      expect(stats.captureRate).to.equal(30);
    });

    it('handles zero errors', function () {
      const stats = capture.getStats();
      expect(stats.captureRate).to.equal(0);
    });
  });
});
