/**
 * Mock for html2canvas (Npm dependency used by ScreenshotCapture).
 */
function html2canvas() {
  return Promise.resolve({
    toDataURL: () => 'data:image/png;base64,mock'
  });
}

module.exports = html2canvas;
module.exports.default = html2canvas;
