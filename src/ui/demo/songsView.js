// 示範曲 Songs tab: a rail of song cards (animated gradient covers) and a big player — transport, loop,
// "一起彈 Play along" (scale lock to the song key), a section timeline with a moving playhead, and one lane per
// part: mini piano roll drawn from the song's events with live highlighting of sounding notes, level meter,
// mute / solo, and "用這個音色彈 Play this sound" (loads the part's preset into the main synth).
//
// Engine API (src/ui/audio.js, "ensemble"): songLoad(song), songPlay(), songStop(), songPart(i, {mute, solo, gain});
// state.song = { playing, beat, lengthBeats, loop, bpm, section, parts: [{ name, peak, notes, mute, solo }] }.

import { h, storage } from '../app/dom.js';
import { t, getLang } from '../app/i18n.js';
import { dIcon } from './center.js';
import { SCALES } from '../../dsp/params.js';

const ROLE_COLORS = { pad: '#a78bfa', bass: '#ff6bd6', lead: '#ffc46b', drums: '#ff6b81', arp: '#6bffd2', keys: '#5cf2ff', fx: '#ff8fe0', pluck: '#3ef0b0', bell: '#8fd8ff', strings: '#ffb38a' };
const ROLE_ICONS = { pad: 'pad', bass: 'bass', lead: 'lead', drums: 'drum', arp: 'arp', keys: 'keys', fx: 'fx', pluck: 'pluck', bell: 'bell', strings: 'strings' };
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const KEY_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const SCALE_ZH = { major: '大調', minor: '小調', dorian: '多利安', mixolydian: '混合利底安', pentMajor: '大調五聲', pentMinor: '小調五聲', blues: '藍調', harmMinor: '和聲小調', inSen: '陰旋', wholeTone: '全音' };
const SCALE_EN = { major: 'major', minor: 'minor', dorian: 'Dorian', mixolydian: 'Mixolydian', pentMajor: 'major pentatonic', pentMinor: 'minor pentatonic', blues: 'blues', harmMinor: 'harmonic minor', inSen: 'In Sen', wholeTone: 'whole tone' };
const SCALE_ALIAS = { ionian: 'major', aeolian: 'minor', naturalMinor: 'minor', pentatonic: 'pentMajor', minorPentatonic: 'pentMinor', majorPentatonic: 'pentMajor', harmonicMinor: 'harmMinor', insen: 'inSen', whole: 'wholeTone' };

/** Song description in the UI language (songs carry a zh string; { zh, en } or descriptionEn when present). */
export function descOf(def, en = getLang() === 'en') {
  const d = def.description || '';
  if (typeof d === 'object') return en ? d.en || d.zh || '' : d.zh || d.en || '';
  return en && def.descriptionEn ? def.descriptionEn : d;
}
const fmtTime = s => (Number.isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Song key → { root: 0..11, scale: SCALES id } (null when unusable). */
export function songScale(key) {
  if (!key) return null;
  let root = key.root;
  if (typeof root === 'string') {
    const m = /^\s*([A-Ga-g])([#b♯♭]*)/.exec(root);
    if (!m) return null;
    root = LETTER[m[1].toUpperCase()];
    for (const ch of m[2]) root += ch === '#' || ch === '♯' ? 1 : -1;
  }
  if (!Number.isFinite(root)) return null;
  let scale = SCALE_ALIAS[key.scale] || key.scale || 'major';
  if (!(scale in SCALES) || scale === 'off') scale = /min/i.test(String(key.scale)) ? 'minor' : 'major';
  return { root: ((Math.round(root) % 12) + 12) % 12, scale };
}
export function keyLabel(sc, lang = getLang()) {
  if (!sc) return '';
  return lang === 'en' ? `${KEY_NAMES[sc.root]} ${SCALE_EN[sc.scale] || sc.scale}` : `${KEY_NAMES[sc.root]} ${SCALE_ZH[sc.scale] || sc.scale}`;
}

/** Note events of a part (sequencer format, or [beat, note, dur, vel] tuples). */
function noteEvents(events) {
  const out = [];
  for (const e of events || []) {
    if (Array.isArray(e)) { out.push({ beat: +e[0] || 0, note: +e[1], dur: +e[2] || 0.25, vel: e[3] ?? 0.8 }); continue; }
    if (!e || (e.type && e.type !== 'on')) continue;
    if (!Number.isFinite(+e.note)) continue;
    out.push({ beat: +e.beat || 0, note: +e.note, dur: +e.dur || 0.25, vel: e.vel ?? 0.8 });
  }
  out.sort((a, b) => a.beat - b.beat);
  return out;
}

/** Cover art: layered animated gradient from cover.colors. */
function coverEl(colors, cls = '') {
  const c = colors && colors.length ? colors : ['#3ef0b0', '#5cf2ff', '#a78bfa'];
  return h(`div.sv-cover ${cls}`.trim(), { '--c1': c[0], '--c2': c[1] || c[0], '--c3': c[2] || c[1] || c[0], 'aria-hidden': 'true' },
    h('i.sv-cover__a'), h('i.sv-cover__b'), h('i.sv-cover__c'), h('span.sv-cover__eq', null, h('b'), h('b'), h('b'), h('b')));
}

/**
 * @param {{ store, getAudio, transport, presets, library, loadEntry, toast, categories, getData: () => ({SONGS, resolveSong, songDuration, sectionAt}|null) }} o
 */
export function createSongsView({ store, getAudio, transport, presets = [], library = null, loadEntry = null, toast = null, getData, audioGate = null }) {
  const rail = h('div.sv-rail', { role: 'listbox', 'aria-orientation': 'horizontal', 'aria-label': `${t('dcSongs', 'zh')} ${t('dcSongs', 'en')}` });
  const player = h('div.sv-player');
  const empty = h('div.dc-empty.sv-empty');
  const el = h('div.sv', null, rail, player, empty);

  let selId = null;
  try { selId = localStorage.getItem('aurora.song'); } catch { /* ignore */ }
  const resolved = new Map(); // id → song | Error
  let playingId = null;
  let loopOn = true;
  let visible = false;
  let lastState = null;
  let prevBeat = -1;
  let playAlong = null; // { prevRoot, prevType } while locked
  // the lock is a temporary override of the user's global scale setting (which main.js persists on every change):
  // remember the user's own setting next to it, so a reload / crash mid-song never keeps the song's key
  const ALONG_KEY = 'aurora.playAlongPrev';
  {
    const stale = storage.get(ALONG_KEY, null);
    if (stale && stale.prevType !== undefined) {
      store.set('scale.root', stale.prevRoot);
      store.set('scale.type', stale.prevType);
    }
    storage.remove(ALONG_KEY);
  }
  addEventListener('pagehide', () => releaseAlong(false));
  let railCards = [];
  let P = null; // player refs for the selected song

  const data = () => (getData ? getData() : null);
  const songs = () => { const d = data(); return d && d.SONGS ? d.SONGS : []; };
  const audioOk = () => { const a = getAudio(); return !!(a && !a.isNull && typeof a.songLoad === 'function'); };
  function resolve(def) {
    if (resolved.has(def.id)) return resolved.get(def.id);
    let r;
    try { r = data().resolveSong(def, presets); } catch (e) { console.error(e); r = e instanceof Error ? e : new Error(String(e)); }
    resolved.set(def.id, r);
    return r;
  }
  const durationOf = (def) => { const d = data(); return d && d.songDuration ? d.songDuration(def) : (def.lengthBeats * 60) / (def.bpm || 120); };
  const titleOf = (def, en = getLang() === 'en') => (en ? def.title || def.zh : def.zh || def.title);
  const subOf = (def, en = getLang() === 'en') => (en ? def.zh : def.title);
  const genreOf = (def, en = getLang() === 'en') => (en ? def.genre || def.zhGenre : def.zhGenre || def.genre) || '';

  /* ── rail ── */
  function buildRail() {
    rail.textContent = '';
    railCards = songs().map((def, i) => {
      const cols = (def.cover && def.cover.colors) || null;
      const tt = h('b.sv-card__t');
      const en = h('span.sv-card__en');
      const meta = h('span.sv-card__meta');
      const b = h('button.sv-card', { type: 'button', role: 'option', 'data-id': def.id, style: `--i:${i}` }, coverEl(cols), h('span.sv-card__txt', null, tt, en, meta));
      b.addEventListener('click', () => select(def.id));
      b.addEventListener('dblclick', () => { select(def.id); play(); });
      rail.append(b);
      const render = () => {
        tt.textContent = titleOf(def);
        en.textContent = subOf(def);
        meta.textContent = `${genreOf(def)} · ${fmtTime(durationOf(def))}`;
        b.classList.toggle('is-on', def.id === selId);
        b.setAttribute('aria-selected', String(def.id === selId));
        b.classList.toggle('is-playing', def.id === playingId);
      };
      render();
      return { def, render, el: b };
    });
  }
  const renderRail = () => { for (const c of railCards) c.render(); };

  /* ── player ── */
  function buildPlayer() {
    player.textContent = '';
    P = null;
    const def = songs().find(s => s.id === selId);
    if (!def) return;
    const song = resolve(def);
    const cols = (def.cover && def.cover.colors) || ['#3ef0b0', '#5cf2ff', '#a78bfa'];
    player.style.setProperty('--c1', cols[0]);
    player.style.setProperty('--c2', cols[1] || cols[0]);
    player.style.setProperty('--c3', cols[2] || cols[1] || cols[0]);
    const sc = songScale(def.key);

    // header
    const playIc = h('span.svp-play__ic');
    const playBtn = h('button.svp-play', { type: 'button' }, playIc);
    playBtn.addEventListener('click', () => togglePlay());
    const cover = coverEl(cols, 'sv-cover--big');
    const genre = h('span.svp-genre');
    const title = h('h3.svp-title');
    const titleEn = h('span.svp-en');
    const desc = h('p.svp-desc');
    const meta = h('div.svp-meta');
    const loopLbl = h('span');
    const loopBtn = h('button.pill-btn.svp-loop', { type: 'button', 'aria-pressed': 'true' }, dIcon('loop', 15), loopLbl);
    loopBtn.addEventListener('click', () => { loopOn = !loopOn; renderHead(); });
    const alongLbl = h('span');
    const alongBtn = h('button.pill-btn.svp-along', { type: 'button', 'aria-pressed': 'false' }, dIcon('keysPlay', 15), alongLbl);
    alongBtn.addEventListener('click', () => togglePlayAlong(def));
    if (!sc) alongBtn.hidden = true;
    const alongHint = h('p.svp-hint');
    const time = h('span.svp-time');
    const head = h('div.svp-head', null,
      h('div.svp-coverWrap', null, cover, playBtn),
      h('div.svp-info', null, h('div.svp-kick', null, genre, time), h('div.svp-titles', null, title, titleEn), desc, meta),
      h('div.svp-actions', null, loopBtn, alongBtn, alongHint));

    // timeline (sections)
    const L = (song && !(song instanceof Error) ? song.lengthBeats : def.lengthBeats) || 16;
    const secs = ((song && !(song instanceof Error) ? song.sections : def.sections) || []).slice().sort((a, b) => a.beat - b.beat);
    const track = h('div.svp-track');
    const secEls = secs.map((s, i) => {
      const end = i + 1 < secs.length ? secs[i + 1].beat : L;
      const seg = h('div.svp-sec', { style: `left:${(100 * s.beat / L).toFixed(3)}%;width:${(100 * (end - s.beat) / L).toFixed(3)}%` }, h('b'), h('small'));
      track.append(seg);
      return { s, seg, from: s.beat, to: end };
    });
    const bars = h('div.svp-bars', { 'aria-hidden': 'true' });
    for (let b = 0; b < L; b += 4) bars.append(h('i', { style: `left:${(100 * b / L).toFixed(3)}%`, class: b % 16 === 0 ? 'is-phrase' : '' }));
    track.prepend(bars);
    const timeline = h('div.svp-timeline', null, h('div.svp-lanehead.svp-lanehead--tl', null, dIcon('steps', 14), h('span.svp-tlLbl')), track);

    // lanes
    const lanes = h('div.svp-lanes');
    const nParts = ((song && !(song instanceof Error) ? song.parts : def.parts) || []).length;
    lanes.classList.toggle('svp-lanes--dense', nParts >= 6);
    const playhead = h('div.svp-playhead', { 'aria-hidden': 'true' }, h('i'));
    const partDefs = (song && !(song instanceof Error) ? song.parts : def.parts) || [];
    const laneRefs = partDefs.map((part, i) => {
      const role = part.role || 'keys';
      const color = ROLE_COLORS[role] || '#5cf2ff';
      const evs = noteEvents((def.parts[i] && def.parts[i].events) || part.events);
      let lo = 127, hi = 0;
      for (const e of evs) { if (e.note < lo) lo = e.note; if (e.note > hi) hi = e.note; }
      if (lo > hi) { lo = 48; hi = 72; }
      if (hi - lo < 12) { const m = (hi + lo) / 2; lo = Math.floor(m - 6); hi = Math.ceil(m + 6); }
      const canvas = h('canvas.svp-roll', { 'aria-hidden': 'true' });
      const meter = h('span.svp-meter', { 'aria-hidden': 'true' }, h('i'));
      const mBtn = h('button.svp-ms', { type: 'button', 'aria-pressed': 'false' }, 'M');
      const sBtn = h('button.svp-ms.svp-ms--s', { type: 'button', 'aria-pressed': 'false' }, 'S');
      const useBtn = h('button.svp-use', { type: 'button' }, dIcon('keysPlay', 15));
      const name = h('b.svp-lane__name');
      const sub = h('span.svp-lane__sub');
      const lane = h('div.svp-lane', { '--lc': color, style: `--i:${i}` },
        h('div.svp-lanehead', null,
          h('span.svp-lane__ic', null, dIcon(ROLE_ICONS[role] || 'wave', 15)),
          h('span.svp-lane__txt', null, name, sub),
          meter, h('span.svp-lane__btns', null, mBtn, sBtn, useBtn)),
        h('div.svp-rollWrap', null, canvas));
      const ref = { part, i, color, evs, lo, hi, canvas, meter, mBtn, sBtn, useBtn, name, sub, lane, mute: false, solo: false, peak: 0, stat: null, w: 0, hgt: 0, active: '' };
      mBtn.addEventListener('click', () => setPart(ref, { mute: !ref.mute }));
      sBtn.addEventListener('click', () => setPart(ref, { solo: !ref.solo }));
      useBtn.addEventListener('click', () => useSound(def, song, ref));
      lanes.append(lane);
      return ref;
    });
    lanes.append(playhead);
    const err = song instanceof Error ? h('p.svp-err', null, dIcon('panic', 14), h('span', null, String(song.message).split('\n').slice(0, 3).join(' · '))) : null;
    player.append(head, timeline, lanes, err || '');
    P = { def, song, playBtn, playIc, loopBtn, loopLbl, alongBtn, alongLbl, alongHint, genre, title, titleEn, desc, meta, time, secEls, lanes, laneRefs, playhead, L, sc, timeline };
    renderHead();
    requestAnimationFrame(() => drawStatic());
  }

  function renderHead() {
    if (!P) return;
    const { def } = P;
    const en = getLang() === 'en';
    const isPlaying = playingId === def.id;
    P.playIc.replaceChildren(dIcon(isPlaying ? 'stop' : 'play', 26));
    P.playBtn.title = t(isPlaying ? 'songStop' : 'songPlay');
    P.playBtn.setAttribute('aria-label', `${P.playBtn.title} — ${titleOf(def)}`);
    P.playBtn.classList.toggle('is-playing', isPlaying);
    player.classList.toggle('is-playing', isPlaying);
    P.genre.textContent = genreOf(def);
    P.title.textContent = titleOf(def);
    P.titleEn.textContent = subOf(def);
    P.desc.textContent = descOf(def, en);
    const parts = (def.parts || []).length;
    P.meta.replaceChildren(
      h('span', null, dIcon('wave', 13), `${Math.round(def.bpm)} BPM`),
      P.sc ? h('span', null, dIcon('keys', 13), keyLabel(P.sc)) : null,
      h('span', null, dIcon('clock', 13), fmtTime(durationOf(def))),
      h('span', null, dIcon('songs', 13), `${parts} ${t('songPartsN')}`));
    P.loopLbl.textContent = t('songLoop');
    P.loopBtn.classList.toggle('is-on', loopOn);
    P.loopBtn.setAttribute('aria-pressed', String(loopOn));
    const along = !!playAlong && playAlong.id === def.id;
    P.alongLbl.textContent = along ? `${t('songPlayAlongOn')} ${keyLabel(P.sc)}` : `${t('songPlayAlong')} · ${keyLabel(P.sc)}`;
    P.alongBtn.classList.toggle('is-on', along);
    P.alongBtn.setAttribute('aria-pressed', String(along));
    P.alongBtn.title = t('songPlayAlongTip');
    P.alongHint.textContent = along ? t('songPlayAlongHint') : '';
    P.timeline.querySelector('.svp-tlLbl').textContent = t('songSections');
    for (const s of P.secEls) {
      s.seg.querySelector('b').textContent = en ? s.s.name || s.s.zh : s.s.zh || s.s.name;
      s.seg.querySelector('small').textContent = en ? (s.s.zh !== s.s.name ? s.s.zh : '') : s.s.name;
    }
    fitSections();
    for (const r of P.laneRefs) {
      const p = r.part;
      r.name.textContent = en ? p.name || p.zh : p.zh || p.name;
      // English mode: the (English) preset name first, the Chinese part name after it
      r.sub.textContent = en ? [p.preset, p.zh].filter(Boolean).join(' · ') : `${p.name || ''}${p.preset ? ` · ${p.preset}` : ''}`;
      r.useBtn.title = `${t('songUseSound')} — ${p.preset || ''}`;
      r.useBtn.setAttribute('aria-label', r.useBtn.title);
      r.mBtn.title = t('songMute');
      r.sBtn.title = t('songSolo');
      r.mBtn.setAttribute('aria-label', `${t('songMute')} ${r.name.textContent}`);
      r.sBtn.setAttribute('aria-label', `${t('songSolo')} ${r.name.textContent}`);
    }
    updTime(isPlaying && lastState && lastState.song ? lastState.song.beat : 0);
  }

  /** Sections too narrow for their name (phones, short intros) hide it — except the playing one, which floats
   *  above its neighbours — instead of showing a one-glyph stub like "夜". */
  function fitSections() {
    if (!P) return;
    for (const s of P.secEls) {
      const b = s.seg.querySelector('b');
      s.seg.classList.remove('is-tight');
      if (b.clientWidth && b.scrollWidth > b.clientWidth + 1) s.seg.classList.add('is-tight');
    }
  }

  /* ── piano roll canvases ── */
  function sizeCanvas(r) {
    const c = r.canvas;
    const w = Math.max(10, c.clientWidth), hh = Math.max(10, c.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (r.w === w && r.hgt === hh && r.stat) return false;
    r.w = w; r.hgt = hh;
    c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr);
    r.dpr = dpr;
    return true;
  }
  function noteRect(r, e) {
    const L = P.L;
    const x = (e.beat / L) * r.w;
    const w = Math.max(1.5, (Math.min(e.dur, L - e.beat) / L) * r.w - 0.6);
    const span = r.hi - r.lo + 1;
    const nh = Math.max(1.5, Math.min(6, (r.hgt - 6) / span));
    const y = 3 + (r.hi - e.note) / span * (r.hgt - 6 - nh) * (span / Math.max(1, span - 1));
    return [x, Math.min(r.hgt - nh - 2, y), w, nh];
  }
  function drawStatic() {
    if (!P) return;
    for (const r of P.laneRefs) {
      sizeCanvas(r);
      const off = r.stat || document.createElement('canvas');
      off.width = r.canvas.width; off.height = r.canvas.height;
      const g = off.getContext('2d');
      g.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
      g.clearRect(0, 0, r.w, r.hgt);
      // beat grid
      g.fillStyle = 'rgba(140,160,220,.07)';
      for (let b = 0; b < P.L; b += 4) g.fillRect(Math.round((b / P.L) * r.w), 0, 1, r.hgt);
      for (const e of r.evs) {
        const [x, y, w, nh] = noteRect(r, e);
        g.globalAlpha = 0.28 + 0.5 * (e.vel ?? 0.7);
        g.fillStyle = r.color;
        g.beginPath();
        if (g.roundRect) g.roundRect(x, y, w, nh, Math.min(2, nh / 2)); else g.rect(x, y, w, nh);
        g.fill();
      }
      g.globalAlpha = 1;
      r.stat = off;
      r.active = '#';
    }
    drawLive(true);
  }
  function drawLive(force = false) {
    if (!P) return;
    const st = lastState && lastState.song;
    const isPlaying = playingId === P.def.id && st && st.playing !== false;
    const beat = isPlaying ? ((st.beat % P.L) + P.L) % P.L : -1;
    P.laneRefs.forEach((r, i) => {
      if (!r.stat) return;
      if (sizeCanvas(r)) { drawStatic(); return; }
      const ps = st && st.parts && st.parts[i];
      const sounding = ps && Array.isArray(ps.notes) ? new Set(ps.notes) : null;
      // notes under the playhead (and sounding, when the engine reports notes)
      const act = [];
      if (beat >= 0) {
        for (const e of r.evs) {
          if (e.beat > beat) break;
          if (beat < e.beat + Math.max(e.dur, 0.12) && (!sounding || sounding.has(e.note))) act.push(e);
        }
      }
      const key = act.length ? `${act.map(e => `${e.beat}:${e.note}`).join(',')}@${Math.round(beat * 16)}` : '';
      if (!force && key === r.active) return;
      r.active = key;
      const g = r.canvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, r.canvas.width, r.canvas.height);
      g.drawImage(r.stat, 0, 0);
      if (!act.length) return;
      g.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
      g.shadowColor = r.color;
      const px = (beat / P.L) * r.w;
      for (const e of act) {
        const [x, y, w, nh] = noteRect(r, e);
        // the whole sounding note glows in its lane colour; the part already played burns white-hot
        g.shadowBlur = 12;
        g.fillStyle = r.color;
        g.beginPath();
        if (g.roundRect) g.roundRect(x, y - 0.5, w, nh + 1, Math.min(2, nh / 2)); else g.rect(x, y - 0.5, w, nh + 1);
        g.fill();
        g.shadowBlur = 6;
        g.fillStyle = '#fff';
        const ew = Math.max(1.5, Math.min(w, px - x));
        g.beginPath();
        if (g.roundRect) g.roundRect(x, y - 0.5, ew, nh + 1, Math.min(2, nh / 2)); else g.rect(x, y - 0.5, ew, nh + 1);
        g.fill();
      }
      g.shadowBlur = 0;
    });
  }

  /* ── playback ── */
  function play(id = selId) {
    const d = data();
    const def = songs().find(s => s.id === id);
    if (!d || !def) return;
    if (!audioOk()) {
      const a = getAudio();
      // no engine: the gate explains (failed → why, with a retry) or starts it; "tap the page" was wrong after a failure
      if ((!a || a.isNull) && audioGate) { audioGate(); return; }
      if (toast) toast(t(a && a.isNull ? 'songNeedsAudio' : 'songUnavailable'), { kind: 'warn' });
      return;
    }
    const song = resolve(def);
    if (song instanceof Error) { if (toast) toast(`${t('songError')}: ${String(song.message).split('\n')[0]}`, { kind: 'error' }); return; }
    const a = getAudio();
    if (transport) transport.claim('song', () => { try { getAudio().songStop(); } catch { /* ignore */ } playingId = null; prevBeat = -1; releaseAlong(); renderRail(); renderHead(); drawLive(true); });
    try {
      a.songStop();
      a.songLoad({ ...song, loop: loopOn });
      a.songPlay();
    } catch (e) {
      console.error(e);
      if (toast) toast(`${t('songError')}: ${e.message}`, { kind: 'error' });
      if (transport) transport.release('song');
      return;
    }
    playingId = def.id;
    prevBeat = -1;
    // play-along follows the song: switching songs re-locks the keyboard to the new key
    if (playAlong && playAlong.id !== def.id) lockAlong(def, false);
    if (P) for (const r of P.laneRefs) { r.mute = false; r.solo = false; }
    renderRail();
    renderHead();
    tick();
  }
  function stop() {
    const a = getAudio();
    if (a && typeof a.songStop === 'function') { try { a.songStop(); } catch (e) { console.error(e); } }
    playingId = null;
    prevBeat = -1;
    releaseAlong();
    if (transport) transport.release('song');
    renderRail();
    renderHead();
    drawLive(true);
  }
  function togglePlay() { if (playingId && playingId === selId) stop(); else play(selId); }

  function setPart(ref, o) {
    Object.assign(ref, o);
    const a = getAudio();
    if (a && typeof a.songPart === 'function') { try { a.songPart(ref.i, o); } catch (e) { console.error(e); } }
    renderParts();
  }
  function renderParts() {
    if (!P) return;
    const anySolo = P.laneRefs.some(r => r.solo);
    for (const r of P.laneRefs) {
      r.mBtn.classList.toggle('is-on', r.mute);
      r.mBtn.setAttribute('aria-pressed', String(r.mute));
      r.sBtn.classList.toggle('is-on', r.solo);
      r.sBtn.setAttribute('aria-pressed', String(r.solo));
      r.lane.classList.toggle('is-muted', r.mute || (anySolo && !r.solo));
    }
  }

  function useSound(def, song, ref) {
    const part = ref.part;
    const patch = part.patch || null;
    const base = presets.find(p => p.name === part.preset) || null;
    const entry = library && part.preset ? library.findByName(part.preset) : null;
    const params = patch ? patch.params : { ...(base ? base.params : {}), ...(part.params || {}) };
    const macros = patch ? patch.macros : (base ? base.macros : []);
    const overrides = !!(def.parts[ref.i] && (def.parts[ref.i].params || def.parts[ref.i].macros));
    const p = {
      ...(entry || base || {}), name: part.preset || part.name, category: (base && base.category) || (entry && entry.category) || null,
      params, macros, key: entry && !overrides ? entry.key : null,
    };
    if (loadEntry) loadEntry(p, { record: true, dirty: overrides });
    else store.loadPreset(p, { record: true, source: 'factory', key: p.key || null, dirty: overrides });
    if (toast) toast(`${t('songUsing')}：${part.preset || part.name}`, { kind: 'ok', ms: 1800 });
    ref.lane.classList.remove('is-picked'); void ref.lane.offsetWidth; ref.lane.classList.add('is-picked');
  }

  /** Lock the keyboard (scale.root / scale.type, global params) to the song's key; remembers the user's setting. */
  function lockAlong(def, announce = true) {
    const sc = songScale(def.key);
    if (!sc) return false;
    const prev = playAlong || { prevRoot: store.get('scale.root'), prevType: store.get('scale.type') };
    playAlong = { id: def.id, prevRoot: prev.prevRoot, prevType: prev.prevType };
    storage.set(ALONG_KEY, { prevRoot: prev.prevRoot, prevType: prev.prevType });
    store.set('scale.root', sc.root);
    store.set('scale.type', sc.scale);
    if (toast) toast(`${t('songPlayAlongOn')} ${keyLabel(sc)}${announce ? ` — ${t('songPlayAlongHint')}` : ''}`, { kind: 'ok', ms: announce ? 2600 : 1600 });
    return true;
  }
  /** Give the user's own scale setting back (song stopped, or play-along switched off). */
  function releaseAlong(announce = true) {
    if (!playAlong) return;
    store.set('scale.root', playAlong.prevRoot);
    store.set('scale.type', playAlong.prevType);
    playAlong = null;
    storage.remove(ALONG_KEY);
    if (announce && toast) toast(t('songPlayAlongOff'), { ms: 1400 });
  }
  function togglePlayAlong(def) {
    if (playAlong && playAlong.id === def.id) releaseAlong();
    else if (lockAlong(def) && playingId !== def.id) play(def.id);
    renderHead();
  }

  /* ── state → UI ── */
  function sectionLabel(st) {
    if (!P) return '';
    const en = getLang() === 'en';
    let s = null;
    if (st && typeof st.sectionIndex === 'number' && P.secEls[st.sectionIndex]) s = P.secEls[st.sectionIndex].s;
    else if (st && typeof st.section === 'number') s = P.secEls[st.section] && P.secEls[st.section].s;
    else if (st && st.section && typeof st.section === 'object') s = st.section;
    else if (st && typeof st.section === 'string') s = (P.secEls.find(x => x.s.name === st.section || x.s.zh === st.section) || {}).s || { name: st.section, zh: st.section };
    if (!s && st) { const b = ((st.beat % P.L) + P.L) % P.L; const f = P.secEls.filter(x => x.from <= b + 1e-6).pop(); s = f && f.s; }
    return s ? (en ? s.name || s.zh : s.zh || s.name) : '';
  }
  function updTime(beat) {
    if (!P) return;
    const spb = 60 / (P.def.bpm || 120);
    const b = ((beat % P.L) + P.L) % P.L;
    P.time.textContent = `${fmtTime(b * spb)} / ${fmtTime(P.L * spb)}`;
    const p = b / P.L;
    P.playhead.style.setProperty('--p', p.toFixed(5));
    P.timeline.style.setProperty('--p', p.toFixed(5));
    for (const s of P.secEls) s.seg.classList.toggle('is-on', playingId === P.def.id && b >= s.from - 1e-6 && b < s.to - 1e-6);
  }

  let raf = 0;
  function tick() {
    if (raf) return;
    raf = requestAnimationFrame(frame);
  }
  let meterT = 0;
  function frame() {
    raf = 0;
    if (!visible || !P) return;
    const st = lastState && lastState.song;
    if (playingId === P.def.id && st) {
      // interpolate the beat between ~30 Hz state messages
      const dt = (performance.now() - (lastState._t || performance.now())) / 1000;
      const beat = (st.beat || 0) + (st.playing !== false ? dt * ((st.bpm || P.def.bpm) / 60) : 0);
      updTime(beat);
      drawLive();
      const now = performance.now();
      if (now - meterT > 45) {
        meterT = now;
        P.laneRefs.forEach((r, i) => {
          const ps = st.parts && st.parts[i];
          let pk = ps ? +ps.peak || 0 : 0;
          if (pk > 1.5 || pk < 0) pk = Math.pow(10, Math.max(-60, Math.min(0, pk)) / 20); // tolerate dB
          const db = pk > 1e-5 ? 20 * Math.log10(pk) : -60;
          const v = Math.max(0, Math.min(1, (db + 48) / 48));
          r.peak = v > r.peak ? v : r.peak * 0.86 + v * 0.14;
          r.meter.firstChild.style.transform = `scaleY(${r.peak.toFixed(3)})`;
          if (ps && typeof ps.mute === 'boolean' && ps.mute !== r.mute) { r.mute = ps.mute; renderParts(); }
          if (ps && typeof ps.solo === 'boolean' && ps.solo !== r.solo) { r.solo = ps.solo; renderParts(); }
        });
      }
      tick();
    } else {
      for (const r of P.laneRefs) if (r.peak > 0.001) { r.peak *= 0.8; r.meter.firstChild.style.transform = `scaleY(${r.peak.toFixed(3)})`; }
      if (P.laneRefs.some(r => r.peak > 0.001)) tick();
    }
  }

  function onState(st) {
    if (!st) return;
    st._t = performance.now();
    lastState = st;
    const s = st.song;
    if (playingId) {
      if (!s || s.playing === false) {
        // the engine finished (non-looping song): replay when loop is on
        if (s && s.playing === false && prevBeat >= 0) {
          if (loopOn) { const id = playingId; playingId = null; play(id); } else stop();
        }
      } else {
        const b = s.beat || 0;
        const L = s.lengthBeats || (P && P.L) || 0;
        // loop off while the engine loops: stop at the wrap
        if (!loopOn && prevBeat >= 0 && L && (b % L) + 0.5 < (prevBeat % L)) { stop(); return; }
        prevBeat = b;
      }
      if (visible) tick();
    }
  }

  function select(id) {
    if (!songs().some(s => s.id === id)) return;
    selId = id;
    try { localStorage.setItem('aurora.song', id); } catch { /* ignore */ }
    renderRail();
    buildPlayer();
    const c = railCards.find(x => x.def.id === id);
    if (c && c.el.scrollIntoView) { try { c.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch { /* ignore */ } }
    tick();
  }

  function dataChanged() {
    const list = songs();
    empty.hidden = list.length > 0;
    empty.textContent = data() ? t('songsEmpty') : t('songsLoading');
    rail.hidden = !list.length;
    player.hidden = !list.length;
    if (!list.length) return;
    if (!list.some(s => s.id === selId)) selId = list[0].id;
    buildRail();
    buildPlayer();
  }

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (visible && P) { drawStatic(); fitSections(); } }).observe(player);
  rail.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const list = songs();
    const i = list.findIndex(s => s.id === selId);
    const j = Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    e.preventDefault();
    e.stopPropagation();
    select(list[j].id);
    const c = railCards[j];
    if (c) c.el.focus();
  });

  dataChanged();
  return {
    el,
    dataChanged,
    setVisible(v) { visible = !!v; if (visible) { requestAnimationFrame(() => { drawStatic(); tick(); }); } },
    onState,
    renderLang() { renderRail(); renderHead(); if (!songs().length) empty.textContent = data() ? t('songsEmpty') : t('songsLoading'); },
    togglePlay,
    play, stop,
    nowPlaying() {
      if (!playingId) return null;
      const def = songs().find(s => s.id === playingId);
      if (!def) return null;
      const st = lastState && lastState.song;
      const L = (st && st.lengthBeats) || def.lengthBeats || 16;
      const b = st ? ((st.beat % L) + L) % L : 0;
      const sec = P && P.def.id === def.id ? sectionLabel(st) : '';
      return { id: def.id, title: def.title, zh: def.zh, section: sec, progress: b / L, colors: def.cover && def.cover.colors };
    },
    get playingId() { return playingId; },
  };
}
