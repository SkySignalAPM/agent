import { Meteor } from "meteor/meteor";
import { estimateObjectSize } from "../sizeEstimator.js";

/**
 * MergeboxCollector
 *
 * Measures Meteor's MERGEBOX RAM residency — the per-session, server-side cache
 * of published documents — and emits per-(publication, collection) rollups to
 * POST /api/v1/metrics/mergebox.
 *
 * WHERE THE BYTES LIVE (all ddp-server INTERNALS, source-verified against
 * ddp-server 3.x — packages/ddp-server/livedata_server.js + session_*_view.ts):
 *   - Meteor.server.sessions : Map(sessionId -> Session)
 *   - session.collectionViews : Map(collectionName -> SessionCollectionView)
 *   - SessionCollectionView.documents : Map(docId -> SessionDocumentView | DummyDocumentView)
 *   - SessionDocumentView.dataByKey : Map(field -> PrecedenceItem[])
 *       where PrecedenceItem = { subscriptionHandle, value }. The RESIDENT value
 *       is precedenceList[0].value (see SessionDocumentView.getFields()).
 *   - SessionDocumentView.existsIn : Set(subscriptionHandle) — the subs referencing
 *       this doc. SessionCollectionView.removed() deletes the doc once existsIn is
 *       empty, so a resident doc always has >= 1 handle (we still guard for 0).
 *
 * We DO NOT use Subscription._documents — that is Map(collectionName -> Set(docId)),
 * a refcount-only structure with NO field values. It is not the byte store.
 *
 * ATTRIBUTION — PURE EVEN-SPLIT (NO per-collection "truth row"):
 *   The shipped server MergeboxService $sums bytesHeld/docCount across ALL rows per
 *   collection with no discriminator (getByCollection / getStrategyBreakdown), so
 *   emitting a separate per-collection total alongside even-split rows would
 *   double-count. We emit ONLY even-split per-(publicationName, collectionName) rows.
 *   For a doc referenced by n handles, its bytes are divided across the handles via
 *   an INTEGER largest-remainder split (the first `docBytes % n` handles get +1
 *   byte) so the per-handle shares sum back to docBytes EXACTLY — no per-bucket
 *   rounding drift. docCount is a 1/n fractional estimate. Because the byte split
 *   sums to docBytes, the rows for a collection SUM BACK to its true residency
 *   (exactly sum-preserving). That property is the load-bearing correctness invariant.
 *
 * STRATEGY:
 *   Read via Meteor.server.getPublicationStrategy(collectionName) — an OBJECT
 *   { useCollectionView, doAccountingForCollection, useDummyDocumentView }, NOT a
 *   string. We reverse-map by identity against DDPServer.publicationStrategies to
 *   all four Meteor strategies (SERVER_MERGE / NO_MERGE / NO_MERGE_NO_HISTORY /
 *   NO_MERGE_MULTI). NO_MERGE / NO_MERGE_NO_HISTORY keep NO collectionView entry at
 *   all (residency ~0); that absence is the whole signal and is never synthesized.
 *   NO_MERGE_MULTI uses DummyDocumentView (empty dataByKey) — doc counts with ~0
 *   field bytes. Only a genuinely unrecognized strategy / any throw -> "unknown".
 *
 * READ-ONLY: this collector never wraps session.send / processMessage (DDPCollector
 * already chains those; double-wrapping risks the stack-overflow regression from
 * bug #7). It only reads in a low-cadence setInterval tick.
 */
export default class MergeboxCollector {
	constructor(options = {}) {
		this.client = options.client; // SkySignalClient instance
		this.host = options.host || "unknown-host";
		this.appVersion = options.appVersion || "unknown";
		this.buildHash = options.buildHash || null;
		this.interval = options.interval || 60000; // 60s default — low cadence

		// Per-session sampling. < 1.0 samples a fraction of sessions; every emitted
		// row carries sampleRate so the server can extrapolate.
		this.sampleRate = typeof options.sampleRate === "number" ? options.sampleRate : 1.0;

		// Bounds for a single synchronous tick (mirror LiveQueriesCollector's caps).
		this.maxSessions = options.maxSessions || 2000;
		this.maxDocsPerSession = options.maxDocsPerSession || 50000;

		// Server accepts up to 500 rows per POST; cap output (top-N by bytesHeld).
		this.maxRows = options.maxRows || 500;

		this.debug = options.debug || false;
		this.intervalId = null;
		this.windowStartTime = Date.now();
	}

	/** @private */
	_log(...args) {
		if (this.debug) {
			console.log("[SkySignal:Mergebox]", ...args);
		}
	}

	/** @private */
	_warn(...args) {
		console.warn("[SkySignal:Mergebox]", ...args);
	}

	start() {
		if (this.intervalId) {
			this._warn("Already started");
			return;
		}

		this.windowStartTime = Date.now();
		this.intervalId = setInterval(() => {
			try {
				this._collect();
			} catch (err) {
				// A single bad tick must never crash the host app.
				this._warn("Collect tick failed:", err.message);
			}
		}, this.interval);

		this._log(`Started (interval: ${this.interval}ms, sampleRate: ${this.sampleRate})`);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this._log("Stopped");
	}

	/**
	 * One snapshot tick: walk sampled sessions, attribute mergebox residency to
	 * (publicationName, collectionName) buckets via even-split, and POST one
	 * rollup payload for the window.
	 * @private
	 */
	_collect() {
		const server = Meteor.server;
		const sessions = server && server.sessions;

		// Feature-detect the residency store. Degrade to zero rows on shape
		// mismatch (older/newer Meteor) rather than throwing.
		if (!sessions || typeof sessions.forEach !== "function") {
			this._log("Meteor.server.sessions not a Map — skipping");
			return;
		}

		// buckets: key (publicationName || "" + "|" + collectionName) -> bucket
		const buckets = new Map();

		let sessionsWalked = 0;
		let sessionsSampledOut = 0;
		let sessionsSkipped = 0;

		for (const session of sessions.values()) {
			if (sessionsWalked >= this.maxSessions) {
				// Bound a single synchronous tick. Reflect the skipped work honestly.
				this._log(`maxSessions (${this.maxSessions}) reached — stopping walk`);
				break;
			}

			// Per-session sampling (NOT per-doc) so a doc's even-split stays intact
			// within a sampled session. Skipped sessions just lower the population.
			if (this.sampleRate < 1.0 && Math.random() > this.sampleRate) {
				sessionsSampledOut++;
				continue;
			}

			try {
				this._attributeSession(session, server, buckets);
				sessionsWalked++;
			} catch (err) {
				// One malformed session never aborts the whole snapshot.
				sessionsSkipped++;
				this._log("Skipped session due to error:", err.message);
			}
		}

		if (buckets.size === 0) {
			this._log(
				`No mergebox residency this tick (walked=${sessionsWalked}, ` +
				`sampledOut=${sessionsSampledOut}, skipped=${sessionsSkipped})`
			);
			this.windowStartTime = Date.now();
			return;
		}

		const windowEnd = Date.now();
		const windowStart = this.windowStartTime;
		const metrics = this._buildRows(buckets, windowStart, windowEnd);

		if (this.client && typeof this.client.addMergeboxMetric === "function" && metrics.length > 0) {
			for (const m of metrics) {
				this.client.addMergeboxMetric(m);
			}
			this._log(
				`Emitted ${metrics.length} mergebox rows ` +
				`(walked=${sessionsWalked}, sampledOut=${sessionsSampledOut}, skipped=${sessionsSkipped})`
			);
		}

		this.windowStartTime = windowEnd;
	}

	/**
	 * Walk one session's collectionViews and accumulate even-split contributions
	 * into the shared `buckets` map.
	 * @private
	 */
	_attributeSession(session, server, buckets) {
		// Feature-detect: session.collectionViews must be a Map-like.
		const collectionViews = session && session.collectionViews;
		if (!collectionViews || typeof collectionViews.forEach !== "function") {
			return; // older/newer Meteor or a session without a mergebox
		}

		let docsWalked = 0;

		// for...of (not Map#forEach) so the maxDocsPerSession cap can actually
		// `break` — a `return` inside forEach keeps iterating every remaining entry,
		// defeating the bound on large sessions/collections.
		for (const [collectionName, cview] of collectionViews) {
			if (docsWalked >= this.maxDocsPerSession) break; // stop scanning further collections
			const documents = cview && cview.documents;
			if (!documents || typeof documents.values !== "function") {
				continue; // shape mismatch — skip this collection view
			}

			const strategy = this._resolveStrategyName(server, collectionName);

			for (const docView of documents.values()) {
				if (docsWalked >= this.maxDocsPerSession) break; // tick bound reached
				docsWalked++;

				// DummyDocumentView (NO_MERGE_MULTI) has no dataByKey -> 0 bytes but
				// docCount > 0. SessionDocumentView has the real field values.
				const dataByKey = docView && docView.dataByKey;

				let docBytes = 0;
				let fieldCount = 0;
				if (dataByKey && typeof dataByKey.forEach === "function") {
					dataByKey.forEach((precedenceList, fieldName) => {
						// estimateObjectSize treats a Map/Set as a plain ~8-byte object,
						// so we MUST iterate dataByKey ourselves and size each value.
						if (!Array.isArray(precedenceList) || precedenceList.length === 0) {
							return; // guard empty/missing precedence arrays
						}
						const resident = precedenceList[0];
						if (!resident) return;
						fieldCount++;
						docBytes +=
							(typeof fieldName === "string" ? fieldName.length * 2 : 0) +
							estimateObjectSize(resident.value);
					});
				}

				// existsIn = Set(subscriptionHandle). The doc is referenced by these
				// subs; split docBytes across them.
				const existsIn = docView && docView.existsIn;
				const handles =
					existsIn && typeof existsIn.forEach === "function"
						? Array.from(existsIn)
						: [];
				const n = handles.length;
				if (n === 0) {
					// removed() deletes such docs; guard anyway against torn state.
					continue;
				}

				// Integer largest-remainder split of the (rounded) byte total: the
				// first `remBytes` handles get +1 byte so the per-handle shares sum
				// back to docBytes EXACTLY. Accumulating integers (no per-bucket
				// rounding drift) keeps per-collection residency exactly sum-preserving.
				const docBytesInt = Math.round(docBytes);
				const baseBytes = Math.floor(docBytesInt / n);
				const remBytes = docBytesInt - baseBytes * n;
				// docCount/fieldCount remain fractional even-split estimates (a shared
				// doc isn't a whole doc for any one pub); they're rounded at emit time.
				const docShare = 1 / n;
				const fieldShare = fieldCount / n;

				handles.forEach((handle, i) => {
					const publicationName = this._resolvePublicationName(session, handle);
					const bytesShare = baseBytes + (i < remBytes ? 1 : 0);
					this._addToBucket(buckets, {
						publicationName,
						collectionName,
						strategy,
						bytesShare,
						docShare,
						fieldShare,
						session
					});
				});
			}
		}
	}

	/**
	 * Accumulate an even-split contribution into the (publicationName, collectionName)
	 * bucket. Sessions are unioned into a Set for an honest distinct connectionCount.
	 * @private
	 */
	_addToBucket(buckets, contribution) {
		const {
			publicationName,
			collectionName,
			strategy,
			bytesShare,
			docShare,
			fieldShare,
			session
		} = contribution;

		// publicationName is null for auto-publish/universal subs. Use "" in the key.
		const key = `${publicationName || ""}|${collectionName}`;

		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = {
				publicationName: publicationName || null,
				collectionName,
				strategy,
				bytesHeld: 0,
				docCount: 0,
				fieldCount: 0,
				_sessions: new Set()
			};
			buckets.set(key, bucket);
		}

		bucket.bytesHeld += bytesShare;
		bucket.docCount += docShare;
		bucket.fieldCount += fieldShare;
		// connectionCount = distinct sessions (NEVER a list of ids — privacy + size).
		bucket._sessions.add(session);
	}

	/**
	 * Materialize bucket map -> emit rows. bytesHeld is already an exact integer
	 * sum (largest-remainder split); docCount/fieldCount fractional estimates are
	 * rounded here. Computes connectionCount + avgBytesPerConnection and caps to the
	 * top-N rows by bytesHeld (aligns with the server's 500/POST limit).
	 * @private
	 */
	_buildRows(buckets, windowStart, windowEnd) {
		const timestamp = new Date(windowEnd);
		const windowStartDate = new Date(windowStart);
		const windowEndDate = new Date(windowEnd);

		let rows = Array.from(buckets.values()).map((b) => {
			const bytesHeld = Math.round(b.bytesHeld);
			const connectionCount = b._sessions.size;
			const row = {
				host: this.host,
				appVersion: this.appVersion,
				timestamp,
				windowStart: windowStartDate,
				windowEnd: windowEndDate,
				collectionName: b.collectionName,
				strategy: b.strategy,
				bytesHeld,
				docCount: Math.round(b.docCount),
				fieldCount: Math.round(b.fieldCount),
				connectionCount,
				sampleRate: this.sampleRate
			};
			// Server strips null publicationName (auto-publish). Only emit when named.
			if (b.publicationName) {
				row.publicationName = b.publicationName;
			}
			// buildHash correlates residency to a specific deployed build (omitted
			// when the agent couldn't resolve one), mirroring other collectors.
			if (this.buildHash) {
				row.buildHash = this.buildHash;
			}
			if (connectionCount > 0) {
				row.avgBytesPerConnection = Math.round(bytesHeld / connectionCount);
			}
			return row;
		});

		// Cap output rows per tick (top-N by bytesHeld) to the server POST limit.
		if (rows.length > this.maxRows) {
			rows.sort((a, b) => b.bytesHeld - a.bytesHeld);
			rows = rows.slice(0, this.maxRows);
			this._log(`Capped output to top ${this.maxRows} rows by bytesHeld`);
		}

		return rows;
	}

	/**
	 * Resolve the schema's strategy enum for a collection by reverse-mapping the
	 * getPublicationStrategy() object against DDPServer.publicationStrategies by
	 * identity. Returns one of the four Meteor strategies — SERVER_MERGE |
	 * NO_MERGE | NO_MERGE_NO_HISTORY | NO_MERGE_MULTI — or "unknown" only when the
	 * strategy genuinely can't be read (no getPublicationStrategy, or any throw).
	 * @private
	 */
	_resolveStrategyName(server, collectionName) {
		try {
			if (typeof server.getPublicationStrategy !== "function") {
				return "unknown";
			}
			const strategyObj = server.getPublicationStrategy(collectionName);
			if (!strategyObj) return "unknown";

			// DDPServer is a Meteor package global; the constant table holds the
			// canonical strategy objects we compare against by identity.
			const table =
				typeof DDPServer !== "undefined" && DDPServer.publicationStrategies;
			if (!table) {
				// Fall back to a structural match if the global table isn't present.
				return this._structuralStrategyName(strategyObj);
			}

			// Identity reverse-map across all four Meteor publication strategies.
			if (strategyObj === table.SERVER_MERGE) return "SERVER_MERGE";
			if (strategyObj === table.NO_MERGE) return "NO_MERGE";
			if (strategyObj === table.NO_MERGE_NO_HISTORY) return "NO_MERGE_NO_HISTORY";
			if (strategyObj === table.NO_MERGE_MULTI) return "NO_MERGE_MULTI";
			// Only a genuinely unrecognized (e.g. future) strategy stays "unknown".
			return "unknown";
		} catch (_err) {
			return "unknown";
		}
	}

	/**
	 * Structural fallback when DDPServer.publicationStrategies isn't reachable.
	 * Maps the { useCollectionView, doAccountingForCollection, useDummyDocumentView }
	 * shape to the schema enum (all four Meteor strategies).
	 * @private
	 */
	_structuralStrategyName(s) {
		const cv = !!s.useCollectionView;
		const acct = !!s.doAccountingForCollection;
		const dummy = !!s.useDummyDocumentView;

		// SERVER_MERGE: collectionView + accounting + real document view
		if (cv && acct && !dummy) return "SERVER_MERGE";
		// NO_MERGE_MULTI: collectionView + accounting + DUMMY document view
		// (multi-publication safe, but stores no field values)
		if (cv && acct && dummy) return "NO_MERGE_MULTI";
		// NO_MERGE: no collectionView, but still accounts ids
		if (!cv && acct && !dummy) return "NO_MERGE";
		// NO_MERGE_NO_HISTORY: no collectionView, no accounting
		if (!cv && !acct && !dummy) return "NO_MERGE_NO_HISTORY";
		// Anything else (e.g. a future strategy shape) -> unknown
		return "unknown";
	}

	/**
	 * Resolve a subscriptionHandle to its publication name.
	 * Named subs: handle = 'N' + subscriptionId -> session._namedSubs.get(subId)._name.
	 * Universal / auto-publish: handle = 'U' + Random.id() -> null (no name; the row's
	 * publicationName is omitted so the server treats it as auto-publish).
	 * @private
	 */
	_resolvePublicationName(session, handle) {
		if (typeof handle !== "string" || handle.length === 0) return null;

		const kind = handle[0];
		if (kind === "U") {
			// Universal / auto-publish subscription — no publication name.
			return null;
		}
		if (kind === "N") {
			const subId = handle.slice(1);
			const namedSubs = session && session._namedSubs;
			if (namedSubs && typeof namedSubs.get === "function") {
				const sub = namedSubs.get(subId);
				if (sub && typeof sub._name === "string" && sub._name) {
					return sub._name;
				}
			}
			return null;
		}
		return null;
	}

	/**
	 * Lightweight stats for debugging.
	 */
	getStats() {
		return {
			interval: this.interval,
			sampleRate: this.sampleRate,
			maxSessions: this.maxSessions,
			maxDocsPerSession: this.maxDocsPerSession,
			maxRows: this.maxRows,
			running: this.intervalId !== null
		};
	}
}
