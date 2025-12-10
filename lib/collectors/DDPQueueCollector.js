import { Meteor } from 'meteor/meteor';

/**
 * DDPQueueCollector
 *
 * Tracks DDP message queue wait time in Meteor applications.
 * Measures how long methods and subscriptions wait in the DDP message queue
 * before they can start executing.
 *
 * Also tracks "waitedOn" time - how long the current operation blocks
 * subsequent operations in the queue.
 */
export default class DDPQueueCollector {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;

    // Store wait lists for messages (who they're waiting for)
    this.waitLists = {};

    // Track currently processing message per session
    this.currentProcessing = {};

    // Cache message metadata (with size limit to prevent memory leaks)
    this.messageCache = {};
    this.messageCacheMaxSize = 5000; // Maximum entries before cleanup
    this.messageCacheTTL = 300000; // 5 minutes TTL for cache entries

    // Store original methods for restoration
    this.originalMethods = {};

    // Periodic cleanup interval for message cache
    this.cacheCleanupInterval = null;

    this.started = false;
  }

  start() {
    if (!this.enabled || this.started) {
      return;
    }

    try {
      this._hijackSessionProcessing();

      // Start periodic message cache cleanup (every 60 seconds)
      this.cacheCleanupInterval = setInterval(() => {
        this._cleanupMessageCache();
      }, 60000);

      this.started = true;
      console.log('✅ DDPQueueCollector: DDP queue monitoring started');
    } catch (error) {
      console.error('⚠️ DDPQueueCollector: Failed to start:', error.message);
      console.error(error.stack);
    }
  }

  stop() {
    if (!this.started) {
      return;
    }

    // Stop periodic cache cleanup
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
      this.cacheCleanupInterval = null;
    }

    // Stop polling for sessions
    if (this.sessionPollInterval) {
      clearInterval(this.sessionPollInterval);
      this.sessionPollInterval = null;
    }

    // Clear wrapped sessions tracking
    if (this.wrappedSessions) {
      this.wrappedSessions.clear();
    }

    // Restore original methods
    this._restoreOriginalMethods();

    // Clear state
    this.waitLists = {};
    this.currentProcessing = {};
    this.messageCache = {};

    this.started = false;
    console.log('DDPQueueCollector stopped');
  }

  /**
   * Hijack Meteor's Session message processing
   * New approach: Poll for new sessions and wrap them
   */
  _hijackSessionProcessing() {
    try {
      const self = this;

      // Track which sessions we've already wrapped
      this.wrappedSessions = new Set();

      // Poll for new sessions every 5 seconds (reduced from 100ms to save CPU)
      // Most sessions are wrapped immediately, this is just a safety net
      this.sessionPollInterval = setInterval(() => {
        if (Meteor.server.sessions instanceof Map) {
          Meteor.server.sessions.forEach((session, sessionId) => {
            // Only wrap if we haven't wrapped this session yet
            if (!self.wrappedSessions.has(sessionId)) {
              self._wrapSession(session);
              self.wrappedSessions.add(sessionId);
            }
          });
        }
      }, 5000);

      // Also wrap any existing sessions immediately
      if (Meteor.server.sessions instanceof Map) {
        Meteor.server.sessions.forEach((session, sessionId) => {
          self._wrapSession(session);
          self.wrappedSessions.add(sessionId);
        });
      }

      console.log('✅ DDPQueueCollector: Polling for new sessions');

    } catch (error) {
      console.error('⚠️ DDPQueueCollector: Error hijacking session:', error);
      throw error;
    }
  }

  /**
   * Wrap an individual session object
   */
  _wrapSession(session) {
    try {
      // Check if session has the methods we need
      if (!session.processMessage) {
        console.warn('⚠️ DDPQueueCollector: Session missing processMessage');
        return;
      }

      const sessionId = session.id;

      // Hijack processMessage for this specific session
      this._hijackProcessMessage(session);

      // Hijack method handler for this specific session
      this._hijackMethodHandler(session);

      // Hijack subscription handler for this specific session
      this._hijackSubHandler(session);

      // Track session close to clean up wrappedSessions Set
      if (session.connectionHandle && session.connectionHandle.onClose) {
        session.connectionHandle.onClose(() => {
          if (this.wrappedSessions) {
            this.wrappedSessions.delete(sessionId);
          }
          // Clean up ALL wait lists for this session (keys are ${sessionId}::${msgId})
          const prefix = `${sessionId}::`;
          for (const key of Object.keys(this.waitLists)) {
            if (key.startsWith(prefix)) {
              delete this.waitLists[key];
            }
          }
          delete this.currentProcessing[sessionId];
        });
      }

    } catch (error) {
      console.error('⚠️ DDPQueueCollector: Error wrapping session:', error);
    }
  }

  /**
   * Hijack Session.processMessage to register queue position
   */
  _hijackProcessMessage(session) {
    const self = this;

    // Get the current processMessage (might already be wrapped by another collector)
    // We need to call THIS version, not the original, to chain properly
    const currentProcessMessage = session.processMessage;

    if (!currentProcessMessage) {
      console.warn('⚠️ DDPQueueCollector: processMessage not found');
      return;
    }

    // Store true original only if not already stored
    if (!session._skySignalOriginalProcessMessage) {
      session._skySignalOriginalProcessMessage = currentProcessMessage;
    }

    session.processMessage = function (msg) {
      // Only track methods and subscriptions
      if (msg.msg === 'method' || msg.msg === 'sub') {
        // Register message position in queue
        self.registerMessage(this, msg);

        // Record when message enters queue
        msg._queueEnterTime = Date.now();
      }

      // Call the version we captured (chains to other wrappers if present)
      return currentProcessMessage.call(this, msg);
    };
  }

  /**
   * Hijack method handler to track wait time
   */
  _hijackMethodHandler(session) {
    const self = this;

    if (!session.protocol_handlers || !session.protocol_handlers.method) {
      console.warn('⚠️ DDPQueueCollector: method handler not found');
      return;
    }

    // Get the current handler (might already be wrapped by another collector)
    const currentMethodHandler = session.protocol_handlers.method;

    // Store true original only if not already stored
    if (!session._skySignalOriginalMethodHandler) {
      session._skySignalOriginalMethodHandler = currentMethodHandler;
    }

    session.protocol_handlers.method = function (msg, unblock) {
      // Check if we're tracking this message
      if (msg._queueEnterTime) {
        // Calculate wait time
        const waitTime = Date.now() - msg._queueEnterTime;

        // Build wait list (who we waited for)
        const waitList = self.buildWaitList(this, msg.id);

        // Record DDP wait time in trace (pass session ID)
        self._recordDDPWaitTime(waitTime, waitList, msg, this.id);

        // Wrap unblock to track blocking time
        unblock = self.wrapUnblock(this, msg, unblock);
      }

      // Call the version we captured (chains to other wrappers if present)
      try {
        return currentMethodHandler.call(this, msg, unblock);
      } finally {
        // Ensure unblock is called even if handler throws
        if (typeof unblock === 'function') {
          try {
            unblock();
          } catch (e) {
            // Unblock might have already been called
          }
        }
      }
    };
  }

  /**
   * Hijack subscription handler to track wait time
   */
  _hijackSubHandler(session) {
    const self = this;

    if (!session.protocol_handlers || !session.protocol_handlers.sub) {
      console.warn('⚠️ DDPQueueCollector: sub handler not found');
      return;
    }

    // Get the current handler (might already be wrapped by another collector)
    const currentSubHandler = session.protocol_handlers.sub;

    // Store true original only if not already stored
    if (!session._skySignalOriginalSubHandler) {
      session._skySignalOriginalSubHandler = currentSubHandler;
    }

    session.protocol_handlers.sub = function (msg, unblock) {
      // Check if we're tracking this message
      if (msg._queueEnterTime) {
        // Calculate wait time
        const waitTime = Date.now() - msg._queueEnterTime;

        // Build wait list
        const waitList = self.buildWaitList(this, msg.id);

        // Record DDP wait time (pass session ID)
        self._recordDDPWaitTime(waitTime, waitList, msg, this.id);

        // Wrap unblock to track blocking time
        unblock = self.wrapUnblock(this, msg, unblock);
      }

      // Call the version we captured (chains to other wrappers if present)
      return currentSubHandler.call(this, msg, unblock);
    };
  }

  /**
   * Register a message's position in the queue
   * Captures all messages that are ahead of this message
   */
  registerMessage(session, msg) {
    try {
      const key = `${session.id}::${msg.id}`;

      // Capture queue snapshot - messages ahead of this one
      const inQueue = session.inQueue ? this._toArray(session.inQueue) : [];

      const waitList = inQueue.map(m => this._cacheMessage(session, m));

      // Add currently processing message to wait list
      if (this.currentProcessing[session.id]) {
        const currentMsg = this.currentProcessing[session.id];
        waitList.unshift(this._cacheMessage(session, currentMsg));
      }

      // Store wait list
      this.waitLists[key] = waitList;

    } catch (error) {
      console.error('⚠️ DDPQueueCollector: Error registering message:', error);
    }
  }

  /**
   * Build wait list for a message (retrieve and clean up)
   */
  buildWaitList(session, msgId) {
    const key = `${session.id}::${msgId}`;
    const waitList = this.waitLists[key] || [];

    // Clean up
    delete this.waitLists[key];

    return waitList;
  }

  /**
   * Wrap unblock to track how long this operation blocks others
   */
  wrapUnblock(session, msg, originalUnblock) {
    const self = this;
    const startTime = Date.now();

    // Mark this message as currently processing
    this.currentProcessing[session.id] = msg;

    let unblocked = false;

    return function () {
      if (unblocked) {
        return; // Already unblocked
      }

      try {
        const blockingTime = Date.now() - startTime;

        // Calculate "waitedOn" metric - how much this operation blocked others
        const waitedOn = self.calculateWaitedOn(session, startTime);

        // Record blocking metrics (pass session ID)
        self._recordBlockingTime(msg, blockingTime, waitedOn, session.id);

        // Clear currently processing
        delete self.currentProcessing[session.id];

        unblocked = true;

        // Call original unblock
        if (typeof originalUnblock === 'function') {
          originalUnblock();
        }

      } catch (error) {
        console.error('⚠️ DDPQueueCollector: Error in wrapped unblock:', error);

        // Still try to call original unblock
        if (typeof originalUnblock === 'function') {
          try {
            originalUnblock();
          } catch (e) {
            // Ignore
          }
        }
      }
    };
  }

  /**
   * Calculate how much wait time this operation imposed on other queued messages
   */
  calculateWaitedOn(session, startTime) {
    let waitedOnTime = 0;
    const now = Date.now();

    try {
      const inQueue = session.inQueue ? this._toArray(session.inQueue) : [];

      inQueue.forEach(msg => {
        if (msg._queueEnterTime) {
          // How long this message has been waiting
          let msgWaitTime = now - msg._queueEnterTime;

          // Adjust if message started waiting before we started processing
          if (msg._queueEnterTime < startTime) {
            msgWaitTime = now - startTime;
          }

          if (msgWaitTime > 0) {
            waitedOnTime += msgWaitTime;
          }
        }
      });

    } catch (error) {
      console.error('⚠️ DDPQueueCollector: Error calculating waitedOn:', error);
    }

    return waitedOnTime;
  }

  /**
   * Store DDP wait time for later retrieval by MethodTracer
   * We can't write to context yet because the method hasn't started executing
   */
  _recordDDPWaitTime(waitTime, waitList, msg, sessionId) {
    try {
      // Initialize global storage for pending wait times
      if (!global._skySignalWaitTimeBySession) {
        global._skySignalWaitTimeBySession = {};
      }

      // Store wait time data by session ID
      // Methods run sequentially per session, so this is safe
      global._skySignalWaitTimeBySession[sessionId] = {
        ddp: waitTime,
        ddpWaitList: waitList,
        messageInfo: {
          msg: msg.msg,
          id: msg.id,
          name: msg.method || msg.name,
          queuedAt: msg._queueEnterTime
        },
        timestamp: Date.now()
      };

    } catch (error) {
      console.error('⚠️ DDPQueueCollector: Error recording DDP wait time:', error);
    }
  }

  /**
   * Store blocking time metrics for later retrieval by MethodTracer
   */
  _recordBlockingTime(msg, blockingTime, waitedOn, sessionId) {
    try {
      // Initialize global storage
      if (!global._skySignalWaitTimeBySession) {
        global._skySignalWaitTimeBySession = {};
      }

      // Add blocking metrics to existing wait time data
      if (global._skySignalWaitTimeBySession[sessionId]) {
        global._skySignalWaitTimeBySession[sessionId].blockingTime = blockingTime;
        global._skySignalWaitTimeBySession[sessionId].waitedOn = waitedOn;
      }

    } catch (error) {
      console.error('⚠️ DDPQueueCollector: Error recording blocking time:', error);
    }
  }

  /**
   * Cache message metadata for wait list
   * Includes cleanup logic to prevent unbounded memory growth
   */
  _cacheMessage(session, msg) {
    const key = `${session.id}::${msg.id}`;
    const now = Date.now();

    if (!this.messageCache[key]) {
      // Cleanup old entries if cache is too large
      const cacheSize = Object.keys(this.messageCache).length;
      if (cacheSize >= this.messageCacheMaxSize) {
        this._cleanupMessageCache(now);
      }

      this.messageCache[key] = {
        msg: msg.msg,
        id: msg.id,
        name: msg.method || msg.name,
        queuedAt: msg._queueEnterTime || now,
        cachedAt: now // Track when entry was cached for TTL cleanup
      };
    }

    return this.messageCache[key];
  }

  /**
   * Cleanup stale message cache entries
   * Removes entries older than TTL or excess entries by age
   */
  _cleanupMessageCache(now = Date.now()) {
    const entries = Object.entries(this.messageCache);
    const expireThreshold = now - this.messageCacheTTL;

    // Remove entries older than TTL
    let removed = 0;
    for (const [key, entry] of entries) {
      if (entry.cachedAt < expireThreshold) {
        delete this.messageCache[key];
        removed++;
      }
    }

    // If still too large, remove oldest entries until under limit
    if (Object.keys(this.messageCache).length >= this.messageCacheMaxSize) {
      const sorted = Object.entries(this.messageCache)
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt);

      const toRemove = sorted.length - Math.floor(this.messageCacheMaxSize * 0.8);
      for (let i = 0; i < toRemove && i < sorted.length; i++) {
        delete this.messageCache[sorted[i][0]];
        removed++;
      }
    }
  }

  /**
   * Convert inQueue to array (handles both array and object)
   */
  _toArray(inQueue) {
    if (Array.isArray(inQueue)) {
      return inQueue;
    }

    if (inQueue && typeof inQueue.toArray === 'function') {
      return inQueue.toArray();
    }

    // Try to iterate
    if (inQueue && typeof inQueue === 'object') {
      const result = [];
      for (const key in inQueue) {
        if (inQueue.hasOwnProperty(key)) {
          result.push(inQueue[key]);
        }
      }
      return result;
    }

    return [];
  }

  /**
   * Restore original methods
   */
  _restoreOriginalMethods() {
    try {
      const Session = Meteor.server.sessions?.constructor;

      if (!Session || !Session.prototype) {
        return;
      }

      const sessionProto = Session.prototype;

      // Restore processMessage
      if (this.originalMethods.processMessage) {
        sessionProto.processMessage = this.originalMethods.processMessage;
      }

      // Restore method handler
      if (this.originalMethods.methodHandler && sessionProto.protocol_handlers) {
        sessionProto.protocol_handlers.method = this.originalMethods.methodHandler;
      }

      // Restore sub handler
      if (this.originalMethods.subHandler && sessionProto.protocol_handlers) {
        sessionProto.protocol_handlers.sub = this.originalMethods.subHandler;
      }

    } catch (error) {
      console.error('⚠️ DDPQueueCollector: Error restoring methods:', error);
    }
  }

  /**
   * Get collector metrics
   */
  getMetrics() {
    return {
      activeWaitLists: Object.keys(this.waitLists).length,
      currentlyProcessing: Object.keys(this.currentProcessing).length,
      cachedMessages: Object.keys(this.messageCache).length
    };
  }
}
