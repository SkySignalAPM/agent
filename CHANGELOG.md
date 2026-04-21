
# Changelog

### v1.0.30 (Agent-Side Aggregation - Opt-In)

- **New `ingestAggregation` config flag** - When enabled (default: **false**), the agent rolls up per-observer and per-subscription telemetry into fixed-shape aggregates on the agent side and posts them to two new REST endpoints (`/api/v1/live-queries/aggregates` and `/api/v1/subscriptions/aggregates`) on an adaptive flush interval. For high-volume apps (thousands of observers / many subscriptions), this cuts server ingest row counts by 10-100× with no loss of dashboard-visible metrics. Opt-in because the platform's aggregation fallback path requires platform-side support for aggregate rollups and is only present in platform versions that ship with this feature.
  - Enable via `SkySignalAgent.configure({ ingestAggregation: true })` or `SKYSIGNAL_INGEST_AGGREGATION=true`.
  - Adaptive flush interval - The server responds with the current recommended flush interval and sample rate (per site, based on recent write volume). The agent honors the server's guidance on the next flush. Default flush interval is 60 seconds; high-volume sites can be pushed to 2-5 minutes automatically.
  - **Backwards compatible** - When left disabled, the agent continues posting per-observer and per-subscription records exactly as before. Platform versions older than the aggregation feature will simply return 404 on the aggregate endpoints and the agent falls back to entity ingest without losing data.
  - **Migration guidance** - New deployments on supported platform versions should set `ingestAggregation: true` as part of onboarding. Existing deployments can flip the flag during a low-traffic window; the server auto-detects aggregate vs. entity data and the dashboard's "Aggregated ingest" chip indicates which path is active.

### v1.0.29 (Host Config Fix)

- **Fix auto-start crash when `host` config is null** - The `host` configuration property was validated with `Match.Optional(String)`, which rejects `null` values. When no `host` is explicitly configured, the value is `null` and the agent infers it from `os.hostname()` at runtime. Changed validation to accept `null` so the agent auto-starts correctly without an explicit `host` setting.

### v1.0.28 (Environment Variable Configuration)

- **Environment variable fallback for all config options** - The agent can now be configured entirely via environment variables, with no `Meteor.settings` required. Set `SKYSIGNAL_API_KEY` and the agent auto-starts. Every server-side config option has a corresponding `SKYSIGNAL_*` env var (e.g., `SKYSIGNAL_DEBUG`, `SKYSIGNAL_TRACE_SAMPLE_RATE`, `SKYSIGNAL_COLLECT_TRACES`). Priority order: Meteor.settings (highest) > env vars > defaults. This is useful for Docker/CI deployments where injecting env vars is easier than mounting settings files.
- **Declarative env var registry** - New `lib/env.js` module with a declarative `ENV_MAP` array mapping 53 environment variables to config keys with automatic type coercion (string, boolean, integer, float, comma-separated arrays). Adding support for a new env var requires only one line in the map.
- **Robust boolean coercion** - Boolean env vars accept `true`/`1`/`yes` and `false`/`0`/`no` (case-insensitive). Unrecognized values are warned and skipped — the agent never crashes the host application due to a misconfigured env var.
- **Removed inline `SKYSIGNAL_ENDPOINT` from `DEFAULT_CONFIG`** - The existing `process.env.SKYSIGNAL_ENDPOINT || "..."` pattern in `DEFAULT_CONFIG` is replaced by the new env var layer. Backwards compatible — existing deployments using `SKYSIGNAL_ENDPOINT` continue to work identically.
- **`validateConfig` now validates the merged config** - `mergeConfig()` now merges all three layers (defaults, env, settings) before validation, allowing `apiKey` to come from any source. The `apiKey` requirement is enforced at `start()` time.

### v1.0.27 (Subscription Write Reduction)

- **Delta-based subscription reporting** - `DDPCollector._sendSubscriptionUpdates()` previously sent the entire subscription Map as a full snapshot every 30-second cycle. For apps with many stable `ready` subscriptions, this generated thousands of redundant updates per minute. The collector now computes a lightweight hash of each subscription's mutable fields (`status`, `documentsAdded`, `documentsChanged`, `documentsRemoved`, `dataTransferred`, `readyAt`, `stoppedAt`, `errorMessage`) and only includes subscriptions whose hash differs from the last reported value. A full snapshot is forced every 10 cycles (~5 minutes at the default 30s interval) so the server self-heals if a delta HTTP request is lost.

### v1.0.26 (Configurable Observer Limit)

- **Expose `liveQueriesMaxObservers` as a public configuration option** - The `LiveQueriesCollector` max observer limit (default: 5000) was hardcoded and not wired through the public config system. High-traffic applications could hit the limit during peak traffic, causing frequent eviction warnings. Users can now configure this via `SkySignalAgent.configure({ liveQueriesMaxObservers: 15000 })` or Meteor settings. Minimum value is 500 to prevent eviction loops.

### v1.0.25 (Stack Overflow Root Cause Fix)

- **Fix shared `protocol_handlers` wrapper chain buildup (ROOT CAUSE)** - In Meteor, `session.protocol_handlers` is a shared object on the Session prototype — all DDP sessions reference the same object. `_hijackMethodHandler` and `_hijackSubHandler` captured `session.protocol_handlers.method` and replaced it with a wrapper, but because the object is shared, each new session's wrap captured the PREVIOUS session's wrapper, building an N-deep call chain. After ~200 concurrent connections, calling `protocol_handlers.method` would recurse through hundreds of chained wrappers and overflow V8's stack. The fix adds a `_skySignalDDPQueueWrapped` flag on the wrapper function itself, ensuring the handler is wrapped exactly once globally regardless of how many sessions connect. (fixes [#7](https://github.com/SkySignalAPM/agent/issues/7))
- **Auto-disable DDPQueueCollector when another APM agent is detected** - When `montiapm:agent` or `mdg:meteor-apm-agent` is installed alongside `skysignal:agent`, `DDPQueueCollector.start()` now automatically disables itself instead of merely logging a warning. Both agents wrap the same DDP session internals, and the compounded wrapper depth compounds the stack overflow risk. Users can force-enable via `{ forceEnable: true }` if they accept the risk.
- **Skip MethodTracer unblock wrapping when another APM agent is detected** - `MethodTracer._wrapMethod()` now skips wrapping `methodInvocation.unblock` when a conflicting APM agent is present. Both agents wrapping unblock adds ~3-5 extra frames per method call. Unblock timing analysis is unavailable in this mode; all other MethodTracer features remain fully functional.
- **New tests: shared prototype regression** - Added tests simulating 50 sessions sharing the same `protocol_handlers` object, verifying the handler is wrapped exactly once and does not build a deep chain.

### v1.0.24 (DDP Queue Stack Overflow Fix)

- **Fix secondary stack overflow in `wrapUnblock`** - When `_recordBlockingTime()` threw an error with a very deep stack trace (e.g. from mutual-recursion across wrapper layers), `console.error(error)` triggered `source-map-support`'s `prepareStackTrace` which re-overflowed, causing a secondary `RangeError`. All `console.error` calls in `DDPQueueCollector` now use `String(error)` to serialize the error message without triggering stack trace reprocessing. See [#12](https://github.com/SkySignalAPM/agent/pull/12).
- **Move `originalUnblock()` call into `finally` block** - The cleanup logic (`delete self.currentProcessing[session.id]` and `originalUnblock()`) was previously in the `try` block after the metrics recording. If `console.error` itself failed in the `catch` block, these cleanup steps were skipped, permanently stalling the DDP queue for that session. Both are now in a `finally` block to guarantee execution regardless of error handling failures.
- **New test: deep-stack error handling** - Added unit test verifying that `wrapUnblock` correctly invokes the original unblock function even when the metrics callback throws an error with a deeply nested stack trace.
- **Fix root cause: async `originalUnblock()` via `queueMicrotask`** - The primary stack overflow ([#7](https://github.com/SkySignalAPM/agent/issues/7)) was caused by `originalUnblock()` being called synchronously in the `finally` block. When another APM agent (e.g. `montiapm:agent`) also wraps the DDP session's unblock function, the synchronous call chain creates infinite recursion. `originalUnblock()` is now called via `queueMicrotask()` to break the synchronous chain. This is safe because Meteor's own `runHandlers()` independently calls its native unblock after the protocol handler returns — our call is purely for instrumentation.
- **Conflicting APM agent detection** - On startup, `DDPQueueCollector` now checks for `montiapm:agent` and `mdg:meteor-apm-agent` and logs a warning if detected. Running multiple APM agents that wrap DDP internals simultaneously is not recommended.
- **New test: synchronous recursion prevention** - Added cross-collector test simulating 200 chained unblock calls from another APM agent, verifying that `queueMicrotask` breaks the recursion without stack overflow.

### v1.0.23 (BullMQ Support & Job Package Tracking)

- **BullMQ queue monitoring** - The agent now supports [BullMQ](https://docs.bullmq.io/) as a second job queue backend alongside `msavin:sjobs`. `BullMQMonitor` discovers queues automatically by scanning Redis for `bull:*:meta` key patterns and attaches `QueueEvents` listeners for real-time job lifecycle tracking (active, completed, failed, stalled, progress). Supports manual queue configuration via `bullmqQueues` for non-standard Redis key prefixes. Includes an LRU job detail cache (`jobCacheMaxSize: 2000`, `jobCacheTTL: 120000`) to fetch full job data on failure without hitting Redis on every event.
- **Trace correlation for BullMQ** - Wraps `Queue.add()` and `Queue.addBulk()` to inject `__skysignal_traceId` into job data, linking each BullMQ job back to the originating Meteor Method trace. On job completion/failure, the trace ID is extracted from the job payload and attached to the job record, enabling end-to-end visibility from Method call through queue execution.
- **Multi-package auto-detection** - The `JobCollector` factory now checks for both `msavin:sjobs` and `bullmq` at startup. If both packages are installed, the agent monitors both simultaneously and tags each job with its originating package. Use `jobsPackage` in settings to force a specific package if needed.
- **`jobsPackage` field in job event payloads** - `BaseJobMonitor._sendJobEvent()` now injects `jobsPackage: this.getPackageName()` into every outbound job event. This is the single choke point for all job data, so both `SteveJobsMonitor` and `BullMQMonitor` events are tagged automatically without subclass changes.
- **Platform: `jobsPackage` schema field and index** - Added `jobsPackage` (optional String) to the `BackgroundJobs` collection schema and a new compound index `{ customerId, siteId, jobsPackage, queuedAt }` for efficient package-filtered queries.
- **Platform: Package-aware query methods** - All job query service methods (`getMetrics`, `getQueueStats`, `queryJobs`, `getJobTypePerformance`, `getLatencyDistribution`, `getFailureRateTrend`) now accept an optional `jobsPackage` filter parameter. Added `getJobsPackages()` to return distinct packages for a site.
- **Platform: Jobs tab package filter** - When a site has jobs from multiple packages, the Jobs tab shows a package filter dropdown (Autocomplete) alongside the existing queue filter. All sub-tabs (Running, Failed, Scheduled, Recent Jobs, Performance, Analytics) respect the selected package filter. Job rows display a small package Chip next to the job type when multiple packages are present.
- **BullMQ configuration options** - `bullmqRedis` (connection object), `bullmqQueues` (manual queue list), `detailedTracking` (fetch full job details on failure), `jobCacheMaxSize`, and `jobCacheTTL`. See documentation for full reference.
- **Backward compatible** - `jobsPackage` is optional in the schema and defaults to `null`. Pre-1.0.23 agents continue to work; the UI hides the package filter when only one (or zero) packages are present.

### v1.0.22 (Graceful Shutdown & Stale Job Fixes)

- **Graceful shutdown on SIGTERM/SIGINT** - The agent now registers `process.once("SIGTERM")` and `process.once("SIGINT")` handlers during auto-start. When the host app shuts down (e.g., new deployment on Galaxy), the agent stops all collectors, flushes all pending telemetry batches, and logs a shutdown message. Previously, deploys killed the agent mid-flight and all buffered data was silently dropped.
- **Fix `client.stop()` dropping final flush** - `SkySignalClient.stop()` previously set `this.stopped = true` before calling `this.flush()`, causing `_sendBatch()` to check the flag and silently discard every pending batch. The flag is now set after the final flush so all buffered data is actually sent.
- **Fix `agent.stop()` not fully cleaning up** - `agent.stop()` previously called `client.flush()` (fire-and-forget, no timer cleanup) instead of `client.stop()` (clears auto-flush timer, clears retry timers, performs final flush, then sets stopped flag). Timers and retries now properly stop on shutdown.
- **Fix `_sendBatch` inner stopped check blocking final flush** - Removed redundant `this.stopped` guard inside the `setImmediate` callback in `_sendBatch()`. The outer guard before `setImmediate` is sufficient, and the inner check was racing with `stop()` to block final-flush HTTP requests that had already been dispatched.
- **Fix Steve Jobs observer race condition (Meteor 3.x)** - `SteveJobsMonitor.setupHooks()` now `await`s `cursor.observe()`, which returns a Promise in Meteor 3.x. Previously the observer was set up asynchronously while `_scanExistingJobs()` ran synchronously, creating a window where jobs could complete before the observer was ready. Completion events in that window were missed, leaving jobs permanently stuck as "running" on the server.
- **Fix orphaned scheduled/replicated jobs** - `_handleJobRemoved()` now handles docs removed with `state: "pending"` by emitting start + complete events. Steve Jobs calls `instance.remove()` without setting state to "success", so replicated jobs that were only tracked as "pending" previously had no completion event and stayed orphaned on the server forever.
- **Remove redundant `_scanExistingJobs()`** - The awaited observer's initial `added` callbacks already cover all existing documents, making the separate synchronous scan both redundant and racy.
- **Fix observer cleanup** - `cleanupHooks()` is now async and checks for `.stop()` on the resolved observer handle, instead of calling `.stop()` on the unresolved Promise that was stored before this fix.

### v1.0.21 (Nested Cgroup Fix & Uptime Metric)

- **Fix container metrics on Galaxy and nested cgroup hierarchies** - The cgroup detection in v1.0.18/v1.0.20 hardcoded root paths (`/sys/fs/cgroup/memory.max`, `/sys/fs/cgroup/cpu.max`). On Galaxy and other platforms that use nested cgroup hierarchies (e.g., `/sys/fs/cgroup/kubepods.slice/kubepods-pod123.slice/...`), the root files return the parent slice limit (often 512 MB or unlimited) instead of the per-container limit (e.g., 2 GB on Galaxy "Double" plan). This caused SkySignal to report 512 MB / 92% (Critical) when the real container had 2 GB at ~23% usage. Added `_getCgroupBase()` which parses `/proc/self/cgroup` to resolve the actual cgroup path for the current process, handling both cgroup v2 (`0::/` lines) and cgroup v1 (`:memory:` controller lines). All four cgroup detection methods (`_detectMemoryLimit`, `_detectCpuQuota`, `_getContainerMemoryUsage`, `_detectCgroupMemUsagePath`) now try the resolved nested path first, then fall back to root paths for simple container setups. This is the same technique used by cAdvisor, Kubernetes metrics-server, and Galaxy's own dashboard.
- **New `uptime` metric field** - Now collects `process.uptime()` (seconds since the Node.js process started) each collection cycle. Previously the System tab showed "Uptime: 0m" because this field was never sent by the agent.
- **`process.constrainedMemory()` safety check** - Added `limit < Number.MAX_SAFE_INTEGER` guard to the Node 19+ `constrainedMemory()` strategy, preventing false positives when the function returns a sentinel value indicating no cgroup limit.

### v1.0.20 (Publication Context & Observer Leak Detection & Container-Aware Metrics)

- **Container memory detection** - When the agent runs inside a Docker container (e.g., Meteor Galaxy), `os.totalmem()` / `os.freemem()` report host machine values, not container limits. The agent now detects cgroup memory limits via a 3-strategy fallback: `process.constrainedMemory()` (Node 19+), cgroup v2 (`/sys/fs/cgroup/memory.max`), cgroup v1 (`/sys/fs/cgroup/memory/memory.limit_in_bytes`). When a limit is found, `memoryTotal`, `memoryUsed`, `memoryFree`, and `memoryUsage` report container-level values instead of host-level values.
- **Container CPU quota detection** - Reads CPU quota from cgroup v2 (`/sys/fs/cgroup/cpu.max`) or cgroup v1 (`cpu.cfs_quota_us / cpu.cfs_period_us`). When a quota is set, `cpuCores` reports the effective container CPU count (e.g., 2.0 for a 200% quota) and process-level CPU % normalizes against the container quota, not host cores.
- **Container memory usage per-cycle** - Reads current memory usage each collection cycle via `process.availableMemory()` (Node 19+), cgroup v2 (`memory.current`), or cgroup v1 (`memory.usage_in_bytes`), with a `heapUsed` fallback.
- **New metric fields** - `isContainerized` (Boolean) indicates container detection; `hostMemoryTotal` (Number) preserves the original `os.totalmem()` value for diagnostics when containerized.
- **Non-containerized environments unchanged** - All metrics remain identical when no cgroup limits are detected (local dev, bare-metal servers).
- **Publication context propagation via AsyncLocalStorage** - `PublicationTracer` now wraps `Meteor.publish` handlers in `AsyncLocalStorage.run()`, setting `publicationName`, `connectionId`, and `isAutoPublish` in the async context. `LiveQueriesCollector` reads this context in its `_observeChanges` wrapper via `publicationContextStore.getStore()` (O(1)), so every observer created inside a publication handler now carries the publication name and DDP connection ID that owns it. This enables the platform's enhanced leak detection to distinguish auto-publish observers from real subscription leaks.
- **Auto-publish detection** - Unnamed/null publications (auto-publish patterns) are wrapped with `isAutoPublish: true` context. Observers created by these publications are tagged accordingly, allowing the platform to apply 3x longer thresholds (72h vs 24h) before flagging them as leaked.
- **New observer payload fields** - `isAutoPublish` (Boolean) and `connectionId` (String) are now included in every observer record sent to the platform. Both fields are backward-compatible (default `false`/`null` for pre-1.0.20 agents).

### v1.0.19 (Bug Fixes & Code Quality)

- **Fix LiveQueriesCollector showing 0 observers and 0 metrics** - Completely rewrote observer interception. The previous approach wrapped `Mongo.Collection.prototype.find` to patch `cursor.observe`/`cursor.observeChanges` on each returned cursor instance, but this failed because: (1) in Meteor 3.x, `observeChanges` is async (returns a Promise via `MongoConnection._observeChanges`) but the wrapper treated it synchronously; (2) the per-cursor instance patching was fragile. Now hooks directly into `MongoInternals.Connection.prototype._observeChanges` — the single async bottleneck ALL server-side observers funnel through. Uses a two-phase tracking approach: `_createObserverData()` creates a provisional observer record BEFORE calling the original `_observeChanges`, so that wrapped `added`/`changed`/`removed` callbacks can count initial documents arriving during the await. `_finalizeObserver()` then links the handle's multiplexer and driver type after the await. Deduplicates by multiplexer identity (not query hash) so observers sharing a Meteor ObserveMultiplexer are counted as one server-side resource with multiple handlers. Falls back to `Collection.prototype.find` wrapping when `MongoInternals` is unavailable.
- **Fix LiveQueriesCollector config missing from DEFAULT_CONFIG** - `collectLiveQueries`, `liveQueriesInterval`, and `liveQueriesPerformanceThresholds` were defined in the `SkySignalAgent` constructor but missing from `config.js` `DEFAULT_CONFIG`. Since `mergeConfig()` spreads `DEFAULT_CONFIG` first, these values were always overwritten to `undefined`, silently disabling live query collection.
- **Fix container memory usage reporting >100%** - `SystemMetricsCollector` previously calculated container memory as `processMemory.rss / constrainedMemory * 100`, which could exceed 100% because RSS (Resident Set Size) includes shared library pages, memory-mapped files, and kernel page cache that don't count against the container's cgroup memory limit. Now uses `process.availableMemory()` (Node 19+), which reads directly from the cgroup memory controller and accounts for reclaimable buffers, to compute usage as `(constrainedMemory - availableMemory) / constrainedMemory * 100`. Falls back to `heapUsed / constrainedMemory * 100` on older Node versions. This aligns reported memory with what container orchestrators (e.g., Meteor Galaxy) actually report.
- **Fix observer stop logging crash** - `LiveQueriesCollector._wrapHandle()` used `this._log()` inside a regular `function()` callback where `this` referred to the handle object, not the collector instance. Changed to `self._log()` to use the captured closure variable. Previously, calling `handle.stop()` would throw `TypeError: this._log is not a function`, silently preventing observer lifecycle metrics from being recorded.
- **Fix P95 percentile off-by-one** - `MongoPoolCollector`, `DnsTimingCollector`, and `DiagnosticsChannelCollector` all used `Math.floor(count * 0.95)` to index into a sorted array, which overshoots the true 95th percentile by one position (e.g., for 100 items, returns the 96th element instead of the 95th). Changed to `Math.ceil(count * p) - 1` across all three collectors. Extracted to shared `percentile()` utility in `lib/utils/percentile.js`.
- **Fix MongoPoolCollector.stop() killing other event listeners** - `stop()` called `client.removeAllListeners(eventName)` for each pool event, which removed ALL listeners for that event — including those registered by the application or other collectors. Now stores individual handler references in `start()` and calls `client.removeListener(eventName, handler)` in `stop()` to remove only the collector's own handlers.
- **Fix circular buffer read after wrap-around** - `MongoPoolCollector._calculateCheckoutMetrics()` used `checkoutSamples.slice(0, count)` to extract samples, which returns incorrect data after the circular buffer wraps (old data mixed with new). Now correctly reads from the current write index forward using modular arithmetic to reconstruct the proper time-ordered sequence.
- **Shared percentile utility** - Extracted percentile calculation to `lib/utils/percentile.js` with `percentile(sorted, p)` and `percentiles(values)` functions, replacing duplicated math in `MongoPoolCollector`, `DnsTimingCollector`, and `DiagnosticsChannelCollector`.
- **Shared buffer eviction utility** - Extracted array trimming to `lib/utils/buffer.js` with `trimToMaxSize(array, maxSize)`, replacing duplicated `splice(0, length - max)` patterns in `DnsTimingCollector`, `DiagnosticsChannelCollector`, and `MongoPoolCollector._recordPoolWaitTime`.
- **Leak-detection field tests** - Added 19 unit tests (`LiveQueriesCollector.leakFields.test.js`) verifying the collector produces correct values for fields used by the server-side `ObserverLeakDetectionService`: `_wrapCallbacks` correctly increments `liveUpdateCount` and `lastActivityAt` only after initial load completes (not during the initial document fetch), `_wrapHandle` calculates `observerLifespan` in seconds on stop, and `_createObserverData` initializes all leak-relevant fields to safe defaults. These tests ensure the agent emits the data contract that leak detection heuristics (inactive observers, long-lived stale observers, orphaned observers) depend on.
- **Remove stale `_generateQuerySignature` tests** - Deleted 5 tests for `_generateQuerySignature` in `LiveQueriesCollector.test.js` that were left behind when the method was removed during the v1.0.19 observer interception rewrite. These tests were failing with `TypeError: collector._generateQuerySignature is not a function`.

### v1.0.18 (Container-Aware Metrics)

- **Container-aware memory usage** - `SystemMetricsCollector` now uses `process.constrainedMemory()` (Node 19+) to detect cgroup memory limits in containerized deployments. When a cgroup limit is present, memory usage is calculated as `processMemory.rss / constrainedMemory * 100` instead of `(os.totalmem() - os.freemem()) / os.totalmem() * 100`. The OS-level calculation counts kernel buffer/cache as "used", which dramatically overstates actual memory pressure in containers (e.g., reporting 89% when real RSS usage is 27%).
- **Process-level CPU measurement** - Replaced OS-level idle-time CPU calculation with `process.cpuUsage()` delta tracking. The previous approach measured total system CPU across all processes, which is misleading for a single Node.js application in a shared or containerized environment. Now tracks user + system CPU microseconds between collection intervals, divided by available parallelism, to report the actual CPU consumed by the monitored Meteor process.

### v1.0.17 (Bug Fixes, Performance & Testing)

- **DDP queue unblock recursion fix** - Restructured `DDPQueueCollector.wrapUnblock()` to eliminate a remaining infinite recursion path. The catch block previously retried calling `originalUnblock()` after a failure, but `originalUnblock` can itself be a wrapper from another layer (e.g., `MethodTracer`). If that wrapper threw, the retry would re-enter it, creating unbounded mutual recursion and `RangeError: Maximum call stack size exceeded`. The fix sets the `unblocked` guard immediately on entry, isolates metrics collection in its own try/catch so failures are non-fatal, and calls `originalUnblock()` exactly once with no retry. (fixes [#7](https://github.com/SkySignalAPM/agent/issues/7))
- **Console error object serialization** - `ErrorTracker` now properly serializes object arguments passed to `console.error()` using `JSON.stringify` instead of `String()`. Previously, `console.error('test', {a:1, b:2})` would be captured as `"test [object Object]"` — it now correctly captures `"test {"a":1,"b":2}"`. The same fix applies to `UnhandledRejection` events where the rejection reason is a plain object rather than an Error instance. Serialization is depth-limited (5 levels) and size-capped (5KB) to prevent oversized payloads from deeply nested objects. Circular references are detected and replaced with `"[Circular]"`. (fixes [#10](https://github.com/SkySignalAPM/agent/issues/10))
- **Use `os.availableParallelism()` for CPU count** - Replaced `os.cpus().length` with `os.availableParallelism()` in `SystemMetricsCollector` and `EnvironmentCollector`. The Node.js docs advise against using `os.cpus().length` to determine available parallelism, as it can return an empty array on some systems. `os.availableParallelism()` (Node 18.14+) is the recommended API for this purpose.
- **Replace sync FS calls with async** - Converted all `readFileSync`, `readdirSync`, and `existsSync` calls to their async equivalents (`fs/promises`) in `SystemMetricsCollector`, `EnvironmentCollector`, and `VulnerabilityCollector`. These ran in background collectors on periodic intervals but still blocked the event loop unnecessarily. Now uses `fs.readFile`, `fs.readdir`, `fs.access` to avoid blocking the host application's event loop.
- **Guard SkySignalClient console output behind `debug` flag** - All `console.error` and `console.warn` calls in `SkySignalClient` (serialization failures, network errors, timeouts, retry queue overflow, dropped batches) are now gated behind a `debug` option. Previously these logged unconditionally, which could be noisy in production. The abort-error log (fix #4) was already guarded; this change applies the same pattern to all 11 remaining log sites.
- **Fix MethodTracer result truncation** - `MethodTracer` attempted to `JSON.parse()` a truncated JSON string when serializing large method results (>500 chars). Slicing a JSON string mid-token always produces invalid JSON, so the parse always threw and the result was silently replaced with `'<unable to serialize>'`. Now stores the truncated string directly instead of attempting to round-trip it through `JSON.parse`.
- **Fix VulnerabilityCollector timer leak on early stop** - `VulnerabilityCollector.start()` used a 60-second `setTimeout` for the initial collect delay but did not store the timer ID. If `stop()` was called within the first 60 seconds, the delayed collect would still fire. Now stores the timer ID in `_delayTimerId` and clears it in `stop()`.
- **Eliminate JSON.parse/stringify from DDP hot path** - `DDPCollector` previously called `JSON.parse()` on every outgoing DDP message (just to read the `msg` field) and `JSON.stringify()` on every incoming and outgoing message (just for byte-size estimation). On a busy app with 100+ subscriptions pushing frequent updates, this added thousands of serialize/deserialize cycles per second. Replaced with `extractMsgType()` (substring extraction) for message type detection and `estimateMsgSize()` (shallow key walk) for size estimation. JSON.parse is now only used for the small subset of messages that require structured data (subscription lifecycle events).
- **Replace `new Date()` with `Date.now()` in all hot paths** - `DDPCollector`, `LiveQueriesCollector`, and `MethodTracer` created `new Date()` objects in per-message and per-observer-callback paths. Each allocation adds GC pressure. Replaced with `Date.now()` (returns a number with zero heap allocation) across all subscription tracking, observer callback wrappers, and method context creation. Timestamps are converted to Date objects only at serialization time.
- **Reduce MethodTracer per-method allocation overhead** - Every method invocation allocated a `new Map()` for query fingerprints, empty arrays for operations and slow queries, and generated a trace ID via `Math.random().toString(36)`. Changed to: counter-based trace IDs (no string conversion), lazy-initialized Map and arrays (only allocated when the method actually performs database operations). Methods that don't touch the database (pure computation, DDP calls) now allocate significantly less.
- **Optimize SkySignalClient flush path** - `_safeStringify` now tries fast `JSON.stringify()` first (no WeakSet, no replacer function overhead) and only falls back to circular-reference-safe serialization if the fast path throws. Hoisted `_getEndpointForBatchType` and `_getPayloadKey` lookup tables to module-level constants (avoids creating new object literals on every batch send). Replaced `[...batch]` spread copy with reference swap in `_sendBatch`.
- **Fix buffer eviction patterns** - `DnsTimingCollector` and `DiagnosticsChannelCollector` used `Array.slice(-max)` to evict old samples, which allocated a new array on every eviction. Replaced with in-place `splice()`. `MongoPoolCollector._recordPoolWaitTime` used `Array.shift()` (O(n) at 1000 elements) on every new sample; replaced with batch eviction via `splice()` that triggers less frequently. `DDPQueueCollector` used `Object.keys().length` to check cache size on every insert; replaced with an O(1) counter.
- **963 unit tests with GitHub Actions CI** - Added a comprehensive standalone test suite (Mocha + Chai + Sinon) covering all collectors, client modules, and library utilities. Includes regression tests for bugs #7 and #10. Tests run via `npm test` without requiring a Meteor environment. Added GitHub Actions workflow (`.github/workflows/test.yml`) to run tests on push/PR against Node.js 20 and 22.

### v1.0.16 (Bug Fixes)

- **DDP queue infinite recursion fix** - Removed `finally` block in `DDPQueueCollector._hijackMethodHandler` that unconditionally called `unblock()` after every method invocation. When sessions were wrapped more than once (e.g., agent stop/restart during hot reload), the stacked `finally` blocks triggered cross-layer recursion through the original `unblock` reference, causing `RangeError: Maximum call stack size exceeded`. Added a `_skySignalDDPQueueWrapped` sentinel to prevent double-wrapping sessions entirely. (fixes [#5](https://github.com/SkySignalAPM/agent/issues/5))
- **Stale keepAlive socket fix** - Added `freeSocketTimeout: 15000` to both HTTP and HTTPS agents used by `SkySignalClient`. Previously, idle keepAlive sockets could sit in the pool indefinitely; when the server closed its end, the next request reusing the stale socket would get an `AbortError`. The `subscriptions` batch type was disproportionately affected due to its longer flush cadence. Abort errors are now downgraded to debug-only `console.warn` since the retry logic already handles them transparently. (fixes [#4](https://github.com/SkySignalAPM/agent/issues/4))
- **Screenshot capture import fix** - `ScreenshotCapture` now imports `html2canvas` as an ES module instead of checking for a global variable. Since `html2canvas` is already declared in `Npm.depends()` in `package.js`, Meteor bundles it automatically — host applications no longer need to install it as a separate dependency. (fixes [#3](https://github.com/SkySignalAPM/agent/issues/3))

### v1.0.15 (New Features)

**7 new collectors**, enhanced system metrics, COLLSCAN detection, sendBeacon transport, and worker thread offloading.

#### New Collectors
- **DNS Timing** (`DnsTimingCollector`) - Wraps `dns.lookup` and `dns.resolve` to measure DNS resolution latency. Tracks per-hostname timing, P95/max latency, and failure counts. Identifies slow resolvers in Docker/K8s environments.
- **Outbound HTTP** (`DiagnosticsChannelCollector`) - Uses Node.js `diagnostics_channel` API (Node 16+) to instrument outbound HTTP/HTTPS requests without monkey-patching. Captures timing breakdown (DNS, connect, TLS, TTFB), status codes, and error rates for external dependencies.
- **CPU Profiling** (`CpuProfiler`) - On-demand CPU profiling via the built-in `inspector` module. Automatically triggers when CPU exceeds a configurable threshold (default: 80%), captures a 10-second profile, and sends a summary of top functions by self-time. Configurable cooldown prevents over-profiling.
- **Deprecated API Detection** (`DeprecatedApiCollector`) - Wraps `Mongo.Collection` prototype methods and `Meteor.call` to count sync vs async invocations. Tracks `find().fetch()` vs `fetchAsync()`, `findOne()` vs `findOneAsync()`, `insert/update/remove` vs async variants. Helps measure Meteor 3.x migration readiness.
- **Publication Efficiency** (`PublicationTracer`) - Wraps `Meteor.publish` to intercept returned cursors. Detects publications missing field projections (over-fetching) and those returning large document sets without limits. Reports per-publication call counts, document averages, and efficiency scores.
- **Environment Snapshots** (`EnvironmentCollector`) - Captures installed package versions (`process.versions` + `package.json`), Node.js flags, environment variable keys (not values), and OS metadata. Collected immediately on start, then refreshed every 30 minutes.
- **Vulnerability Scanning** (`VulnerabilityCollector`) - Runs `npm audit --json` hourly (with 30s timeout). Parses both v6 and v7+ audit formats. Reports high/critical vulnerabilities with package name, severity, advisory title, and fix availability. Deduplicates unchanged results.

#### Enhanced System Metrics
- **Event Loop Utilization (ELU)** - 0-1 ratio of event loop busyness via `performance.eventLoopUtilization()` (Node 14.10+)
- **V8 Heap Statistics** - Per-heap-space breakdown (new_space, old_space, code_space, etc.) via `v8.getHeapStatistics()` and `v8.getHeapSpaceStatistics()`. Includes native context count and detached context leak detection.
- **Process Resource Usage** - User/system CPU time, voluntary/involuntary context switches, filesystem reads/writes via `process.resourceUsage()`
- **Active Resources** - Handle/request counts by type (Timer, TCPWrap, FSReqCallback, etc.) via `process.getActiveResourcesInfo()` (Node 17+) for resource leak detection
- **Container Memory Limit** - cgroup memory constraint via `process.constrainedMemory()` (Node 19+) for containerized deployments
- **Agent Version** - `agentVersion` field added to every system metrics payload for compatibility tracking

#### Method Tracer Enhancements
- **COLLSCAN flagging** - Slow queries are now flagged with `collscan: true` when `explain()` data indicates a full collection scan (no index used, or `totalDocsExamined > 0` with `totalKeysExamined === 0`). Applied both at initial detection time and retroactively after async explain completes.
- **Slow aggregation pipeline capture** - Slow aggregation operations now include the sanitized pipeline stages in the slow query entry for debugging.

#### Client-Side Transport Improvements
- **`sendBeacon` primary transport** - `ErrorTracker` and `RUMClient` now use `navigator.sendBeacon()` as the primary transport for small payloads (<60KB for errors, all RUM batches). This is truly fire-and-forget with zero async overhead — no promises, no callbacks, no event loop work. Falls back to `fetch` with `keepalive` for large payloads or when sendBeacon returns false.
- **Public key via query param** - `sendBeacon` cannot set custom headers, so the public key is passed as `?pk=` query parameter (lazily cached URL). The `X-SkySignal-Public-Key` header is still sent on fetch fallback for backward compatibility.

#### Batching & Infrastructure
- **7 new batch types** in `SkySignalClient`: `dnsMetrics`, `outboundHttp`, `cpuProfiles`, `deprecatedApis`, `publications`, `environment`, `vulnerabilities` — each with dedicated REST endpoints and payload keys
- **Worker thread pool** (`WorkerPool` + `compressionWorker`) - Optional `worker_threads`-based compression offloading to prevent gzip work from blocking the host application's event loop. Lazy initialization, auto-restart on crash, and graceful main-thread fallback.

#### Configuration
- **18 new config fields** added to `DEFAULT_CONFIG` and `validateConfig()` for all new collectors: `collectDnsTimings`, `dnsTimingsInterval`, `collectOutboundHttp`, `outboundHttpInterval`, `collectCpuProfiles`, `cpuProfileThreshold`, `cpuProfileDuration`, `cpuProfileCooldown`, `cpuProfileCheckInterval`, `collectDeprecatedApis`, `deprecatedApisInterval`, `collectPublications`, `publicationsInterval`, `collectEnvironment`, `environmentInterval`, `collectVulnerabilities`, `vulnerabilitiesInterval`
- All new collectors are **enabled by default** and use staggered startup to avoid CPU spikes at boot

### v1.0.14 (Bug Fix)
- **Silent production logging** - Replaced bare `console.log()` calls with debug-guarded `_log()` helpers across all collectors (`HTTPCollector`, `DDPCollector`, `DDPQueueCollector`, `LiveQueriesCollector`, `MongoCollectionStatsCollector`, `BaseJobMonitor`, `SteveJobsMonitor`, `JobCollector`). Previously, operational messages like "Batched 1 HTTP requests", "Sent 18 subscription records", and job lifecycle events were unconditionally printed to stdout regardless of the `debug` setting. All informational logs are now silent by default and only appear when `debug: true` is set in the agent configuration.

### v1.0.13 (Bug Fix)
- **Trace context isolation** - Replaced shared `_currentMethodContext` variable with Node.js `AsyncLocalStorage` to properly isolate method trace contexts across concurrent async operations. Fixes a bug where background job database queries (e.g., `jobs_data.findOneAsync()`) would leak into unrelated Meteor method traces when both executed concurrently on the same event loop.

### v1.0.12 (New Features & Bug Fixes)
- **Change Streams support** - Live query observer detection now identifies Change Stream drivers (Meteor 3.5+) alongside oplog and polling, with per-observer introspection instead of global heuristic
- **Log collection** - New `LogsCollector` captures `console.*` and Meteor `Log.*` output with structured metadata, configurable levels, and sampling support. Includes public `SkySignalAgent.addLog()` API for programmatic log submission
- **Silent failure for optional packages** - HTTP and Email package instrumentation no longer logs warnings when packages aren't installed; errors are suppressed to debug-only output (fixes [#1](https://github.com/SkySignalAPM/agent/issues/1))
- **Client-side error tracking fix** - Fixed 400 "Invalid JSON" response when the agent sends batched client errors to `/api/v1/errors`. The server endpoint now correctly reads the pre-parsed request body and supports both batched `{ errors: [...] }` and single error formats (fixes [#2](https://github.com/SkySignalAPM/agent/issues/2))

### v1.0.11 (New Feature)
- Added client IP address collection for enhanced user context in error tracking and performance correlation

### v1.0.7 (Bug Fixes)
- Increased default timeout from 3000ms to 15000ms for API requests to handle slow networks

### v1.0.4 (Rollback)
- Reverted to Meteor 2.16+ compatibility due to Node.js version issues with older Meteor versions (Only Meteor 3.x supports Node 20+)

### v1.0.3 (Bug Fixes)
- Polyfill for `AbortSignal.timeout()` to support older Node.js versions

### v1.0.2 (Bug Fixes)
- Updated Meteor version compatibility to 2.16

### v1.0.1 (Bug Fixes)
- Fixed incorrect default endpoint URL

### v1.0.0 (Initial Release)

- **Complete Method Tracing** - Automatic instrumentation with operation-level profiling
- **MongoDB Query Analysis** - explain() support, N+1 detection, slow query analysis
- **`this.unblock()` Analysis** - Optimization recommendations for blocking methods
- **DDP Connection Monitoring** - Real-time WebSocket tracking with latency metrics
- **MongoDB Pool Monitoring** - Connection pool health, checkout times, queue tracking
- **Live Query Monitoring** - Oplog vs polling efficiency tracking
- **Background Job Monitoring** - Support for msavin:sjobs with extensible adapter system
- **HTTP Request Monitoring** - Automatic tracking of server HTTP requests
- **Collection Stats** - MongoDB collection size and index statistics
- **App Version Tracking** - Auto-detection from package.json with manual override
- **Build Hash Tracking** - Source map correlation via BUILD_HASH/GIT_SHA env vars
- **Performance Safeguards** - Memory limits, request timeouts, batch retries
- **Real User Monitoring (RUM)** - Client-side Core Web Vitals collection (LCP, FID, CLS, TTFB, FCP, TTI)
- **PageSpeed-Style Warnings** - Automatic performance threshold warnings in console
- **SPA Route Tracking** - Automatic performance collection on every route change
- **Session Management** - 30-minute sessions with localStorage persistence
- **Browser Context Collection** - Automatic device, browser, OS, network information
- **User Correlation** - Uses Meteor.userId() to correlate with server-side traces
- **Fire-and-Forget HTTP** - Reliable transmission with keepalive during page unload
- **Configurable Sampling** - Auto-detects environment (100% dev, 50% prod) or manual configuration
- **web-vitals Integration** - Uses Google's official Core Web Vitals library
- System metrics monitoring (CPU, memory, load average)
- HTTP client with batching and auto-flush
- Configurable collection intervals
- Basic error handling and retry logic
- Multi-tenant ready architecture
