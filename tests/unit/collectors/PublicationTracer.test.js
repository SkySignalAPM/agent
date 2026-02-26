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
});
