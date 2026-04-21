const LEAK_LIFESPAN_MS = 10 * 60 * 1000;
const SLOW_INITIAL_QUERY_MS = 100;
const FETCH_BACKLOG_THRESHOLD = 50;
const ACTIVE_FETCHES_THRESHOLD = 5;

export function evaluateObserver(observer, context = {}) {
	const reasons = [];
	const windowMs = context.windowDurationMs || 60000;
	const now = Date.now();

	if (observer.observerType === "polling") {
		reasons.push("polling");
	}

	if (
		(observer.blockedWrites || 0) > 0 ||
		(observer.pendingPolls || 0) > 1 ||
		(observer.oplogPhase && observer.oplogPhase !== "STEADY")
	) {
		reasons.push("driver_distress");
	}

	if (observer.performance === "slow" || observer.performance === "inefficient") {
		reasons.push("slow_performance");
	}

	const lifespan = now - (observer.createdAt || now);
	if (lifespan > LEAK_LIFESPAN_MS && (observer.liveUpdateCount || 0) > 0) {
		reasons.push("leak_candidate");
	}

	if (
		(observer.fetchBacklog || 0) > FETCH_BACKLOG_THRESHOLD ||
		(observer.activeFetches || 0) > ACTIVE_FETCHES_THRESHOLD
	) {
		reasons.push("oplog_pressure");
	}

	const newlyCreated = lifespan < windowMs;
	if (observer.status === "stopped" || newlyCreated) {
		reasons.push("lifecycle_edge");
	}

	if ((observer.initialQueryMs || 0) > SLOW_INITIAL_QUERY_MS) {
		reasons.push("slow_initial_query");
	}

	return reasons;
}
