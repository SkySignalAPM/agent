/**
 * DiagnosticsChannelCollector tests — request buffering, aggregation
 * (byHost, percentiles, statusCodes), event handling, getStats.
 *
 * Does NOT subscribe to real diagnostics channels —
 * tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import DiagnosticsChannelCollector from '../../../lib/collectors/DiagnosticsChannelCollector.js';

describe('DiagnosticsChannelCollector', function () {

  let collector;
  let mockClient;

  beforeEach(function () {
    mockClient = { addOutboundHttpMetric: sinon.stub() };
    collector = new DiagnosticsChannelCollector({
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
      expect(collector._requests).to.be.an('array').that.is.empty;
      expect(collector._maxRequests).to.equal(1000);
      expect(collector._subscriptions).to.be.an('array').that.is.empty;
    });
  });

  // ==========================================
  // _recordRequest
  // ==========================================
  describe('_recordRequest', function () {

    it('adds request with correct fields', function () {
      collector._recordRequest({
        method: 'GET',
        host: 'api.example.com',
        path: '/users',
        statusCode: 200,
        ttfb: 50,
        totalTime: 120
      }, false);

      expect(collector._requests).to.have.lengthOf(1);
      const r = collector._requests[0];
      expect(r.method).to.equal('GET');
      expect(r.host).to.equal('api.example.com');
      expect(r.statusCode).to.equal(200);
      expect(r.failed).to.be.false;
      expect(r.timestamp).to.be.a('number');
    });

    it('trims buffer at maxRequests', function () {
      collector._maxRequests = 5;
      for (let i = 0; i < 10; i++) {
        collector._recordRequest({
          method: 'GET', host: `h${i}`, path: '/',
          statusCode: 200, totalTime: i
        }, false);
      }
      expect(collector._requests).to.have.lengthOf(5);
      expect(collector._requests[0].host).to.equal('h5');
    });

    it('records failed requests', function () {
      collector._recordRequest({
        method: 'POST', host: 'api.com', path: '/',
        totalTime: 100, error: 'ECONNREFUSED'
      }, true);

      expect(collector._requests[0].failed).to.be.true;
      expect(collector._requests[0].error).to.equal('ECONNREFUSED');
    });
  });

  // ==========================================
  // _collect
  // ==========================================
  describe('_collect', function () {

    it('does nothing when requests are empty', function () {
      collector._collect();
      expect(mockClient.addOutboundHttpMetric.called).to.be.false;
    });

    it('sends aggregated metric', function () {
      collector._recordRequest({ method: 'GET', host: 'a.com', path: '/', statusCode: 200, ttfb: 10, totalTime: 50 }, false);
      collector._recordRequest({ method: 'POST', host: 'a.com', path: '/data', statusCode: 201, ttfb: 20, totalTime: 100 }, false);
      collector._recordRequest({ method: 'GET', host: 'b.com', path: '/', statusCode: 500, ttfb: 5, totalTime: 200 }, false);
      collector._recordRequest({ method: 'GET', host: 'c.com', path: '/', totalTime: 300, error: 'timeout' }, true);

      collector._collect();

      expect(mockClient.addOutboundHttpMetric.calledOnce).to.be.true;
      const metric = mockClient.addOutboundHttpMetric.firstCall.args[0];

      expect(metric.totalRequests).to.equal(4);
      expect(metric.totalFailures).to.equal(1);
      expect(metric.uniqueHosts).to.equal(3);
      expect(metric.host).to.equal('test-host');
      expect(metric.timestamp).to.be.instanceOf(Date);
    });

    it('calculates percentiles', function () {
      for (let i = 1; i <= 100; i++) {
        collector._recordRequest({
          method: 'GET', host: 'h.com', path: '/',
          statusCode: 200, ttfb: i / 2, totalTime: i
        }, false);
      }
      collector._collect();

      const metric = mockClient.addOutboundHttpMetric.firstCall.args[0];
      // Math.floor(100 * 0.5) = 50 → times[50] = 51
      expect(metric.p50ResponseTime).to.equal(51);
      expect(metric.p95ResponseTime).to.equal(96);
      expect(metric.p99ResponseTime).to.equal(100);
    });

    it('groups status codes by Nxx', function () {
      collector._recordRequest({ method: 'GET', host: 'a.com', path: '/', statusCode: 200, ttfb: 1, totalTime: 10 }, false);
      collector._recordRequest({ method: 'GET', host: 'a.com', path: '/', statusCode: 201, ttfb: 1, totalTime: 10 }, false);
      collector._recordRequest({ method: 'GET', host: 'a.com', path: '/', statusCode: 404, ttfb: 1, totalTime: 10 }, false);
      collector._recordRequest({ method: 'GET', host: 'a.com', path: '/', statusCode: 0, ttfb: 1, totalTime: 10 }, true);

      collector._collect();

      const metric = mockClient.addOutboundHttpMetric.firstCall.args[0];
      const hostA = metric.topHosts.find(h => h.host === 'a.com');
      expect(hostA.statusCodes['2xx']).to.equal(2);
      expect(hostA.statusCodes['4xx']).to.equal(1);
      expect(hostA.statusCodes['err']).to.equal(1);
    });

    it('topHosts limited to 20 and sorted by count', function () {
      for (let h = 0; h < 25; h++) {
        for (let i = 0; i < h + 1; i++) {
          collector._recordRequest({
            method: 'GET', host: `host${h}.com`, path: '/',
            statusCode: 200, ttfb: 1, totalTime: 10
          }, false);
        }
      }
      collector._collect();

      const metric = mockClient.addOutboundHttpMetric.firstCall.args[0];
      expect(metric.topHosts).to.have.lengthOf(20);
      expect(metric.topHosts[0].host).to.equal('host24.com');
    });

    it('clears requests after collection', function () {
      collector._recordRequest({ method: 'GET', host: 'a.com', path: '/', statusCode: 200, ttfb: 1, totalTime: 10 }, false);
      collector._collect();
      expect(collector._requests).to.have.lengthOf(0);
    });
  });

  // ==========================================
  // _handleUndiciEvent
  // ==========================================
  describe('_handleUndiciEvent', function () {

    it('tracks request lifecycle: create → headers → trailers', function () {
      const req = { method: 'GET', origin: 'https://api.com', path: '/test' };

      collector._handleUndiciEvent('undici:request:create', { request: req });
      expect(collector._inFlight.has(req)).to.be.true;

      collector._handleUndiciEvent('undici:request:headers', {
        request: req,
        response: { statusCode: 200 }
      });

      collector._handleUndiciEvent('undici:request:trailers', { request: req });
      expect(collector._inFlight.has(req)).to.be.false;
      expect(collector._requests).to.have.lengthOf(1);
      expect(collector._requests[0].failed).to.be.false;
    });

    it('tracks error events', function () {
      const req = { method: 'POST', origin: 'https://api.com', path: '/data' };

      collector._handleUndiciEvent('undici:request:create', { request: req });
      collector._handleUndiciEvent('undici:request:error', {
        request: req,
        error: { message: 'ECONNREFUSED' }
      });

      expect(collector._requests).to.have.lengthOf(1);
      expect(collector._requests[0].failed).to.be.true;
      expect(collector._requests[0].error).to.equal('ECONNREFUSED');
    });

    it('ignores events with no request', function () {
      expect(() => {
        collector._handleUndiciEvent('undici:request:create', {});
        collector._handleUndiciEvent('undici:request:headers', {});
      }).to.not.throw();
    });
  });

  // ==========================================
  // _handleHttpEvent
  // ==========================================
  describe('_handleHttpEvent', function () {

    it('tracks http request lifecycle', function () {
      const req = { method: 'GET', hostname: 'example.com', path: '/api' };

      collector._handleHttpEvent('http.client.request.start', { request: req });
      expect(collector._inFlight.has(req)).to.be.true;

      collector._handleHttpEvent('http.client.response.finish', {
        request: req,
        response: { statusCode: 200 }
      });

      expect(collector._requests).to.have.lengthOf(1);
      expect(collector._requests[0].statusCode).to.equal(200);
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns pending requests and subscription count', function () {
      collector._recordRequest({ method: 'GET', host: 'a.com', path: '/', statusCode: 200, totalTime: 10 }, false);
      const stats = collector.getStats();
      expect(stats.pendingRequests).to.equal(1);
      expect(stats.subscriptions).to.equal(0);
    });
  });
});
