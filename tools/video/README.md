# AURORA 極光 · video capture pipeline

Records the **real running app** — real-time AudioWorklet audio, WebGL/DOM visuals, the overlay's motion
graphics — as a 1920×1080 60 fps video with sample-accurate, lossless audio, driven by a script (a *timeline*).
Nothing is mocked: the audio in the file is exactly what the app's master node sends to the speakers.

```
node tools/video/record.mjs --timeline tools/video/capture/timelines/calibration.mjs --out renders/video/capture/calibration.mp4
node tools/video/record.mjs --timeline my-scene.mjs --out renders/video/scene-en.mp4 --lang en --takes 3
node tools/video/record.mjs --timeline my-scene.mjs --out renders/video/scene-zh.mp4 --lang zh --takes 3
node tools/video/record.mjs --timeline my-scene.mjs --out x.mp4 --dry          # rehearse: no capture, prints slow frames
node tools/video/capture/measure.mjs renders/video/scene-en.mp4 --frames 1.5,4.0   # frame/sync/audio check + stills
```

Requirements: the dev server on http://localhost:5173 (started automatically if down), Google Chrome, ffmpeg.
Chrome runs **headless and muted** — nothing plays on the speakers, no window appears. Each run uses its own free
debugging port (9900–9999) and a throw-away profile, so recordings can run in parallel with other jobs.

## Files

| file | what |
|---|---|
| `record.mjs` | the CLI: launches Chrome, runs the timeline, captures, assembles, encodes |
| `director.html` / `director.js` | the filmed page: 1920×1080 stage = app iframe (`/index.html?video=1`) inside a CSS **camera**, overlay root above, timecode strip below (cropped) |
| `capture/app-hook.js` | loaded by `src/ui/main.js` **only with `?video=1`** → `window.__aurora` (scripting handles) + video-mode CSS |
| `capture/tap-worklet.js` | lossless AudioWorklet tap on the app's master node + clock marks |
| `capture/chrome.mjs` | headless Chrome launcher + minimal CDP client |
| `capture/screencast.mjs` | CDP screencast → one MJPEG file + frame index |
| `capture/assemble.mjs` | timecode decoding, CFR frame picking, audio slicing, ffmpeg encode |
| `capture/context.mjs` | the `ctx` object timelines get |
| `capture/measure.mjs` | measures a finished clip (frames, A/V sync from flashes, loudness, clicks) |
| `capture/timelines/*.mjs` | `calibration` (12 s proof clip), `stress` (overlay + song + camera), `interact` (cursor clicks, typing, knob drag, wheel), `splash` (take that opens on the splash) |
| `timelines/` | **the X film**: `ui` / `proof` / `songs` takes, `lib.mjs` (beat grid, captions), `stage.js` (browser frame, spectrogram, gallery, build-log layers) — see `timelines/README.md` (`theater.mjs` is the first cut's take, no longer in the edit) |
| `make-assets.mjs` · `make-bed.mjs` · `make-buildlog.mjs` · `make-label.mjs` | film assets: full song render + 2400-px spectrogram + gallery still · the soundtrack (song beats 188→260, two arrangement mutes, onset-aligned) · the real build-log excerpt from the build transcript · transparent caption stills for composited shots |
| `edit.mjs` · `finish.mjs` · `xlen.mjs` | beat-exact cut of the takes (+ the 2×2 engine grid) over the bed → `renders/video/aurora-x-<lang>.mp4` · posters, contact sheets, 600/390-px checks, specs, 720p previews · X weighted lengths of the post copy |

`src/ui/main.js` changes (all inert without `?video=1`): no first-run tips, no session restore / autosave (a
recording always starts from *Aurora Pad* and never overwrites a viewer's saved sound), and it hands its internals to
`capture/app-hook.js`.

## Writing a timeline

```js
// my-scene.mjs
export const meta = { tail: 0.5 };            // optional: overlay ('none'), cursor ('overlay'|'builtin'|'none'),
                                              // tail (s kept after the timeline), preload: [strings with glyphs]
export async function prepare(ctx) {          // optional, runs BEFORE the capture starts (not in the video)
  await ctx.aurora.loadPresetByName('Stellar Supersaw');
}
export default async function (ctx) {         // t = 0 of the video is the moment this is called
  ctx.overlay.hook([{ en: "Claude can't hear.", zh: 'Claude 聽不見。' }]);   // not awaited: runs alongside
  await ctx.at(0.4);                          // audio-clock scheduling, seconds from the start
  await ctx.holdKeys(['KeyA', 'KeyD', 'KeyG'], 1200);          // QWERTY chord (C E G), trusted key events
  await ctx.at(2.0);
  await ctx.camera.zoomTo('.play__macros', null, 900, 'inOutCubic');   // fit the macro knobs
  await ctx.drag('.play__macros .macro:nth-child(1) [role="slider"]', { dy: -150 }, { ms: 1000 });   // turn M1
  await ctx.camera.reset(800);
  await ctx.aurora.playSong('neon-nights');   // Demo Center opens, song plays
  await ctx.at(9.0);
  await ctx.aurora.stopAll();
}
```

Timing: things the timeline does at `t` seconds appear **and sound** at `t` seconds into the video (±½ frame).
Everything is real time — a timeline takes as long to record as the video lasts.

### `ctx` reference

| | |
|---|---|
| `ctx.lang`, `fps`, `w`, `h`, `args` | language (`en`/`zh`), output settings, `--set k=v` pairs (+ `take`) |
| `ctx.at(s)` | wait until `s` seconds after the start (app audio clock; page clock for `--no-autostart` takes) |
| `ctx.wait(ms)`, `ctx.waitAudio(s)`, `ctx.now()` | plain wait · wait `s` on the audio clock · seconds since start |
| `ctx.mark(label)` | chapter marker in the report (`events`, with its video time) |
| `ctx.aurora.*` | anything on `window.__aurora` in the app (below), awaited, JSON args/results |
| `ctx.overlay.*` | anything on the overlay instance (`tools/video/overlays/overlay.js`: `hook`, `caption`, `badge`, `counter`, `stats`, `swarm`, `spotlight`, `highlightRing`, `flash`, `endCard`, `cursor.moveTo/click/show/hide`, …); nested paths work (`ctx.overlay.cursor.moveTo(x, y, { ms })`). Missing → logged no-op |
| `ctx.director.*` | anything on `window.director` |
| `ctx.evalApp(fn, ...args)` / `ctx.evalDirector(fn, ...args)` | run a self-contained function (no closures) in the app frame / the director page; returns JSON |
| `ctx.camera.zoomTo(target, scale?, ms=900, ease='inOutCubic', opts?)` | target = app selector, `{x,y,w,h}` or `[x,y,w,h]` in app px; `scale` null = fit (margin `opts.margin` 0.08); `opts.anchorX/Y` (0..1) where the target centre lands; `opts.dx/dy`; `opts.free` allows showing past the edges |
| `ctx.camera.to({s,x,y}, ms, ease)`, `reset(ms, ease)`, `set(state)`, `get()`, `frameFor(target, scale, opts)` | camera state: stage = app·s + (x, y). Eases: `linear inOutCubic outCubic inCubic inOutSine outQuint outExpo inOutExpo inOutQuart outBack` or any CSS `cubic-bezier(...)` |
| `ctx.click(x, y, opts)` | trusted click at stage px. With the overlay cursor it glides there first (`moveMs`, default 450) and plays the press animation. `opts.holdMs`, `cursor:false` |
| `ctx.clickSelector(sel, opts)` | click an app element's centre — the camera transform is applied (`opts.dx/dy/scroll/moveMs`) |
| `ctx.moveTo(target, { ms, ease, arc })` | move the pointer (hover states follow) and the cursor visual |
| `ctx.drag(from, to, { ms, moveMs, ease })` | press–move–release; `to` = point, selector or `{ dy, dx }` relative. Knobs: 220 px of vertical drag (in app px) = full range |
| `ctx.wheel(target, deltaY)` | wheel over a point / selector (knobs respond) |
| `ctx.showCursor(on)`, `ctx.pointer()` | cursor visibility · current pointer position |
| `ctx.key(k, key?, { holdMs })`, `keyDown`, `keyUp` | `k` = DOM code (`'KeyA'`, `'Space'`, `'Enter'`, `'ArrowRight'`) or a character (`'a'`, `';'`) |
| `ctx.holdKeys(keys, ms)`, `ctx.play([[keys, ms], …], { gapMs })` | chords / phrases. The app's layout: `A W S E D F T G Y H U J K O L P ; '` = C4…F5, `Z`/`X` octave, `C`/`V` velocity |
| `ctx.type(text, { charMs })` | type into the focused field (CJK via insertText) |
| `ctx.focusApp()` | focus the app frame (key events go there) |
| `ctx.screenshot(file)` | PNG of the stage (debug) |
| `ctx.cdp(method, params)` | raw CDP |

### `window.__aurora` (app, `?video=1` only)

`start()` (engine + splash dismissal — the director calls it unless `autostart=0`), `isReady()`,
`loadPresetByName(name)` (exact, key or substring; returns the name), `presetNames()`, `setMacro(i, v)` /
`getMacro(i)` / `rampMacro(i, v, ms)` (i = 0…3, v = 0…1 — knob, XY pad and sound follow), `setParam(id, v)` /
`getParam(id)`, `noteOn(note, vel)` / `noteOff(note)`, `onNote(fn)` (JS-triggered notes, for overlay reactions),
`startDemo()` / `stopDemo()` (preset demo phrase), `openDemoCenter(tab)` / `closeDemoCenter()` (tabs `songs tours jam
magic theater`), `playSong(id)` (`aurora-dreams neon-nights lofi-rain crystal-caves pulse-city silk-road`),
`startTour(id)` (`.tours` lists them), `theater()`, `stopAll()` (no toast), `setEditMode(on)`, `rect(sel)`,
`setLang(l)`, and the objects `store`, `library`, `audio`, `ctx` (AudioContext), `master` (the node that reaches the
destination), `presets`, `categories`, `songs`, `tours`, `center`, `internals`.

Video mode also hides toasts, the first-run tips, the headless-only "MIDI unsupported" strike-through (a desktop
Chrome shows the idle pill) and the OS cursor (`cursor: none` everywhere — the overlay draws
the cursor; `--cursor builtin` uses the director's simple arrow, `none` shows nothing).

### `window.director`

`app`, `appDoc`, `aurora`, `camera` (the wrapper element), `cam` (camera API above), `overlayRoot`, `overlay`,
`audioClock()`, `waitAudio(t)`, `wallNow()`, `waitWall(ms)`, `toStage(x, y)`, `rectToStage(r)`, `selectorRect(sel)`,
`pointer(x, y, type)` (also fires `director:pointer` events and `overlay.onPointer({x, y, type})` if the overlay has
it), `noteFlash(on)` (white square top-right on every note — calibration), `prewarmFonts(text)`, `focusApp()`,
`ready`. The overlay module is `createOverlay(overlayRoot, { lang, director })` from `?overlay=` (default
`./overlays/overlay.js`); a requested overlay that fails to load aborts the recording (`--allow-missing-overlay` to
record anyway).

## Output

`<out>` plus `<out>.wav` (24-bit PCM, the exact aligned audio — use it for the final mix) and `<out>.json`:
`video` (unique / held frames, longest render gap), `sync` (method, timecode coverage, audio-clock jitter and
wander, per-pulse audio−picture error), `audio` (peak, RMS), `loudness` (with `--loudness`), `perf` (render gaps,
long tasks, long animation frames with the scripts that caused them), `events` (every click / chord / mark with its
video time), `takes`.

| extension | codec |
|---|---|
| `.mp4` | H.264 High 4.2, yuv420p BT.709 limited range, CRF 14 `slow`, aq-mode 3 (dark gradients), AAC 320 kb/s, faststart — upload-ready for X |
| `.webm` | VP9 CRF 18 + Opus 256 kb/s |
| `.mov` | ProRes 422 HQ 10-bit + 24-bit PCM (editing intermediate) |
| `.mkv` | near-lossless H.264 4:4:4 CRF 6 + FLAC |

Options: `--fps 60|30`, `--dpr 2` (renders at 3840×2160 and downsamples: smoother text/canvas edges, ~same frame
rate on the M5), `--quality` (screencast JPEG, default 80 — measured indistinguishable from 92 after the H.264
encode, and it keeps 60 fps under heavier scenes), `--crf`, `--preset`, `--loudness -16` (plain gain toward the
target, never past −1 dBFS peak; default: the app's own level untouched), `--takes N` + `--min-unique 0.985` (record
up to N takes and keep the smoothest), `--score shots` (rank takes by held frames inside the timeline's `shot`
windows only — hitches in set-up gaps don't count), `--keep` (keep the work dir: frames, timecodes, marks).

## How it works

1. **Capture method.** Tab capture was tried first and is **not available headless**: `getDisplayMedia({ preferCurrentTab })`
   with `--auto-accept-this-tab-capture` / `--use-fake-ui-for-media-stream` / `--auto-select-tab-capture-source-by-title`
   (Chrome 154, `--headless=new`) never resolves, and `chrome.tabCapture` through an unpacked extension (loaded via
   CDP `Extensions.loadUnpacked`, allow-listed) gets a stream id but `getUserMedia` fails with *NotFoundError*. So:
   **CDP `Page.startScreencast`** (every compositor frame, JPEG) for video + **an in-page lossless audio tap** for audio.
2. **Video timing.** Chrome's screencast timestamps are the capture time, 25–45 ms after the frame was rendered and not
   constant. So the director draws the page time of every frame (its rAF time, 0.1 ms units, 28 bits + checksum) as
   32 black/white 8×8 blocks in an 8-px strip below the stage; the recorder decodes it from every JPEG (100% of frames
   in all tests) and knows exactly which moment each captured frame shows. Output frame *k* = the latest frame whose
   content time ≤ start + k/fps (a missing frame is held; nothing is interpolated).
3. **Audio.** `tap-worklet.js` sits on the app's master GainNode (the node that feeds `ctx.destination`) and copies
   every rendered sample (float32 stereo, 48 kHz) — no compression, no resampling, no speaker path. Every 50 ms the
   director posts a mark; the worklet answers with the context frame of the next render quantum (the one a note
   posted in the same task starts in). The median maps the AudioContext clock onto the page clock (measured jitter
   5.3 ms = one 256-frame callback, wander < 3 ms over 20 s: no drift correction needed).
4. **Alignment.** Audio for output time τ = page time *start* + τ − ½ frame, so an event's sound lands in the middle
   of the first frame that shows it. White-square pulses in the pre- and post-roll (flash + audio mark in one task)
   verify it on every take (`sync.pulseAvMs`) and are the fallback if the timecode is unreadable.
5. **Camera.** Zooms/pans are Web Animations on the wrapper's transform: composited (smooth even while the app's main
   thread works) and rasterised at the animation's largest scale — text stays crisp at 2× and mid-move.
6. **Fonts.** Before filming, every glyph the app, the overlay sources and the timeline file contain is loaded
   (Noto Sans TC slices included), so nothing pops in during a take.

## Measured (Apple M5, Chrome 154 headless, 2026-09-30)

Calibration clip (`capture/timelines/calibration.mjs`, 12.1 s: QWERTY notes and chords, 2 preset loads, a knob drag
under a 2.1× zoom, zoom out), `renders/video/capture/calibration.mp4` (+ `calibration-zh.mp4`):

| | en | zh |
|---|---|---|
| frames | 724/727 unique (99.6%), 60.00 fps CFR; the 3 holds are one 50 ms render gap at the end of the zoom-out | 723/726 (99.6%) |
| A/V sync (17 note flashes vs audio attacks, measured on the delivered MP4) | median 0.0 ms, range −4.0…+7.3 ms (+ = sound after picture), 17/17 within one frame (16.7 ms) | median +3.0 ms, −3.0…+11.3 ms, 17/17 |
| sync pulses (pre/post-roll, per take) | +0.4…+9.9 ms | −5.6…+3.0 ms |
| across 8 recordings with this pipeline (136 flashes) | medians −1.3…+4.8 ms, worst single flash +13.5 ms, 136/136 within one frame | |
| audio | lossless tap, 0 sample gaps, 0 click blocks, no digital dropouts; −22 LUFS / −5.7 dBTP (the app's own level) | same |
| picture | crisp text at 1× and mid-zoom / at 2.1× zoom, no tearing (a captured frame is always one complete compositor frame); BT.709 tags | CJK UI crisp |

Stress (`stress.mjs`: WebGL overlay hook, Demo Center song, captions, two camera moves, knob drag): 99.5% unique
frames on a quiet machine (1069/1074, longest render gap 50 ms); one earlier take held 150 ms when the app closed the
Demo Center — the same stall shows up in `--dry` without any capture, so it is the app, not the recorder.
`interact.mjs` (overlay-cursor clicks, typing, drag, wheel): 100% (677/677). `splash.mjs` (take opens on the splash, the audio
tap attaches the moment the engine starts): 99.2%.

Frame drops scale with machine load: with several other headless jobs running at the same time the same stress
timeline dropped to 89–96% unique frames (JPEG q92: 89–92%, q80: 96% — hence the q80 default). Use `--takes 3` for final renders (the recorder keeps the smoothest take),
avoid running two recordings at once, and check `video.uniqueSourceFrames` / `perf.renderGaps` in the report.
If a scene cannot hold 60 fps, `--fps 30` records every second frame.

## Known limitations

- Real time only: a 60 s scene takes ~60 s + ~20 s of assembly and encode; timelines cannot be "rendered faster".
- App-inherent hitches show up as held frames: a preset load costs ~1 frame, opening/closing the Demo Center up to
  ~150 ms. Cut or cover them with the camera/overlay if they matter.
- In the English UI the preset descriptions under the preset name stay Chinese (the factory presets only have zh
  descriptions) — frame around them or hide `.play__desc` via `ctx.evalApp` for the English cut.
- The AudioContext sample rate is 48 kHz (the app caps it); the delivered AAC is 48 kHz stereo.
- The director writes `aurora.lang` into the page's localStorage (the recorder's profile is thrown away; if you open
  the director in your own browser it switches your app language too).

**Requirements.** Node 22+ and Google Chrome. On macOS the default Chrome path is used; elsewhere set `CHROME_BIN=/path/to/chrome`. `make-buildlog.mjs` needs `--transcript <agent .jsonl>` — the original build transcript is not part of this repository, so the build-log shot can only be rebuilt on the machine that built AURORA.
