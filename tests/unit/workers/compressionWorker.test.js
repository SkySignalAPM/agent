/**
 * compressionWorker tests — verifies the worker_threads message protocol
 * for gzip compression and ping/pong.
 *
 * Mocks `parentPort` from `worker_threads` by patching Module._resolveFilename
 * before requiring the worker script.
 */

const { expect } = require('chai');
const sinon = require('sinon');
const zlib = require('zlib');
const { promisify } = require('util');
const Module = require('module');

const gunzipAsync = promisify(zlib.gunzip);

describe('compressionWorker', function () {

  let messageHandler;
  let postMessage;

  before(function () {
    postMessage = sinon.stub();
    const fakeParentPort = {
      on(event, handler) {
        if (event === 'message') {
          messageHandler = handler;
        }
      },
      postMessage
    };

    // Intercept require("worker_threads") to return our mock
    const origResolve = Module._resolveFilename;
    const mockId = '__worker_threads_mock__';

    Module._resolveFilename = function (request, parent, ...rest) {
      if (request === 'worker_threads') {
        return mockId;
      }
      return origResolve.call(this, request, parent, ...rest);
    };

    // Pre-populate cache with our mock
    const m = new Module(mockId);
    m.exports = { parentPort: fakeParentPort };
    m.loaded = true;
    require.cache[mockId] = m;

    // Resolve and clear worker from cache so it gets re-loaded with our mock
    const workerPath = require.resolve('../../../lib/workers/compressionWorker.js');
    delete require.cache[workerPath];

    // Load the worker — it will require("worker_threads") which hits our mock
    require(workerPath);

    // Restore
    Module._resolveFilename = origResolve;
  });

  beforeEach(function () {
    postMessage.resetHistory();
  });

  // ==========================================
  // compress message type
  // ==========================================
  describe('compress', function () {

    it('compresses data and returns result with sizes', async function () {
      const data = 'Hello, World! '.repeat(100);

      await messageHandler({ id: 1, type: 'compress', data });

      expect(postMessage.calledOnce).to.be.true;
      const msg = postMessage.firstCall.args[0];
      expect(msg.id).to.equal(1);
      expect(msg.type).to.equal('result');
      expect(msg.originalSize).to.equal(Buffer.from(data, 'utf8').length);
      expect(msg.compressedSize).to.be.a('number');
      expect(msg.compressedSize).to.be.lessThan(msg.originalSize);
      expect(msg.compressed).to.be.instanceOf(Buffer);
    });

    it('produces valid gzip output', async function () {
      const data = 'test compression data';

      await messageHandler({ id: 2, type: 'compress', data });

      const msg = postMessage.firstCall.args[0];
      const decompressed = await gunzipAsync(msg.compressed);
      expect(decompressed.toString('utf8')).to.equal(data);
    });

    it('handles empty string', async function () {
      await messageHandler({ id: 3, type: 'compress', data: '' });

      expect(postMessage.calledOnce).to.be.true;
      const msg = postMessage.firstCall.args[0];
      expect(msg.type).to.equal('result');
      expect(msg.originalSize).to.equal(0);
    });

    it('preserves message id for correlation', async function () {
      await messageHandler({ id: 42, type: 'compress', data: 'test' });
      expect(postMessage.firstCall.args[0].id).to.equal(42);
    });

    it('handles large payloads', async function () {
      const data = 'x'.repeat(100000);

      await messageHandler({ id: 4, type: 'compress', data });

      const msg = postMessage.firstCall.args[0];
      expect(msg.type).to.equal('result');
      // Repetitive data should compress very well
      expect(msg.compressedSize).to.be.lessThan(msg.originalSize / 10);
    });

    it('handles unicode data', async function () {
      const data = '日本語テスト emoji: 🚀🎉 special: àáâãäå';

      await messageHandler({ id: 5, type: 'compress', data });

      const msg = postMessage.firstCall.args[0];
      expect(msg.type).to.equal('result');
      const decompressed = await gunzipAsync(msg.compressed);
      expect(decompressed.toString('utf8')).to.equal(data);
    });
  });

  // ==========================================
  // ping message type
  // ==========================================
  describe('ping', function () {

    it('responds with pong', async function () {
      await messageHandler({ id: 10, type: 'ping' });

      expect(postMessage.calledOnce).to.be.true;
      const msg = postMessage.firstCall.args[0];
      expect(msg.id).to.equal(10);
      expect(msg.type).to.equal('pong');
    });
  });

  // ==========================================
  // unknown message type
  // ==========================================
  describe('unknown message type', function () {

    it('does not respond to unknown types', async function () {
      await messageHandler({ id: 99, type: 'unknown' });
      expect(postMessage.called).to.be.false;
    });
  });
});
