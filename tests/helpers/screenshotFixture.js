import sinon from 'sinon';

// Mock only browser rendering/encoding; keep the capture and redaction flow real.
export function setupScreenshotFixture() {
  const saved = Object.fromEntries(['document', 'FileReader'].map(name =>
    [name, Object.getOwnPropertyDescriptor(global, name)]
  ));
  const overlays = [];
  const activeOverlays = new Set();
  const element = { getBoundingClientRect: () => ({ top: 10, left: 20, width: 30, height: 40 }) };
  const document = {
    body: { appendChild: overlay => { overlays.push(overlay); activeOverlays.add(overlay); } },
    querySelectorAll: selector => selector === '.secret' ? [element] : [],
    createElement: () => {
      const overlay = { style: {} };
      overlay.remove = sinon.spy(() => activeOverlays.delete(overlay));
      return overlay;
    }
  };
  class FileReader {
    readAsDataURL(blob) {
      this.result = blob.dataURL;
      this.onloadend();
    }
  }
  Object.defineProperty(global, 'document', { value: document, configurable: true, writable: true });
  Object.defineProperty(global, 'FileReader', { value: FileReader, configurable: true, writable: true });
  const blob = { size: 128, dataURL: 'data:image/jpeg;base64,capture' };
  const canvas = { toBlob: sinon.stub().callsFake(callback => callback(blob)) };
  const renderer = sinon.stub().resolves(canvas);
  const clock = sinon.useFakeTimers();

  return {
    document, overlays, activeOverlays, blob, canvas, renderer, clock,
    restore() {
      clock.restore();
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(global, name, descriptor);
        else delete global[name];
      }
    }
  };
}
