import { expect } from "chai";
import { AggregateBucket } from "../../lib/collectors/aggregation/AggregateBucket.js";
import { computeQuerySignature } from "../../lib/collectors/aggregation/QuerySignature.js";
import { evaluateObserver } from "../../lib/collectors/aggregation/ObserverPromotion.js";

function makeObserver(i, shape) {
	return {
		observerId: `obs-${i}`,
		collectionName: shape.coll,
		publicationName: shape.pub,
		observerType: shape.driver,
		host: shape.host,
		query: shape.query,
		queryLimit: 50,
		hasLimit: true,
		hasProjection: false,
		performance: "optimal",
		observerCount: 1,
		handlersSharing: 1,
		addedCount: 2,
		changedCount: 5,
		removedCount: 0,
		liveUpdateCount: 7,
		documentCount: 10,
		initialQueryMs: 20,
		createdAt: Date.now() - 5 * 60 * 1000,
		status: "active",
		fetchBacklog: 0,
		blockedWrites: 0,
		pendingPolls: 0
	};
}

describe("Aggregation load characteristics (regression guard)", function () {
	this.timeout(30000);

	it("produces <= 300 writes/window for 2000 observers across ~180 groupKeys", function () {
		// 10 pubs × 3 hosts × 2 drivers × 3 query shapes = 180 groupKeys max
		const shapes = [];
		for (let p = 0; p < 10; p++) {
			for (let h = 0; h < 3; h++) {
				for (const driver of ["oplog", "changeStream"]) {
					for (let q = 0; q < 3; q++) {
						shapes.push({
							pub: `pub${p}`,
							coll: `coll${p}`,
							host: `host${h}`,
							driver,
							query: { key: "<string>", q }
						});
					}
				}
			}
		}

		const observers = [];
		for (let i = 0; i < 2000; i++) {
			observers.push(makeObserver(i, shapes[i % shapes.length]));
		}

		const buckets = new Map();
		let interesting = 0;
		for (const obs of observers) {
			const sig = computeQuerySignature(obs.query, { limit: 50 });
			const key = `${obs.collectionName}|${obs.publicationName}|${obs.observerType}|${sig}|${obs.host}|false`;
			let bucket = buckets.get(key);
			if (!bucket) {
				bucket = new AggregateBucket({
					groupKey: key,
					identity: {
						collectionName: obs.collectionName,
						publicationName: obs.publicationName,
						observerType: obs.observerType,
						querySignature: sig,
						host: obs.host,
						isAutoPublish: false
					}
				});
				buckets.set(key, bucket);
			}
			bucket.addObserver(obs);
			if (evaluateObserver(obs).length > 0) interesting++;
		}

		const aggregateWrites = buckets.size;
		const entityWrites = interesting;
		const totalWrites = aggregateWrites + entityWrites;

		expect(aggregateWrites).to.be.at.most(180);
		expect(totalWrites).to.be.at.most(300);
		// vs. legacy: 2000 entities -> at least 6x reduction
		expect(totalWrites).to.be.at.most(2000 / 6);
	});
});
