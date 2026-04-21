import { expect } from "chai";
import { evaluateObserver } from "../../../../../lib/collectors/aggregation/ObserverPromotion.js";

function obs(overrides) {
	return {
		observerType: "oplog",
		status: "active",
		blockedWrites: 0,
		pendingPolls: 0,
		oplogPhase: "STEADY",
		fetchBacklog: 0,
		activeFetches: 0,
		initialQueryMs: 20,
		liveUpdateCount: 0,
		createdAt: Date.now() - 60000,
		performance: "optimal",
		...overrides
	};
}

describe("ObserverPromotion", function () {
	it("returns [] for a healthy observer", function () {
		expect(evaluateObserver(obs({}))).to.deep.equal([]);
	});

	it("promotes polling observers unconditionally", function () {
		expect(evaluateObserver(obs({ observerType: "polling" }))).to.include("polling");
	});

	it("promotes driver distress", function () {
		expect(evaluateObserver(obs({ blockedWrites: 2 }))).to.include("driver_distress");
		expect(evaluateObserver(obs({ pendingPolls: 3 }))).to.include("driver_distress");
		expect(evaluateObserver(obs({ oplogPhase: "QUERYING" }))).to.include("driver_distress");
	});

	it("promotes slow/inefficient performance", function () {
		expect(evaluateObserver(obs({ performance: "slow" }))).to.include("slow_performance");
		expect(evaluateObserver(obs({ performance: "inefficient" }))).to.include("slow_performance");
	});

	it("promotes leak candidates (lifespan > 10min with updates)", function () {
		const over10 = Date.now() - 11 * 60 * 1000;
		expect(
			evaluateObserver(obs({ createdAt: over10, liveUpdateCount: 5 }))
		).to.include("leak_candidate");
	});

	it("does not promote long-lived observers with zero updates", function () {
		const over10 = Date.now() - 11 * 60 * 1000;
		expect(
			evaluateObserver(obs({ createdAt: over10, liveUpdateCount: 0 }))
		).to.deep.equal([]);
	});

	it("promotes oplog pressure", function () {
		expect(evaluateObserver(obs({ fetchBacklog: 60 }))).to.include("oplog_pressure");
		expect(evaluateObserver(obs({ activeFetches: 6 }))).to.include("oplog_pressure");
	});

	it("promotes lifecycle edges (new/stopped)", function () {
		expect(evaluateObserver(obs({ status: "stopped" }))).to.include("lifecycle_edge");
		const justCreated = Date.now() - 1000;
		expect(
			evaluateObserver(obs({ createdAt: justCreated }), { windowDurationMs: 60000 })
		).to.include("lifecycle_edge");
	});

	it("promotes slow initial query (>100ms)", function () {
		expect(evaluateObserver(obs({ initialQueryMs: 150 }))).to.include("slow_initial_query");
	});

	it("combines reasons when multiple criteria match", function () {
		const result = evaluateObserver(
			obs({
				observerType: "polling",
				performance: "inefficient"
			})
		);
		expect(result).to.include("polling");
		expect(result).to.include("slow_performance");
	});
});
