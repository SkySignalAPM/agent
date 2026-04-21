const SLOW_RESPONSE_MS = 500;
const LONG_LIVED_MS = 30 * 60 * 1000;

export function evaluateSubscription(subscription) {
	const reasons = [];

	if (subscription.previousStatus && subscription.previousStatus !== subscription.status) {
		reasons.push("status_transition");
	}

	if ((subscription.responseTime || 0) > SLOW_RESPONSE_MS) {
		reasons.push("slow_ready");
	}

	if (subscription.status === "error") {
		reasons.push("errored");
	}

	const lifespan = Date.now() - (subscription.subscribedAt || Date.now());
	if (lifespan > LONG_LIVED_MS && !subscription.fullReportedForLifecycle) {
		reasons.push("long_lived_unreported");
	}

	return reasons;
}
