/**
 * Factory for mock DDP session objects that simulate Meteor server sessions.
 */

let sessionCounter = 0;

/**
 * Create a mock DDP session with processMessage, protocol_handlers, etc.
 *
 * @param {string} [id] - Session ID (auto-generated if omitted)
 * @returns {Object} Mock session
 */
function createMockSession(id) {
  const sessionId = id || `test-session-${++sessionCounter}`;
  const closeCallbacks = [];

  const session = {
    id: sessionId,

    // Message queue
    inQueue: [],

    // processMessage — base implementation just pushes to inQueue
    processMessage(msg) {
      // no-op in base mock; tests replace this
    },

    // Protocol handlers
    protocol_handlers: {
      method(msg, unblock) {
        // Base no-op; tests override as needed
      },
      sub(msg, unblock) {
        // Base no-op
      }
    },

    // Connection handle with onClose
    connectionHandle: {
      onClose(cb) {
        closeCallbacks.push(cb);
      }
    },

    // --- Test helpers ---

    /** Simulate connection close (fires onClose callbacks) */
    _simulateClose() {
      for (const cb of closeCallbacks) {
        cb();
      }
    },

    /** Get registered close callbacks */
    _getCloseCallbacks() {
      return closeCallbacks;
    }
  };

  return session;
}

module.exports = { createMockSession };
