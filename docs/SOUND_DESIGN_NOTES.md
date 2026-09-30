# Sound design notes from the engine builders

Verified starting points and engine behaviour notes. Param sets are JSON (param id → value).


## osc

I wrote the osc engine (classic VA plus wavetable) and the procedural wavetable module. Everything was checked numerically: alias spectra, a comparison against a 16× oversampled render, a fuzz test and CPU timing. No other files were touched.

**osc.js — anti-aliasing**
- Uses a linear-phase table BLEP/BLAMP: a 32-tap Kaiser-windowed sinc (β=9, cutoff at Nyquist), 64 sub-sample rows with linear interpolation between them.
- Every unison voice writes its naive sample into one shared stereo accumulator, which is read 16 samples late. Each event adds a residual at its exact sub-sample time.
- Events covered: saw reset, pulse edges (solved analytically even while pw moves), triangle corners (BLAMP), and sync resets (jumps in value, slope, 2nd and 3rd derivative).
- The 2nd/3rd-order residual tables carry a small correction for the window's non-zero second moment so they stay finite-length.
- At note start the 16-sample latency is pre-rolled, so a fresh note begins on the note-on sample at the chosen phase. Retriggers in reset/random mode crossfade from the old waveform over 16 samples.

**osc.js — classic mode**
- Sine / tri / falling saw / DC-free pulse, phase-aligned so crossfades never cancel the fundamental. Shape crossfades neighbours.
- Weights, pw and gains are ramped per sample.
- Self hard-sync: slave = f·2^(4·sync), reset by a virtual master at f. Samples without a reset use the fast inline path.
- A 3.5 Hz DC blocker removes the DC that synced waveforms carry.

**osc.js — wavetable mode**
- 4-point cubic Hermite read with a linear crossfade between frames.
- Mip choice: the richest level whose top harmonic is ≤ (1 − 15 kHz/fs)·fs, so aliases can only land above 15 kHz. Level changes are crossfaded over one block.
- Wavetable sync is also supported, with 3rd-order residuals and a 0.33·fs mip limit.

**osc.js — unison, drift, phase**
- Unison 1–8 uses the JP-8000 voice ratios for N=7 and hand-made irregular spacings otherwise. Detune curve is 0.6x^1.3 + 0.4x³, up to ±50 ct on the outer voices.
- Blend: 0 = centre voice(s) only, 0.5 = all equal, 1 = sides dominant. Stereo spread alternates sides so each side gets sharp and flat voices.
- Normalisation is 1/√Σg². Changes to unison count or gains ramp in/out, so they don't click.
- Drift: per-voice smoothed random walk (≈0.1–1 Hz, drift 1 ≈ ±8 ct), deterministic, re-seeded per note so voices stay uncorrelated.
- Phase modes: free, reset (centre voice at 0, others on a fixed golden-ratio pattern), random.
- All parameter clamps are NaN-safe.

**wavetables.js**
- 10 tables × 64 frames. Each frame is a harmonic spectrum (up to 512 harmonics) built three ways: analytically, as an exact closed-form Fourier series of piecewise-linear waveforms, or by FFT of a densely sampled waveform.
- Rendered with my own radix-2 FFT (real inverse via a half-size complex FFT) into 10 per-octave mip levels (512…1 harmonics). Levels are 4× / 8× / 16–64× oversampled, with a raised-cosine taper on the top 15%.
- Stored as Int16 with a per-table scale and Hermite guard samples. Total 10.6 MB, generated once into a shared module cache.
- The tables:
  - **analog:** sine → tri → saw → square, the same level as classic mode.
  - **harmonic:** additive sweep, 1 → 64 partials.
  - **vowels:** Klatt-style 5-formant cascade, A→E→I→O→U (tenor formants, designed for D3).
  - **pulse:** PWM sweep 50% → 3%.
  - **organ:** 10 Hammond drawbar registrations, played at f/2 so the 16′ and 5⅓′ drawbars exist.
  - **glass:** free-free bar modes mapped onto sparse, mostly odd partials, stretching and brightening, with twinkling high partials.
  - **sync:** exact hard-sync saw, slave ratio 1→8.
  - **digital:** PPG-style — stepped sine, square+square organ, bit-reduced saw, CZ-style resonant sweep.
  - **strings:** bowed Helmholtz spectrum with bow-position comb and violin body resonances, brightening.
  - **growl:** saw/square source through sweeping resonant formants, tanh-waveshaped, then band-limited again.
- `getWavetableFrame()` returns one cycle for UI drawing.

### Deviations
No changes to params.js or util.js were needed. Behaviours other engineers or the UI should know about:
1. The accumulator adds 16 samples of latency. It is pre-rolled, so a note still starts on its note-on sample, but parameter and pitch changes reach the osc output 16 samples (0.33 ms) late.
2. The constructor takes an optional third argument `seed`. `voice.js` currently calls `new OscEngine(sr, 'osc1')` without it; that is fine because voices decorrelate through a per-note hash of note number and note count, and renders stay deterministic per Synth. Passing the voice index would add extra variety.
3. Waveform conventions:
   - The saw falls (1−2p) so all shapes share the fundamental's phase; a sync reset jumps it to +1.
   - The pulse is DC-free: ±1 at pw 0.5, but peaks about +1.9 at pw 0.05. The WT pulse table uses the same peak-to-peak normalisation.
   - pw does nothing in wavetable mode.
4. Blend: 0 = centre voice(s) only, 0.5 = all voices equal, 1 = sides full with the centre at 0.31. With unison 2 both voices count as centre, so blend has no effect there.
5. Reset phase mode puts the centre voice at phase 0 and the other unison voices on a fixed golden-ratio spread. They are never all aligned, which avoids a √N peak. In free mode, a freshly constructed or reset engine gets note-seeded random phases.
6. The organ wavetable plays at f/2 (freqRatio 0.5) so the 16′ and 5⅓′ drawbars can exist. `getWavetableFrame` therefore shows one 16′ cycle, which is two 8′ cycles.
7. Vowels, strings and growl use formants fixed relative to the note, so formants move with pitch (normal for wavetables). Their design pitches are exported as `WAVETABLE_REF_HZ`.
8. Tables are stored as Int16 with a per-table scale (about −94 dB quantisation). That is what lets the mips be 16× oversampled for the Hermite read while staying at 10.6 MB.
9. The detune curve is 0.6x^1.3 + 0.4x³. It keeps the JP-8000 shape (slow start, accelerating top) but maxes at the spec's ±50 ct; the JP polynomial itself is nearly flat and then jumps to about ±190 ct.
10. Hard sync also works in wavetable mode.
11. Any process length n is accepted, and every call does its own control update. Splitting a block therefore just shortens that call's ramps.

### Known issues
- Sine-slave hard sync at very high fundamentals aliases: −56 dBFS at 5 kHz (sync 0.33), −48 dBFS at 5 kHz (sync 0.6) at 48 kHz. Saw/pulse/tri sync stays below −93 dBFS up to 5 kHz, and sine sync below −95 dBFS up to 2 kHz.
- Wavetable hard sync leaves about −60 to −80 dBFS of aliasing at 1–2.5 kHz fundamentals. Synced wavetables use a lower mip limit (0.33·fs), so they have slightly less top end.
- Wavetable aliases are allowed to land above 15 kHz by design. Worst in-band component: growl at 2.6 kHz on 44.1 kHz, −77 dBFS (a Hermite interpolation image).
- Table switching and classic↔wavetable mode changes are not crossfaded; they are UI-rate actions, so switching while a note sounds can make a small click. Shape, position and pw jumps crossfade over the call length (16 samples).
- Wavetable generation took 170–190 ms, measured while the machine was heavily loaded by the other parallel engineers (a calibration loop ran about 1.3× slow). Idle is estimated at about 130–150 ms. It runs once at the first OscEngine construction; Synth construction took about 200 ms in total. All timing numbers are noisy for the same reason.
- A 3.5 Hz DC blocker sits on the output. A slow (<3 Hz) sync sweep can leave slight sub-audio DC wander.
- A dense unison can peak around 2 and extreme fuzz settings reached 3.86 (a single voice stays near ±1); normalisation is 1/√N by design, so peaks are left to the downstream limiter.


## fm

I wrote src/dsp/engines/fm.js (825 lines), a 4-operator FM engine. It follows ARCHITECTURE.md §4 and is verified with numbers across the keyboard, at 44.1/48/96 kHz, including a randomised fuzz test. The only file I touched is fm.js. Test scripts are in the scratchpad fm/ folder.

What it does:
- The 8 algorithms exactly as specified, plus op4 self-feedback using the two-sample average.
- Per operator: ratio, detune, level, a/d/s/r, velocity sensitivity and key scaling. The engine applies fm.oct and fm.fine. It does not apply fm.level, fm.pan or fm.filt (the voice does).
- Carriers are summed and multiplied by 1/√(number of carriers). Modulator depth β = 4π·level² radians. Measured sidebands match the Bessel functions within 0.003 dB.
- Sine comes from a 4097-point interleaved value+delta table with linear interpolation (max error 2.9e-7, about −130 dB, spurs −121 dBc). This is about 2x faster than Math.sin in dependent chains. Phase accumulators are double precision.
- 2x oversampling below 64 kHz, decimated by an 8-coefficient polyphase IIR halfband (designed at load time). Stopband −95 dB, passband flat to 0.43·fs. It adds about 1.25 samples of delay, flat up to 10 kHz, so layering with other engines is fine.
- Index clamping to control aliasing and harshness:
  - Every control block, the engine estimates how far each carrier's spectrum reaches, working through the algorithm graph. It then finds one scale factor per carrier tree for all modulation depths in that tree.
  - The scale keeps spectral edges clear of fold-back at the oversampled rate, and keeps carrier brightness under an 8 kHz ceiling. It uses a soft knee, so the reduction is smooth and monotone across the keyboard.
  - Low and mid notes are untouched (a brass chain is unchanged up to C6). The top octaves get gentler automatically, even with key scaling at 0, as the task asked.
- Modulators whose own frequency is ultrasonic fade out (they could only fold back). Carriers fade near the oversampled Nyquist. Feedback depth shrinks at very high op4 pitch.
- A 5 Hz DC blocker on the output; high feedback settings make asymmetric waves that otherwise carried up to 0.2 of DC.
- Envelopes work like a DX7:
  - Attack is an RC-shaped curve that reaches full level exactly at `a` (minimum 1 ms). A retrigger restarts from the current level.
  - Decay and release are exponential, and d and r mean T60: the time to fall 60 dB.
  - `isActive()` goes false when every carrier has dropped below −90 dB after noteOff.
- Click prevention:
  - Operator levels and feedback are smoothed (about 3 ms) and all gains are ramped across each block.
  - Changing the algorithm while a note sounds fades out over about 2 ms, switches at silence, and fades back in.
  - Phases reset to 0 on noteOn only when the voice is silent, so retriggering a sounding voice never jumps.
- NaN-safe parameter handling.
- Also exported: `FM_ALGORITHMS` for the UI diagram, `feedbackBeta`, `fmSin`, and `getOpLevels()`.

Six param sets for the preset designers, each checked by spectrum. All are alias-free (worst ≤ −93 dBFS, mostly ≤ −99, at every tested note up to 103):

1. E-Piano (tine), algo 3: {"fm.algo":3,"fm.feedback":0.08,"fm.op1.ratio":1,"fm.op1.level":0.95,"fm.op1.a":0.001,"fm.op1.d":5.5,"fm.op1.s":0,"fm.op1.r":0.45,"fm.op1.vel":0.35,"fm.op1.kscale":-0.15,"fm.op2.ratio":1,"fm.op2.level":0.36,"fm.op2.a":0.001,"fm.op2.d":1.6,"fm.op2.s":0.12,"fm.op2.r":0.45,"fm.op2.vel":0.85,"fm.op2.kscale":-0.35,"fm.op3.ratio":1,"fm.op3.detune":3,"fm.op3.level":0.55,"fm.op3.a":0.001,"fm.op3.d":2.4,"fm.op3.s":0,"fm.op3.r":0.35,"fm.op3.vel":0.5,"fm.op3.kscale":-0.2,"fm.op4.ratio":14,"fm.op4.level":0.25,"fm.op4.a":0.001,"fm.op4.d":0.32,"fm.op4.s":0,"fm.op4.r":0.2,"fm.op4.vel":0.75,"fm.op4.kscale":-0.5}
   - At C4, first 43 ms: partials 1×/2×/3×/4× at 0/−6/−17/−29 dB, tine sidebands 13×/15× at −20 dB.
   - At 0.9 s only 1×/2×/3× remain (0/−19/−46 dB).
   - Loudness −1.8 dB vs the saw reference. Onset centroid 386 Hz at velocity 0.9, 267 Hz at 0.35.

2. Tubular Bells, algo 3: {"fm.algo":3,"fm.feedback":0,"fm.op1.ratio":1,"fm.op1.level":0.9,"fm.op1.a":0.001,"fm.op1.d":9,"fm.op1.s":0,"fm.op1.r":4,"fm.op1.vel":0.3,"fm.op2.ratio":3.5,"fm.op2.level":0.46,"fm.op2.a":0.001,"fm.op2.d":6,"fm.op2.s":0,"fm.op2.r":4,"fm.op2.vel":0.6,"fm.op2.kscale":-0.3,"fm.op3.ratio":2,"fm.op3.detune":7,"fm.op3.level":0.5,"fm.op3.a":0.001,"fm.op3.d":4.5,"fm.op3.s":0,"fm.op3.r":3,"fm.op3.vel":0.4,"fm.op4.ratio":5,"fm.op4.detune":-4,"fm.op4.level":0.33,"fm.op4.a":0.001,"fm.op4.d":2.5,"fm.op4.s":0,"fm.op4.r":2,"fm.op4.vel":0.6,"fm.op4.kscale":-0.3}
   - At onset: inharmonic partials at 2, 2.5, 3, 4.5, 6, 7, 8, 9.5 and 11.5× (within about −10 dB of each other).
   - At 1.8 s: the hum at 1× dominates, with 2×/2.5×/4.5× near −17 dB.
   - Centroid at C4: 1260 → 865 → 424 Hz (5 ms / 300 ms / 1 s).

3. Marimba, algo 3: {"fm.algo":3,"fm.feedback":0,"fm.op1.ratio":1,"fm.op1.level":1,"fm.op1.a":0.001,"fm.op1.d":1.1,"fm.op1.s":0,"fm.op1.r":0.25,"fm.op1.vel":0.35,"fm.op1.kscale":0,"fm.op2.ratio":3,"fm.op2.level":0.46,"fm.op2.a":0.001,"fm.op2.d":0.08,"fm.op2.s":0,"fm.op2.r":0.05,"fm.op2.vel":0.8,"fm.op2.kscale":-0.3,"fm.op3.ratio":3.99,"fm.op3.level":0.38,"fm.op3.a":0.001,"fm.op3.d":0.35,"fm.op3.s":0,"fm.op3.r":0.1,"fm.op3.vel":0.6,"fm.op3.kscale":-0.4,"fm.op4.ratio":1,"fm.op4.level":0.3,"fm.op4.a":0.001,"fm.op4.d":0.06,"fm.op4.s":0,"fm.op4.r":0.05,"fm.op4.vel":0.8}
   - At onset: 4th bar partial at −8 dB and a mallet knock at 2× (−17 dB).
   - By 0.7 s only the fundamental remains; −40 dB at 0.75 s.

4. FM Bass, algo 2: {"fm.algo":2,"fm.feedback":0.55,"fm.op1.ratio":1,"fm.op1.level":1,"fm.op1.a":0.001,"fm.op1.d":2.5,"fm.op1.s":0.55,"fm.op1.r":0.12,"fm.op1.vel":0.3,"fm.op2.ratio":1,"fm.op2.level":0.48,"fm.op2.a":0.001,"fm.op2.d":0.45,"fm.op2.s":0.25,"fm.op2.r":0.12,"fm.op2.vel":0.7,"fm.op2.kscale":-0.3,"fm.op3.ratio":2,"fm.op3.level":0.22,"fm.op3.a":0.001,"fm.op3.d":0.25,"fm.op3.s":0,"fm.op3.r":0.1,"fm.op3.vel":0.6,"fm.op4.ratio":1,"fm.op4.level":0.25,"fm.op4.a":0.001,"fm.op4.d":0.6,"fm.op4.s":0.3,"fm.op4.r":0.12,"fm.op4.vel":0.5}
   - Sustain is saw-like: partials 1× to 5× at 0/−5/−15/−25/−35 dB.
   - Loudness −1.5 dB vs saw. Onset centroid 122 Hz at velocity 0.9, 90 Hz at 0.35 (at C2).

5. FM Brass, algo 2: {"fm.algo":2,"fm.feedback":0.45,"fm.op1.ratio":1,"fm.op1.level":1,"fm.op1.a":0.03,"fm.op1.d":3,"fm.op1.s":0.85,"fm.op1.r":0.25,"fm.op1.vel":0.3,"fm.op2.ratio":1,"fm.op2.level":0.41,"fm.op2.a":0.09,"fm.op2.d":1.2,"fm.op2.s":0.55,"fm.op2.r":0.25,"fm.op2.vel":0.6,"fm.op2.kscale":-0.25,"fm.op3.ratio":1,"fm.op3.detune":5,"fm.op3.level":0.2,"fm.op3.a":0.12,"fm.op3.d":1,"fm.op3.s":0.7,"fm.op3.r":0.25,"fm.op3.vel":0.5,"fm.op4.ratio":1,"fm.op4.detune":-5,"fm.op4.level":0.18,"fm.op4.a":0.07,"fm.op4.d":1,"fm.op4.s":0.7,"fm.op4.r":0.25,"fm.op4.vel":0.5}
   - The modulation depth swells after the amplitude: centroid 306 → 413 Hz at C4.
   - Sustain 1×/2×/3× at 0/−2/−19 dB. The sustain depth is deliberately kept away from the 1:1 fundamental null near β≈1.84, which made an earlier version hollow.

6. Glass Pad, algo 5: {"fm.algo":5,"fm.feedback":0.15,"fm.op1.ratio":1,"fm.op1.level":0.9,"fm.op1.a":0.7,"fm.op1.d":6,"fm.op1.s":0.85,"fm.op1.r":2.5,"fm.op1.vel":0.2,"fm.op2.ratio":2,"fm.op2.detune":7,"fm.op2.level":0.55,"fm.op2.a":0.9,"fm.op2.d":6,"fm.op2.s":0.8,"fm.op2.r":2.8,"fm.op2.vel":0.2,"fm.op3.ratio":3,"fm.op3.detune":-7,"fm.op3.level":0.4,"fm.op3.a":1.2,"fm.op3.d":6,"fm.op3.s":0.8,"fm.op3.r":3,"fm.op3.vel":0.2,"fm.op3.kscale":-0.3,"fm.op4.ratio":4,"fm.op4.level":0.24,"fm.op4.a":1.6,"fm.op4.d":4,"fm.op4.s":0.6,"fm.op4.r":3,"fm.op4.vel":0.3,"fm.op4.kscale":-0.3}
   - The shimmer grows as op4 fades in: by 1.8 s partials 5×/6×/7×/9× sit at −10/−14/−16/−22 dB. Detuned operators give a slow chorus.
   - Late-sustain loudness −3.4 dB vs saw.

Suggested voice settings to use with these: "fm.on": true, "osc1.on": false. Amp envelope a=0, d=10, s=1, with r at least the longest carrier release (0.5 s for keys, 4 s for bells, 3 s for the pad). Either fm.filt 0 or an open filter, since the operator envelopes already shape the brightness.

### Deviations
No changes to params.js or util.js were needed. Choices the spec left open, or where I added behaviour:
1. Envelope timing: `d` and `r` are T60 times (time to fall 60 dB, exponential, linear in dB). Attack is an RC-shaped curve that reaches full level exactly at `a`, with a 1 ms minimum.
2. Key scaling: level × 2^(kscale·(note−60)/24), i.e. ±12 dB at ±4 octaves. The note comes from `freq` (the voice pitch before the engine's own transpose), so pitch bend and glide move it smoothly.
3. Velocity: level × (1 − vel·(1 − velocity)).
4. Effective carrier level is capped at 1.0, so key scaling never pushes a carrier past full level; modulator level is capped at 1.5 (β up to 28 rad). With four in-phase carriers the output can still reach about 2.0 after the 1/√(number of carriers) normalisation the spec asks for.
5. The feedback depth follows op4's envelope (as on a DX7) but not op4's level knob. The fm.feedback curve: 0 → sine, 0.75 → saw-like, 0.9 → gritty, 1.0 → noise.
6. Built-in index clamping means that with kscale = 0 the top octaves are still automatically made gentler (8 kHz brightness ceiling), as the task asked. Up to about C5 nothing changes. The ceiling is only adjustable through the constructor `opts`, not as a patch parameter.
7. Phases reset to 0 on noteOn only when the voice is silent (carriers below −60 dB). Otherwise they keep running, so retriggers can't click.
8. A legato noteOn keeps the original velocity.
9. The engine includes its own 5 Hz DC blocker.
10. Output is mono, duplicated to L and R; the voice does the panning.
11. Extras beyond the interface: an optional third constructor argument `opts`, the `getOpLevels()` method, and exports `feedbackBeta` and `fmSin`.
12. Changing fm.algo while a note sounds fades out over about 2 ms, switches at silence, and fades back in over about 2 ms.

### Known issues
- CPU, measured in Node on this machine while other jobs were running: 16 voices of a full 4-op stack with feedback at 2x oversampling cost 5.8–6.7% of one core, 8.4% on high notes where the clamp solver runs, e-piano 5.8%, idle voices 0.4%. An earlier run under heavier load showed 10–14%. Older machines or browsers could be 2–3x slower.
- At fm.feedback ≥ 0.95 (noise) the DC blocker can push peaks to about 1.8–2.2, because the chaotic signal has sub-audio wander. By design, the fuzz test's worst output peak is 1.99.
- Very bright patches lose some crest-factor headroom: the halfband filter's non-linear phase lets peaks reach 1.1–1.4 on bright single-carrier patches. The final limiter handles this.
- The clamp uses the envelope level at the end of each 16-sample block. During a 1 ms attack at high notes it can briefly lag by up to one block. I did not measure this separately; steady-state and decaying cases measure clean.
- The brightness ceiling (8 kHz) and the alias limits are fixed defaults, not patch parameters. A preset that wants harsh DX-style top octaves can only reduce it with negative key scaling, not exceed it.
- A retrigger re-runs the 1 ms attack, so it is exactly as sharp as a fresh note's onset (measured equal). A retrigger from a low sustain level is therefore an audible fast re-attack, as on a DX7; a longer op attack softens it.


## phys

Both engines are written and verified. phys.js is 1167 lines, noise.js is 201. Both are pure ES modules with no allocation after construction and use the Rng from util.js. In the project suite (`node tools/test.mjs --only purity,engines`) all 24 phys model/exciter combinations pass, as do tuning, purity and noise. One warning remains: plucked-string loudness compared with a sustained saw (see deviations).

PHYS 'string': a two-segment digital waveguide. The delay line is split at the pluck/bow point, so the pick-position comb comes out of the physics. In the bridge reflection path:
- a fractional allpass whose coefficient is solved exactly at f0 (η = sin((1−d)ω/2)/sin((1+d)ω/2)), with hysteresis, and its state re-seeded when the integer tap moves (so vibrato and glide don't click);
- a 4-stage stiffness-dispersion allpass cascade that is always in the loop, with a continuous coefficient. `inharm` 0.1 is nearly harmonic, 0.3 gives B≈4e-4 to 6e-4 (piano middle), 0.6 gives about 4e-3, and 1 is metallic (B≈1–2e-2);
- a one-pole loss filter designed from two points: T60 = `decay` at f0, and a brightness-dependent T60 near 3.2 kHz. Its DC gain is capped at ρ0^0.5 so low-frequency modes die with the note;
- an in-loop DC blocker (non-bowed only) whose gain and phase at f0 are compensated.
The phase delays of all these filters are subtracted at f0, so pitch comes out exact. Other string details:
- Pluck: the output is leakily integrated, which gives the physically correct 1/k plucked spectrum.
- Mallet: velocity-wave hammer, with contact time set by hardness and pitch.
- Bow: STK-style friction junction with a loss spectrum that is the same at every pitch. Tuning uses a 1/k-weighted mean over the harmonics, because stick-slip locks them together. Bow position and force are limited to a range where normal (Helmholtz) bowing starts reliably, found by sweeping C1–C7.
- Breath: filtered turbulence plus a jet tone locked to the fundamental, plus a little direct air noise.
- Stereo: two strings detuned by ±3.5 ct × `spread`, each excited at a slightly different point.
- Body: six parallel band-passes (guitar/koto-like: 98, 196, 282, 420, 1150, 2600 Hz).
- `damp` shortens T60 and darkens the tone on noteOff. There is also a pitch-tracking output DC blocker.
Every strike is normalised by running a scratch copy of the loop at noteOn to find its true peak.

PHYS modal (bar/bell/glass/membrane/plate): banks of 24–32 complex one-pole (coupled-form) resonators. Material ratio tables:
- bar: 16 flexural modes (tuned 1:4:10 at inharm 0, free-bar at 1) plus 8 torsional;
- bell: 14 church-bell partials (hum, prime, tierce, quint, nominal…), each as a split doublet so it beats;
- glass: 12 thin-shell modes n(n²−1)/√(n²+1), as doublets;
- membrane: 24 Bessel-zero modes; inharm 0 is the harmonic tabla tuning (after Raman), 1 is an ideal membrane / tom;
- plate: 32 rectangular-plate modes; inharm changes the aspect ratio.
Per-mode T60 = decay·ratio^−γ(brightness), with an air-damping term. Position weights come from real mode shapes (Bessel J_n for the membrane, sin·sin for the plate, free-bar shapes for the bar). Stereo comes from a per-mode radiation pattern × spread. Modes above 0.45·fs are skipped, and modes that have rung out below −140 dB are culled. The force is fed in differentiated, with per-mode compensation, which removes a sub-bass "thump" on strikes. A cheap pitch-only path rotates the poles under vibrato. Strike normalisation simulates the whole bank at noteOn. Bow and breath on modal models use a resonant drive at the fundamental plus noise whose output RMS is normalised analytically; bowing adds damping so the note speaks quickly. Resonator parameters are smoothed internally over about 12 ms, which fixed the project test's per-block random-modulation warnings (peaks had reached 3.8).

NOISE: white noise coloured by a true spectral tilt: 8 first-order shelving sections, coefficients interpolated from a table built per sample rate. Slope runs from −6 dB/oct at −1 (brown), through −3 dB/oct (pink) and flat at 0, to +4.8 dB/oct at +1. Every colour is RMS-normalised to the saw's 0.577. Colour and width are smoothed over about 15 ms. Width is a mid/side rotation of two independent white sources, preserving power. One-shot mode decays by −60 dB at `decay` seconds, and isActive() goes false once it has decayed.

SUGGESTED PHYS PRESETS (params are `phys.*`; each was checked at 48 kHz over the listed notes; "err" is fundamental pitch error, pk is peak):
1. Nylon Guitar {"model":"string","exciter":"pluck","hardness":0.35,"position":0.22,"decay":3.5,"brightness":0.45,"inharm":0.05,"body":0.55,"spread":0.25,"damp":0.6}. E2–E5: err ≤1.2 ct, pk 0.82–0.86, T60 2.5–3.7 s (varies with body/detune beating).
2. Koto {"model":"string","exciter":"pluck","hardness":0.78,"position":0.07,"decay":4.5,"brightness":0.72,"inharm":0.14,"body":0.35,"spread":0.35,"damp":0.45}. err ≤1.7 ct, pk 0.87–0.91, T60 4.5 s.
3. Concert Harp {"model":"string","exciter":"pluck","hardness":0.3,"position":0.85,"decay":6,"brightness":0.5,"inharm":0.04,"body":0.25,"spread":0.45,"damp":0.25}. C2–C6: err ≤2.2 ct, pk 0.81–0.92.
4. Felt Piano {"model":"string","exciter":"mallet","hardness":0.3,"position":0.2,"decay":7,"brightness":0.45,"inharm":0.32,"body":0.3,"spread":0.3,"damp":0.75}. err ≤1.4 ct, pk 0.88–0.97, stretched partials B≈5e-4.
5. Marimba {"model":"bar","exciter":"mallet","hardness":0.38,"position":0.9,"decay":1.3,"brightness":0.25,"inharm":0,"body":0.7,"spread":0.25,"damp":0.5}. A2–A6: err 0.00 ct, pk 0.95, T60 1.30 s.
6. Vibraphone {"model":"bar","exciter":"mallet","hardness":0.55,"position":0.85,"decay":6,"brightness":0.6,"inharm":0.04,"body":0.4,"spread":0.5,"damp":0.85}. err 0.00 ct, pk 0.95–1.01, T60 6.00 s.
7. Tubular Bell {"model":"bell","exciter":"mallet","hardness":0.72,"position":0.3,"decay":9,"brightness":0.55,"inharm":0.12,"body":0.2,"spread":0.6,"damp":0.25}. err ≤0.31 ct, pk 0.95–0.99.
8. Crystal Glass {"model":"glass","exciter":"mallet","hardness":0.85,"position":0.4,"decay":7,"brightness":0.8,"inharm":0.1,"body":0.1,"spread":0.7,"damp":0.3}. C5–G6: err ≤1.6 ct, pk 0.95–1.00.
9. Bowed Cello {"model":"string","exciter":"bow","hardness":0.4,"position":0.5,"decay":2.5,"brightness":0.55,"inharm":0.03,"pressure":0.6,"body":0.6,"spread":0.2,"damp":0.6}. C2–C4: err +0.6 to +0.8 ct, RMS 0.37–0.57, sawtooth (Helmholtz) spectrum, voice freed about 0.6–1 s after release.
10. Pan Flute {"model":"string","exciter":"breath","hardness":0.45,"position":0.5,"decay":1.4,"brightness":0.35,"inharm":0,"pressure":0.55,"body":0,"spread":0.15,"damp":0.8}. G4–C6: err ≤0.9 ct, pk 0.91–1.09, RMS 0.24–0.35.
Four more were also checked, all with no NaN:
- Kalimba {bar, pluck, hardness 0.62, position 0.15, decay 2.4, brightness 0.42, inharm 0.55, body 0.5}: pk 0.95.
- Singing Bowl {glass, bow, pressure 0.45, decay 12, inharm 0.2, spread 0.6}: err ≤0.75 ct.
- Tabla {membrane, mallet, hardness 0.62, position 0.35, decay 0.9, inharm 0.08, body 0.5}: err 0, T60 0.90 s.
- Gong {plate, mallet, hardness 0.3, position 0.3, decay 8, brightness 0.7, inharm 0.6, spread 0.8}: pk 1.3–1.46.
For all of these, pair with filter off or phys.filt 0, a long amp release (aenv.r ≥ 1–3 s) so `phys.damp` shapes the release, and some reverb.

### Deviations
No changes to params.js or util.js were needed. Design decisions to review:
1. Plucked-string loudness: strikes are normalised to peak ≈ ±1, as §4 phys requires. A plucked string has a high crest factor (14–23 dB) and decays, so the project test warns "phys loudness vs osc saw −15.8 dB RMS (default params, 1 s, note 60)". The ±3 dB RMS rule and the "peaks ≈ ±1" rule cannot both hold for a pluck. I kept the peak rule. Sustained exciters are matched to the saw: bow RMS is 0.35–0.5 against the saw's 0.577; breath is 0.2–0.45 depending on pressure. If you want plucks louder by default, the fix belongs in presets or a voice-level trim (for example +6 dB), not in peak normalisation.
2. The bow's working range is narrowed on purpose. On the string with the bow exciter, `position` maps to bow point β = 0.175–0.19, and `pressure` maps to friction slope 1.2–0.8 (i.e. bow force). Sweeps showed the friction model falls out of normal bowing (Helmholtz) near the 1/5 and 1/6 points and at higher slopes. Pluck and mallet use the full range, β = 0.03–0.5.
3. Breath includes a quiet "jet" tone locked to the resonator's fundamental, on top of the filtered noise. Without it the pitch of noise-driven flute sounds wandered ±8 ct; with it the error is ≤1 ct.
4. `body` on modal models raises the amplitude of modes near the fundamental (tube/shell warmth). It does not add a separate resonator or lengthen T60; the fundamental's T60 always equals `decay`. On the string, `body` is the six-band-pass guitar/koto body.
5. On bow and breath, the continuous exciters' fade-in time comes from `hardness`. `pressure` is ignored by pluck and mallet.
6. Pitch is clamped: the string fundamental to 16 Hz…0.2·fs, modal fundamentals to 20 Hz…0.45·fs.
7. Velocity raises effective hardness (h + 0.35·(vel − 0.6)) and so brightness. It does not change amplitude, which the voice applies.

### Known issues
- Bowed string at the extremes: bowing at E1 and below sometimes fails to lock into normal bowing (2.9% of a 594-case sweep, mostly the lowest note, some at the top), and bowed pitch above about C7 can be off by 3–8 ct. From C2 to C6, bowed pitch is within ±3 ct.
- Bell and glass doublets beat by design, so the peak can rise to about 1.2 after the onset; the plate with high inharm and spread reaches about 1.46. The noteOn normalisation only covers the first max(1.5 periods, 10 ms).
- String T60 measured through a single frequency band reads 2.5–3.7 s for a 3.5 s setting when spread and body are on, because the two detuned strings beat and the body colours the band. With spread 0 and body 0 it is exact (3.00 s against 3.00 s).
- Breath on modal models at low notes (C2) is mostly noise-driven, so a spectral-peak pitch estimate wanders ±15–35 ct. The modes themselves are tuned exactly.
- Changing bow position mid-note moves the integer split point by a sample at a time; with the narrow bow range these steps are rare and small. Changing the model mid-note restarts the new resonator silent until the next note.
- The project test still warns on plucked-string loudness vs a sustained saw; this is the peak-normalisation trade-off in deviation 1.


## filter

I wrote src/dsp/filter.js (865 lines). All filter types pass the stability, NaN, allocation, click and accuracy tests. One target is missed: the 2× oversampled ladder costs about 85 ns per sample per channel, against the ~60 ns ideal. It supports 44.1/48/96 kHz and also ran clean at 22.05, 32 and 192 kHz.

**Filter types**
- **ladder24 / ladder12:** a nonlinear zero-delay-feedback transistor ladder (Voipio/mystran "cheap non-linear ZDF"), 2× oversampled below 88.2 kHz.
  - Each stage has a tanh nonlinearity (a bounded [5/4] Padé), evaluated at the previous state; the resulting linear system is then solved exactly, so there is no unit delay in the feedback loop.
  - Resonance maps to feedback as k = 4.4·res^1.25, so self-oscillation starts at res ≈ 0.93. Self-oscillation amplitude is stable and bounded (≈0.33 at res = 1) and very pure (3rd harmonic below −48 dB). A measured cutoff correction past k = 4 keeps its pitch within ±0.1% from 55 Hz to 16 kHz.
  - Bass-loss compensation restores 62% of the passband loss (passband is −3.1 dB at res 0.9). Drive goes up to +18 dB, with a makeup curve that keeps loudness roughly steady (+6 dB makeup at full drive).
  - ladder12 takes stage 2 as output while resonance still loops over all 4 stages; it gets a 1/(1+0.12k) level trim to match ladder24.
  - The 2× resampling uses 6-coefficient polyphase halfband filters (flat to ~22 kHz at 48k, ≥85 dB rejection).
  - To use the processor well, the L and R channels run interleaved in one loop.
- **lp / bp / hp / notch:** a Simper/Cytomic trapezoidal state-variable filter. Q runs from 0.5 to 25 exponentially.
  - Bandpass peak gain is √(2Q/0.707). A soft limiter on the band state (transparent at small signals) keeps resonant peaks bounded like an analog filter.
  - Drive is a tanh pre-saturation with loudness compensation that is continuous down to drive = 0.
- **formant:** 5 parallel bandpass filters using the classic bass/tenor/alto/soprano formant tables, morphing A-E-I-O-U.
  - Cutoff sets "voice size": it blends bass (354 Hz) → tenor (1 kHz) → alto (2.8 kHz) → soprano (8 kHz) and also shifts all formants by 0.2 octave per octave of cutoff.
  - Resonance narrows the bandwidths (1.5× down to 0.3× the table values).
  - Adjacent formants alternate polarity (Klatt-style); of the 16 fixed patterns tested, this gives the shallowest valleys between formants.
  - A power normalisation keeps vowels within about ±3 dB of each other at low and medium res.
- **comb:** a feedback comb with 4-point Hermite fractional delay, tuned to the cutoff in Hz.
  - Feedback = 0.98·√res. A damping lowpass sits in the loop, and drive adds tanh saturation in the loop plus a safety ceiling.
  - Input DC is removed before the loop (5 Hz) and only a 0.5 Hz blocker is inside it; the loop delay compensates the phase of both. This keeps the fundamental within ±0.6 cents.

**Behaviour shared by all types**
- Cutoff is interpolated exponentially across each block; res, drive and gains ramp linearly.
- Changing filter type crossfades over 5 ms (smoothstep), and within a family it crossfades the outputs, so there are no clicks.
- Denormals are flushed and NaN states reset at block ends; the comb's Float32 delay line is guarded against NaN, Inf and denormals.
- Nothing is allocated per block. V8 boxes decimal numbers passed between non-inlined functions, so all internal block parameters travel in preallocated Float64Arrays.

**Other exports**
- **SVFilter** is the same state-variable core with 5 ms mode crossfades and cutoff/res smoothing between calls.
- **filterResponse** returns the exact small-signal response of each structure for the UI curve. Measured outputs match it to ≤0.02 dB, apart from the comb's upper peaks (see known issues).

### Deviations
- **Constructor:** `VoiceFilter` takes an optional second argument `{ oversample: 1 | 2 }`. `new VoiceFilter(sampleRate)` behaves as the spec says. Passing 1 roughly halves ladder cost at 44.1/48k (≈42 ns per sample per channel) at the price of more aliasing when driven (inharmonic content at drive 0.5 goes from ≈ −50…−56 dB to ≈ −36…−42 dB).
- **Ladder drive ceiling:** full drive is +18 dB rather than anything higher. +24 dB aliased badly even at 2× (about −35 dB inharmonic content); +18 dB measures ≈ −40…−48 dB.
- **filter2 mapping (for the voice owner):** `SVFilter` uses the spec's modes (0 lp, 1 hp, 2 bp, 3 notch). `filter2.type` options are ['off','lp','hp','bp','notch'], so the voice should skip `SVFilter` when the type is 'off' and otherwise pass mode = type − 1.
- **`filterResponse` extras:**
  - `type` also accepts the id string.
  - Ladder resonance is drawn as a finite peak (k capped at 3.96), visually softened by drive as k/(1+0.35·drive).
  - Drive is otherwise ignored except for the comb's makeup gain.
- **Buffers:** `bufL` and `bufR` must be different arrays (in-place stereo processing).
- **params.js / util.js:** no changes needed.
- **Allocation (for the voice owner):** V8 boxes decimal-number arguments at non-inlined call sites, so the voice's own call to `filter.process(... cutoff0, cutoff1, res, drive, vowel)` may create small garbage per call. That is outside this module; the module itself allocates nothing.

### Known issues
- Ladder CPU is above the ~60 ns/sample/channel ideal. The 2x ladder measured about 85 ns/sample/channel (about 13% of one core for 16 stereo voices at 48k). The machine was heavily loaded during all timing (load average 40-130), so treat absolute numbers as approximate; the baseline SVF kernel measured 3.9 ns in the same run. At 96k (no oversampling) the ladder is about 42 ns. Tried and rejected: [7/6] Pade (about 30% slower), a clamped [3/2] ratio (no cheaper), batch inversion (slower), reusing stage gains on the 2nd oversampled tick (only 5-9% faster, and self-oscillation drifted +0.36% at 8 kHz).
- Heavily driven, bright ladder settings still alias at 2x: inharmonic content is about -31 to -48 dB at drive 1 (for 882-3523 Hz notes at 8-20 kHz cutoff). A high note well above a very resonant, driven cutoff (3.5 kHz note, 3 kHz cutoff, res 0.9, drive 1) measures -17.5 dB, which is mostly the nonlinear filter's own inharmonic oscillation rather than aliasing.
- SVF lp/hp at high res is louder than the ladder: about +4.6 dB RMS on a saw at res 0.9, peaking around 2.1. The band-state limiter bounds it (a 1 kHz sine at amplitude 1 into Q 25 gives about 2.3-2.8 out instead of 25 linear).
- Comb UI curve differs from the real output by up to 2.5 dB at the upper harmonic peaks when the comb is pitched high (e.g. 5 kHz), because the Hermite interpolation loss isn't modelled. Fundamentals match within 0.3 dB. The comb's upper harmonics sit up to about 3 cents flat at 41 Hz (loop DC blocker dispersion); fundamentals are within ±0.6 cents (7 kHz: -2.8 cents).
- Parallel formant summing still leaves some deep valleys between formants for certain vowel/voice-type combinations (inherent to parallel formant synthesis; the alternating polarity was the best of the 16 fixed patterns tested). Vowel loudness spread grows to about ±5 dB at res 0.9, when narrow formants fall between harmonics.
- Self-oscillation started from exact silence at very low cutoff (e.g. 55 Hz) takes over a second to build up (growth rate is proportional to cutoff); any input signal starts it immediately.
- Switching to a filter type from a different family resets that family's state and fades it in over 5 ms (no stale ringing, but the new filter starts from rest). Switching again during a fade drops the older fading-out filter abruptly (rare).


## fx

I built the complete FX section from ARCHITECTURE.md §7. Everything is pure ES modules: deterministic, no dependencies, no allocation while running (the project's own test runner measures FxChain at 2 bytes per 128-sample block, down from 1458), and each effect uses no CPU when it is off and idle.

- **FxChain.** Runs drive → chorus → phaser → delay → reverb → eq → comp, working in place in chunks of up to 32 samples so parameter smoothing is independent of the host block size. The chain decides which effects to call, so an effect that is off and idle is never called.
- **Reverb (the centrepiece).** A 16-line modulated feedback delay network:
  - Hadamard mixing (fast Walsh–Hadamard transform), 4-stage allpass input diffusion per channel with lengths scaled by size, and a smoothed pre-delay of up to 250 ms.
  - Early reflections (12 per channel) read from the diffused signal; their times scale with size and their envelope follows the decay.
  - Line lengths span one octave (16–144 ms base × 1–2). Each line has its own sine plus smooth-random delay modulation and a per-line absorption shelf, so T60 equals `reverb.decay` in the low-mids and damping sets how much faster the highs decay.
  - Stereo comes from two orthogonal sign patterns over the line outputs (L/R correlation below 0.03), plus mid/side width.
  - Shimmer is an octave-up pitch shifter with two crossfaded grains, placed inside the feedback loop on 4 lines. Each shifter has a different grain length and an anti-alias low-pass in front. The lines switch on one after another as `reverb.shimmer` rises.
  - The loop is stable by construction: orthogonal mixing, per-line gains below 1, cubic (Hermite) reads with gain ≤ 1, and shimmer compensation capped so its gain times the largest line gain stays ≤ 0.998. A last-resort energy guard never engaged in any test.
  - Long decays get louder by only half the dB difference, and room size is level-compensated. Turning the reverb off only closes its input, so the tail rings out naturally and the module then goes idle.
- **Delay.** Tempo sync uses `divToBeats` and bpm; `sync = off` uses `delay.time`. The feedback path has tone filters (1-pole high-pass, 2-pole low-pass, both darker as tone goes to 0) and gentle saturation. Tape wobble combines wow (0.55 Hz), flutter (7.3 Hz) and random drift. Time changes glide like tape: one-pole smoothing plus a rate limit of 0.45. Ping-pong cross-feed is an energy-preserving rotation. Turning it off gates only the input, so echoes ring out, then it idles and clears.
- **Chorus.**
  - `chorus`: 2 voices per channel with quadrature LFO phases.
  - `ensemble`: 3 taps per channel at 120° driven by slow + fast LFOs, with an 8.5 kHz 2-pole low-pass on the wet.
  - `flanger`: short swept delay with damped, DC-blocked, soft-clipped feedback.
  - All reads are cubic Hermite. On switch-on the delay line fills for 24 ms before the wet fades in; mode changes dip the wet for 10 ms.
- **Phaser.** 4/6/8/12 first-order allpass stages, exponential sweep from 200 Hz to 8 kHz, quadrature L/R, and DC-blocked, soft-limited feedback. Changing the stage count dips the wet briefly.
- **Drive.**
  - soft, tube and fold run at 2× oversampling; crush reduces bit depth and sample rate.
  - The oversampling filter was designed at construction and measured at over 100 dB image rejection, with the passband flat to 22 kHz.
  - The dry signal goes through an identical filter pair so dry/wet blends stay phase-aligned.
  - Loudness compensation combines a static per-type/amount table with a slow adaptive correction.
  - Also: ±8 dB tilt tone, 8 Hz DC blocker, mix, and click-free (smoothstep) on/off and type switching.
- **EQ.** Standard RBJ biquads: low shelf 120 Hz, peak at `eq.midfreq` with Q 0.9, high shelf 8 kHz. Flat bands are skipped with bit-exact output, and the chain doesn't call the EQ at all when every gain is 0 dB.
- **Comp.** Stereo-linked glue compressor using the higher of an RMS and a peak-envelope detector. It has an 8 dB soft knee, ratio 1→3.5 and threshold −6→−20 dBFS rising with amount, 12 ms attack, a two-speed release, and auto makeup. Amount 0 is a bit-exact bypass.
- **Limiter.** Look-ahead peak limiter:
  - Peak detection includes a half-sample estimate between samples (8-tap windowed sinc).
  - The gain moves through a 2 dB soft knee, a sliding-window minimum, a 90 ms release and a box filter as long as the look-ahead, so it reaches each peak's required gain by the time that peak is output.
  - A final clamp at the ceiling and NaN/Inf cleanup mean the output can never exceed the ceiling.

### Deviations
No changes to params.js or util.js; no changes to them are needed.
1. **Extra file.** I added src/dsp/fx/common.js (shared helpers) inside my own fx/ directory.
2. **Per-effect call signature.** Individual effects take an offset: process(L, R, off, n, eff). That lets FxChain run in 32-sample chunks without creating subarrays. FxChain itself matches the spec exactly.
3. **Delay tempo.** Delay gets its tempo from a `delay.bpm` field that FxChain sets every block, instead of a per-chunk argument; passing bpm as an argument would allocate a boxed number on every call. Delay.process also accepts an optional 6th bpm argument.
4. **Limiter extras.** It accepts an extra `releaseMs` option (default 90), an optional 4th `off` argument, and a `latency` getter. Look-ahead is at least 5 samples.
5. **Ping-pong at 100%.** Ping-pong cross-feed is an energy-preserving rotation. A linear crossfade lost 3 dB per repeat on decorrelated stereo input, so pingpong 0.5 decayed like much lower feedback. At pingpong = 1 the polarity flips on every other bounce.
6. **Shimmer shortens long decays.** Shimmer is stable by construction, and the cost is that at shimmer = 1 the effective T60 is capped at about 10 s even when decay is 30 s. At shimmer 0.5 it is about 18 s.
7. **Mix laws.**
   - Delay and reverb use a send-style law: dry stays at unity up to mix 0.5, wet reaches unity at 0.5.
   - Chorus and ensemble use (1−m)^0.75 / m^0.75, between linear and equal-power.
   - Flanger, phaser and drive use a linear crossfade.
8. **What `reverb.decay` means.** It sets T60 at low and mid frequencies; `reverb.damp` shortens the high-frequency T60 and lowers the input bandwidth.
9. **EQ start-up.** The EQ starts flat, so the first non-zero gain after construction or a patch change glides in over about 30 ms. After reset() it snaps straight to the target values.
10. **tailActive().** Delay and reverb report false once they have been silent for their full loop length; drive, chorus and phaser count only while their input has been non-silent within the last 0.5 s.

### Known issues
- Limiter output never exceeds the ceiling as a sample value, but its true-peak control is approximate (it only checks half-sample points): worst measured +0.16 dBTP on a full-scale 11 kHz sine and +1.8 dBTP on white noise pushed +10 dB into limiting; musical material such as a saw measured +0.04 dBTP.
- Shimmer at 1 caps the effective reverb T60 at about 10 s, even with decay 30 s. This is the cost of the stable design. A pure tone through the grain-based pitch shifter also picks up sidebands at the grain rate; using four different grain lengths smooths this out in dense reverb tails.
- Drive auto-gain: a sudden big amount change (for example 0.3→1) can make loudness overshoot or dip by ±2–4 dB for about 0.3 s while the adaptive correction settles. Steady-state level stays within about 1.5 dB.
- Delay time and sync changes glide like tape at a limited rate (0.45). Big jumps such as 1/16→1/2 take roughly 1–2 s to settle, with a pitch sweep; there is no crossfade mode for time changes.
- Reverb size changes glide over about 0.25 s, so sweeping size produces tape-like pitch artifacts.
- Chorus/flanger start with a 24 ms delay after being switched on (the line fills before the wet fades in).
- When the delay goes idle it clears its buffer once: 2×2^18 floats at 48 kHz, roughly a 0.1 ms spike. The reverb does the same with about 1–2 MB when it goes idle.
- JIT warm-up: the reverb's large process function runs slower until V8 optimises it, typically in the first 0.5–1 s after it starts. Under heavy machine load I saw several hundred µs per block during that period, which is still within the 2667 µs budget.
- Timing numbers are noisy on this shared machine (load averages of 7–57 while other engineers ran tests; the process can also land on efficiency cores). The CPU figures I report are the minimum/median of repeated runs.
- The project test suite's only failure in the suites I ran is a missing index.html. That file belongs to the UI engineer, not the FX module.
