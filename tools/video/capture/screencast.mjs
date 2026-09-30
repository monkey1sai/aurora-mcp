// CDP screencast → one append-only MJPEG file + a frame index (timestamps from Chrome's compositor).
// Every frame is acknowledged immediately (Chrome only sends the next one after the ack), then written with a
// synchronous append so the order on disk is the arrival order. At 1920×1080 / JPEG q92 this sustains 60 fps
// on an Apple-silicon Mac (measured: 594/594 frames over 10 s).

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} chrome   launchChrome() api
 * @param {{ dir: string, quality?: number, w?: number, h?: number, format?: 'jpeg'|'png' }} o
 */
export async function startScreencast(chrome, { dir, quality = 92, w = 1920, h = 1080, format = 'jpeg', everyNthFrame = 1 }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, format === 'png' ? 'frames.pngs' : 'frames.mjpeg');
  const fd = fs.openSync(file, 'w');
  const index = []; // { t (s, compositor wall clock), off, len, rx (ms, Node receive time) }
  let off = 0;
  let stopped = false;
  const unsubscribe = chrome.on((d) => {
    if (d.method !== 'Page.screencastFrame') return;
    const { data, metadata, sessionId } = d.params;
    chrome.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (stopped) return;
    const buf = Buffer.from(data, 'base64');
    fs.writeSync(fd, buf);
    index.push({ t: metadata.timestamp, off, len: buf.length, rx: performance.timeOrigin + performance.now(), dw: metadata.deviceWidth, dh: metadata.deviceHeight });
    off += buf.length;
  });
  await chrome.send('Page.startScreencast', { format, quality, maxWidth: w, maxHeight: h, everyNthFrame });
  return {
    file, index,
    get count() { return index.length; },
    async stop() {
      try { await chrome.send('Page.stopScreencast'); } catch { /* browser gone */ }
      await new Promise(r => setTimeout(r, 120)); // frames already in flight
      stopped = true;
      unsubscribe();
      fs.closeSync(fd);
      fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(index));
      return { file, index };
    },
  };
}

/** Read frame i's encoded bytes. */
export function readFrame(fd, fr) {
  const b = Buffer.allocUnsafe(fr.len);
  fs.readSync(fd, b, 0, fr.len, fr.off);
  return b;
}
