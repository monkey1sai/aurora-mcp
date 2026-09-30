// Shared helpers for the X film timelines (tools/video/timelines/*.mjs). See tools/video/timelines/README.md.
//
// The film is cut on the beat grid of its soundtrack: Neon Nights (A minor, 104 BPM), song beats 188 → 260
// (tools/video/make-bed.mjs). Film time of song beat b: (b − 188) · BEAT. Takes are recorded separately and cut
// together by tools/video/edit.mjs.

export const BPM = 104;
export const BEAT = 60 / BPM;          // 0.576923 s
export const BAR = 4 * BEAT;           // 2.307692 s
export const FILM_B0 = 188;            // first song beat of the film
export const FILM_B1 = 260;            // last (exclusive)
export const filmT = b => (b - FILM_B0) * BEAT;

/** pick the take's language from { en, zh } (or pass a string through) */
export const tx = (ctx, s) => (s && typeof s === 'object' && !Array.isArray(s) ? (s[ctx.lang] ?? s.en) : s);

/** the take's timeline position in seconds (audio clock) — events recorded with it land at that video time */
export const nowS = ctx => ctx.now();

/** load the director-side stage extras (browser frame, spectrogram, gallery layers) */
export async function installStage(ctx) {
  return ctx.evalDirector(async () => { await import('/tools/video/timelines/stage.js'); return window.director.vx.install(); });
}

/** chord on the user's synth (timed inside the page: note-offs land exactly ms later) */
export function chord(ctx, notes, vel = 1, ms = 1500) {
  return ctx.evalApp((notes, vel, ms) => {
    const A = window.__aurora;
    for (const n of notes) A.noteOn(n, vel);
    setTimeout(() => { for (const n of notes) A.noteOff(n); }, ms);
    return true;
  }, notes, vel, ms);
}

/** CSS injected into the app frame (id → replaces) */
export function appCss(ctx, id, css) {
  return ctx.evalApp((id, css) => {
    let s = document.getElementById(id);
    if (!s) { s = document.createElement('style'); s.id = id; document.head.append(s); }
    s.textContent = css;
    return true;
  }, id, css);
}

/**
 * Song clock of the demo song playing in the app: fits (AudioContext time, song beat) pairs from the engine's
 * ~30 Hz state messages. Returns { c0, bpm, sOf(beat) → timeline seconds, beatNow() }.
 * Message latency only ever makes a sample late, so a low percentile of the offsets is the estimate (±1 callback).
 */
export async function songSync(ctx, { ms = 900 } = {}) {
  const samples = await ctx.evalApp(async (ms) => {
    const A = window.__aurora, a = A.audio, out = [];
    const off = a.onState(st => { if (st && st.song && st.song.playing) out.push([A.ctx.currentTime, st.song.beat, st.song.bpm]); });
    await new Promise(r => setTimeout(r, ms));
    off();
    return out;
  }, ms);
  if (samples.length < 5) throw new Error(`songSync: only ${samples.length} song states (is a song playing?)`);
  const bpm = samples[0][2] || BPM;
  const offs = samples.map(([t, b]) => t - (b * 60) / bpm).sort((x, y) => x - y);
  const c0 = offs[Math.floor(offs.length * 0.15)];
  const t0 = ctx.t0.ctx;
  const sync = {
    c0, bpm, n: samples.length, spreadMs: +((offs[offs.length - 1] - offs[0]) * 1000).toFixed(1),
    /** timeline seconds at which song beat b plays */
    sOf: b => c0 + (b * 60) / bpm - t0,
    /** await song beat b (audio clock) */
    at: b => ctx.at(c0 + (b * 60) / bpm - t0),
  };
  ctx.log(`songSync: ${samples.length} states, offset spread ${sync.spreadMs} ms, bpm ${bpm}`);
  return sync;
}

/** poll until the app's song reaches beat b (for prepare(): minutes of real time, off camera) */
export async function waitSongBeat(ctx, b, { log = true } = {}) {
  let last = -1;
  for (;;) {
    const st = await ctx.evalApp(() => { const s = window.__aurora.audio.getSongState(); return s ? { beat: s.beat, playing: s.playing } : null; });
    if (st && st.beat >= b) return st.beat;
    if (log && st && Math.floor(st.beat / 32) !== Math.floor(last / 32)) ctx.log(`song at beat ${st.beat.toFixed(1)} → waiting for ${b}`);
    if (st) last = st.beat;
    const left = st ? ((b - st.beat) * 60) / BPM : 1;
    await ctx.wait(Math.max(20, Math.min(2000, left * 1000 - 40)));
  }
}

/** every caption string of the film (preloaded before filming: no font slice ever loads mid-take).
 *  zh display lines carry no sentence-final punctuation; EN sentences end with a period (big lines) or none (labels). */
export const TEXT = {
  hook1: { en: 'Claude can’t hear.', zh: 'Claude 聽不見' },
  hook2: { en: 'It built this synth *anyway*.', zh: '卻做出了這台*合成器*' },
  soundOn: { en: '🔊 Sound on', zh: '🔊 打開聲音' },
  sub: { en: 'A synthesizer built by *Claude*', zh: '一台由 *Claude* 打造的合成器' },
  browser: { en: 'Runs entirely in a *browser tab*', zh: '完全在*瀏覽器分頁*裡執行' },
  looking: { en: 'So it tuned every sound by *looking* at it', zh: '所以它用「*看*」的，調好每一個聲音' },
  fixed: { en: 'Saw the noise. Found the bug. *Fixed it.*', zh: '看到雜訊，揪出 bug，*修好它*' },
  presets: { en: '*100* presets. *Zero* samples.', zh: '*100* 個音色，*零*取樣' },
  presetsKick: { en: 'every sound synthesized live', zh: '每個聲音都是即時合成' },
  engines: { en: 'Real-time DSP in plain *JavaScript*', zh: '純 *JavaScript* 即時運算' },
  wavetable: { en: 'Wavetable', zh: '波表合成' },
  fm: { en: '4-operator FM', zh: '四運算子 FM' },
  physical: { en: 'Physical modeling', zh: '物理建模' },
  ladder: { en: 'Ladder filter', zh: 'Ladder 濾波器' },
  knobs: { en: 'Knobs that turn *themselves*', zh: '旋鈕會*自己轉*' },
  tours: { en: '6 guided sound tours', zh: '6 段自動音色導覽' },
  mood: { en: 'One tap: “*Ethereal*”', zh: '一鍵「*更空靈*」' },
  moodKick: { en: 'sound design in plain words', zh: '用一句話調音色' },
  songs: { en: '6 songs, composed by *Claude*', zh: '6 首原創曲，全是 *Claude* 寫的' },
  hearing: { en: 'You’re hearing *one* right now.', zh: '你正在聽的，就是*其中一首*' },
  hearingKick: { en: 'Neon Nights, as Claude saw it', zh: '〈霓虹夜色〉，Claude 眼中的樣子' },
  agentsLabel: { en: 'Claude agents built it', zh: '個 Claude 代理人合力打造' },
  lines: { en: 'lines of code', zh: '行程式碼' },
  deps: { en: 'dependencies', zh: '個依賴套件' },
  samples: { en: 'audio samples', zh: '個取樣音檔' },
  tests: { en: 'automated tests', zh: '項自動測試' },
  statsTitle: { en: 'Built by Claude Code', zh: '由 Claude Code 打造' },
  never: { en: 'Claude has never *heard* it.', zh: 'Claude 從來沒*聽過*它' },
  youCan: { en: 'But *you* can.', zh: '但*你*可以' },
  built: { en: 'Built with <b>Claude Code</b>', zh: '用 <b>Claude Code</b> 打造' },
  model: { en: 'Claude Opus 5.5', zh: 'Claude Opus 5.5' },
};
