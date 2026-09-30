// Audio bridge: AudioContext + AudioWorkletNode('aurora-synth') + analysers (docs/ARCHITECTURE.md §8).
// The UI never touches the Synth directly — everything is a port message.
//
//   const audio = await createAudio();       // call from a user gesture (autoplay policy)
//   audio.noteOn(60, 0.8); audio.setParam('filter.cutoff', 1200); audio.onState(s => …);
//
// Demo songs (multi-part ensemble, docs/SONGS.md) — the user's synth keeps playing on top:
//   import { SONGS } from '../demo/songs/index.js';
//   audio.songLoad(SONGS[0]); audio.songPlay();    // definitions are resolved against the factory presets
//   audio.songQueue(SONGS[1]);                      // seamless switch at the end of the current loop
//   audio.songPart(2, { mute: true });              // mixer: gain (dB trim), mute, solo, pan
//   audio.getState().song → { playing, beat, lengthBeats, section, parts:[{name, peak, notes, mute, solo}], … }

import { resolveSong } from '../demo/resolve.js';
import { PRESETS } from '../presets/index.js';
import { audioBlockedReason, preferPlaybackSession, startSilentUnlock, MAX_AUTO_SAMPLE_RATE } from './compat.js';

/** Song definition (parts reference presets by name) → engine-ready song; engine-ready songs pass through. */
function engineSong(song) {
  if (!song || typeof song !== 'object' || !Array.isArray(song.parts)) throw new Error('song must be an object with parts');
  return song.parts.every(p => p && p.patch) ? song : resolveSong(song, PRESETS);
}

const WORKLET_URL = new URL('../worklet/processor.js', import.meta.url);
// JIT warm-up set (src/worklet/processor.js 'warmup'): factory presets that together use every engine, phys
// model/exciter, filter type, drive/chorus mode and FX of the factory library (greedy cover, 34 features).
const WARM_PRESETS = ['Derelict Starship', 'Zephyr', 'Stardust Nebula', 'Cobalt Snare', 'Data Corruption',
  'Dewdrop Kalimba', 'Seraphim Voices', 'Golden Twelve', 'Celestial Carillon', 'Gravity Well'];
const READY_TIMEOUT_MS = 6000;

/**
 * @param {{ latencyHint?: string|number, sampleRate?: number, seed?: number }} [opts]
 * @returns {Promise<{
 *   ctx: AudioContext, node: AudioWorkletNode, analyser: AnalyserNode, analyserL: AnalyserNode, analyserR: AnalyserNode,
 *   output: GainNode, sampleRate: number,
 *   noteOn(note:number, vel?:number):void, noteOff(note:number):void, setParam(id:string, v:any):void, setParams(obj:object):void,
 *   loadPatch(patch:object):void, setMacro(i:number, v:number):void, setController(kind:string, v:number):void,
 *   allNotesOff(hard?:boolean):void, seqLoad(song:object):void, seqPlay():void, seqStop():void,
 *   songLoad(song:object):object, songPlay():void, songStop(hard?:boolean):void, songQueue(song:object):object,
 *   songPart(part:number|string, opts:{gain?:number, mute?:boolean, solo?:boolean, pan?:number|null}):void,
 *   getSongState():object|null,
 *   getState():object|null, onState(cb):()=>void, onError(cb):()=>void, resume():Promise<void>, close():Promise<void>,
 *   contextState():string, onContextState(cb:(state:string)=>void):()=>void
 * }>}
 * songLoad/songQueue accept a song definition (src/demo/songs/*.js; resolved against the factory presets —
 * throws synchronously on unknown presets/params) or an engine-ready song, and return the engine-ready song.
 * state.song (≈30 Hz) = Ensemble.getState(): { playing, beat, lengthBeats, loop, bpm, section, sectionIndex, id, title,
 * zh, loaded, pending, queued, ending, built, maxParts, parts:[{index, name, zh, role, peak, notes, mute, solo, gain, active}] }.
 * Throws (rejects) when AudioWorklet is unavailable or the processor module fails to load/construct; in a non-secure
 * context (http://<LAN-IP>) it throws first with err.code = 'insecure-context' and a bilingual message.
 * Without an explicit sampleRate the context runs at the device rate capped to 48 kHz (MAX_AUTO_SAMPLE_RATE).
 */
export async function createAudio({ latencyHint = 'interactive', sampleRate, seed = 1 } = {}) {
  // http://<LAN-IP> is not a secure context: no AudioWorklet (and no MIDI) — say so clearly, in both languages
  const blocked = audioBlockedReason();
  if (blocked) throw Object.assign(new Error(blocked.message), { code: blocked.code });
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  // iOS: 'playback' audio session so the ring/silent switch does not mute the synth (must precede the context)
  const hasSession = preferPlaybackSession();
  let ctx = new AC(sampleRate ? { latencyHint, sampleRate } : { latencyHint });
  // 96/192 kHz interfaces would cost 2–4× the DSP (dropouts in the songs) for nothing audible: run at 48 kHz and
  // let the browser resample. Still synchronous, inside the gesture.
  if (!sampleRate && ctx.sampleRate > MAX_AUTO_SAMPLE_RATE) {
    try { const c2 = new AC({ latencyHint, sampleRate: MAX_AUTO_SAMPLE_RATE }); ctx.close().catch(() => {}); ctx = c2; } catch { /* keep the device rate */ }
  }
  // Resume synchronously inside the user gesture (before the first await) — required by iOS/Safari.
  const resumed = ctx.resume().catch(() => {});
  // older iOS without navigator.audioSession: a looping silent <audio> (same gesture) lifts the silent-switch mute
  const unlock = hasSession ? null : startSilentUnlock({ sampleRate: ctx.sampleRate });
  const fail = () => { if (unlock) unlock.stop(); ctx.close().catch(() => {}); };
  if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
    fail();
    throw new Error('AudioWorklet is not supported in this browser (a secure context — http://localhost or https — is required)');
  }

  try {
    await ctx.audioWorklet.addModule(WORKLET_URL.href);
  } catch (e) {
    fail();
    throw new Error(`Failed to load the audio worklet (${WORKLET_URL.pathname}): ${e && e.message ? e.message : e}`);
  }

  const node = new AudioWorkletNode(ctx, 'aurora-synth', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { seed },
  });

  // ── routing: node → output gain → destination; taps for the visualisers ──
  const output = ctx.createGain();
  output.gain.value = 1;
  node.connect(output);
  output.connect(ctx.destination);

  const analyser = ctx.createAnalyser();          // stereo summed to mono
  analyser.channelCount = 1;
  analyser.channelCountMode = 'explicit';
  analyser.channelInterpretation = 'speakers';
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.78;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -10;
  const splitter = ctx.createChannelSplitter(2);
  const analyserL = ctx.createAnalyser();
  const analyserR = ctx.createAnalyser();
  for (const a of [analyserL, analyserR]) {
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0.5;
    a.minDecibels = -100;
    a.maxDecibels = -10;
  }
  node.connect(analyser);
  node.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  // ── messages from the worklet ──
  let state = null;
  const stateSubs = new Set();
  const errorSubs = new Set();
  const emitError = (message) => { for (const fn of errorSubs) { try { fn(message); } catch (e) { console.error(e); } } };
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  let isReady = false;

  node.port.onmessage = (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'state') {
      state = m.state;
      for (const fn of stateSubs) { try { fn(state); } catch (e) { console.error(e); } }
    } else if (m.type === 'ready') {
      isReady = true;
      readyResolve(m);
    } else if (m.type === 'error') {
      console.error('[aurora worklet]', m.message);
      if (!isReady) readyReject(new Error(m.message));
      emitError(m.message);
    }
  };
  node.onprocessorerror = (ev) => {
    const msg = `AudioWorklet processor error${ev && ev.message ? `: ${ev.message}` : ''}`;
    console.error('[aurora worklet]', ev);
    if (!isReady) readyReject(new Error(msg));
    emitError(msg);
  };

  let timer = 0;
  try {
    await Promise.race([
      ready,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Audio engine did not respond (timeout)')), READY_TIMEOUT_MS); }),
    ]);
  } catch (e) {
    clearTimeout(timer);
    try { node.disconnect(); } catch { /* ignore */ }
    fail();
    throw e;
  }
  clearTimeout(timer);
  await resumed;

  const post = (msg) => { try { node.port.postMessage(msg); } catch (e) { console.error(e); } };
  // warm the DSP code paths during the silent first second (the worklet runs it only while nothing sounds)
  post({ type: 'warmup', patches: WARM_PRESETS.map(n => PRESETS.find(p => p.name === n)).filter(Boolean).map(p => ({ params: p.params || {}, macros: p.macros || [] })) });

  // Mobile Safari may suspend/interrupt the context (calls, Siri, backgrounding): resume on the next gesture, and
  // try again when the page comes back (visibilitychange / pageshow). onContextState() lets the UI say so.
  const kick = () => {
    if (unlock) unlock.resume();
    if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  };
  const gestureEvents = ['pointerdown', 'keydown', 'touchend'];
  for (const t of gestureEvents) globalThis.addEventListener?.(t, kick, { passive: true, capture: true });
  const onShow = () => { if (globalThis.document?.visibilityState !== 'hidden') kick(); };
  globalThis.document?.addEventListener?.('visibilitychange', onShow);
  globalThis.addEventListener?.('pageshow', onShow);
  const ctxSubs = new Set();
  const onCtxState = () => { for (const fn of ctxSubs) { try { fn(ctx.state); } catch (e) { console.error(e); } } };
  if (ctx.addEventListener) ctx.addEventListener('statechange', onCtxState); else ctx.onstatechange = onCtxState;

  const api = {
    ctx, node, analyser, analyserL, analyserR, output,
    sampleRate: ctx.sampleRate,
    noteOn(note, vel = 0.8) { post({ type: 'noteOn', note, vel }); },
    noteOff(note) { post({ type: 'noteOff', note }); },
    setParam(id, value) { post({ type: 'param', id, value }); },
    setParams(values) { post({ type: 'params', values }); },
    loadPatch(patch) { post({ type: 'patch', patch }); },
    setMacro(index, value) { post({ type: 'macro', index, value }); },
    setController(kind, value) { post({ type: 'ctrl', kind, value }); },
    allNotesOff(hard = false) { post({ type: 'allOff', hard: !!hard }); },
    seqLoad(song) { post({ type: 'seqLoad', song }); },
    seqPlay() { kick(); post({ type: 'seqPlay' }); },
    seqStop() { post({ type: 'seqStop' }); },
    // ── demo songs (ensemble) ──
    songLoad(song) { const s = engineSong(song); post({ type: 'songLoad', song: s }); return s; },
    songPlay() { kick(); post({ type: 'songPlay' }); },
    songStop(hard = false) { post({ type: 'songStop', hard: !!hard }); },
    songQueue(song) { const s = engineSong(song); kick(); post({ type: 'songQueue', song: s }); return s; },
    songPart(part, opts = {}) { post({ type: 'songPart', part, gain: opts.gain, mute: opts.mute, solo: opts.solo, pan: opts.pan }); },
    /** Latest song state (state.song) or null. */
    getSongState: () => (state && state.song) || null,
    /** Latest state posted by the worklet (~30 Hz) or null before the first one. */
    getState: () => state,
    onState(cb) { stateSubs.add(cb); return () => stateSubs.delete(cb); },
    onError(cb) { errorSubs.add(cb); return () => errorSubs.delete(cb); },
    resume() { if (unlock) unlock.resume(); return ctx.resume(); },
    /** 'running' | 'suspended' | 'interrupted' (iOS) | 'closed' */
    contextState: () => ctx.state,
    /** cb(state) on every AudioContext state change → unsubscribe */
    onContextState(cb) { ctxSubs.add(cb); return () => ctxSubs.delete(cb); },
    async close() {
      for (const t of gestureEvents) globalThis.removeEventListener?.(t, kick, { capture: true });
      globalThis.document?.removeEventListener?.('visibilitychange', onShow);
      globalThis.removeEventListener?.('pageshow', onShow);
      if (unlock) unlock.stop();
      post({ type: 'dispose' });
      try { node.disconnect(); } catch { /* ignore */ }
      await ctx.close().catch(() => {});
    },
  };
  return api;
}

/** Same interface with no-ops: lets the UI run (silently) before/without audio. */
export function createNullAudio() {
  const noop = () => {};
  return {
    ctx: null, node: null, analyser: null, analyserL: null, analyserR: null, output: null, sampleRate: 48000, isNull: true,
    noteOn: noop, noteOff: noop, setParam: noop, setParams: noop, loadPatch: noop, setMacro: noop, setController: noop,
    allNotesOff: noop, seqLoad: noop, seqPlay: noop, seqStop: noop,
    songLoad: song => song, songPlay: noop, songStop: noop, songQueue: song => song, songPart: noop,
    getSongState: () => null,
    getState: () => null,
    onState: () => noop,
    onError: () => noop,
    contextState: () => 'closed',
    onContextState: () => noop,
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
