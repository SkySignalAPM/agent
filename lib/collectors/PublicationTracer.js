import { Meteor } from "meteor/meteor";
import { publicationContextStore } from "./LiveQueriesCollector";
import { patchRegistration } from "../utils/patchRegistration.js";

const TRACED = Symbol("skysignal.publicationTraced");

// Handler wrappers and registration patches are process-wide and outlive a
// tracer instance (stop() → start() creates a new one), so they report to
// whichever tracer is currently running.
let activeTracer = null;

/**
 * PublicationTracer
 * Tracks publication efficiency by wrapping Meteor.publish handlers.
 *
 * Detects:
 * - Publications returning cursors without field projections (over-fetching)
 * - Publications returning large document sets without limits
 * - Average/max document counts per publication
 *
 * Approach: Wraps Meteor.publish. In the handler wrapper, intercepts the
 * returned cursor(s) and inspects _cursorDescription.options.fields.
 * If no projection, flags as "over-fetching".
 */
export default class PublicationTracer {
  constructor(options = {}) {
    this.client = options.client;
    this.host = options.host || "unknown-host";
    this.appVersion = options.appVersion || "unknown";
    this.interval = options.interval || 300000; // 5 minutes
    this.debug = options.debug || false;
    this.docCountThreshold = options.docCountThreshold || 100;

    this.intervalId = null;
    this._wrapped = false;

    // Stats per publication: { pubName: { callCount, noProjection, totalDocs, maxDocs } }
    this._stats = {};
  }

  _log(...args) {
    if (this.debug) {
      console.log("[SkySignal:PublicationTracer]", ...args);
    }
  }

  _warn(...args) {
    console.warn("[SkySignal:PublicationTracer]", ...args);
  }

  start() {
    if (this.intervalId) {
      this._warn("Already started");
      return;
    }

    this._wrapPublish();

    this.intervalId = setInterval(() => {
      this._collect();
    }, this.interval);

    this._log(`Started (interval: ${this.interval}ms)`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (activeTracer === this) activeTracer = null;
    // Wrappers stay installed: unwrapping handlers that live subscriptions may
    // still re-run is riskier than leaving a pass-through, and LiveQueries
    // relies on the publication context they set.
    this._log("Stopped");
  }

  /**
   * Wrap publish handlers at the source of truth (Meteor.server.publish_handlers
   * and universal_publish_handlers). Wrapping only Meteor.publish calls made
   * after start() missed publications registered earlier, the object form
   * Meteor.publish({...}), and Meteor.server.publish (Meteor.publish is a bound
   * copy). So: wrap what's registered now, then re-sweep after each registration.
   */
  _wrapPublish() {
    activeTracer = this;
    if (this._wrapped) return;
    this._wrapped = true;

    const sweep = () => activeTracer && activeTracer._wrapRegisteredPublications();
    sweep();
    patchRegistration(Meteor, "publish", sweep);
    patchRegistration(Meteor.server, "publish", sweep);

    this._log("Publish wrapper installed (with ALS context propagation)");
  }

  /**
   * Wrap every not-yet-wrapped named and universal (null) publish handler.
   * Idempotent: wrapped handlers carry `_skySignalOriginal`.
   * shortcut: a universal publication registered while sessions are already
   * connected starts on those sessions unwrapped; fine since that only
   * happens at startup before clients connect.
   */
  _wrapRegisteredPublications() {
    const server = Meteor.server;
    if (!server) return;

    const named = server.publish_handlers;
    if (named) {
      for (const name of Object.keys(named)) {
        const handler = named[name];
        if (typeof handler === "function" && !handler._skySignalOriginal) {
          named[name] = this._wrapHandler(name, handler);
        }
      }
    }

    const universal = server.universal_publish_handlers;
    if (Array.isArray(universal)) {
      for (let i = 0; i < universal.length; i++) {
        const handler = universal[i];
        if (typeof handler === "function" && !handler._skySignalOriginal) {
          universal[i] = this._wrapHandler(null, handler);
        }
      }
    }
  }

  _wrapHandler(name, handler) {
    const wrapped = function (...args) {
      // Re-entry guard (handler re-wrapped by someone else, then re-swept by us)
      if (this && typeof this === "object") {
        if (this[TRACED]) return handler.apply(this, args);
        this[TRACED] = true;
      }
      // Set publication context in AsyncLocalStorage so that any
      // _observeChanges calls inside this handler can read the
      // publication name and connection ID.
      const context = {
        publicationName: name || null,
        connectionId: this.connection?.id || null,
        isAutoPublish: !name
      };

      return publicationContextStore.run(context, () => {
        const result = handler.apply(this, args);
        if (name) {
          if (result && typeof result.then === "function") {
            // Meteor 3 async publish handlers resolve to the cursor(s)
            result.then((resolved) => activeTracer && activeTracer._analyzeCursors(name, resolved), () => {});
          } else if (activeTracer) {
            activeTracer._analyzeCursors(name, result);
          }
        }
        return result;
      });
    };
    wrapped._skySignalOriginal = handler;
    return wrapped;
  }

  /**
   * Analyze cursors returned by a publication handler
   */
  _analyzeCursors(pubName, result) {
    try {
      if (!result) return;

      // Initialize stats for this publication
      if (!this._stats[pubName]) {
        this._stats[pubName] = {
          callCount: 0,
          noProjectionCount: 0,
          totalDocs: 0,
          maxDocs: 0,
          hasLimit: true
        };
      }

      const stats = this._stats[pubName];
      stats.callCount++;

      // Handle single cursor or array of cursors
      const cursors = Array.isArray(result) ? result : [result];

      for (const cursor of cursors) {
        if (!cursor || typeof cursor !== "object") continue;

        // Access cursor description (Meteor internals)
        const desc = cursor._cursorDescription;
        if (!desc) continue;

        // Check for field projection
        const fields = desc.options?.fields || desc.options?.projection;
        if (!fields || Object.keys(fields).length === 0) {
          stats.noProjectionCount++;
        }

        // Check for limit
        if (!desc.options?.limit) {
          stats.hasLimit = false;
        }

        // Estimate document count if possible
        // Note: We can't call count() here as it would add overhead.
        // We track via the cursor's limit if available.
        const limit = desc.options?.limit;
        if (limit) {
          stats.totalDocs += limit;
          stats.maxDocs = Math.max(stats.maxDocs, limit);
        }
      }
    } catch (error) {
      // Silently fail - never impact publications
      this._log("Error analyzing cursors:", error.message);
    }
  }

  _collect() {
    try {
      const pubNames = Object.keys(this._stats);
      if (pubNames.length === 0) return;

      const publications = pubNames.map(name => {
        const s = this._stats[name];
        return {
          name,
          noProjection: s.noProjectionCount > 0,
          noProjectionRate: s.callCount > 0
            ? Math.round((s.noProjectionCount / s.callCount) * 100)
            : 0,
          avgDocs: s.callCount > 0 ? Math.round(s.totalDocs / s.callCount) : 0,
          maxDocs: s.maxDocs,
          callCount: s.callCount,
          hasLimit: s.hasLimit
        };
      });

      const metric = {
        timestamp: new Date(),
        host: this.host,
        appVersion: this.appVersion,
        publications
      };

      if (this.client) {
        this.client.addPublicationMetric(metric);
      }

      this._log(`Collected: ${publications.length} publications tracked`);

      // Reset stats
      this._stats = {};
    } catch (error) {
      this._warn("Collection error:", error.message);
    }
  }
}
