/**
 * MongoCollectionStatsCollector tests — constructor defaults, start guards,
 * stop lifecycle. Does NOT connect to real MongoDB.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import MongoCollectionStatsCollector from '../../../lib/collectors/MongoCollectionStatsCollector.js';

describe('MongoCollectionStatsCollector', function () {

  let collector;
  let mockSkySignalClient;
  let mockMongoClient;

  beforeEach(function () {
    mockSkySignalClient = { addCollectionStats: sinon.stub() };
    mockMongoClient = {
      db: sinon.stub().returns({
        listCollections: sinon.stub().returns({
          toArray: sinon.stub().resolves([])
        }),
        command: sinon.stub().resolves({}),
        collection: sinon.stub().returns({
          listIndexes: sinon.stub().returns({ toArray: sinon.stub().resolves([]) })
        })
      })
    };
    collector = new MongoCollectionStatsCollector({
      client: mockMongoClient,
      skySignalClient: mockSkySignalClient,
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
      expect(collector.collectionInterval).to.equal(300000);
      expect(collector.enabled).to.be.true;
      expect(collector.started).to.be.false;
      expect(collector.db).to.be.null;
    });

    it('respects disabled flag', function () {
      const c = new MongoCollectionStatsCollector({ enabled: false });
      expect(c.enabled).to.be.false;
    });
  });

  // ==========================================
  // start guards
  // ==========================================
  describe('start', function () {

    it('does not start when disabled', function () {
      collector.enabled = false;
      collector.start();
      expect(collector.started).to.be.false;
    });

    it('does not start without skySignalClient', function () {
      collector.skySignalClient = null;
      collector.start();
      expect(collector.started).to.be.false;
    });

    it('does not start without mongoClient', function () {
      collector.mongoClient = null;
      collector.start();
      expect(collector.started).to.be.false;
    });

    it('does not double-start', function () {
      collector.start();
      const firstTimer = collector.collectionTimer;
      collector.start();
      expect(collector.collectionTimer).to.equal(firstTimer);
    });

    it('sets started=true and creates interval on success', function () {
      collector.start();
      expect(collector.started).to.be.true;
      expect(collector.collectionTimer).to.not.be.null;
    });
  });

  // ==========================================
  // stop
  // ==========================================
  describe('stop', function () {

    it('clears interval and resets state', function () {
      collector.start();
      collector.stop();
      expect(collector.collectionTimer).to.be.null;
      expect(collector.started).to.be.false;
    });

    it('safe to call when not started', function () {
      expect(() => collector.stop()).to.not.throw();
    });
  });

  // ==========================================
  // _collectStats
  // ==========================================
  describe('_collectStats', function () {

    it('warns when db is null', async function () {
      collector.db = null;
      await collector._collectStats();
      expect(mockSkySignalClient.addCollectionStats.called).to.be.false;
    });

    it('sends stats for found collections', async function () {
      const db = mockMongoClient.db();
      db.listCollections.returns({
        toArray: sinon.stub().resolves([{ name: 'users' }, { name: 'posts' }])
      });
      db.command.resolves({
        count: 100, size: 50000, storageSize: 60000,
        nindexes: 3, totalIndexSize: 10000, avgObjSize: 500
      });
      db.collection.returns({
        listIndexes: sinon.stub().returns({
          toArray: sinon.stub().resolves([
            { name: '_id_', key: { _id: 1 } },
            { name: 'customerId_1', key: { customerId: 1 } }
          ])
        })
      });

      collector.db = db;
      await collector._collectStats();

      expect(mockSkySignalClient.addCollectionStats.calledOnce).to.be.true;
      const args = mockSkySignalClient.addCollectionStats.firstCall.args[0];
      expect(args.collections).to.have.lengthOf(2);
      expect(args.host).to.equal('test-host');
    });

    it('handles collection stats errors gracefully', async function () {
      const db = mockMongoClient.db();
      db.listCollections.returns({
        toArray: sinon.stub().resolves([{ name: 'views_collection' }])
      });
      db.command.rejects({ codeName: 'CommandNotSupportedOnView' });
      db.collection.returns({
        listIndexes: sinon.stub().returns({
          toArray: sinon.stub().resolves([])
        })
      });

      collector.db = db;
      await collector._collectStats();
      // Should not crash, but no stats to send
    });
  });

  // ==========================================
  // _getCollectionStats
  // ==========================================
  describe('_getCollectionStats', function () {

    it('returns null for view collections', async function () {
      const db = mockMongoClient.db();
      db.command.rejects({ codeName: 'CommandNotSupportedOnView' });
      db.collection.returns({
        listIndexes: sinon.stub().returns({ toArray: sinon.stub().resolves([]) })
      });

      collector.db = db;
      const result = await collector._getCollectionStats('my_view', new Date());
      expect(result).to.be.null;
    });

    it('returns stats object for regular collections', async function () {
      const db = mockMongoClient.db();
      db.command.resolves({
        count: 42, size: 1234, storageSize: 2000,
        nindexes: 2, totalIndexSize: 500, avgObjSize: 29
      });
      db.collection.returns({
        listIndexes: sinon.stub().returns({
          toArray: sinon.stub().resolves([{ name: '_id_', key: { _id: 1 } }])
        })
      });

      collector.db = db;
      const result = await collector._getCollectionStats('users', new Date());

      expect(result.name).to.equal('users');
      expect(result.documentCount).to.equal(42);
      expect(result.size).to.equal(1234);
      expect(result.indexCount).to.equal(2);
      expect(result.indexes).to.have.lengthOf(1);
    });
  });
});
