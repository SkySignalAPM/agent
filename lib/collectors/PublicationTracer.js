import { Meteor } from "meteor/meteor";

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
    this._log("Stopped");
  }

  _wrapPublish() {
    if (this._wrapped) return;
    this._wrapped = true;

    const self = this;
    const originalPublish = Meteor.publish;

    Meteor.publish = function (name, handler, options) {
      // Don't wrap null publications or unnamed ones
      if (!name || typeof handler !== "function") {
        return originalPublish.call(this, name, handler, options);
      }

      const wrappedHandler = function (...args) {
        try {
          const result = handler.apply(this, args);
          self._analyzeCursors(name, result);
          return result;
        } catch (error) {
          // Don't interfere with publication errors
          throw error;
        }
      };

      return originalPublish.call(this, name, wrappedHandler, options);
    };

    this._log("Publish wrapper installed");
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
