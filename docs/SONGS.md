# Demo songs 示範歌曲 — format, helpers, mixing and engine

AURORA plays multi-part demo songs: every part is a **full Synth** with its own factory preset (engines, filter,
modulation, macros **and** FX chain), all parts are clocked sample-synchronously, and the mix is added on top of the
user's own synth — so the user can **play along** on the keyboard (or turn knobs) while a song runs.

```
src/demo/songs/<id>.js   one song definition per file (default export)     ← song composers
src/demo/songs/index.js  SONGS (display order), songById(id)
src/demo/songlib.js      composition helpers (pure functions → sequencer events)
src/demo/resolve.js      resolveSong(def, PRESETS) → engine-ready song · validateSong · songDuration
src/dsp/ensemble.js      Ensemble (the song engine) + SafetyBus (limiter on the final sum)
src/worklet/processor.js songLoad / songPlay / songStop / songQueue / songPart messages
src/ui/audio.js          audio.songLoad(def) … · state.song
tools/render-song.mjs    offline render → WAV + spectrogram + metrics (mixing work)
```

Quick loop for composers:

```bash
node tools/render-song.mjs --list
node tools/render-song.mjs --song neon-nights            # renders/songs/neon-nights/{.wav,-spectrogram.png,.json}
node tools/render-song.mjs --song neon-nights --solo lead
node tools/render-song.mjs --song neon-nights --beats 32  # only the first 8 bars (fast check of a long song)
node tools/test.mjs --only songs                          # validates + renders every song, checks the engine
node tools/test.mjs --only songs --quick                  # same, first 8 bars of each song only
```

---

## 1. Song definition

```js
// src/demo/songs/neon-nights.js
import { chords, bassline, drums, melody, repeat, merge, humanize, macroRamp, bars } from '../songlib.js';

export default {
  id: 'neon-nights',                 // unique, kebab-case, = file name
  title: 'Neon Nights',              // English title
  zh: '霓虹夜色',                     // 中文標題 (shown first in the UI)
  genre: 'Synthwave', zhGenre: '合成器浪潮',
  description: 'A 小調的八〇年代夜間公路…',   // zh, one or two sentences
  descriptionEn: 'An 80s midnight highway…',   // optional: shown when the UI is in English
  bpm: 100,                          // 40–240 (the user's synth follows the song tempo while it plays)
  key: { root: 'A', scale: 'minor' },  // suggests the scale lock for play-along (scale ids of params.js SCALES)
  lengthBeats: 32,                   // one pass (quarter-note beats)
  loop: true,                        // false → the song ends after one pass (tails ring out, then it stops)
  cover: { colors: ['#ff6bd6', '#a78bfa', '#5cf2ff'] },   // 3 hex colours for the song card / visuals
  sections: [{ beat: 0, name: 'Cruise', zh: '巡航' }, { beat: 16, name: 'Skyline', zh: '天際線' }],
  parts: [
    { name: 'Kick', zh: '大鼓', role: 'drums', preset: 'Anvil Kick', gain: -2.5, pan: 0, events: kick },
    { name: 'Bass', zh: '貝斯', role: 'bass', preset: 'Rubber Pulse', gain: 0, events: bass },
    { name: 'Pad', zh: '鋪底', role: 'pad', preset: 'Velvet Dusk',
      params: { 'voice.poly': 6, 'reverb.mix': 0.3 },   // overrides on top of the preset (native units)
      macros: [0.2, 0.5],                              // initial macro values (macro1, macro2, …) 0..1
      gain: -6, pan: -0.2, events: pad },
    // … up to 8 parts
  ],
};
```

| field | required | notes |
|---|---|---|
| `id`, `title`, `zh` | ✓ | `zh` is the primary UI label (UI text is zh-TW first, English sub-label) |
| `genre`, `zhGenre`, `description`, `descriptionEn` | | `description` in Chinese; `descriptionEn` (optional) is shown in the English UI |
| `bpm` | ✓ | 40–240 |
| `key` | | `{root: 'C'…'B' (#/b ok), scale}`; scale = a scale-lock option: `major minor dorian mixolydian pentMajor pentMinor blues harmMinor inSen wholeTone` |
| `lengthBeats` | ✓ | events at `beat ≥ lengthBeats` never play; notes may ring past the end |
| `loop` | | default `true` |
| `cover.colors` | | 3 hex colours |
| `sections` | | `[{beat, name, zh}]` — shown live in the UI (`state.song.section`) and marked in renders |
| `parts` | ✓ | 1–8 parts (`SONG_MAX_PARTS`) |

### Parts

| field | notes |
|---|---|
| `name`, `zh` | unique `name` (mixer label; also how `songPart('Bass', …)` finds it) |
| `role` | `pad bass lead drums arp keys fx` — UI icon/colour and mixer grouping |
| `preset` | **exact factory preset name** (`node tools/render.mjs --list`). Unknown → `resolveSong` throws. An array = candidates, first existing wins |
| `fallback` | optional category id (`pad`, `drum`, …): used only if no candidate exists (a warning is recorded). Placeholders only — final songs use exact names |
| `params` | param overrides (ids from `src/dsp/params.js`, native units; enums by option id). `voice.poly` caps are the main CPU tool |
| `macros` | initial macro values `[m1, m2, m3, m4]` (0..1); the preset's macro *definitions* are kept |
| `gain`, `pan` | part fader in dB (−60…+12, 0 = preset level) and balance (−1…1) |
| `events` | sequencer events (below), beats |

Global-scope params do not belong to parts: tempo is the song's `bpm`, master volume is the user's. `scale.root` /
`scale.type` in a part's `params` are allowed (they apply to that part only — e.g. to snap a generated line); a part
without them always plays unlocked, even on a part synth that a previous song had locked.

### Events (src/dsp/sequencer.js, ARCHITECTURE §6)

```js
{ beat, type: 'on', note, vel /*0..1*/, dur /*beats*/ }     // notes go through the part's scale lock → chord → arp
{ beat, type: 'off', note }
{ beat, type: 'param', id, value }                          // native value
{ beat, type: 'ramp', id, to, beats[, from] }               // linear in normalised space (Hz/seconds sweep musically)
{ beat, type: 'macro', index /*0..3*/, value /*0..1*/ }
{ beat, type: 'ramp-macro', index, to, beats }
```

* Automation is restored when the song stops (and at the top of each queued segment the part starts from its patch).
* A preset with the **arpeggiator on** (most `arp` presets) plays *held chords* in tempo: give it sustained chord
  notes (`chords(…)`) and let the preset's arp do the rhythm.
* **Drums**: the factory drum presets are *single instruments* (kick, snare, clap, hats, ride, tabla, taiko, …), so a
  groove uses one part per instrument. They sit on GM keys: kick C2 (36), snare D2 (38), clap D♯2 (39), closed hat
  F♯2 (42), open hat A♯2 (46), ride D♯3 (51) — see each preset's description for its sweet spot. `songlib.GM` maps
  names → notes.

---

## 2. Composition helpers — `src/demo/songlib.js`

Pure functions returning event arrays in beats (sort/merge freely). Deterministic: no `Math.random` (use `rngOf(seed)`).

### Notes, keys, scales

```js
midi('C#4') // 61   (C4 = 60; also 'Bb3', 'E♭5', 'Cb4', numbers pass through) — alias: note()
noteName(61) // 'C#4'   noteName(61, { flats: true }) // 'Db4'
pc('F#') // 6
keyOf('D dorian') / keyOf('F#m') / keyOf({ root: 'A', scale: 'minor' })   // → {root, scale, pc, steps}
degree('D dorian', 0, 4) // 62 — 0-based scale step in octave 4; 7 = next octave, -1 = below
scaleNotes('C pentMajor', 'C4', 'C5') // [60, 62, 64, 67, 69, 72]
snap(61, 'C major') // 60 (nearest, ties down — like the synth's scale lock)
SCALES  // major minor dorian phrygian lydian mixolydian locrian harmMinor melMinor pentMajor pentMinor blues
        // inSen hirajoshi yo wholeTone gong shang jue zhi yu (Chinese pentatonic modes) chromatic
```

### Chords, voicing, progressions

```js
chord('Am7')                          // [69, 72, 76, 79]  (root in octave 4, close voicing)
chord('Fmaj7', { octave: 3, inversion: 1, voicing: 'drop2' })   // voicing: close | open | drop2 | spread | shell
chord('C/E')                          // slash bass below: [52, 60, 64, 67]
chord('G', { bass: true })            // + root an octave below the voicing
chordRoot('F#m7b5', 2)                // 42
parseChord('Bbmaj9')                  // {root, quality, intervals, bass}
// qualities: '' m dim aug sus2 sus4 5 6 m6 69 7 maj7 m7 mMaj7 dim7 m7b5 ø 7sus4 aug7 9 maj9 m9 add9 madd9 11 m11 13
//            maj13 7b9 7#9 7#11 maj7#11 … (CHORD_QUALITIES)

voiceLead(['Am9', 'Fmaj7', 'C', 'G6'], { range: ['A3', 'E5'] })  // smooth voicings (min total movement)
progression('Am7 F | C:2 G:2 | % | .')  // [{symbol, beat, beats}] — ':beats', '%' repeat, '.' rest, '|' ignored

chords('Am9 Fmaj7 C G6', { vel: 0.6, range: ['F#3', 'D5'] })            // sustained, voice-led chords
chords('Fmaj7 Em7 Dm7 Cmaj7', { rhythm: 'x.....x.x.......', step: 0.25, drop2: true })   // comping rhythm
chords('Am F C G', { strum: 0.03, gate: 0.9, bass: 2 })                   // strummed, + root in octave 2
bassline('Am F C G', 'x..xo.f-', { octave: 2, step: 0.5 })
// pattern: x root · X accent · o octave · O accented octave · f fifth · 3 third · 7 seventh · . rest · - tie
```

### Rhythm, melody, arpeggios

```js
steps('x..X|o.3-', { note: 'C2', step: 0.25 })
// x hit · X accent · o ghost · 1–9 velocity 0.1–0.9 · . rest · - tie · spaces and | are bar lines
drums({ kick: 'x...x...x...x...', hat: '..x...x...x...x.' }, { vel: { kick: 1, hat: 0.5 } })   // GM names (GM map)
drums({ C2: 'x.......', G2: '....x.x.' })                                                          // or note names
melody('E5 - D5 C5 | A4 - - . | G4! A4 C5 D5? | ~E5 ~D5 C5 -', { step: 0.5 })
// tokens: note names · '.' rest · '-' hold · suffix ! accent / ? soft · prefix ~ legato (overlaps for mono glides)
melody("1 3 5 1' | 6, - 5, -", { key: 'D pentMajor', octave: 4 })     // scale degrees (1-based), ' up / , down
arpeggiate(['A3', 'C4', 'E4'], { pattern: 'updown', rate: 0.25, beats: 4, octaves: 2 })
// patterns: up down updown downup converge random [indices]; accentEvery, gate, vel, seed
```

### Transforms & structure

```js
repeat(bar, 8, 4)            // 8 copies, 4 beats apart
loopTo(pattern, 2, 16)       // fill 16 beats with a 2-beat pattern (last copy cut)
merge(a, b, c)               // concat + sort
shift(ev, 4) · transpose(ev, 12) · velocity(ev, 0.8 | (v, e, i) => …) · legato(ev, 1.2) · clip(ev, 0, 16)
humanize(ev, { timing: 0.01, velocity: 0.06, seed: 3, swing: 0.2 })   // deterministic; swing delays odd 16ths
param('filter.cutoff', 800, 0) · macro(1, 0.5, 8)
ramp('filter.cutoff', 400, 4000, 0, 16)       // param at `from`, then ramp over 16 beats
macroRamp(0, 0.2, 0.8, 0, 32)
automate('reverb.mix', [[0, 0.1], [16, 0.4], [32, 0.2]])   // piecewise linear; { macro: 2 } for macros
bars(8) // 32

const A = arrange([
  { name: 'Intro', zh: '前奏', bars: 4, parts: { pad: padIntro } },
  { name: 'Theme', zh: '主題', bars: 8, parts: { pad: padLoop, bass: s => loopTo(bassBar, 4, s.beats) } },
]);
// A.tracks.pad / A.tracks.bass (absolute beats) · A.sections · A.lengthBeats → drop into the song definition
```

---

## 3. Mixing & loudness

Render with `node tools/render-song.mjs --song <id>` and read the summary (also in the `.json`):

* **Mix**: integrated **−16 … −13 LUFS** (quiet/ambient songs down to −18), sample peak **≤ −1 dBFS before the safety
  limiter** (`pre-limit`). The SafetyBus (ceiling −0.3 dBFS) is a safety net: `limiter` should stay above −1 dB.
  The song follows the user's master volume, and the user's own synth plays on top — leave headroom.
* **Parts** (post fader): lead/bass/keys/pad typically −24 … −18 LUFS each; kick −22 … −18; hats −36 … −30.
  One bass-register part at a time; high-pass pads with `filter2`/`eq.low` if the low end gets muddy.
* **Sections**: per-section LUFS shows the arrangement's dynamics (intro quieter than the chorus is good).
* Spectrogram (`-spectrogram.png`, section markers) — look for masking, harsh 2–5 kHz build-ups, empty spectrum.
* `--solo <part>` / `--parts kick,bass` render subsets (the other parts are listed as `(muted)`); `--stems` writes
  every part's post-fader WAV; `--beats N` renders only the first N beats; `--loops 2` checks the loop seam.
* The `cpu` column is each part's share of one core (thread CPU time, whole render incl. tails) — the place to look
  when a song is too heavy.

## 4. CPU budget (the browser has to render every part in real time)

Each part is a full synth: a sounding voice costs ≈1–1.7 % of an M-series core (Node), an active FX chain ≈0.5–3 %
(a reverb alone ≈1–3 %); Chrome's AudioWorklet costs ≈1.3–1.5× Node. Measured with the placeholder songs (5–7 parts,
final presets), on top of whatever the user plays:

| where | load |
|---|---|
| Node, relative | 0.9–1.3× the CPU of ARCHITECTURE §11's "worst realistic patch" (12 voices, ≈8× real time) → ≈11–16 % of an unloaded M5 core (6–9× real time) |
| Chrome AudioWorklet, bare page (M5, lightly loaded) | median 14–26 %, max 20–31 % of the render budget |
| Chrome, full app (headless = software WebGL visuals competing) | 57–77 % max; the governor below engaged once |
| Node on a heavily loaded machine (load avg 30–100) | 28–62 % of a core (1.6–3.6× real time) |

Relative part costs: unison + FM bells (Frost Lantern) and unison + bowed-phys strings (Aurora Symphony) cost ≈5× a
mono bass (≈14–16 % vs ≈3 % of a core on the loaded machine).

* **Budget: ≤ 32 voices sounding at once over all parts** (`voices peak` in render-song; `npm test` warns above 32,
  fails above 48). Pads with 5-note chords and long releases overlap into 10–12 voices: cap them with
  `params: { 'voice.poly': 6–8 }` and prefer 4-note voicings (`drop2`, `shell`).
* Parts that rest cost nothing once their FX tails end (idle bypass). Heavy presets: big unison pads, FM + unison
  keys, phys strings with long decay, shimmer reverbs.
* Safety net: while a song plays, the worklet caps every part's polyphony when the measured render load exceeds 72 %
  (`state.song.voiceCap`: 8 → 6 → … ≥ 2) and relaxes it again — a thinner sound instead of dropouts on slow machines.

## 5. Engine & API

### Browser (`src/ui/audio.js`)

```js
import { SONGS } from '../demo/songs/index.js';
audio.songLoad(SONGS[0]);        // definition → resolved against PRESETS here (throws on unknown presets/params)
audio.songPlay();                // starts on the next render quantum once the parts are ready (≈10–100 ms)
audio.songQueue(SONGS[1]);       // seamless: starts exactly at the end of the current loop (or now when stopped)
audio.songPart('Bass', { gain: -3, mute: false, solo: false, pan: null });  // gain = trim dB on top of the song's
audio.songStop();                // release notes, tails ring ≈1.5 s then fade; songStop(true) = fade in ≈8 ms
audio.getState().song            // ≈30 Hz, see below; audio.getSongState() is a shortcut
```

`state.song`:

```js
{ playing, beat, lengthBeats, loop, bpm, section /* {beat, name, zh} | null */, sectionIndex,
  id, title, zh, loaded, pending /* waiting for parts / preparing */, queued /* id | null */, ending,
  built /* part synths constructed */, maxParts, voiceCap,
  parts: [{ index, name, zh, role, peak /* post-fader since last state */, notes /* sounding MIDI notes */,
            mute, solo, gain /* trim dB */, active }] }
```

* The user's synth keeps its own patch, notes and controls; while a song plays it runs at the song's tempo (arp,
  synced LFOs/delays lock to the song) and its previous tempo is restored on stop. For play-along, suggest
  `scale.type`/`scale.root` from `song.key`.
* Panic (`allNotesOff(true)`) also stops the song.
* Worklet messages: `{type:'songLoad', song}`, `{type:'songPlay'}`, `{type:'songStop', hard}`,
  `{type:'songQueue', song}`, `{type:'songPart', part, gain, mute, solo, pan}` (engine-ready songs only — `audio.js`
  resolves definitions before posting).

### Engine (`src/dsp/ensemble.js`)

```js
const ens = new Ensemble(sampleRate, { maxParts: 8 });   // part Synths are built lazily (see below)
ens.load(engineSong); ens.play(); ens.queue(next); ens.stop(hard);
ens.setPart(i | name, { gain, mute, solo, pan }); ens.setVoiceCap(n);
ens.process(L, R, n);            // ADDS the mix into L/R (allocation-free)
ens.playing · ens.beat · ens.active · ens.built · ens.getState()
const bus = new SafetyBus(sampleRate); bus.engaged = ens.active; bus.process(L, R, n);   // final-sum limiter
ens.tap = (partIndex, L, R, n, offset) => …;   // offline: post-fader stems · ens.profile = () => ms → slot.cpuMs per part
```

* **Sync**: every part is a Synth whose sequencer plays the part's events; all parts start on the same sample and
  advance with bit-identical beat arithmetic on the shared 16-sample control grid (tested: parts are bit-identical
  with odd host block sizes, looping, tempo 97.3).
* **Part pool**: a Synth costs ≈2–6 ms to construct on an idle M5 (20 voices + FX chain; 4–30 ms measured on a busy
  machine; `loadPatch` ≈0.1 ms, a song message ≈0.1–0.4 ms to parse), more than one render quantum, so parts are
  built one every 6 render quanta while the user's synth is silent (≈150 ms after audio starts), or — when a song
  waits for parts — every 3 quanta. `load()` waits until enough parts exist; parts are reused across songs
  (`loadPatch`, at most one per quantum while preparing; a queued song pre-loads free parts before the boundary).
  Memory ≈4 MB per part.
* **Queue**: parts with an identical patch keep playing on the same synth across a switch (tails continue); dropped
  parts ring out ≈8 s then fade. Mixer settings carry over for parts with the same name.
* **Stop**: notes are released, tails ring `stopHold` (1.5 s), then fade over `stopFade` (1 s). A one-shot song
  (`loop: false`) ends when every part is silent (at most `maxEndTail` = 12 s after its last beat).

## 6. Checklist for a finished song

1. `node tools/test.mjs --only songs` passes (valid, every part audible, peak ≤ −0.3 dBFS, voices ≤ 32).
2. Mix −16…−13 LUFS, pre-limit peak ≤ −1 dBFS, no part masking the lead; sections have a dynamic arc.
3. Exact preset names (no `fallback`), `zh`/`description` in Chinese, 3 cover colours, sections named in zh + en.
4. Loops seamlessly (render with `--loops 2` and listen to/look at the seam), or ends gracefully (`loop: false`).
5. The key is right for play-along (the UI suggests the scale lock from `key`).
