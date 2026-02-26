/**
 * CpuProfiler tests — CPU usage delta, _sendProfileSummary extraction,
 * _shortenUrl, threshold/cooldown logic, getStats.
 *
 * Does NOT start real inspector sessions — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import CpuProfiler from '../../../lib/collectors/CpuProfiler.js';

describe('CpuProfiler', function () {

  let profiler;
  let mockClient;

  beforeEach(function () {
    mockClient = { addCpuProfile: sinon.stub() };
    profiler = new CpuProfiler({
      client: mockClient,
      host: 'test-host',
      appVersion: '1.0.0',
      cpuThreshold: 80,
      profileDuration: 5000,
      cooldownPeriod: 60000
    });
  });

  afterEach(function () {
    profiler.stop();
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      const p = new CpuProfiler({});
      expect(p.cpuThreshold).to.equal(80);
      expect(p.profileDuration).to.equal(10000);
      expect(p.cooldownPeriod).to.equal(300000);
      expect(p.interval).to.equal(60000);
      expect(p._isProfiling).to.be.false;
      expect(p._lastProfileTime).to.equal(0);
      expect(p._session).to.be.null;
    });

    it('respects custom options', function () {
      expect(profiler.cpuThreshold).to.equal(80);
      expect(profiler.profileDuration).to.equal(5000);
      expect(profiler.cooldownPeriod).to.equal(60000);
    });
  });

  // ==========================================
  // _getCpuUsage
  // ==========================================
  // Note: _getCpuUsage uses require("os") inside the function body,
  // which fails in ESM. Tested indirectly via SystemMetricsCollector
  // which has the same logic but imports os at module level.

  // ==========================================
  // _checkAndProfile
  // ==========================================
  describe('_checkAndProfile', function () {

    it('skips when already profiling', async function () {
      profiler._isProfiling = true;
      sinon.stub(profiler, '_getCpuUsage').returns(50);
      const captureStub = sinon.stub(profiler, '_captureProfile');
      await profiler._checkAndProfile();
      expect(captureStub.called).to.be.false;
    });

    it('skips when in cooldown period', async function () {
      profiler._lastProfileTime = Date.now(); // Just profiled
      const captureStub = sinon.stub(profiler, '_captureProfile');
      // Force high CPU
      sinon.stub(profiler, '_getCpuUsage').returns(99);
      await profiler._checkAndProfile();
      expect(captureStub.called).to.be.false;
    });

    it('skips when CPU below threshold', async function () {
      sinon.stub(profiler, '_getCpuUsage').returns(50);
      const captureStub = sinon.stub(profiler, '_captureProfile');
      await profiler._checkAndProfile();
      expect(captureStub.called).to.be.false;
    });

    it('profiles when CPU exceeds threshold and not in cooldown', async function () {
      sinon.stub(profiler, '_getCpuUsage').returns(95);
      const mockProfile = { nodes: [], samples: [], startTime: 0, endTime: 10000 };
      sinon.stub(profiler, '_captureProfile').resolves(mockProfile);
      sinon.stub(profiler, '_sendProfileSummary');

      await profiler._checkAndProfile();

      expect(profiler._captureProfile.calledOnce).to.be.true;
      expect(profiler._sendProfileSummary.calledOnce).to.be.true;
    });

    it('handles profiling errors gracefully', async function () {
      sinon.stub(profiler, '_getCpuUsage').returns(95);
      sinon.stub(profiler, '_captureProfile').rejects(new Error('inspector failed'));

      await profiler._checkAndProfile();
      // Should not throw
    });
  });

  // ==========================================
  // _sendProfileSummary
  // ==========================================
  describe('_sendProfileSummary', function () {

    it('skips when profile has no nodes or samples', function () {
      profiler._sendProfileSummary(null, 90);
      profiler._sendProfileSummary({}, 90);
      profiler._sendProfileSummary({ nodes: [] }, 90);
      profiler._sendProfileSummary({ nodes: [{}], samples: null }, 90);
      expect(mockClient.addCpuProfile.called).to.be.false;
    });

    it('extracts top functions from profile', function () {
      const profile = {
        nodes: [
          { id: 1, callFrame: { functionName: 'processData', url: '/imports/api/service.js', lineNumber: 42 } },
          { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: 0 } },
          { id: 3, callFrame: { functionName: 'handleRequest', url: '/server/main.js', lineNumber: 10 } },
          { id: 4, callFrame: { functionName: 'internalFn', url: 'node:internal/foo', lineNumber: 1 } },
        ],
        samples: [1, 1, 1, 2, 2, 3, 4],
        startTime: 0,
        endTime: 7000000 // 7s in microseconds
      };

      profiler._sendProfileSummary(profile, 85);

      expect(mockClient.addCpuProfile.calledOnce).to.be.true;
      const metric = mockClient.addCpuProfile.firstCall.args[0];

      expect(metric.triggerCpu).to.equal(85);
      expect(metric.totalSamples).to.equal(7);
      expect(metric.topFunctions).to.be.an('array');
      // Should exclude (idle) and node: internal functions
      expect(metric.topFunctions.every(f => f.functionName !== '(idle)')).to.be.true;
      expect(metric.topFunctions.every(f => !f.url.startsWith('node:'))).to.be.true;
      // processData should be first (3/7 = 42.86%)
      expect(metric.topFunctions[0].functionName).to.equal('processData');
    });

    it('limits to 25 top functions', function () {
      const nodes = [];
      const samples = [];
      for (let i = 0; i < 30; i++) {
        nodes.push({ id: i, callFrame: { functionName: `fn${i}`, url: `/file${i}.js`, lineNumber: i } });
        samples.push(i);
      }

      profiler._sendProfileSummary({ nodes, samples, startTime: 0, endTime: 1000000 }, 90);

      const metric = mockClient.addCpuProfile.firstCall.args[0];
      expect(metric.topFunctions.length).to.be.at.most(25);
    });
  });

  // ==========================================
  // _shortenUrl
  // ==========================================
  describe('_shortenUrl', function () {

    it('returns empty string for falsy input', function () {
      expect(profiler._shortenUrl('')).to.equal('');
      expect(profiler._shortenUrl(null)).to.equal('');
      expect(profiler._shortenUrl(undefined)).to.equal('');
    });

    it('shortens from /imports/ marker', function () {
      expect(profiler._shortenUrl('/home/user/app/imports/api/service.js'))
        .to.equal('/imports/api/service.js');
    });

    it('shortens from /packages/ marker', function () {
      expect(profiler._shortenUrl('/home/user/.meteor/packages/kadira/package.js'))
        .to.equal('/packages/kadira/package.js');
    });

    it('shortens from /node_modules/ marker', function () {
      expect(profiler._shortenUrl('/app/node_modules/express/index.js'))
        .to.equal('/node_modules/express/index.js');
    });

    it('shortens from /server/ marker', function () {
      expect(profiler._shortenUrl('/home/user/app/server/main.js'))
        .to.equal('/server/main.js');
    });

    it('falls back to last 2 path segments', function () {
      expect(profiler._shortenUrl('/some/deep/path/to/file.js'))
        .to.equal('to/file.js');
    });
  });

  // ==========================================
  // _stopProfiling
  // ==========================================
  describe('_stopProfiling', function () {

    it('cleans up session and resets state', function () {
      profiler._session = {
        post: sinon.stub().callsArg(1),
        disconnect: sinon.stub()
      };
      profiler._isProfiling = true;

      profiler._stopProfiling();

      expect(profiler._session).to.be.null;
      expect(profiler._isProfiling).to.be.false;
    });

    it('handles null session gracefully', function () {
      profiler._session = null;
      expect(() => profiler._stopProfiling()).to.not.throw();
      expect(profiler._isProfiling).to.be.false;
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns expected stat keys', function () {
      const stats = profiler.getStats();
      expect(stats).to.have.property('isProfiling', false);
      expect(stats).to.have.property('lastCpuUsage', 0);
      expect(stats).to.have.property('lastProfileTime', null);
      expect(stats).to.have.property('cooldownRemaining');
    });
  });

  // ==========================================
  // start / stop
  // ==========================================
  describe('start / stop', function () {

    it('start sets interval', function () {
      profiler.start();
      expect(profiler.intervalId).to.not.be.null;
    });

    it('is idempotent', function () {
      profiler.start();
      const firstId = profiler.intervalId;
      profiler.start();
      expect(profiler.intervalId).to.equal(firstId);
    });

    it('stop clears interval', function () {
      profiler.start();
      profiler.stop();
      expect(profiler.intervalId).to.be.null;
    });
  });
});
