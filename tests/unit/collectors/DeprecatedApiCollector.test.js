/**
 * DeprecatedApiCollector tests — counter incrementing, _collect aggregation,
 * sync percentage calculation, start/stop lifecycle.
 *
 * Does NOT test actual prototype wrapping (requires Meteor env) —
 * tests internal counter/aggregation logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import DeprecatedApiCollector from '../../../lib/collectors/DeprecatedApiCollector.js';

describe('DeprecatedApiCollector', function () {

  let collector;
  let mockClient;

  beforeEach(function () {
    mockClient = { addDeprecatedApiMetric: sinon.stub() };
    collector = new DeprecatedApiCollector({
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
      expect(collector.interval).to.equal(300000);
      expect(collector._wrapped).to.be.false;
      expect(collector._counters).to.deep.equal({});
    });
  });

  // ==========================================
  // _increment
  // ==========================================
  describe('_increment', function () {

    it('creates counter entry on first call', function () {
      collector._increment('Users', 'findOne', 'sync');
      expect(collector._counters['Users.findOne']).to.deep.equal({ sync: 1, async: 0 });
    });

    it('increments existing counter', function () {
      collector._increment('Users', 'findOne', 'sync');
      collector._increment('Users', 'findOne', 'sync');
      collector._increment('Users', 'findOne', 'async');
      expect(collector._counters['Users.findOne']).to.deep.equal({ sync: 2, async: 1 });
    });

    it('tracks different collections independently', function () {
      collector._increment('Users', 'insert', 'sync');
      collector._increment('Posts', 'insert', 'async');
      expect(collector._counters['Users.insert']).to.deep.equal({ sync: 1, async: 0 });
      expect(collector._counters['Posts.insert']).to.deep.equal({ sync: 0, async: 1 });
    });
  });

  // ==========================================
  // _collect
  // ==========================================
  describe('_collect', function () {

    it('does nothing when counters are empty', function () {
      collector._collect();
      expect(mockClient.addDeprecatedApiMetric.called).to.be.false;
    });

    it('sends metric with sync/async breakdown', function () {
      collector._increment('Users', 'findOne', 'sync');
      collector._increment('Users', 'findOne', 'sync');
      collector._increment('Users', 'insert', 'async');
      collector._increment('Posts', 'update', 'sync');

      collector._collect();

      expect(mockClient.addDeprecatedApiMetric.calledOnce).to.be.true;
      const metric = mockClient.addDeprecatedApiMetric.firstCall.args[0];

      expect(metric.totalSync).to.equal(3);
      expect(metric.totalAsync).to.equal(1);
      expect(metric.syncPercentage).to.equal(75); // 3/(3+1) = 75%
      expect(metric.host).to.equal('test-host');
      expect(metric.timestamp).to.be.instanceOf(Date);
    });

    it('separates syncCalls and asyncCalls arrays', function () {
      collector._increment('Users', 'findOne', 'sync');
      collector._increment('Users', 'insert', 'async');

      collector._collect();

      const metric = mockClient.addDeprecatedApiMetric.firstCall.args[0];
      expect(metric.syncCalls).to.have.lengthOf(1);
      expect(metric.syncCalls[0]).to.deep.equal({ method: 'findOne', collection: 'Users', count: 1 });
      expect(metric.asyncCalls).to.have.lengthOf(1);
      expect(metric.asyncCalls[0]).to.deep.equal({ method: 'insert', collection: 'Users', count: 1 });
    });

    it('resets counters after collection', function () {
      collector._increment('Users', 'findOne', 'sync');
      collector._collect();
      expect(collector._counters).to.deep.equal({});
    });

    it('calculates 0% when only async', function () {
      collector._increment('Users', 'findOne', 'async');
      collector._collect();

      const metric = mockClient.addDeprecatedApiMetric.firstCall.args[0];
      expect(metric.syncPercentage).to.equal(0);
    });

    it('calculates 100% when only sync', function () {
      collector._increment('Users', 'findOne', 'sync');
      collector._collect();

      const metric = mockClient.addDeprecatedApiMetric.firstCall.args[0];
      expect(metric.syncPercentage).to.equal(100);
    });

    it('handles missing client gracefully', function () {
      collector.client = null;
      collector._increment('Users', 'findOne', 'sync');
      expect(() => collector._collect()).to.not.throw();
    });
  });

  // ==========================================
  // start / stop
  // ==========================================
  describe('start / stop', function () {

    it('start sets interval', function () {
      // _wrapApis will try to require meteor — mock it by pre-setting _wrapped
      collector._wrapped = true;
      collector.start();
      expect(collector.intervalId).to.not.be.null;
    });

    it('is idempotent', function () {
      collector._wrapped = true;
      collector.start();
      const firstId = collector.intervalId;
      collector.start();
      expect(collector.intervalId).to.equal(firstId);
    });

    it('stop clears interval', function () {
      collector._wrapped = true;
      collector.start();
      collector.stop();
      expect(collector.intervalId).to.be.null;
    });
  });
});
