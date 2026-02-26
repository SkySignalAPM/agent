/**
 * ScreenshotCapture tests — constructor defaults, default redaction selectors,
 * _shouldCapture sampling, _shouldCaptureErrorType filtering, getStats.
 *
 * Does NOT capture real screenshots — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import ScreenshotCapture from '../../../client/ScreenshotCapture.js';

describe('ScreenshotCapture', function () {

  let capture;

  beforeEach(function () {
    capture = new ScreenshotCapture();
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
