// Checks for platform compatibility (npm test → suite "compat"): the dev server's https mode (self-signed
// certificate, TLS + http→https on one port, certificate cache), src/ui/compat.js (secure-context gate, iOS audio
// session / silent unlock, MIDI permission without a prompt, wake lock, fullscreen), createAudio() against a fake
// AudioContext (48 kHz cap, insecure-context error, statechange API), malformed saved data in the preset library,
// and the DSP at the sample-rate extremes a browser may hand us (16 kHz … 192 kHz). Node only, no DOM.
// Each check returns { name, probs: string[], info }.
//
//   import { compatChecks } from './compat-checks.mjs';
//   for (const c of await compatChecks(ROOT, { part: 'core' | 'rates', mode })) …

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function run(name, fn) {
  const info = [];
  try {
    await fn(info);
    return { name, probs: [], info: info.join(' · ') };
  } catch (e) {
    return { name, probs: [String(e && e.message ? e.message : e).split('\n')[0].slice(0, 300)], info: info.join(' · ') };
  }
}

/** In-memory localStorage (Node 26 warns when modules touch the built-in one). */
function memoryStorage(init = {}) {
  const mem = new Map(Object.entries(init));
  return {
    getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); }, clear: () => mem.clear(), key: i => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
}
function setGlobal(name, value) {
  const had = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => { if (had) Object.defineProperty(globalThis, name, had); else delete globalThis[name]; };
}

function request(mod, opts) {
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

/* ───────────── part: core ───────────── */

async function coreChecks(ROOT) {
  const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
  const out = [];

  const { createSelfSignedCert } = await load('tools/selfsigned.mjs');
  process.env.QUIET = '1'; // serve.mjs reads it at import: no request log in the test output
  const serve = await load('tools/serve.mjs');
  const compat = await load('src/ui/compat.js');

  out.push(await run('https: self-signed certificate (X.509 v3, ECDSA P-256)', (info) => {
    const hosts = ['localhost', '127.0.0.1', '::1', '192.168.1.23'];
    const t0 = performance.now();
    const c = createSelfSignedCert({ hosts });
    const x = new crypto.X509Certificate(c.cert);
    assert.ok(x.verify(x.publicKey), 'self-signature does not verify');
    assert.equal(x.ca, false, 'must not be a CA certificate');
    assert.ok(x.checkHost('localhost'), 'SAN misses localhost');
    for (const ip of ['127.0.0.1', '::1', '192.168.1.23']) assert.ok(x.checkIP(ip), `SAN misses ${ip}`);
    assert.equal(x.checkIP('10.0.0.9'), undefined, 'SAN must not match other addresses');
    const days = (new Date(x.validTo) - new Date(x.validFrom)) / 864e5;
    assert.ok(days > 300 && days <= 399, `validity ${days.toFixed(0)} days (Apple accepts ≤ 398)`);
    assert.equal(crypto.createPrivateKey(c.key).asymmetricKeyDetails?.namedCurve, 'prime256v1', 'key is not P-256');
    info.push(`${x.subjectAltName} · ${days.toFixed(0)} days · ${(performance.now() - t0).toFixed(0)} ms`);
  }));

  out.push(await run('https: dev server — TLS and http→https redirect on one port', async (info) => {
    const c = createSelfSignedCert({ hosts: ['localhost', '127.0.0.1'] });
    const server = serve.createDualServer({ key: c.key, cert: c.cert });
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    const port = server.address().port;
    try {
      // strict verification with the certificate as the only trusted root (what mkcert / a trusted profile gives)
      const page = await request(https, { host: '127.0.0.1', port, path: '/index.html', ca: c.cert, servername: 'localhost' });
      assert.equal(page.status, 200, `https /index.html → ${page.status}`);
      assert.match(String(page.headers['content-type']), /text\/html/);
      assert.match(page.body, /AURORA/);
      const js = await request(https, { host: '127.0.0.1', port, path: '/src/ui/compat.js', ca: c.cert, servername: 'localhost' });
      assert.equal(js.status, 200);
      assert.match(String(js.headers['content-type']), /javascript/, 'ES module served with a JS MIME type');
      const secret = await request(https, { host: '127.0.0.1', port, path: '/.cert/selfsigned-key.pem', ca: c.cert, servername: 'localhost' });
      assert.equal(secret.status, 403, `.cert/ must never be served (got ${secret.status})`);
      const plain = await request(http, { host: '127.0.0.1', port, path: '/src/ui/main.js?x=1', headers: { host: `192.168.1.23:${port}` } });
      assert.equal(plain.status, 308, `plain http → ${plain.status} (expected a redirect)`);
      assert.equal(plain.headers.location, `https://192.168.1.23:${port}/src/ui/main.js?x=1`);
      const evil = await request(http, { host: '127.0.0.1', port, path: '/', headers: { host: 'evil.test/"><script>' } });
      assert.ok(!/evil/.test(evil.headers.location || ''), 'a malformed Host header must not be reflected');
      // a burst of parallel TLS connections (the page loads ~70 modules at once)
      const many = await Promise.all(Array.from({ length: 24 }, () => request(https, { host: '127.0.0.1', port, path: '/src/ui/audio.js', ca: c.cert, servername: 'localhost', agent: false })));
      assert.ok(many.every(r => r.status === 200), 'parallel https requests failed');
      info.push(`https 200 · http → 308 ${plain.headers.location.replace(/:\d+/, ':PORT')} · .cert 403 · 24 parallel OK`);
    } finally { server.close(); }
  }));

  out.push(await run('https: certificate cache (.cert/) and user certificate priority', (info) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cert-'));
    try {
      const a = serve.loadCert({ hosts: ['192.168.1.23'], dir, env: {} });
      assert.equal(a.source, 'selfsigned-new');
      const b = serve.loadCert({ hosts: ['192.168.1.23'], dir, env: {} });
      assert.equal(b.source, 'selfsigned', 'second start must reuse the cached certificate');
      assert.equal(b.cert, a.cert);
      const c = serve.loadCert({ hosts: ['10.0.0.7'], dir, env: {} });
      assert.equal(c.source, 'selfsigned-new', 'a new LAN address must regenerate the certificate');
      assert.ok(new crypto.X509Certificate(c.cert).checkIP('10.0.0.7'));
      const expired = serve.loadCert({ hosts: ['10.0.0.7'], dir, env: {}, now: new Date(Date.now() + 400 * 864e5) });
      assert.equal(expired.source, 'selfsigned-new', 'an expiring certificate must be regenerated');
      const mode = fs.statSync(path.join(dir, 'selfsigned-key.pem')).mode & 0o777;
      if (process.platform !== 'win32') assert.equal(mode, 0o600, `private key mode ${mode.toString(8)}`);
      fs.writeFileSync(path.join(dir, 'cert.pem'), a.cert); fs.writeFileSync(path.join(dir, 'key.pem'), a.key);
      assert.equal(serve.loadCert({ hosts: [], dir, env: {} }).source, 'user', '.cert/cert.pem + key.pem (mkcert) must win');
      info.push('generate → reuse → regenerate on new IP / expiry · key 0600 · user cert wins');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  out.push(await run('compat: secure-context gate (http://<LAN-IP> has no AudioWorklet)', (info) => {
    const AC = function () {};
    const lan = compat.audioBlockedReason({ isSecureContext: false, location: { protocol: 'http:', host: '192.168.1.23:5173' }, AudioContext: AC });
    assert.equal(lan && lan.code, 'insecure-context');
    assert.match(lan.zh, /https/); assert.match(lan.zh, /localhost/); assert.match(lan.zh, /192\.168\.1\.23:5173/);
    assert.match(lan.en, /https or localhost/);
    assert.equal(compat.audioBlockedReason({ isSecureContext: true, AudioContext: AC }), null);
    assert.equal(compat.audioBlockedReason({ webkitAudioContext: AC }), null, 'isSecureContext undefined (old browsers) must not block');
    assert.equal(compat.audioBlockedReason({ isSecureContext: true }).code, 'no-webaudio');
    info.push(lan.zh);
  }));

  out.push(await run('compat: iOS ring/silent switch — audio session + silent unlock', (info) => {
    const nav = { audioSession: { type: 'auto' } };
    assert.equal(compat.preferPlaybackSession(nav), true);
    assert.equal(nav.audioSession.type, 'playback');
    assert.equal(compat.preferPlaybackSession({}), false);
    assert.equal(compat.preferPlaybackSession({ get audioSession() { throw new Error('x'); } }), false, 'must never throw');
    // silent WAV: valid header, all-silence 8-bit PCM at the context's rate
    const url = compat.silentWavDataUrl(44100);
    const b = Buffer.from(url.split(',')[1], 'base64');
    assert.equal(b.toString('latin1', 0, 4), 'RIFF'); assert.equal(b.toString('latin1', 8, 12), 'WAVE');
    assert.equal(b.readUInt32LE(24), 44100); assert.equal(b.readUInt16LE(34), 8);
    assert.equal(b.readUInt32LE(40), b.length - 44);
    assert.ok(b.subarray(44).every(v => v === 0x80), 'data is not silence');
    // the fallback element: only on Apple mobile without audioSession
    const made = [];
    const doc = { createElement: (t) => { const el = { tag: t, attrs: {}, paused: true, loop: false, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; this.src = ''; }, load() {}, play() { this.paused = false; made.push('play'); return Promise.resolve(); }, pause() { this.paused = true; } }; return el; } };
    const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 };
    const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', maxTouchPoints: 5 };
    const mac = { userAgent: ipad.userAgent, maxTouchPoints: 0 };
    const android = { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile Safari/537.36', maxTouchPoints: 5 };
    const u = compat.startSilentUnlock({ sampleRate: 48000, nav: iphone, doc });
    assert.ok(u && u.el.loop && /^data:audio\/wav;base64,/.test(u.el.src) && 'playsinline' in u.el.attrs, 'iPhone: looping inline silent <audio>');
    assert.equal(u.el.paused, false, 'must start playing inside the gesture');
    u.el.paused = true; u.resume(); assert.equal(u.el.paused, false, 'resume() restarts a paused element');
    u.stop(); assert.equal(u.el.paused, true);
    assert.ok(compat.startSilentUnlock({ nav: ipad, doc }), 'iPadOS (Mac UA + touch) counts as Apple mobile');
    assert.equal(compat.startSilentUnlock({ nav: { ...iphone, audioSession: {} }, doc }), null, 'not needed with navigator.audioSession');
    assert.equal(compat.startSilentUnlock({ nav: mac, doc }), null, 'desktop Mac: no media element');
    assert.equal(compat.startSilentUnlock({ nav: android, doc }), null, 'Android: no media element (would add a media notification)');
    info.push(`audioSession → playback · silent WAV ${b.length} B · element only on iPhone/iPad without audioSession`);
  }));

  out.push(await run('compat: MIDI connects without a surprise permission prompt', async (info) => {
    let asked = 0;
    const mk = (perm) => ({ requestMIDIAccess: () => { asked++; return Promise.resolve({}); }, permissions: perm });
    assert.equal(await compat.midiPermission({}), 'unsupported');
    assert.equal(await compat.midiPermission(mk({ query: async q => { assert.equal(q.name, 'midi'); return { state: 'granted' }; } })), 'granted');
    assert.equal(await compat.midiPermission(mk({ query: async () => ({ state: 'prompt' }) })), 'prompt');
    assert.equal(await compat.midiPermission(mk({ query: async () => { throw new TypeError('midi is not a valid permission name'); } })), 'unknown');
    assert.equal(await compat.midiPermission(mk(undefined)), 'unknown');
    assert.equal(asked, 0, 'checking the permission must never call requestMIDIAccess');
    // permission flips to granted later (site settings) → callback
    const st = new EventTarget(); st.state = 'prompt';
    const seen = [];
    const off = compat.watchMidiPermission(s => seen.push(s), mk({ query: async () => st }));
    await new Promise(r => setTimeout(r, 5));
    st.state = 'granted'; st.dispatchEvent(new Event('change'));
    off(); st.state = 'denied'; st.dispatchEvent(new Event('change'));
    assert.deepEqual(seen, ['granted']);
    info.push('granted → auto-connect · prompt/unknown → wait for a click · change events followed');
  }));

  out.push(await run('compat: screen wake lock while something plays', async (info) => {
    let req = 0, rel = 0, last = null;
    const tick = () => new Promise(r => setTimeout(r, 0));
    const doc = new EventTarget(); doc.visibilityState = 'visible';
    const nav = { wakeLock: { request: async () => { req++; const s = new EventTarget(); s.release = async () => { rel++; s.dispatchEvent(new Event('release')); }; last = s; return s; } } };
    const wl = compat.createWakeLock({ nav, doc });
    assert.ok(wl.supported);
    await wl.set('song', true); await wl.set('theater', true);
    assert.equal(req, 1, 'one lock for several reasons'); assert.ok(wl.isHeld());
    wl.set('song', false); assert.ok(wl.isHeld(), 'still wanted by theater');
    wl.set('theater', false); await tick();
    assert.equal(rel, 1); assert.ok(!wl.isHeld());
    await wl.set('song', true); await wl.set('song', true);
    assert.equal(req, 2, 'no duplicate request while held');
    // the browser drops the lock when the page hides; it must come back when the page is visible again
    doc.visibilityState = 'hidden'; last.dispatchEvent(new Event('release')); doc.dispatchEvent(new Event('visibilitychange'));
    assert.ok(!wl.isHeld()); await tick(); assert.equal(req, 2, 'no request while hidden');
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); await tick();
    assert.equal(req, 3, 're-acquired on visible'); assert.ok(wl.isHeld());
    wl.dispose(); await tick(); assert.ok(!wl.isHeld());
    doc.dispatchEvent(new Event('visibilitychange')); await tick();
    assert.equal(req, 3, 'disposed: no re-acquire');
    const none = compat.createWakeLock({ nav: {}, doc });
    assert.equal(none.supported, false); none.set('x', true); none.dispose();
    info.push('acquire once · release when nothing plays · re-acquire on visible · no-op without the API');
  }));

  out.push(await run('compat: fullscreen helpers (webkit prefix, iPhone has none)', (info) => {
    const iphoneDoc = { documentElement: {}, fullscreenEnabled: undefined };
    assert.equal(compat.fullscreenSupported(iphoneDoc), false);
    let called = '';
    const el = { webkitRequestFullscreen() { called = 'webkit'; } };
    const oldIpad = { documentElement: el, webkitFullscreenEnabled: true, webkitFullscreenElement: null, webkitExitFullscreen() { called = 'exit'; } };
    assert.equal(compat.fullscreenSupported(oldIpad), true);
    assert.equal(compat.requestFullscreen(el), true); assert.equal(called, 'webkit');
    assert.equal(compat.fullscreenElement(oldIpad), null);
    oldIpad.webkitFullscreenElement = el;
    assert.equal(compat.fullscreenElement(oldIpad), el);
    assert.equal(compat.exitFullscreen(oldIpad), true); assert.equal(called, 'exit');
    assert.equal(compat.fullscreenSupported({ documentElement: { requestFullscreen() {} }, fullscreenEnabled: false }), false, 'disabled (iframe policy)');
    assert.equal(compat.requestFullscreen({}), false);
    info.push('standard · webkit · none → button hidden');
  }));

  out.push(await run('audio.js: createAudio() — 48 kHz cap, secure-context error, iOS session, statechange', async (info) => {
    const made = [];
    let deviceRate = 192000;
    class FakeParam { constructor(v) { this.value = v; } }
    const node = () => ({ connect() {}, disconnect() {}, gain: new FakeParam(1) });
    class FakeCtx extends EventTarget {
      constructor(o = {}) { super(); this.opts = o; this.sampleRate = o.sampleRate || deviceRate; this.state = 'suspended'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; made.push(this); }
      resume() { if (this.state !== 'closed') this._set('running'); return Promise.resolve(); }
      close() { this._set('closed'); return Promise.resolve(); }
      _set(s) { if (this.state === s) return; this.state = s; this.dispatchEvent(new Event('statechange')); }
      createGain() { return node(); }
      createAnalyser() { return { ...node(), fftSize: 2048 }; }
      createChannelSplitter() { return node(); }
    }
    class FakeNode {
      constructor() { this.port = { onmessage: null, postMessage: () => {} }; setTimeout(() => this.port.onmessage && this.port.onmessage({ data: { type: 'ready' } }), 1); }
      connect() {} disconnect() {}
    }
    const nav = { userAgent: 'node', audioSession: { type: 'auto' } };
    const restore = [setGlobal('AudioContext', FakeCtx), setGlobal('AudioWorkletNode', FakeNode), setGlobal('navigator', nav), setGlobal('isSecureContext', true)];
    try {
      const { createAudio } = await load('src/ui/audio.js');
      const a = await createAudio();
      assert.equal(a.sampleRate, 48000, `192 kHz device → ${a.sampleRate} (expected the 48 kHz cap)`);
      assert.equal(made.length, 2); assert.equal(made[0].state, 'closed', 'the 192 kHz context must be closed');
      assert.equal(made[1].opts.sampleRate, 48000);
      assert.equal(nav.audioSession.type, 'playback', 'iOS audio session not set to playback');
      const seen = [];
      a.onContextState(s => seen.push(s));
      made[1]._set('suspended'); made[1]._set('running');
      assert.deepEqual(seen, ['suspended', 'running']); assert.equal(a.contextState(), 'running');
      await a.close();
      made.length = 0; deviceRate = 44100;
      const b = await createAudio();
      assert.equal(b.sampleRate, 44100, 'a 44.1 kHz device keeps its rate'); assert.equal(made.length, 1);
      await b.close();
      made.length = 0; deviceRate = 192000;
      const c = await createAudio({ sampleRate: 96000 });
      assert.equal(c.sampleRate, 96000, 'an explicit sampleRate is honoured'); await c.close();
      setGlobal('isSecureContext', false);
      setGlobal('location', { protocol: 'http:', host: '192.168.1.23:5173' });
      made.length = 0;
      await assert.rejects(createAudio(), (e) => e.code === 'insecure-context' && /https/.test(e.message) && /192\.168\.1\.23/.test(e.message));
      assert.equal(made.length, 0, 'no AudioContext may be created in an insecure context');
      info.push('192k → 48k · 44.1k kept · explicit 96k kept · audioSession=playback · statechange → onContextState · insecure → clear error');
    } finally { for (const r of restore.reverse()) r(); delete globalThis.location; }
  }));

  out.push(await run('library: malformed saved data never stops the boot', async (info) => {
    const cases = [
      ['userPresets = {}', { 'aurora.userPresets': '{}' }],
      ['favourites = {}', { 'aurora.favourites': '{}' }],
      ['favourites = "x"', { 'aurora.favourites': '"x"' }],
      ['tags as a string', { 'aurora.userPresets': JSON.stringify([{ name: 'Lofi Keys', category: 'keys', params: {}, tags: 'lofi, warm' }]) }],
      ['junk entries', { 'aurora.userPresets': JSON.stringify([null, 'x', 3, [], { name: '' , params: {} }, { name: 'no params' }, { name: 'bad params', params: 3 }, { name: 7, params: {}, tags: [1, null, { a: 1 }, ' ok '], description: { x: 1 } }]) }],
      ['not JSON', { 'aurora.userPresets': '{oops', 'aurora.favourites': '[' }],
    ];
    const restore = setGlobal('localStorage', memoryStorage());
    try {
      const { createLibrary, sanitizeUserPresets } = await load('src/ui/app/library.js');
      const factory = [{ name: 'Aurora Pad', category: 'pad', params: {}, tags: ['lush'] }];
      for (const [label, init] of cases) {
        setGlobal('localStorage', memoryStorage(init));
        const lib = createLibrary({ factory });
        for (const p of lib.all()) {
          assert.ok(Array.isArray(p.tags) && p.tags.every(t => typeof t === 'string'), `${label}: tags not an array of strings`);
          assert.equal(typeof p.name, 'string', `${label}: name`);
          assert.ok(p.description === undefined || typeof p.description === 'string', `${label}: description`);
          (p.tags || []).slice(0, 3).map(t => `#${t}`); // what the preset browser does
        }
        lib.isFav('f:Aurora Pad'); lib.toggleFav('f:Aurora Pad');
      }
      const s = sanitizeUserPresets([{ name: 'A', params: {}, tags: 'lofi, warm，soft' }, { name: 7, params: {}, tags: [1, null, ' ok '] }, { name: 'x', params: [] }]);
      assert.deepEqual(s.map(p => [p.name, p.tags]), [['A', ['lofi', 'warm', 'soft']], ['7', ['1', 'ok']]]);
      info.push(`${cases.length} malformed shapes load cleanly (tags → string arrays, junk dropped)`);
    } finally { restore(); }
  }));

  return out;
}

/* ───────────── part: rates (DSP at the sample-rate extremes) ───────────── */

// Factory presets that together use every engine, phys model/exciter, filter type, drive/chorus mode and FX
// (same greedy cover as the worklet's JIT warm-up in src/ui/audio.js).
const COVER = ['Derelict Starship', 'Zephyr', 'Stardust Nebula', 'Cobalt Snare', 'Data Corruption',
  'Dewdrop Kalimba', 'Seraphim Voices', 'Golden Twelve', 'Celestial Carillon', 'Gravity Well'];

async function rateChecks(ROOT, { mode = 'default' } = {}) {
  const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
  const R = await load('tools/render.mjs');
  const A = await load('tools/analyze.mjs');
  const { getPhrase, phraseToTimedEvents } = await load('tools/phrases.mjs');
  const M = await R.loadSynth();
  const { PRESETS } = await R.loadPresets();
  const list = mode === 'full' ? PRESETS : COVER.map(n => PRESETS.find(p => p.name === n)).filter(Boolean);
  const rates = mode === 'quick' ? [16000, 192000] : [16000, 22050, 192000];
  const out = [];
  for (const sr of rates) {
    out.push(await run(`DSP at ${sr / 1000} kHz (${list.length} presets${mode === 'full' ? '' : ' covering every engine/filter/FX'})`, async (info) => {
      const probs = [];
      let worst = -Infinity, t = 0;
      for (const p of list) {
        const phraseId = R.phraseFor(p);
        const CUT = 1.4;
        const ev = phraseToTimedEvents(getPhrase(phraseId)).filter(e => e.time < CUT || e.type === 'off').map(e => (e.type === 'off' && e.time > CUT ? { ...e, time: CUT } : e));
        const held = new Set(ev.filter(e => e.type === 'on').map(e => e.note));
        for (let k = ev.length - 1; k >= 0; k--) if (ev[k].type === 'off' && !held.has(ev[k].note)) ev.splice(k, 1);
        const t0 = performance.now();
        const r = await R.renderEvents(R.buildPatch(p), ev, { sampleRate: sr, bpm: getPhrase(phraseId).bpm, maxTail: 0.4, synthMod: M });
        t += performance.now() - t0;
        const m = A.analyze(r.L, r.R, sr, { lastNoteOff: r.lastNoteOff });
        if (m.nanCount || m.infCount) probs.push(`${p.name}: ${m.nanCount + m.infCount} NaN/Inf`);
        if (m.peak > 1) probs.push(`${p.name}: peak ${m.peak.toFixed(3)} > 1`);
        if (m.dcMax >= 0.01) probs.push(`${p.name}: DC ${m.dcMax.toFixed(4)}`);
        if (m.peakDb < -50) probs.push(`${p.name}: silent (peak ${m.peakDb.toFixed(1)} dBFS)`);
        worst = Math.max(worst, m.peakDb);
      }
      info.push(`max peak ${worst.toFixed(1)} dBFS · ${(t / 1000).toFixed(1)} s`);
      if (probs.length) throw new Error(probs.slice(0, 4).join('; '));
    }));
  }
  return out;
}

export async function compatChecks(ROOT, { part = 'core', mode = 'default' } = {}) {
  return part === 'rates' ? rateChecks(ROOT, { mode }) : coreChecks(ROOT);
}
