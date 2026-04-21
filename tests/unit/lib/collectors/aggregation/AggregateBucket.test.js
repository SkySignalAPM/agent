import { expect } from "chai";
import { AggregateBucket, percentile } from "../../../../../lib/collectors/aggregation/AggregateBucket.js";

describe("percentile", function () {
	it("computes p50 and p95 of small arrays", function () {
		expect(percentile([10, 20, 30, 40, 50], 0.5)).to.equal(30);
		expect(percentile([10, 20, 30, 40, 50], 0.95)).to.be.at.least(40);
	});

	it("returns null for empty array", function () {
		expect(percentile([], 0.5)).to.equal(null);
	});

	it("handles single element", function () {
		expect(percentile([42], 0.5)).to.equal(42);
	});
});

describe("AggregateBucket", function () {
	it("accumulates counts and sums", function () {
		const bucket = new AggregateBucket({ groupKey: "key1" });
		bucket.addObserver({
			observerCount: 1,
			liveUpdateCount: 5,
			addedCount: 2,
			changedCount: 3,
			removedCount: 0,
			documentCount: 10,
			initialQueryMs: 15,
			performance: "optimal"
		});
		bucket.addObserver({
			observerCount: 1,
			liveUpdateCount: 10,
			addedCount: 4,
			changedCount: 6,
			removedCount: 1,
			documentCount: 20,
			initialQueryMs: 40,
			performance: "good"
		});

		const row = bucket.toAggregateRow();
		expect(row.observerCount).to.equal(2);
		expect(row.addedSum).to.equal(6);
		expect(row.changedSum).to.equal(9);
		expect(row.removedSum).to.equal(1);
		expect(row.liveUpdatesSum).to.equal(15);
		expect(row.documentCountSum).to.equal(30);
		expect(row.performanceBucketCounts.optimal).to.equal(1);
		expect(row.performanceBucketCounts.good).to.equal(1);
	});

	it("computes percentiles for initialQueryMs", function () {
		const bucket = new AggregateBucket({ groupKey: "key1" });
		for (let i = 1; i <= 100; i++) {
			bucket.addObserver({
				observerCount: 1,
				liveUpdateCount: 0,
				addedCount: 0,
				changedCount: 0,
				removedCount: 0,
				documentCount: 0,
				initialQueryMs: i,
				performance: "optimal"
			});
		}
		const row = bucket.toAggregateRow();
		expect(row.initialQueryMsP50).to.be.closeTo(50, 1);
		expect(row.initialQueryMsP95).to.be.closeTo(95, 1);
		expect(row.initialQueryMsMax).to.equal(100);
	});

	it("tracks max of blockedWrites and fetchBacklog", function () {
		const bucket = new AggregateBucket({ groupKey: "key1" });
		bucket.addObserver({ observerCount: 1, blockedWrites: 0, fetchBacklog: 5, performance: "optimal" });
		bucket.addObserver({ observerCount: 1, blockedWrites: 3, fetchBacklog: 20, performance: "slow" });
		const row = bucket.toAggregateRow();
		expect(row.blockedWritesMax).to.equal(3);
		expect(row.fetchBacklogMax).to.equal(20);
	});
});
