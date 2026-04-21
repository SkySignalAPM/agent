export function percentile(values, p) {
	if (!values || values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
	return sorted[idx];
}

export class AggregateBucket {
	constructor({ groupKey, identity = {} }) {
		this.groupKey = groupKey;
		this.identity = identity;
		this.observerCount = 0;
		this.handlersSharing = 0;
		this.newObservers = 0;
		this.stoppedObservers = 0;
		this.addedSum = 0;
		this.changedSum = 0;
		this.removedSum = 0;
		this.liveUpdatesSum = 0;
		this.documentCountSum = 0;
		this._initialQueryMsSamples = [];
		this._avgProcessingTimeSamples = [];
		this._documentCountSamples = [];
		this._observerCountSamples = [];
		this.fetchBacklogMax = 0;
		this.blockedWritesMax = 0;
		this.pendingPollsMax = 0;
		this.performanceBucketCounts = { optimal: 0, good: 0, slow: 0, inefficient: 0 };
	}

	addObserver(o, flags = {}) {
		this.observerCount += o.observerCount || 1;
		this.handlersSharing += o.handlersSharing || 0;
		this.addedSum += o.addedCount || 0;
		this.changedSum += o.changedCount || 0;
		this.removedSum += o.removedCount || 0;
		this.liveUpdatesSum += o.liveUpdateCount || 0;
		this.documentCountSum += o.documentCount || 0;

		if (o.initialQueryMs != null) this._initialQueryMsSamples.push(o.initialQueryMs);
		if (o.avgProcessingTime != null) this._avgProcessingTimeSamples.push(o.avgProcessingTime);
		if (o.documentCount != null) this._documentCountSamples.push(o.documentCount);

		this.fetchBacklogMax = Math.max(this.fetchBacklogMax, o.fetchBacklog || 0);
		this.blockedWritesMax = Math.max(this.blockedWritesMax, o.blockedWrites || 0);
		this.pendingPollsMax = Math.max(this.pendingPollsMax, o.pendingPolls || 0);

		const perfKey = o.performance || "optimal";
		if (this.performanceBucketCounts[perfKey] != null) {
			this.performanceBucketCounts[perfKey]++;
		}

		if (flags.isNew) this.newObservers++;
		if (flags.isStopped) this.stoppedObservers++;
	}

	toAggregateRow() {
		const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
		return {
			...this.identity,
			observerCount: this.observerCount,
			observerCountAvg: Math.round(avg(this._observerCountSamples) ?? this.observerCount),
			handlersSharing: this.handlersSharing,
			newObservers: this.newObservers,
			stoppedObservers: this.stoppedObservers,
			addedSum: this.addedSum,
			changedSum: this.changedSum,
			removedSum: this.removedSum,
			liveUpdatesSum: this.liveUpdatesSum,
			documentCountSum: this.documentCountSum,
			documentCountAvg: Math.round(avg(this._documentCountSamples) ?? 0),
			initialQueryMsP50: percentile(this._initialQueryMsSamples, 0.5),
			initialQueryMsP95: percentile(this._initialQueryMsSamples, 0.95),
			initialQueryMsMax: this._initialQueryMsSamples.length
				? Math.max(...this._initialQueryMsSamples)
				: null,
			avgProcessingTimeP50: percentile(this._avgProcessingTimeSamples, 0.5),
			avgProcessingTimeP95: percentile(this._avgProcessingTimeSamples, 0.95),
			fetchBacklogMax: this.fetchBacklogMax,
			blockedWritesMax: this.blockedWritesMax,
			pendingPollsMax: this.pendingPollsMax,
			performanceBucketCounts: { ...this.performanceBucketCounts }
		};
	}
}
