/**
 * Mock for ScreenshotCapture module (imported by ErrorTracker).
 */

class ScreenshotCapture {
  constructor(config = {}) {
    this.config = config;
    this._captureCount = 0;
  }

  async capture(errorInfo) {
    this._captureCount++;
    return null; // No screenshot in tests
  }

  getStats() {
    return { captureCount: this._captureCount };
  }
}

module.exports = ScreenshotCapture;
module.exports.default = ScreenshotCapture;
