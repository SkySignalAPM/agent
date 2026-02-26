/**
 * MethodTracer tests — P0 pure function coverage.
 *
 * Tests all stateless / near-stateless methods that can be exercised
 * without starting the full method-wrapping machinery.
 */

import { expect } from 'chai';
import MethodTracer from '../../../lib/collectors/MethodTracer.js';

describe('MethodTracer', function () {

  let tracer;

  beforeEach(function () {
    tracer = new MethodTracer({
      client: null,
      host: 'test-host',
      enabled: false // don't start() — we only test pure functions
    });
  });

  // ==========================================
  // isSensitiveKey (static)
  // ==========================================
  describe('isSensitiveKey', function () {

    it('returns false for null/undefined/empty', function () {
      expect(MethodTracer.isSensitiveKey(null)).to.be.false;
      expect(MethodTracer.isSensitiveKey(undefined)).to.be.false;
      expect(MethodTracer.isSensitiveKey('')).to.be.false;
    });

    it('detects exact sensitive keys (case-insensitive)', function () {
      const keys = [
        'password', 'secret', 'token', 'apikey', 'api_key',
        'authorization', 'cookie', 'session', 'credit_card',
        'ssn', 'cvv', 'private_key', 'access_token', 'bearer',
        'credentials', 'refresh_token'
      ];
      for (const key of keys) {
        expect(MethodTracer.isSensitiveKey(key), `${key}`).to.be.true;
        expect(MethodTracer.isSensitiveKey(key.toUpperCase()), `${key.toUpperCase()}`).to.be.true;
      }
    });

    it('detects substring matches (e.g. userPassword)', function () {
      expect(MethodTracer.isSensitiveKey('userPassword')).to.be.true;
      expect(MethodTracer.isSensitiveKey('my_api_key_here')).to.be.true;
      expect(MethodTracer.isSensitiveKey('x-authorization-header')).to.be.true;
    });

    it('returns false for safe keys', function () {
      expect(MethodTracer.isSensitiveKey('username')).to.be.false;
      expect(MethodTracer.isSensitiveKey('email')).to.be.false;
      expect(MethodTracer.isSensitiveKey('firstName')).to.be.false;
      expect(MethodTracer.isSensitiveKey('count')).to.be.false;
    });
  });

  // ==========================================
  // _calculateQuerySeverity
  // ==========================================
  describe('_calculateQuerySeverity', function () {

    it('returns CRITICAL for >= 1000ms', function () {
      expect(tracer._calculateQuerySeverity(1000)).to.equal('CRITICAL');
      expect(tracer._calculateQuerySeverity(5000)).to.equal('CRITICAL');
    });

    it('returns HIGH for >= 500ms', function () {
      expect(tracer._calculateQuerySeverity(500)).to.equal('HIGH');
      expect(tracer._calculateQuerySeverity(999)).to.equal('HIGH');
    });

    it('returns MEDIUM for >= 200ms', function () {
      expect(tracer._calculateQuerySeverity(200)).to.equal('MEDIUM');
      expect(tracer._calculateQuerySeverity(499)).to.equal('MEDIUM');
    });

    it('returns LOW for < 200ms', function () {
      expect(tracer._calculateQuerySeverity(199)).to.equal('LOW');
      expect(tracer._calculateQuerySeverity(0)).to.equal('LOW');
    });
  });

  // ==========================================
  // _hasRegexOperator
  // ==========================================
  describe('_hasRegexOperator', function () {

    it('returns false for null/undefined/non-object', function () {
      expect(tracer._hasRegexOperator(null)).to.be.false;
      expect(tracer._hasRegexOperator(undefined)).to.be.false;
      expect(tracer._hasRegexOperator('string')).to.be.false;
    });

    it('detects RegExp instances', function () {
      expect(tracer._hasRegexOperator({ name: /test/i })).to.be.true;
    });

    it('detects $regex operator key', function () {
      expect(tracer._hasRegexOperator({ $regex: 'test' })).to.be.true;
    });

    it('detects nested $regex in field value', function () {
      expect(tracer._hasRegexOperator({ name: { $regex: 'test', $options: 'i' } })).to.be.true;
    });

    it('returns false for non-regex queries', function () {
      expect(tracer._hasRegexOperator({ userId: '123', status: 'active' })).to.be.false;
    });

    it('respects depth limit of 3', function () {
      // depth starts at 0, check is `depth > 3`, so depth 4+ is skipped.
      // To reach depth 4: obj.a.b.c.d.regex — 5 levels of nesting
      const deep = { a: { b: { c: { d: { name: /test/ } } } } };
      expect(tracer._hasRegexOperator(deep)).to.be.false;
    });

    it('detects regex at depth 3', function () {
      // depth 0: obj, 1: a, 2: b, 3: c — depth 3 is still checked
      const atDepth3 = { a: { b: { c: /test/ } } };
      expect(tracer._hasRegexOperator(atDepth3)).to.be.true;
    });
  });

  // ==========================================
  // _normalizeQueryObject
  // ==========================================
  describe('_normalizeQueryObject', function () {

    it('returns "?" for null, undefined, and primitives', function () {
      expect(tracer._normalizeQueryObject(null)).to.equal('?');
      expect(tracer._normalizeQueryObject(undefined)).to.equal('?');
      expect(tracer._normalizeQueryObject(42)).to.equal('?');
      expect(tracer._normalizeQueryObject('str')).to.equal('?');
    });

    it('returns "?" for arrays', function () {
      expect(tracer._normalizeQueryObject([1, 2, 3])).to.equal('?');
    });

    it('replaces simple field values with "?"', function () {
      const result = tracer._normalizeQueryObject({ userId: 'abc123', status: 'active' });
      expect(result).to.deep.equal({ userId: '?', status: '?' });
    });

    it('preserves $operator structure', function () {
      const result = tracer._normalizeQueryObject({
        age: { $gte: 18, $lte: 65 }
      });
      expect(result).to.deep.equal({
        age: { $gte: '?', $lte: '?' }
      });
    });

    it('replaces simple $operator values with "?"', function () {
      const result = tracer._normalizeQueryObject({
        _id: { $in: ['a', 'b', 'c'] }
      });
      expect(result).to.deep.equal({
        _id: { $in: '?' }
      });
    });

    it('handles nested $and / $or', function () {
      const result = tracer._normalizeQueryObject({
        $and: [{ a: 1 }, { b: 2 }]
      });
      // $and has an array value → simple operator → "?"
      expect(result).to.deep.equal({ $and: '?' });
    });

    it('handles empty object', function () {
      const result = tracer._normalizeQueryObject({});
      expect(result).to.deep.equal({});
    });
  });

  // ==========================================
  // _generateQueryFingerprint
  // ==========================================
  describe('_generateQueryFingerprint', function () {

    it('generates collection.operation::normalizedSelector format', function () {
      const fp = tracer._generateQueryFingerprint('users', 'find', { status: 'active' });
      expect(fp).to.equal('users.find::{"status":"?"}');
    });

    it('normalizes different values to same fingerprint', function () {
      const fp1 = tracer._generateQueryFingerprint('users', 'findOne', { _id: 'abc' });
      const fp2 = tracer._generateQueryFingerprint('users', 'findOne', { _id: 'xyz' });
      expect(fp1).to.equal(fp2);
    });

    it('differentiates different query structures', function () {
      const fp1 = tracer._generateQueryFingerprint('users', 'find', { status: 'active' });
      const fp2 = tracer._generateQueryFingerprint('users', 'find', { role: 'admin' });
      expect(fp1).to.not.equal(fp2);
    });

    it('handles empty selector', function () {
      const fp = tracer._generateQueryFingerprint('orders', 'find', {});
      expect(fp).to.equal('orders.find::{}');
    });

    it('handles undefined selector', function () {
      const fp = tracer._generateQueryFingerprint('orders', 'find');
      // undefined → _normalizeQueryObject returns "?" → JSON.stringify("?") = '"?"'
      expect(fp).to.include('orders.find');
    });

    it('falls back to simple fingerprint on error', function () {
      // Force an error by passing a non-serializable selector
      const circular = {};
      circular.self = circular;
      // _normalizeQueryObject won't crash on circular (it just builds a new obj),
      // but JSON.stringify will — which triggers the fallback
      const fp = tracer._generateQueryFingerprint('test', 'find', circular);
      expect(fp).to.equal('test.find');
    });
  });

  // ==========================================
  // _generateN1Suggestion
  // ==========================================
  describe('_generateN1Suggestion', function () {

    it('suggests $in for findOne', function () {
      const s = tracer._generateN1Suggestion('findOne', 10);
      expect(s).to.include('$in');
      expect(s).to.include('10');
    });

    it('suggests $in for findOneAsync', function () {
      const s = tracer._generateN1Suggestion('findOneAsync', 7);
      expect(s).to.include('$in');
      expect(s).to.include('7');
    });

    it('suggests aggregation for find', function () {
      const s = tracer._generateN1Suggestion('find', 15);
      expect(s).to.include('$lookup');
      expect(s).to.include('15');
    });

    it('suggests batch update for update/updateAsync', function () {
      expect(tracer._generateN1Suggestion('update', 8)).to.include('Batch');
      expect(tracer._generateN1Suggestion('updateAsync', 8)).to.include('Batch');
    });

    it('suggests batch remove for remove/removeAsync', function () {
      expect(tracer._generateN1Suggestion('remove', 6)).to.include('Batch');
      expect(tracer._generateN1Suggestion('removeAsync', 6)).to.include('Batch');
    });

    it('provides generic suggestion for unknown operations', function () {
      const s = tracer._generateN1Suggestion('aggregate', 5);
      expect(s).to.include('Consolidate');
      expect(s).to.include('aggregate');
    });
  });

  // ==========================================
  // _analyzeN1Patterns
  // ==========================================
  describe('_analyzeN1Patterns', function () {

    it('returns null when no queryFingerprints', function () {
      expect(tracer._analyzeN1Patterns({})).to.be.null;
      expect(tracer._analyzeN1Patterns({ queryFingerprints: new Map() })).to.be.null;
    });

    it('returns null when counts below threshold (5)', function () {
      const fingerprints = new Map();
      fingerprints.set('users.findOne::{"_id":"?"}', {
        count: 4, // below threshold
        totalDuration: 100,
        operations: []
      });
      expect(tracer._analyzeN1Patterns({ queryFingerprints: fingerprints })).to.be.null;
    });

    it('detects N+1 pattern at threshold', function () {
      const fingerprints = new Map();
      fingerprints.set('users.findOne::{"_id":"?"}', {
        count: 5,
        totalDuration: 10,
        operations: [{ dur: 2 }, { dur: 2 }, { dur: 2 }, { dur: 2 }, { dur: 2 }]
      });

      const result = tracer._analyzeN1Patterns({ queryFingerprints: fingerprints });
      expect(result).to.be.an('array').with.lengthOf(1);
      expect(result[0].count).to.equal(5);
      expect(result[0].collection).to.equal('users');
      expect(result[0].operation).to.equal('findOne');
      expect(result[0].suggestion).to.include('$in');
    });

    it('sorts patterns by totalDuration descending', function () {
      const fingerprints = new Map();
      fingerprints.set('users.find::{"status":"?"}', {
        count: 10, totalDuration: 50,
        operations: Array(10).fill({ dur: 5 })
      });
      fingerprints.set('orders.findOne::{"_id":"?"}', {
        count: 20, totalDuration: 200,
        operations: Array(20).fill({ dur: 10 })
      });

      const result = tracer._analyzeN1Patterns({ queryFingerprints: fingerprints });
      expect(result[0].collection).to.equal('orders'); // higher totalDuration first
      expect(result[1].collection).to.equal('users');
    });

    it('limits samples to first 3', function () {
      const ops = Array(10).fill(null).map((_, i) => ({ dur: i }));
      const fingerprints = new Map();
      fingerprints.set('col.find::{}', {
        count: 10, totalDuration: 100, operations: ops
      });

      const result = tracer._analyzeN1Patterns({ queryFingerprints: fingerprints });
      expect(result[0].samples).to.have.lengthOf(3);
    });

    it('returns null when totalDuration below MIN_TOTAL_DURATION (2)', function () {
      const fingerprints = new Map();
      fingerprints.set('users.findOne::{"_id":"?"}', {
        count: 10,
        totalDuration: 1, // below threshold
        operations: Array(10).fill({ dur: 0.1 })
      });
      expect(tracer._analyzeN1Patterns({ queryFingerprints: fingerprints })).to.be.null;
    });
  });

  // ==========================================
  // _analyzeSlowQuery
  // ==========================================
  describe('_analyzeSlowQuery', function () {

    it('flags MISSING_INDEX for queries > 500ms', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', { status: 'active' }, 600);
      expect(result.likelyIssues).to.include('MISSING_INDEX');
      expect(result.severity).to.equal('HIGH');
    });

    it('flags SUBOPTIMAL_INDEX for queries 200-500ms', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', { status: 'active' }, 300);
      expect(result.likelyIssues).to.include('SUBOPTIMAL_INDEX');
    });

    it('flags COLLECTION_SCAN for empty selector', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', {}, 100);
      expect(result.likelyIssues).to.include('COLLECTION_SCAN');
    });

    it('flags COLLECTION_SCAN for null selector', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', null, 100);
      expect(result.likelyIssues).to.include('COLLECTION_SCAN');
    });

    it('flags COMPLEX_QUERY for > 2 selector keys', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', {
        status: 'active', role: 'admin', age: 25
      }, 100);
      expect(result.likelyIssues).to.include('COMPLEX_QUERY');
    });

    it('flags REGEX_QUERY for regex in selector', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', { name: /john/i }, 100);
      expect(result.likelyIssues).to.include('REGEX_QUERY');
    });

    it('flags COMPLEX_OPERATOR for $where', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', { $where: 'this.a > 1' }, 100);
      expect(result.likelyIssues).to.include('COMPLEX_OPERATOR');
    });

    it('flags COMPLEX_OPERATOR for $expr', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', { $expr: { $gt: ['$a', '$b'] } }, 100);
      expect(result.likelyIssues).to.include('COMPLEX_OPERATOR');
    });

    it('returns severity in result', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', {}, 1500);
      expect(result.severity).to.equal('CRITICAL');
    });

    it('can flag multiple issues simultaneously', function () {
      // > 500ms + empty selector + has $where
      const result = tracer._analyzeSlowQuery('users', 'find', { $where: 'true' }, 600);
      expect(result.likelyIssues).to.include('MISSING_INDEX');
      expect(result.likelyIssues).to.include('COMPLEX_OPERATOR');
    });

    it('returns recommendations matching issues', function () {
      const result = tracer._analyzeSlowQuery('users', 'find', {}, 600);
      expect(result.recommendations).to.be.an('array').with.length.greaterThan(0);
      expect(result.recommendations.join(' ')).to.include('users');
    });
  });

  // ==========================================
  // _computeUnblockImpact
  // ==========================================
  describe('_computeUnblockImpact', function () {

    it('returns impactScore 0 when unblock was called', function () {
      const result = tracer._computeUnblockImpact(
        { called: true, timeToUnblock: 15, callPosition: 'early' },
        500, 0, 0
      );
      expect(result.called).to.be.true;
      expect(result.impactScore).to.equal(0);
      expect(result.recommendation).to.equal('NONE');
    });

    it('returns null for low-impact scenarios (NONE recommendation)', function () {
      // Short method, no blocking, no waiting
      const result = tracer._computeUnblockImpact(
        { called: false }, 50, 50, 0
      );
      expect(result).to.be.null;
    });

    it('returns HIGH recommendation for high impact (score >= 7)', function () {
      // blockTime > 1000 (4pts) + waitedOn > 2000 (4pts) + duration > 1000 (2pts) = 10
      const result = tracer._computeUnblockImpact(
        { called: false }, 2000, 2000, 3000
      );
      expect(result.recommendation).to.equal('HIGH');
      expect(result.impactScore).to.be.at.least(7);
      expect(result.impactScore).to.be.at.most(10);
    });

    it('returns MEDIUM recommendation for moderate impact (score 4-6)', function () {
      // blockTime > 500 (3pts) + waitedOn > 200 (1pts) + duration < 500 (0pts) = 4
      const result = tracer._computeUnblockImpact(
        { called: false }, 400, 600, 300
      );
      expect(result.recommendation).to.equal('MEDIUM');
      expect(result.impactScore).to.be.within(4, 6);
    });

    it('returns LOW recommendation for minor impact (score 2-3)', function () {
      // blockTime > 200 (2pts), no waitedOn (0pts), short duration (0pts)
      const result = tracer._computeUnblockImpact(
        { called: false }, 300, 300, 0
      );
      expect(result.recommendation).to.equal('LOW');
      expect(result.impactScore).to.be.within(2, 3);
    });

    it('caps impactScore at 10', function () {
      const result = tracer._computeUnblockImpact(
        { called: false }, 5000, 5000, 5000
      );
      expect(result.impactScore).to.equal(10);
    });

    it('calculates potentialSaving', function () {
      const result = tracer._computeUnblockImpact(
        { called: false }, 1000, 1000, 500
      );
      expect(result).to.not.be.null;
      expect(result.potentialSaving).to.be.a('number');
      expect(result.potentialSaving).to.be.at.least(0);
    });

    it('uses duration as blockTime when blockingTime is falsy', function () {
      // blockingTime = 0 (falsy), should use duration = 1500
      const result = tracer._computeUnblockImpact(
        { called: false }, 1500, 0, 500
      );
      expect(result).to.not.be.null;
      // duration 1500 → blockTime 1500 → 4 pts for blocking + 1 pt for waitedOn + 2 pts for duration = 7 → HIGH
      expect(result.recommendation).to.equal('HIGH');
    });

    it('includes suggestedPosition of 20ms (security checks estimate)', function () {
      const result = tracer._computeUnblockImpact(
        { called: false }, 2000, 2000, 3000
      );
      expect(result.suggestedPosition).to.equal(20);
    });
  });

  // ==========================================
  // _cleanupStaleCallStackEntries
  // ==========================================
  describe('_cleanupStaleCallStackEntries', function () {

    it('removes entries older than 5 minutes', function () {
      const now = Date.now();
      tracer._callStack = [
        { methodName: 'old', startTime: now - 6 * 60 * 1000, sessionId: 's1' },
        { methodName: 'recent', startTime: now - 1 * 60 * 1000, sessionId: 's2' }
      ];
      tracer._cleanupStaleCallStackEntries();
      expect(tracer._callStack).to.have.lengthOf(1);
      expect(tracer._callStack[0].methodName).to.equal('recent');
    });

    it('keeps all entries when none are stale', function () {
      const now = Date.now();
      tracer._callStack = [
        { methodName: 'a', startTime: now - 1000, sessionId: 's1' },
        { methodName: 'b', startTime: now - 2000, sessionId: 's2' }
      ];
      tracer._cleanupStaleCallStackEntries();
      expect(tracer._callStack).to.have.lengthOf(2);
    });

    it('removes all entries when all are stale', function () {
      const now = Date.now();
      tracer._callStack = [
        { methodName: 'a', startTime: now - 10 * 60 * 1000, sessionId: 's1' },
        { methodName: 'b', startTime: now - 8 * 60 * 1000, sessionId: 's2' }
      ];
      tracer._cleanupStaleCallStackEntries();
      expect(tracer._callStack).to.have.lengthOf(0);
    });

    it('handles empty call stack gracefully', function () {
      tracer._callStack = [];
      expect(() => tracer._cleanupStaleCallStackEntries()).to.not.throw();
      expect(tracer._callStack).to.have.lengthOf(0);
    });
  });

  // ==========================================
  // _defaultSanitizer
  // ==========================================
  describe('_defaultSanitizer', function () {

    it('returns null/undefined unchanged', function () {
      expect(tracer._defaultSanitizer(null)).to.be.null;
      expect(tracer._defaultSanitizer(undefined)).to.be.undefined;
    });

    it('returns numbers and booleans unchanged', function () {
      expect(tracer._defaultSanitizer(42)).to.equal(42);
      expect(tracer._defaultSanitizer(true)).to.be.true;
      expect(tracer._defaultSanitizer(0)).to.equal(0);
    });

    it('passes through short strings', function () {
      expect(tracer._defaultSanitizer('hello')).to.equal('hello');
    });

    it('truncates strings beyond maxArgLength (default 1000)', function () {
      const long = 'x'.repeat(1500);
      const result = tracer._defaultSanitizer(long);
      expect(result).to.include('...<truncated>');
      expect(result.length).to.be.lessThan(1500);
    });

    it('converts functions to "<function>"', function () {
      expect(tracer._defaultSanitizer(() => {})).to.equal('<function>');
    });

    it('converts Date to ISO string', function () {
      const d = new Date('2024-01-15T12:00:00Z');
      expect(tracer._defaultSanitizer(d)).to.equal('2024-01-15T12:00:00.000Z');
    });

    it('converts RegExp to string representation', function () {
      expect(tracer._defaultSanitizer(/test/gi)).to.equal('/test/gi');
    });

    it('redacts sensitive keys in objects', function () {
      const result = tracer._defaultSanitizer({
        username: 'alice',
        password: 'secret123',
        token: 'abc'
      });
      expect(result.username).to.equal('alice');
      expect(result.password).to.equal('<redacted>');
      expect(result.token).to.equal('<redacted>');
    });

    it('returns "<max depth reached>" beyond maxDepth (3)', function () {
      // depth check is `depth > maxDepth`, so depth 3 is still processed.
      // We need depth 4 to trigger the guard.
      const deep = { a: { b: { c: { d: { e: 'leaf' } } } } };
      const result = tracer._defaultSanitizer(deep);
      expect(result.a.b.c.d).to.equal('<max depth reached>');
    });

    it('truncates arrays beyond 10 items', function () {
      const arr = Array.from({ length: 15 }, (_, i) => i);
      const result = tracer._defaultSanitizer(arr);
      expect(result).to.have.lengthOf(11); // 10 items + truncation message
      expect(result[10]).to.include('5 more items');
    });

    it('truncates objects beyond 50 keys', function () {
      const obj = {};
      for (let i = 0; i < 60; i++) {
        obj[`key${i}`] = i;
      }
      const result = tracer._defaultSanitizer(obj);
      expect(result['<truncated>']).to.include('10 more keys omitted');
    });

    it('uses custom maxArgLength', function () {
      const custom = new MethodTracer({ enabled: false, maxArgLength: 50 });
      const long = 'x'.repeat(100);
      const result = custom._defaultSanitizer(long);
      expect(result).to.include('...<truncated>');
      expect(result.length).to.be.lessThan(100);
    });
  });

  // ==========================================
  // _sanitizeDbArg
  // ==========================================
  describe('_sanitizeDbArg', function () {

    it('returns null/undefined unchanged', function () {
      expect(tracer._sanitizeDbArg(null)).to.be.null;
      expect(tracer._sanitizeDbArg(undefined)).to.be.undefined;
    });

    it('returns numbers and booleans unchanged', function () {
      expect(tracer._sanitizeDbArg(42)).to.equal(42);
      expect(tracer._sanitizeDbArg(false)).to.be.false;
    });

    it('truncates strings at 500 chars (not maxArgLength)', function () {
      const long = 'y'.repeat(600);
      const result = tracer._sanitizeDbArg(long);
      expect(result).to.include('...<truncated>');
      // 500 + "...<truncated>" length
      expect(result.length).to.be.lessThan(600);
    });

    it('converts functions to "<function>"', function () {
      expect(tracer._sanitizeDbArg(function foo() {})).to.equal('<function>');
    });

    it('converts Date to ISO string', function () {
      const d = new Date('2024-06-01T00:00:00Z');
      expect(tracer._sanitizeDbArg(d)).to.equal('2024-06-01T00:00:00.000Z');
    });

    it('converts RegExp to string', function () {
      expect(tracer._sanitizeDbArg(/^test$/)).to.equal('/^test$/');
    });

    it('has deeper maxDepth (5) than _defaultSanitizer (3)', function () {
      const deep = { a: { b: { c: { d: { e: 'leaf' } } } } };
      const result = tracer._sanitizeDbArg(deep);
      expect(result.a.b.c.d.e).to.equal('leaf'); // depth 5 should reach leaf
    });

    it('returns "<max depth reached>" beyond depth 5', function () {
      // depth check is `depth > maxDepth`, so depth 5 is still processed.
      // We need depth 6 to trigger the guard.
      const deep = { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } };
      const result = tracer._sanitizeDbArg(deep);
      expect(result.a.b.c.d.e.f).to.equal('<max depth reached>');
    });

    it('redacts sensitive keys', function () {
      const result = tracer._sanitizeDbArg({
        query: { userId: '123' },
        password: 'secret'
      });
      expect(result.query.userId).to.equal('123');
      expect(result.password).to.equal('<redacted>');
    });

    it('truncates arrays beyond 20 items', function () {
      const arr = Array.from({ length: 25 }, (_, i) => i);
      const result = tracer._sanitizeDbArg(arr);
      expect(result).to.have.lengthOf(21); // 20 items + truncation msg
      expect(result[20]).to.include('5 more items');
    });

    it('truncates objects beyond 50 keys', function () {
      const obj = {};
      for (let i = 0; i < 55; i++) {
        obj[`field${i}`] = i;
      }
      const result = tracer._sanitizeDbArg(obj);
      expect(result['<truncated>']).to.include('5 more keys omitted');
    });
  });

  // ==========================================
  // _sanitizeArgs
  // ==========================================
  describe('_sanitizeArgs', function () {

    it('returns empty object for null/undefined/empty args', function () {
      expect(tracer._sanitizeArgs(null)).to.deep.equal({});
      expect(tracer._sanitizeArgs(undefined)).to.deep.equal({});
      expect(tracer._sanitizeArgs([])).to.deep.equal({});
    });

    it('passes single object arg through sanitizer directly', function () {
      const result = tracer._sanitizeArgs([{ name: 'test', password: 'secret' }]);
      expect(result.name).to.equal('test');
      expect(result.password).to.equal('<redacted>');
      // Should NOT wrap in arg0
      expect(result).to.not.have.property('arg0');
    });

    it('wraps multiple args as arg0, arg1, arg2...', function () {
      const result = tracer._sanitizeArgs(['hello', 42, { key: 'val' }]);
      expect(result).to.have.property('arg0');
      expect(result).to.have.property('arg1');
      expect(result).to.have.property('arg2');
    });

    it('wraps single primitive arg as arg0', function () {
      const result = tracer._sanitizeArgs(['hello']);
      expect(result).to.have.property('arg0');
    });

    it('wraps single array arg as arg0', function () {
      const result = tracer._sanitizeArgs([[1, 2, 3]]);
      expect(result).to.have.property('arg0');
    });

    it('returns error object on sanitizer failure', function () {
      const broken = new MethodTracer({
        enabled: false,
        argumentSanitizer: () => { throw new Error('boom'); }
      });
      const result = broken._sanitizeArgs([{ a: 1 }]);
      expect(result.error).to.include('error sanitizing');
    });
  });

  // ==========================================
  // constructor defaults
  // ==========================================
  describe('constructor', function () {

    it('sets default option values', function () {
      const t = new MethodTracer({ enabled: false });
      expect(t.maxArgLength).to.equal(1000);
      expect(t.slowQueryThreshold).to.equal(1000);
      expect(t.appVersion).to.equal('unknown');
      expect(t.buildHash).to.be.null;
      expect(t.debug).to.be.false;
    });

    it('respects custom options', function () {
      const t = new MethodTracer({
        enabled: false,
        maxArgLength: 500,
        slowQueryThreshold: 200,
        appVersion: '1.2.3',
        buildHash: 'abc123',
        debug: true
      });
      expect(t.maxArgLength).to.equal(500);
      expect(t.slowQueryThreshold).to.equal(200);
      expect(t.appVersion).to.equal('1.2.3');
      expect(t.buildHash).to.equal('abc123');
      expect(t.debug).to.be.true;
    });

    it('binds _defaultSanitizer as default argumentSanitizer', function () {
      const t = new MethodTracer({ enabled: false });
      // The default sanitizer should work (it's bound to the instance)
      const result = t.argumentSanitizer({ password: 'x', name: 'y' });
      expect(result.password).to.equal('<redacted>');
      expect(result.name).to.equal('y');
    });

    it('accepts custom argumentSanitizer', function () {
      const custom = (arg) => 'custom';
      const t = new MethodTracer({ enabled: false, argumentSanitizer: custom });
      expect(t.argumentSanitizer({ a: 1 })).to.equal('custom');
    });
  });

  // ==========================================
  // getCurrentContext
  // ==========================================
  describe('getCurrentContext', function () {

    it('returns null when no method is executing', function () {
      expect(tracer.getCurrentContext()).to.be.null;
    });

    it('returns the current method context when set inside AsyncLocalStorage.run', function () {
      const ctx = { methodName: 'test', operations: [] };
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        expect(tracer.getCurrentContext()).to.equal(ctx);
      });
    });
  });

  // ==========================================
  // addOperation
  // ==========================================
  describe('addOperation', function () {

    let ctx;

    function createContext(overrides = {}) {
      return {
        methodName: 'users.find',
        startTime: Date.now() - 100,
        operations: [],
        queryFingerprints: new Map(),
        queryOperations: [],
        slowQueries: [],
        maxQueryFingerprints: 100,
        maxQueryOperations: 500,
        ...overrides
      };
    }

    it('returns undefined when no context', function () {
      expect(tracer.addOperation({ type: 'db' })).to.be.undefined;
    });

    it('adds operation with relative time', function () {
      ctx = createContext();
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        const op = tracer.addOperation({ type: 'wait', label: 'sleep', duration: 50 });
        expect(ctx.operations).to.have.lengthOf(1);
        expect(op.time).to.be.a('number');
        expect(op.time).to.be.at.least(0);
      });
    });

    it('tracks db operation fingerprints for N+1 detection', function () {
      ctx = createContext();
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        tracer.addOperation({
          type: 'db', collection: 'users', operation: 'findOne',
          selector: { _id: '1' }, duration: 5
        });
        tracer.addOperation({
          type: 'db', collection: 'users', operation: 'findOne',
          selector: { _id: '2' }, duration: 3
        });

        expect(ctx.queryFingerprints.size).to.equal(1);
        const fp = ctx.queryFingerprints.values().next().value;
        expect(fp.count).to.equal(2);
        expect(fp.totalDuration).to.equal(8);
      });
    });

    it('respects maxQueryFingerprints limit', function () {
      ctx = createContext({ maxQueryFingerprints: 2 });
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        tracer.addOperation({ type: 'db', collection: 'a', operation: 'find', selector: {}, duration: 1 });
        tracer.addOperation({ type: 'db', collection: 'b', operation: 'find', selector: {}, duration: 1 });
        tracer.addOperation({ type: 'db', collection: 'c', operation: 'find', selector: {}, duration: 1 });

        expect(ctx.queryFingerprints.size).to.equal(2);
        expect(ctx.operations).to.have.lengthOf(3);
      });
    });

    it('tracks slow queries with COLLSCAN flag', function () {
      ctx = createContext();
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        tracer.addOperation({
          type: 'db', collection: 'orders', operation: 'find',
          selector: { status: 'pending' }, duration: 500,
          slowQuery: true,
          queryAnalysis: { stage: 'COLLSCAN' },
          indexUsed: 'COLLSCAN',
          totalDocsExamined: 1000,
          totalKeysExamined: 0
        });

        expect(ctx.slowQueries).to.have.lengthOf(1);
        expect(ctx.slowQueries[0].collscan).to.be.true;
        expect(ctx.slowQueries[0].collscanCollection).to.equal('orders');
      });
    });

    it('attaches pipeline for slow aggregations', function () {
      ctx = createContext();
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        tracer.addOperation({
          type: 'db', collection: 'logs', operation: 'aggregate',
          selector: {}, duration: 800,
          slowQuery: true,
          queryAnalysis: { stage: 'SORT' },
          pipeline: [{ $match: { level: 'error' } }, { $sort: { ts: -1 } }]
        });

        expect(ctx.slowQueries[0].pipeline).to.have.lengthOf(2);
      });
    });

    it('respects maxQueryOperations limit', function () {
      ctx = createContext({ maxQueryOperations: 2 });
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        tracer.addOperation({ type: 'db', collection: 'a', operation: 'find', selector: {}, duration: 1 });
        tracer.addOperation({ type: 'db', collection: 'b', operation: 'find', selector: {}, duration: 1 });
        tracer.addOperation({ type: 'db', collection: 'c', operation: 'find', selector: {}, duration: 1 });

        expect(ctx.queryOperations).to.have.lengthOf(2);
      });
    });

    it('returns the operation object (for callers to mutate)', function () {
      ctx = createContext();
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        const op = tracer.addOperation({ type: 'compute', label: 'calc', duration: 10 });
        expect(op).to.be.an('object');
        expect(op.type).to.equal('compute');
      });
    });
  });

  // ==========================================
  // trackWaitTime / trackComputeTime / trackAsyncOperation
  // ==========================================
  describe('track* methods', function () {

    function createContext() {
      return {
        methodName: 'test',
        startTime: Date.now() - 100,
        operations: [],
        queryFingerprints: new Map(),
        queryOperations: [],
        slowQueries: [],
        maxQueryFingerprints: 100,
        maxQueryOperations: 500
      };
    }

    it('trackWaitTime adds wait operation and returns duration', function () {
      const ctx = createContext();
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        const startTime = Date.now() - 50;
        const duration = tracer.trackWaitTime('db-query', startTime);

        expect(duration).to.be.at.least(50);
        expect(ctx.operations).to.have.lengthOf(1);
        expect(ctx.operations[0].type).to.equal('wait');
        expect(ctx.operations[0].label).to.equal('db-query');
      });
    });

    it('trackWaitTime uses default label', function () {
      const ctx = createContext();
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        tracer.trackWaitTime(null, Date.now());
        expect(ctx.operations[0].label).to.equal('wait');
      });
    });

    it('trackComputeTime adds compute operation', function () {
      const ctx = createContext();
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        const startTime = Date.now() - 25;
        const duration = tracer.trackComputeTime('hash-data', startTime);

        expect(duration).to.be.at.least(25);
        expect(ctx.operations[0].type).to.equal('compute');
        expect(ctx.operations[0].label).to.equal('hash-data');
      });
    });

    it('trackAsyncOperation adds async operation', function () {
      const ctx = createContext();
      tracer._asyncContextStorage.run({ methodContext: ctx }, () => {
        const startTime = Date.now() - 10;
        const duration = tracer.trackAsyncOperation('fetch-api', startTime);

        expect(duration).to.be.at.least(10);
        expect(ctx.operations[0].type).to.equal('async');
        expect(ctx.operations[0].label).to.equal('fetch-api');
      });
    });
  });

  // ==========================================
  // trackAsyncFunction
  // ==========================================
  describe('trackAsyncFunction', function () {

    function createContext() {
      return {
        methodName: 'test',
        startTime: Date.now() - 100,
        operations: [],
        queryFingerprints: new Map(),
        queryOperations: [],
        slowQueries: [],
        maxQueryFingerprints: 100,
        maxQueryOperations: 500
      };
    }

    it('tracks async function and returns result', async function () {
      const ctx = createContext();
      const result = await tracer._asyncContextStorage.run({ methodContext: ctx }, async () => {
        return tracer.trackAsyncFunction('calc', async () => 42);
      });
      expect(result).to.equal(42);
      expect(ctx.operations).to.have.lengthOf(1);
      expect(ctx.operations[0].type).to.equal('async');
    });

    it('tracks resolved promise directly', async function () {
      const ctx = createContext();
      const result = await tracer._asyncContextStorage.run({ methodContext: ctx }, async () => {
        return tracer.trackAsyncFunction('fetch', Promise.resolve('data'));
      });
      expect(result).to.equal('data');
    });

    it('re-throws error and records operation with error', async function () {
      const ctx = createContext();
      let caught = false;
      try {
        await tracer._asyncContextStorage.run({ methodContext: ctx }, async () => {
          return tracer.trackAsyncFunction('fail', async () => { throw new Error('boom'); });
        });
      } catch (e) {
        caught = true;
        expect(e.message).to.equal('boom');
      }
      expect(caught).to.be.true;
      expect(ctx.operations).to.have.lengthOf(1);
      expect(ctx.operations[0].error).to.equal('boom');
    });
  });

  // ==========================================
  // _shouldExplainQuery
  // ==========================================
  describe('_shouldExplainQuery', function () {

    it('only explains slow queries when explainSlowQueriesOnly=true', function () {
      tracer.explainSlowQueriesOnly = true;
      tracer.slowQueryThreshold = 100;

      expect(tracer._shouldExplainQuery(200)).to.be.true;
      expect(tracer._shouldExplainQuery(50)).to.be.false;
    });

    it('uses sampling when explainSlowQueriesOnly=false', function () {
      tracer.explainSlowQueriesOnly = false;
      tracer.indexUsageSampleRate = 1.0;
      expect(tracer._shouldExplainQuery(10)).to.be.true;

      tracer.indexUsageSampleRate = 0;
      // With 0 sample rate, Math.random() < 0 is always false
      expect(tracer._shouldExplainQuery(10)).to.be.false;
    });
  });
});
