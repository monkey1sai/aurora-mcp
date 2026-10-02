import { renderProject, encodePcmWav } from './render.js';
self.onmessage = ev => {
  const { id, project, options } = ev.data;
  try {
    const result = renderProject(project, options), wav = encodePcmWav(result.L, result.R, result.plan.sampleRate, result.plan.bitDepth);
    self.postMessage({ id, status: 'artifact-ready', wav: wav.buffer, metrics: result.metrics }, [wav.buffer]);
  } catch (error) { self.postMessage({ id, status: 'error', code: error.code || 'RENDER_FAILED', message: error.message }); }
};
