// Browser / platform compatibility helpers (docs/ARCHITECTURE.md §11). No imports and no side effects at load:
// every function takes its globals as optional arguments, so tools/test.mjs (suite 'compat') runs them in Node
// with fakes. Everything here degrades to a no-op when an API is missing.
//
//   audioBlockedReason()      → why Web Audio cannot start here (http://<LAN-IP> is not a secure context), or null
//   preferPlaybackSession()   → iOS 16.4+/17: navigator.audioSession.type = 'playback' (ring/silent switch ≠ mute)
//   startSilentUnlock()       → older iOS: a looping silent <audio> started in the gesture does the same
//   midiSupported() / midiPermission() / watchMidiPermission() → Web MIDI without a surprise permission prompt
//   createWakeLock()          → keep the screen on while something plays (theater, songs, jam…)
//   fullscreenSupported() / fullscreenElement() / requestFullscreen() / exitFullscreen() → incl. webkit prefix
//   attachResumePrompt()      → "聲音已暫停 — 點一下恢復" pill when the AudioContext gets suspended/interrupted
//   applySplashCompat()       → splash notes: insecure context warning, MIDI hint only where Web MIDI exists

/** Contexts faster than this are recreated at this rate (96/192 kHz interfaces cost 2–4× the DSP for nothing). */
export const MAX_AUTO_SAMPLE_RATE = 48000;

/** { code, zh, en, message } when audio cannot run in this page, else null. */
export function audioBlockedReason(g = globalThis) {
  if (g && g.isSecureContext === false) {
    const loc = g.location;
    const here = loc && loc.protocol ? `${loc.protocol}//${loc.host}` : 'http';
    const zh = `需要 https 或 localhost 才能發聲（目前是 ${here}）`;
    const en = `Sound needs https or localhost (this page is ${here})`;
    return { code: 'insecure-context', zh, en, message: `${zh} · ${en}` };
  }
  if (!g || !(g.AudioContext || g.webkitAudioContext)) {
    const zh = '此瀏覽器不支援 Web Audio';
    const en = 'Web Audio API is not available in this browser';
    return { code: 'no-webaudio', zh, en, message: `${zh} · ${en}` };
  }
  return null;
}

/** iPhone / iPad / iPod (iPadOS reports itself as a Mac with touch). */
export function isAppleMobile(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = String(nav.userAgent || '');
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
}

/**
 * Put the page's audio in the 'playback' category (WebKit: navigator.audioSession, Safari 16.4+/17) so the
 * iPhone ring/silent switch does not mute it. Call inside the user gesture, before the AudioContext starts.
 * @returns {boolean} true when the API exists (the older-iOS fallback is then not needed)
 */
export function preferPlaybackSession(nav = globalThis.navigator) {
  try {
    const s = nav && nav.audioSession;
    if (!s) return false;
    if (s.type !== 'playback') s.type = 'playback';
    return true;
  } catch { return false; }
}

/** 8-bit mono silent WAV as a data: URL (≈0.1 s — tiny, loops seamlessly). */
export function silentWavDataUrl(sampleRate = 48000, seconds = 0.1) {
  const sr = Math.max(8000, Math.min(192000, Math.round(sampleRate) || 48000));
  const n = Math.max(1, Math.round(sr * seconds));
  const b = new Uint8Array(44 + n);
  const dv = new DataView(b.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  str(36, 'data'); dv.setUint32(40, n, true); b.fill(0x80, 44);          // unsigned 8-bit silence
  let s = '';
  for (let i = 0; i < b.length; i += 0x2000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x2000));
  return `data:audio/wav;base64,${btoa(s)}`;
}

/**
 * Older iOS (no navigator.audioSession): Web Audio alone is 'ambient' and obeys the silent switch; a playing
 * HTML media element moves the page to 'playback'. Starts a looping silent <audio> — call synchronously in the
 * user gesture. Only on Apple mobile without audioSession (elsewhere it would add a media notification).
 * @returns {{ el: HTMLAudioElement, resume(): void, stop(): void } | null}
 */
export function startSilentUnlock({ sampleRate = 48000, nav = globalThis.navigator, doc = globalThis.document, force = false } = {}) {
  try {
    if (!doc || typeof doc.createElement !== 'function') return null;
    if (!force && (!isAppleMobile(nav) || (nav && nav.audioSession))) return null;
    const el = doc.createElement('audio');
    el.setAttribute('x-webkit-airplay', 'deny');
    el.setAttribute('playsinline', '');
    el.preload = 'auto';
    el.loop = true;
    el.src = silentWavDataUrl(sampleRate);
    let stopped = false;
    const play = () => { if (stopped) return; try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ } };
    play();
    return {
      el,
      resume() { if (!stopped && el.paused) play(); },
      stop() { stopped = true; try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* ignore */ } },
    };
  } catch { return null; }
}

/* ───────────── Web MIDI ───────────── */

export const midiSupported = (nav = globalThis.navigator) => !!(nav && typeof nav.requestMIDIAccess === 'function');

/**
 * Current Web MIDI permission without prompting: 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown'
 * ('unknown' when the Permissions API cannot tell, e.g. Firefox — then only connect on an explicit click).
 */
export async function midiPermission(nav = globalThis.navigator) {
  if (!midiSupported(nav)) return 'unsupported';
  try {
    if (!nav.permissions || typeof nav.permissions.query !== 'function') return 'unknown';
    const st = await nav.permissions.query({ name: 'midi', sysex: false });
    return st && typeof st.state === 'string' ? st.state : 'unknown';
  } catch { return 'unknown'; }
}

/** Calls cb(state) whenever the MIDI permission changes (e.g. allowed from the site settings). → unsubscribe */
export function watchMidiPermission(cb, nav = globalThis.navigator) {
  let st = null, dead = false;
  const on = () => { if (!dead && st) cb(st.state); };
  (async () => {
    try {
      if (!midiSupported(nav) || !nav.permissions || !nav.permissions.query) return;
      st = await nav.permissions.query({ name: 'midi', sysex: false });
      if (dead || !st) return;
      if (st.addEventListener) st.addEventListener('change', on); else st.onchange = on;
    } catch { /* not queryable */ }
  })();
  return () => { dead = true; if (st) { if (st.removeEventListener) st.removeEventListener('change', on); else if (st.onchange === on) st.onchange = null; } };
}

/* ───────────── Screen Wake Lock ───────────── */

/**
 * Keeps the screen awake while at least one key wants it (phones lock after 30 s–2 min, which on iOS also
 * suspends Web Audio). Re-acquires when the page becomes visible again (the browser drops the lock on hide).
 */
export function createWakeLock({ nav = globalThis.navigator, doc = globalThis.document } = {}) {
  const supported = !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function');
  const wants = new Set();
  let sentinel = null, pending = null;
  const visible = () => !doc || doc.visibilityState !== 'hidden';
  function acquire() {
    if (!supported || sentinel || pending || !wants.size || !visible()) return pending;
    try {
      pending = Promise.resolve(nav.wakeLock.request('screen')).then((s) => {
        pending = null;
        if (!s) return;
        if (!wants.size) { try { s.release(); } catch { /* ignore */ } return; }
        sentinel = s;
        const onRel = () => { if (sentinel === s) sentinel = null; };
        if (s.addEventListener) s.addEventListener('release', onRel); else s.onrelease = onRel;
      }, () => { pending = null; });
    } catch { pending = null; }
    return pending;
  }
  function release() {
    const s = sentinel;
    sentinel = null;
    if (s) { try { const p = s.release(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ } }
  }
  const onVis = () => { if (visible()) acquire(); };
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis);
  return {
    supported,
    /** set(key, true|false): the lock is held while any key is on. Returns the pending request (tests). */
    set(key, on) { if (on) wants.add(key); else wants.delete(key); if (wants.size) return acquire(); release(); return null; },
    isHeld: () => !!sentinel,
    wanted: () => wants.size > 0,
    dispose() { wants.clear(); release(); if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis); },
  };
}

/* ───────────── Fullscreen (standard + webkit prefix; iPhone Safari has neither for elements) ───────────── */

export function fullscreenSupported(doc = globalThis.document) {
  if (!doc) return false;
  const el = doc.documentElement;
  const fn = el && (el.requestFullscreen || el.webkitRequestFullscreen);
  if (!fn) return false;
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled;
  return enabled === undefined ? true : !!enabled;
}
export const fullscreenElement = (doc = globalThis.document) => (doc && (doc.fullscreenElement || doc.webkitFullscreenElement)) || null;
export function requestFullscreen(el) {
  try {
    const fn = el && (el.requestFullscreen || el.webkitRequestFullscreen);
    if (!fn) return false;
    const p = fn.call(el);
    if (p && p.catch) p.catch(() => {});
    return true;
  } catch { return false; }
}
export function exitFullscreen(doc = globalThis.document) {
  try {
    if (!fullscreenElement(doc)) return false;
    const fn = doc.exitFullscreen || doc.webkitExitFullscreen;
    if (!fn) return false;
    const p = fn.call(doc);
    if (p && p.catch) p.catch(() => {});
    return true;
  } catch { return false; }
}

/* ───────────── AudioContext interruptions (iOS calls, Siri, backgrounding) ───────────── */

/**
 * Shows a persistent "聲音已暫停 — 點一下恢復 · Tap to resume" pill while a context that was running is
 * 'suspended' / 'interrupted', and sets html.audio-suspended (css/compat.css dims live indicators). Tapping it
 * resumes inside the gesture. audio: createAudio() result (onContextState/contextState/resume).
 * @returns {() => void} detach
 */
export function attachResumePrompt(audio, { doc = globalThis.document, delayMs = 700 } = {}) {
  if (!audio || audio.isNull || typeof audio.onContextState !== 'function' || !doc) return () => {};
  const root = doc.documentElement;
  let el = null, timer = 0;
  let wasRunning = audio.contextState() === 'running';
  const en = () => !/^zh/i.test((root && root.lang) || 'zh');
  function build() {
    el = doc.createElement('button');
    el.type = 'button';
    el.className = 'resume-pill';
    el.hidden = true;
    const dot = doc.createElement('span'); dot.className = 'resume-pill__dot';
    const txt = doc.createElement('span'); txt.className = 'resume-pill__txt';
    const b = doc.createElement('b'); const s = doc.createElement('small');
    txt.append(b, s); el.append(dot, txt);
    el.addEventListener('click', () => { audio.resume().catch(() => {}); });
    doc.body.append(el);
  }
  function show() {
    if (!el) build();
    const [main, sub] = en() ? ['Audio paused — tap to resume', '聲音已暫停 · 點一下恢復'] : ['聲音已暫停 — 點一下恢復', 'Audio paused · tap to resume'];
    el.querySelector('b').textContent = main;
    el.querySelector('small').textContent = sub;
    el.setAttribute('aria-label', main);
    el.hidden = false;
    requestAnimationFrame(() => el && el.classList.add('is-in'));
  }
  function hide() {
    clearTimeout(timer);
    if (root) root.classList.remove('audio-suspended');
    if (el) { el.classList.remove('is-in'); el.hidden = true; }
  }
  function update(state) {
    if (state === 'running') { wasRunning = true; hide(); return; }
    if (state === 'closed' || !wasRunning) { hide(); return; }
    if (root) root.classList.add('audio-suspended');
    clearTimeout(timer);
    // give the automatic resume (visibility / next gesture) a moment before asking
    timer = setTimeout(() => { if (audio.contextState() !== 'running' && doc.visibilityState !== 'hidden') show(); }, delayMs);
  }
  const off = audio.onContextState(update);
  const onVis = () => { if (doc.visibilityState === 'visible') update(audio.contextState()); };
  doc.addEventListener('visibilitychange', onVis);
  return () => { off(); doc.removeEventListener('visibilitychange', onVis); hide(); if (el) el.remove(); el = null; };
}

/* ───────────── splash notes ───────────── */

/**
 * Before the first tap: warn when sound cannot work here (http://<LAN-IP>) and hide the "支援 MIDI" hint where
 * there is no Web MIDI (Safari / iOS). Returns the audioBlockedReason (or null).
 */
export function applySplashCompat(splash, g = globalThis) {
  if (!splash) return null;
  const doc = splash.ownerDocument || g.document;
  if (!midiSupported(g.navigator)) for (const n of splash.querySelectorAll('.splash__midi')) n.hidden = true;
  const why = audioBlockedReason(g);
  if (why) {
    splash.classList.add('is-warn');
    let note = splash.querySelector('.splash__warn');
    if (!note && doc) {
      note = doc.createElement('p');
      note.className = 'splash__warn';
      note.setAttribute('role', 'note');
      const status = splash.querySelector('.splash__status');
      if (status && status.parentNode) status.parentNode.insertBefore(note, status); else splash.append(note);
    }
    if (note) {
      note.textContent = '';
      const b = doc.createElement('b'); b.textContent = why.zh;
      const s = doc.createElement('span'); s.textContent = why.en;
      note.append(b, s);
      if (why.code === 'insecure-context') {
        const tip = doc.createElement('small');
        tip.textContent = '請改開 https:// 網址（電腦上執行 npm run lan）· Open the https:// address instead (npm run lan)';
        note.append(tip);
      }
    }
  }
  return why;
}
