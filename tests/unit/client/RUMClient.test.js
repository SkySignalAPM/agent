/**
 * RUMClient tests — batch logic, publicKey validation, flush, beacon URL.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { setupBrowserMocks, teardownBrowserMocks } from '../../helpers/browserMock.js';
import RUMClient from '../../../client/RUMClient.js';

describe('RUMClient', function () {

  before(function () {
    setupBrowserMocks();
    // Add document.addEventListener stub
    global.document.addEventListener = sinon.stub();
    // Add Blob constructor
    global.Blob = class Blob {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts && opts.type;
      }
    };
  });

  after(function () {
    delete global.Blob;
    teardownBrowserMocks();
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('enables when publicKey is provided', function () {
      const client = new RUMClient({ publicKey: 'pk_test_123' });
      expect(client.isEnabled()).to.be.true;
      expect(client.config.publicKey).to.equal('pk_test_123');
    });

    it('disables when publicKey is missing', function () {
      const client = new RUMClient({});
      expect(client.isEnabled()).to.be.false;
    });

    it('sets default config values', function () {
      const client = new RUMClient({ publicKey: 'pk_test' });
      expect(client.config.endpoint).to.equal('/api/v1/rum');
      expect(client.config.batchSize).to.equal(10);
      expect(client.config.flushInterval).to.equal(5000);
      expect(client.config.debug).to.be.false;
    });

    it('respects custom config', function () {
      const client = new RUMClient({
        publicKey: 'pk_test',
        endpoint: '/custom/rum',
        batchSize: 20,
        flushInterval: 3000,
        debug: true
      });
      expect(client.config.endpoint).to.equal('/custom/rum');
      expect(client.config.batchSize).to.equal(20);
      expect(client.config.flushInterval).to.equal(3000);
    });
  });

  // ==========================================
  // addMeasurement
  // ==========================================
  describe('addMeasurement', function () {

    it('adds measurement to batch when enabled', function () {
      const client = new RUMClient({ publicKey: 'pk_test' });
      client.addMeasurement({ type: 'pageLoad', duration: 1500 });
      expect(client.getBatchSize()).to.equal(1);
      clearTimeout(client.flushTimer);
      client.flushTimer = null;
    });

    it('does not add measurement when disabled', function () {
      const client = new RUMClient({});
      client.addMeasurement({ type: 'pageLoad', duration: 1500 });
      expect(client.getBatchSize()).to.equal(0);
    });

    it('auto-flushes when batch reaches batchSize', function () {
      const client = new RUMClient({ publicKey: 'pk_test', batchSize: 3 });
      const flushStub = sinon.stub(client, 'flush');

      client.addMeasurement({ type: 'a' });
      client.addMeasurement({ type: 'b' });
      expect(flushStub.called).to.be.false;

      client.addMeasurement({ type: 'c' }); // 3rd item triggers flush
      expect(flushStub.calledOnce).to.be.true;
      // Clean up timer scheduled by first addMeasurement
      clearTimeout(client.flushTimer);
      client.flushTimer = null;
    });

    it('schedules flush timer when batch is not full', function () {
      const client = new RUMClient({ publicKey: 'pk_test', batchSize: 10 });
      client.addMeasurement({ type: 'a' });
      expect(client.flushTimer).to.not.be.null;
      // Clean up timer to prevent post-test crash
      clearTimeout(client.flushTimer);
      client.flushTimer = null;
    });
  });

  // ==========================================
  // flush
  // ==========================================
  describe('flush', function () {

    it('clears batch on flush', function () {
      const client = new RUMClient({ publicKey: 'pk_test' });
      // Stub _send to prevent actual sending
      sinon.stub(client, '_send');

      client.batch = [{ type: 'a' }, { type: 'b' }];
      client.flush();
      expect(client.getBatchSize()).to.equal(0);
    });

    it('does nothing when batch is empty', function () {
      const client = new RUMClient({ publicKey: 'pk_test' });
      const sendStub = sinon.stub(client, '_send');
      client.flush();
      expect(sendStub.called).to.be.false;
    });

    it('clears flush timer', function () {
      const client = new RUMClient({ publicKey: 'pk_test' });
      sinon.stub(client, '_send');
      client.flushTimer = setTimeout(() => {}, 10000);
      client.flush();
      expect(client.flushTimer).to.be.null;
    });

    it('calls _send with measurements', function () {
      const client = new RUMClient({ publicKey: 'pk_test' });
      const sendStub = sinon.stub(client, '_send');
      client.batch = [{ type: 'a' }, { type: 'b' }];
      client.flush();
      expect(sendStub.calledOnce).to.be.true;
      expect(sendStub.firstCall.args[0]).to.have.lengthOf(2);
    });
  });

  // ==========================================
  // _getBeaconUrl
  // ==========================================
  describe('_getBeaconUrl', function () {

    it('constructs URL with pk query param from relative endpoint', function () {
      const client = new RUMClient({ publicKey: 'pk_test_abc' });
      const url = client._getBeaconUrl();
      expect(url).to.include('pk_test_abc');
      expect(url).to.include('/api/v1/rum');
    });

    it('caches the URL after first call', function () {
      const client = new RUMClient({ publicKey: 'pk_test' });
      const url1 = client._getBeaconUrl();
      const url2 = client._getBeaconUrl();
      expect(url1).to.equal(url2);
    });

    it('uses absolute endpoint as-is when starts with http', function () {
      const client = new RUMClient({
        publicKey: 'pk_test',
        endpoint: 'https://custom.example.com/rum'
      });
      const url = client._getBeaconUrl();
      expect(url).to.include('https://custom.example.com/rum');
    });
  });

  // ==========================================
  // updateConfig
  // ==========================================
  describe('updateConfig', function () {

    it('merges new config values', function () {
      const client = new RUMClient({ publicKey: 'pk_test' });
      client.updateConfig({ batchSize: 50, debug: true });
      expect(client.config.batchSize).to.equal(50);
      expect(client.config.debug).to.be.true;
      // Original values preserved
      expect(client.config.publicKey).to.equal('pk_test');
    });
  });

  // ==========================================
  // getBatchSize / isEnabled
  // ==========================================
  describe('getBatchSize / isEnabled', function () {

    it('getBatchSize reflects batch length', function () {
      const client = new RUMClient({ publicKey: 'pk_test' });
      expect(client.getBatchSize()).to.equal(0);
      client.batch.push({ type: 'test' });
      expect(client.getBatchSize()).to.equal(1);
    });

    it('isEnabled returns boolean', function () {
      expect(new RUMClient({ publicKey: 'pk_test' }).isEnabled()).to.be.true;
      expect(new RUMClient({}).isEnabled()).to.be.false;
    });
  });
});
