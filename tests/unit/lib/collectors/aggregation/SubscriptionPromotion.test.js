import { expect } from "chai";
import { evaluateSubscription } from "../../../../../lib/collectors/aggregation/SubscriptionPromotion.js";

function sub(overrides) {
	return {
		status: "ready",
		previousStatus: "ready",
		responseTime: 30,
		subscribedAt: Date.now() - 60000,
		fullReportedForLifecycle: false,
		...overrides
	};
}

describe("SubscriptionPromotion", function () {
	it("returns [] for a healthy steady-state sub", function () {
		expect(evaluateSubscription(sub({}))).to.deep.equal([]);
	});

	it("promotes on any status transition", function () {
		expect(
			evaluateSubscription(sub({ status: "ready", previousStatus: "pending" }))
		).to.include("status_transition");
		expect(
			evaluateSubscription(sub({ status: "stopped", previousStatus: "ready" }))
		).to.include("status_transition");
		expect(
			evaluateSubscription(sub({ status: "error", previousStatus: "pending" }))
		).to.include("status_transition");
	});

	it("promotes slow ready (>500ms response time)", function () {
		expect(evaluateSubscription(sub({ responseTime: 600 }))).to.include("slow_ready");
	});

	it("always promotes errored subs", function () {
		expect(evaluateSubscription(sub({ status: "error" }))).to.include("errored");
	});

	it("promotes long-lived unreported subs", function () {
		const old = Date.now() - 35 * 60 * 1000;
		const result = evaluateSubscription(
			sub({
				subscribedAt: old,
				fullReportedForLifecycle: false
			})
		);
		expect(result).to.include("long_lived_unreported");
	});

	it("does not re-promote long-lived subs already reported", function () {
		const old = Date.now() - 35 * 60 * 1000;
		const result = evaluateSubscription(
			sub({
				subscribedAt: old,
				fullReportedForLifecycle: true
			})
		);
		expect(result).to.not.include("long_lived_unreported");
	});
});
