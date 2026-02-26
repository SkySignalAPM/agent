/**
 * trackAsync utility tests.
 *
 * Tests makeTrackable, makeTrackableClass, trackAsync, trackAsyncBatch
 * — pure utility functions with minimal dependency on global.SkySignalTracer.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import {
  makeTrackable,
  makeTrackableClass,
  trackAsync,
  trackAsyncBatch
} from '../../../lib/utils/trackAsync.js';

describe('trackAsync utilities', function () {

  afterEach(function () {
    delete global.SkySignalTracer;
  });

  // ==========================================
  // makeTrackable
  // ==========================================
  describe('makeTrackable', function () {

    it('throws if second argument is not a function', function () {
      expect(() => makeTrackable('label', 'not-a-function')).to.throw('must be a function');
      expect(() => makeTrackable('label', null)).to.throw('must be a function');
    });

    it('returns a function', function () {
      const wrapped = makeTrackable('test', async () => 42);
      expect(wrapped).to.be.a('function');
    });

    it('passes through the return value of the wrapped function', async function () {
      const wrapped = makeTrackable('test', async (x) => x * 2);
      const result = await wrapped(21);
      expect(result).to.equal(42);
    });

    it('passes arguments to the wrapped function', async function () {
      const wrapped = makeTrackable('test', async (a, b, c) => a + b + c);
      expect(await wrapped(1, 2, 3)).to.equal(6);
    });

    it('preserves `this` binding', async function () {
      const obj = {
        value: 10,
        method: makeTrackable('test', async function () {
          return this.value;
        })
      };
      expect(await obj.method()).to.equal(10);
    });

    it('re-throws errors from the wrapped function', async function () {
      const wrapped = makeTrackable('boom', async () => {
        throw new Error('test error');
      });
      try {
        await wrapped();
        expect.fail('should have thrown');
      } catch (e) {
        expect(e.message).to.equal('test error');
      }
    });

    it('calls addOperation on success when tracer is available', async function () {
      const addOp = sinon.stub();
      global.SkySignalTracer = {
        getCurrentContext: () => ({}),
        addOperation: addOp
      };

      const wrapped = makeTrackable('myOp', async () => 'result');
      await wrapped();

      expect(addOp.calledOnce).to.be.true;
      expect(addOp.firstCall.args[0].type).to.equal('async');
      expect(addOp.firstCall.args[0].label).to.equal('myOp');
      expect(addOp.firstCall.args[0].duration).to.be.a('number');
      expect(addOp.firstCall.args[0]).to.not.have.property('error');
    });

    it('calls addOperation with error on failure when tracer is available', async function () {
      const addOp = sinon.stub();
      global.SkySignalTracer = {
        getCurrentContext: () => ({}),
        addOperation: addOp
      };

      const wrapped = makeTrackable('failOp', async () => {
        throw new Error('fail');
      });

      try { await wrapped(); } catch (_) {}

      expect(addOp.calledOnce).to.be.true;
      expect(addOp.firstCall.args[0].error).to.equal('fail');
    });

    it('does not call addOperation when tracer has no context', async function () {
      const addOp = sinon.stub();
      global.SkySignalTracer = {
        getCurrentContext: () => null,
        addOperation: addOp
      };

      const wrapped = makeTrackable('noCtx', async () => 'ok');
      await wrapped();

      expect(addOp.called).to.be.false;
    });

    it('does not call addOperation when tracer is absent', async function () {
      // global.SkySignalTracer is deleted in afterEach
      const wrapped = makeTrackable('noTracer', async () => 'ok');
      const result = await wrapped();
      expect(result).to.equal('ok');
    });
  });

  // ==========================================
  // makeTrackableClass
  // ==========================================
  describe('makeTrackableClass', function () {

    it('wraps async prototype methods', async function () {
      class Service {
        async doWork() { return 'done'; }
        syncMethod() { return 'sync'; }
      }

      const instance = new Service();
      const wrapped = makeTrackableClass('Service', instance);

      expect(await wrapped.doWork()).to.equal('done');
      expect(wrapped.syncMethod()).to.equal('sync');
    });

    it('does not wrap the constructor', function () {
      class Service {
        constructor() { this.x = 1; }
        async run() { return this.x; }
      }

      const instance = new Service();
      const wrapped = makeTrackableClass('Svc', instance);
      // constructor should not be an own property of the wrapped object
      expect(wrapped).to.not.have.own.property('constructor');
    });

    it('wraps own async arrow function properties', async function () {
      const obj = {
        asyncArrow: async () => 'arrow'
      };
      // Force prototype to be Object.prototype
      const wrapped = makeTrackableClass('Obj', obj);
      expect(await wrapped.asyncArrow()).to.equal('arrow');
    });

    it('tracks wrapped async methods via tracer', async function () {
      const addOp = sinon.stub();
      global.SkySignalTracer = {
        getCurrentContext: () => ({}),
        addOperation: addOp
      };

      class Calc {
        async add(a, b) { return a + b; }
      }

      const wrapped = makeTrackableClass('Calc', new Calc());
      const result = await wrapped.add(3, 4);

      expect(result).to.equal(7);
      expect(addOp.calledOnce).to.be.true;
      expect(addOp.firstCall.args[0].label).to.equal('Calc.add');
    });
  });

  // ==========================================
  // trackAsync
  // ==========================================
  describe('trackAsync', function () {

    it('executes a Promise when tracer is absent', async function () {
      const result = await trackAsync('test', Promise.resolve(42));
      expect(result).to.equal(42);
    });

    it('executes a function when tracer is absent', async function () {
      const result = await trackAsync('test', async () => 'hello');
      expect(result).to.equal('hello');
    });

    it('delegates to tracer.trackAsyncFunction when tracer is available', async function () {
      global.SkySignalTracer = {
        trackAsyncFunction: sinon.stub().resolves('tracked')
      };

      const result = await trackAsync('op', async () => 'ignored');
      expect(result).to.equal('tracked');
      expect(global.SkySignalTracer.trackAsyncFunction.calledOnce).to.be.true;
      expect(global.SkySignalTracer.trackAsyncFunction.firstCall.args[0]).to.equal('op');
    });
  });

  // ==========================================
  // trackAsyncBatch
  // ==========================================
  describe('trackAsyncBatch', function () {

    it('runs multiple operations in parallel and returns keyed results', async function () {
      // No tracer — just passes through
      const results = await trackAsyncBatch({
        a: Promise.resolve(1),
        b: Promise.resolve(2),
        c: Promise.resolve(3)
      });

      expect(results).to.deep.equal({ a: 1, b: 2, c: 3 });
    });

    it('handles empty operations', async function () {
      const results = await trackAsyncBatch({});
      expect(results).to.deep.equal({});
    });
  });
});
