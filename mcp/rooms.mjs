import { randomUUID } from 'node:crypto';
import { validateProject, fail } from '../src/creation/project.js';
export function createRooms() {
  const rooms = new Map(), ttl = 30 * 60000;
  const get = id => { const r = rooms.get(id); if (!r || r.expiresAt < Date.now()) { rooms.delete(id); fail('BROWSER_OFFLINE', 'Browser room disabled or expired'); } return r; };
  return {
    enable() { for(const [id,r] of rooms)if(r.expiresAt<=Date.now())rooms.delete(id);if (rooms.size >= 16) fail('RESOURCE_LIMIT', 'Maximum active browser rooms'); const id = randomUUID(); rooms.set(id, { expiresAt: Date.now() + ttl, queue: [], results: new Map() }); return { room: id, expiresAt: Date.now() + ttl }; },
    disable(id) { rooms.delete(id); },
    command(a) {
      const r = get(a.room), previous = r.results.get(a.requestId); if (previous) return previous;
      if (a.action !== 'stop' && (r.queue.length >= 32 || r.results.size >= 256)) fail('RESOURCE_LIMIT', 'Browser command budget exceeded; reconnect');
      if (!['apply_project', 'play_project', 'stop'].includes(a.action)) fail('INVALID_ARGUMENT', 'Unknown browser action');
      if (a.action !== 'stop') validateProject(a.project);
      const result = { status: 'queued', requestId: a.requestId, action: a.action };
      if(a.action === 'stop') {
        for(const pending of r.queue)r.results.set(pending.requestId,{...r.results.get(pending.requestId),status:'cancelled',message:'Cancelled by stop'});
        r.queue.length=0;
        while(r.results.size>=256)r.results.delete(r.results.keys().next().value);
      }
      r.results.set(a.requestId, result); r.queue.push(a); return result;
    },
    poll(id) { const r = get(id); return { commands: r.queue.splice(0, 1) }; },
    ack(id, value) {
      const r = get(id), old = r.results.get(value.requestId); if (!old) fail('NOT_FOUND', 'Unknown requestId');
      if (!['project-applied', 'audio-running', 'stopped', 'error'].includes(value.status)) fail('INVALID_ARGUMENT', 'Unknown browser status');
      const result = { ...old, status: value.status, message: String(value.message || '').slice(0, 200) }; r.results.set(value.requestId, result); return result;
    },
    status(id, requestId) { return get(id).results.get(requestId) || { status: 'unknown' }; },
    close() { rooms.clear(); },
  };
}
