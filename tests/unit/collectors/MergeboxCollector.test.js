/**
 * MergeboxCollector tests.
 *
 * Fabricates Meteor ddp-server internals (Session.collectionViews,
 * SessionCollectionView.documents, SessionDocumentView.dataByKey/existsIn,
 * Session._namedSubs) to drive the collector's read-only snapshot logic without a
 * real Meteor runtime. All structures mirror ddp-server 3.x source.
 *
 * Asserts:
 *   (a) SERVER_MERGE doc shared by 2 named subs -> even-split halves bytes per pub,
 *       and the two rows SUM to the full doc bytes (sum-preserving invariant).
 *   (b) auto-publish ('U') handle -> row with publicationName omitted.
 *   (c) NO_MERGE collection absent from collectionViews -> no row.
 *   (d) connectionCount counts distinct SESSIONS, not handles.
 *   (e) sampleRate < 1 path doesn't crash and stamps sampleRate on rows.
 *   (f) feature-detect: a session missing collectionViews is skipped without throwing.
 *   (g) strategy reverse-map: NO_MERGE object -> "NO_MERGE", unknown object -> "unknown".
 *
 * Does NOT wrap session.send / processMessage — read-only collector.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { Meteor } from 'meteor/meteor';
import MergeboxCollector from '../../../lib/collectors/MergeboxCollector.js';
import { estimateObjectSize } from '../../../lib/sizeEstimator.js';

// ---------------------------------------------------------------------------
// Fabricated ddp-server internals (source-shaped replicas)
// ---------------------------------------------------------------------------

// Canonical publication strategy objects (identity-compared by the collector).
const STRATEGIES = {
  SERVER_MERGE: { useDummyDocumentView: false, useCollectionView: true, doAccountingForCollection: true },
  NO_MERGE_NO_HISTORY: { useDummyDocumentView: false, useCollectionView: false, doAccountingForCollection: false },
  NO_MERGE: { useDummyDocumentView: false, useCollectionView: false, doAccountingForCollection: true },
  NO_MERGE_MULTI: { useDummyDocumentView: true, useCollectionView: true, doAccountingForCollection: true }
};

/** SessionDocumentView replica: dataByKey (Map) + existsIn (Set). */
function makeDocView(fields, handles) {
  const dataByKey = new Map();
  for (const [field, value] of Object.entries(fields)) {
    // PrecedenceItem[] — resident value is precedenceList[0].value
    dataByKey.set(field, [{ subscriptionHandle: handles[0], value }]);
  }
  return { dataByKey, existsIn: new Set(handles) };
}

/** SessionCollectionView replica: documents (Map of docId -> docView). */
function makeCollectionView(docs) {
  const documents = new Map();
  for (const [docId, docView] of Object.entries(docs)) {
    documents.set(docId, docView);
  }
  return { documents };
}

/**
 * Session replica.
 * @param collectionViews  Map(collectionName -> SessionCollectionView)
 * @param namedSubs        Map(subscriptionId -> { _name })
 */
function makeSession(id, collectionViews, namedSubs = new Map()) {
  return { id, collectionViews, _namedSubs: namedSubs };
}

/** Build a fake Meteor.server with a sessions Map + strategy resolver. */
function makeServer(sessionsArray, strategyByCollection = {}) {
  const sessions = new Map();
  for (const s of sessionsArray) sessions.set(s.id, s);
  return {
    sessions,
    getPublicationStrategy(collectionName) {
      return strategyByCollection[collectionName] || STRATEGIES.SERVER_MERGE;
    }
  };
}

// Compute the exact resident bytes for a docView the way the collector does.
function docBytesOf(fields) {
  let bytes = 0;
  for (const [field, value] of Object.entries(fields)) {
    bytes += field.length * 2 + estimateObjectSize(value);
  }
  return bytes;
}

describe('MergeboxCollector', function () {
  let collector;
  let mockClient;
  let originalServer;

  beforeEach(function () {
    mockClient = { addMergeboxMetric: sinon.stub() };
    originalServer = Meteor.server;
    collector = new MergeboxCollector({
      client: mockClient,
      host: 'test-host',
      appVersion: '1.0.0'
    });
  });

  afterEach(function () {
    if (collector.intervalId) {
      clearInterval(collector.intervalId);
      collector.intervalId = null;
    }
    Meteor.server = originalServer;
    delete global.DDPServer;
  });

  function emittedRows() {
    return mockClient.addMergeboxMetric.getCalls().map(c => c.args[0]);
  }

  // ==========================================
  // constructor
  // ==========================================
  describe('constructor', function () {
    it('sets default values', function () {
      expect(collector.host).to.equal('test-host');
      expect(collector.interval).to.equal(60000);
      expect(collector.sampleRate).to.equal(1.0);
      expect(collector.maxSessions).to.equal(2000);
      expect(collector.maxDocsPerSession).to.equal(50000);
      expect(collector.maxRows).to.equal(500);
      expect(collector.intervalId).to.be.null;
    });

    it('honors overrides', function () {
      const c = new MergeboxCollector({
        interval: 30000,
        sampleRate: 0.25,
        maxSessions: 10,
        maxDocsPerSession: 100,
        maxRows: 50
      });
      expect(c.interval).to.equal(30000);
      expect(c.sampleRate).to.equal(0.25);
      expect(c.maxSessions).to.equal(10);
      expect(c.maxDocsPerSession).to.equal(100);
      expect(c.maxRows).to.equal(50);
    });
  });

  // ==========================================
  // (a) even-split + sum-preserving (LOAD-BEARING)
  // ==========================================
  describe('even-split attribution (sum-preserving)', function () {
    it('halves a SERVER_MERGE doc shared by 2 named subs; rows sum to full bytes', function () {
      // One doc in "messages", referenced by two named subs.
      const fields = { text: 'hello world', count: 42 };
      const handles = ['Nsub1', 'Nsub2'];
      const docView = makeDocView(fields, handles);

      const namedSubs = new Map([
        ['sub1', { _name: 'pubA' }],
        ['sub2', { _name: 'pubB' }]
      ]);

      const session = makeSession(
        'sess1',
        new Map([['messages', makeCollectionView({ doc1: docView })]]),
        namedSubs
      );

      Meteor.server = makeServer([session], { messages: STRATEGIES.SERVER_MERGE });

      collector._collect();

      const rows = emittedRows();
      expect(rows).to.have.lengthOf(2);

      const fullBytes = docBytesOf(fields);

      const rowA = rows.find(r => r.publicationName === 'pubA');
      const rowB = rows.find(r => r.publicationName === 'pubB');
      expect(rowA, 'pubA row').to.exist;
      expect(rowB, 'pubB row').to.exist;

      // Each half (rounded). Their sum reconstructs the collection's true residency.
      expect(rowA.bytesHeld + rowB.bytesHeld).to.equal(fullBytes);
      expect(rowA.bytesHeld).to.equal(Math.round(fullBytes / 2));
      expect(rowB.bytesHeld).to.equal(Math.round(fullBytes / 2));

      // docCount even-split: 1/2 each -> rounded.
      expect(rowA.docCount).to.equal(Math.round(0.5));
      expect(rowB.docCount).to.equal(Math.round(0.5));

      // Both are SERVER_MERGE on the right collection.
      expect(rowA.strategy).to.equal('SERVER_MERGE');
      expect(rowA.collectionName).to.equal('messages');
      expect(rowB.collectionName).to.equal('messages');
    });

    it('splits across 3 subs with an exact integer remainder (non-divisible bytes)', function () {
      const fields = { a: 'alpha', b: 'bravo', c: 'charlie payload here' };
      const handles = ['Nsub1', 'Nsub2', 'Nsub3'];
      const docView = makeDocView(fields, handles);
      const namedSubs = new Map([
        ['sub1', { _name: 'pubA' }],
        ['sub2', { _name: 'pubB' }],
        ['sub3', { _name: 'pubC' }]
      ]);
      const session = makeSession(
        's',
        new Map([['messages', makeCollectionView({ d: docView })]]),
        namedSubs
      );
      Meteor.server = makeServer([session], { messages: STRATEGIES.SERVER_MERGE });

      collector._collect();

      const rows = emittedRows();
      expect(rows).to.have.lengthOf(3);

      const fullBytes = docBytesOf(fields);
      const sum = rows.reduce((acc, r) => acc + r.bytesHeld, 0);
      // EXACTLY sum-preserving whether or not fullBytes divides evenly by 3.
      expect(sum).to.equal(fullBytes);
      // Largest-remainder split -> per-handle shares differ by at most 1 byte.
      const vals = rows.map(r => r.bytesHeld).sort((x, y) => x - y);
      expect(vals[vals.length - 1] - vals[0]).to.be.at.most(1);
    });

    it('does not emit a separate per-collection truth row (avoids double-count)', function () {
      const fields = { text: 'x' };
      const handles = ['Nsub1', 'Nsub2'];
      const docView = makeDocView(fields, handles);
      const namedSubs = new Map([
        ['sub1', { _name: 'pubA' }],
        ['sub2', { _name: 'pubB' }]
      ]);
      const session = makeSession(
        'sess1',
        new Map([['messages', makeCollectionView({ doc1: docView })]]),
        namedSubs
      );
      Meteor.server = makeServer([session], { messages: STRATEGIES.SERVER_MERGE });

      collector._collect();

      const rows = emittedRows();
      // Exactly the two even-split rows — no extra collection-total row.
      expect(rows).to.have.lengthOf(2);
      // No row may be missing a publicationName here (all handles are named).
      expect(rows.every(r => r.publicationName)).to.be.true;
    });

    it('aggregates the same (pub, collection) across multiple sessions', function () {
      const fields = { v: 1 };
      const namedSubs = new Map([['s', { _name: 'pubA' }]]);
      const mkSession = (id) =>
        makeSession(
          id,
          new Map([['c', makeCollectionView({ d: makeDocView(fields, ['Ns']) })]]),
          namedSubs
        );

      Meteor.server = makeServer([mkSession('a'), mkSession('b')], { c: STRATEGIES.SERVER_MERGE });
      collector._collect();

      const rows = emittedRows();
      expect(rows).to.have.lengthOf(1);
      const row = rows[0];
      // bytesHeld = 2 * full doc bytes (one doc per session, single handle each)
      expect(row.bytesHeld).to.equal(docBytesOf(fields) * 2);
      expect(row.docCount).to.equal(2);
      expect(row.connectionCount).to.equal(2);
    });
  });

  // ==========================================
  // (b) auto-publish handle -> publicationName omitted
  // ==========================================
  describe('auto-publish attribution', function () {
    it("omits publicationName for a 'U' (universal) handle", function () {
      const fields = { a: 'b' };
      const handles = ['Uxyz']; // universal / auto-publish
      const docView = makeDocView(fields, handles);
      const session = makeSession(
        'sess1',
        new Map([['posts', makeCollectionView({ d: docView })]])
        // no _namedSubs needed for a universal handle
      );
      Meteor.server = makeServer([session], { posts: STRATEGIES.SERVER_MERGE });

      collector._collect();

      const rows = emittedRows();
      expect(rows).to.have.lengthOf(1);
      expect(rows[0]).to.not.have.property('publicationName');
      expect(rows[0].collectionName).to.equal('posts');
      expect(rows[0].bytesHeld).to.equal(docBytesOf(fields));
    });
  });

  // ==========================================
  // (c) NO_MERGE collection absent -> no row
  // ==========================================
  describe('NO_MERGE residency absence', function () {
    it('emits no row when a NO_MERGE collection has no collectionView entry', function () {
      // NO_MERGE keeps no SessionCollectionView, so collectionViews is empty.
      const session = makeSession('sess1', new Map(), new Map());
      Meteor.server = makeServer([session], { feed: STRATEGIES.NO_MERGE });

      collector._collect();

      expect(mockClient.addMergeboxMetric.called).to.be.false;
    });
  });

  // ==========================================
  // (d) connectionCount = distinct sessions, not handles
  // ==========================================
  describe('connectionCount', function () {
    it('counts distinct sessions even when many handles reference a doc', function () {
      // A single session, one doc referenced by THREE handles.
      const fields = { x: 'y' };
      const handles = ['Nsub1', 'Nsub2', 'Nsub3'];
      const docView = makeDocView(fields, handles);
      const namedSubs = new Map([
        ['sub1', { _name: 'p' }],
        ['sub2', { _name: 'p' }],
        ['sub3', { _name: 'p' }]
      ]);
      const session = makeSession(
        'sess1',
        new Map([['c', makeCollectionView({ d: docView })]]),
        namedSubs
      );
      Meteor.server = makeServer([session], { c: STRATEGIES.SERVER_MERGE });

      collector._collect();

      const rows = emittedRows();
      // All three handles resolve to pub "p" -> single bucket.
      expect(rows).to.have.lengthOf(1);
      // Three handles but ONE session.
      expect(rows[0].connectionCount).to.equal(1);
      // Sum-preserving: three thirds round-trip to the full doc bytes.
      expect(rows[0].bytesHeld).to.equal(docBytesOf(fields));
    });
  });

  // ==========================================
  // (e) sampleRate < 1
  // ==========================================
  describe('sampleRate < 1', function () {
    it('does not crash and stamps sampleRate on every row', function () {
      const c = new MergeboxCollector({
        client: mockClient,
        host: 'test-host',
        sampleRate: 0.5
      });
      // Force the sampler to ALWAYS include the session (Math.random() returns 0).
      const rndStub = sinon.stub(Math, 'random').returns(0);

      const fields = { a: 1 };
      const session = makeSession(
        's',
        new Map([['c', makeCollectionView({ d: makeDocView(fields, ['Ux']) })]])
      );
      Meteor.server = makeServer([session], { c: STRATEGIES.SERVER_MERGE });

      expect(() => c._collect()).to.not.throw();
      rndStub.restore();

      const rows = emittedRows();
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].sampleRate).to.equal(0.5);
    });

    it('skips sessions when the sampler excludes them', function () {
      const c = new MergeboxCollector({
        client: mockClient,
        host: 'test-host',
        sampleRate: 0.5
      });
      // Math.random() > sampleRate -> session is sampled out.
      const rndStub = sinon.stub(Math, 'random').returns(0.99);

      const session = makeSession(
        's',
        new Map([['c', makeCollectionView({ d: makeDocView({ a: 1 }, ['Ux']) })]])
      );
      Meteor.server = makeServer([session], { c: STRATEGIES.SERVER_MERGE });

      c._collect();
      rndStub.restore();

      expect(mockClient.addMergeboxMetric.called).to.be.false;
    });
  });

  // ==========================================
  // (f) feature-detect malformed sessions
  // ==========================================
  describe('feature detection', function () {
    it('skips a session missing collectionViews without throwing', function () {
      const goodFields = { a: 1 };
      const good = makeSession(
        'good',
        new Map([['c', makeCollectionView({ d: makeDocView(goodFields, ['Ux']) })]])
      );
      const broken = { id: 'broken' }; // no collectionViews at all

      Meteor.server = makeServer([broken, good], { c: STRATEGIES.SERVER_MERGE });

      expect(() => collector._collect()).to.not.throw();

      // The good session still produces its row.
      const rows = emittedRows();
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].bytesHeld).to.equal(docBytesOf(goodFields));
    });

    it('degrades to zero rows when Meteor.server.sessions is not a Map', function () {
      Meteor.server = { sessions: null, getPublicationStrategy() { return STRATEGIES.SERVER_MERGE; } };
      expect(() => collector._collect()).to.not.throw();
      expect(mockClient.addMergeboxMetric.called).to.be.false;
    });
  });

  // ==========================================
  // (g) strategy reverse-map
  // ==========================================
  describe('_resolveStrategyName', function () {
    it('identity-maps NO_MERGE object -> "NO_MERGE" via DDPServer table', function () {
      global.DDPServer = { publicationStrategies: STRATEGIES };
      const server = {
        getPublicationStrategy() { return STRATEGIES.NO_MERGE; }
      };
      expect(collector._resolveStrategyName(server, 'c')).to.equal('NO_MERGE');
    });

    it('identity-maps SERVER_MERGE and NO_MERGE_NO_HISTORY', function () {
      global.DDPServer = { publicationStrategies: STRATEGIES };
      const sm = { getPublicationStrategy() { return STRATEGIES.SERVER_MERGE; } };
      const nh = { getPublicationStrategy() { return STRATEGIES.NO_MERGE_NO_HISTORY; } };
      expect(collector._resolveStrategyName(sm, 'c')).to.equal('SERVER_MERGE');
      expect(collector._resolveStrategyName(nh, 'c')).to.equal('NO_MERGE_NO_HISTORY');
    });

    it('identity-maps NO_MERGE_MULTI', function () {
      global.DDPServer = { publicationStrategies: STRATEGIES };
      const server = { getPublicationStrategy() { return STRATEGIES.NO_MERGE_MULTI; } };
      expect(collector._resolveStrategyName(server, 'c')).to.equal('NO_MERGE_MULTI');
    });

    it('maps an unrecognized object -> "unknown"', function () {
      global.DDPServer = { publicationStrategies: STRATEGIES };
      const server = { getPublicationStrategy() { return { foo: true }; } };
      expect(collector._resolveStrategyName(server, 'c')).to.equal('unknown');
    });

    it('returns "unknown" when getPublicationStrategy throws', function () {
      const server = { getPublicationStrategy() { throw new Error('boom'); } };
      expect(collector._resolveStrategyName(server, 'c')).to.equal('unknown');
    });

    it('falls back to structural matching when DDPServer global is absent', function () {
      // No global.DDPServer -> structural fallback by shape.
      const server = { getPublicationStrategy() { return { ...STRATEGIES.NO_MERGE }; } };
      expect(collector._resolveStrategyName(server, 'c')).to.equal('NO_MERGE');
      // a dummy-document-view shape resolves structurally to NO_MERGE_MULTI
      const multi = { getPublicationStrategy() { return { ...STRATEGIES.NO_MERGE_MULTI }; } };
      expect(collector._resolveStrategyName(multi, 'c')).to.equal('NO_MERGE_MULTI');
    });
  });

  // ==========================================
  // _resolvePublicationName
  // ==========================================
  describe('_resolvePublicationName', function () {
    it("resolves 'N'+subId via session._namedSubs._name", function () {
      const session = makeSession('s', new Map(), new Map([['abc', { _name: 'myPub' }]]));
      expect(collector._resolvePublicationName(session, 'Nabc')).to.equal('myPub');
    });

    it("returns null for 'U' (universal) handles", function () {
      const session = makeSession('s', new Map(), new Map());
      expect(collector._resolvePublicationName(session, 'Uxyz')).to.be.null;
    });

    it('returns null when the named sub is not found', function () {
      const session = makeSession('s', new Map(), new Map());
      expect(collector._resolvePublicationName(session, 'Nmissing')).to.be.null;
    });
  });

  // ==========================================
  // DummyDocumentView (NO_MERGE_MULTI): docCount>0, bytesHeld~0
  // ==========================================
  describe('DummyDocumentView (empty dataByKey)', function () {
    it('counts the doc but holds ~0 bytes and maps strategy to NO_MERGE_MULTI', function () {
      // DummyDocumentView has existsIn but no dataByKey field values.
      const dummy = { existsIn: new Set(['Ux']) }; // no dataByKey
      const session = makeSession(
        's',
        new Map([['c', makeCollectionView({ d: dummy })]])
      );
      global.DDPServer = { publicationStrategies: STRATEGIES };
      Meteor.server = makeServer([session], { c: STRATEGIES.NO_MERGE_MULTI });

      collector._collect();

      const rows = emittedRows();
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].docCount).to.equal(1);
      expect(rows[0].bytesHeld).to.equal(0);
      expect(rows[0].strategy).to.equal('NO_MERGE_MULTI');
    });
  });

  // ==========================================
  // row shape + avgBytesPerConnection + window
  // ==========================================
  describe('row shape', function () {
    it('stamps window bounds, timestamp, host and avgBytesPerConnection', function () {
      const fields = { a: 'hello' };
      const session = makeSession(
        's',
        new Map([['c', makeCollectionView({ d: makeDocView(fields, ['Ux']) })]])
      );
      Meteor.server = makeServer([session], { c: STRATEGIES.SERVER_MERGE });

      collector._collect();
      const row = emittedRows()[0];

      expect(row.host).to.equal('test-host');
      expect(row.appVersion).to.equal('1.0.0');
      expect(row.timestamp).to.be.instanceOf(Date);
      expect(row.windowStart).to.be.instanceOf(Date);
      expect(row.windowEnd).to.be.instanceOf(Date);
      expect(row.connectionCount).to.equal(1);
      expect(row.avgBytesPerConnection).to.equal(row.bytesHeld);
      expect(row.fieldCount).to.equal(1);
    });
  });

  // ==========================================
  // buildHash
  // ==========================================
  describe('buildHash', function () {
    it('omits buildHash when not configured', function () {
      const session = makeSession(
        's',
        new Map([['c', makeCollectionView({ d: makeDocView({ a: 'x' }, ['Ux']) })]])
      );
      Meteor.server = makeServer([session]);
      collector._collect();
      expect(emittedRows()[0]).to.not.have.property('buildHash');
    });

    it('stamps buildHash on rows when configured', function () {
      const stub = sinon.stub();
      const c = new MergeboxCollector({
        client: { addMergeboxMetric: stub },
        host: 'h',
        buildHash: 'abc123'
      });
      const session = makeSession(
        's',
        new Map([['c', makeCollectionView({ d: makeDocView({ a: 'x' }, ['Ux']) })]])
      );
      Meteor.server = makeServer([session]);
      c._collect();
      const row = stub.getCalls().map(x => x.args[0])[0];
      expect(row.buildHash).to.equal('abc123');
    });
  });

  // ==========================================
  // maxRows cap
  // ==========================================
  describe('maxRows cap', function () {
    it('keeps only the top-N rows by bytesHeld', function () {
      const c = new MergeboxCollector({ client: mockClient, host: 'h', maxRows: 2 });

      // Three collections with distinct, increasing byte sizes -> 3 buckets.
      const collectionViews = new Map([
        ['small', makeCollectionView({ d: makeDocView({ a: 'x' }, ['Ux']) })],
        ['medium', makeCollectionView({ d: makeDocView({ a: 'xxxxxxxxxx' }, ['Ux']) })],
        ['large', makeCollectionView({ d: makeDocView({ a: 'x'.repeat(200) }, ['Ux']) })]
      ]);
      const session = makeSession('s', collectionViews);
      Meteor.server = makeServer([session], {
        small: STRATEGIES.SERVER_MERGE,
        medium: STRATEGIES.SERVER_MERGE,
        large: STRATEGIES.SERVER_MERGE
      });

      c._collect();
      const rows = emittedRows();
      expect(rows).to.have.lengthOf(2);
      const names = rows.map(r => r.collectionName);
      expect(names).to.include('large');
      expect(names).to.include('medium');
      expect(names).to.not.include('small');
    });
  });

  // ==========================================
  // maxDocsPerSession cap
  // ==========================================
  describe('maxDocsPerSession cap', function () {
    it('stops walking a session once the cap is reached (for...of break)', function () {
      const stub = sinon.stub();
      const c = new MergeboxCollector({
        client: { addMergeboxMetric: stub },
        host: 'h',
        maxDocsPerSession: 2
      });
      const docs = {};
      const namedSubs = new Map();
      for (let i = 0; i < 5; i++) {
        docs[`d${i}`] = makeDocView({ v: `value-${i}` }, [`Nsub${i}`]);
        namedSubs.set(`sub${i}`, { _name: `pub${i}` });
      }
      const session = makeSession('s', new Map([['c', makeCollectionView(docs)]]), namedSubs);
      Meteor.server = makeServer([session]);
      c._collect();
      const rows = stub.getCalls().map(x => x.args[0]);
      // cap = 2 -> only the first 2 docs walked -> 2 distinct-pub rows, not 5
      expect(rows).to.have.lengthOf(2);
    });
  });

  // ==========================================
  // start / stop
  // ==========================================
  describe('start / stop', function () {
    it('start sets interval; idempotent; stop clears it', function () {
      Meteor.server = makeServer([]);
      collector.start();
      expect(collector.intervalId).to.not.be.null;
      const id = collector.intervalId;
      collector.start();
      expect(collector.intervalId).to.equal(id);
      collector.stop();
      expect(collector.intervalId).to.be.null;
    });
  });
});
