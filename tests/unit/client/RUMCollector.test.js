/**
 * RUMCollector tests — threshold checking, warning messages,
 * minimum metrics detection, metric handling, onMeasurement,
 * reset, getMetrics/getWarnings.
 *
 * Uses web-vitals mock. Browser globals must be set up before import.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { setupBrowserMocks, teardownBrowserMocks } from '../../helpers/browserMock.js';
import { _reset as resetWebVitals } from 'web-vitals';

// RUMCollector must be imported after browser mocks are available
// since its constructor calls _startCollection which uses document/window/performance
let RUMCollector;

describe('RUMCollector', function () {

  before(function () {
    setupBrowserMocks();
    // Now import RUMCollector — constructor will use browser globals
    RUMCollector = require('../../../client/RUMCollector.js').default;
  });

  after(function () {
    teardownBrowserMocks();
  });

  let collector;
  let mockSessionManager;
  let mockBrowserContext;
  let clock;

  beforeEach(function () {
    // Use fake timers to prevent the 10-second setTimeout in _setupSendTriggers
    // from firing after teardown and crashing with "window is not defined"
    clock = sinon.useFakeTimers();
    resetWebVitals();

    mockSessionManager = {
      getSessionId: sinon.stub().returns('session-123')
    };
    mockBrowserContext = {
      collect: sinon.stub().returns({ browser: 'Chrome', os: 'Windows' }),
      getUserId: sinon.stub().returns(null)
    };

    // Create collector with user action tracking disabled to avoid DOM listeners
    collector = new RUMCollector(mockSessionManager, mockBrowserContext, {
      trackUserActions: false
    });
  });

  afterEach(function () {
    clock.restore();
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('initializes with empty state', function () {
      expect(collector.metrics).to.be.an('object');
      expect(collector.callbacks).to.be.an('array');
      expect(collector.sent).to.be.false;
      expect(collector.warnings).to.be.an('array');
    });

    it('has performance thresholds', function () {
      expect(collector.thresholds.lcp.good).to.equal(2500);
      expect(collector.thresholds.lcp.poor).to.equal(4000);
      expect(collector.thresholds.cls.good).to.equal(0.1);
      expect(collector.thresholds.fid.good).to.equal(100);
    });

    it('does not create UserActionTracker when disabled', function () {
      expect(collector.userActionTracker).to.be.null;
    });
  });

  // ==========================================
  // _checkThreshold
  // ==========================================
  describe('_checkThreshold', function () {

    it('rates good values as "good" with no warning', function () {
      collector._checkThreshold('lcp', 1000);
      expect(collector.metrics.lcpRating).to.equal('good');
      expect(collector.warnings).to.be.empty;
    });

    it('rates moderate values as "needs-improvement"', function () {
      collector._checkThreshold('lcp', 3000);
      expect(collector.metrics.lcpRating).to.equal('needs-improvement');
      expect(collector.warnings).to.have.lengthOf(1);
      expect(collector.warnings[0].rating).to.equal('needs-improvement');
    });

    it('rates poor values as "poor"', function () {
      collector._checkThreshold('lcp', 5000);
      expect(collector.metrics.lcpRating).to.equal('poor');
      expect(collector.warnings).to.have.lengthOf(1);
      expect(collector.warnings[0].rating).to.equal('poor');
    });

    it('handles CLS threshold (decimal values)', function () {
      collector._checkThreshold('cls', 0.05);
      expect(collector.metrics.clsRating).to.equal('good');

      collector._checkThreshold('cls', 0.15);
      expect(collector.metrics.clsRating).to.equal('needs-improvement');

      collector._checkThreshold('cls', 0.5);
      expect(collector.metrics.clsRating).to.equal('poor');
    });

    it('handles FID threshold', function () {
      collector._checkThreshold('fid', 50);
      expect(collector.metrics.fidRating).to.equal('good');

      collector._checkThreshold('fid', 200);
      expect(collector.metrics.fidRating).to.equal('needs-improvement');
    });

    it('ignores unknown metric names', function () {
      collector._checkThreshold('unknownMetric', 999);
      expect(collector.warnings).to.be.empty;
    });
  });

  // ==========================================
  // _getWarningMessage
  // ==========================================
  describe('_getWarningMessage', function () {

    it('returns poor LCP message', function () {
      const msg = collector._getWarningMessage('lcp', 5000, 'poor');
      expect(msg).to.include('Largest Contentful Paint');
      expect(msg).to.include('5000ms');
      expect(msg).to.include('slow');
    });

    it('returns needs-improvement FID message', function () {
      const msg = collector._getWarningMessage('fid', 200, 'needs-improvement');
      expect(msg).to.include('First Input Delay');
      expect(msg).to.include('200ms');
      expect(msg).to.include('needs improvement');
    });

    it('formats CLS with decimal', function () {
      const msg = collector._getWarningMessage('cls', 0.35, 'poor');
      expect(msg).to.include('0.350');
    });

    it('returns fallback message for unknown metric', function () {
      const msg = collector._getWarningMessage('custom', 100, 'poor');
      expect(msg).to.include('CUSTOM');
    });

    it('covers all metric types', function () {
      const metrics = ['lcp', 'fid', 'cls', 'ttfb', 'fcp', 'tti'];
      for (const m of metrics) {
        const msg = collector._getWarningMessage(m, 9999, 'poor');
        expect(msg).to.be.a('string').that.is.not.empty;
      }
    });
  });

  // ==========================================
  // _handleMetric
  // ==========================================
  describe('_handleMetric', function () {

    it('stores metric value', function () {
      collector._handleMetric('lcp', { value: 1500 });
      expect(collector.metrics.lcp).to.equal(1500);
    });

    it('checks threshold for the metric', function () {
      collector._handleMetric('fid', { value: 500 });
      expect(collector.metrics.fidRating).to.equal('poor');
    });
  });

  // ==========================================
  // _hasMinimumMetrics
  // ==========================================
  describe('_hasMinimumMetrics', function () {

    it('returns falsy when no metrics', function () {
      expect(collector._hasMinimumMetrics()).to.not.be.ok;
    });

    it('returns falsy with only ttfb', function () {
      collector.metrics.ttfb = 500;
      expect(collector._hasMinimumMetrics()).to.not.be.ok;
    });

    it('returns truthy with ttfb + lcp', function () {
      collector.metrics.ttfb = 500;
      collector.metrics.lcp = 2000;
      expect(collector._hasMinimumMetrics()).to.be.ok;
    });

    it('returns truthy with ttfb + fcp', function () {
      collector.metrics.ttfb = 500;
      collector.metrics.fcp = 1500;
      expect(collector._hasMinimumMetrics()).to.be.ok;
    });

    it('returns truthy with ttfb + fid', function () {
      collector.metrics.ttfb = 500;
      collector.metrics.fid = 50;
      expect(collector._hasMinimumMetrics()).to.be.ok;
    });
  });

  // ==========================================
  // _sendMeasurements
  // ==========================================
  describe('_sendMeasurements', function () {

    it('sends nothing when already sent', function () {
      const callback = sinon.stub();
      collector.onMeasurement(callback);
      collector.sent = true;
      collector.metrics = { ttfb: 500, lcp: 2000 };

      collector._sendMeasurements();
      expect(callback.called).to.be.false;
    });

    it('sends nothing without minimum metrics', function () {
      const callback = sinon.stub();
      collector.onMeasurement(callback);
      collector.metrics = {}; // No metrics

      collector._sendMeasurements();
      expect(callback.called).to.be.false;
    });

    it('sends measurement when has minimum metrics', function () {
      const callback = sinon.stub();
      collector.onMeasurement(callback);
      collector.metrics = { ttfb: 500, lcp: 2000, fcp: 1500 };

      collector._sendMeasurements();

      expect(callback.calledOnce).to.be.true;
      const measurement = callback.firstCall.args[0];
      expect(measurement.ttfb).to.equal(500);
      expect(measurement.lcp).to.equal(2000);
      expect(measurement.sessionId).to.equal('session-123');
      expect(measurement.timestamp).to.be.instanceOf(Date);
    });

    it('sets sent=true after sending', function () {
      collector.onMeasurement(sinon.stub());
      collector.metrics = { ttfb: 500, lcp: 2000 };

      collector._sendMeasurements();
      expect(collector.sent).to.be.true;
    });

    it('includes warnings when present', function () {
      const callback = sinon.stub();
      collector.onMeasurement(callback);
      collector.metrics = { ttfb: 500, lcp: 5000 };
      collector.warnings = [{ metric: 'lcp', rating: 'poor' }];

      collector._sendMeasurements();

      const measurement = callback.firstCall.args[0];
      expect(measurement.warnings).to.have.lengthOf(1);
    });

    it('handles callback errors gracefully', function () {
      collector.onMeasurement(() => { throw new Error('callback broke'); });
      collector.metrics = { ttfb: 500, lcp: 2000 };

      expect(() => collector._sendMeasurements()).to.not.throw();
    });
  });

  // ==========================================
  // onMeasurement
  // ==========================================
  describe('onMeasurement', function () {

    it('registers callbacks', function () {
      const cb1 = sinon.stub();
      const cb2 = sinon.stub();
      collector.onMeasurement(cb1);
      collector.onMeasurement(cb2);
      expect(collector.callbacks).to.have.lengthOf(2);
    });
  });

  // ==========================================
  // getMetrics / getWarnings
  // ==========================================
  describe('getMetrics / getWarnings', function () {

    it('getMetrics returns copy of metrics', function () {
      collector.metrics.lcp = 2000;
      const m = collector.getMetrics();
      expect(m.lcp).to.equal(2000);
      // Should be a copy
      m.lcp = 999;
      expect(collector.metrics.lcp).to.equal(2000);
    });

    it('getWarnings returns copy of warnings', function () {
      collector.warnings.push({ metric: 'lcp' });
      const w = collector.getWarnings();
      expect(w).to.have.lengthOf(1);
      w.push({ metric: 'test' });
      expect(collector.warnings).to.have.lengthOf(1);
    });
  });

  // ==========================================
  // reset
  // ==========================================
  describe('reset', function () {

    it('clears metrics, warnings, and sent flag', function () {
      collector.metrics = { lcp: 2000, ttfb: 500 };
      collector.warnings = [{ metric: 'lcp' }];
      collector.sent = true;

      collector.reset();

      // reset() clears core metrics and re-runs _collectTTI + _collectResourceTiming,
      // so metrics won't be empty {} but should have no core web vitals
      expect(collector.metrics.lcp).to.be.undefined;
      expect(collector.metrics.ttfb).to.be.undefined;
      expect(collector.warnings).to.be.empty;
      expect(collector.sent).to.be.false;
    });
  });
});
