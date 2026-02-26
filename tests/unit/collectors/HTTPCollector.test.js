/**
 * HTTPCollector tests — pure functions: route extraction, exclusion matching,
 * object pool, client IP extraction, and batch management.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import HTTPCollector from '../../../lib/collectors/HTTPCollector.js';

describe('HTTPCollector', function () {

  let collector;

  beforeEach(function () {
    collector = new HTTPCollector({
      client: null,
      host: 'test-host'
    });
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      expect(collector.host).to.equal('test-host');
      expect(collector.interval).to.equal(10000);
      expect(collector.sampleRate).to.equal(1.0);
      expect(collector.maxBatchSize).to.equal(1000);
      expect(collector.batch).to.be.an('array').that.is.empty;
    });

    it('uses default exclude regex when no custom patterns provided', function () {
      expect(collector._excludeRegex).to.be.instanceOf(RegExp);
    });

    it('compiles custom exclude patterns into single regex', function () {
      const custom = new HTTPCollector({
        excludePatterns: ['/health', /\/api\/internal/]
      });
      expect(custom._excludeRegex).to.be.instanceOf(RegExp);
      expect(custom._excludeRegex.test('/health')).to.be.true;
      expect(custom._excludeRegex.test('/api/internal/check')).to.be.true;
      expect(custom._excludeRegex.test('/api/v1/users')).to.be.false;
    });

    it('initializes object pool of size 50', function () {
      expect(collector._requestPool).to.have.lengthOf(50);
      expect(collector._requestPool[0]).to.have.property('method');
      expect(collector._requestPool[0]).to.have.property('statusCode');
    });
  });

  // ==========================================
  // _shouldTrack
  // ==========================================
  describe('_shouldTrack', function () {

    it('excludes sockjs paths', function () {
      expect(collector._shouldTrack('/sockjs/info')).to.be.false;
      expect(collector._shouldTrack('/sockjs/123/abc/websocket')).to.be.false;
    });

    it('excludes meteor_runtime_config.js', function () {
      expect(collector._shouldTrack('/meteor_runtime_config.js')).to.be.false;
    });

    it('excludes favicon.ico', function () {
      expect(collector._shouldTrack('/favicon.ico')).to.be.false;
    });

    it('excludes __browser and __cordova paths', function () {
      expect(collector._shouldTrack('/__browser/some-file.js')).to.be.false;
      expect(collector._shouldTrack('/__cordova/plugin.js')).to.be.false;
    });

    it('allows normal API paths', function () {
      expect(collector._shouldTrack('/api/v1/users')).to.be.true;
      expect(collector._shouldTrack('/app/dashboard')).to.be.true;
    });

    it('allows root path', function () {
      expect(collector._shouldTrack('/')).to.be.true;
    });
  });

  // ==========================================
  // _extractRoute
  // ==========================================
  describe('_extractRoute', function () {

    it('uses req.route.path if available', function () {
      const req = { url: '/api/v1/users/123', route: { path: '/api/v1/users/:id' } };
      expect(collector._extractRoute(req)).to.equal('/api/v1/users/:id');
    });

    it('normalizes MongoDB ObjectIDs in API paths', function () {
      const req = { url: '/api/v1/users/507f1f77bcf86cd799439011' };
      expect(collector._extractRoute(req)).to.equal('/api/v1/users/:id');
    });

    it('normalizes UUIDs in API paths', function () {
      const req = { url: '/api/v1/users/550e8400-e29b-41d4-a716-446655440000' };
      expect(collector._extractRoute(req)).to.equal('/api/v1/users/:uuid');
    });

    it('normalizes numeric IDs in API paths', function () {
      const req = { url: '/api/v1/orders/12345' };
      expect(collector._extractRoute(req)).to.equal('/api/v1/orders/:id');
    });

    it('strips query strings', function () {
      const req = { url: '/api/v1/users?page=1&limit=20' };
      expect(collector._extractRoute(req)).to.equal('/api/v1/users');
    });

    it('returns static file paths as-is', function () {
      const req = { url: '/assets/app.js' };
      expect(collector._extractRoute(req)).to.equal('/assets/app.js');
    });

    it('returns non-API paths as-is', function () {
      const req = { url: '/dashboard/settings' };
      expect(collector._extractRoute(req)).to.equal('/dashboard/settings');
    });
  });

  // ==========================================
  // _getClientIP
  // ==========================================
  describe('_getClientIP', function () {

    it('uses x-forwarded-for header (first entry)', function () {
      const req = {
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
        connection: {}
      };
      expect(collector._getClientIP(req)).to.equal('1.2.3.4');
    });

    it('uses x-real-ip header', function () {
      const req = {
        headers: { 'x-real-ip': '10.0.0.1' },
        connection: {}
      };
      expect(collector._getClientIP(req)).to.equal('10.0.0.1');
    });

    it('falls back to connection.remoteAddress', function () {
      const req = {
        headers: {},
        connection: { remoteAddress: '127.0.0.1' }
      };
      expect(collector._getClientIP(req)).to.equal('127.0.0.1');
    });

    it('returns "unknown" when no address available', function () {
      const req = { headers: {}, connection: {} };
      expect(collector._getClientIP(req)).to.equal('unknown');
    });
  });

  // ==========================================
  // _getPooledObject (circular pool)
  // ==========================================
  describe('_getPooledObject', function () {

    it('returns objects from the pool in round-robin order', function () {
      const obj1 = collector._getPooledObject();
      const obj2 = collector._getPooledObject();
      expect(obj1).to.not.equal(obj2);
    });

    it('wraps around after pool size (50)', function () {
      const first = collector._getPooledObject();
      // Advance through entire pool
      for (let i = 1; i < 50; i++) {
        collector._getPooledObject();
      }
      // Should wrap back to the first object
      const wrapped = collector._getPooledObject();
      expect(wrapped).to.equal(first);
    });
  });

  // ==========================================
  // _sendBatch
  // ==========================================
  describe('_sendBatch', function () {

    it('does nothing when batch is empty', function () {
      collector.client = { addHttpRequest: sinon.stub() };
      collector._sendBatch();
      expect(collector.client.addHttpRequest.called).to.be.false;
    });

    it('sends all items and clears batch', function () {
      collector.client = { addHttpRequest: sinon.stub() };
      collector.batch = [{ method: 'GET' }, { method: 'POST' }];
      collector._sendBatch();
      expect(collector.client.addHttpRequest.callCount).to.equal(2);
      expect(collector.batch).to.have.lengthOf(0);
    });

    it('does nothing when no client', function () {
      collector.client = null;
      collector.batch = [{ method: 'GET' }];
      expect(() => collector._sendBatch()).to.not.throw();
      expect(collector.batch).to.have.lengthOf(0);
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns expected stat keys', function () {
      const stats = collector.getStats();
      expect(stats).to.have.property('pendingRequests', 0);
      expect(stats).to.have.property('sampleRate', 1.0);
      expect(stats).to.have.property('excludePattern');
      expect(stats).to.have.property('poolIndex');
      expect(stats).to.have.property('poolSize', 50);
    });
  });
});
