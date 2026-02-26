/**
 * WorkerPool tests — round-robin logic, pending request tracking,
 * lifecycle guards, graceful degradation.
 *
 * Does NOT spawn real workers — tests internal logic only.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import WorkerPool from '../../../lib/workers/WorkerPool.js';

describe('WorkerPool', function () {

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      expect(pool.poolSize).to.equal(1);
      expect(pool.debug).to.be.false;
      expect(pool._started).to.be.false;
      expect(pool._workers).to.be.an('array').that.is.empty;
      expect(pool._nextWorker).to.equal(0);
      expect(pool._requestId).to.equal(0);
      expect(pool._pending).to.be.instanceOf(Map);
    });

    it('respects custom poolSize', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js', poolSize: 4 });
      expect(pool.poolSize).to.equal(4);
    });

    it('detects worker_threads availability', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      // In Node.js test environment, worker_threads should be available
      expect(pool.isAvailable).to.be.a('boolean');
    });
  });

  // ==========================================
  // _getNextWorker (round-robin)
  // ==========================================
  describe('_getNextWorker', function () {

    it('returns null when no workers exist', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js', poolSize: 3 });
      expect(pool._getNextWorker()).to.be.null;
    });

    it('round-robins through available workers', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js', poolSize: 3 });
      const w1 = { id: 1 };
      const w2 = { id: 2 };
      const w3 = { id: 3 };
      pool._workers = [w1, w2, w3];

      expect(pool._getNextWorker()).to.equal(w1);
      expect(pool._getNextWorker()).to.equal(w2);
      expect(pool._getNextWorker()).to.equal(w3);
      expect(pool._getNextWorker()).to.equal(w1); // wraps around
    });

    it('skips null workers', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js', poolSize: 3 });
      const w2 = { id: 2 };
      pool._workers = [null, w2, null];

      expect(pool._getNextWorker()).to.equal(w2);
      expect(pool._getNextWorker()).to.equal(w2); // only one available
    });

    it('returns null when all workers are null', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js', poolSize: 3 });
      pool._workers = [null, null, null];
      expect(pool._getNextWorker()).to.be.null;
    });
  });

  // ==========================================
  // execute
  // ==========================================
  describe('execute', function () {

    it('rejects when pool not started', async function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      try {
        await pool.execute({ type: 'test' });
        expect.fail('should have rejected');
      } catch (e) {
        expect(e.message).to.include('not available');
      }
    });

    it('rejects when no workers available', async function () {
      const pool = new WorkerPool({ workerScript: '/fake.js', poolSize: 1 });
      pool._started = true;
      pool._available = true;
      pool._workers = [null]; // No actual workers

      try {
        await pool.execute({ type: 'test' });
        expect.fail('should have rejected');
      } catch (e) {
        expect(e.message).to.include('No workers available');
      }
    });

    it('increments request ID on each call', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      pool._started = true;
      pool._available = true;
      const mockWorker = { postMessage: sinon.stub() };
      pool._workers = [mockWorker];

      // Start two execute calls (they'll be pending)
      pool.execute({ type: 'a' }, 60000);
      pool.execute({ type: 'b' }, 60000);

      expect(pool._requestId).to.equal(2);
      expect(pool._pending.size).to.equal(2);

      // Clean up timeouts
      for (const [, pending] of pool._pending) {
        clearTimeout(pending.timeout);
      }
      pool._pending.clear();
    });

    it('posts message to worker with task and id', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      pool._started = true;
      pool._available = true;
      const mockWorker = { postMessage: sinon.stub() };
      pool._workers = [mockWorker];

      pool.execute({ type: 'compress', data: 'abc' }, 60000);

      expect(mockWorker.postMessage.calledOnce).to.be.true;
      const msg = mockWorker.postMessage.firstCall.args[0];
      expect(msg.type).to.equal('compress');
      expect(msg.data).to.equal('abc');
      expect(msg.id).to.equal(0);

      // Clean up
      for (const [, pending] of pool._pending) {
        clearTimeout(pending.timeout);
      }
      pool._pending.clear();
    });
  });

  // ==========================================
  // stop
  // ==========================================
  describe('stop', function () {

    it('rejects all pending requests', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      pool._started = true;

      const rejections = [];
      const timeout1 = setTimeout(() => {}, 60000);
      const timeout2 = setTimeout(() => {}, 60000);
      pool._pending.set(0, {
        resolve: () => {},
        reject: (e) => rejections.push(e),
        timeout: timeout1
      });
      pool._pending.set(1, {
        resolve: () => {},
        reject: (e) => rejections.push(e),
        timeout: timeout2
      });

      pool.stop();

      expect(rejections).to.have.lengthOf(2);
      expect(rejections[0].message).to.include('stopped');
      expect(pool._started).to.be.false;
      expect(pool._pending.size).to.equal(0);
      expect(pool._workers).to.have.lengthOf(0);
    });

    it('terminates workers', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      const mockWorker = { terminate: sinon.stub() };
      pool._workers = [mockWorker];
      pool._started = true;

      pool.stop();

      expect(mockWorker.terminate.calledOnce).to.be.true;
      expect(pool._workers).to.have.lengthOf(0);
    });

    it('handles null workers gracefully', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      pool._workers = [null, null];
      pool._started = true;

      expect(() => pool.stop()).to.not.throw();
    });
  });

  // ==========================================
  // getStats
  // ==========================================
  describe('getStats', function () {

    it('returns expected stats', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js', poolSize: 2 });
      const stats = pool.getStats();
      expect(stats).to.have.property('available').that.is.a('boolean');
      expect(stats).to.have.property('started', false);
      expect(stats).to.have.property('workers', 0);
      expect(stats).to.have.property('pendingRequests', 0);
    });

    it('counts non-null workers', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js', poolSize: 3 });
      pool._workers = [{ id: 1 }, null, { id: 3 }];
      expect(pool.getStats().workers).to.equal(2);
    });
  });

  // ==========================================
  // start (guards)
  // ==========================================
  describe('start', function () {

    it('does not start if worker_threads unavailable', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      pool._available = false;
      pool.start();
      expect(pool._started).to.be.false;
    });

    it('is idempotent (second start is no-op)', function () {
      const pool = new WorkerPool({ workerScript: '/fake.js' });
      pool._available = true;
      // Mock _spawnWorker to avoid actual worker creation
      sinon.stub(pool, '_spawnWorker');
      pool.start();
      expect(pool._started).to.be.true;
      const callCount = pool._spawnWorker.callCount;
      pool.start(); // second call
      expect(pool._spawnWorker.callCount).to.equal(callCount); // no new spawns
      pool.stop();
    });
  });
});
