/**
 * DnsTimingCollector tests — ring buffer, aggregation (percentiles, topHostnames),
 * start/stop lifecycle, getStats.
 *
 * Does NOT wrap real dns — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import DnsTimingCollector from '../../../lib/collectors/DnsTimingCollector.js';

describe('DnsTimingCollector', function () {

  let collector;
  let mockClient;

  beforeEach(function () {
    mockClient = { addDnsMetric: sinon.stub() };
    collector = new DnsTimingCollector({
      client: mockClient,
      host: 'test-host',
      appVersion: '1.0.0'
    });
  });

  afterEach(function () {
    collector.stop();
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      expect(collector.host).to.equal('test-host');
      expect(collector.interval).to.equal(60000);
      expect(collector._samples).to.be.an('array').that.is.empty;
      expect(collector._maxSamples).to.equal(500);
      expect(collector._originalLookup).to.be.null;
      expect(collector._originalResolve).to.be.null;
    });
  });

  // ==========================================
  // _recordSample
  // ==========================================
  describe('_recordSample', function () {

    it('adds a sample with correct fields', function () {
      collector._recordSample('example.com', 'lookup', 12.345, false);
      expect(collector._samples).to.have.lengthOf(1);
      const s = collector._samples[0];
      expect(s.hostname).to.equal('example.com');
      expect(s.method).to.equal('lookup');
      expect(s.duration).to.equal(12.345);
      expect(s.failed).to.be.false;
      expect(s.timestamp).to.be.a('number');
    });

    it('trims buffer at maxSamples', function () {
      collector._maxSamples = 5;
      for (let i = 0; i < 10; i++) {
        collector._recordSample(`host${i}`, 'lookup', i, false);
      }
      expect(collector._samples).to.have.lengthOf(5);
      // Should keep the most recent entries
      expect(collector._samples[0].hostname).to.equal('host5');
    });
  });

  // ==========================================
  // _collect
  // ==========================================
  describe('_collect', function () {

    it('does nothing when samples are empty', function () {
      collector._collect();
      expect(mockClient.addDnsMetric.called).to.be.false;
    });

    it('sends aggregated metric', function () {
      collector._recordSample('a.com', 'lookup', 10, false);
      collector._recordSample('a.com', 'lookup', 20, false);
      collector._recordSample('b.com', 'resolve', 5, false);
      collector._recordSample('c.com', 'lookup', 100, true);

      collector._collect();

      expect(mockClient.addDnsMetric.calledOnce).to.be.true;
      const metric = mockClient.addDnsMetric.firstCall.args[0];

      expect(metric.totalLookups).to.equal(4);
      expect(metric.totalFailures).to.equal(1);
      expect(metric.uniqueHostnames).to.equal(3);
      expect(metric.host).to.equal('test-host');
      expect(metric.timestamp).to.be.instanceOf(Date);
    });

    it('calculates percentiles correctly', function () {
      // Add 100 samples with durations 1-100
      for (let i = 1; i <= 100; i++) {
        collector._recordSample('host.com', 'lookup', i, false);
      }
      collector._collect();

      const metric = mockClient.addDnsMetric.firstCall.args[0];
      // Math.ceil(100 * 0.5) - 1 = 49 → durations[49] = 50
      expect(metric.p50Duration).to.equal(50);
      expect(metric.p95Duration).to.equal(95);
      expect(metric.p99Duration).to.equal(99);
      expect(metric.maxDuration).to.equal(100);
    });

    it('builds topHostnames sorted by count (max 15)', function () {
      // Create 20 unique hosts with varying counts
      for (let h = 0; h < 20; h++) {
        for (let i = 0; i < h + 1; i++) {
          collector._recordSample(`host${h}.com`, 'lookup', 1, false);
        }
      }
      collector._collect();

      const metric = mockClient.addDnsMetric.firstCall.args[0];
      expect(metric.topHostnames).to.have.lengthOf(15);
      // Most frequent host should be first
      expect(metric.topHostnames[0].hostname).to.equal('host19.com');
      expect(metric.topHostnames[0].count).to.equal(20);
    });

    it('clears samples after collection', function () {
      collector._recordSample('a.com', 'lookup', 10, false);
      collector._collect();
      expect(collector._samples).to.have.lengthOf(0);
    });

    it('tracks per-hostname max duration and failures', function () {
      collector._recordSample('a.com', 'lookup', 10, false);
      collector._recordSample('a.com', 'lookup', 50, false);
      collector._recordSample('a.com', 'lookup', 5, true);

      collector._collect();

      const metric = mockClient.addDnsMetric.firstCall.args[0];
      const hostA = metric.topHostnames.find(h => h.hostname === 'a.com');
      expect(hostA.maxDuration).to.equal(50);
      expect(hostA.failures).to.equal(1);
      expect(hostA.count).to.equal(3);
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns pending sample count', function () {
      collector._recordSample('a.com', 'lookup', 1, false);
      collector._recordSample('b.com', 'lookup', 2, false);
      expect(collector.getStats().pendingSamples).to.equal(2);
    });
  });

  // ==========================================
  // start / stop
  // ==========================================
  describe('start / stop', function () {

    it('start sets interval', function () {
      collector.start();
      expect(collector.intervalId).to.not.be.null;
    });

    it('is idempotent', function () {
      collector.start();
      const firstId = collector.intervalId;
      collector.start(); // second call is no-op
      expect(collector.intervalId).to.equal(firstId);
    });

    it('stop clears interval', function () {
      collector.start();
      collector.stop();
      expect(collector.intervalId).to.be.null;
    });

    it('unwraps dns on stop', function () {
      collector._originalLookup = () => {};
      collector._originalResolve = () => {};
      collector.stop();
      expect(collector._originalLookup).to.be.null;
      expect(collector._originalResolve).to.be.null;
    });
  });
});
