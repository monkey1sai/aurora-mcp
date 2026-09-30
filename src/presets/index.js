// AURORA 極光 — factory preset index.
// Aggregates the per-category files (each `export default [ ...presets ]`, see docs/ARCHITECTURE.md §9).
// Pure ES module (browser + Node): no DOM, no Node APIs.

import keys from './keys.js';
import pad from './pad.js';
import bass from './bass.js';
import lead from './lead.js';
import pluck from './pluck.js';
import bell from './bell.js';
import strings from './strings.js';
import arp from './arp.js';
import fx from './fx.js';
import drum from './drum.js';

/**
 * Categories in display order.
 * icon: name of an inline SVG icon (src/ui/app/icons.js); emoji: plain-text fallback; color: UI accent.
 */
export const CATEGORIES = Object.freeze([
  { id: 'keys', label: 'Keys', zh: '鍵盤', icon: 'keys', emoji: '🎹', color: '#5cf2ff' },
  { id: 'pad', label: 'Pad', zh: '鋪底', icon: 'pad', emoji: '🌌', color: '#a78bfa' },
  { id: 'bass', label: 'Bass', zh: '貝斯', icon: 'bass', emoji: '🔊', color: '#ff6bd6' },
  { id: 'lead', label: 'Lead', zh: '主奏', icon: 'lead', emoji: '⚡', color: '#ffc46b' },
  { id: 'pluck', label: 'Pluck', zh: '撥弦', icon: 'pluck', emoji: '🪕', color: '#3ef0b0' },
  { id: 'bell', label: 'Bell', zh: '鐘琴', icon: 'bell', emoji: '🔔', color: '#8fd8ff' },
  { id: 'strings', label: 'Strings & Winds', zh: '弦樂/管樂', icon: 'strings', emoji: '🎻', color: '#ffb38a' },
  { id: 'arp', label: 'Arp & Groove', zh: '琶音/律動', icon: 'arp', emoji: '🎚️', color: '#6bffd2' },
  { id: 'fx', label: 'FX & Texture', zh: '音效/質感', icon: 'fx', emoji: '✨', color: '#ff8fe0' },
  { id: 'drum', label: 'Drum', zh: '打擊', icon: 'drum', emoji: '🥁', color: '#ff6b81' },
].map(Object.freeze));

const BY_CATEGORY = { keys, pad, bass, lead, pluck, bell, strings, arp, fx, drum };

/** All factory presets, in category order. `category` defaults to the file's category. */
export const PRESETS = Object.freeze(
  CATEGORIES.flatMap(c => (Array.isArray(BY_CATEGORY[c.id]) ? BY_CATEGORY[c.id] : [])
    .filter(p => p && typeof p === 'object')
    .map(p => Object.freeze({ ...p, category: p.category || c.id, tags: p.tags || [], macros: p.macros || [] }))),
);

/** Category entry by id (undefined if unknown). */
export function categoryOf(id) {
  return CATEGORIES.find(c => c.id === id);
}
