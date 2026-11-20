import { expect } from 'chai';
import { estimateObjectSize } from '../../../lib/sizeEstimator.js';

describe('sizeEstimator', function () {

  describe('estimateObjectSize', function () {

    it('returns 0 for null and undefined', function () {
      expect(estimateObjectSize(null)).to.equal(0);
      expect(estimateObjectSize(undefined)).to.equal(0);
    });

    it('returns 8 for numbers', function () {
      expect(estimateObjectSize(42)).to.equal(8);
      expect(estimateObjectSize(3.14)).to.equal(8);
      expect(estimateObjectSize(0)).to.equal(8);
      expect(estimateObjectSize(-Infinity)).to.equal(8);
    });

    it('returns 4 for booleans', function () {
      expect(estimateObjectSize(true)).to.equal(4);
      expect(estimateObjectSize(false)).to.equal(4);
    });

    it('returns length * 2 for strings', function () {
      expect(estimateObjectSize('')).to.equal(0);
      expect(estimateObjectSize('hello')).to.equal(10);
      expect(estimateObjectSize('abc')).to.equal(6);
    });

    it('returns 8 for bigint', function () {
      expect(estimateObjectSize(BigInt(999))).to.equal(8);
    });

    it('returns 24 for Date objects', function () {
      expect(estimateObjectSize(new Date())).to.equal(24);
    });

    it('estimates RegExp from source length', function () {
      const re = /abc/gi;
      // source "abc" = 3 chars * 2 + 24 = 30
      expect(estimateObjectSize(re)).to.equal(30);
    });

    it('estimates ArrayBuffer by byteLength', function () {
      const buf = new ArrayBuffer(64);
      expect(estimateObjectSize(buf)).to.equal(64);
    });

    it('estimates TypedArray by byteLength', function () {
      const arr = new Uint8Array(128);
      expect(estimateObjectSize(arr)).to.equal(128);
    });

    it('estimates plain objects (overhead + keys + values)', function () {
      const obj = { name: 'John', age: 30 };
      const size = estimateObjectSize(obj);
      // 8 (overhead) + "name"(8) + "John"(8) + "age"(6) + 30(8) = 38
      expect(size).to.equal(38);
    });

    it('estimates arrays (overhead + elements)', function () {
      const arr = [1, 2, 3];
      const size = estimateObjectSize(arr);
      // 8 (overhead) + 3 * 8 (numbers) = 32
      expect(size).to.equal(32);
    });

    it('handles circular references without infinite loop', function () {
      const obj = { a: 1 };
      obj.self = obj;
      // Should not throw or hang
      const size = estimateObjectSize(obj);
      expect(size).to.be.a('number');
      expect(size).to.be.greaterThan(0);
    });

    it('returns 100 for deeply nested objects beyond MAX_DEPTH (20)', function () {
      let nested = { value: 42 };
      for (let i = 0; i < 25; i++) {
        nested = { child: nested };
      }
      // Should complete without stack overflow
      const size = estimateObjectSize(nested);
      expect(size).to.be.a('number');
      expect(size).to.be.greaterThan(0);
    });

    it('limits array iteration to 1000 items', function () {
      const bigArray = new Array(2000).fill(42);
      // Should not hang; should estimate remaining items
      const size = estimateObjectSize(bigArray);
      expect(size).to.be.greaterThan(0);
    });

    it('limits object key iteration to 500 keys', function () {
      const bigObj = {};
      for (let i = 0; i < 700; i++) {
        bigObj[`key${i}`] = i;
      }
      const size = estimateObjectSize(bigObj);
      expect(size).to.be.greaterThan(0);
    });

    it('estimates functions by toString length', function () {
      const fn = function myFunc() { return 42; };
      const size = estimateObjectSize(fn);
      expect(size).to.equal(fn.toString().length * 2);
    });
  });
});
