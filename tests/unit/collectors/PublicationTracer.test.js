/**
 * PublicationTracer tests — cursor analysis, projection detection,
 * _collect aggregation, start/stop lifecycle.
 *
 * Does NOT wrap real Meteor.publish — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import PublicationTracer from '../../../lib/collectors/PublicationTracer.js';

describe('PublicationTracer', function () {

  let tracer;
  let mockClient;

  beforeEach(function () {
    mockClient = { addPublicationMetric: sinon.stub() };
    tracer = new PublicationTracer({
      client: mockClient,
      host: 'test-host',
      appVersion: '1.0.0'
    });
  });

  afterEach(function () {
    tracer.stop();
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      expect(tracer.host).to.equal('test-host');
      expect(tracer.interval).to.equal(300000);
      expect(tracer.docCountThreshold).to.equal(100);
      expect(tracer._wrapped).to.be.false;
      expect(tracer._stats).to.deep.equal({});
    });

    it('respects custom options', function () {
      const t = new PublicationTracer({ docCountThreshold: 50, interval: 60000 });
      expect(t.docCountThreshold).to.equal(50);
      expect(t.interval).to.equal(60000);
    });
  });

  // ==========================================
  // _analyzeCursors
  // ==========================================
  describe('_analyzeCursors', function () {

    it('initializes stats for a new publication', function () {
      const cursor = {
        _cursorDescription: { options: { fields: { name: 1 }, limit: 50 } }
      };
      tracer._analyzeCursors('usersList', cursor);

      expect(tracer._stats['usersList']).to.exist;
      expect(tracer._stats['usersList'].callCount).to.equal(1);
    });

    it('detects missing projection', function () {
      const cursor = {
        _cursorDescription: { options: {} }
      };
      tracer._analyzeCursors('allUsers', cursor);
      expect(tracer._stats['allUsers'].noProjectionCount).to.equal(1);
    });

    it('detects empty projection object', function () {
      const cursor = {
        _cursorDescription: { options: { fields: {} } }
      };
      tracer._analyzeCursors('allUsers', cursor);
      expect(tracer._stats['allUsers'].noProjectionCount).to.equal(1);
    });

    it('does not flag when projection exists', function () {
      const cursor = {
        _cursorDescription: { options: { fields: { name: 1, email: 1 } } }
      };
      tracer._analyzeCursors('users', cursor);
      expect(tracer._stats['users'].noProjectionCount).to.equal(0);
    });

    it('supports projection key as well as fields key', function () {
      const cursor = {
        _cursorDescription: { options: { projection: { name: 1 } } }
      };
      tracer._analyzeCursors('users', cursor);
      expect(tracer._stats['users'].noProjectionCount).to.equal(0);
    });

    it('detects missing limit', function () {
      const cursor = {
        _cursorDescription: { options: {} }
      };
      tracer._analyzeCursors('allPosts', cursor);
      expect(tracer._stats['allPosts'].hasLimit).to.be.false;
    });

    it('tracks limit and document counts', function () {
      const cursor = {
        _cursorDescription: { options: { fields: { a: 1 }, limit: 25 } }
      };
      tracer._analyzeCursors('posts', cursor);
      tracer._analyzeCursors('posts', cursor);

      expect(tracer._stats['posts'].totalDocs).to.equal(50);
      expect(tracer._stats['posts'].maxDocs).to.equal(25);
      expect(tracer._stats['posts'].callCount).to.equal(2);
    });

    it('handles array of cursors', function () {
      const cursors = [
        { _cursorDescription: { options: { fields: { a: 1 }, limit: 10 } } },
        { _cursorDescription: { options: {} } }
      ];
      tracer._analyzeCursors('composite', cursors);
      expect(tracer._stats['composite'].noProjectionCount).to.equal(1);
      expect(tracer._stats['composite'].totalDocs).to.equal(10);
    });

    it('handles null result gracefully', function () {
      expect(() => tracer._analyzeCursors('empty', null)).to.not.throw();
    });

    it('handles cursor without _cursorDescription', function () {
      expect(() => tracer._analyzeCursors('noCursor', { someOtherProp: true })).to.not.throw();
    });
  });

  // ==========================================
  // _collect
  // ==========================================
  describe('_collect', function () {

    it('does nothing when stats are empty', function () {
      tracer._collect();
      expect(mockClient.addPublicationMetric.called).to.be.false;
    });

    it('sends metric with publication summary', function () {
      const cursor1 = { _cursorDescription: { options: { fields: { a: 1 }, limit: 50 } } };
      const cursor2 = { _cursorDescription: { options: {} } };

      tracer._analyzeCursors('goodPub', cursor1);
      tracer._analyzeCursors('goodPub', cursor1);
      tracer._analyzeCursors('badPub', cursor2);

      tracer._collect();

      expect(mockClient.addPublicationMetric.calledOnce).to.be.true;
      const metric = mockClient.addPublicationMetric.firstCall.args[0];

      expect(metric.host).to.equal('test-host');
      expect(metric.publications).to.have.lengthOf(2);

      const good = metric.publications.find(p => p.name === 'goodPub');
      expect(good.noProjection).to.be.false;
      expect(good.noProjectionRate).to.equal(0);
      expect(good.callCount).to.equal(2);
      expect(good.avgDocs).to.equal(50);

      const bad = metric.publications.find(p => p.name === 'badPub');
      expect(bad.noProjection).to.be.true;
      expect(bad.noProjectionRate).to.equal(100);
    });

    it('resets stats after collection', function () {
      tracer._analyzeCursors('pub', { _cursorDescription: { options: {} } });
      tracer._collect();
      expect(tracer._stats).to.deep.equal({});
    });

    it('handles missing client gracefully', function () {
      tracer.client = null;
      tracer._analyzeCursors('pub', { _cursorDescription: { options: {} } });
      expect(() => tracer._collect()).to.not.throw();
    });
  });

  // ==========================================
  // start / stop
  // ==========================================
  describe('start / stop', function () {

    it('start sets interval', function () {
      // Pre-set _wrapped to avoid Meteor.publish wrapping
      tracer._wrapped = true;
      tracer.start();
      expect(tracer.intervalId).to.not.be.null;
    });

    it('is idempotent', function () {
      tracer._wrapped = true;
      tracer.start();
      const firstId = tracer.intervalId;
      tracer.start();
      expect(tracer.intervalId).to.equal(firstId);
    });

    it('stop clears interval', function () {
      tracer._wrapped = true;
      tracer.start();
      tracer.stop();
      expect(tracer.intervalId).to.be.null;
    });
  });

  // ==========================================
  // handler-table wrapping
  // ==========================================
  describe('_wrapRegisteredPublications', function () {
    const { Meteor } = require('../../helpers/meteorMock.js');
    const { publicationContextStore } = require('../../../lib/collectors/LiveQueriesCollector.js');
    let saved;

    beforeEach(function () {
      saved = { named: Meteor.server.publish_handlers, universal: Meteor.server.universal_publish_handlers };
    });

    afterEach(function () {
      Meteor.server.publish_handlers = saved.named;
      Meteor.server.universal_publish_handlers = saved.universal;
    });

    it('wraps publications registered before start, idempotently, with ALS context', function () {
      let seen = null;
      const original = function () { seen = publicationContextStore.getStore(); return null; };
      Meteor.server.publish_handlers = { early: original };
      Meteor.server.universal_publish_handlers = [function () { seen = publicationContextStore.getStore(); }];

      tracer._wrapRegisteredPublications();
      const wrapped = Meteor.server.publish_handlers.early;
      expect(wrapped._skySignalOriginal).to.equal(original);
      tracer._wrapRegisteredPublications();
      expect(Meteor.server.publish_handlers.early).to.equal(wrapped);

      wrapped.call({ connection: { id: 'c1' } });
      expect(seen).to.include({ publicationName: 'early', connectionId: 'c1', isAutoPublish: false });

      Meteor.server.universal_publish_handlers[0].call({ connection: { id: 'c2' } });
      expect(seen).to.include({ publicationName: null, isAutoPublish: true });
    });

    it('wraps publications registered later through Meteor.publish (incl. object form) and Meteor.server.publish', function () {
      const server = Meteor.server;
      const savedPublish = Meteor.publish;
      server.publish_handlers = {};
      server.universal_publish_handlers = [];
      server.publish = function (name, handler) {
        if (name && typeof name === 'object') {
          Object.entries(name).forEach(([k, v]) => this.publish(k, v));
        } else if (name) {
          this.publish_handlers[name] = handler;
        } else {
          this.universal_publish_handlers.push(handler);
        }
      };
      Meteor.publish = server.publish.bind(server); // bound copy, like ddp-server
      try {
        tracer._wrapPublish();
        Meteor.publish('viaMeteor', function () {});
        Meteor.publish({ viaObject() {} });
        server.publish('viaServer', function () {});
        Meteor.publish(null, function () {});
        for (const name of ['viaMeteor', 'viaObject', 'viaServer']) {
          expect(server.publish_handlers[name]._skySignalOriginal, name).to.be.a('function');
        }
        expect(server.universal_publish_handlers[0]._skySignalOriginal).to.be.a('function');
      } finally {
        Meteor.publish = savedPublish;
        delete server.publish;
      }
    });

    it('reports to the new tracer after stop() → start() (wrappers outlive instances)', function () {
      const cursor = { _cursorDescription: { collectionName: 'posts', options: {} } };
      Meteor.server.publish_handlers = { pub: function () { return cursor; } };
      tracer._wrapped = false;
      tracer._wrapPublish();
      tracer.stop();

      const next = new PublicationTracer({ client: mockClient, host: 'test-host' });
      next._wrapped = false;
      next._wrapPublish();
      Meteor.server.publish_handlers.pub.call({ connection: { id: 'c1' } });
      next.stop();

      expect(next._stats.pub.callCount).to.equal(1);
      expect(tracer._stats.pub).to.be.undefined;
    });

    it('analyzes cursors returned by async publish handlers', async function () {
      const cursor = { _cursorDescription: { collectionName: 'posts', options: {} } };
      Meteor.server.publish_handlers = { asyncPub: async function () { return cursor; } };
      tracer._wrapped = true; // make this the active tracer without patching Meteor.publish
      tracer._wrapPublish();
      tracer._wrapRegisteredPublications();

      await Meteor.server.publish_handlers.asyncPub.call({ connection: { id: 'c1' } });
      await new Promise((r) => setImmediate(r));
      expect(tracer._stats.asyncPub.callCount).to.equal(1);
      expect(tracer._stats.asyncPub.noProjectionCount).to.equal(1);
    });
  });
});
