# The X film — timelines, takes, edit

The 41.5-second demo film for X (`docs/video/STORYBOARD.md` §0, post copy in `docs/video/POST.md`), made entirely from
the real running app with the capture pipeline in `tools/video/` (README there) and the overlay layer in
`tools/video/overlays/`. Two cuts: English UI + captions, and Traditional Chinese UI + captions.

```sh
node tools/video/make-assets.mjs                       # full song render (for sync), 2400-px spectrogram, gallery still
node tools/video/make-bed.mjs                          # the soundtrack: song beats 188→260 with two arrangement mutes
node tools/video/make-buildlog.mjs --transcript <agent .jsonl>   # the real build-log excerpt (needs the original, unpublished build transcript)
node tools/video/make-label.mjs                        # transparent caption stills for the 2×2 engine grid
for lang in en zh; do
  node tools/video/record.mjs --timeline tools/video/timelines/ui.mjs --out renders/video/takes/ui-$lang.mp4 --lang $lang --takes 4 --score shots --min-unique 0.9992
  node tools/video/record.mjs --timeline tools/video/timelines/proof.mjs --out renders/video/takes/proof-$lang.mp4 --lang $lang --takes 2 --min-unique 0.998
  node tools/video/record.mjs --timeline tools/video/timelines/songs.mjs --out renders/video/takes/songs-$lang.mp4 --lang $lang
done                                                   # ≈ 20 min, one recording at a time
node tools/video/edit.mjs --lang en                    # → renders/video/aurora-x-en.mp4 (+ .json edit report)
node tools/video/edit.mjs --lang zh                    # → renders/video/aurora-x-zh.mp4
node tools/video/xlen.mjs                              # X weighted lengths of every post option in docs/video/POST.md
node tools/video/finish.mjs                            # posters, contact sheets, 600/390-px checks, specs, 720p previews, POST.md
```

## How it is built

* **The clock is the soundtrack.** Neon Nights (A minor, 104 BPM, composed by a Claude agent), song beats 188 → 260,
  rendered offline by the app's own engine. Two arrangement mutes (note events only, like the song player's lane
  mutes) give it real dynamics: kick/hats/bass/lead out for beats 180–192 (the film opens on the brass swell and the
  song's snare-roll build; the drop at 2.3 s is +6 dB and brings the low end), everything but the brass out for the
  breakdown bar 252–256 under "Claude has never heard it." The render's onsets land 17.8 ms after the nominal grid, so
  the bed is trimmed that much later: film frame of song beat *b* = `round((b − 188) · 60/104 · 60)` is where the beat
  is **heard** (measured on the final files: kick onsets +1…+2.5 ms from the cut grid).
* **Three takes per language**, each a timeline module:

| take | film (song beats) | what |
|---|---|---|
| `ui.mjs` | H 188–192 · D 192–200 · P 208–216 · E1–E4 216–220 · T 220–224 · M 224–228 · Q 252–256 · Z 256–260 | the app itself, one shot per window: the hook over the live UI, the drop + browser pull-back, preset flips, four engine panels (the edit tiles them 2×2), the tour's self-turning cutoff knob, the mood tap, "never heard it", the end card. Each shot is set up in a gap and written to the report as a `shot` mark |
| `proof.mjs` | L 200–208 · NAX 232–252 | the real build-log excerpt (render → read the spectrogram → noise box → repro → workaround → clean); the song's spectrogram with a NOW PLAYING playhead, the 47-agent swarm, the numbers |
| `songs.mjs` | S 228–232 | the song player playing Neon Nights live at the same beats as the bed (`prepare()` waits ~2 min off camera) |

* **In-points.** `ui`/`proof`: their `shot` marks. `songs`: cross-correlation of the take's lossless audio (the tap)
  with the unmodified song render — the exact video time of each song beat (r ≈ 0.61; the timeline's own estimate from
  the engine's ~30 Hz state is 20–24 ms early, the edit corrects it).
* **Audio** = the bed only (the takes' app audio is discarded — the chords that light the hero are visual), one static
  gain toward −14 LUFS bounded by a −1.5 dBTP true-peak ceiling (→ −14.7 LUFS / −1.5 dBTP after AAC; no compressor, no
  limiter), 8 ms / 60 ms fades so X's auto-loop restarts click-free.
* **The engine grid** (beats 216–220): four 4-beat shots scaled to 954×536 and tiled with 12/8 px gutters, the caption
  still from `make-label.mjs` on top. Each shot carries its own big title (`ov.tag`): top row top-left, bottom row
  bottom-left, so the centre stays free for the caption.
* `lib.mjs` — beat grid, caption strings (EN/zh), song clock, chord helper. `stage.js` — director-side layers: a
  generic browser window around the app, the spectrogram, the gallery still, the build-log card.

## Gotchas found while filming

* `scrollIntoView()` inside the app scrolled the director's `#stage`: it is `overflow: clip`, and the app document is
  pinned at scroll 0 in the UI take.
* A hard camera cut to a new zoom re-rasterises the iframe (~100 ms held): shots set the new framing in the gap (1.035×
  punch) and only animate the settle on the beat. The D pull-back to the browser window shows that framing once off
  camera first, so its window frame and backdrop are rasterised before the move.
* The first mood tap stalls rendering ~0.3 s: the UI take taps once off camera to warm it up. After the Demo Center
  closes, the (invisible) pointer is parked on static text — left over a macro knob it pops the knob's target
  tooltip into later shots.
* A scaling text box with glow re-rasterises every frame: the hook text is static (no push). Macro sweeps under the
  hook text cost dropped frames, so only the preset flips of P sweep the knobs.
* `store.animate()` ending inside a window costs 1–2 held frames: glides run past the end of their shot.
* A backdrop fade restarted with `show({ ms: 0 })` dropped to the stylesheet opacity for one frame (the old cut's frame
  2207 flicker): `Backdrop.show()` now reads the on-screen opacity before cancelling the running fade.
* The recorder ranks takes by held frames inside the `shot` windows (`--score shots`): hitches in the set-up gaps don't
  count. Remaining held frames in the delivered cuts: 3–4 single frames (the D pull-back start, the first frame of E3,
  the Z drop, and in zh one in the hook).
