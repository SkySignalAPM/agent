import { expect } from 'chai';
import sinon from 'sinon';
import { ENV_MAP, resolveEnvConfig } from '../../../lib/env.js';

describe('env', function () {

	// Track env vars we set so we can clean them up
	const setVars = [];

	function setEnv(key, value) {
		setVars.push(key);
		process.env[key] = value;
	}

	afterEach(function () {
		for (const key of setVars) {
			delete process.env[key];
		}
		setVars.length = 0;
		sinon.restore();
	});

	describe('ENV_MAP', function () {

		it('has unique env var names', function () {
			const envNames = ENV_MAP.map(e => e.env);
			expect(new Set(envNames).size).to.equal(envNames.length);
		});

		it('has unique config keys', function () {
			const keys = ENV_MAP.map(e => e.key);
			expect(new Set(keys).size).to.equal(keys.length);
		});

		it('only uses valid types', function () {
			const validTypes = ['string', 'bool', 'int', 'float', 'array'];
			for (const entry of ENV_MAP) {
				expect(validTypes).to.include(entry.type, `${entry.env} has invalid type "${entry.type}"`);
			}
		});
	});

	describe('resolveEnvConfig', function () {

		it('returns empty object when no env vars are set', function () {
			expect(resolveEnvConfig()).to.deep.equal({});
		});

		it('reads SKYSIGNAL_API_KEY as string', function () {
			setEnv('SKYSIGNAL_API_KEY', 'sk_test_env');
			expect(resolveEnvConfig().apiKey).to.equal('sk_test_env');
		});

		it('reads SKYSIGNAL_ENDPOINT as string', function () {
			setEnv('SKYSIGNAL_ENDPOINT', 'https://custom.example.com');
			expect(resolveEnvConfig().endpoint).to.equal('https://custom.example.com');
		});

		it('coerces SKYSIGNAL_ENABLED "true" to boolean true', function () {
			setEnv('SKYSIGNAL_ENABLED', 'true');
			expect(resolveEnvConfig().enabled).to.equal(true);
		});

		it('coerces SKYSIGNAL_ENABLED "false" to boolean false', function () {
			setEnv('SKYSIGNAL_ENABLED', 'false');
			expect(resolveEnvConfig().enabled).to.equal(false);
		});

		it('coerces SKYSIGNAL_DEBUG case-insensitively', function () {
			setEnv('SKYSIGNAL_DEBUG', 'TRUE');
			expect(resolveEnvConfig().debug).to.equal(true);
		});

		it('coerces "1" and "yes" as truthy booleans', function () {
			setEnv('SKYSIGNAL_ENABLED', '1');
			expect(resolveEnvConfig().enabled).to.equal(true);
			delete process.env.SKYSIGNAL_ENABLED;

			setEnv('SKYSIGNAL_ENABLED', 'yes');
			expect(resolveEnvConfig().enabled).to.equal(true);
		});

		it('coerces "0" and "no" as falsy booleans', function () {
			setEnv('SKYSIGNAL_ENABLED', '0');
			expect(resolveEnvConfig().enabled).to.equal(false);
			delete process.env.SKYSIGNAL_ENABLED;

			setEnv('SKYSIGNAL_ENABLED', 'no');
			expect(resolveEnvConfig().enabled).to.equal(false);
		});

		it('warns and skips unrecognized boolean values', function () {
			const warnStub = sinon.stub(console, 'warn');
			setEnv('SKYSIGNAL_ENABLED', 'maybe');
			const cfg = resolveEnvConfig();
			expect(cfg).to.not.have.property('enabled');
			expect(warnStub.calledOnce).to.be.true;
			expect(warnStub.firstCall.args[0]).to.include('SKYSIGNAL_ENABLED');
		});

		it('coerces SKYSIGNAL_BATCH_SIZE to integer', function () {
			setEnv('SKYSIGNAL_BATCH_SIZE', '200');
			expect(resolveEnvConfig().batchSize).to.equal(200);
		});

		it('coerces SKYSIGNAL_FLUSH_INTERVAL to integer', function () {
			setEnv('SKYSIGNAL_FLUSH_INTERVAL', '30000');
			expect(resolveEnvConfig().flushInterval).to.equal(30000);
		});

		it('coerces SKYSIGNAL_TRACE_SAMPLE_RATE to float', function () {
			setEnv('SKYSIGNAL_TRACE_SAMPLE_RATE', '0.25');
			expect(resolveEnvConfig().traceSampleRate).to.equal(0.25);
		});

		it('coerces SKYSIGNAL_LOG_LEVELS to array', function () {
			setEnv('SKYSIGNAL_LOG_LEVELS', 'info, warn, error');
			expect(resolveEnvConfig().logLevels).to.deep.equal(['info', 'warn', 'error']);
		});

		it('ignores empty string env vars', function () {
			setEnv('SKYSIGNAL_API_KEY', '');
			const cfg = resolveEnvConfig();
			expect(cfg).to.not.have.property('apiKey');
		});

		it('does not include keys for unset env vars', function () {
			setEnv('SKYSIGNAL_API_KEY', 'sk_test_env');
			const cfg = resolveEnvConfig();
			expect(cfg).to.have.property('apiKey');
			expect(cfg).to.not.have.property('debug');
			expect(cfg).to.not.have.property('flushInterval');
		});

		it('warns and skips invalid integer values', function () {
			const warnStub = sinon.stub(console, 'warn');
			setEnv('SKYSIGNAL_FLUSH_INTERVAL', 'notanumber');
			const cfg = resolveEnvConfig();
			expect(cfg).to.not.have.property('flushInterval');
			expect(warnStub.calledOnce).to.be.true;
			expect(warnStub.firstCall.args[0]).to.include('SKYSIGNAL_FLUSH_INTERVAL');
		});

		it('warns and skips invalid float values', function () {
			const warnStub = sinon.stub(console, 'warn');
			setEnv('SKYSIGNAL_TRACE_SAMPLE_RATE', 'abc');
			const cfg = resolveEnvConfig();
			expect(cfg).to.not.have.property('traceSampleRate');
			expect(warnStub.calledOnce).to.be.true;
		});

		it('handles multiple env vars at once', function () {
			setEnv('SKYSIGNAL_API_KEY', 'sk_env_123');
			setEnv('SKYSIGNAL_DEBUG', 'true');
			setEnv('SKYSIGNAL_FLUSH_INTERVAL', '5000');
			setEnv('SKYSIGNAL_TRACE_SAMPLE_RATE', '0.5');
			const cfg = resolveEnvConfig();
			expect(cfg).to.deep.equal({
				apiKey: 'sk_env_123',
				debug: true,
				flushInterval: 5000,
				traceSampleRate: 0.5
			});
		});

		it('handles feature flag env vars', function () {
			setEnv('SKYSIGNAL_COLLECT_TRACES', 'false');
			setEnv('SKYSIGNAL_COLLECT_LOGS', 'true');
			const cfg = resolveEnvConfig();
			expect(cfg.collectTraces).to.equal(false);
			expect(cfg.collectLogs).to.equal(true);
		});
	});
});
