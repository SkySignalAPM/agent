import { Meteor } from "meteor/meteor";
import { DDP } from "meteor/ddp-client";
import { Accounts } from "meteor/accounts-base";

/**
 * Extract the DDP "msg" field from a serialized DDP string without JSON.parse.
 * DDP messages always contain "msg":"<type>" near the start.
 * Returns the msg type string or null if not found.
 * @private
 */
function extractMsgType(str) {
	const idx = str.indexOf('"msg":"');
	if (idx === -1) return null;
	const start = idx + 7; // length of '"msg":"'
	const end = str.indexOf('"', start);
	if (end === -1) return null;
	return str.substring(start, end);
}

/**
 * Lightweight object size estimate for DDP messages.
 * Avoids JSON.stringify — counts string keys/values and estimates the rest.
 * Returns an approximate byte count.
 * @private
 */
function estimateMsgSize(msg) {
	if (typeof msg !== "object" || msg === null) return 8;
	let size = 16; // base object overhead
	for (const key in msg) {
		const val = msg[key];
		size += key.length * 2 + 4; // key + separator overhead
		if (typeof val === "string") size += val.length * 2;
		else if (typeof val === "number") size += 8;
		else if (typeof val === "boolean") size += 4;
		else if (typeof val === "object" && val !== null) size += 64; // rough estimate for nested objects
		else size += 8;
	}
	return size;
}

/**
 * DDPCollector
 * Tracks DDP/WebSocket connection metrics, message types, latency, and bandwidth
 */
export default class DDPCollector {
	constructor(options = {}) {
		this.client = options.client;
		this.appVersion = options.appVersion || "unknown";
		this.buildHash = options.buildHash || null;
		this.interval = options.interval || 30000; // 30 seconds default
		this.connections = new Map(); // Map of connectionId -> connection data
		this.subscriptions = new Map(); // Map of subscriptionId -> subscription data
		this.debug = options.debug || false;
		this.intervalId = null;

		// DDP message type tracking setup
		this.messageTypeMap = {
			connect: "connect",
			connected: "connected",
			method: "method",
			result: "result",
			sub: "sub",
			unsub: "unsub",
			nosub: "nosub",
			ready: "ready",
			added: "added",
			changed: "changed",
			removed: "removed",
			ping: "ping",
			pong: "pong"
		};
	}

	/**
	 * Start collecting DDP connection data
	 */
	/** @private */
	_log(...args) {
		if (this.debug) {
			console.log('[SkySignal:DDP]', ...args);
		}
	}

	start() {
		if (this.intervalId) {
			console.warn("⚠️ DDPCollector already started");
			return;
		}

		// Hook into Meteor.onConnection to track new connections
		this._setupConnectionTracking();

		// Send updates at regular intervals
		this.intervalId = setInterval(() => {
			this._sendUpdates();
		}, this.interval);

		this._log(`Started (interval: ${this.interval}ms)`);
	}

	/**
	 * Stop collecting DDP connection data
	 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		// Stop polling for sessions
		if (this.sessionPollInterval) {
			clearInterval(this.sessionPollInterval);
			this.sessionPollInterval = null;
		}

		// Stop Accounts event listeners
		if (this._loginHandle) {
			this._loginHandle.stop();
			this._loginHandle = null;
		}
		if (this._logoutHandle) {
			this._logoutHandle.stop();
			this._logoutHandle = null;
		}

		// Clear wrapped sessions tracking
		if (this.wrappedSessions) {
			this.wrappedSessions.clear();
		}

		// Clean up connection tracking
		this.connections.clear();

		// Clean up subscription tracking
		if (this.subscriptions) {
			this.subscriptions.clear();
		}

		this._log("Stopped");
	}

	/**
	 * Setup connection tracking using Meteor.onConnection
	 * @private
	 */
	_setupConnectionTracking() {
		// Track which sessions we've already wrapped
		this.wrappedSessions = new Set();

		// Poll for new sessions every 5 seconds (reduced from 100ms to save CPU)
		// Most sessions are wrapped immediately, this is just a safety net
		this.sessionPollInterval = setInterval(() => {
			if (Meteor.server.sessions instanceof Map) {
				Meteor.server.sessions.forEach((session, sessionId) => {
					// Only wrap if we haven't wrapped this session yet
					if (!this.wrappedSessions.has(sessionId)) {
						this._wrapSession(session);
						this.wrappedSessions.add(sessionId);
					}
				});
			}
		}, 5000);

		// Also wrap any existing sessions immediately
		if (Meteor.server.sessions instanceof Map) {
			Meteor.server.sessions.forEach((session, sessionId) => {
				this._wrapSession(session);
				this.wrappedSessions.add(sessionId);
			});
		}

		this._log('Polling for new sessions');

		// Track user login/logout (store handles for cleanup)
		this._loginHandle = Accounts.onLogin((loginDetails) => {
			const { connection, user } = loginDetails;
			if (connection && user) {
				const connData = this.connections.get(connection.id);
				if (connData) {
					connData.userId = user._id;
				}
			}
		});

		this._logoutHandle = Accounts.onLogout((logoutDetails) => {
			const { connection } = logoutDetails;
			if (connection) {
				const connData = this.connections.get(connection.id);
				if (connData) {
					connData.userId = null;
				}
			}
		});
	}

	/**
	 * Wrap an individual session to track DDP messages
	 * @private
	 */
	_wrapSession(session) {
		const self = this;
		try {
			const sessionId = session.id;
			const connectedAt = Date.now();

			// Initialize connection tracking data
			const connData = {
				connectionId: sessionId,
				clientAddress: session.socket?.remoteAddress || session.connectionHandle?.clientAddress || 'unknown',
				httpHeaders: session.connectionHandle?.httpHeaders || {},
				userId: session.userId || null,
				userAgent: session.connectionHandle?.httpHeaders?.["user-agent"] || 'unknown',
				connectedAt,
				disconnectedAt: null,
				status: "active",
				messagesSent: 0,
				messagesReceived: 0,
				bytesSent: 0,
				bytesReceived: 0,
				messageTypes: {},
				activeSubscriptions: [],
				lastPingLatency: null,
				avgLatency: null,
				latencyMeasurements: [],
				reconnectCount: 0,
				// Store last ping timestamp for latency calculation (ping/pong don't have IDs)
				lastPingTimestamp: null
			};

			this.connections.set(sessionId, connData);

			// Wrap session.send to track outgoing messages
			if (session.send) {
				// Get the current send method (might already be wrapped by another collector)
				// We need to call THIS version, not the original, to chain properly
				const currentSend = session.send;

				// Store true original only if not already stored
				if (!session._skySignalOriginalSend) {
					session._skySignalOriginalSend = currentSend;
				}

				session.send = (message) => {
					try {
						let msgType;
						let size;
						let msgObj;

						if (typeof message === "string") {
							// Extract msg type without JSON.parse — avoids full deserialization on every DDP send
							msgType = extractMsgType(message);
							size = message.length;
							// Only parse to object for subscription tracking messages that need structured data
							if (msgType === "ready" || msgType === "nosub" || msgType === "added" ||
								msgType === "changed" || msgType === "removed" || msgType === "sub" || msgType === "unsub") {
								try { msgObj = JSON.parse(message); } catch (_) { /* skip tracking */ }
							}
						} else {
							msgObj = message;
							msgType = message.msg;
							size = estimateMsgSize(message);
						}


						// Track message type
						if (msgType) {
							connData.messageTypes[msgType] = (connData.messageTypes[msgType] || 0) + 1;
						}

						connData.messagesSent++;
						connData.bytesSent += size;

						// Track subscription-related messages
						if (msgObj) {
							self._trackSubscriptionMessage(msgObj, sessionId, size);
						}

						// Track ping for latency measurement
						if (msgType === "ping") {
							connData.lastPingTimestamp = Date.now();
						}
					} catch (error) {
						// Silently ignore parsing errors
					}

					// Call the version we captured (chains to other wrappers if present)
					return currentSend.call(session, message);
				};
			}

			// Wrap session.processMessage to track incoming messages
			if (session.processMessage) {
				// Get the current processMessage (might already be wrapped by another collector like DDPQueueCollector)
				// We need to call THIS version, not the original, to chain properly
				const currentProcessMessage = session.processMessage;

				// Store true original only if not already stored
				if (!session._skySignalOriginalProcessMessage) {
					session._skySignalOriginalProcessMessage = currentProcessMessage;
				}

				session.processMessage = function (msg) {
					try {
						const msgType = msg.msg;


						// Track message type
						if (msgType) {
							connData.messageTypes[msgType] = (connData.messageTypes[msgType] || 0) + 1;
						}

						// Track message size (lightweight estimate, avoids JSON.stringify on every message)
						const size = estimateMsgSize(msg);
						connData.messagesReceived++;
						connData.bytesReceived += size;

						// Track subscription-related messages
						self._trackSubscriptionMessage(msg, sessionId, size);

						// Track pong for latency calculation (pong comes from client)
						if (msgType === "pong") {
							if (connData.lastPingTimestamp) {
								const latency = Date.now() - connData.lastPingTimestamp;
								connData.lastPingLatency = latency;
								connData.latencyMeasurements.push(latency);

								// Keep only last 10 measurements for average
								if (connData.latencyMeasurements.length > 10) {
									connData.latencyMeasurements.shift();
								}

								// Calculate average latency
								connData.avgLatency = Math.round(
									connData.latencyMeasurements.reduce((a, b) => a + b, 0) /
									connData.latencyMeasurements.length
								);

								// Clear timestamp after using it
								connData.lastPingTimestamp = null;
							}
						}
					} catch (error) {
						// Silently ignore errors
					}

					// Call the version we captured (chains to other wrappers if present)
					return currentProcessMessage.call(this, msg);
				};
			}

			// Track session close
			if (session.connectionHandle && session.connectionHandle.onClose) {
				session.connectionHandle.onClose(() => {
					this._handleConnectionClose(sessionId);
				});
			}

			this._log(`Session wrapped: ${sessionId}`);
		} catch (error) {
			console.error('⚠️ DDPCollector: Error wrapping session:', error);
		}
	}

	/**
	 * Handle connection close event
	 * @private
	 */
	_handleConnectionClose(connectionId) {
		const connData = this.connections.get(connectionId);
		if (connData) {
			connData.status = "disconnected";
			connData.disconnectedAt = Date.now();

			// Send final update immediately
			this._sendConnectionUpdate(connData);

			// Remove from active connections after sending
			this.connections.delete(connectionId);
		}

		// Also remove from wrapped sessions tracking to prevent memory leak
		if (this.wrappedSessions) {
			this.wrappedSessions.delete(connectionId);
		}
	}

	/**
	 * Send updates for all active connections
	 * @private
	 */
	_sendUpdates() {
		if (this.connections.size === 0) {
			return; // No active connections to report
		}

		const connections = Array.from(this.connections.values()).map(conn => ({
			connectionId: conn.connectionId,
			clientAddress: conn.clientAddress,
			userId: conn.userId,
			userAgent: conn.userAgent,
			connectedAt: conn.connectedAt,
			disconnectedAt: conn.disconnectedAt,
			status: conn.status,
			messagesSent: conn.messagesSent,
			messagesReceived: conn.messagesReceived,
			bytesSent: conn.bytesSent,
			bytesReceived: conn.bytesReceived,
			messageTypes: conn.messageTypes,
			activeSubscriptions: conn.activeSubscriptions,
			avgLatency: conn.avgLatency,
			lastPingLatency: conn.lastPingLatency,
			reconnectCount: conn.reconnectCount,
			httpHeaders: conn.httpHeaders,
			appVersion: this.appVersion,
			buildHash: this.buildHash
		}));

		// Send to platform
		if (this.client && connections.length > 0) {
			this.client.sendDDPConnections(connections);
		}

		// Also send subscription updates
		this._sendSubscriptionUpdates();
	}

	/**
	 * Send update for a single connection (used on disconnect)
	 * @private
	 */
	_sendConnectionUpdate(connData) {
		const connection = {
			connectionId: connData.connectionId,
			clientAddress: connData.clientAddress,
			userId: connData.userId,
			userAgent: connData.userAgent,
			connectedAt: connData.connectedAt,
			disconnectedAt: connData.disconnectedAt,
			status: connData.status,
			messagesSent: connData.messagesSent,
			messagesReceived: connData.messagesReceived,
			bytesSent: connData.bytesSent,
			bytesReceived: connData.bytesReceived,
			messageTypes: connData.messageTypes,
			activeSubscriptions: connData.activeSubscriptions,
			avgLatency: connData.avgLatency,
			lastPingLatency: connData.lastPingLatency,
			reconnectCount: connData.reconnectCount,
			httpHeaders: connData.httpHeaders,
			appVersion: this.appVersion,
			buildHash: this.buildHash
		};

		if (this.client) {
			this.client.sendDDPConnections([connection]);
		}
	}

	/**
	 * Track subscription message
	 * @private
	 */
	_trackSubscriptionMessage(msg, sessionId, size) {
		const msgType = msg.msg;

		try {
			if (msgType === "sub") {
				// Client subscribes to a publication
				const subId = msg.id;
				const publicationName = msg.name;
				const params = msg.params || [];

				if (subId && publicationName) {
					const now = Date.now();
					this.subscriptions.set(subId, {
						subscriptionId: subId,
						connectionId: sessionId,
						publicationName,
						params,
						status: "pending",
						subscribedAt: now,
						readyAt: null,
						stoppedAt: null,
						responseTime: null,
						documentsAdded: 0,
						documentsChanged: 0,
						documentsRemoved: 0,
						dataTransferred: size,
						lastActivityAt: now
					});

					this._log(`New subscription ${subId} to "${publicationName}"`);
				}
			} else if (msgType === "ready") {
				// Server confirms subscription(s) are ready
				const subs = msg.subs || [];
				subs.forEach(subId => {
					const sub = this.subscriptions.get(subId);
					if (sub && sub.status === "pending") {
						sub.status = "ready";
						sub.readyAt = Date.now();
						sub.responseTime = sub.readyAt - sub.subscribedAt;
						sub.lastActivityAt = sub.readyAt;

						this._log(`Subscription ${subId} ready (${sub.responseTime}ms)`);
					}
				});
			} else if (msgType === "nosub") {
				// Subscription failed or doesn't exist
				const subId = msg.id;
				const error = msg.error;

				const sub = this.subscriptions.get(subId);
				if (sub) {
					sub.status = "error";
					sub.stoppedAt = Date.now();
					sub.errorMessage = error ? `${error.error}: ${error.reason}` : "Unknown error";
					sub.lastActivityAt = sub.stoppedAt;

					this._log(`Subscription ${subId} failed: ${sub.errorMessage}`);
				}
			} else if (msgType === "unsub") {
				// Client unsubscribes
				const subId = msg.id;
				const sub = this.subscriptions.get(subId);
				if (sub) {
					sub.status = "stopped";
					sub.stoppedAt = Date.now();
					sub.lastActivityAt = sub.stoppedAt;

					this._log(`Subscription ${subId} stopped`);
				}
			} else if (msgType === "added" || msgType === "changed" || msgType === "removed") {
				// Data changes - try to associate with active subscriptions
				// Note: DDP doesn't explicitly say which subscription caused the change,
				// so we track by collection name if available
				const collection = msg.collection;

				if (collection) {
					// Find active subscriptions and increment counters
					// Compute timestamp once outside loop to avoid per-subscription Date.now() calls
					const now = Date.now();
					this.subscriptions.forEach(sub => {
						if (sub.status === "ready") {
							// Increment appropriate counter
							if (msgType === "added") {
								sub.documentsAdded++;
							} else if (msgType === "changed") {
								sub.documentsChanged++;
							} else if (msgType === "removed") {
								sub.documentsRemoved++;
							}

							sub.dataTransferred += size;
							sub.lastActivityAt = now;
						}
					});
				}
			}
		} catch (error) {
			console.error("⚠️ DDPCollector: Error tracking subscription:", error);
		}
	}

	/**
	 * Send subscription updates to platform
	 * @private
	 */
	_sendSubscriptionUpdates() {
		if (this.subscriptions.size === 0) {
			return;
		}

		const subscriptions = Array.from(this.subscriptions.values());

		// Send to platform
		if (this.client && subscriptions.length > 0) {
			this.client.sendSubscriptions(subscriptions);
			this._log(`Sent ${subscriptions.length} subscription records`);
		}

		// Clean up stopped/error subscriptions older than 60 seconds
		const now = Date.now();
		this.subscriptions.forEach((sub, subId) => {
			if ((sub.status === "stopped" || sub.status === "error") && sub.stoppedAt) {
				const age = now - sub.stoppedAt;
				if (age > 60000) {
					this.subscriptions.delete(subId);
				}
			}
		});
	}

	/**
	 * Get current connection stats (for debugging)
	 */
	getStats() {
		return {
			activeConnections: this.connections.size,
			activeSubscriptions: this.subscriptions.size,
			connections: Array.from(this.connections.values()).map(conn => ({
				connectionId: conn.connectionId,
				status: conn.status,
				messagesSent: conn.messagesSent,
				messagesReceived: conn.messagesReceived,
				avgLatency: conn.avgLatency
			})),
			subscriptions: Array.from(this.subscriptions.values()).map(sub => ({
				subscriptionId: sub.subscriptionId,
				publicationName: sub.publicationName,
				status: sub.status,
				documentsAdded: sub.documentsAdded,
				documentsChanged: sub.documentsChanged,
				documentsRemoved: sub.documentsRemoved
			}))
		};
	}
}
