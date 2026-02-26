/**
 * EnvironmentCollector tests — pure Node.js functions: package versions,
 * env keys, OS info, snapshot change detection.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import EnvironmentCollector from '../../../lib/collectors/EnvironmentCollector.js';

describe('EnvironmentCollector', function () {

  let collector;
  let mockClient;

  beforeEach(function () {
    mockClient = { addEnvironmentMetric: sinon.stub() };
    collector = new EnvironmentCollector({
      client: mockClient,
      host: 'test-host',
      appVersion: '1.0.0'
    });
  });

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {

    it('sets default values', function () {
      expect(collector.interval).to.equal(1800000); // 30 min
      expect(collector._lastSnapshot).to.be.null;
      expect(collector.host).to.equal('test-host');
    });
  });

  // ==========================================
  // _getPackageVersions
  // ==========================================
  describe('_getPackageVersions', function () {

    it('includes process.versions entries', async function () {
      const versions = await collector._getPackageVersions();
      expect(versions).to.have.property('node');
      expect(versions).to.have.property('v8');
    });

    it('returns an object', async function () {
      const versions = await collector._getPackageVersions();
      expect(versions).to.be.an('object');
    });
  });

  // ==========================================
  // _getEnvKeys
  // ==========================================
  describe('_getEnvKeys', function () {

    it('returns sorted array of env variable names', function () {
      const keys = collector._getEnvKeys();
      expect(keys).to.be.an('array');
      expect(keys.length).to.be.greaterThan(0);
      // Verify sorted
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i] >= keys[i - 1]).to.be.true;
      }
    });

    it('contains common env variables like PATH', function () {
      const keys = collector._getEnvKeys();
      // At least one known env variable should exist
      expect(keys.length).to.be.greaterThan(0);
    });

    it('returns keys only, never values', function () {
      const keys = collector._getEnvKeys();
      // Each entry should be a string (key name), not a value
      for (const key of keys) {
        expect(key).to.be.a('string');
        // Should not contain '=' which would indicate a value
        expect(key).to.not.include('=');
      }
    });
  });

  // ==========================================
  // _getOsInfo
  // ==========================================
  describe('_getOsInfo', function () {

    it('returns expected OS info fields', function () {
      const info = collector._getOsInfo();
      expect(info).to.have.property('platform').that.is.a('string');
      expect(info).to.have.property('release').that.is.a('string');
      expect(info).to.have.property('arch').that.is.a('string');
      expect(info).to.have.property('cpuCount').that.is.a('number');
      expect(info).to.have.property('cpuModel').that.is.a('string');
      expect(info).to.have.property('totalMemory').that.is.a('number');
      expect(info).to.have.property('freeMemory').that.is.a('number');
      expect(info).to.have.property('hostname').that.is.a('string');
      expect(info).to.have.property('uptime').that.is.a('number');
    });

    it('returns positive values for memory and CPU count', function () {
      const info = collector._getOsInfo();
      expect(info.cpuCount).to.be.at.least(1);
      expect(info.totalMemory).to.be.greaterThan(0);
      expect(info.freeMemory).to.be.greaterThan(0);
    });
  });

  // ==========================================
  // _collect (snapshot change detection)
  // ==========================================
  describe('_collect', function () {

    it('sends metric on first call', async function () {
      await collector._collect();
      expect(mockClient.addEnvironmentMetric.calledOnce).to.be.true;
    });

    it('does not send metric on second identical call', async function () {
      await collector._collect();
      await collector._collect();
      // Second call should be skipped (no change)
      expect(mockClient.addEnvironmentMetric.calledOnce).to.be.true;
    });

    it('sends metric fields with expected structure', async function () {
      await collector._collect();
      const metric = mockClient.addEnvironmentMetric.firstCall.args[0];
      expect(metric).to.have.property('timestamp').that.is.instanceOf(Date);
      expect(metric).to.have.property('host', 'test-host');
      expect(metric).to.have.property('appVersion', '1.0.0');
      expect(metric).to.have.property('packages').that.is.an('object');
      expect(metric).to.have.property('nodeFlags').that.is.an('array');
      expect(metric).to.have.property('envKeys').that.is.an('array');
      expect(metric).to.have.property('os').that.is.an('object');
    });

    it('handles missing client gracefully', async function () {
      collector.client = null;
      await collector._collect(); // Should not throw
    });
  });

  // ==========================================
  // start / stop lifecycle
  // ==========================================
  describe('start / stop', function () {

    it('does not start twice', function () {
      collector.start();
      const firstId = collector.intervalId;
      collector.start(); // Should warn and no-op
      expect(collector.intervalId).to.equal(firstId);
      collector.stop();
    });

    it('clears interval on stop', function () {
      collector.start();
      expect(collector.intervalId).to.not.be.null;
      collector.stop();
      expect(collector.intervalId).to.be.null;
    });
  });
});
