/**
 * SystemMetricsCollector tests — pure helper methods: CPU usage delta,
 * heap space stats, resource usage, active resources, constrained memory.
 *
 * Does NOT test full _collect cycle (requires Meteor + exec) —
 * tests individual helper methods and lifecycle only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import SystemMetricsCollector from '../../../lib/collectors/SystemMetricsCollector.js';

describe('SystemMetricsCollector', function () {

  let collector;
  let mockClient;

  beforeEach(function () {
    mockClient = { addSystemMetric: sinon.stub() };
    collector = new SystemMetricsCollector({
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
      expect(collector.platform).to.be.a('string');
      expect(collector.previousCpuStats).to.be.null;
      expect(collector.cachedDiskStats).to.be.null;
      expect(collector.diskStatsCacheTTL).to.equal(300000);
    });

    it('initializes GC stats', function () {
      expect(collector.gcStats).to.deep.equal({
        count: 0,
        totalDuration: 0,
        totalPauseTime: 0
      });
    });

    it('starts event loop monitoring', function () {
      expect(collector.eventLoopIntervalId).to.not.be.null;
    });
  });

  // ==========================================
  // _getCpuUsage
  // ==========================================
  describe('_getCpuUsage', function () {

    it('returns 0 on first call (baseline)', function () {
      collector.previousCpuStats = null;
      expect(collector._getCpuUsage()).to.equal(0);
    });

    it('stores previous CPU stats after first call', function () {
      collector._getCpuUsage();
      expect(collector.previousCpuStats).to.have.property('idle');
      expect(collector.previousCpuStats).to.have.property('total');
    });

    it('returns value between 0-100 on second call', function () {
      collector._getCpuUsage(); // baseline
      const usage = collector._getCpuUsage();
      expect(usage).to.be.at.least(0);
      expect(usage).to.be.at.most(100);
    });
  });

  // ==========================================
  // _getHeapSpaceStats
  // ==========================================
  describe('_getHeapSpaceStats', function () {

    it('returns object with heap space breakdown', function () {
      const stats = collector._getHeapSpaceStats();
      expect(stats).to.be.an('object');
      // Should have at least new_space and old_space
      const spaceNames = Object.keys(stats);
      expect(spaceNames.length).to.be.greaterThan(0);
    });

    it('each space has size, used, available, physical', function () {
      const stats = collector._getHeapSpaceStats();
      const firstSpace = Object.values(stats)[0];
      expect(firstSpace).to.have.property('size').that.is.a('number');
      expect(firstSpace).to.have.property('used').that.is.a('number');
      expect(firstSpace).to.have.property('available').that.is.a('number');
      expect(firstSpace).to.have.property('physical').that.is.a('number');
    });
  });

  // ==========================================
  // _getResourceUsage
  // ==========================================
  describe('_getResourceUsage', function () {

    it('returns object with expected fields (Node 12+)', function () {
      const usage = collector._getResourceUsage();
      if (typeof process.resourceUsage === 'function') {
        expect(usage).to.have.property('userCPUTime').that.is.a('number');
        expect(usage).to.have.property('systemCPUTime').that.is.a('number');
        expect(usage).to.have.property('maxRSS').that.is.a('number');
        expect(usage).to.have.property('voluntaryContextSwitches');
        expect(usage).to.have.property('involuntaryContextSwitches');
        expect(usage).to.have.property('fsRead');
        expect(usage).to.have.property('fsWrite');
      } else {
        expect(usage).to.be.null;
      }
    });
  });

  // ==========================================
  // _getActiveResources
  // ==========================================
  describe('_getActiveResources', function () {

    it('returns resource info if available (Node 17+)', function () {
      const resources = collector._getActiveResources();
      if (typeof process.getActiveResourcesInfo === 'function') {
        expect(resources).to.have.property('total').that.is.a('number');
        expect(resources).to.have.property('byType').that.is.an('object');
      } else {
        expect(resources).to.be.null;
      }
    });
  });

  // ==========================================
  // _getConstrainedMemory
  // ==========================================
  describe('_getConstrainedMemory', function () {

    it('returns null or number', function () {
      const result = collector._getConstrainedMemory();
      if (typeof process.constrainedMemory === 'function') {
        // Could be null (no cgroup limit) or a number
        expect(result === null || typeof result === 'number').to.be.true;
      } else {
        expect(result).to.be.null;
      }
    });
  });

  // ==========================================
  // _getDiskStats (caching)
  // ==========================================
  describe('_getDiskStats', function () {

    it('returns cached stats if still valid', async function () {
      collector.cachedDiskStats = { diskUsage: 50, diskTotal: 100, diskUsed: 50, diskFree: 50 };
      collector.diskStatsCacheTime = Date.now(); // just cached
      const stats = await collector._getDiskStats();
      expect(stats).to.deep.equal(collector.cachedDiskStats);
    });

    it('returns zero defaults on error with no cache', async function () {
      collector.cachedDiskStats = null;
      collector.diskStatsCacheTime = 0;
      // Force cache miss + command failure
      collector.platform = 'unsupported_platform';
      const stats = await collector._getDiskStats();
      expect(stats.diskUsage).to.equal(0);
    });
  });

  // ==========================================
  // start / stop
  // ==========================================
  describe('start / stop', function () {

    it('is idempotent', async function () {
      // Mock _collect to avoid real Meteor dependency
      sinon.stub(collector, '_collect').resolves();
      await collector.start();
      const firstId = collector.intervalId;
      await collector.start();
      expect(collector.intervalId).to.equal(firstId);
      collector.stop();
    });

    it('stop clears all intervals and GC observer', function () {
      // Set up fake intervals
      collector.intervalId = setInterval(() => {}, 100000);
      collector.stop();
      expect(collector.intervalId).to.be.null;
      expect(collector.eventLoopIntervalId).to.be.null;
      expect(collector.gcObserver).to.be.null;
    });
  });
});
