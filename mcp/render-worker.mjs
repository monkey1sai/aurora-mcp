import { parentPort, workerData } from 'node:worker_threads';
import { renderProject, encodePcmWav } from '../src/creation/render.js';
try {
  const r = renderProject(workerData.project, workerData.options), wav = encodePcmWav(r.L, r.R, r.plan.sampleRate, r.plan.bitDepth);
  parentPort.postMessage({ wav: wav.buffer, metrics: r.metrics }, [wav.buffer]);
} catch (e) { parentPort.postMessage({ error: { code: e.code || 'RENDER_FAILED', message: e.message } }); }
