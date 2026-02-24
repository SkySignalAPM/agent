/**
 * Compression Worker
 * Offloads gzip compression to a worker thread to prevent the agent's
 * compression work from blocking the host application's event loop.
 *
 * Communication protocol:
 *   Main -> Worker: { id, type: "compress", data: string }
 *   Worker -> Main: { id, type: "result", compressed: Buffer, originalSize, compressedSize }
 *   Worker -> Main: { id, type: "error", message: string }
 */
const { parentPort } = require("worker_threads");
const zlib = require("zlib");
const { promisify } = require("util");

const gzipAsync = promisify(zlib.gzip);

parentPort.on("message", async (msg) => {
  if (msg.type === "compress") {
    try {
      const buffer = Buffer.from(msg.data, "utf8");
      const compressed = await gzipAsync(buffer, { level: 6 });

      parentPort.postMessage({
        id: msg.id,
        type: "result",
        compressed,
        originalSize: buffer.length,
        compressedSize: compressed.length,
      });
    } catch (error) {
      parentPort.postMessage({
        id: msg.id,
        type: "error",
        message: error.message,
      });
    }
  } else if (msg.type === "ping") {
    parentPort.postMessage({ id: msg.id, type: "pong" });
  }
});
