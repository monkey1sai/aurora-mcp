// 劇院模式 Theater: a lean-back full-screen showcase. A huge hero visualizer, large captions (preset name,
// description, which macro is moving right now), auto-cycling through factory presets (all or one category)
// — each plays its demo phrase with macro rides for ~20–30 s (whole phrase passes), with a smooth output
// dip-and-rise between presets — or through all demo songs in sequence.
// Keys: Esc exit · ←/→ previous/next · Space pause · F full screen. The user's patch is restored on exit
// (unless "使用這個音色 Use this sound" was chosen).

import { h } from '../app/dom.js';
import { t, getLang } from '../app/i18n.js';
import { dIcon } from './center.js';
import { descOf } from './songsView.js';
import { presetDemoSong, macroValues, snapshotPatch, applyPatchSilently, restorePatch } from './automation.js';
import { fullscreenSupported, fullscreenElement, requestFullscreen, exitFullscreen } from '../compat.js';

const PALETTE_FOR = { keys: 'aurora', pad: 'aurora', bass: 'sunset', lead: 'sunset', pluck: 'ocean', bell: 'ocean', strings: 'sunset', arp: 'ocean', fx: 'aurora', drum: 'sunset' };
const FADE_OUT = 0.65, FADE_IN = 0.9; // seconds
const nameParts = (s) => {
  const m = /^(.*?[⺀-鿿].*?)\s+([A-Za-z0-9][\w .&/+'’-]*)$/.exec(String(s || ''));
  return m ? { zh: m[1], en: m[2] } : { zh: String(s || ''), en: '' };
};
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * @param {{ store, getAudio, presets, categories, visuals, phrases, library, loadEntry, transport, playView, toast,
 *           songsData: () => ({SONGS, resolveSong, songDuration}|null) }} o
 */
export function createTheater({ store, getAudio, presets = [], categories = [], visuals = null, phrases = null, library = null, loadEntry = null, transport = null, playView = null, toast = null, songsData = () => null, audioGate = null }) {
  const cfg = { source: 'all', secs: 24, shuffle: false };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('aurora.theater') || '{}')); } catch { /* ignore */ }
  const saveCfg = () => { try { localStorage.setItem('aurora.theater', JSON.stringify(cfg)); } catch { /* ignore */ } };

  /* ═════════════ launcher (Demo Center tab) ═════════════ */
  // the preview IS a way in: its big ▶ circle looked like a play button, so the whole card is one
  const lPreview = h('button.th-prev', { type: 'button' }, h('i', { 'aria-hidden': 'true' }), h('i', { 'aria-hidden': 'true' }), h('i', { 'aria-hidden': 'true' }),
    h('span.th-prev__word', { 'aria-hidden': 'true' }, 'AURORA'), h('span.th-prev__play', { 'aria-hidden': 'true' }, dIcon('theater', 30)));
  lPreview.addEventListener('click', () => enter());
  const lTitle = h('h3.th-l__title');
  const lDesc = h('p.th-l__desc');
  const chips = h('div.th-l__chips', { role: 'radiogroup', 'aria-label': t('thSource') });
  const secsVal = h('b.th-l__secsVal');
  const secsInput = h('input.th-l__range', { type: 'range', min: 20, max: 30, step: 1, value: String(cfg.secs) });
  secsInput.addEventListener('input', () => { cfg.secs = +secsInput.value; secsVal.textContent = `${cfg.secs} s`; saveCfg(); });
  const secsLbl = h('span.th-l__lbl');
  const shufLbl = h('span');
  const shuf = h('button.pill-btn.th-l__shuf', { type: 'button', 'aria-pressed': String(cfg.shuffle) }, dIcon('shuffle', 15), shufLbl);
  shuf.addEventListener('click', () => { cfg.shuffle = !cfg.shuffle; saveCfg(); renderLauncher(); });
  const enterLbl = h('span');
  const enterBtn = h('button.btn.btn--primary.th-l__enter', { type: 'button' }, dIcon('theater', 17), enterLbl);
  enterBtn.addEventListener('click', () => enter());
  const lKeys = h('p.th-l__keys');
  const qLbl = h('span.th-l__lbl');
  const qHint = h('span.th-l__qhint');
  const queue = h('div.th-l__queue', { role: 'group' });
  const launcherEl = h('div.th-l', null,
    h('div.th-l__stage', null, lPreview),
    h('div.th-l__side', null, lTitle, lDesc,
      h('div.th-l__row', null, h('span.th-l__lbl.th-l__srcLbl'), chips),
      h('div.th-l__row', null, secsLbl, h('div.th-l__secs', null, secsInput, secsVal)),
      h('div.th-l__row.th-l__row--btns', null, shuf, enterBtn),
      lKeys),
    h('div.th-l__qwrap', null, h('div.th-l__qhead', null, qLbl, qHint), queue));
  const sources = () => [
    { id: 'all', zh: '全部音色', en: 'All presets', icon: 'grid', color: '#5cf2ff' },
    ...categories.filter(c => presets.some(p => p.category === c.id)).map(c => ({ id: c.id, zh: c.zh, en: c.label, icon: c.icon, color: c.color })),
    { id: 'songs', zh: '示範曲連播', en: 'All songs', icon: 'songs', color: '#ff6bd6' },
  ];
  /** Items of the current source in playing order (unshuffled). */
  function sourceItems() {
    if (cfg.source === 'songs') { const d = songsData(); return d ? d.SONGS.slice() : []; }
    return cfg.source === 'all' ? presets.slice() : presets.filter(p => p.category === cfg.source);
  }
  const QMAX = 14;
  function renderQueue() {
    const en = getLang() === 'en';
    const items = sourceItems();
    const songs = cfg.source === 'songs';
    qLbl.textContent = `${t('thQueue')} · ${items.length}`;
    queue.setAttribute('aria-label', t('thQueue'));
    qHint.textContent = cfg.shuffle ? t('thQueueShuffled') : t('thQueueHint');
    queue.textContent = '';
    items.slice(0, QMAX).forEach((it, i) => {
      let art, name, sub, c1, c2;
      if (songs) {
        const cols = (it.cover && it.cover.colors) || ['#ff6bd6', '#a78bfa'];
        c1 = cols[0]; c2 = cols[1] || cols[0];
        art = h('span.th-q__art.th-q__art--song', null, dIcon('songs', 16));
        name = en ? it.title : it.zh;
        sub = en ? it.genre || it.zhGenre : it.zhGenre || it.genre;
      } else {
        const cat = categories.find(c => c.id === it.category);
        c1 = (cat && cat.color) || '#5cf2ff'; c2 = '#a78bfa';
        art = h('span.th-q__art', null, dIcon((cat && cat.icon) || 'sparkle', 16));
        name = it.name;
        sub = cat ? (en ? cat.label : cat.zh) : '';
      }
      const b = h('button.th-q', { type: 'button', '--c1': c1, '--c2': c2, style: `--i:${i}`, title: `${t('thStartHere')} — ${name}` },
        art, h('span.th-q__txt', null, h('b', null, name), h('small', null, sub)), h('span.th-q__n', null, String(i + 1).padStart(2, '0')));
      b.setAttribute('aria-label', `${t('thStartHere')}: ${name}`);
      b.addEventListener('click', () => enter({ startAt: it }));
      queue.append(b);
    });
    if (items.length > QMAX) queue.append(h('span.th-q.th-q--more', { 'aria-hidden': 'true' }, h('b', null, `+${items.length - QMAX}`), h('small', null, t('thMore'))));
  }

  function renderLauncher() {
    const en = getLang() === 'en';
    lTitle.textContent = t('thTitle');
    lDesc.textContent = t('thDesc');
    launcherEl.querySelector('.th-l__srcLbl').textContent = t('thSource');
    chips.setAttribute('aria-label', t('thSource'));
    secsLbl.textContent = t('thSeconds');
    secsInput.setAttribute('aria-label', t('thSecondsAria'));
    lPreview.setAttribute('aria-label', t('thEnter'));
    lPreview.title = t('thEnter');
    secsVal.textContent = `${cfg.secs} s`;
    // songs play whole: the per-preset time does not apply
    secsInput.disabled = cfg.source === 'songs';
    secsLbl.parentElement.classList.toggle('is-off', cfg.source === 'songs');
    shufLbl.textContent = t('thShuffle');
    shuf.classList.toggle('is-on', !!cfg.shuffle);
    shuf.setAttribute('aria-pressed', String(!!cfg.shuffle));
    enterLbl.textContent = t('thEnter');
    lKeys.textContent = t('thKeys');
    chips.textContent = '';
    for (const s of sources()) {
      const on = cfg.source === s.id;
      const n = s.id === 'all' ? presets.length : s.id === 'songs' ? (songsData() ? songsData().SONGS.length : 0) : presets.filter(p => p.category === s.id).length;
      const b = h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(on), '--c': s.color || '#5cf2ff', class: on ? 'is-on' : '' },
        dIcon(s.icon, 14), h('span', null, en ? s.en : s.zh), h('span.chip__n', null, String(n)));
      b.addEventListener('click', () => { cfg.source = s.id; saveCfg(); renderLauncher(); });
      chips.append(b);
    }
    renderQueue();
  }

  /* ═════════════ full-screen stage ═════════════ */
  const heroHost = h('div.th__hero', { 'aria-hidden': 'true' });
  const counter = h('span.th__count');
  const exitBtn = h('button.th-btn.th__exit', { type: 'button' }, dIcon('x', 20));
  exitBtn.addEventListener('click', () => exit());
  const fsBtn = h('button.th-btn', { type: 'button' }, dIcon('fullscreen', 18));
  fsBtn.hidden = !fullscreenSupported(); // iPhone Safari cannot make an element full screen (iPadOS: webkit prefix)
  fsBtn.addEventListener('click', () => toggleFs());
  const catChip = h('span.th__cat');
  const nameEl = h('h1.th__name');
  const nameEn = h('p.th__en');
  const descEl = h('p.th__desc');
  const chgLbl = h('span.th__chgLbl');
  const chgName = h('b.th__chgName');
  const chgArrow = h('span.th__chgArrow');
  const changing = h('div.th__changing', { 'aria-live': 'off' }, chgLbl, chgName, chgArrow);
  const macroBars = h('div.th__macros', { 'aria-hidden': 'true' });
  const partsEl = h('div.th__parts', { 'aria-hidden': 'true' });
  const caption = h('div.th__caption', null, catChip, nameEl, nameEn, descEl, changing, macroBars, partsEl);
  const prog = h('i.th__progFill');
  const prevBtn = h('button.th-btn', { type: 'button' }, dIcon('prev', 22));
  const pauseBtn = h('button.th-btn.th-btn--big', { type: 'button' }, dIcon('pause', 24));
  const nextBtn = h('button.th-btn', { type: 'button' }, dIcon('next', 22));
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  pauseBtn.addEventListener('click', () => togglePause());
  const useLbl = h('span');
  const useBtn = h('button.pill-btn.th__use', { type: 'button' }, dIcon('check', 15), useLbl);
  useBtn.addEventListener('click', () => useThis());
  const upNext = h('span.th__next');
  const keysHint = h('span.th__keys');
  const stage = h('div.theater', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Theater', tabindex: '-1', hidden: true },
    heroHost, h('div.th__vignette', { 'aria-hidden': 'true' }),
    h('header.th__top', null, h('div.th__brand', null, h('span.logo__mark', { 'aria-hidden': 'true' }), h('span.th__brandTxt', null, 'AURORA'), h('span.th__brandSub')), h('span.th__spacer'), counter, fsBtn, exitBtn),
    caption,
    h('footer.th__bottom', null,
      h('div.th__prog', null, prog),
      h('div.th__ctl', null, h('div.th__ctlL', null, upNext), h('div.th__ctlC', null, prevBtn, pauseBtn, nextBtn), h('div.th__ctlR', null, useBtn)),
      keysHint));

  /* ═════════════ runtime ═════════════ */
  let open = false, paused = false, mode = 'presets';
  let list = [], idx = 0, snap = null, heroInst = null, timer = 0, switching = false, token = 0;
  let itemStart = 0, dwell = 24, pausedAt = 0;
  let prevMacros = null, chgVel = [0, 0, 0, 0], lastChg = -1;
  let uiTimer = 0, progRaf = 0, exitedAt = -1e9;
  const audio = () => getAudio();

  function buildList() {
    if (cfg.source === 'songs') {
      const d = songsData();
      mode = 'songs';
      list = d ? d.SONGS.slice() : [];
    } else {
      mode = 'presets';
      list = cfg.source === 'all' ? presets.slice() : presets.filter(p => p.category === cfg.source);
    }
    if (cfg.shuffle) {
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    }
  }

  function gainTo(v, sec) {
    const a = audio();
    const g = a && a.output && a.output.gain;
    if (!g || !a.ctx) return;
    const now = a.ctx.currentTime;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(v, now + Math.max(0.01, sec));
    } catch { g.value = v; }
  }

  function stopPlayback() {
    const a = audio();
    if (!a) return;
    try { a.seqStop(); } catch { /* ignore */ }
    if (typeof a.songStop === 'function') { try { a.songStop(); } catch { /* ignore */ } }
  }

  function startItem() {
    const a = audio();
    const item = list[idx];
    if (!a || !item) return;
    if (mode === 'presets') {
      applyPatchSilently(store, item, { source: 'demo' });
      const demo = presetDemoSong({ phrases, meta: item, demoMacros: item.demoMacros, macros: store.getMacros(), values: macroValues(store) });
      if (demo) {
        a.seqLoad(demo.song);
        a.seqPlay();
        const pass = (demo.song.lengthBeats * 60) / (demo.song.bpm || 120);
        const passes = Math.max(1, Math.round(cfg.secs / pass));
        dwell = pass * (pass > cfg.secs * 1.5 ? 1 : passes);
      } else dwell = cfg.secs;
      if (heroInst && heroInst.setPalette) { try { heroInst.setPalette(PALETTE_FOR[item.category] || 'aurora'); } catch { /* ignore */ } }
    } else {
      const d = songsData();
      let song = null;
      try { song = d.resolveSong(item, presets); } catch (e) { console.error(e); }
      if (song && typeof a.songLoad === 'function') {
        a.songLoad({ ...song, loop: false });
        a.songPlay();
        dwell = (d.songDuration ? d.songDuration(song) : (song.lengthBeats * 60) / song.bpm) + 1.2;
      } else {
        dwell = 4;
        if (toast) toast(t('songUnavailable'), { kind: 'warn' });
      }
      if (heroInst && heroInst.setPalette) { try { heroInst.setPalette(['aurora', 'sunset', 'ocean'][idx % 3]); } catch { /* ignore */ } }
    }
    itemStart = performance.now();
    prevMacros = null;
    chgVel = [0, 0, 0, 0];
    renderItem();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (paused || !open) return;
    const left = dwell - (performance.now() - itemStart) / 1000;
    // start the dip slightly before the phrase ends so the switch lands on the loop point
    timer = setTimeout(() => step(1, true), Math.max(200, (left - FADE_OUT) * 1000));
  }

  async function show(i, auto = false) {
    if (!list.length) return;
    const my = ++token;
    switching = true;
    stage.classList.add('is-switching');
    gainTo(0, FADE_OUT);
    await new Promise(r => setTimeout(r, (auto ? FADE_OUT : FADE_OUT * 0.7) * 1000));
    if (my !== token || !open) return;
    stopPlayback();
    idx = ((i % list.length) + list.length) % list.length;
    startItem();
    await new Promise(r => setTimeout(r, 60));
    if (my !== token || !open) return;
    gainTo(1, FADE_IN);
    stage.classList.remove('is-switching');
    switching = false;
    if (paused) { paused = false; renderPause(); }
  }
  function step(d, auto = false) { if (open) show(idx + d, auto); }

  function togglePause() {
    if (!open) return;
    paused = !paused;
    const a = audio();
    if (paused) {
      pausedAt = performance.now();
      clearTimeout(timer);
      stopPlayback();
    } else {
      // restart the current item's playback from its top (the sequencer cannot seek)
      if (a) {
        if (mode === 'presets') { const demo = presetDemoSong({ phrases, meta: list[idx], demoMacros: list[idx].demoMacros, macros: store.getMacros(), values: macroValues(store) }); if (demo) { a.seqLoad(demo.song); a.seqPlay(); } }
        else if (typeof a.songPlay === 'function') a.songPlay();
      }
      itemStart = performance.now();
      schedule();
    }
    renderPause();
  }
  function renderPause() {
    pauseBtn.replaceChildren(dIcon(paused ? 'play' : 'pause', 24));
    pauseBtn.title = `${t(paused ? 'tourResume' : 'tourPause')} (Space)`;
    pauseBtn.setAttribute('aria-label', t(paused ? 'tourResume' : 'tourPause'));
    stage.classList.toggle('is-paused', paused);
  }

  function renderItem() {
    const item = list[idx];
    if (!item) return;
    const en = getLang() === 'en';
    counter.textContent = `${idx + 1} / ${list.length}`;
    const nxt = list[(idx + 1) % list.length];
    upNext.textContent = nxt && list.length > 1 ? `${t('thUpNext')}：${mode === 'songs' ? (en ? nxt.title : nxt.zh) : nxt.name}` : '';
    catChip.textContent = '';
    macroBars.textContent = '';
    partsEl.textContent = '';
    changing.classList.remove('is-on');
    if (mode === 'presets') {
      const cat = categories.find(c => c.id === item.category);
      if (cat) {
        catChip.style.setProperty('--c', cat.color || 'var(--a-cyan)');
        catChip.append(dIcon(cat.icon, 16), h('span', null, en ? cat.label : cat.zh), h('small', null, en ? cat.zh : cat.label));
      }
      nameEl.textContent = item.name;
      nameEn.textContent = (item.tags || []).slice(0, 4).map(x => `#${x}`).join('  ');
      descEl.textContent = item.description || '';
      (store.getMacros() || []).forEach((m, i) => {
        const np = nameParts(m.name);
        const bar = h('div.th__mb', { '--mc': ['#3ef0b0', '#5cf2ff', '#a78bfa', '#ff6bd6'][i] }, h('span.th__mbName', null, `M${i + 1} ${en ? np.en || np.zh : np.zh || np.en}`), h('span.th__mbTrack', null, h('i')));
        if (!m.targets || !m.targets.length) bar.classList.add('is-empty');
        macroBars.append(bar);
      });
      updMacroBars(macroValues(store));
    } else {
      catChip.style.setProperty('--c', (item.cover && item.cover.colors && item.cover.colors[0]) || 'var(--a-pink)');
      catChip.append(dIcon('songs', 16), h('span', null, en ? item.genre || item.zhGenre : item.zhGenre || item.genre), h('small', null, `${Math.round(item.bpm)} BPM`));
      nameEl.textContent = en ? item.title : item.zh;
      nameEn.textContent = en ? item.zh : item.title;
      descEl.textContent = descOf(item, en);
      for (const p of item.parts || []) partsEl.append(h('span.th__part', null, h('i'), h('span', null, en ? p.name : p.zh || p.name), h('small', null, p.preset && typeof p.preset === 'string' ? p.preset : '')));
    }
    // re-trigger the caption entrance
    caption.classList.remove('is-in');
    void caption.offsetWidth;
    caption.classList.add('is-in');
  }

  function updMacroBars(vals) {
    const bars = macroBars.children;
    for (let i = 0; i < 4 && i < bars.length; i++) {
      const v = Math.max(0, Math.min(1, +vals[i] || 0));
      bars[i].querySelector('i').style.transform = `scaleX(${v.toFixed(3)})`;
    }
  }

  function onState(st) {
    if (!open || !st) return;
    if (mode === 'presets' && Array.isArray(st.macros)) {
      const m = st.macros;
      if (prevMacros) {
        let best = -1, bv = 0;
        for (let i = 0; i < 4; i++) {
          const d = (m[i] || 0) - (prevMacros[i] || 0);
          chgVel[i] = chgVel[i] * 0.7 + d * 0.3;
          if (Math.abs(chgVel[i]) > bv) { bv = Math.abs(chgVel[i]); best = i; }
        }
        const bars = macroBars.children;
        for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('is-moving', i === best && bv > 0.0012);
        if (best >= 0 && bv > 0.0012) {
          const mac = store.getMacros()[best];
          const np = nameParts(mac && mac.name);
          const en = getLang() === 'en';
          if (best !== lastChg || !changing.classList.contains('is-on')) {
            chgName.textContent = `M${best + 1} ${en ? np.en || np.zh : np.zh || np.en}`;
            changing.style.setProperty('--mc', ['#3ef0b0', '#5cf2ff', '#a78bfa', '#ff6bd6'][best]);
          }
          chgArrow.textContent = chgVel[best] > 0 ? '↗' : '↘';
          changing.classList.add('is-on');
          lastChg = best;
        } else if (bv < 0.0004) changing.classList.remove('is-on');
      }
      prevMacros = m.slice();
      updMacroBars(m);
    } else if (mode === 'songs' && st.song) {
      const parts = partsEl.children;
      const sp = st.song.parts || [];
      for (let i = 0; i < parts.length; i++) {
        let pk = sp[i] ? +sp[i].peak || 0 : 0;
        if (pk > 1.5 || pk < 0) pk = Math.pow(10, Math.max(-60, Math.min(0, pk)) / 20);
        const v = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-5, pk)) + 42) / 42));
        parts[i].style.setProperty('--lv', v.toFixed(3));
      }
      const item = list[idx];
      if (item && item.sections && item.sections.length) {
        const L = item.lengthBeats || 1;
        const b = ((st.song.beat || 0) % L + L) % L;
        const sec = item.sections.filter(s => s.beat <= b + 1e-6).pop();
        if (sec) {
          const en = getLang() === 'en';
          chgLbl.textContent = t('thSection');
          chgName.textContent = en ? sec.name : sec.zh || sec.name;
          chgArrow.textContent = '';
          changing.style.setProperty('--mc', (item.cover && item.cover.colors && item.cover.colors[1]) || '#5cf2ff');
          changing.classList.add('is-on');
        }
      }
    }
  }

  function progressLoop() {
    progRaf = 0;
    if (!open) return;
    const el = paused ? pausedAt - itemStart : performance.now() - itemStart;
    const p = Math.max(0, Math.min(1, el / 1000 / dwell));
    prog.style.transform = `scaleX(${p.toFixed(4)})`;
    progRaf = requestAnimationFrame(progressLoop);
  }

  function pokeUi() {
    stage.classList.add('is-ui');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => { if (!stage.matches(':focus-within') || document.activeElement === stage) stage.classList.remove('is-ui'); }, 3200);
  }

  function onKey(e) {
    if (!open) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); exitFullscreen(); exit(); return; }
    if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); step(k === 'ArrowRight' ? 1 : -1); pokeUi(); return; }
    if (k === ' ') {
      const tgt = e.target;
      if (tgt && tgt.closest && tgt.closest('button') && tgt !== stage) return; // Space activates the focused button
      e.preventDefault(); e.stopImmediatePropagation(); togglePause(); pokeUi(); return;
    }
    if (k === 'f' || k === 'F') { e.preventDefault(); e.stopImmediatePropagation(); toggleFs(); return; }
    if (k === 'Tab') {
      pokeUi();
      const f = [...stage.querySelectorAll('button')].filter(b => !b.disabled && b.offsetParent);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      return;
    }
    if (k === '/' || k === '?') e.stopImmediatePropagation();
  }
  document.addEventListener('keydown', onKey, true);
  stage.addEventListener('pointermove', pokeUi);
  stage.addEventListener('pointerdown', pokeUi);

  function toggleFs() {
    try {
      if (fullscreenElement()) exitFullscreen();
      else requestFullscreen(stage);
    } catch { /* not supported */ }
  }

  let prevFocus = null;
  function enter({ startAt = null } = {}) {
    if (open) return;
    const a = audio();
    buildList();
    if (!list.length) { if (toast) toast(t(mode === 'songs' ? 'songsEmpty' : 'thEmpty'), { kind: 'warn' }); return; }
    if (!a || a.isNull) { if (audioGate) audioGate(); else if (toast) toast(t('songNeedsAudio'), { kind: 'warn' }); return; }
    if (transport) transport.claim('theater', () => exit({ fromTransport: true }));
    open = true;
    paused = false;
    if (typeof store.claim === 'function') store.claim('theater', { exclusive: true }); // magic tools pause
    snap = snapshotPatch(store, { committed: true });
    prevFocus = document.activeElement;
    if (!stage.isConnected) document.body.append(stage);
    stage.hidden = false;
    document.documentElement.classList.add('theater-open');
    if (!heroInst && visuals && visuals.createHeroVisualizer && a.analyser) {
      try {
        heroInst = visuals.createHeroVisualizer({ analyser: a.analyser, analyserL: a.analyserL, analyserR: a.analyserR, getState: () => a.getState() });
        heroHost.append(heroInst.el);
      } catch (e) { console.error('[aurora theater] hero failed', e); }
    }
    if (heroInst) heroInst.start();
    if (playView && playView.setHeroPaused) playView.setHeroPaused('theater', true);
    renderLang();
    renderPause();
    // start from the chosen item, else the current preset when it is in the list
    const curName = store.getMeta().name;
    let at = startAt ? list.indexOf(startAt) : -1;
    if (at < 0 && mode === 'presets') at = list.findIndex(p => p.name === curName);
    idx = at >= 0 ? at : 0;
    stopPlayback();
    gainTo(0, 0.05);
    requestAnimationFrame(() => stage.classList.add('is-in'));
    setTimeout(() => {
      if (!open) return;
      startItem();
      gainTo(1, FADE_IN);
    }, 120);
    pokeUi();
    progressLoop();
    setTimeout(() => pauseBtn.focus({ preventScroll: true }), 80);
  }

  function exit({ fromTransport = false, keep = false } = {}) {
    if (!open) return;
    open = false;
    exitedAt = performance.now();
    token++;
    clearTimeout(timer);
    cancelAnimationFrame(progRaf);
    stopPlayback();
    gainTo(1, 0.25);
    if (!keep && snap) restorePatch(store, snap);
    snap = null;
    if (typeof store.release === 'function') store.release('theater');
    stage.classList.remove('is-in', 'is-ui', 'is-switching');
    document.documentElement.classList.remove('theater-open');
    exitFullscreen();
    setTimeout(() => { if (!open) { stage.hidden = true; if (heroInst) heroInst.stop(); } }, 420);
    if (playView && playView.setHeroPaused) playView.setHeroPaused('theater', false);
    if (transport && !fromTransport) transport.release('theater');
    const back = prevFocus && prevFocus.focus && document.contains(prevFocus) ? prevFocus : enterBtn.offsetParent ? enterBtn : null;
    if (back) { try { back.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  function useThis() {
    const item = list[idx];
    if (!item) return;
    if (mode === 'presets') {
      const entry = library ? library.findByName(item.name) : null;
      // put the user's patch back first: loading over it then keeps unsaved edits one undo step away
      // (loading over the borrowed demo patch left an orphaned 'demo' patch in the history)
      exit();
      if (loadEntry) loadEntry(entry || item, {}); else store.loadPreset(item, { source: 'factory' });
      if (toast) toast(`${t('songUsing')}：${item.name}`, { kind: 'ok', ms: 1600 });
    } else {
      exit();
    }
  }

  function renderLang() {
    renderLauncher();
    stage.querySelector('.th__brandSub').textContent = t('dcTheater');
    exitBtn.title = `${t('thExit')} (Esc)`;
    exitBtn.setAttribute('aria-label', t('thExit'));
    fsBtn.title = `${t('thFullscreen')} (F)`;
    fsBtn.setAttribute('aria-label', t('thFullscreen'));
    prevBtn.title = `${t('thPrev')} (←)`; prevBtn.setAttribute('aria-label', t('thPrev'));
    nextBtn.title = `${t('thNext')} (→)`; nextBtn.setAttribute('aria-label', t('thNext'));
    useLbl.textContent = mode === 'songs' ? t('thExit') : t('thUseSound');
    keysHint.textContent = t('thKeys');
    chgLbl.textContent = mode === 'songs' ? t('thSection') : t('thChanging');
    stage.setAttribute('aria-label', t('dcTheater'));
    renderPause();
    if (open) renderItem();
  }
  renderLauncher();

  return {
    launcherEl,
    el: stage,
    enter, exit,
    isOpen: () => open,
    onState,
    renderLang,
    setLauncherVisible(v) { launcherEl.classList.toggle('is-visible', !!v); if (v) renderLauncher(); },
    // while open the play view is hidden; right after exit, stale engine states must not overwrite the restored macros
    ownsMacros: () => open || performance.now() - exitedAt < 900,
    status: () => ({ open, paused, idx, total: list.length, mode, item: list[idx] ? (list[idx].name || list[idx].title) : null, dwell, elapsed: (performance.now() - itemStart) / 1000 }),
    _fmt: fmtTime,
  };
}
