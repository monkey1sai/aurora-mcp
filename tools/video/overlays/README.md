# AURORA 極光 · video overlay layer

Motion graphics for the X demo film: kinetic hook typography, captions, badges, odometer counters,
the "how Claude built it" agent swarm, a guide cursor, spotlight / highlight rings, soft flashes and
an end card that loops back into the opening. Everything is DOM + CSS + Canvas 2D + WebGL, animated live
(no pre-rendered assets), in AURORA's own visual language (night-blue glass, aurora gradient
`#3ef0b0 → #5cf2ff → #a78bfa → #ff6bd6`, Inter / Noto Sans TC / JetBrains Mono).

```
tools/video/overlays/
  overlay.js        createOverlay(): the API below
  overlay.css       styles (injected automatically by overlay.js)
  lib/anim.js       rAF engine (+ timer fallback), easing, WAAPI helper, freeze/step support
  lib/text.js       {en, zh} picking, *highlight* markup, char/word splitting, continuous gradients
  lib/backdrop.js   WebGL aurora sky + stars + vignette + grain (shared by hook / swarm / end card)
  lib/swarm.js      the agent-swarm visualisation (Canvas 2D + DOM labels)
  preview.html/.js  test bench: every component over a sample background, plus a ~45 s sample film
  verify.mjs        headless Chrome: fonts, freeze-frame screenshots, per-frame perf, deterministic MP4 render
  assets/app-sample.jpg   a 1920×1080 screenshot of the app (preview background)
```

## Quick start

```js
import { createOverlay } from '/tools/video/overlays/overlay.js';

const ov = createOverlay(document.getElementById('overlay-root'), { lang: 'en' }); // or 'zh'
await ov.ready;                                   // stylesheet + fonts (Inter, Noto Sans TC, JetBrains Mono)
await ov.preload([allMyCaptionTexts]);            // fetch every CJK glyph slice BEFORE the first frame

ov.badge({ en: '🔊 Sound on', zh: '🔊 請開聲音' }, { delay: 800, ms: 3600 });
await ov.hook([{ en: "Claude can't hear.", zh: 'Claude 聽不見。', size: 'l' },
               { en: 'It built this anyway.', zh: '卻做出了這台合成器。', key: true }]);
await ov.wait(1300);
await ov.clearHook();                             // iris-opens onto the app underneath
await ov.caption({ en: 'Every sound is synthesized *live*', zh: '每個聲音都是*即時合成*' }, { kicker: { en: '0 samples', zh: '零取樣' } });
…
await ov.endCard({ ms: 3000, loopOut: true });    // ends on the opening frame's sky → seamless X loop
```

**Stage.** Everything is laid out on a fixed **1920×1080** stage. The root element should be a
1920×1080 box that sits on top of the app. If its layout size differs, the layer scales itself to fit;
an outer CSS `transform: scale()` on a parent (preview-style) is fine too.
All coordinates (`cursor`, `spotlight`, `highlightRing`, `counter` x/y) are **stage pixels**.
Wherever a rect/point is accepted you may also pass a DOM element, a CSS selector (searched in the
page and in same-origin iframes, e.g. the app in an `<iframe>`), `[x, y, w, h]` or `{x, y, w, h}`;
`ov.rectOf(elOrSelector)` converts any element (also inside an iframe) to stage coordinates.

**Do not** put `contain`, `filter`, `opacity < 1`, `mask`, `clip-path`, `mix-blend-mode`,
`backdrop-filter` or `will-change` on the overlay root or its ancestors: each makes a *backdrop root*
and the glass panels stop blurring the app behind them (verified — `contain` silently killed it).

**Text.** Any text is `{ en, zh }` or a plain string. `*word*` = aurora-gradient highlight with a light
sweep, `\n` = line break. Keep captions short (≤ 8 words EN / ≤ 16 字 zh). In zh, prefer no final `。` on
big lines (`palt` is on, but headline style reads better without it).

## Timing contract

* Every method accepts `delay` (ms before it starts). Async methods resolve when their animation finishes.
* Persistent components (hook, badge, counter, stats, swarm, highlightRing, endCard, caption with
  `persist`) resolve after their **intro** and return a **handle** `{ el, remove({ ms }) }`.
  Pass `ms`/`hold` to have them leave by themselves (then they resolve after the exit).
* All timing runs on the overlay clock (`ov.engine`): rAF-driven with a timer fallback, so waits still
  advance when frames are not being produced. `ov.wait(ms)` uses the same clock (use it for cues, so
  frame-stepped renders stay in sync).
* `ov.clear({ ms })` fades out everything (cancels queued captions too).

## API

| call | what it does | key options (defaults) |
|---|---|---|
| `hook(lines, o)` | Huge kinetic type over the aurora sky: per-glyph blur-rise, tracking-in, slow camera push, gradient + light sweep + streak on the key line, a light beam across the frame. Key line ≥ 125 px cap height; lines auto-fit 1740 px. Frame 0 is already the sky (scroll-stopper, loop target). Resolves when all lines are in (+ `ms`). | `lines: [{en, zh, key?, size?: 'xxl' 200 \| 'xl' 172 \| 'l' 138 \| 'm' 104 \| 's' 64 \| px, soft?}]` — default key = last line; `backdrop: 'aurora'\|'dim'\|'none'`, `stagger 24`, `lineGap 560`, `amp 1`, `lift .30`, `beam true`, `push true`, `y 0`, `ms 0` |
| `clearHook(o)` | Glyphs blur away upward; the sky iris-opens onto the app. | `ms 520`, `reveal: 'iris'\|'fade'\|'none'` |
| `caption(text, o)` | Punchy caption, queued per position. `label` = glass pill with a glowing aurora dot (60 px); `statement` = 82 px bold on a blurred scrim. Words rise in, highlights sweep. | `ms 2400` (hold), `position: 'bottom'\|'top'\|'center'`, `style: 'label'\|'statement'`, `kicker {en,zh}` (small mono line above), `persist false`, `scrim` (auto for statement), `stagger` |
| `clearCaptions(o)` | Removes live captions, drops the queue. | `ms 420` |
| `badge(text, o)` | Pill with gradient border. A leading 🔊 / ✓ / ✦ becomes an animated vector icon (🔊 adds live EQ bars). Stacks per corner. | `position: 'top-right'\|'top-left'\|'bottom-right'\|'bottom-left'\|'top'\|'bottom'`, `icon: 'auto'\|'sound'\|'spark'\|'check'\|'none'`, `ms` (auto-remove), `eq` |
| `counter(o)` | One big odometer number (aurora gradient, rolling digits, leading digits roll in, `0` = slot-machine spin that lands on 0). | `value`, `label {en,zh}`, `sub`, `prefix`, `suffix`, `from 0`, `decimals 0`, `ms 1600` (count), `x 960`, `y 540`, `size 250`, `dim false`, `hold` |
| `stats(items, o)` | Glass tiles (3 + 2 for five) counting up with a stagger, glow on landing, darkened app behind. | `items: [{value, label, prefix?, suffix?, from?, decimals?}]`, `title {en,zh}`, `ms 1700`, `stagger 150`, `size 144`, `dim true`, `hold`, `y` |
| `swarm(o)` | "How Claude built it": Claude Code core ignites → each phase fans out as a ring of agent nodes (fly out → progress ring → report back to leads; review phase flows reviewers → verifiers → fixers), camera pulls back, live agent counter, callouts, then everything spirals into an **AURORA 極光** bloom with "~20M tokens · ~11 h". ~5.6 s by default (reads in 4–5 s); `ms` rescales. | `ms 5600`, `phases` (default = the verified 47 runs; see `DEFAULT_PHASES`), `hold`, `meta`, `kicker`, `countLabel`, `core`, `cx 1020`, `cy 560`, `amp .55`, `backdrop true` |
| `clearSwarm(o)` | Blur-fades the swarm (and its sky). | `ms 600` |
| `cursor.moveTo(x, y, ms\|o)` | Stylised glowing arrow gliding on a slight arc with velocity tilt. Also `moveTo(elOrRect, o)`. | `ms` (auto from distance, 320–950), `arc .12`, `delay` |
| `cursor.click(x, y, o)` | Glide (if needed), press, ripples. `onPress` fires at the press instant — fire the real click there. | `ms`, `delay`, `onPress` |
| `cursor.show({x, y})` / `cursor.hide()` | Fade in at a position / fade out. | `ms` |
| `spotlight(target, o)` | Dims everything but a rounded window; glides between targets; `spotlight(null)` removes. | `ms 650`, `pad 18`, `radius 22`, `dim .64` |
| `highlightRing(target, o)` | Aurora ring draws itself around the target, then breathes; optional gradient tag. | `ms 750`, `pad 12`, `radius 18`, `label {en,zh}`, `labelPos 'above'\|'below'`, `hold`, `pulse true` |
| `flash(opacity, ms, o)` | Soft full-frame screen-blend flash for beat accents. **Photosensitivity guard:** max 3 per rolling second (extra calls are skipped and resolve `false`), white capped at .55, aurora at .8, min 220 ms with a soft 14 % attack. | `opacity .45`, `ms 480`, `color: 'aurora'\|'white'` |
| `endCard(o)` | Aurora sky + AURORA 極光 logotype tracking in with a light sweep, tagline, **Built with Claude Code** pill with a gleam, facts line. With `loopOut`, after `ms` the text dissolves and the sky cross-dissolves to exactly the hook's first frame. | `ms` (hold), `loopOut false`, `lang`, `tagline`, `built`, `facts true\|false\|{en,zh}` (HTML allowed) |
| `handle.loopOut({ ms: 1400 })` | (end-card handle) do the loop-out later yourself. | |
| `dim(on, {ms})` | Darken the app (0..1 or boolean). | |
| `backdrop.show/hide/now/loopBack` | Direct control of the sky (`amp` brightness, `lift` curtain height). | |
| `setLang('en'\|'zh')` | Switches language for subsequent calls (and live counter/stat/badge labels). | |
| `ready` / `preload(strings)` / `fontReport()` | Font loading. `preload` takes any nesting of strings / `{en, zh}` objects / arrays. | |
| `rectOf(target)` | Element/selector → stage rect. | |
| `freeze()` / `thaw()` | Hold every overlay animation + the overlay clock on the current frame (poster frames, exact screenshots). | |
| `step(ms = 1000/60)` | Deterministic frame stepping (after `freeze()`): advances all animations and the clock by exactly `ms`, then resolves; capture a frame, repeat. | |
| `perf()` / `perfReset()` | Overlay JS cost per frame: `{frames, avg, p50, p95, p99, max}` ms. | |
| `wait(ms)`, `clear(o)`, `destroy()` | | |

`createOverlay(root, { lang = 'en', loadFonts = true, glScale = .5, pixelRatio = 1, clock })` —
`glScale` = aurora render resolution (soft light, half-res is invisible), `pixelRatio` = swarm canvas
resolution, `clock` = custom time source (ms).

### Default swarm data (verified facts only)

Build: 10 module builders + 1 integration lead · Sound: 10 sound designers, 5 demo & visual engineers,
3 composers, 2 QA leads (preset QA + final QA) · Review: 5 reviewers → 5 adversarial verifiers → 4 fixers,
2 regression & i18n (regression lead + i18n fixer) = **47 agent runs**; meta line "~20M tokens of agent work /
~11 h of workflow time". The counter always equals the number of nodes drawn.

## Recording

* **Real time (with the app and its audio):** just run the cues; 60 fps is safe (numbers below).
* **Frame-exact (overlay-only segments — hook, swarm, stats, end card cover the whole frame):**
  `ov.freeze()` then loop `await ov.step(1000/60); capture()`. `verify.mjs render` does exactly this and
  pipes JPEG frames into ffmpeg. The app underneath is *not* stepped (its own animations/audio run in real
  time), so use this for full-frame segments or a static background.
* **Loop:** start the film with `hook()` (sky visible on frame 0) and end with `endCard({ loopOut: true })`;
  stop recording when that promise resolves. The last frame is the same sky state as frame 0.

## Verification (done on Apple M5, headless Chrome, 1920×1080)

* Fonts: Inter (variable 400–900, opsz), Noto Sans TC (variable 400–900, unicode-range slices) and
  JetBrains Mono load from Google Fonts in headless Chrome (`verify.mjs fonts`). Fallbacks if offline:
  PingFang TC / SF (system-ui) — no layout depends on exact metrics except the hook auto-fit.
* WebGL: `ANGLE Metal Renderer: Apple M5` (CSS-gradient fallback if WebGL is unavailable).
* Per-frame cost (`verify.mjs perf`, every scene): **60 fps, 0 frames > 25 ms**, overlay JS p95 ≤ 1.3 ms
  (swarm; others ≤ 0.2 ms), total main-thread ≤ 1.9 ms/frame over the screenshot and ≤ 2.5 ms/frame over
  the live app (that figure includes the app's own work).
* Legibility checked at 600 px wide (X timeline size): hook, statements, stats, swarm counter and end card
  read comfortably; label captions ≥ 60 px, callouts ≥ 42 px.

```sh
node tools/serve.mjs &                                           # if the dev server is not running
open http://localhost:5173/tools/video/overlays/preview.html     # interactive bench (?lang=zh, ?bg=app|gradient)
node tools/video/overlays/verify.mjs fonts
node tools/video/overlays/verify.mjs shots --scene swarm --at 900,2700,4800 --lang zh
node tools/video/overlays/verify.mjs perf  --scenes hook,swarm,end --bg app
node tools/video/overlays/verify.mjs render --scene film --lang en   # → renders/video/overlay-preview-film-en.mp4
```
`--port` (default 9968) and a throw-away Chrome profile per run keep parallel runs apart; Chrome is always closed.

## Additions for the film's second cut (2026-09-30)

* `hook(lines, { scrim: 'band' })` / `title({ scrim: 'band' })` — a strong horizontal band behind the text instead of
  the radial scrim, for text over the live app UI (the UI above and below stays bright and moving).
* `tag(text, { x, y, size })` — a big bold label pill at a fixed stage position (quadrant titles that must stay legible
  after the edit scales a shot to half size). Cleared by `clear()`.
* `stats()` / `counter()` — a value that does not count (0) is shown as itself from its first frame and pops in; it
  never spins through other digits, so no paused frame reads "4 dependencies".
* `swarm({ stay: true, phaseGap, calls: 'current' })` — `stay`: no convergence / logo, the swarm holds on the full
  count (the number punches and the tokens/hours line appears when it completes; `play()` resolves then);
  `phaseGap` (ms) spaces the waves independently of `ms`; `calls: 'current'` shows only the running wave's labels (the
  previous wave's vanish the moment the next launches). The count stays hidden until the first agent lands.
* `Backdrop.show()` reads the on-screen opacity before cancelling a running fade (cancelling first dropped the layer to
  its stylesheet opacity for one frame).
