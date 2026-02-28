import { Meteor } from "meteor/meteor";
import { DDP } from "meteor/ddp";
import { AsyncLocalStorage } from "async_hooks";
import MongoPoolCollector from "./MongoPoolCollector.js";
import DDPQueueCollector from "./DDPQueueCollector.js";

/**
 * MethodTracer - Traces Meteor Method executions with full MontiAPM compatibility
 *
 * Captures:
 * - Method name, duration, timestamp
 * - User ID and session ID
 * - Arguments (sanitized)
 * - Errors with stack traces
 * - Operations timeline (db, async, compute)
 * - Wait times (DDP queue, connection pool)
 */
export default class MethodTracer {
  // Optimization: Use Set for O(1) exact key lookup
  static SENSITIVE_KEYS = new Set([
    'password', 'passwd', 'pwd', 'pass',
    'secret', 'token', 'apikey', 'api_key',
    'auth', 'authorization', 'cookie', 'session',
    'credit_card', 'creditcard', 'ssn', 'cvv',
    'private_key', 'privatekey', 'access_token', 'accesstoken',
    'refresh_token', 'refreshtoken', 'bearer', 'credentials'
  ]);

  // Pre-compiled regex for O(1) substring matching (instead of O(n) loop)
  static SENSITIVE_KEY_REGEX = new RegExp(
    [...MethodTracer.SENSITIVE_KEYS].join('|'),
    'i'
  );

  /**
   * Check if a key is sensitive
   * Uses pre-compiled regex for O(m) substring matching where m = key length
   */
  static isSensitiveKey(key) {
    if (!key) return false;
    // Single regex test for both exact and substring matches
    return MethodTracer.SENSITIVE_KEY_REGEX.test(key);
  }

  constructor(options = {}) {
    this.client = options.client;
    this.host = options.host;
    this.appVersion = options.appVersion || "unknown";
    this.buildHash = options.buildHash || null; // Build hash for source map lookup
    this.enabled = options.enabled !== false;
    this.debug = options.debug || false; // Debug mode for verbose logging
    this.maxArgLength = options.maxArgLength || 1000;
    this.argumentSanitizer = options.argumentSanitizer || this._defaultSanitizer.bind(this);
    this.slowQueryThreshold = options.slowQueryThreshold || 1000; // ms

    // Index usage tracking configuration
    this.captureIndexUsage = options.captureIndexUsage !== false;
    this.indexUsageSampleRate = options.indexUsageSampleRate || 0.05; // 5% default
    this.explainVerbosity = options.explainVerbosity || 'executionStats';
    this.explainSlowQueriesOnly = options.explainSlowQueriesOnly || false;

    // Store original Meteor.methods
    this._originalMethods = Meteor.methods;
    this._wrappedMethods = new Map();

    // AsyncLocalStorage for proper async context isolation.
    // This ensures each method execution chain tracks its own context,
    // preventing background jobs from leaking operations into method traces.
    this._asyncContextStorage = new AsyncLocalStorage();

    // Legacy _currentMethodContext property - now backed by AsyncLocalStorage.
    // Getter reads from the async-local store so each async chain sees its own context.
    // Setter updates the store value for backwards compatibility within a .run() scope.
    Object.defineProperty(this, '_currentMethodContext', {
      get() {
        const store = this._asyncContextStorage.getStore();
        return store ? store.methodContext : null;
      },
      set(value) {
        const store = this._asyncContextStorage.getStore();
        if (store) {
          store.methodContext = value;
        }
        // If no store exists (outside .run()), this is a no-op — which is correct,
        // because operations outside a method context should not be tracked.
      },
      configurable: true
    });

    // Track call stack for dependency graph generation
    // Each entry: { methodName, startTime, sessionId }
    this._callStack = [];
    this._maxCallStackDepth = 100; // Prevent unbounded growth
    this._callStackCleanupInterval = null;

    // Counter-based trace ID generation — avoids Math.random().toString(36) per method call
    this._traceCounter = 0;

    // Initialize wait time collectors
    this.mongoPoolCollector = null;
    this.ddpQueueCollector = null;
  }

  /**
   * Debug logging helper - only logs when debug mode is enabled
   */
  _log(...args) {
    if (this.debug) {
      console.log('[SkySignal]', ...args);
    }
  }

  /**
   * Warning logging helper - always logs warnings
   */
  _warn(...args) {
    console.warn('[SkySignal]', ...args);
  }

  start() {
    if (!this.enabled) {
      this._log("MethodTracer: Disabled in configuration");
      return;
    }

    // Register tracer globally for user access
    global.SkySignalTracer = this;

    // Wrap Meteor.methods to intercept all method registrations
    this._wrapMeteorMethods();

    // Instrument MongoDB operations
    this._instrumentMongoOperations();

    // Instrument HTTP operations
    this._instrumentHttpOperations();

    // Instrument Fetch operations - DEFERRED to after all packages load
    // Meteor loads fetch polyfills that overwrite global.fetch, so we must instrument AFTER that
    setImmediate(() => {
      try {
        this._instrumentFetchOperations();
      } catch (error) {
        this._warn('Failed to instrument Fetch operations:', error.message);
      }
    });

    // Instrument Email operations
    this._instrumentEmailOperations();

    // Initialize and start wait time collectors
    this._startWaitTimeCollectors();

    // Start periodic cleanup of stale call stack entries (every 60 seconds)
    this._callStackCleanupInterval = setInterval(() => {
      this._cleanupStaleCallStackEntries();
    }, 60000);

    this._log("MethodTracer started");
  }

  /**
   * Cleanup stale call stack entries (methods that started > 5 minutes ago)
   * This prevents memory leaks from methods that didn't properly pop
   */
  _cleanupStaleCallStackEntries() {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const originalLength = this._callStack.length;

    this._callStack = this._callStack.filter(entry => {
      return (now - entry.startTime) < maxAge;
    });

    const removed = originalLength - this._callStack.length;
    if (removed > 0) {
      this._warn(`Cleaned up ${removed} stale call stack entries`);
    }
  }

  stop() {
    // Stop call stack cleanup interval
    if (this._callStackCleanupInterval) {
      clearInterval(this._callStackCleanupInterval);
      this._callStackCleanupInterval = null;
    }

    // Clear call stack
    this._callStack = [];

    // Stop wait time collectors
    if (this.mongoPoolCollector) {
      this.mongoPoolCollector.stop();
      this.mongoPoolCollector = null;
    }

    if (this.ddpQueueCollector) {
      this.ddpQueueCollector.stop();
      this.ddpQueueCollector = null;
    }

    // Restore original Meteor.methods
    if (this._originalMethods) {
      Meteor.methods = this._originalMethods;
    }

    // Remove global tracer reference
    if (global.SkySignalTracer === this) {
      delete global.SkySignalTracer;
    }

    this._wrappedMethods.clear();
    this._log("MethodTracer stopped");
  }

  /**
   * Wrap Meteor.methods to intercept method registrations
   */
  _wrapMeteorMethods() {
    const self = this;

    Meteor.methods = function(methods) {
      // Wrap each method function
      const wrappedMethods = {};

      for (const methodName in methods) {
        if (Object.prototype.hasOwnProperty.call(methods, methodName)) {
          const originalMethod = methods[methodName];
          wrappedMethods[methodName] = self._wrapMethod(methodName, originalMethod);
        }
      }

      // Call original Meteor.methods with wrapped methods
      return self._originalMethods.call(this, wrappedMethods);
    };
  }

  /**
   * Wrap a single method function to track execution
   */
  _wrapMethod(methodName, originalMethod) {
    const self = this;

    return function(...args) {
      const startTime = Date.now();
      const timestamp = startTime;

      // Generate unique trace ID for this method execution using counter (avoids Math.random + toString allocation)
      const traceId = `${methodName}-${startTime}-${++self._traceCounter}`;

      // Capture method context
      const context = {
        methodName,
        timestamp,
        startTime,
        userId: this.userId || null,
        sessionId: this.connection?.id || null,
        clientIp: this.connection?.clientAddress || null,
        args: self._sanitizeArgs(args),
        traceId: traceId,  // Add unique trace ID
        operations: [
          {
            type: "start",
            time: 0
          }
        ],

        // Initialize unblock tracking
        unblockAnalysis: {
          called: false,
          timeToUnblock: null,
          callPosition: null
        },

        // Query pattern tracking for N+1 detection — lazy-initialized on first db operation
        // to avoid Map/Array allocations for methods that don't touch the database
        queryFingerprints: null,        // Map: fingerprint -> {count, operations, totalDuration}
        maxQueryFingerprints: 500,      // Limit unique fingerprints per method
        queryOperations: null,          // Array: All db operations for later analysis
        maxQueryOperations: 1000,       // Limit operations per method

        // Slow query tracking — lazy-initialized on first slow query
        slowQueries: null               // Array: Slow queries for analysis
      };

      // Check for pending wait time data from collectors
      self._attachWaitTimeData(context);

      // Track caller method for dependency graph
      // If there's already a method on the call stack, it's our caller
      if (self._callStack.length > 0) {
        const caller = self._callStack[self._callStack.length - 1];
        context.callerMethod = caller.methodName;
        context.callerSessionId = caller.sessionId;
        context.callDepth = self._callStack.length;
        context.parentTraceId = caller.traceId;  // Add parent trace ID for linking
      } else {
        context.callDepth = 0;
      }

      // Push current method onto call stack with trace ID and context reference
      // Enforce max depth to prevent unbounded growth
      if (self._callStack.length >= self._maxCallStackDepth) {
        self._warn(`Call stack depth exceeded ${self._maxCallStackDepth}, dropping oldest entry`);
        self._callStack.shift(); // Remove oldest entry
      }

      self._callStack.push({
        methodName,
        startTime,
        sessionId: context.sessionId,
        traceId: traceId,
        context: context  // Store reference to context for adding child method operations
      });

      // Wrap this.unblock() to detect when it's called
      const methodInvocation = this;
      const originalUnblock = methodInvocation.unblock;
      let unblockCalled = false;

      if (originalUnblock && typeof originalUnblock === 'function') {
        methodInvocation.unblock = function() {
          if (!unblockCalled) {
            unblockCalled = true;
            const unblockTime = Date.now();
            context.unblockAnalysis.called = true;
            context.unblockAnalysis.timeToUnblock = unblockTime - startTime;
            context.unblockAnalysis.callPosition = unblockTime - startTime;
          }
          return originalUnblock.call(this);
        };
      }

      // Helper function to record this method call in the parent's operations array
      const recordMethodInParent = (duration, result = null, error = null) => {
        if (self._callStack.length > 1) {
          // Get parent from call stack (second to last)
          const parentStackEntry = self._callStack[self._callStack.length - 2];

          if (parentStackEntry.context && parentStackEntry.context.operations) {
            const relativeTime = Date.now() - parentStackEntry.context.startTime;
            const methodOperation = {
              type: "method",
              methodName: methodName,
              traceId: traceId,  // Include child trace ID for linking
              time: relativeTime,
              duration: duration,
              args: context.args
            };

            // Add result or error if available
            if (error) {
              methodOperation.error = error.message || String(error);
            } else if (result !== null && result !== undefined) {
              // Sanitize and truncate result to avoid huge objects
              try {
                const resultStr = JSON.stringify(result);
                if (resultStr.length > 500) {
                  methodOperation.result = resultStr.substring(0, 500) + '...<truncated>';
                } else {
                  methodOperation.result = result;
                }
              } catch (e) {
                methodOperation.result = '<unable to serialize>';
              }
            }

            parentStackEntry.context.operations.push(methodOperation);
          }
        }
      };

      // Run inside AsyncLocalStorage context so all async operations
      // within this method chain are properly isolated from other concurrent work.
      return self._asyncContextStorage.run({ methodContext: context }, () => {
        try {
          // Call original method
          const result = originalMethod.apply(methodInvocation, args);

          // Check if result is a Promise (async method)
          if (result && typeof result.then === 'function') {
            return result
              .then((resolvedValue) => {
                const endTime = Date.now();
                const duration = endTime - startTime;

                context.operations.push({
                  type: "complete",
                  time: duration
                });

                // Record this method call in parent's operations array (if parent exists)
                recordMethodInParent(duration, resolvedValue, null);

                self._recordTrace(context, duration, null);

                // Pop from call stack
                self._callStack.pop();

                return resolvedValue;
              })
              .catch((error) => {
                const endTime = Date.now();
                const duration = endTime - startTime;

                context.operations.push({
                  type: "complete",
                  time: duration
                });

                // Record this method call in parent's operations array with error
                recordMethodInParent(duration, null, error);

                self._recordTrace(context, duration, error);

                // Pop from call stack
                self._callStack.pop();

                throw error;
              });
          } else {
            // Synchronous method
            const endTime = Date.now();
            const duration = endTime - startTime;

            context.operations.push({
              type: "complete",
              time: duration
            });

            // Record this method call in parent's operations array (if parent exists)
            recordMethodInParent(duration, result, null);

            self._recordTrace(context, duration, null);

            // Pop from call stack
            self._callStack.pop();

            return result;
          }
        } catch (error) {
          // Synchronous error
          const endTime = Date.now();
          const duration = endTime - startTime;

          context.operations.push({
            type: "complete",
            time: duration
          });

          // Record this method call in parent's operations array with error
          recordMethodInParent(duration, null, error);

          self._recordTrace(context, duration, error);

          // Pop from call stack
          self._callStack.pop();

          throw error;
        }
      });
    };
  }

  /**
   * Record a method trace
   *
   * IMPORTANT: This method must NOT await long-running operations (like explain queries).
   * Blocking trace recording causes traces to pile up in memory and get lost when the
   * container restarts (Galaxy health check failures). Explain data is nice-to-have;
   * the trace itself is critical.
   */
  _recordTrace(context, duration, error) {
    // Fire-and-forget: let pending explain() queries resolve in the background.
    // They mutate context.operations in-place via side effects, but we do NOT wait
    // for them. If they complete before the next batch flush, the data is included;
    // otherwise the trace ships without index usage metrics.
    if (context.pendingExplains && context.pendingExplains.length > 0) {
      Promise.all(context.pendingExplains).catch(() => {
        // Silently swallow — explain failures must never impact tracing
      });
    }

    const trace = {
      traceType: "method",
      methodName: context.methodName,
      timestamp: context.timestamp,
      duration,
      userId: context.userId,
      sessionId: context.sessionId,
      clientIp: context.clientIp,
      args: context.args,
      operations: context.operations,
      host: this.host,
      appVersion: this.appVersion,
      traceId: context.traceId  // Add unique trace ID
    };

    // Add buildHash if available (for source map lookup)
    if (this.buildHash) {
      trace.buildHash = this.buildHash;
    }

    // Add parent trace ID if this is a child method
    if (context.parentTraceId) {
      trace.parentTraceId = context.parentTraceId;
    }

    // Add caller information for dependency graph
    if (context.callerMethod !== undefined) {
      trace.callerMethod = context.callerMethod;
      trace.callerSessionId = context.callerSessionId;
      trace.callDepth = context.callDepth;
    } else {
      // Root-level method (no caller)
      trace.callDepth = context.callDepth || 0;
    }

    // Add wait time metrics if available
    if (context.waitTimes) {
      trace.waitTimes = {
        ddp: context.waitTimes.ddp || 0,
        pool: context.waitTimes.pool || 0,
        total: (context.waitTimes.ddp || 0) + (context.waitTimes.pool || 0)
      };

      // Add wait list if available (who we waited for)
      if (context.waitTimes.ddpWaitList && context.waitTimes.ddpWaitList.length > 0) {
        trace.waitList = context.waitTimes.ddpWaitList;
      }

      // Add pool wait samples if available
      if (context.waitTimes.poolSamples && context.waitTimes.poolSamples.length > 0) {
        trace.poolWaitSamples = context.waitTimes.poolSamples;
      }
    }

    // Add blocking metrics if available
    if (context.blockingTime !== undefined) {
      trace.blockingTime = context.blockingTime;
    }

    if (context.waitedOn !== undefined) {
      trace.waitedOn = context.waitedOn;
    }

    // Add message info if available (for DDP tracking)
    if (context.messageInfo) {
      trace.messageInfo = context.messageInfo;
    }

    // Compute and add unblock analysis
    if (context.unblockAnalysis) {
      const unblockAnalysis = this._computeUnblockImpact(
        context.unblockAnalysis,
        duration,
        context.blockingTime,
        context.waitedOn
      );

      if (unblockAnalysis) {
        trace.unblockAnalysis = unblockAnalysis;
      }
    }

    // Analyze and add N+1 query patterns
    const n1Patterns = this._analyzeN1Patterns(context);
    if (n1Patterns && n1Patterns.length > 0) {
      trace.n1Patterns = n1Patterns;

      // Add summary metrics for quick filtering
      trace.n1Summary = {
        patternCount: n1Patterns.length,
        totalQueries: n1Patterns.reduce((sum, p) => sum + p.count, 0),
        totalWastedTime: n1Patterns.reduce((sum, p) => sum + p.totalDuration, 0),
        worstPattern: n1Patterns[0] // Already sorted by totalDuration
      };
    }

    // Add slow query analysis
    if (context.slowQueries && context.slowQueries.length > 0) {
      trace.slowQueries = context.slowQueries;

      // Add summary for quick filtering
      const totalSlowQueryTime = context.slowQueries.reduce((sum, q) => sum + q.duration, 0);
      const criticalQueries = context.slowQueries.filter(q => q.analysis.severity === 'CRITICAL').length;
      const highQueries = context.slowQueries.filter(q => q.analysis.severity === 'HIGH').length;

      trace.slowQuerySummary = {
        count: context.slowQueries.length,
        totalDuration: totalSlowQueryTime,
        criticalCount: criticalQueries,
        highCount: highQueries,
        worstQuery: context.slowQueries.reduce((worst, q) =>
          (!worst || q.duration > worst.duration) ? q : worst
        , null)
      };
    }

    // Add error information if present
    if (error) {
      trace.error = {
        message: error.message || String(error),
        stack: error.stack || "",
        type: error.name || error.errorType || "Error"
      };
    }

    // Send to client (which handles sampling and batching)
    if (this.client) {
      this.client.addTrace(trace);
    }
  }

  /**
   * Attach wait time data from collectors to method context
   * Called when method starts executing, after collectors have recorded wait time
   */
  _attachWaitTimeData(context) {
    try {
      const sessionId = context.sessionId;
      if (!sessionId) {
        return; // No session ID, can't retrieve wait time data
      }

      // Check for DDP wait time data
      if (global._skySignalWaitTimeBySession && global._skySignalWaitTimeBySession[sessionId]) {
        const waitData = global._skySignalWaitTimeBySession[sessionId];

        // Initialize waitTimes object
        if (!context.waitTimes) {
          context.waitTimes = {};
        }

        // Attach DDP wait time
        context.waitTimes.ddp = waitData.ddp || 0;
        context.waitTimes.ddpWaitList = waitData.ddpWaitList || [];

        // Attach blocking metrics
        if (waitData.blockingTime !== undefined) {
          context.blockingTime = waitData.blockingTime;
        }
        if (waitData.waitedOn !== undefined) {
          context.waitedOn = waitData.waitedOn;
        }

        // Attach message info
        if (waitData.messageInfo) {
          context.messageInfo = waitData.messageInfo;
        }

        // Clean up - remove this session's data
        delete global._skySignalWaitTimeBySession[sessionId];
      }

      // Check for MongoDB pool wait time samples
      // Collect any pool wait samples that occurred just before this method started
      if (global._skySignalPoolWaitTimes && global._skySignalPoolWaitTimes.length > 0) {
        // Find samples from the last 100ms (assume they belong to this method's startup)
        const recentThreshold = context.startTime - 100;
        const recentSamples = [];
        let poolWaitTotal = 0;

        // Collect recent samples
        for (let i = global._skySignalPoolWaitTimes.length - 1; i >= 0; i--) {
          const sample = global._skySignalPoolWaitTimes[i];
          if (sample.timestamp >= recentThreshold) {
            recentSamples.unshift(sample);
            poolWaitTotal += sample.waitTime || 0;
          } else {
            break; // Older samples, stop looking
          }
        }

        if (recentSamples.length > 0) {
          // Initialize waitTimes if needed
          if (!context.waitTimes) {
            context.waitTimes = {};
          }

          context.waitTimes.pool = poolWaitTotal;
          context.waitTimes.poolSamples = recentSamples;
        }
      }

    } catch (error) {
      this._warn('Error attaching wait time data:', error);
    }
  }

  /**
   * Compute this.unblock() impact and generate recommendations
   * Returns null if unblock analysis not needed, otherwise returns analysis object
   */
  _computeUnblockImpact(unblockAnalysis, duration, blockingTime, waitedOn) {
    try {
      // If unblock was called, just record it (no issues)
      if (unblockAnalysis.called) {
        return {
          called: true,
          timeToUnblock: unblockAnalysis.timeToUnblock,
          callPosition: unblockAnalysis.callPosition,
          impactScore: 0,
          recommendation: "NONE",
          potentialSaving: 0
        };
      }

      // Unblock was NOT called - analyze impact
      const blockTime = blockingTime || duration;  // If no blockingTime, assume entire duration
      const waitedOnTime = waitedOn || 0;

      // Calculate impact score (0-10)
      // Higher score = more problematic
      let impactScore = 0;

      // Factor 1: Long blocking time (0-4 points)
      if (blockTime > 1000) {
        impactScore += 4;  // > 1 second
      } else if (blockTime > 500) {
        impactScore += 3;  // > 500ms
      } else if (blockTime > 200) {
        impactScore += 2;  // > 200ms
      } else if (blockTime > 100) {
        impactScore += 1;  // > 100ms
      }

      // Factor 2: High waitedOn time - blocking other operations (0-4 points)
      if (waitedOnTime > 2000) {
        impactScore += 4;  // Blocked > 2 seconds of other work
      } else if (waitedOnTime > 1000) {
        impactScore += 3;
      } else if (waitedOnTime > 500) {
        impactScore += 2;
      } else if (waitedOnTime > 200) {
        impactScore += 1;
      }

      // Factor 3: Method duration (0-2 points)
      // Longer methods benefit more from unblock
      if (duration > 1000) {
        impactScore += 2;
      } else if (duration > 500) {
        impactScore += 1;
      }

      // Calculate potential savings
      // If we unblock early (after security checks ~20ms), the rest could be parallel
      const estimatedSecurityChecksTime = 20;  // Assume 20ms for security checks
      const potentialParallelTime = Math.max(0, duration - estimatedSecurityChecksTime);
      const potentialSaving = Math.min(potentialParallelTime, waitedOnTime);

      // Determine recommendation level
      let recommendation;
      if (impactScore >= 7) {
        recommendation = "HIGH";       // Critical issue
      } else if (impactScore >= 4) {
        recommendation = "MEDIUM";     // Should consider adding unblock
      } else if (impactScore >= 2) {
        recommendation = "LOW";        // Minor benefit
      } else {
        recommendation = "NONE";       // Fast method, unblock not needed
      }

      // Only return analysis if there's an actual recommendation
      if (recommendation === "NONE") {
        return null;
      }

      return {
        called: false,
        timeToUnblock: null,
        callPosition: null,
        blockingTime: blockTime,
        waitedOn: waitedOnTime,
        impactScore: Math.min(10, impactScore),  // Cap at 10
        recommendation,
        potentialSaving: Math.round(potentialSaving),
        suggestedPosition: estimatedSecurityChecksTime  // Suggest adding after ~20ms
      };

    } catch (error) {
      this._warn('Error computing unblock impact:', error);
      return null;
    }
  }

  /**
   * Generate a fingerprint for a database query
   * Normalizes queries by replacing specific values with placeholders
   * to detect repeated query patterns (N+1 queries)
   *
   * Example:
   *   { userId: "abc123" } -> { userId: "?" }
   *   { _id: { $in: ["a", "b", "c"] } } -> { _id: { $in: "?" } }
   */
  _generateQueryFingerprint(collection, operation, selector = {}) {
    try {
      // Base fingerprint with collection and operation
      const parts = [`${collection}.${operation}`];

      // Normalize selector by replacing values with placeholders
      const normalized = this._normalizeQueryObject(selector);

      // Convert to stable string representation
      const selectorStr = JSON.stringify(normalized, Object.keys(normalized).sort());
      parts.push(selectorStr);

      return parts.join('::');
    } catch (error) {
      // Fallback to simple fingerprint if normalization fails
      return `${collection}.${operation}`;
    }
  }

  /**
   * Recursively normalize a query object by replacing values with "?"
   * Preserves operators and structure, only normalizes leaf values
   */
  _normalizeQueryObject(obj) {
    if (obj === null || obj === undefined) {
      return "?";
    }

    if (typeof obj !== 'object') {
      return "?";
    }

    if (Array.isArray(obj)) {
      // For arrays, just mark as "?" (we care about the pattern, not the values)
      return "?";
    }

    const normalized = {};
    for (const key of Object.keys(obj)) {
      const value = obj[key];

      // MongoDB operators - preserve structure
      if (key.startsWith('$')) {
        if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
          // Nested operator like { $gte: 100, $lte: 200 }
          normalized[key] = this._normalizeQueryObject(value);
        } else {
          // Simple operator value like { $in: [...] } or { $gt: 100 }
          normalized[key] = "?";
        }
      } else {
        // Regular field
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          // Field has operators like { userId: { $ne: "abc" } }
          normalized[key] = this._normalizeQueryObject(value);
        } else {
          // Simple field value like { userId: "abc123" }
          normalized[key] = "?";
        }
      }
    }

    return normalized;
  }

  /**
   * Analyze query patterns to detect N+1 queries
   * N+1 pattern: Same query executed multiple times with different IDs
   *
   * Detection criteria:
   * - Same fingerprint (collection + operation + query structure)
   * - Executed 5+ times
   * - Total duration > 50ms
   *
   * Returns array of N+1 patterns with:
   * - fingerprint: Query pattern
   * - count: Number of executions
   * - totalDuration: Total time spent
   * - avgDuration: Average query time
   * - collection: Collection name
   * - operation: DB operation (find, findOne, etc.)
   * - suggestion: Optimization recommendation
   */
  _analyzeN1Patterns(context) {
    try {
      if (!context.queryFingerprints || context.queryFingerprints.size === 0) {
        return null;
      }

      const patterns = [];
      const N1_THRESHOLD = 5; // Minimum occurrences to flag as N+1
      const MIN_TOTAL_DURATION = 2; // Minimum total duration in ms (lowered for testing - even fast queries add up)

      // Analyze each fingerprint
      for (const [fingerprint, data] of context.queryFingerprints.entries()) {
        if (data.count >= N1_THRESHOLD && data.totalDuration >= MIN_TOTAL_DURATION) {
          // Extract collection and operation from fingerprint
          const [collectionOp] = fingerprint.split('::');
          const [collection, operation] = collectionOp.split('.');

          // Generate optimization suggestion
          const suggestion = this._generateN1Suggestion(operation, data.count);

          patterns.push({
            fingerprint,
            count: data.count,
            totalDuration: Math.round(data.totalDuration),
            avgDuration: Math.round(data.totalDuration / data.count),
            collection,
            operation,
            suggestion,
            // Include sample operations for debugging (first 3)
            samples: data.operations.slice(0, 3)
          });
        }
      }

      // Sort by total duration (most impactful first)
      patterns.sort((a, b) => b.totalDuration - a.totalDuration);

      return patterns.length > 0 ? patterns : null;
    } catch (error) {
      this._warn('Error analyzing N+1 patterns:', error);
      return null;
    }
  }

  /**
   * Generate optimization suggestion based on operation type
   */
  _generateN1Suggestion(operation, count) {
    if (operation === 'findOne' || operation === 'findOneAsync') {
      return `Replace ${count} individual queries with a single find() using $in operator`;
    } else if (operation === 'find') {
      return `Consolidate ${count} find() queries or use aggregation with $lookup`;
    } else if (operation === 'update' || operation === 'updateAsync') {
      return `Batch ${count} updates into a single update with $in or updateMany`;
    } else if (operation === 'remove' || operation === 'removeAsync') {
      return `Batch ${count} removes into a single remove with $in`;
    }

    return `Consolidate ${count} ${operation} operations`;
  }

  /**
   * Analyze a slow query and provide recommendations
   * Uses heuristics to identify potential index issues
   *
   * @param {String} collection - Collection name
   * @param {String} operation - DB operation
   * @param {Object} selector - Query selector
   * @param {Number} duration - Query duration in ms
   * @returns {Object} Query analysis with recommendations
   */
  _analyzeSlowQuery(collection, operation, selector = {}, duration) {
    try {
      const analysis = {
        duration,
        severity: this._calculateQuerySeverity(duration),
        likelyIssues: [],
        recommendations: []
      };

      // Heuristic 1: Very slow queries likely have missing indexes
      if (duration > 500) {
        analysis.likelyIssues.push('MISSING_INDEX');
        analysis.recommendations.push(`Add index on ${collection} for frequently queried fields`);
      } else if (duration > 200) {
        analysis.likelyIssues.push('SUBOPTIMAL_INDEX');
        analysis.recommendations.push(`Review index usage for ${collection}`);
      }

      // Heuristic 2: Empty selector = collection scan
      if (!selector || Object.keys(selector).length === 0) {
        analysis.likelyIssues.push('COLLECTION_SCAN');
        analysis.recommendations.push('Add query filter to avoid full collection scan');
      }

      // Heuristic 3: Complex selectors without compound indexes
      const selectorKeys = Object.keys(selector || {});
      if (selectorKeys.length > 2) {
        analysis.likelyIssues.push('COMPLEX_QUERY');
        analysis.recommendations.push(`Consider compound index on ${collection} for: ${selectorKeys.slice(0, 3).join(', ')}`);
      }

      // Heuristic 4: $regex queries without index
      if (selector && this._hasRegexOperator(selector)) {
        analysis.likelyIssues.push('REGEX_QUERY');
        analysis.recommendations.push('Regex queries can be slow; consider text index or alternative approach');
      }

      // Heuristic 5: $where or $expr queries (always slow)
      if (selector && (selector.$where || selector.$expr)) {
        analysis.likelyIssues.push('COMPLEX_OPERATOR');
        analysis.recommendations.push('$where and $expr operators bypass indexes; refactor if possible');
      }

      return analysis;
    } catch (error) {
      this._warn('Error analyzing slow query:', error);
      return {
        duration,
        severity: 'UNKNOWN',
        likelyIssues: [],
        recommendations: []
      };
    }
  }

  /**
   * Calculate query severity based on duration
   */
  _calculateQuerySeverity(duration) {
    if (duration >= 1000) return 'CRITICAL';
    if (duration >= 500) return 'HIGH';
    if (duration >= 200) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Check if selector contains regex operators
   */
  _hasRegexOperator(selector, depth = 0) {
    if (depth > 3 || !selector || typeof selector !== 'object') {
      return false;
    }

    for (const key in selector) {
      const value = selector[key];

      // Check if value is a regex
      if (value instanceof RegExp) {
        return true;
      }

      // Check if value is $regex operator
      if (key === '$regex' || (typeof value === 'object' && value && value.$regex)) {
        return true;
      }

      // Recursively check nested objects
      if (typeof value === 'object' && value !== null) {
        if (this._hasRegexOperator(value, depth + 1)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Sanitize method arguments to remove sensitive data
   * Returns an Object (not Array) to match the platform schema
   */
  _sanitizeArgs(args) {
    if (!args || args.length === 0) {
      return {};
    }

    try {
      // If single argument and it's already an object, return it sanitized
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
        return this.argumentSanitizer(args[0]);
      }

      // Otherwise, convert array to object with arg0, arg1, arg2... keys
      const argsObj = {};
      args.forEach((arg, index) => {
        argsObj[`arg${index}`] = this.argumentSanitizer(arg);
      });
      return argsObj;
    } catch (error) {
      this._warn("Error sanitizing arguments:", error);
      return { error: "<error sanitizing args>" };
    }
  }

  /**
   * Sanitize database operation arguments (queries, selectors, etc.)
   * Similar to _defaultSanitizer but more permissive for DB queries
   *
   * Optimizations applied:
   * - Compiled regex for sensitive key matching
   * - Object key truncation to prevent excessive iteration
   * - Optimized early returns for primitives
   * - For loops instead of map() to reduce allocations
   */
  _sanitizeDbArg(arg, depth = 0, maxDepth = 5) {
    // Optimization #3: Early depth check
    if (depth > maxDepth) {
      return "<max depth reached>";
    }

    // Optimization #3: Combined null/undefined check
    if (arg == null) {
      return arg;
    }

    const type = typeof arg;

    // Optimization #3: Grouped primitive checks
    if (type === "number" || type === "boolean") {
      return arg;
    }

    if (type === "string") {
      return arg.length > 500 ? arg.substring(0, 500) + "...<truncated>" : arg;
    }

    if (type === "function") {
      return "<function>";
    }

    if (arg instanceof Date) {
      return arg.toISOString();
    }

    if (arg instanceof RegExp) {
      return arg.toString();
    }

    // Optimization #4: Array handling with for loops
    if (Array.isArray(arg)) {
      const maxArrayLength = 20;
      if (arg.length > maxArrayLength) {
        const sanitized = [];
        for (let i = 0; i < maxArrayLength; i++) {
          sanitized.push(this._sanitizeDbArg(arg[i], depth + 1, maxDepth));
        }
        sanitized.push(`<${arg.length - maxArrayLength} more items>`);
        return sanitized;
      } else {
        const sanitized = new Array(arg.length);
        for (let i = 0; i < arg.length; i++) {
          sanitized[i] = this._sanitizeDbArg(arg[i], depth + 1, maxDepth);
        }
        return sanitized;
      }
    }

    // Optimization #2: Object key truncation + Optimization #1: Regex matching
    if (type === "object") {
      const maxObjectKeys = 50;
      const keys = Object.keys(arg);
      const sanitized = {};

      // Handle truncation for large objects
      if (keys.length > maxObjectKeys) {
        for (let i = 0; i < maxObjectKeys; i++) {
          const key = keys[i];
          const isSensitive = MethodTracer.isSensitiveKey(key);
          sanitized[key] = isSensitive ? "<redacted>" : this._sanitizeDbArg(arg[key], depth + 1, maxDepth);
        }
        sanitized['<truncated>'] = `<${keys.length - maxObjectKeys} more keys omitted>`;
        return sanitized;
      }

      // Normal object processing with Set lookup
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const isSensitive = MethodTracer.isSensitiveKey(key);
        sanitized[key] = isSensitive ? "<redacted>" : this._sanitizeDbArg(arg[key], depth + 1, maxDepth);
      }

      return sanitized;
    }

    return String(arg);
  }

  /**
   * Default argument sanitizer
   * - Removes passwords, tokens, secrets
   * - Truncates long strings
   * - Limits object depth
   *
   * Optimizations applied:
   * - Compiled regex for sensitive key matching
   * - Object key truncation to prevent excessive iteration
   * - Optimized early returns for primitives
   * - For loops instead of map() to reduce allocations
   */
  _defaultSanitizer(arg, depth = 0, maxDepth = 3) {
    // Optimization #3: Early depth check
    if (depth > maxDepth) {
      return "<max depth reached>";
    }

    // Optimization #3: Combined null/undefined check
    if (arg == null) {
      return arg;
    }

    const type = typeof arg;

    // Optimization #3: Grouped primitive checks
    if (type === "number" || type === "boolean") {
      return arg;
    }

    if (type === "string") {
      return arg.length > this.maxArgLength
        ? arg.substring(0, this.maxArgLength) + "...<truncated>"
        : arg;
    }

    if (type === "function") {
      return "<function>";
    }

    if (arg instanceof Date) {
      return arg.toISOString();
    }

    if (arg instanceof RegExp) {
      return arg.toString();
    }

    // Optimization #4: Array handling with for loops
    if (Array.isArray(arg)) {
      const maxArrayLength = 10;
      if (arg.length > maxArrayLength) {
        const sanitized = [];
        for (let i = 0; i < maxArrayLength; i++) {
          sanitized.push(this._defaultSanitizer(arg[i], depth + 1, maxDepth));
        }
        sanitized.push(`<${arg.length - maxArrayLength} more items>`);
        return sanitized;
      } else {
        const sanitized = new Array(arg.length);
        for (let i = 0; i < arg.length; i++) {
          sanitized[i] = this._defaultSanitizer(arg[i], depth + 1, maxDepth);
        }
        return sanitized;
      }
    }

    // Optimization #2: Object key truncation + Optimization #1: Regex matching
    if (type === "object") {
      const maxObjectKeys = 50;
      const keys = Object.keys(arg);
      const sanitized = {};

      // Handle truncation for large objects
      if (keys.length > maxObjectKeys) {
        for (let i = 0; i < maxObjectKeys; i++) {
          const key = keys[i];
          const isSensitive = MethodTracer.isSensitiveKey(key);
          sanitized[key] = isSensitive ? "<redacted>" : this._defaultSanitizer(arg[key], depth + 1, maxDepth);
        }
        sanitized['<truncated>'] = `<${keys.length - maxObjectKeys} more keys omitted>`;
        return sanitized;
      }

      // Normal object processing with Set lookup
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const isSensitive = MethodTracer.isSensitiveKey(key);
        sanitized[key] = isSensitive ? "<redacted>" : this._defaultSanitizer(arg[key], depth + 1, maxDepth);
      }

      return sanitized;
    }

    return String(arg);
  }

  /**
   * Add an operation to the current method trace
   * This is called by other trackers (e.g., MongoTracer) to add operations
   * @returns {Object} The operation object that was added (useful for later mutations)
   */
  addOperation(operation) {
    if (this._currentMethodContext && this._currentMethodContext.operations) {
      const relativeTime = Date.now() - this._currentMethodContext.startTime;
      const operationWithTime = {
        ...operation,
        time: relativeTime
      };
      this._currentMethodContext.operations.push(operationWithTime);

      // Track query fingerprints for N+1 detection
      if (operation.type === 'db' && operation.collection && operation.operation) {
        const fingerprint = this._generateQueryFingerprint(
          operation.collection,
          operation.operation,
          operation.selector
        );

        // Lazy-init queryFingerprints Map on first db operation
        if (!this._currentMethodContext.queryFingerprints) {
          this._currentMethodContext.queryFingerprints = new Map();
        }

        // Initialize fingerprint tracking if not exists (with limit check)
        if (!this._currentMethodContext.queryFingerprints.has(fingerprint)) {
          // Check fingerprints limit
          if (this._currentMethodContext.queryFingerprints.size >= this._currentMethodContext.maxQueryFingerprints) {
            // Skip adding new fingerprints once limit reached
            // Still track the operation below
          } else {
            this._currentMethodContext.queryFingerprints.set(fingerprint, {
              count: 0,
              totalDuration: 0,
              operations: []
            });
          }
        }

        // Update fingerprint data if it exists
        if (this._currentMethodContext.queryFingerprints.has(fingerprint)) {
          const fpData = this._currentMethodContext.queryFingerprints.get(fingerprint);
          fpData.count++;
          fpData.totalDuration += operation.duration || 0;
          // Limit operations stored per fingerprint to 100
          if (fpData.operations.length < 100) {
            fpData.operations.push({
              collection: operation.collection,
              operation: operation.operation,
              selector: operation.selector,
              duration: operation.duration,
              time: relativeTime
            });
          }
        }

        // Store full operation for later analysis (lazy-init + limit check)
        if (!this._currentMethodContext.queryOperations) {
          this._currentMethodContext.queryOperations = [];
        }
        if (this._currentMethodContext.queryOperations.length < this._currentMethodContext.maxQueryOperations) {
          this._currentMethodContext.queryOperations.push({
            fingerprint,
            ...operation,
            time: relativeTime
          });
        }

        // Track slow queries
        if (operation.slowQuery && operation.queryAnalysis) {
          this._log('Slow query:', operation.collection + '.' + operation.operation, operation.duration + 'ms');
          const slowQueryEntry = {
            collection: operation.collection,
            operation: operation.operation,
            selector: operation.selector,
            duration: operation.duration,
            time: relativeTime,
            analysis: operation.queryAnalysis
          };

          // Add COLLSCAN flag if explain data indicates a collection scan
          if (operation.indexUsed === 'COLLSCAN' ||
              (operation.totalDocsExamined > 0 && operation.totalKeysExamined === 0)) {
            slowQueryEntry.collscan = true;
            slowQueryEntry.collscanCollection = operation.collection;
          }

          // Capture sanitized pipeline for slow aggregations
          if (operation.pipeline) {
            slowQueryEntry.pipeline = operation.pipeline;
          }

          if (!this._currentMethodContext.slowQueries) {
            this._currentMethodContext.slowQueries = [];
          }
          this._currentMethodContext.slowQueries.push(slowQueryEntry);
        }
      }

      // Return the actual object that was pushed (so callers can mutate it if needed)
      return operationWithTime;
    }
  }

  /**
   * Get current method context (for use by other tracers)
   */
  getCurrentContext() {
    return this._currentMethodContext;
  }

  /**
   * Track wait time (e.g., awaiting promises, setTimeout)
   */
  trackWaitTime(label, startTime) {
    const duration = Date.now() - startTime;
    this.addOperation({
      type: "wait",
      label: label || "wait",
      duration
    });
    return duration;
  }

  /**
   * Track compute time (synchronous CPU work)
   */
  trackComputeTime(label, startTime) {
    const duration = Date.now() - startTime;
    this.addOperation({
      type: "compute",
      label: label || "compute",
      duration
    });
    return duration;
  }

  /**
   * Track async operation (manual timing)
   */
  trackAsyncOperation(label, startTime) {
    const duration = Date.now() - startTime;
    this.addOperation({
      type: "async",
      label: label || "async",
      duration
    });
    return duration;
  }

  /**
   * Track async function execution (automatic timing)
   *
   * Usage:
   *   const result = await tracer.trackAsyncFunction('profitCalculator', profitCalculator(input));
   *
   * Or with inline async function:
   *   const result = await tracer.trackAsyncFunction('calculateProfit', async () => {
   *     return await someAsyncOperation();
   *   });
   */
  async trackAsyncFunction(label, asyncOperationOrPromise) {
    const operationStart = Date.now();

    try {
      // Handle both Promise and async function
      const result = typeof asyncOperationOrPromise === 'function'
        ? await asyncOperationOrPromise()
        : await asyncOperationOrPromise;

      const duration = Date.now() - operationStart;
      this.addOperation({
        type: "async",
        label: label || "async",
        duration
      });

      return result;
    } catch (error) {
      const duration = Date.now() - operationStart;
      this.addOperation({
        type: "async",
        label: label || "async",
        duration,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Instrument MongoDB operations
   */
  _instrumentMongoOperations() {
    const self = this;

    try {
      const { Mongo } = require('meteor/mongo');

      if (!Mongo || !Mongo.Collection) {
        this._warn("Mongo.Collection not available for instrumentation");
        return;
      }

      // Instrument Collection.prototype methods
      const collectionPrototype = Mongo.Collection.prototype;

      // Wrap common collection methods (both sync and async)
      const methodsToWrap = [
        'find', 'findOne', 'insert', 'update', 'remove', 'upsert',
        'findOneAsync', 'insertAsync', 'updateAsync', 'removeAsync', 'upsertAsync'
      ];

      methodsToWrap.forEach(methodName => {
        const originalMethod = collectionPrototype[methodName];
        if (typeof originalMethod === 'function') {
          collectionPrototype[methodName] = function(...args) {
            const operationStart = Date.now();
            const collectionName = this._name;

            try {
              const result = originalMethod.apply(this, args);

              // Check if result is a Promise (async method)
              if (result && typeof result.then === 'function') {
                // Async method - wrap the promise to measure duration
                return result.then(
                  (resolvedValue) => {
                    const duration = Date.now() - operationStart;
                    const operationDetails = {
                      type: "db",
                      operation: methodName,
                      collection: collectionName,
                      duration
                    };

                    // Capture operation-specific details
                    if (methodName.includes('find') || methodName.includes('findOne')) {
                      operationDetails.selector = self._sanitizeDbArg(args[0]);
                      operationDetails.options = self._sanitizeDbArg(args[1]);
                    } else if (methodName.includes('insert')) {
                      operationDetails.doc = self._sanitizeDbArg(args[0]);
                    } else if (methodName.includes('update') || methodName.includes('upsert')) {
                      operationDetails.selector = self._sanitizeDbArg(args[0]);
                      operationDetails.modifier = self._sanitizeDbArg(args[1]);
                      operationDetails.options = self._sanitizeDbArg(args[2]);
                    } else if (methodName.includes('remove')) {
                      operationDetails.selector = self._sanitizeDbArg(args[0]);
                    }

                    // Flag slow queries for analysis
                    if (duration >= self.slowQueryThreshold) {
                      operationDetails.slowQuery = true;
                      operationDetails.queryAnalysis = self._analyzeSlowQuery(
                        collectionName,
                        methodName,
                        args[0], // selector
                        duration
                      );
                    }

                    self.addOperation(operationDetails);
                    return resolvedValue;
                  },
                  (error) => {
                    const duration = Date.now() - operationStart;
                    const operationDetails = {
                      type: "db",
                      operation: methodName,
                      collection: collectionName,
                      duration,
                      error: error.message
                    };

                    self.addOperation(operationDetails);
                    throw error;
                  }
                );
              }

              // Synchronous method - measure duration immediately
              const duration = Date.now() - operationStart;
              const operationDetails = {
                type: "db",
                operation: methodName,
                collection: collectionName,
                duration
              };

              // Capture operation-specific details
              if (methodName === 'find' || methodName === 'findOne') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
                operationDetails.options = self._sanitizeDbArg(args[1]);
              } else if (methodName === 'insert') {
                operationDetails.doc = self._sanitizeDbArg(args[0]);
              } else if (methodName === 'update' || methodName === 'upsert') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
                operationDetails.modifier = self._sanitizeDbArg(args[1]);
                operationDetails.options = self._sanitizeDbArg(args[2]);
              } else if (methodName === 'remove') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
              }

              // Flag slow queries for analysis
              if (duration >= self.slowQueryThreshold) {
                operationDetails.slowQuery = true;
                operationDetails.queryAnalysis = self._analyzeSlowQuery(
                  collectionName,
                  methodName,
                  args[0], // selector
                  duration
                );
              }

              self.addOperation(operationDetails);

              return result;
            } catch (error) {
              const duration = Date.now() - operationStart;
              const operationDetails = {
                type: "db",
                operation: methodName,
                collection: collectionName,
                duration,
                error: error.message
              };

              // Capture details even on error
              if (methodName === 'find' || methodName === 'findOne') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
              } else if (methodName === 'update' || methodName === 'upsert') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
              } else if (methodName === 'remove') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
              }

              self.addOperation(operationDetails);
              throw error;
            }
          };
        }
      });

      // Wrap async versions
      const asyncMethodsToWrap = ['insertAsync', 'updateAsync', 'removeAsync', 'upsertAsync', 'findOneAsync'];

      asyncMethodsToWrap.forEach(methodName => {
        const originalMethod = collectionPrototype[methodName];
        if (typeof originalMethod === 'function') {
          collectionPrototype[methodName] = async function(...args) {
            const operationStart = Date.now();
            const collectionName = this._name;

            try {
              const result = await originalMethod.apply(this, args);

              const duration = Date.now() - operationStart;
              const operationDetails = {
                type: "db",
                operation: methodName,
                collection: collectionName,
                duration
              };

              // Capture operation-specific details
              const baseMethod = methodName.replace('Async', '');
              if (baseMethod === 'findOne') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
                operationDetails.options = self._sanitizeDbArg(args[1]);
              } else if (baseMethod === 'insert') {
                operationDetails.doc = self._sanitizeDbArg(args[0]);
              } else if (baseMethod === 'update' || baseMethod === 'upsert') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
                operationDetails.modifier = self._sanitizeDbArg(args[1]);
                operationDetails.options = self._sanitizeDbArg(args[2]);
              } else if (baseMethod === 'remove') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
              }

              // Flag slow queries for analysis
              if (duration >= self.slowQueryThreshold) {
                operationDetails.slowQuery = true;
                operationDetails.queryAnalysis = self._analyzeSlowQuery(
                  collectionName,
                  methodName,
                  args[0], // selector
                  duration
                );
              }

              self.addOperation(operationDetails);

              return result;
            } catch (error) {
              const duration = Date.now() - operationStart;
              const operationDetails = {
                type: "db",
                operation: methodName,
                collection: collectionName,
                duration,
                error: error.message
              };

              // Capture details even on error
              const baseMethod = methodName.replace('Async', '');
              if (baseMethod === 'findOne') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
              } else if (baseMethod === 'update' || baseMethod === 'upsert') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
              } else if (baseMethod === 'remove') {
                operationDetails.selector = self._sanitizeDbArg(args[0]);
              }

              self.addOperation(operationDetails);
              throw error;
            }
          };
        }
      });

      // Instrument _rawCollection().aggregate()
      const originalRawCollection = collectionPrototype.rawCollection;
      if (typeof originalRawCollection === 'function') {
        collectionPrototype.rawCollection = function() {
          const rawCollection = originalRawCollection.apply(this, arguments);
          const collectionName = this._name;

          // Wrap aggregate method
          if (rawCollection && typeof rawCollection.aggregate === 'function') {
            const originalAggregate = rawCollection.aggregate;
            rawCollection.aggregate = function(pipeline, options) {
              const operationStart = Date.now();
              const aggregateCursor = originalAggregate.apply(this, arguments);

              // Wrap only high-level cursor methods (not next/hasNext which are called per-document)
              const cursorMethodsToWrap = ['toArray'];

              cursorMethodsToWrap.forEach(cursorMethod => {
                if (typeof aggregateCursor[cursorMethod] === 'function') {
                  const originalCursorMethod = aggregateCursor[cursorMethod];

                  aggregateCursor[cursorMethod] = async function(...cursorArgs) {
                    const cursorOperationStart = Date.now();

                    try {
                      const result = await originalCursorMethod.apply(this, cursorArgs);
                      const duration = Date.now() - cursorOperationStart;

                      const operationDetails = {
                        type: "db",
                        operation: `aggregate.${cursorMethod}`,
                        collection: collectionName,
                        pipelineStages: pipeline?.length || 0,
                        pipeline: self._sanitizeDbArg(pipeline),
                        options: self._sanitizeDbArg(options),
                        duration
                      };

                      // Flag slow aggregations
                      if (duration >= self.slowQueryThreshold) {
                        operationDetails.slowQuery = true;
                        operationDetails.queryAnalysis = self._analyzeSlowQuery(
                          collectionName,
                          `aggregate.${cursorMethod}`,
                          { pipeline },
                          duration
                        );
                      }

                      // Add operation first and get reference
                      const addedOperation = self.addOperation(operationDetails);

                      // Capture index usage with explain() for aggregations
                      if (self.captureIndexUsage && self._shouldExplainQuery(duration) && addedOperation) {
                        self._log(`Starting explain() for ${collectionName}.aggregate.${cursorMethod}`);

                        const explainPromise = (async () => {
                          try {
                            const indexUsageData = await self._captureAggregationIndexUsage(
                              collectionName,
                              pipeline,
                              options,
                              originalAggregate
                            );

                            if (indexUsageData) {
                              self._log(`Got aggregation explain data for ${collectionName}`);
                              Object.assign(addedOperation, indexUsageData);

                              // Retroactively flag COLLSCAN on slow query entries
                              if (indexUsageData.indexUsed === 'COLLSCAN' ||
                                  (indexUsageData.totalDocsExamined > 0 && indexUsageData.totalKeysExamined === 0)) {
                                const ctx2 = self._currentMethodContext;
                                if (ctx2 && ctx2.slowQueries) {
                                  const matchingSQ = ctx2.slowQueries.find(sq =>
                                    sq.collection === collectionName && sq.time === addedOperation.time
                                  );
                                  if (matchingSQ) {
                                    matchingSQ.collscan = true;
                                    matchingSQ.collscanCollection = collectionName;
                                  }
                                }
                              }
                            }
                          } catch (explainError) {
                            self._warn(`Failed to capture aggregation index usage for ${collectionName}:`, explainError.message);
                          }
                        })();

                        // Store promise in context (with size limit)
                        const ctx = self._currentMethodContext;
                        if (ctx) {
                          if (!ctx.pendingExplains) {
                            ctx.pendingExplains = [];
                          }
                          // Limit pending explains to prevent unbounded growth
                          if (ctx.pendingExplains.length < 50) {
                            ctx.pendingExplains.push(explainPromise);
                          }
                        }
                      }

                      return result;
                    } catch (error) {
                      const duration = Date.now() - cursorOperationStart;
                      self.addOperation({
                        type: "db",
                        operation: `aggregate.${cursorMethod}`,
                        collection: collectionName,
                        pipelineStages: pipeline?.length || 0,
                        pipeline: self._sanitizeDbArg(pipeline),
                        duration,
                        error: error.message
                      });
                      throw error;
                    }
                  };
                }
              });

              return aggregateCursor;
            };
          }

          return rawCollection;
        };
      }

      // Instrument Cursor methods (fetchAsync, fetch, count, etc.)
      // When find() is called, it returns a Cursor, and fetchAsync() actually executes the query
      const originalFind = collectionPrototype.find;
      if (typeof originalFind === 'function') {
        collectionPrototype.find = function(...args) {
          const cursor = originalFind.apply(this, args);
          const collectionName = this._name;
          const selector = args[0];
          const options = args[1];

          // Wrap cursor methods to measure actual query execution
          const cursorMethodsToWrap = ['fetchAsync', 'fetch', 'count', 'countAsync'];

          cursorMethodsToWrap.forEach(cursorMethod => {
            const originalCursorMethod = cursor[cursorMethod];
            if (typeof originalCursorMethod === 'function') {
              cursor[cursorMethod] = async function(...cursorArgs) {
                const operationStart = Date.now();

                try {
                  const result = await originalCursorMethod.apply(this, cursorArgs);
                  const duration = Date.now() - operationStart;

                  const operationDetails = {
                    type: "db",
                    operation: 'find.' + cursorMethod,
                    collection: collectionName,
                    selector: self._sanitizeDbArg(selector),
                    options: self._sanitizeDbArg(options),
                    duration
                  };

                  // Flag slow queries for analysis
                  if (duration >= self.slowQueryThreshold) {
                    operationDetails.slowQuery = true;
                    operationDetails.queryAnalysis = self._analyzeSlowQuery(
                      collectionName,
                      'find.' + cursorMethod,
                      selector,
                      duration
                    );
                  }

                  // Add operation first and get the reference to the actual object in the operations array
                  const addedOperation = self.addOperation(operationDetails);

                  // Capture index usage with explain() (asynchronously, no user-facing latency)
                  if (self.captureIndexUsage && self._shouldExplainQuery(duration) && addedOperation) {
                    self._log(`Starting explain() for ${collectionName}.find.${cursorMethod}`);

                    // Start explain() immediately but don't block - store promise to await before sending trace
                    const explainPromise = (async () => {
                      try {
                        const indexUsageData = await self._captureIndexUsage(
                          collectionName,
                          selector,
                          options,
                          originalFind
                        );

                        if (indexUsageData) {
                          self._log(`Got explain data for ${collectionName}`);
                          // Merge index usage data into the ACTUAL operation in the array (not the original operationDetails)
                          Object.assign(addedOperation, indexUsageData);

                          // Retroactively flag COLLSCAN on slow query entries
                          if (indexUsageData.indexUsed === 'COLLSCAN' ||
                              (indexUsageData.totalDocsExamined > 0 && indexUsageData.totalKeysExamined === 0)) {
                            const ctx2 = self._currentMethodContext;
                            if (ctx2 && ctx2.slowQueries) {
                              const matchingSQ = ctx2.slowQueries.find(sq =>
                                sq.collection === collectionName && sq.time === addedOperation.time
                              );
                              if (matchingSQ) {
                                matchingSQ.collscan = true;
                                matchingSQ.collscanCollection = collectionName;
                              }
                            }
                          }
                        }
                      } catch (explainError) {
                        // Silently fail - don't impact user queries
                        self._warn(`Failed to capture index usage for ${collectionName}:`, explainError.message);
                      }
                    })();

                    // Store promise in context so we can await it before sending trace (with size limit)
                    const ctx = self._currentMethodContext;
                    if (ctx) {
                      if (!ctx.pendingExplains) {
                        ctx.pendingExplains = [];
                      }
                      // Limit pending explains to prevent unbounded growth
                      if (ctx.pendingExplains.length < 50) {
                        ctx.pendingExplains.push(explainPromise);
                      }
                    }
                  }
                  return result;
                } catch (error) {
                  const duration = Date.now() - operationStart;
                  self.addOperation({
                    type: "db",
                    operation: 'find.' + cursorMethod,
                    collection: collectionName,
                    duration,
                    error: error.message
                  });
                  throw error;
                }
              };
            }
          });

          return cursor;
        };
      }

      this._log("MongoDB operations instrumented");
    } catch (error) {
      this._warn("Failed to instrument MongoDB operations:", error);
    }
  }

  /**
   * Instrument HTTP operations
   */
  _instrumentHttpOperations() {
    const self = this;

    try {
      const { HTTP } =  require('meteor/http');

      if (!HTTP) {
        this._log("HTTP package not available for instrumentation");
        return;
      }

      // Wrap HTTP.call
      const originalCall = HTTP.call;
      if (typeof originalCall === 'function') {
        HTTP.call = function(method, url, options, callback) {
          const operationStart = Date.now();

          // Handle both callback and non-callback versions
          if (typeof callback === 'function') {
            // Callback version
            const wrappedCallback = function(error, result) {
              const duration = Date.now() - operationStart;
              self.addOperation({
                type: "http",
                method: method,
                url: url,
                duration,
                statusCode: result?.statusCode,
                error: error?.message
              });

              return callback(error, result);
            };

            return originalCall.call(this, method, url, options, wrappedCallback);
          } else {
            // Sync version or Promise
            try {
              const result = originalCall.apply(this, arguments);

              const duration = Date.now() - operationStart;
              self.addOperation({
                type: "http",
                method: method,
                url: url,
                duration,
                statusCode: result?.statusCode
              });

              return result;
            } catch (error) {
              const duration = Date.now() - operationStart;
              self.addOperation({
                type: "http",
                method: method,
                url: url,
                duration,
                error: error.message
              });
              throw error;
            }
          }
        };
      }

      // Wrap HTTP method shortcuts (GET, POST, PUT, DELETE, etc.)
      ['get', 'post', 'put', 'del', 'patch', 'head'].forEach(method => {
        const originalMethod = HTTP[method];
        if (typeof originalMethod === 'function') {
          HTTP[method] = function(url, options, callback) {
            const operationStart = Date.now();

            if (typeof callback === 'function') {
              const wrappedCallback = function(error, result) {
                const duration = Date.now() - operationStart;
                self.addOperation({
                  type: "http",
                  method: method.toUpperCase(),
                  url: url,
                  duration,
                  statusCode: result?.statusCode,
                  error: error?.message
                });

                return callback(error, result);
              };

              return originalMethod.call(this, url, options, wrappedCallback);
            } else {
              try {
                const result = originalMethod.apply(this, arguments);

                const duration = Date.now() - operationStart;
                self.addOperation({
                  type: "http",
                  method: method.toUpperCase(),
                  url: url,
                  duration,
                  statusCode: result?.statusCode
                });

                return result;
              } catch (error) {
                const duration = Date.now() - operationStart;
                self.addOperation({
                  type: "http",
                  method: method.toUpperCase(),
                  url: url,
                  duration,
                  error: error.message
                });
                throw error;
              }
            }
          };
        }
      });

      this._log("HTTP operations instrumented");
    } catch (error) {
      this._log("HTTP package not available, skipping instrumentation");
    }
  }

  /**
   * Instrument Fetch operations (meteor/fetch - modern HTTP requests)
   */
  _instrumentFetchOperations() {
    const self = this;

    try {
      // In Meteor 3.x, fetch is a built-in global - directly use global.fetch
      const meteorFetch = global.fetch;

      if (!meteorFetch || typeof meteorFetch !== 'function') {
        return;
      }

      // Store original fetch
      const originalFetch = meteorFetch;

      // Wrap global fetch
      global.fetch = function(url, options = {}) {
        const operationStart = Date.now();

        // CRITICAL: Capture context NOW before async operation
        // When the promise resolves, _currentMethodContext may be cleared
        const context = self._currentMethodContext;

        // Extract HTTP method from options (defaults to GET)
        const method = (options.method || 'GET').toUpperCase();

        // Handle both URL objects and strings
        const urlString = url instanceof URL ? url.href : String(url);

        // Call original fetch and track the operation
        const fetchPromise = originalFetch.call(this, url, options);

        return fetchPromise
          .then(async (response) => {
            const duration = Date.now() - operationStart;

            // Record successful operation using captured context
            if (context && context.operations) {
              const relativeTime = Date.now() - context.startTime;
              context.operations.push({
                type: "http",
                method: method,
                url: urlString,
                duration,
                statusCode: response.status,
                time: relativeTime
              });
            }

            return response;
          })
          .catch((error) => {
            const duration = Date.now() - operationStart;

            // Record failed operation using captured context
            if (context && context.operations) {
              const relativeTime = Date.now() - context.startTime;
              context.operations.push({
                type: "http",
                method: method,
                url: urlString,
                duration,
                error: error.message,
                time: relativeTime
              });
            }

            throw error;
          });
      };
    } catch (error) {
      this._warn("Failed to instrument fetch operations:", error);
    }
  }

  /**
   * Instrument Email operations
   */
  _instrumentEmailOperations() {
    const self = this;

    try {
      const { Email } = require('meteor/email');

      if (!Email) {
        this._log("Email package not available for instrumentation");
        return;
      }

      // Wrap Email.send
      const originalSend = Email.send;
      if (typeof originalSend === 'function') {
        Email.send = function(options) {
          const operationStart = Date.now();

          try {
            const result = originalSend.apply(this, arguments);

            const duration = Date.now() - operationStart;
            self.addOperation({
              type: "email",
              to: Array.isArray(options.to) ? options.to.length : 1,
              subject: options.subject?.substring(0, 50) || "<no subject>",
              duration
            });

            return result;
          } catch (error) {
            const duration = Date.now() - operationStart;
            self.addOperation({
              type: "email",
              to: Array.isArray(options.to) ? options.to.length : 1,
              subject: options.subject?.substring(0, 50) || "<no subject>",
              duration,
              error: error.message
            });
            throw error;
          }
        };
      }

      // Wrap Email.sendAsync if available
      if (typeof Email.sendAsync === 'function') {
        const originalSendAsync = Email.sendAsync;
        Email.sendAsync = async function(options) {
          const operationStart = Date.now();

          try {
            const result = await originalSendAsync.apply(this, arguments);

            const duration = Date.now() - operationStart;
            self.addOperation({
              type: "email",
              to: Array.isArray(options.to) ? options.to.length : 1,
              subject: options.subject?.substring(0, 50) || "<no subject>",
              duration
            });

            return result;
          } catch (error) {
            const duration = Date.now() - operationStart;
            self.addOperation({
              type: "email",
              to: Array.isArray(options.to) ? options.to.length : 1,
              subject: options.subject?.substring(0, 50) || "<no subject>",
              duration,
              error: error.message
            });
            throw error;
          }
        };
      }

      this._log("Email operations instrumented");
    } catch (error) {
      this._log("Email package not available, skipping instrumentation");
    }
  }

  /**
   * Start wait time collectors
   * Initializes MongoDB connection pool monitoring and DDP queue monitoring
   */
  _startWaitTimeCollectors() {
    try {
      // Initialize MongoDB Pool Collector
      // Get MongoDB client from MongoInternals
      let mongoClient = null;

      try {
        const { MongoInternals } = require('meteor/mongo');

        if (MongoInternals && MongoInternals.defaultRemoteCollectionDriver) {
          const driver = MongoInternals.defaultRemoteCollectionDriver();

          if (driver && driver.mongo && driver.mongo.client) {
            mongoClient = driver.mongo.client;
            this._log("Found MongoDB client for pool monitoring");
          } else {
            this._warn("MongoDB client not accessible via driver.mongo.client");
          }
        } else {
          this._warn("MongoInternals not available");
        }
      } catch (error) {
        this._warn("Could not access MongoInternals:", error.message);
      }

      if (mongoClient) {
        this.mongoPoolCollector = new MongoPoolCollector({
          client: mongoClient,
          enabled: true
        });
        this.mongoPoolCollector.start();
      } else {
        this._warn("Skipping MongoDB pool monitoring - client not available");
      }

      // Initialize DDP Queue Collector
      this.ddpQueueCollector = new DDPQueueCollector({
        enabled: true
      });
      this.ddpQueueCollector.start();

    } catch (error) {
      this._warn("Failed to start wait time collectors:", error);
    }
  }

  /**
   * Determines if a query should be explained based on configuration
   * @param {number} duration - Query duration in ms
   * @returns {boolean} - True if query should be explained
   */
  _shouldExplainQuery(duration) {
    // If explainSlowQueriesOnly is true, only explain slow queries
    if (this.explainSlowQueriesOnly) {
      return duration >= this.slowQueryThreshold;
    }

    // Otherwise, use sampling rate
    return Math.random() < this.indexUsageSampleRate;
  }

  /**
   * Captures index usage data by running explain() on a cursor
   * @param {string} collectionName - Name of the collection
   * @param {Object} selector - Query selector
   * @param {Object} options - Query options
   * @param {Function} originalFind - Original find function
   * @returns {Promise<Object|null>} - Index usage data or null
   */
  async _captureIndexUsage(collectionName, selector, options, originalFind) {
    try {
      // Access the MongoDB collection to run explain
      const { MongoInternals } = require('meteor/mongo');
      const driver = MongoInternals.defaultRemoteCollectionDriver();

      if (!driver || !driver.mongo || !driver.mongo.db) {
        return null;
      }

      const rawCollection = driver.mongo.db.collection(collectionName);

      // Create a new cursor with the same query
      const cursor = rawCollection.find(selector || {}, options || {});

      // Run explain with the configured verbosity
      const explainResult = await cursor.explain(this.explainVerbosity);

      // Extract executionStats from explain result
      return this._extractIndexUsageMetrics(explainResult);
    } catch (error) {
      // Silently log and return null - don't break the operation
      this._warn(`Failed to capture index usage for ${collectionName}:`, error.message);
      return null;
    }
  }

  /**
   * Captures index usage for aggregation pipelines via explain()
   * @param {String} collectionName - Name of the collection
   * @param {Array} pipeline - Aggregation pipeline stages
   * @param {Object} options - Aggregation options
   * @param {Function} originalAggregate - Original aggregate function reference
   * @returns {Promise<Object|null>} - Index usage metrics or null
   */
  async _captureAggregationIndexUsage(collectionName, pipeline, options, originalAggregate) {
    try {
      const { MongoInternals } = require('meteor/mongo');
      const driver = MongoInternals.defaultRemoteCollectionDriver();

      if (!driver || !driver.mongo || !driver.mongo.db) {
        return null;
      }

      const rawCollection = driver.mongo.db.collection(collectionName);

      // Run explain() on the aggregation pipeline
      // MongoDB aggregation explain returns a cursor that needs to be consumed
      const explainCursor = rawCollection.aggregate(pipeline, {
        ...(options || {}),
        explain: true
      });

      // Get the actual explain data from the cursor
      const explainData = await explainCursor.toArray();
      const explainResult = explainData[0]; // Explain returns single document

      return this._extractAggregationIndexUsageMetrics(explainResult);
    } catch (error) {
      this._warn(`Failed to capture aggregation index usage for ${collectionName}:`, error.message);
      return null;
    }
  }

  /**
   * Extracts index usage metrics from MongoDB aggregation explain result
   * Handles various explain formats including $facet pipelines and different MongoDB versions
   * @param {Object} explainResult - MongoDB aggregation explain() output
   * @returns {Object} - Extracted metrics
   */
  _extractAggregationIndexUsageMetrics(explainResult) {
    const metrics = {};

    try {
      // Initialize aggregated stats
      let indexesUsed = [];
      let totalDocsExamined = 0;
      let totalKeysExamined = 0;
      let nReturned = 0;
      let executionTimeMillis = 0;

      // Try to extract stats from various explain formats
      const stages = explainResult.stages || [];

      // 1. Check for $cursor stage (standard aggregation format)
      const cursorStage = stages.find(stage => stage.$cursor);
      if (cursorStage && cursorStage.$cursor) {
        const extracted = this._extractStatsFromCursorStage(cursorStage.$cursor);
        if (extracted.indexUsed) indexesUsed.push(extracted.indexUsed);
        totalDocsExamined += extracted.totalDocsExamined;
        totalKeysExamined += extracted.totalKeysExamined;
        nReturned += extracted.nReturned;
        executionTimeMillis = Math.max(executionTimeMillis, extracted.executionTimeMillis);
      }

      // 2. Check for $facet stages (complex pipelines with sub-pipelines)
      const facetStage = stages.find(stage => stage.$facet);
      if (facetStage && facetStage.$facet) {
        const facetStats = this._extractStatsFromFacetStage(facetStage.$facet);
        indexesUsed = indexesUsed.concat(facetStats.indexesUsed);
        totalDocsExamined += facetStats.totalDocsExamined;
        totalKeysExamined += facetStats.totalKeysExamined;
        nReturned += facetStats.nReturned;
        executionTimeMillis = Math.max(executionTimeMillis, facetStats.executionTimeMillis);
      }

      // 3. Check for top-level executionStats (MongoDB 5.0+ format)
      if (explainResult.executionStats) {
        totalDocsExamined += explainResult.executionStats.totalDocsExamined || 0;
        totalKeysExamined += explainResult.executionStats.totalKeysExamined || 0;
        nReturned += explainResult.executionStats.nReturned || 0;
        executionTimeMillis = Math.max(executionTimeMillis, explainResult.executionStats.executionTimeMillis || 0);
      }

      // 4. Check for top-level queryPlanner (MongoDB 5.0+ format)
      if (explainResult.queryPlanner && explainResult.queryPlanner.winningPlan) {
        const idx = this._extractIndexFromPlan(explainResult.queryPlanner.winningPlan);
        if (idx && idx !== 'UNKNOWN') indexesUsed.push(idx);
      }

      // 5. Recursively search all stages for any nested execution stats we might have missed
      for (const stage of stages) {
        const nestedStats = this._extractStatsFromNestedStage(stage);
        if (nestedStats) {
          if (nestedStats.indexUsed && !indexesUsed.includes(nestedStats.indexUsed)) {
            indexesUsed.push(nestedStats.indexUsed);
          }
          // Only add if we haven't captured these stats yet
          if (totalDocsExamined === 0 && nestedStats.totalDocsExamined > 0) {
            totalDocsExamined = nestedStats.totalDocsExamined;
            totalKeysExamined = nestedStats.totalKeysExamined;
            nReturned = nestedStats.nReturned;
            executionTimeMillis = nestedStats.executionTimeMillis;
          }
        }
      }

      // Determine primary index used (prefer actual index names over COLLSCAN)
      const actualIndexes = indexesUsed.filter(idx => idx && idx !== 'COLLSCAN' && idx !== 'UNKNOWN');
      let indexUsed;
      if (actualIndexes.length > 0) {
        indexUsed = actualIndexes[0]; // Use first actual index
      } else if (indexesUsed.includes('COLLSCAN')) {
        indexUsed = 'COLLSCAN';
      } else if (indexesUsed.length > 0) {
        indexUsed = indexesUsed[0];
      } else {
        // No index info found - check if we have any indication of collection scan
        indexUsed = totalDocsExamined > 0 && totalKeysExamined === 0 ? 'COLLSCAN' : 'UNKNOWN';
      }

      metrics.indexUsed = indexUsed;
      metrics.executionTimeMillis = executionTimeMillis;
      metrics.totalDocsExamined = totalDocsExamined;
      metrics.totalKeysExamined = totalKeysExamined;
      metrics.nReturned = nReturned;

      // Calculate efficiency metrics
      if (totalDocsExamined > 0) {
        metrics.efficiency = Math.round((nReturned / totalDocsExamined) * 100);
      } else if (nReturned > 0) {
        // Docs returned but none examined - efficient (likely from index)
        metrics.efficiency = 100;
      } else {
        // No data - don't assume 100%
        metrics.efficiency = 0;
      }

      if (totalKeysExamined > 0) {
        metrics.indexEfficiency = Math.round((nReturned / totalKeysExamined) * 100);
      } else if (indexUsed && indexUsed !== 'COLLSCAN' && indexUsed !== 'UNKNOWN') {
        metrics.indexEfficiency = 100;
      } else {
        metrics.indexEfficiency = 0;
      }
    } catch (error) {
      this._warn('Failed to extract aggregation index usage metrics:', error.message);
    }

    return metrics;
  }

  /**
   * Extracts stats from a $cursor stage in aggregation explain
   * @private
   */
  _extractStatsFromCursorStage(cursorData) {
    const result = {
      indexUsed: null,
      totalDocsExamined: 0,
      totalKeysExamined: 0,
      nReturned: 0,
      executionTimeMillis: 0
    };

    try {
      if (cursorData.queryPlanner && cursorData.queryPlanner.winningPlan) {
        result.indexUsed = this._extractIndexFromPlan(cursorData.queryPlanner.winningPlan);
      }

      if (cursorData.executionStats) {
        result.totalDocsExamined = cursorData.executionStats.totalDocsExamined || 0;
        result.totalKeysExamined = cursorData.executionStats.totalKeysExamined || 0;
        result.nReturned = cursorData.executionStats.nReturned || 0;
        result.executionTimeMillis = cursorData.executionStats.executionTimeMillis || 0;
      }
    } catch (e) {
      // Silently fail - partial data is fine
    }

    return result;
  }

  /**
   * Extracts aggregated stats from a $facet stage
   * $facet contains multiple sub-pipelines, each with their own execution stats
   * @private
   */
  _extractStatsFromFacetStage(facetData) {
    const result = {
      indexesUsed: [],
      totalDocsExamined: 0,
      totalKeysExamined: 0,
      nReturned: 0,
      executionTimeMillis: 0
    };

    try {
      // facetData is an object where keys are facet names and values are pipeline execution info
      for (const [facetName, facetPipeline] of Object.entries(facetData)) {
        // Each facet may have stages array with execution info
        if (Array.isArray(facetPipeline)) {
          for (const stage of facetPipeline) {
            const nestedStats = this._extractStatsFromNestedStage(stage);
            if (nestedStats) {
              if (nestedStats.indexUsed) result.indexesUsed.push(nestedStats.indexUsed);
              result.totalDocsExamined += nestedStats.totalDocsExamined;
              result.totalKeysExamined += nestedStats.totalKeysExamined;
              result.nReturned += nestedStats.nReturned;
              result.executionTimeMillis = Math.max(result.executionTimeMillis, nestedStats.executionTimeMillis);
            }
          }
        } else if (facetPipeline && typeof facetPipeline === 'object') {
          // MongoDB might also return facet data as objects with executionStats
          if (facetPipeline.executionStats) {
            result.totalDocsExamined += facetPipeline.executionStats.totalDocsExamined || 0;
            result.totalKeysExamined += facetPipeline.executionStats.totalKeysExamined || 0;
            result.nReturned += facetPipeline.executionStats.nReturned || 0;
            result.executionTimeMillis = Math.max(result.executionTimeMillis, facetPipeline.executionStats.executionTimeMillis || 0);
          }
          if (facetPipeline.queryPlanner && facetPipeline.queryPlanner.winningPlan) {
            const idx = this._extractIndexFromPlan(facetPipeline.queryPlanner.winningPlan);
            if (idx) result.indexesUsed.push(idx);
          }
        }
      }
    } catch (e) {
      // Silently fail - partial data is fine
    }

    return result;
  }

  /**
   * Recursively extracts stats from any nested stage structure
   * Handles various MongoDB explain formats
   * @private
   */
  _extractStatsFromNestedStage(stage) {
    if (!stage || typeof stage !== 'object') return null;

    const result = {
      indexUsed: null,
      totalDocsExamined: 0,
      totalKeysExamined: 0,
      nReturned: 0,
      executionTimeMillis: 0
    };

    try {
      // Check for $cursor nested inside any stage
      if (stage.$cursor) {
        return this._extractStatsFromCursorStage(stage.$cursor);
      }

      // Check for direct executionStats on the stage
      if (stage.executionStats) {
        result.totalDocsExamined = stage.executionStats.totalDocsExamined || 0;
        result.totalKeysExamined = stage.executionStats.totalKeysExamined || 0;
        result.nReturned = stage.executionStats.nReturned || 0;
        result.executionTimeMillis = stage.executionStats.executionTimeMillis || 0;
      }

      // Check for queryPlanner on the stage
      if (stage.queryPlanner && stage.queryPlanner.winningPlan) {
        result.indexUsed = this._extractIndexFromPlan(stage.queryPlanner.winningPlan);
      }

      // Check for inputStage (recursive query plan structure)
      if (stage.inputStage) {
        const inputStats = this._extractStatsFromNestedStage(stage.inputStage);
        if (inputStats) {
          if (!result.indexUsed && inputStats.indexUsed) result.indexUsed = inputStats.indexUsed;
          if (result.totalDocsExamined === 0) result.totalDocsExamined = inputStats.totalDocsExamined;
          if (result.totalKeysExamined === 0) result.totalKeysExamined = inputStats.totalKeysExamined;
          if (result.nReturned === 0) result.nReturned = inputStats.nReturned;
        }
      }

      // Only return if we found some data
      if (result.indexUsed || result.totalDocsExamined > 0 || result.nReturned > 0) {
        return result;
      }
    } catch (e) {
      // Silently fail
    }

    return null;
  }

  /**
   * Extracts index usage metrics from MongoDB explain result
   * @param {Object} explainResult - MongoDB explain() output
   * @returns {Object} - Extracted metrics
   */
  _extractIndexUsageMetrics(explainResult) {
    const metrics = {};

    try {
      // executionStats is available when verbosity is 'executionStats' or 'allPlansExecution'
      const executionStats = explainResult.executionStats;

      if (!executionStats) {
        // If only queryPlanner verbosity, extract index from winning plan
        const winningPlan = explainResult.queryPlanner?.winningPlan;
        if (winningPlan) {
          metrics.indexUsed = this._extractIndexFromPlan(winningPlan);
        }
        return metrics;
      }

      // Extract key metrics from executionStats
      metrics.executionTimeMillis = executionStats.executionTimeMillis || 0;
      metrics.totalDocsExamined = executionStats.totalDocsExamined || 0;
      metrics.totalKeysExamined = executionStats.totalKeysExamined || 0;
      metrics.nReturned = executionStats.nReturned || 0;

      // Determine which index was used (or if it was a collection scan)
      const winningPlan = explainResult.queryPlanner?.winningPlan;
      metrics.indexUsed = this._extractIndexFromPlan(winningPlan);

      // Calculate efficiency metrics
      if (metrics.totalDocsExamined > 0) {
        metrics.efficiency = Math.round((metrics.nReturned / metrics.totalDocsExamined) * 100);
      } else {
        metrics.efficiency = 100; // No docs examined, perfect efficiency
      }

      if (metrics.totalKeysExamined > 0) {
        metrics.indexEfficiency = Math.round((metrics.nReturned / metrics.totalKeysExamined) * 100);
      } else if (metrics.indexUsed && metrics.indexUsed !== 'COLLSCAN') {
        metrics.indexEfficiency = 100; // Index used but no keys examined
      } else {
        metrics.indexEfficiency = 0; // Collection scan
      }

    } catch (error) {
      this._warn('Failed to extract index usage metrics:', error.message);
    }

    return metrics;
  }

  /**
   * Extracts index name from query plan
   * @param {Object} plan - Query plan from explain result
   * @returns {string} - Index name or "COLLSCAN"
   */
  _extractIndexFromPlan(plan) {
    if (!plan) return 'UNKNOWN';

    // Check if it's a collection scan
    if (plan.stage === 'COLLSCAN') {
      return 'COLLSCAN';
    }

    // Check for index scan stages
    if (plan.stage === 'IXSCAN' && plan.indexName) {
      return plan.indexName;
    }

    // Recursively check input stages
    if (plan.inputStage) {
      return this._extractIndexFromPlan(plan.inputStage);
    }

    // Check shards for sharded clusters
    if (plan.shards && plan.shards.length > 0) {
      // Use first shard's plan (they should all be the same)
      return this._extractIndexFromPlan(plan.shards[0].winningPlan);
    }

    return 'UNKNOWN';
  }
}
