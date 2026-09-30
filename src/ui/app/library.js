// Preset library: factory presets + user presets (localStorage) + favourites (localStorage).
// Every entry gets a stable key: 'f:<name>' for factory, 'u:<name>' for user presets.

import { storage } from './dom.js';

const USER_KEY = 'aurora.userPresets';
const FAV_KEY = 'aurora.favourites';

export function createLibrary({ factory = [], categories = [] } = {}) {
  const fac = factory.map(p => ({ ...p, key: `f:${p.name}`, source: 'factory' }));
  // saved data may come from an older build or a hand edit: validate the shapes so it can never stop the boot
  let user = sanitizeUserPresets(storage.get(USER_KEY, []))
    .map(p => ({ ...p, key: `u:${p.name}`, source: 'user', user: true }));
  let favs = new Set(sanitizeFavourites(storage.get(FAV_KEY, [])));
  const subs = new Set();
  const emit = () => { for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } } };

  const persistList = list => storage.set(USER_KEY, list.map(({ key, source, ...rest }) => rest));
  /** Insert or replace (by name) in `list`; returns the new entry. */
  function upsert(list, preset) {
    const entry = { ...preset, user: true, key: `u:${preset.name}`, source: 'user', created: preset.created || Date.now(), modified: Date.now() };
    const i = list.findIndex(p => p.name === preset.name);
    if (i >= 0) list[i] = entry; else list.push(entry);
    return entry;
  }
  const persistFav = () => storage.set(FAV_KEY, [...favs]);

  /** Add or overwrite several presets with ONE storage write and ONE change event (imports). Entries, or null. */
  function saveMany(presets) {
    const next = user.slice();
    const out = [];
    for (const p of presets || []) if (p && p.name) out.push(upsert(next, p));
    if (!out.length) return [];
    if (!persistList(next)) return null;
    user = next;
    emit();
    return out;
  }

  return {
    categories,
    all: () => [...fac, ...user],
    factory: () => fac,
    user: () => user,
    get(key) { return fac.find(p => p.key === key) || user.find(p => p.key === key) || null; },
    findByName(name) { return user.find(p => p.name === name) || fac.find(p => p.name === name) || null; },
    hasUser: name => user.some(p => p.name === name),
    /**
     * Add or overwrite (by name) a user preset. Returns the stored entry, or null if storage failed — then
     * nothing changes (no phantom entry that is gone after a reload).
     */
    saveUser(preset) {
      const r = saveMany([preset]);
      return r && r.length ? r[0] : null;
    },
    saveMany,
    deleteUser(key) {
      const next = user.filter(p => p.key !== key);
      if (next.length === user.length || !persistList(next)) return false;
      user = next;
      favs.delete(key); persistFav(); emit();
      return true;
    },
    isFav: key => favs.has(key),
    toggleFav(key) {
      if (favs.has(key)) favs.delete(key); else favs.add(key);
      persistFav();
      emit();
      return favs.has(key);
    },
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/**
 * Stored user presets → well-formed entries: an array of objects with a name and a params object; tags become an
 * array of strings (a string is split at commas), description a string. Anything else is dropped or coerced.
 */
export function sanitizeUserPresets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    if (!p.params || typeof p.params !== 'object' || Array.isArray(p.params)) continue;
    const name = typeof p.name === 'string' || typeof p.name === 'number' ? String(p.name).trim() : '';
    if (!name) continue;
    const tagList = Array.isArray(p.tags) ? p.tags : typeof p.tags === 'string' ? p.tags.split(/[,，]/) : [];
    const e = { ...p, name, tags: tagList.filter(t => typeof t === 'string' || typeof t === 'number').map(t => String(t).trim()).filter(Boolean).slice(0, 12) };
    if (e.description != null && typeof e.description !== 'string') delete e.description;
    if (e.category != null && typeof e.category !== 'string') delete e.category;
    out.push(e);
  }
  return out;
}

/** Stored favourites → array of preset keys (strings). */
export const sanitizeFavourites = raw => (Array.isArray(raw) ? raw.filter(k => typeof k === 'string') : []);
