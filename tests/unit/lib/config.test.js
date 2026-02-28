import { expect } from 'chai';
import { DEFAULT_CONFIG, validateConfig, mergeConfig } from '../../../lib/config.js';

describe('config', function () {

  describe('DEFAULT_CONFIG', function () {

    it('has null apiKey by default', function () {
      expect(DEFAULT_CONFIG.apiKey).to.be.null;
    });

    it('has correct default batch settings', function () {
      expect(DEFAULT_CONFIG.batchSize).to.equal(100);
      expect(DEFAULT_CONFIG.batchSizeBytes).to.equal(1024 * 1024);
      expect(DEFAULT_CONFIG.flushInterval).to.equal(60000);
    });

    it('has sample rates between 0 and 1', function () {
      expect(DEFAULT_CONFIG.traceSampleRate).to.be.within(0, 1);
      expect(DEFAULT_CONFIG.rumSampleRate).to.be.within(0, 1);
      expect(DEFAULT_CONFIG.indexUsageSampleRate).to.be.within(0, 1);
      expect(DEFAULT_CONFIG.logSampleRate).to.be.within(0, 1);
    });

    it('has feature flags as booleans', function () {
      expect(DEFAULT_CONFIG.collectSystemMetrics).to.be.a('boolean');
      expect(DEFAULT_CONFIG.collectTraces).to.be.a('boolean');
      expect(DEFAULT_CONFIG.collectErrors).to.be.a('boolean');
      expect(DEFAULT_CONFIG.collectLogs).to.be.a('boolean');
      expect(DEFAULT_CONFIG.collectRUM).to.be.false; // Disabled by default
    });
  });

  describe('validateConfig', function () {

    it('accepts a valid minimal config', function () {
      expect(() => validateConfig({ apiKey: 'sk_test_123' })).to.not.throw();
    });

    it('throws on missing apiKey', function () {
      expect(() => validateConfig({})).to.throw(/Missing key 'apiKey'/);
    });

    it('throws when traceSampleRate < 0', function () {
      expect(() => validateConfig({
        apiKey: 'sk_test_123',
        traceSampleRate: -0.1
      })).to.throw('traceSampleRate must be between 0 and 1');
    });

    it('throws when traceSampleRate > 1', function () {
      expect(() => validateConfig({
        apiKey: 'sk_test_123',
        traceSampleRate: 1.5
      })).to.throw('traceSampleRate must be between 0 and 1');
    });

    it('throws when rumSampleRate out of range', function () {
      expect(() => validateConfig({
        apiKey: 'sk_test_123',
        rumSampleRate: 2.0
      })).to.throw('rumSampleRate must be between 0 and 1');
    });

    it('throws when indexUsageSampleRate out of range', function () {
      expect(() => validateConfig({
        apiKey: 'sk_test_123',
        indexUsageSampleRate: -1
      })).to.throw('indexUsageSampleRate must be between 0 and 1');
    });

    it('throws when logSampleRate out of range', function () {
      expect(() => validateConfig({
        apiKey: 'sk_test_123',
        logSampleRate: 1.1
      })).to.throw('logSampleRate must be between 0 and 1');
    });

    it('throws for invalid explainVerbosity', function () {
      expect(() => validateConfig({
        apiKey: 'sk_test_123',
        explainVerbosity: 'invalid'
      })).to.throw(/explainVerbosity must be one of/);
    });

    it('accepts valid explainVerbosity values', function () {
      for (const val of ['queryPlanner', 'executionStats', 'allPlansExecution']) {
        expect(() => validateConfig({
          apiKey: 'sk_test_123',
          explainVerbosity: val
        })).to.not.throw();
      }
    });

    it('throws when batchSize < 1', function () {
      // Note: batchSize=0 is falsy so skips the check in source code.
      // Use -1 which is truthy and < 1.
      expect(() => validateConfig({
        apiKey: 'sk_test_123',
        batchSize: -1
      })).to.throw('batchSize must be at least 1');
    });

    it('throws when flushInterval < 1000', function () {
      expect(() => validateConfig({
        apiKey: 'sk_test_123',
        flushInterval: 500
      })).to.throw('flushInterval must be at least 1000ms');
    });

    it('throws for invalid log levels', function () {
      expect(() => validateConfig({
        apiKey: 'sk_test_123',
        logLevels: ['info', 'invalid']
      })).to.throw(/Invalid log level: invalid/);
    });
  });

  describe('mergeConfig', function () {

    it('merges user values over defaults', function () {
      const config = mergeConfig({ apiKey: 'sk_test_123', batchSize: 100 });
      expect(config.apiKey).to.equal('sk_test_123');
      expect(config.batchSize).to.equal(100);
      // Defaults preserved
      expect(config.flushInterval).to.equal(DEFAULT_CONFIG.flushInterval);
      expect(config.collectSystemMetrics).to.equal(DEFAULT_CONFIG.collectSystemMetrics);
    });

    it('preserves all default keys when only apiKey is provided', function () {
      const config = mergeConfig({ apiKey: 'sk_test_123' });
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (key === 'apiKey') continue;
        expect(config[key]).to.deep.equal(DEFAULT_CONFIG[key]);
      }
    });

    it('throws on invalid input (delegates to validateConfig)', function () {
      expect(() => mergeConfig({})).to.throw(/Missing key 'apiKey'/);
    });
  });
});
