# AURORA 極光 — Hybrid Synthesizer: Architecture & Contracts

A browser synthesizer with a pro-grade DSP core that also runs in Node for offline rendering/analysis.
Goals, in priority order: **sounds gorgeous**, **looks gorgeous & fun**, **intuitive for humans**, **deep for sound design**, **demo/autoplay features**.

No frameworks, no bundler, no npm dependencies. Plain ES modules. Chrome/Edge/Safari/Firefox current.
Run: `npm start` (tools/serve.mjs static server on http://localhost:5173). AudioWorklet (and Web MIDI, Wake Lock) need a
secure context — http://localhost or https, not file:// and not http://<LAN-IP>; `npm run lan` serves https on the LAN.

---

## 1. File layout (ownership)

```
index.html                    UI shell
css/style.css                 design tokens + layout            (UI shell)
css/components.css            controls, keyboard                 (UI components)
css/visuals.css               visualizers                        (UI visuals)
src/dsp/params.js             PARAM SCHEMA — the central contract (exists; do not rename ids)
src/dsp/util.js               shared DSP helpers                 (core)
src/dsp/synth.js              Synth: voices, alloc, macros, perf, FX, limiter  (core)
src/dsp/voice.js              Voice: sources → filters → amp, mod matrix       (core)
src/dsp/env.js, lfo.js        envelopes, LFOs                    (core)
src/dsp/performance.js        arpeggiator, chord memory, scale lock            (core)
src/dsp/sequencer.js          sample-accurate event sequencer (demos/autoplay)  (core)
src/dsp/engines/osc.js        classic VA + wavetable oscillator (osc1/osc2)
src/dsp/engines/wavetables.js wavetable generation + mipmaps
src/dsp/engines/fm.js         4-op FM
src/dsp/engines/phys.js       physical modelling (waveguide string + modal)
src/dsp/engines/noise.js      noise source
src/dsp/filter.js             ladder / SVF / formant / comb + response curve for UI
src/dsp/fx/*.js               drive, chorus, phaser, delay, reverb, eq, comp, limiter
src/dsp/fx/fxchain.js         FxChain
src/worklet/processor.js      AudioWorkletProcessor wrapping Synth
src/ui/*.js                   UI (see §8)
src/presets/*.js              factory presets (see §9)
tools/*.mjs                   serve, render, analyze, wav, png, test
```

## 2. Global DSP conventions

* Everything is **sample-rate independent** (tested at 44100 and 48000).
* **Control rate**: `CR = 16` samples. Modulation (LFOs, mod envs, mod matrix, filter cutoff targets) is evaluated once per control block. Amplitude envelopes and gain changes must be **per-sample or linearly ramped** within the block — no zipper noise, no clicks.
* Audio buffers are `Float32Array`. The synth renders stereo.
* No allocation in the audio path (no `new`, no array literals, no closures created per block). Pre-allocate in constructors.
  **Also no numeric (double) arguments or return values across non-inlined calls in the per-block path**: V8 boxes each
  one into a HeapNumber (measured: ≈2.8 KB of garbage per 128 samples per FM voice before this rule; 0 after). Pass block
  values through number fields (`eng.freqIn = f`) or preallocated `Float64Array`s (`filter.inp`, scratch arrays), and
  return results the same way. Integers (Smis), booleans, arrays and objects are free. `npm test` measures bytes/128 samples.
* Denormals: add tiny DC/noise (1e-20) or flush in feedback paths.
* No `Math.random()` in DSP: use `util.js` xorshift RNG (deterministic renders; seedable).
* Pure modules: DSP files must not touch `window`, `document`, `AudioContext`, `process`, `fs`. Must import cleanly in both AudioWorkletGlobalScope and Node.
* Imports between DSP files use relative paths with `.js` extensions.

### Parameter values inside DSP

`params.js` exports `PARAMS`, `idx(id)`, `toValueArray()`, etc. Inside DSP, parameter values live in `Float64Array`s indexed by param index:
* float/int → native units; enum → option **index**; bool → 1/0.
* Resolve indices once in constructors: `this.iCut = idx('filter.cutoff')`.

`Synth` keeps:
* `base` — patch values (from `loadPatch` / `setParam`)
* `eff` — effective values = base + macros (see §6). Recomputed only when base or macro values change.
* each `Voice` keeps `v` — per-voice modulated copy of `eff`. Only indices targeted by active mod slots are rewritten each control block (from `eff` + Σ modulation). When `eff` changes, voices refresh their copy (set a dirty flag; copy at next control block).

Modulation is additive in **normalised space**: `v[i] = fromNormNumeric(p, clamp01(toNorm(p, eff[i]) + Σ amt·src))`. Use cached per-param mapping functions for speed (don't call the generic schema helpers per block if avoidable — precompute min/max/log ratios).

## 3. Signal flow per voice

```
            ┌ osc1 ─┐
 pitch ───▶ ├ osc2 ─┤  each source: level · pan, then split by `.filt` (0..1):
            ├ fm   ─┤     filt part → FILTER BUS,  (1-filt) part → DRY BUS
            ├ phys ─┤
            └ noise ┘
 FILTER BUS → filter (type/cutoff/res/drive/vowel) → filter2 (SVF, serial) ─┐
 DRY BUS ──────────────────────────────────────────────────────────────────┴▶ + → amp env · velocity · amp.level → pan/voice.spread → synth mix
```
Global chain: `Σ voices → FxChain(drive → chorus → phaser → delay → reverb → eq → comp) → master.volume → brickwall limiter (true-peak-ish, ceiling −0.3 dBFS, soft knee, transparent) → out`.

### Pitch
Per control block, voice frequency (Hz):
`f = 440 · 2^((note − 69 + glideOffset + voice.pitch + bend·voice.bend + vibrato/100)/12)`
* glide: exponential portamento in semitone domain, time constant from `voice.glide` (legato/mono always; poly glides from last played note when glide > 0).
* vibrato: sine at `vib.rate`, depth `vib.depth` cents faded in over `vib.delay`, plus `vib.wheel` cents × mod wheel.
Engines apply their own `oct/semi/fine`.

### Gain staging
A single note of `osc1` saw at level 0.8, filter open, amp env at sustain 1, velocity 1, `amp.level` 0 dB should peak around **−12 dBFS** in the synth mix
(measured: RMS −16.8 dB = an ideal ±1 saw at −12 dBFS peak; the band-limited saw's Gibbs overshoot puts the sample peak at −10.6 dBFS).
*Integration note:* the voice multiplies the `phys` source by a loudness make-up (`PHYS_TRIM` in voice.js: ×2 for pluck/mallet,
×1.41 for bow/breath). Strikes are peak-normalised with a 14–26 dB crest factor, so without it a pluck at equal `level` was
11–13 dB (momentary LUFS) below a saw; with it plucks/mallets are within ≈ −5…+1 dB and bow/breath within 2 dB. Engines should produce roughly unit-peak output (±1) at level 1 so sources are comparable; voice applies `level`. FM/phys/noise should be loudness-matched to the saw within ±3 dB (RMS) for typical settings.

## 4. Engine interface (osc, fm, phys, noise)

```js
export class XEngine {
  constructor(sampleRate, prefix, seed?)   // prefix: 'osc1'|'osc2'|'fm'|'phys'|'noise'; resolve idx(`${prefix}.x`) here.
                                           // seed (osc, phys, noise): per-voice seed from the voice → renders are deterministic
                                           // per Synth seed, independent of how many engines were constructed before.
  noteOn(note, velocity, freq, v, legato) // velocity 0..1; freq Hz; v = voice value array; legato=true → don't retrigger (phase/exciter/envelopes continue)
  noteOff()                          // release phase (FM op envelopes release, phys exciter stops/damps, noise decays)
  process(v, freq, outL, outR, offset, n)   // OVERWRITE outL/outR[offset .. offset+n). freq = voice pitch (Hz) for this block (excludes the engine's own oct/semi/fine). n ≤ 16.
  render(v, outL, outR, offset, n)          // same as process() with the pitch read from the number field `this.freqIn`.
                                            // The voice sets `eng.freqIn` once per control block and calls render() (allocation-free, see §2).
                                            // process(v, freq, …) is `this.freqIn = freq; this.render(…)` and stays the public/test entry point.
  isActive()                         // false once the engine can produce no more sound (phys ring-out done / FM carriers released). osc/noise: true while voice held.
  reset()                            // hard reset (voice stolen)
}
```
The **voice** applies `level`, `pan`, and routing; engines must NOT apply `.level/.pan/.filt`. Engines read their own params from `v` via cached indices. Engines are skipped (not processed) when `.on` is 0.

### osc (engines/osc.js + wavetables.js)
* `classic` mode: band-limited (PolyBLEP/PolyBLAMP or better) sine, triangle, saw, square with **continuous morph** by `shape` (0 sine → ⅓ tri → ⅔ saw → 1 square, crossfade neighbours); `pw` affects square; `sync` = self hard-sync: slave frequency = f·2^(sync·4) reset by a virtual master at f, with BLEP-corrected resets.
* `wavetable` mode: `table` (see `WAVETABLES` in params.js) with `shape` = frame position (interpolate between frames), band-limited via mipmaps (one mip per octave, halve table length as harmonics drop); memory < 16 MB total, generation < 300 ms at construction (cache in a module-level singleton so all voices share it).
  Tables (generated procedurally from harmonic spectra): analog (sine→tri→saw→square), harmonic (additive sweep 1→64 partials), vowels (A-E-I-O-U formant spectra), pulse (PWM sweep), organ (drawbar registrations), glass (sparse bright odd/high partials), sync (hard-sync sweep), digital (bit/step-like spectra), strings (bowed-string-like spectra, brightening), growl (vocal/formant-ish bass morph).
* `unison` 1–8 voices, `detune` (0..1 → up to ≈±50 cents, supersaw-style nonlinear curve), `blend` (center vs side voices level), `spread` (stereo pan of voices), `phase` (free/reset/random per note), `drift` (slow per-voice random pitch/phase drift, analog feel; 1 = ≈±8 cents wander).
* Output peak ≈ ±1 (normalise unison by ~1/√N).

### fm (engines/fm.js)
4 sine operators. Algorithms (`fm.algo`), `a→b` means a modulates b; C = carriers summed to output:
1. 4→3→2→1, C[1]
2. (3+4)→2→1, C[1]
3. 2→1, 4→3, C[1,3]
4. (2 + (4→3))→1, C[1]
5. 4→1, 4→2, 4→3, C[1,2,3]
6. 4→3, C[1,2,3]
7. 2→1, C[1,3,4]
8. C[1,2,3,4] (additive)
Op 4 has self-feedback (`fm.feedback`, averaged two-sample feedback to avoid chaos).
Per op: `ratio` (× note freq), `detune` (cents), `level` (carrier: output gain; modulator: index β = 4π·level² radians peak), envelope `a/d/s/r` (exponential segments), `vel` (velocity → op level), `kscale` (−1..1: level scaled by ±(note−60)/48, positive = brighter up high). Carriers summed and normalised by 1/√(#carriers). Engine `oct/fine` transpose. Anti-aliasing: at minimum clamp indices so modulated frequencies stay reasonable; oversampling 2× optional if affordable.
`isActive()` false when all carrier envelopes are finished after noteOff.

### phys (engines/phys.js)
* `model`: `string` = waveguide (Karplus-Strong family: fractional-delay tuned with allpass/Thiran interpolation, loop filter set by `decay` (T60 in s) and `brightness`, `inharm` = stiffness dispersion allpass, `position` = pick/comb position, `body` = small resonant body filter bank, ±`spread` stereo via two slightly detuned strings).
  `bar`, `bell`, `glass`, `membrane`, `plate` = **modal** resonator bank (≥ 24 modes when affordable, per-mode decay scaled by frequency & `brightness`; mode ratios per material: bar ≈ marimba tuned bar (1, 3.93→tuned 4, 10…) , bell ≈ church-bell partials (0.5 hum, 1, 1.2 minor third, 1.5, 2, 2.5, 3…), glass (bright sparse inharmonic), membrane (Bessel zeros 1, 1.59, 2.14, 2.30, 2.65…), plate (dense 2D plate modes); `inharm` morphs ratios away from/toward harmonic; `position` sets mode excitation weights (e.g. sin(k·π·pos)); modes above Nyquist×0.45 are dropped.
* `exciter`: `pluck` (shaped noise burst / filtered impulse, `hardness` = brightness & shortness), `mallet` (raised-cosine strike, hardness = contact time), `bow` (continuous stick-slip-ish friction excitation or bandpassed noise with `pressure`), `breath` (continuous filtered noise with `pressure`). Continuous exciters stop on noteOff.
* `decay` = T60 seconds of the resonator; `damp` = how strongly noteOff damps (0 rings on, 1 quick mute). `isActive()` false when energy < −90 dB.
* Output normalised so a typical pluck/strike peaks ≈ ±1.

### noise (engines/noise.js)
White → coloured by `color` (−1 = brown/dark, 0 = white, +1 = blue/bright) using filters; `width` = decorrelated L/R; `decay` > 0 → one-shot exponential decay from noteOn (useful for attack chiff, breath, snare); 0 → sustained.

## 5. Filters (src/dsp/filter.js)

```js
export class VoiceFilter {               // main filter, stereo, one per voice
  constructor(sampleRate)
  reset()
  // In place on bufL/bufR[offset..offset+n). type = enum index of FILTER_TYPES.
  // cutoff0 → cutoff1: interpolate exponentially across the block (no zipper).
  process(bufL, bufR, offset, n, type, cutoff0, cutoff1, res, drive, vowel)
}
// Allocation-free entry point used by the voice: write filter.inp = Float64Array [cutoff0, cutoff1, res, drive, vowel],
// then call filter.run(bufL, bufR, offset, n, type). process(...) fills `inp` and calls run().
export class SVFilter {                  // generic TPT state-variable filter, stereo; used for filter2 and elsewhere
                                         // (same pattern: inp = [cutoff, res]; run(bufL, bufR, offset, n, mode))
  constructor(sampleRate)
  reset()
  process(bufL, bufR, offset, n, mode /* 0 lp,1 hp,2 bp,3 notch */, cutoff, res)
}
// For the UI: magnitude response in dB at the given frequencies (Float32Array of Hz). Analytic or approximate.
export function filterResponse(type, cutoff, res, drive, vowel, freqs, sampleRate) // → Float32Array dB
```
* `ladder24/12`: Moog-style ZDF/TPT ladder, nonlinear (tanh-ish saturation, fast approximations), self-oscillates near res = 1 with stable amplitude, bass loss compensation; `drive` pushes into saturation with gain compensation. Consider 2× oversampling for the nonlinear ladder if CPU allows.
* `lp/bp/hp/notch`: TPT SVF (Simper), resonant, stable under fast modulation.
* `formant`: vowel filter (parallel bandpasses; `vowel` morphs A-E-I-O-U; `cutoff` shifts formants ±, e.g. `cutoff/1000` as scale in sqrt; `res` = sharpness).
* `comb`: feedback comb tuned to `cutoff` Hz (fractional delay), `res` = feedback (0..0.98, allow negative-ish via drive? keep simple), with gentle damping.
* All must be stable for cutoff 20..20000 at any sample rate (clamp to < 0.49·fs).

## 6. Synth core (src/dsp/synth.js, voice.js, env.js, lfo.js, performance.js, sequencer.js, util.js)

```js
export class Synth {
  constructor(sampleRate, { seed = 1 } = {})
  loadPatch(patch)             // patch: { params: {id: nativeValue}, macros: [{name, targets:[{id, amount}]}×≤4] } — missing params → defaults; global-scope params are NOT changed by loadPatch
  setParam(id, nativeValue)    // enums by option id or index, bools by boolean or 0/1
  setParams(obj)
  getParam(id)                 // native value (base)
  setMacro(i /*0..3*/, value /*0..1*/)   // same as setParam(`macro${i+1}`, v)
  noteOn(note, velocity /*0..1*/)       // goes through performance layer (scale lock → chord → arp) then voice allocation
  noteOff(note)
  setController(kind, value)   // 'wheel' 0..1, 'aftertouch' 0..1, 'bend' -1..1, 'sustain' 0|1
  allNotesOff(hard = false)    // hard: immediately silence
  sequencer                    // Sequencer instance (see below)
  process(outL, outR, n)       // render n samples (any n; internally in CR blocks). Overwrites buffers.
  getState()                   // for UI/visuals, cheap: { voices: [{note, velocity, level /*current amp env*/, stage /*'attack'|'decay'|'sustain'|'release'*/, age}], peak:[l,r], rms:[l,r], held: [notes], arpStep, beat /*sequencer/arp beat position*/, cpuLoad? }
}
```
* **Macros**: `eff_norm[target] = clamp01(base_norm[target] + Σ amount_i · macro_i)` over the patch's macro targets (amount −1..1, normalised units). Targets may be any float/int param including FX params. Macro values are the params `macro1..4` (patch scope; presets may set their initial values).
* **Voice allocation**: `voice.poly` limit; steal oldest released voice first, else the quietest held voice (ties → oldest; a voice still in its attack, or whose note-on has not rendered yet, counts as full level — never steal the note just played), else the oldest not-yet-rendered voice (more notes in one block than `voice.poly`: the latest win); stolen voices get a ~2 ms fade (no clicks). Pool exhausted by fading voices → the quietest fading voice is cut, never a new note (`synth.droppedNotes` counts notes stolen before they sounded; the song tests require 0). Mono/legato modes: last-note priority with note stack; legato = no retrigger of envelopes when overlapping. Voices are freed when amp env finished AND (engines inactive or amp env silent).
* Sustain pedal holds noteOffs.
* **Envelopes** (`env.js`): ADSR with `curve` (see params.js comment), exponential-ish decay/release, retrigger from current level (no clicks), `a=0` still ramps ≥ 1 ms (amp) to avoid clicks. Amp env output per-sample (or ramped).
* **LFOs** (`lfo.js`): shapes per params; `sync` ≠ off → rate from `global.bpm` and `divToBeats`; `fade` fade-in from note start; `mode` poly = per voice, phase reset to `phase` at noteOn; mono = one shared free-running instance in the Synth; `sh`/`smooth` use RNG. Output −1..1 (bipolar).
* **Mod sources** (per voice, per control block): lfo1, lfo2 (−1..1); menv, fenv, aenv (0..1); velocity (0..1); note ((note−60)/48, clamp −1..1); wheel, aftertouch (0..1); bend (−1..1); random (per-note, −1..1, fixed at noteOn).
* **Filter cutoff** per control block: `cutoff · 2^( key·(note−60)/12 + env·6·fenv + vel·3·velocity )` then modulation (normalised) → clamp 20..0.45·fs. `filter.env` is in the mod dest list too; the formula uses the (modulated) value.
* **Performance layer** (`performance.js`): scale lock (`scale.type`, `scale.root`: snap incoming note to nearest scale note, prefer down on ties) → chord memory (`chord.type`: expand to chord notes; note-offs release the same expansion; option order is `CHORD_IDS` in params.js —
  not `Object.keys(CHORDS)`, which enumerates the integer-like key `'7'` first; DSP tables are built from the schema's option order) → arpeggiator (`arp.*`, tempo from `global.bpm`, sample-accurate step timing inside `process`, swing on even steps, gate, octaves, latch, modes; `chord` mode retriggers all held notes each step). The arp clock must run even with the sequencer stopped.
* **Sequencer** (`sequencer.js`) for demos/autoplay, sample-accurate at CR resolution:
  ```js
  synth.sequencer.load({ bpm, loop /*bool*/, lengthBeats, events: [ {beat, type:'on', note, vel, dur /*beats*/} | {beat, type:'param', id, value} | {beat, type:'ramp', id, to, beats /*linear ramp in normalised space*/} | {beat, type:'macro', index, value} | {beat, type:'ramp-macro', index, to, beats} ] })
  synth.sequencer.play(); .stop(); .playing; .beat   // stop() releases sequencer-held notes
  ```
  Sequencer notes go through the performance layer like live notes. `bpm` from the song sets `global.bpm` while playing.
* `util.js`: `mtof`, `dbToGain`, `gainToDb`, `clamp`, `fastTanh` (accurate within 1e-3 on ±5, monotone, bounded), `polyBlep`, `polyBlamp`, `Rng` (xorshift32, `next()` 0..1, `bipolar()`), `onePoleCoef(timeSec, sr)`, `PI2`.

## 7. Effects (src/dsp/fx/)

```js
export class FxChain {
  constructor(sampleRate)
  process(L, R, n, eff /* Float64Array effective values */, bpm)   // in place, n arbitrary (≤ 128 typical)
  reset()
  tailActive()   // optional
}
```
Each effect is its own class/file (`drive.js chorus.js phaser.js delay.js reverb.js eq.js comp.js limiter.js`). Bypassed effects cost ~nothing; toggling on/off or changing params must never click (crossfade/smooth ~10–30 ms). All params smoothed.
* drive: soft (tanh), tube (asymmetric, even harmonics), fold (wavefolder), crush (bit depth + sample-rate reduction driven by amount). `tone` = tilt EQ after; auto gain compensation; 2× oversampling for soft/tube/fold recommended.
* chorus: `chorus` (2 voices, stereo), `ensemble` (3-phase BBD-string-ensemble style, lush), `flanger` (short delay + feedback). Interpolated (cubic/allpass) delay reads.
* phaser: N allpass stages (enum 4/6/8/12), exponential sweep 200 Hz–8 kHz, stereo quadrature LFO, feedback.
* delay: `sync` ≠ off → time from bpm; else `time`. Feedback path with `tone` (LP/HP band limiting, darker as tone → 0), `pingpong` (cross-feed amount), `wobble` (tape wow/flutter), soft saturation in loop, smooth time changes (no zipper; pitch-glide like tape is fine).
* reverb: high-quality **FDN** (8+ lines, Hadamard/Householder mixing, modulated delay lines, frequency-dependent decay for `decay` T60 and `damp`), input diffusion allpasses, `size` scales delay lengths, `predelay`, `width`, `shimmer` (+12 st pitch shifter in the feedback path, blended by shimmer — lush, not metallic), `mix`. This is a centrepiece: must sound lush, smooth, no metallic ringing, no flutter.
* eq: low shelf 120 Hz, peaking at `eq.midfreq` (Q≈0.9), high shelf 8 kHz (RBJ biquads).
* comp (`comp.amount`): gentle stereo-linked bus glue compressor (ratio ~2–4 rising with amount, auto makeup).
* limiter (always on, after master.volume): lookahead ~1.5 ms, ceiling −0.3 dBFS, never outputs > 1.0 or NaN. Clean when not limiting.

## 8. UI (src/ui/, css/)

Language: Traditional Chinese first (zh-TW) with English synth terms where universal (LFO, FM, ADSR, Cutoff). The schema has `label` (EN) and `zh` for every param; show zh with EN small caps or vice versa — consistent.

### Visual design system ("Aurora")
Dark, luminous, premium hardware-meets-aurora aesthetic. Tokens (css/style.css `:root`):
```
--bg-0:#07080d; --bg-1:#0c0f18; --bg-2:#121726; --panel:rgba(22,28,46,.72); --panel-hi:rgba(38,48,78,.6);
--line:rgba(140,160,220,.14); --text:#e8ecff; --text-dim:#8e97b8; --text-faint:#5a6284;
--a-cyan:#5cf2ff; --a-teal:#3ef0b0; --a-violet:#a78bfa; --a-pink:#ff6bd6; --a-amber:#ffc46b; --a-red:#ff6b81;
--grad-aurora: linear-gradient(120deg,#3ef0b0,#5cf2ff 30%,#a78bfa 65%,#ff6bd6);
--radius:14px; --radius-sm:8px; --shadow: 0 10px 40px rgba(0,0,0,.45);
--font-ui: "Inter","Noto Sans TC",system-ui,sans-serif; --font-mono:"JetBrains Mono",ui-monospace,monospace;
Section accents: sources = --a-cyan, filter = --a-violet, envelopes/mod = --a-amber, fx = --a-pink, performance = --a-teal.
```
Glassy panels (backdrop-filter blur), subtle grain, soft glows on active elements, smooth 150–250 ms transitions, everything animated tastefully. Must look stunning at 1440×900 and still work at 1024 wide and on a tablet; phone gets a simplified "play" layout (macros, XY pad, keyboard/pads, preset browser).

### Component APIs (src/ui/components.js — one module, plus keyboard.js)
All components return `{ el, ... }` with plain DOM; they never talk to audio directly.
```js
createKnob({ param /*schema entry*/, value, onChange(v), size:'sm'|'md'|'lg'|'xl', accent /*css color*/, label /*override*/, showValue:true, bipolar })
  → { el, setValue(v) /*no onChange*/, setModulation(normLo, normHi) /*draw mod range arc*/, setAccent(c) }
  // vertical drag (shift = fine), wheel, double-click → default, arrow keys, value bubble while dragging, ARIA slider.
createSlider({ param, value, onChange, orientation:'h'|'v', accent }) → { el, setValue }
createToggle({ label, value, onChange, accent }) → { el, setValue }       // pill switch w/ glow
createSelect({ param, value, onChange }) → { el, setValue }                // styled segmented or dropdown depending on option count (≤4 → segmented)
createEnvelopeEditor({ values:{a,d,s,r,curve}, ranges /*schema entries*/, onChange(partialNative), accent })
  → { el, setValues(v), setPlayhead(level, stage) }   // draggable nodes on a canvas/SVG curve
createXYPad({ x, y, onChange(x,y), labelX, labelY, accent }) → { el, setXY(x,y) }  // glowing puck, trails, springs back? no — stays
createKeyboard({ low:36, high:96, onNoteOn(note, vel), onNoteOff(note) }) → { el, setActive(noteSet /*Set<number>*/), setScale(root, scaleIntervals|null), setRange(low, high) }
  // velocity from vertical click position; glissando while dragging; multi-touch; active keys glow in aurora colours; scale notes marked when scale lock on
attachQwerty({ onNoteOn, onNoteOff, onOctave(delta) }) → detach()   // Z-row/Q-row two-octave layout (Ableton-style), Z/X octave, C/V velocity; ignore when focus in inputs
attachMidi({ onNoteOn, onNoteOff, onController(kind,value) }) → Promise<{ inputs:[names], detach() }>  // Web MIDI; CC1 → wheel, CC64 sustain, pitch bend, channel pressure
```
### Visual APIs (src/ui/visuals.js)
```js
createHeroVisualizer({ analyser /*AnalyserNode stereo-summed*/, analyserL, analyserR, getState /*() => synth state from worklet*/ })
  → { el, start(), stop(), setPalette(name) }
  // The centrepiece: a gorgeous, reactive, 60 fps visual (WebGL2 preferred with Canvas2D fallback) — e.g. an aurora ribbon/particle field
  // driven by the spectrum (colour from spectral centroid, energy from loudness, stereo field from L/R), with per-voice note "blooms".
createScope({ analyserL, analyserR, mode:'wave'|'lissajous' }) → { el, start(), stop(), setMode(m) }
createSpectrum({ analyser }) → { el, start(), stop() }       // log-frequency, smooth, peak-hold, glow
createFilterView({ getParams /*() => {type,cutoff,res,drive,vowel}*/, filterResponse /*from dsp/filter.js*/, sampleRate }) → { el, update() }
createLfoView({ getParams /*() => {shape, rate, ...}*/ }) → { el, update() }
createMeter({ getState }) → { el }                            // stereo peak/rms meter
```
Visuals must throttle when tab hidden and cost < 4 ms/frame.

### Audio bridge (src/ui/audio.js)
```js
export async function createAudio() → {
  ctx, node /*AudioWorkletNode*/, analyser, analyserL, analyserR,
  noteOn(note, vel), noteOff(note), setParam(id, v), setParams(obj), loadPatch(patch), setMacro(i, v), setController(kind, v),
  allNotesOff(hard), seqLoad(song), seqPlay(), seqStop(),
  getState() /* latest state posted by worklet ~30 Hz */, onState(cb), resume(),
  contextState() /* 'running'|'suspended'|'interrupted'|'closed' */, onContextState(cb)
}
```
`createAudio()` throws `err.code = 'insecure-context'` (bilingual message) before creating anything when
`isSecureContext === false`; without an explicit `sampleRate` a context faster than 48 kHz is recreated at 48 kHz
(`MAX_AUTO_SAMPLE_RATE`, src/ui/compat.js). See §11 *Platform compatibility*.
Worklet message protocol (main → worklet, `port.postMessage`): `{type:'noteOn',note,vel}`, `{type:'noteOff',note}`, `{type:'param',id,value}`, `{type:'params',values}`, `{type:'patch',patch}`, `{type:'macro',index,value}`, `{type:'ctrl',kind,value}`, `{type:'allOff',hard}`, `{type:'seqLoad',song}`, `{type:'seqPlay'}`, `{type:'seqStop'}`.
Worklet → main: `{type:'state', state}` (≈30 Hz, from `synth.getState()` plus `seqPlaying`, `seqBeat`), `{type:'ready'}`, `{type:'error', message}`.
The processor: `registerProcessor('aurora-synth', ...)`, 0 inputs, 1 output with 2 channels, constructs `new Synth(sampleRate)`.

### App (index.html, src/ui/main.js, src/ui/app/*.js)
Layout (desktop): top bar (logo AURORA 極光, preset name with ◀ ▶, category browser button, Save, Undo/Redo?, Random/Mutate, tempo, master volume, MIDI status, CPU/meter); left: preset browser (categories, search, favourites, tags); centre: **hero visualizer** with 4 big macro knobs + XY pad ("Play" view); a tab strip for deep editing: 聲源 Sources | 濾波 Filter | 調變 Mod | 效果 FX | 演奏 Perform; bottom: keyboard with wheel/bend strips. A big friendly "▶ Demo" button (plays the preset's demo phrase — the sequencer; detailed demo features come later).
The editor panels are generated from the schema groups (`GROUPS`, `PARAMS`), with custom visual widgets where they add clarity: envelope editors, filter response curve, LFO shape view, FM algorithm diagram, mod matrix with source colours, modulation arcs on knobs.
User presets: save to localStorage, export/import JSON. "Mutate": randomise selected params by small amounts; "Randomize" with musical constraints.
Undo/redo for parameter edits is a nice-to-have.

## 9. Presets (src/presets/)

```js
// src/presets/<category>.js
export default [
  { name: 'Aurora Pad', category: 'pad', tags: ['warm','wide'], description: '中文一句話描述',
    params: { 'osc1.unison': 7, ... },   // only non-default values; native units
    macros: [ { name: '亮度 Bright', targets: [ { id: 'filter.cutoff', amount: 0.35 }, ... ] }, ×4 ],
    demo: 'pad' /* demo phrase style: 'keys'|'pad'|'bass'|'lead'|'pluck'|'bell'|'arp'|'fx'|'drum' */ },
];
// src/presets/index.js aggregates: export const PRESETS = [...]; export const CATEGORIES = [{id, label, zh, icon}]
```
Categories: keys 鍵盤, pad 鋪底, bass 貝斯, lead 主奏, pluck 撥弦, bell 鐘琴, strings 弦樂/管樂 (orchestral-ish), arp 琶音/律動, fx 音效/質感, drum 打擊.
Every preset has exactly 4 named macros that do something musically meaningful and safe across their whole range.

## 10. Tools (tools/)
* `serve.mjs` — zero-dependency static server (port 5173, correct MIME for .js/.mjs/.css/.html/.json/.wasm/.svg/.png, no caching headers for dev).
  `--https` / `HTTPS=1`: TLS with `.cert/cert.pem`+`key.pem` (mkcert) or an auto-generated self-signed certificate
  (`selfsigned.mjs`, cached in `.cert/`, regenerated for new LAN addresses); plain http on the same port → 308 to https.
  `--lan` (`npm run lan`) = https on 0.0.0.0 and prints the LAN URLs.
* `compat-checks.mjs` — suite `compat` of `npm test` (https server, src/ui/compat.js, createAudio rate cap, saved-data shapes, DSP at 16–192 kHz).
* `wav.mjs` — 16/24-bit/float WAV writer. `png.mjs` — minimal PNG encoder (zlib from node). `analyze.mjs` — metrics: peak dBFS, RMS dB, approximate integrated loudness (K-weighted, LUFS-ish), crest factor, DC offset, NaN/Inf count, spectral centroid over time, low/mid/high band energy, stereo correlation/width, onset/decay times, estimated aliasing indicator (energy that doesn't track harmonics is hard — at least report energy above 16 kHz for notes < 1 kHz), noise floor at tail; spectrogram PNG (log freq, dB colormap) and waveform PNG.
* `render.mjs` — CLI: `node tools/render.mjs --preset "<name>" [--phrase keys|pad|bass|lead|pluck|bell|arp|fx|drum|scale|single] [--note 60] [--sr 48000] [--out renders/] [--params '{"filter.cutoff":800}']` → WAV + PNG spectrogram + JSON metrics. Also `--all` for all presets and `--patch file.json`.
* `test.mjs` — `npm test`: loads all modules in Node, runs each engine/filter/fx through edge cases (extreme params, all enum values, sample rates 44.1k/48k/96k, rapid param changes), every preset through a phrase; asserts no NaN/Inf, no sample > 1.0 at output, no DC > 0.01, voices free after release, CPU real-time factor per preset (report; fail if a single 8-voice chord renders slower than 0.5× real time on this machine), and silence after all notes off + tails.

---

## 11. Integration notes (accepted deviations, measured status)

Behaviour that differs from, or refines, the contracts above — kept because it is measurably better:

* **osc**: 16-sample band-limiting accumulator latency, pre-rolled so notes start on time (param/pitch changes reach the
  output 0.33 ms late). Saw falls (1−2p). Detune curve 0.6x^1.3 + 0.4x³ (max ±50 ct). Unison normalised 1/√N (peaks up to
  ≈2–3 at max unison/detune by design; the output limiter takes it). Wavetables: Int16 storage, 10.6 MB, ≈55 ms generation.
* **fm**: op `d`/`r` are T60 times; key scaling ±12 dB at ±4 oct; automatic index clamping (8 kHz brightness ceiling,
  anti-alias Carson limit) at 2× oversampling; algorithm changes duck ≈2 ms.
* **phys**: strikes peak-normalised; bow position range narrowed to the Helmholtz-stable zone; breath adds a jet tone.
* **filter**: ladder 2× oversampled below 88.2 kHz, drive up to +18 dB; `filter2.type` 'off' skips the SVF, else mode = index − 1.
* **fx**: per-effect `process(L, R, off, n, eff)` (offset form); delay reads tempo from a field; send-style mix law for
  delay/reverb; limiter has `releaseMs`, `latency`; shimmer caps T60 at ≈10 s at shimmer 1.
* **voice smoothing (integration)**: source gains, amp gain/pan, base cutoff (log domain), res/drive/vowel and filter 2
  follow a 6 ms one-pole evaluated per control block (still linearly ramped inside it); `filter.on` and filter 2 off↔on
  crossfade over 5 ms. A level knob turned at UI rate went from −32 dB to −59 dB HF bursts (steady tone: −92 dB);
  `filter.on` toggles from −14 dB to −66 dB. The filter-envelope contribution to cutoff is not smoothed.
* **core**: `loadPatch` fades sounding voices over 6 ms; sequencer restores params it changed on stop (`restoreOnStop`);
  hard all-notes-off also clears FX tails; idle bypass skips FX + limiter after 50 ms of silence; getState has extra fields
  (activeVoices, bpm, reduction, macros, focus); `renderOffline` returns `{L, R, synth}` and accepts extra event types.
* **UI**: QWERTY follows the Ableton A-row layout (A W S E D … = C…, Z/X octave, C/V velocity), not "Z-row/Q-row".

### Demo features (integration)

* **Transport rule** (`src/ui/demo/center.js` `createTransport`): exactly one demo source owns playback — `demo`
  (▶ 示範, synth sequencer), `song` (Ensemble), `tour` (sequencer + transient patch), `jam` (Ensemble), `magic`
  (▶ 試聽, sequencer) or `theater`. `claim(kind, stop)` runs the previous owner's stop callback first; owners that
  play on the Ensemble never touch the sequencer and vice versa, so every stop callback stops its own engine
  (a tour stopped by a song used to leave its phrase looping). Panic / Space-to-stop call `stopAll()`.
* **Tempo**: `Sequencer.play()` writes the phrase tempo as a restorable change (restored on stop unless the user
  changed the tempo meanwhile); the worklet does the same for songs (`_followTempo` / `_restoreTempo`). Before this,
  any ▶ 示範 / tour / theater phrase left the user's arp and synced LFOs/delays at the phrase tempo while the top bar
  showed the user's tempo.
* **Ensemble state during a pending load** reports the song being loaded (id, sections, parts), not the outgoing
  one — the Jam panel read the old id as "another song took over" and orphaned its own playback.
* **JIT warm-up** (`processor.js` `warmup` message, sent by `audio.js`): the first demo song of a session rendered
  ≈20–30 ms of cold (interpreted) DSP code in its first quanta (≈7 underruns at its first beat in Chrome). After the
  part pool is built, while everything is silent, a private Synth plays ten factory presets that cover every
  engine / phys model / filter type / FX (16 quanta each, one per `process()` call, output discarded). Measured in
  Chrome (M5): first-song underruns 7 → 1 event; the startup underruns (part-pool construction, ≈18 events in the
  first second) happen while nothing sounds.
* **Measured in headless Chrome 152 (ANGLE Metal, M5), 1440×900**: while a demo song plays the worklet render load
  is 12–18 % median (max 20–32 % incl. the Jam), the hero visualizer costs 0.07–0.13 ms of main-thread time per
  frame at 60 fps, no long tasks, and `AudioContext.playbackStats` counts 0 underruns during playback.

### Platform compatibility (src/ui/compat.js, css/compat.css)

* **Secure context**: phones/tablets opening `http://<LAN-IP>` get no AudioWorklet, Web MIDI or Wake Lock. The splash
  says so before the first tap (`applySplashCompat`), `createAudio` throws a clear bilingual error, and `npm run lan`
  serves https (self-signed: one browser warning; or mkcert for none). http on the https port redirects.
* **iOS ring/silent switch**: Web Audio alone is in the 'ambient' session (muted by the switch).
  `navigator.audioSession.type = 'playback'` (Safari 16.4+/17) before the context starts; older iOS: a looping silent
  8-bit WAV `<audio>` started in the same gesture (only on iPhone/iPad without `audioSession`; paused on close).
* **Interruptions** (calls, Siri, backgrounding): `onContextState` → "聲音已暫停 — 點一下恢復" pill and
  `html.audio-suspended` (live indicators freeze); resume also tried on `visibilitychange`/`pageshow` and any gesture.
* **Web MIDI**: requested only on a click (top-bar MIDI button or ⋯ menu) unless `permissions.query({name:'midi'})` is
  already 'granted' — Chrome 124+ prompts for all MIDI access, Firefox installs a site-permission add-on. The splash
  "支援 MIDI" hint is hidden where there is no Web MIDI (Safari/iOS).
* **Wake Lock**: held while any transport owner plays (song, jam, tour, theater, ▶ 示範, magic preview), re-acquired
  when the page is visible again. Fullscreen uses the webkit prefix where needed; the theater button hides on iPhone.
* **Sample rate**: 96/192 kHz output devices cost ≈2×/4× DSP (neon-nights cpuMeanLoad 0.49/0.84/1.75 at 48/96/192k):
  contexts above 48 kHz are recreated at 48 kHz (browsers resample). The DSP stays clean at 16–192 kHz (test `compat`).
* **Fonts**: the Google Fonts stylesheet is preloaded (non-blocking, `<noscript>` fallback); `--font-ui` lists
  "PingFang TC" before "Noto Sans TC", so Apple devices use the native CJK face (booting the app fetched 52 Noto slices
  ≈3.4 MB before, 0 after; Windows/Android still get Noto).
* **Saved data**: user presets / favourites are shape-checked on load (tags → array of strings); if boot still fails,
  the splash offers "清除已儲存的資料並重新載入" (downloads a backup of every `aurora.*` key first).

Status at integration (Apple M5, Node 26 / headless Chrome):
* `npm test`: all pass; remaining WARNs are the documented trade-offs (phys 1 s RMS vs sustained saw, osc max-setting peak).
* Audio path allocation: whole Synth (8 voices, all FX, S&H + shape modulation) ≈ 0.05 KB / 128 samples, 0 GCs in 4 s
  (was 4.7 KB and 4 GCs).
* Worst realistic patch (osc1+osc2 unison 7, FM, driven ladder, chorus/delay/reverb, 12 voices): ≈8× real time in Node,
  ≈19 % of the render-quantum budget in Chrome's AudioWorklet; everything on at 16 voices ≈ 30 %.
