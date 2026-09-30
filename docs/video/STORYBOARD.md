# AURORA 極光 — X demo video storyboard

**Goal (user):** 做一個 demo 影片要放到 X 上，要能夠引人注目，讓大家覺得「用 Claude 能做出這個也太酷了吧」。
**Audience:** people scrolling X anywhere in the world. Autoplay starts **muted**, so the first 1–2 s have to stop the scroll with visuals alone. After that, the video has to pay off anyone who turns the sound on.
**Deliverables:** an English-caption cut and a Traditional-Chinese-caption cut, same edit and same music.

## 0. Revision 2 (2026-09-30) — the cut that ships

Three reviews of the first cut (46 s: hook text over a blurred full-screen aurora, logo card on the drop, the
"tuned by sight" answer at 30 s, a flat soundtrack) led to a re-edit. **This section supersedes §3–§5 wherever they
differ;** the rest of the document is kept as the research and capture record.

| | Revision 2 |
|---|---|
| Length | **41.538 s** — 18 bars at 104 BPM, song beats **188 → 260**, 2492 frames at 60 fps |
| Music | Neon Nights by the app's own engine, **with two arrangement mutes** (`tools/video/make-bed.mjs`): beats 180–192 kick/hats/bass/lead muted (the film opens on the brass swell + the song's own snare-roll build, ≈ −19.5 LUFS momentary; the drop brings band, low end and the lead's hook back: **+6 dB**, +10 dB below 150 Hz), beats 252–256 brass alone under "Claude has never heard it." (+5 dB into the outro). Trimmed 17.8 ms late so beat onsets sit on the cut grid (measured ≤ 2.5 ms). −14.7 LUFS / −1.5 dBTP after AAC (static gain, true-peak bound). |
| First frame | Both hook lines over the **live app UI** (Stellar Supersaw, pillars peaking on frame 0, lit keys) + "🔊 Sound on" pill; presets flip on every beat (4 palettes in 2.3 s) |
| Drop (2.3 s) | Slam into the hero (1.52× → 1.34×, white flash, 12-note chord): "A synthesizer built by Claude" → pull back to a generic browser window: "Runs entirely in a browser tab" |
| The answer (6.9 s) | A **real excerpt of the build transcript** (`tools/video/make-buildlog.mjs`): a sound-designer agent renders Bowed Moonglass (a working name during that session, not a shipped preset name), reads the spectrogram PNG (the exact image it was shown), a red box marks the broadband noise, it builds a repro of the voice-steal bug, works around it, reads the clean result (a glowing sweep wipes the noise away). "So it tuned every sound by looking at it." → "Saw the noise. Found the bug. Fixed it." |
| Montage | 8 preset flips on the hero (knobs sweep on each beat) · a 2×2 grid of the wavetable / FM / physical-model / ladder-filter panels with "Real-time DSP in plain JavaScript" · the tour's cutoff knob at 2.1× (463 Hz → 1.4 kHz) · one tap "Ethereal" + its change log · the song player |
| Proof | Neon Nights' spectrogram with a NOW PLAYING playhead: "You're hearing one right now." · 47-agent swarm (the count completes at ≈ 2 s and holds 2.6 s; only the current wave's labels) · stats: 46,742 and 308 count up, the zeros pop in as "0" (no slot roll), all four held ≈ 3.5 s |
| End | "Claude has never heard it. / But you can." over the idle UI (the breakdown bar) → the full band returns: explosion + AURORA 極光 · Built with Claude Code · Claude Opus 5.5 · 🔊 Sound on |

| # | Song beats | Film s | Take · shot | EN caption | zh caption |
|---|---|---|---|---|---|
| H | 188–192 | 0.00 | ui · H | Claude can't hear. / It built this synth anyway. | Claude 聽不見 / 卻做出了這台合成器 |
| D | 192–200 | 2.31 | ui · D | A synthesizer built by Claude → Runs entirely in a browser tab | 一台由 Claude 打造的合成器 → 完全在瀏覽器分頁裡執行 |
| L | 200–208 | 6.92 | proof · L | So it tuned every sound by looking at it → Saw the noise. Found the bug. Fixed it. | 所以它用「看」的，調好每一個聲音 → 看到雜訊，揪出 bug，修好它 |
| P | 208–216 | 11.54 | ui · P | 100 presets. Zero samples. (every sound synthesized live) | 100 個音色，零取樣（每個聲音都是即時合成） |
| E | 216–220 | 16.15 | ui · E1–E4 (2×2) | Wavetable · 4-operator FM · Physical modeling · Ladder filter + Real-time DSP in plain JavaScript | 波表合成 · 四運算子 FM · 物理建模 · Ladder 濾波器 + 純 JavaScript 即時運算 |
| T | 220–224 | 18.46 | ui · T | Knobs that turn themselves (6 guided sound tours) | 旋鈕會自己轉（6 段自動音色導覽） |
| M | 224–228 | 20.77 | ui · M | One tap: "Ethereal" (sound design in plain words) | 一鍵「更空靈」（用一句話調音色） |
| S | 228–232 | 23.08 | songs | 6 songs, composed by Claude | 6 首原創曲，全是 Claude 寫的 |
| N | 232–236 | 25.38 | proof · NAX | You're hearing one right now. (Neon Nights, as Claude saw it) | 你正在聽的，就是其中一首（〈霓虹夜色〉，Claude 眼中的樣子） |
| A | 236–244 | 27.69 | proof · NAX | 47 Claude agents built it | 47 個 Claude 代理人合力打造 |
| X | 244–252 | 32.31 | proof · NAX | 46,742 lines of code · 0 dependencies · 0 audio samples · 308 automated tests | 46,742 行程式碼 · 0 個依賴套件 · 0 個取樣音檔 · 308 項自動測試 |
| Q | 252–256 | 36.92 | ui · Q | Claude has never heard it. / But you can. | Claude 從來沒聽過它 / 但你可以 |
| Z | 256–260 | 39.23 | ui · Z | AURORA 極光 · Built with Claude Code · Claude Opus 5.5 | AURORA 極光 · 用 Claude Code 打造 · Claude Opus 5.5 |

New on-screen claims and what they rest on: **"Saw the noise. Found the bug. Fixed it."** — the pad sound designer's
transcript (the pad sound designer's session, messages 385–449, 2026-09-27 10:07–10:13 UTC): render → Read PNG → "Scan bowed
glass noise per note" → "Build minimal repro for phys bow voice-steal noise" → "Apply Moonglass workaround and
re-test" → Read PNG (clean; >16 kHz energy −43 → −60 dB); the engine-side cause was reported in its hand-off and
`src/dsp/engines/phys.js` `reset()` now carries the fix ("…hissy bows" after a voice steal). **"But you can."** — the
viewer can hear the video. **No mood-button count** is stated anywhere (the app has 16; an older facts sheet said 14).

The first cut and its takes are kept in `renders/video/drafts/`.

| Decision | Choice |
|---|---|
| Length | **46.154 s** (20 bars at 104 BPM, an exact beat grid). X auto-loops videos of 60 s or less, so the end card is built to loop back into the hook. |
| Master | **16:9, 1920×1080**, 30 fps (60 fps if the capture is smooth). An optional **4:5 mobile cut** is described in §8. |
| Music bed | **Neon Nights 霓虹夜色** (`neon-nights`, A minor, **104 BPM**), song beats **184 → 264**: the last 2 bars of the *Rain on Glass* breakdown, the **drop at beat 192** into *Overdrive*, and 2 bars of *Tail Lights*. Rendered by the app's own engine. |
| Hook | **"Claude can't hear."** → "It built a synth anyway." → the drop. zh: **「Claude 聽不見。」** →「但它還是做出了一台合成器。」 |
| Payoffs for sound-on viewers | The drop at 4.6 s. "You're hearing one right now." at 27.7 s. "Your turn. Sound on." at 41.5 s. |

Reference frames from the real app (headless Chrome, M5 GPU) are in `renders/video/storyboard-refs/` (gitignored). File names start with the shot number, for example `S01-hook-en.png`.

---

## 1. What stops the scroll on X (research summary)

| Finding | Implication for this video | Source |
|---|---|---|
| Most feed video starts muted. 75 % of people say they often watch mobile video on mute. In a Verizon Media/Publicis study, 92 % of consumers regularly watch with the sound off, people were 80 % more likely to finish a captioned video, and 37 % turned the sound on because the captions made them curious. | Burn in large captions. The story must work with no sound at all. Add explicit "sound on" payoffs. | [Digiday/Sharethrough](https://digiday.com/sponsored/75-percent-of-people-watch-mobile-videos-on-mute/), [Verbit summary of Verizon/Publicis](https://verbit.ai/sound-on-sound-off-64-marketers-using-video-see-benefit-of-captions/), [Storyblocks](https://www.storyblocks.com/resources/blog/video-captioning) |
| X's own creative guidance: grab attention with movement in the first few seconds, add captions or text overlays for sound-off viewing, keep branding persistent (logo in the upper left), and use short videos for higher completion (their figure is under 15 s, for ads). | Frame 0 is already bright and moving and already shows the hook text. A small AURORA bug sits top left. Keep the organic cut under 1 minute. | [X Business creative best practices](https://business.x.com/en/advertising/creative-best-practices) (read through search summaries; the page returned HTTP 402 to the fetcher) |
| Videos of 60 s or less loop automatically on X (a change reported in 2019; confirm on a test post). | The end card has to lead back into the hook. The music seam must be click-free and harmonically smooth. | [Digital Information World](https://www.digitalinformationworld.com/2019/02/under-60-seconds-twitter-videos-loop.html) |
| Length sweet spot: about 20–45 s holds viewers, and under 60 s is best for completion. | 46 s: long enough to prove depth, short enough to loop. | [HeyOrca 2026 specs](https://www.heyorca.com/blog/x-twitter-media-specs-best-practices-2026), [Zebracat](https://www.zebracat.ai/post/how-viral-twitter) |
| Specs: MP4, H.264 + AAC; 16:9 at 1920×1080 or 1280×720; accepted aspect ratios run from 1:2.39 to 2.39:1; 30 or 60 fps; up to 512 MB; up to 2:20 for standard accounts. | Master at 1920×1080 H.264 High with AAC 48 kHz. | [HeyOrca](https://www.heyorca.com/blog/x-twitter-media-specs-best-practices-2026), [CapCut/Filmora spec summaries](https://www.capcut.com/resource/twitter-video-sizes), [PostFast](https://postfa.st/sizes/x/video) |
| Aspect ratio: 9:16 opens X's immersive, sound-on viewer, and 1:1 or 4:5 take more space in the mobile feed. 16:9 is the standard for landscape clips and is what a desktop app UI needs. | Master in **16:9** so the desktop UI stays legible. Offer an optional **4:5** cut with big caption bands (§8). | [PostEverywhere](https://posteverywhere.ai/blog/x-twitter-aspect-ratios), [XO3D Labs](https://labs.xo3d.co.uk/twitter-video-size/) |
| "Built with AI" demos that go viral lead with the finished thing in motion and one surprising constraint, then tell the build story with concrete numbers. The best-known case is @levelsio's vibe-coded flight sim, built in public on X with short clips; the saga passed 100 M views. | Result first (the aurora and the UI), then an unexpected constraint (*Claude can't hear*), proof of depth, the "how" with 3–4 hard numbers, and a loop. | [levels.io](https://levels.io/fly-pieter-com-vibecoded-flight-simulator), [VibeCoding.Wiki](https://www.vibecoding.wiki/showcase/fly-pieter-com-by-levelsio/) |

Resulting structure: **hook (constraint) → reveal (logo on the drop) → beat-synced proof montage → the answer to the hook (spectrograms) → the build in numbers → emotional button → loop.**

---

## 2. What the app gives us (exploration notes)

I explored the app with headless Chrome over CDP at 1920×1080. WebGL2 renders on the M5 GPU (ANGLE Metal). The most striking and legible moments, with their reference frames:

1. **Theater mode, clean plate.** Full-screen WebGL aurora with the UI hidden by CSS. In songs mode the palette follows the song's position in the list: Aurora Dreams gets `aurora` (green/violet), **Neon Nights gets `sunset` (pink/gold)**, Lo-fi Rain gets `ocean`. The curtains move with the song. *Light pillars and ripple rings appear only for notes played on the user's synth*, so a wide chord played "along" with the song makes it explode (`S03-drop-chord-pillars.png`). Measured on stills, the song alone raises bright pixels from about 1 % to 3–6 % at the drop. A 12-note chord fills the whole width.
2. **Main hero with a chord.** Stellar Supersaw in the sunset palette with pillars and rings. This is the single most "wow" UI frame (`S04-main-ui-en-supersaw-chord.png`). The palette changes with the category: keys/pad/fx use aurora, bass/lead/strings/drum use sunset, and pluck/bell/arp use ocean. Flipping presets therefore changes the colours on screen.
3. **Wavetable:** Singularity's Osc 1 "Harmonic Sweep" as a stacked 3-D frame view that scans when Shape moves (`S06a-*`).
4. **FM:** Platinum Ballad's 4-operator algorithm diagram plus 8 algorithm tiles (`S06b-*`).
5. **Physical model:** Celestial Carillon, with model buttons for string, bar, bell, glass, membrane, plate and exciter buttons for pluck, mallet, bow, breath (`S06c-*`).
6. **Filter:** Acid Serpent's ladder response curve with a resonant peak (`S06d-*`).
7. **Sound tour, Acid Bass step 8.** The cutoff knob is ringed in green, the curve's peak slides, and the typewriter caption pill reads "8/12 The classic move: slowly open the cutoff…" (`S07-*`).
8. **Magic:** the 4×4 mood grid, then tapping "Ethereal" shows a change log (↑ reverb shimmer, mix, size, decay…). With the FX tab open, the same mood visibly glides the Delay and Reverb knobs (`S08a/b-*`).
9. **Jam:** the synthwave style, set to A minor at 104 BPM (the same tempo as the bed), gives a glowing piano roll with a playhead and a "NOW G → Am(add9)" chord readout (`S09-*`).
10. **Songs:** 6 cover cards plus a 6-lane player with the section timeline, playhead and lane meters (`S10-*`).
11. **Renders gallery** at `/renders/`: 113 offline renders, each with a spectrogram and metrics (Peak, LUFS, Centroid, Width, Tail, RTF). This is the literal evidence of how Claude "heard" the sounds (`S11-*`).
12. **Splash wordmark** "AURORA 極光", gradient from cyan through violet to pink, on a blurred aurora (`S14-splash-wordmark-ref.png`). Use it as the reference for the end-card type.

**Songs by the numbers** (`renders/songs/*/*.json` and per-beat RMS computed from the WAVs):

| Song | BPM | Loudest section (LUFS) | Usable drop? |
|---|---|---|---|
| **Neon Nights** | 104 | Overdrive −13.7, Neon Skyline −13.9 | **Yes.** The breakdown sits at −19…−22 dB RMS per beat and builds to −17 over beats 184–191. **Beat 192 hits hard:** the kick returns with an attack at −12.7 dB. |
| Crystal Caves | 100 | Heart of Crystal −12.9 (the loudest of any song) | A cinematic swell, not a drop: 112→128 rises from −19.4 to −15.7 and then plateaus. |
| Pulse City | 124 | Peak Time −14.7 | The drop at beat 188 falls on a pickup bar, and the mix is quieter overall (−16.2). |
| Aurora Dreams | 88 | Aurora Bloom −13.4 | Too gentle for a hook. |

The chosen excerpt, beats 184–264, measures **−13.9 LUFS integrated, −1.8 dBTP true peak, LRA 1.2** (BS.1770, `tools/analyze.mjs`). It needs no loudness processing for social.

---

## 3. Music bed

**Song:** `neon-nights` (A minor, 104 BPM). The parts are Anvil Kick, Cobalt Snare, Quicksilver Hats, Rubber Pulse bass, Starfall Brass pad and Polaris Sync lead, all factory presets and all composed by a Claude agent.

- **1 beat = 0.576923 s** (17.31 frames at 30 fps, 34.62 frames at 60 fps). **1 bar = 2.307692 s.**
- Excerpt: song beats **184 → 264**, which is song time **106.153846 s → 152.307692 s**, **46.153846 s** long, or samples **5 095 385 → 7 310 769** at 48 kHz.
- Harmony: beat 184 is on **Dm**, beat 188 on **E** (a dominant, so tension), beat **192 on Am (the drop)**, …, beat 256 on Am and beat 260 on Fmaj7. The loop goes Fmaj7 → Dm, which is smooth because the chords share F and A.
- Video time for any song beat *b*: **t = (b − 184) × 0.576923 s**.

```bash
# render with the app's own engine (identical to the browser: every part through Ensemble + safety limiter)
node tools/render-song.mjs --song neon-nights --bits 24          # → renders/songs/neon-nights/neon-nights.wav
ffmpeg -i renders/songs/neon-nights/neon-nights.wav \
  -af "atrim=start_sample=5095385:end_sample=7310769,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.008,afade=t=out:st=46.094:d=0.06" \
  -c:a pcm_s24le renders/video/bed-neon-b184-264.wav
# export: AAC-LC 48 kHz stereo 256–320 kbps. No limiter or normalisation needed (−13.9 LUFS, −1.8 dBTP).
```

The 8 ms fade-in and 60 ms fade-out keep X's loop restart click-free. The loop jumps from the full outro into the filtered breakdown, which sounds like a deliberate DJ-style reset.

**Alternatives if the team wants a different mood:**
- *Cinematic:* `crystal-caves`, 100 BPM, beats **112 → 192** (Awakening build into Heart of Crystal) = **48.000 s**. Each beat is exactly 0.6 s (18 frames at 30 fps), which makes frame-perfect cuts easy. The drop is soft, so the reveal lands on the swell at beat 128 (t = 9.6 s).
- *Club:* `pulse-city`, 124 BPM. The breakdown runs 160–187 and the return comes at beat 188. It's usable, but the mix is quieter.

---

## 4. Hook lines

| # | EN | zh-TW | Notes |
|---|---|---|---|
| **A (pick)** | **Claude can't hear.** → *It built a synth anyway.* | **Claude 聽不見。** →「但它還是做出了一台合成器。」 | A curiosity gap in 3 words. It is true and surprising, and it gets answered at 30 s (spectrograms) and closed at 39 s ("has never heard it"). |
| B | An AI that can't hear built this synthesizer. | 一個聽不見的 AI，做出了這台合成器。 | The same idea in one line. It is longer, so it is harder to read at thumbnail size. |
| C | 0 samples. 0 dependencies. 47 Claude agents. | 零取樣、零套件、47 個 Claude 代理人。 | Numbers first, for developer Twitter. It stops fewer non-developers. |
| D | I asked Claude for the best synth it could build. | 我請 Claude 做出它能做到最好的合成器。 | A first-person story hook. It is accurate: the user asked in Chinese, over several messages. It's a good post first line but a weaker video frame. |

Phone check: a 156 px caption at 1080p is about 32 px tall in a 390 px-wide feed player and reads well (`S01-hook-phone-390px.png`).

---

## 5. Shot list

Each shot gives: timecodes in song beats, video seconds and frames at 30 fps; what is on screen; the exact app state; the camera move; the captions in EN and zh; and why the shot is there. **Camera zoom targets are in 1920×1080 UI pixels at 1.0×.** Shots S01–S03 and S13–S14 are real theater-mode captures of Neon Nights in sync with the bed (§7.4). Every other shot is a UI capture cut to the beat grid.

### Overview

| # | Song beats | Video time (s) | Frames at 30 fps | Content | EN caption | zh caption |
|---|---|---|---|---|---|---|
| S01 | 184–188 | 0.000–2.308 | 0–69 | Theater aurora (sunset) with pillars | **Claude can't hear.** | **Claude 聽不見。** |
| S02 | 188–192 | 2.308–4.615 | 69–138 | Same shot, push in (the build) | It built a synth anyway. | 但它還是做出了一台合成器。 |
| S03 | 192–196 | 4.615–6.923 | 138–208 | **DROP:** 12-note chord explodes across the aurora, wordmark slams in | AURORA 極光 / A synthesizer built by Claude | AURORA 極光 / 一台由 Claude 打造的合成器 |
| S04 | 196–200 | 6.923–9.231 | 208–277 | Full UI in a generic browser frame, chord bloom | Runs entirely in a browser tab. | 完全在瀏覽器分頁裡執行。 |
| S05 | 200–208 | 9.231–13.846 | 277–415 | 8 preset flips, one per beat, palette swaps | 100 presets. Zero samples. | 100 個音色，零取樣。 |
| S06 | 208–216 | 13.846–18.462 | 415–554 | 4 engine close-ups, half a bar each | Wavetable · 4-operator FM · Physical modelling · Ladder filter | 波表合成 · 四運算子 FM · 物理模型 · Ladder 濾波器 |
| S07 | 216–220 | 18.462–20.769 | 554–623 | Acid tour: cutoff knob turns itself | Knobs that turn themselves. | 旋鈕會自己轉。 |
| S08 | 220–224 | 20.769–23.077 | 623–692 | Tap "Ethereal", then Reverb/Delay knobs glide | One tap: "more ethereal." | 按一下：「更空靈」。 |
| S09 | 224–228 | 23.077–25.385 | 692–762 | Jam piano roll at 104 BPM | It improvises, too. 7 styles. | 還會自己即興，7 種風格。 |
| S10 | 228–236 | 25.385–30.000 | 762–900 | Song player playing Neon Nights (real sync) | 6 songs, composed by Claude. → **You're hearing one right now.** | 6 首原創曲，Claude 作曲。→ **你正在聽的，就是其中一首。** |
| S11 | 236–244 | 30.000–34.615 | 900–1038 | Spectrogram of this song, then the renders gallery | So it tuned by sight: → spectrograms + loudness meters. | 所以它用「看」的調音：→ 頻譜圖 + 響度量測。 |
| S12 | 244–252 | 34.615–39.231 | 1038–1177 | 47 agent nodes in 4 waves, then a numbers grid | 47 Claude agents built it. / 46,742 lines · 0 dependencies · 0 samples · 308 tests | 47 個 Claude 代理人合力打造。/ 46,742 行程式碼 · 0 依賴套件 · 0 取樣音檔 · 308 項測試 |
| S13 | 252–256 | 39.231–41.538 | 1177–1246 | Theater aurora, calm | **Claude has never heard it.** | **Claude 從來沒聽過它。** |
| S14 | 256–264 | 41.538–46.154 | 1246–1385 | End card: "Your turn", then wordmark + Built with Claude Code, then loop | Your turn. Sound on. → AURORA 極光 · Built with Claude Code | 換你聽聽看，打開聲音。→ AURORA 極光 · 用 Claude Code 打造 |

At 60 fps, double the frame numbers (for example, the drop lands on frame 277 and the end on frame 2769).

### S01 — Hook · beats 184–188 · 0.000–2.308 s · frames 0–69

- **On screen:** a full-bleed theater aurora in the **sunset** palette (pink, gold, violet) with 9–12 glowing light pillars and ripple rings, and huge white text centred. **The text is visible from frame 0 with no fade-in.** Frame 0 doubles as the poster.
- **App state:** theater, songs mode, Neon Nights playing, clean plate (§7.3). The user patch is **Stellar Supersaw**. At **song beat 182.5** (0.87 s before frame 0), play a **Dm** spread: MIDI 38 45 50 53 57 62 65 69 74, vel 1.0, held 1.8 s. This way the pillars peak at frame 0.
- **Camera:** static at 1.0×, with a slow drift (1.00 → 1.03 over the bar, anchored at 960, 520).
- **Overlay:** EN **Claude can't hear.** in Inter 800, 156 px, tracking −2.5 %. zh **Claude 聽不見。** in Noto Sans TC 700, 150 px, tracking +4 %. Put a soft radial scrim behind the text (ellipse 62 %×34 %, rgba(5,6,12,.62) → 0) plus a text shadow of 0 4 48 px rgba(0,0,0,.6). References: `S01-hook-en.png`, `S01-hook-zh.png`.
- **Why:** muted viewers get a bright moving image and a 3-word paradox at the same moment. It creates the open loop the rest of the video answers.

### S02 — Turn · beats 188–192 · 2.308–4.615 s · frames 69–138

- **On screen:** the same aurora while the music builds. The text swaps on the downbeat.
- **App state:** keep playing. At **beat 188**, play an **E** chord (40 47 52 56 59 64 68 71, vel 0.8, held 1.5 s); the bed is on E here.
- **Camera:** push 1.03 → 1.12 over the bar, anchored at 960, 520. The tension rises with the riser.
- **Overlay:** EN *It built a synth anyway.* (110 px, 800). zh「但它還是做出了一台合成器。」(104 px, 700). Bottom-right, from 2.8 s to 4.5 s: a small pill with a speaker glyph reading **"sound on"** / 「開聲音」 at 44 px, 70 % opacity.
- **Why:** it resolves the paradox into a promise. The sound-on pill is placed right before the drop so anyone who taps catches it.

### S03 — Drop / reveal · beats 192–196 · 4.615–6.923 s · frames 138–208

- **On screen:** on the downbeat (frame 138) the aurora **explodes**: 12 pillars across the full width plus rings. The **AURORA 極光** wordmark slams in, scaling from 1.12 to 1.0 over 4 frames, with a 2-frame white flash at 35 %. At beat 194 (frame 173) a subline fades in over 6 frames.
- **App state:** at **song beat ≥ 191.98** (poll `getSongState().beat`), play **Am** across 5 octaves: 33 40 45 52 57 60 64 69 72 76 81 84, vel 1.0, held 2.5 s (`S03-drop-chord-pillars.png`). Retrigger the top 6 notes at beat 194 for a second bloom.
- **Camera:** a hard cut back to 1.0× on the downbeat (from S02's 1.12), then a slow pull-out to 0.97.
- **Overlay:** the wordmark "AURORA" in Inter 800 at 190 px, letter-spacing 0.18 em, gradient #5cf2ff → #a78bfa → #ff6bd6 (the app's own logo gradient; see `S14-splash-wordmark-ref.png`), plus a smaller white "極光". Subline EN *A synthesizer built by Claude* / zh「一台由 Claude 打造的合成器」at 64 px, 600.
- **Why:** this is the audio-visual payoff and the first moment sound-on viewers go "oh". The core claim (Claude built this) is on screen before 7 s for people who leave early.

### S04 — "It's a web page" · beats 196–200 · 6.923–9.231 s · frames 208–277

- **On screen:** the full AURORA UI inside a **generic, unbranded browser window frame** composited in post: dark title bar, three dots, and one tab with the AURORA favicon reading "AURORA 極光", **with no URL text**. The frame sits on a dark gradient. On the downbeat a chord blooms pillars in the hero.
- **App state:** main view in the cut's language, preset **Stellar Supersaw**, Sources tab. At beat 196 play Am (45 57 60 64 69 72 76, vel 1.0, held 1.6 s). See `S04-main-ui-en-supersaw-chord.png`.
- **Camera:** window at 0.80× scale, pushing to 0.88× over the bar, anchored on the hero (925, 270).
- **Overlay:** EN *Runs entirely in a browser tab.* / zh「完全在瀏覽器分頁裡執行。」, lower third (§6).
- **Why:** it shows the "it's just a web page?!" factor and makes the scale of the UI legible. Every sound is computed live in that tab.

### S05 — Preset flips · beats 200–208 · 9.231–13.846 s · frames 277–415

- **On screen:** one **preset change per beat**, each with a chord hit. The title, category chip, hero palette, source view and preset-list highlight all jump together.
- **App state:** run a 104 BPM script. On each beat *k*: load the preset, wait 40 ms, play Am (45 52 57 60 64 69, vel 0.95, released after 0.45 s). In post, align the first load to frame 277.

  | Beat | t (s) | Frame | Preset | Category → palette |
  |---|---|---|---|---|
  | 200 | 9.231 | 277 | Ivory Hall Grand | Keys (physical piano) → aurora |
  | 201 | 9.808 | 294 | Acid Serpent | Bass → sunset |
  | 202 | 10.385 | 312 | Celestial Carillon | Bell (physical) → ocean |
  | 203 | 10.962 | 329 | Stellar Supersaw | Lead → sunset |
  | 204 | 11.538 | 346 | Jade Guzheng | Pluck (physical) → ocean |
  | 205 | 12.115 | 363 | Event Horizon | Pad → aurora |
  | 206 | 12.692 | 381 | Autumn Moon Erhu | Strings (bowed physical) → sunset |
  | 207 | 13.269 | 398 | Singularity | FX → aurora (hands off to S06a) |

- **Camera:** beats 200–203 show the full UI at 1.0 → 1.06 so the preset list is visible. On **beat 204, hard cut** to a 1.5× crop of the hero (centre 922, 330), where the preset names read large and the palette swaps fill the frame.
- **Overlay:** EN *100 presets. Zero samples.* / zh「100 個音色，零取樣。」. Show the numbers in the logo gradient.
- **Why:** it proves breadth in 4.6 s with a colour strobe that matches the beat. The erhu and guzheng are a nod to the zh-TW audience.

### S06 — Engines · beats 208–216 · 13.846–18.462 s · frames 415–554 (4 half-bar shots)

| Sub | Beats | Video time (s) | Frames | Preset · tab | Action | Zoom target | EN / zh caption |
|---|---|---|---|---|---|---|---|
| 6a | 208–210 | 13.846–15.000 | 415–450 | Singularity · Sources › Osc 1 (Wavetable, "Harmonic Sweep") | Chord (45 52 57 64) at 208; `store.animate({'osc1.shape': 0.95}, {ms: 1100})` from 0.30 so the frame stack scans | 1.7× @ (760, 690) | Wavetable / 波表合成 |
| 6b | 210–212 | 15.000–16.154 | 450–485 | Platinum Ballad · Sources › FM | `store.set('fm.algo', n)` for n = 1, 3, 5, 8, one per eighth note (every 0.288 s); chord (52 59 64 68 71) at 210 | 1.6× @ (1048, 700) | 4-operator FM / 四運算子 FM |
| 6c | 212–214 | 16.154–17.308 | 485–519 | Celestial Carillon · Sources › Physical | `store.set('phys.model', m)` for string → bar → bell → glass, one per eighth note, each followed by a struck note (72, 76, 79, 84) | 1.6× @ (1048, 690) | Physical modelling / 物理模型 |
| 6d | 214–216 | 17.308–18.462 | 519–554 | Acid Serpent · Filter (scroll so the panel sits at y 265–790, as in `S07-*`) | `store.animate({'filter.cutoff': 2400, 'filter.res': 0.8}, {ms: 1100})` from 200 Hz, with a held note (33) | 1.6× @ (700, 540) | Ladder filter / Ladder 濾波器 |

- **Persistent top-left label during S06:** *Real-time DSP · plain JavaScript* / 「純 JavaScript 即時運算」 at 40 px, 80 %.
- **Transitions:** hard cuts on each half bar. Add a 3-frame 1.04× punch-in at the start of each sub-shot.
- **Why:** it shows depth for the synth crowd. Each engine is a distinct, instantly readable diagram: a wave stack, operator boxes, instrument icons and a resonant curve.

### S07 — Knobs turn themselves · beats 216–220 · 18.462–20.769 s · frames 554–623

- **On screen:** Sound Tour "Acid Bass", **step 8/12**: the green ring on **Cutoff**, the knob rotating, the curve's resonant peak sliding right, and the tour's typewriter caption pill at the bottom (EN "The classic move: slowly open the cutoff…", zh「最經典的一招：慢慢把截止頻率轉開……」).
- **App state:** `aurora.center.tours.start(TOURS[3])` (acid-bass, 124 BPM). Step 8 starts at tour beat 56, which is **27.1 s after start**. Record 25–33 s and use the 2.31 s window where the cutoff is visibly moving (see `S07-tour-acid-step8.png`). Tours auto-scroll the editor and ring the focused control.
- **Camera:** 1.35× @ (780, 560), which includes the curve, the ringed knob and the caption pill. Add a gentle 1.35 → 1.42 drift.
- **Overlay:** EN *Knobs that turn themselves.* / zh「旋鈕會自己轉。」, subline *6 guided sound tours* / 「6 段自動音色導覽」.
- **Why:** it's the "it plays itself" delight and is instantly understandable without sound.

### S08 — One-tap mood · beats 220–224 · 20.769–23.077 s · frames 623–692

- **8a, beats 220–222 (frames 623–658):** Demo Center › Magic. A rendered cursor (soft white circle) **taps "Ethereal / 更空靈"** on beat 220. The button flashes (`is-fired`) and the change log appears (↑ Reverb shimmer, ↑ mix, ↑ size…). Zoom 1.5× @ (505, 470). App: `aurora.center.open('magic')`, then click the `.mt-mood` button that contains *Ethereal* or *更空靈*. The current preset is **Sunset Poly**. See `S08a-magic-ethereal.png`.
- **8b, beats 222–224 (frames 658–692):** a cut to the main UI with the **FX tab** open. The **same mood** glides the Delay and Reverb knobs over 700 ms, starting on beat 222, with a chord (57 60 64 67 71). This runs the button's own code path (§7.6). Zoom 1.45× @ (1370, 740), covering the Delay and Reverb panels (`S08b-fx-glide.png`).
- **Overlay:** EN *One tap: "more ethereal."* / zh「按一下：「更空靈」。」
- **Why:** it makes the idea of *sound design without knob knowledge* concrete: one plain word turns into more than a dozen parameter moves (13–14 for Sunset Poly).

### S09 — Jam · beats 224–228 · 23.077–25.385 s · frames 692–762

- **On screen:** the Jam piano roll (Synthwave, **A minor, 104 BPM**) with the glowing playhead sweeping, notes lighting as they play, and the "NOW" chord readout.
- **App state:** open `'jam'`, click the Synthwave `.jam-style`, set `.jam-range[0]` to 104 and `.jam-select[0]` to '9' (A) and `[1]` to 'minor', then click `.jam-play`. The user preset is Sunset Poly or Polaris Sync. The roll's tempo matches the bed, so the playhead moves in time with the music even though the jam's notes aren't heard.
- **Camera:** 1.25× @ (865, 390). Pan slightly to follow the playhead.
- **Overlay:** EN *It improvises, too. 7 styles.* / zh「還會自己即興，7 種風格。」
- **Why:** it shows generative music, the "it plays with you" idea.

### S10 — The songs, with real sync · beats 228–236 · 25.385–30.000 s · frames 762–900

- **10a, beats 228–232 (frames 762–831):** the full Songs sheet: the 6 cover cards plus the Neon Nights player, with the "Overdrive" section highlighted, the playhead at x ≈ 1398 → 1413, and the lane meters bouncing. The capture is **the same song at the same beats as the bed**, so the playhead, meters and notes match the music exactly (§7.4). Camera 1.0 → 1.08. Caption EN *6 songs, composed by Claude.* / zh「6 首原創曲，Claude 作曲。」
- **10b, beats 232–236 (frames 831–900):** 1.6× @ (1300, 590) on the lanes around the playhead, with lead, brass and bass notes crossing it. Caption EN **You're hearing one right now.** / zh **你正在聽的，就是其中一首。**
- **App state:** `aurora.center.open('songs')`, click `.sv-card` [1] (Neon Nights), then `.svp-play`. Log `getSongState().beat` for every captured frame. Lane x-position: x(b) = 555 + 1065·b/288.
- **Why:** it's the biggest sound-on reward. The music the viewer has been hearing was composed by Claude and is played by this synth.

### S11 — How can it tune if it can't hear? · beats 236–244 · 30.000–34.615 s · frames 900–1038

- **11a, beats 236–240 (frames 900–969):** `renders/songs/neon-nights/neon-nights-spectrogram.png` (1400×500, rendered by `tools/render-song.mjs`) at 1.3× on #07080d. A thin glowing white **playhead** sits at the current song time: x_img ≈ 58 + t × 7.42 px, which moves from t = 136.15 to 138.46 s (verify against the axis ticks). Push 1.0 → 1.25 toward the playhead. Caption EN *So it tuned by sight:* / zh「所以它用「看」的調音：」. Small label: *Neon Nights, the song you're hearing, as a spectrogram* / 「你正在聽的〈霓虹夜色〉，畫成頻譜圖」.
- **11b, beats 240–244 (frames 969–1038):** `http://localhost:5173/renders/` ("113 renders"). A smooth fast scroll of about 2400 px over the bar through cards of spectrograms and metrics (Peak, LUFS, Centroid, Width, Tail, RTF). Optionally add a slight 3-D tilt. Caption EN *spectrograms + loudness meters.* / zh「頻譜圖 + 響度量測。」 See `S11-renders-gallery.png`.
- **Why:** it answers the hook. The claim is exactly the verified fact: Claude tuned sounds with loudness and spectral metrics and by looking at spectrogram images it rendered. The images are real artifacts from the build.

### S12 — The build in numbers · beats 244–252 · 34.615–39.231 s · frames 1038–1177

- **12a, beats 244–248 (frames 1038–1108), motion graphic:** a centre pill reading "Claude Code". **47 glowing nodes** appear in 4 waves, one wave per beat, with lines drawing from the centre over 6 frames. A counter in the top right ticks up to 47.

  | Beat · frame | Wave (colour) | Nodes | Small label EN / zh |
  |---|---|---|---|
  | 244 · 1038 | Build (#3ef0b0) | 11 | 10 module builders + integration lead / 10 個模組 + 整合 |
  | 245 · 1056 | Sound & demos (#5cf2ff) | 20 | 10 sound designers, 5 demo/visual engineers, 3 composers, 2 QA leads / 10 音色設計、5 示範與視覺、3 作曲、2 品管 |
  | 246 · 1073 | Review (#a78bfa) | 15 | 5 reviewers, 5 adversarial verifiers, 4 fixers, 1 regression lead / 5 審查、5 挑錯驗證、4 修復、1 回歸 |
  | 247 · 1090 | Polish (#ff6bd6) | 1 | 1 i18n fixer / 1 語系修正 |

  Background: a 30 % blurred theater frame. Caption EN **47 Claude agents built it.** / zh **47 個 Claude 代理人合力打造。**
- **12b, beats 248–252 (frames 1108–1177):** a 2×2 grid that fills **one cell per beat**. Numerals in Inter 800 at 170 px in the logo gradient, labels at 44 px:

  | Beat · frame | Number | EN label | zh label |
  |---|---|---|---|
  | 248 · 1108 | 46,742 | lines of code | 行程式碼 |
  | 249 · 1125 | 0 | dependencies | 個依賴套件 |
  | 250 · 1142 | 0 | audio samples | 個取樣音檔 |
  | 251 · 1160 | 308 | automated tests | 項自動測試 |

- **Why:** this is the "how did Claude do that" moment, with hard numbers a developer can quote. "0 dependencies / 0 samples" lands with the developer crowd.

### S13 — The button · beats 252–256 · 39.231–41.538 s · frames 1177–1246

- **On screen:** a return to the theater aurora (Neon Nights, clean plate, song-reactive curtains, no pillars). It's calm while the music is still at full power.
- **Camera:** a slow pull-out from 1.08 to 1.0.
- **Overlay:** EN **Claude has never heard it.** / zh **Claude 從來沒聽過它。** Centred at 120 px.
- **Why:** it's the emotional turn that closes the hook's loop. It's accurate because Claude cannot hear.

### S14 — End card and loop · beats 256–264 · 41.538–46.154 s · frames 1246–1385

- **14a, beats 256–260 (frames 1246–1315):** same aurora (Tail Lights). At beat 256 play a soft Am chord (45 52 57 60 64, vel 0.7) for a last bloom. Caption EN **Your turn. Sound on.** / zh **換你聽聽看，打開聲音。**, with the speaker glyph.
- **14b, beats 260–264 (frames 1315–1385):** the **AURORA 極光** wordmark (as in S03) plus **Built with Claude Code** / **用 Claude Code 打造** at 64 px, and a small line *Claude Opus 5.5* at 36 px, 60 %. On the last beat (from frame 1367), fade all text out over 12 frames and keep the aurora, so the loop restart cuts cleanly to S01's text-on-aurora.
- **Why:** it gives credit and a call to action. It also tells muted viewers to rewatch with sound, and X replays the video automatically.

**Persistent brand bug from S04 to S13:** "AURORA 極光" at 28 px, 55 % opacity, top left (x 48, y 40), with a tiny "built with Claude Code" underneath. This follows X's persistent-branding guidance and helps people who join mid-loop.

---

## 6. Caption style and safe zones

- **Fonts:** Inter 800 for EN and Noto Sans TC 700 for zh. Both are the app's own web fonts. Captions are white. Numbers and key words use the logo gradient (#5cf2ff → #a78bfa → #ff6bd6).
- **Sizes at 1080p:** hook 150–156 px; section captions **88–104 px**, which is about 18–21 px on a 390 px-wide phone player; sublines 44–64 px, never below 40 px.
- **Position:** centred for aurora shots. For UI shots use a lower-third band, baseline at y ≈ 880, on a bottom scrim (linear gradient rgba(5,6,12,.75) → 0 over the bottom 38 %).
- **Safe area:** keep text inside x 120–1800 and y 80–930. X overlays the timer, mute and fullscreen controls at the bottom.
- **Timing:** captions cut **on the beat** (frames in §5) with a 4-frame fade-in and a 3-frame fade-out, except S01, which is visible from frame 0. Never show more than one caption plus one subline at a time.
- **zh copy:** natural Taiwanese Mandarin with full-width punctuation. Don't put a full stop on the wordmark lines.
- **Length:** every EN caption is 6 words or fewer. The zh captions match.

---

## 7. Capture recipes

**7.1 Chrome and CDP.** Use `launchChrome` from `tools/video/capture/chrome.mjs`: it picks a free debugging port (9900–9999) and a private `--user-data-dir`. If you drive Chrome yourself, check the port first with `lsof -iTCP:<port> -sTCP:LISTEN` — a port already taken by another Chrome makes "localhost" resolve into the wrong browser. Always close Chrome when you're done. Viewport is 1920×1080. Use `deviceScaleFactor: 2` for shots zoomed more than 1.3× so they stay sharp.

**7.2 Boot.** Set `localStorage['aurora.lang'] = 'en'` or `'zh'` before the page loads (or click `button.lang`). Click `.splash__start` and wait for `!aurora.audio.isNull`. Close the first-visit coach with `.coach__x`. Hide toasts with `#toasts{opacity:0!important}`: switching presets after an edit shows "Preset switched — Undo…". Headless audio is muted, which is fine because the audio comes from the offline render. The debug handle is `globalThis.aurora = { store, library, audio, editor, startDemo, stopDemo, center }`.

**7.3 Helpers.**
```js
const load  = n => document.querySelector(`.prow[data-key="f:${n}"]`).click();            // factory preset by name
const edTab = re => [...document.querySelectorAll('[role=tab]')].find(t => re.test(t.textContent.trim())).click();
// editor tabs: EN 'Sources聲源' 'Filter濾波' 'Mod調變' 'FX效果' 'Perform演奏'; zh '聲源Sources' '濾波Filter' … (match /^FX\s*效果/ —
// /^FX/ alone hits the "FX & Texture" category chip first). Source sub-tabs: /^Osc 1/ /^FM/ /^Physical/ (zh /^振盪器 1/ /^FM 合成/ /^物理模型/)
const chord = (ns, v = 1, ms = 1500) => { ns.forEach(n => aurora.audio.noteOn(n, v)); setTimeout(() => ns.forEach(n => aurora.audio.noteOff(n)), ms); };
aurora.store.animate({ 'osc1.shape': 0.95 }, { ms: 1100 });   // knobs glide visibly (transient)
aurora.store.set('fm.algo', 5); aurora.store.set('phys.model', 'glass');
// theater clean plate:
// .th__top,.th__caption,.th__bottom,.th__changing,.th__parts,.th__macros,.th__prog,#toasts{opacity:0!important}
```

**7.4 Theater on Neon Nights, synced to the bed.**
```js
const { SONGS } = await import('/src/demo/songs/index.js');
aurora.center.open('theater');
[...document.querySelectorAll('.th-l__chips button')].find(b => /All songs|示範曲連播/.test(b.textContent)).click();
aurora.center.close();
aurora.center.theater.enter({ startAt: SONGS[1] });   // pass the song OBJECT; an index is ignored
```
Record the whole song once (about 2:50) and, for every frame, log `aurora.audio.getSongState().beat` against `performance.now()`. State arrives at about 30 Hz, so interpolate between updates. Then keep only the frames whose beat falls in the shot's range. The engine is deterministic, so these frames line up with `render-song`'s WAV beat for beat. Fire the S01, S02, S03 and S14 chords from a poller on `getSongState().beat`. For the pillars, the user patch should be **Stellar Supersaw**, loaded before entering theater. Songs mode doesn't take over the user synth.

**7.5 Tours, Jam, Songs.**
```js
const { TOURS } = await import('/src/demo/tours/index.js');   // [supersaw-pad, fm-epiano, string-journey, acid-bass, space-magic, epic-lead]
aurora.center.tours.start(TOURS[3]);                            // stop: aurora.center.tours.stop({ revert: true, silent: true })
// Jam: see S09. Songs: aurora.center.open('songs'); document.querySelectorAll('.sv-card')[1].click(); document.querySelector('.svp-play').click();
// Stop everything: aurora.center.stopAll(); aurora.center.theater.exit();
```

**7.6 The mood glide with the editor visible (the same code path as the button, `src/ui/demo/smart.js`).**
```js
const { applyMoods } = await import('/src/demo/moods.js');
const ch = applyMoods(aurora.store.committedValues(), [{ id: 'ethereal', amount: 0.8 }], { category: aurora.store.getMeta().category });
aurora.store.animate(ch, { ms: 700, ease: 'inOut', commit: 'mood:ethereal', owner: 'smart' });   // ~14 params glide on Sunset Poly
```

**7.7 Gotchas.**
- The keyboard dock covers y ≥ 930 in the main view.
- In the EN UI, the hero's preset *description* line stays in Chinese. Crop it out or accept it.
- Tours scroll the editor, so frame positions shift.
- Screenshots over CDP take about 0.45 s each. Record the screen (screencast or `Page.startScreencast`) for moving shots, not stills.

---

## 8. Alternative cut: 4:5 (1080×1350) for mobile-first reach

X accepts aspect ratios from 1:2.39 to 2.39:1. In the mobile feed, 4:5 takes up about 1.9× the height of 16:9. The desktop UI is landscape, though, so a plain crop would cut it apart. Use a **stacked layout** instead:

- **Top band, y 0–300:** the caption at 84–96 px, always on screen. It's huge on phones.
- **Middle window, y 300–1110 (1080×810, 4:3):** UI shots re-framed with the zoom targets from §5 (1.6–2.0×; every panel target is ≤ 1080 px wide at 1.0×).
- **Bottom band, y 1110–1350:** the sublines and brand bug.
- **Aurora shots (S01–S03, S13–S14) go full-bleed and native.** The WebGL hero re-lays out at any size, so capture theater at 1080×1350 with `Emulation.setDeviceMetricsOverride`. Set the hook on 2 lines ("Claude / can't hear."), 150 px.
- **S12's** motion graphic re-flows to a vertical stack. **S05** uses only the 1.5× hero crop.

Preview the upload in X's composer before posting. If the in-feed crop looks wrong, fall back to 1:1 (1080×1080) with the same bands.

(Optional teaser: S01–S05 plus S14b, which is beats 184–208 followed by the end card, about 18 s, for a reply or an ad.)

---

## 9. Fact check (every on-screen claim)

| On-screen claim | Verified fact it rests on |
|---|---|
| Claude can't hear. / Claude has never heard it. | "Claude cannot hear." |
| It built a synth anyway. / A synthesizer built by Claude / Built with Claude Code | Built by Claude Code (Claude Opus 5.5) at the user's request, over several messages. We never say "one prompt", "in minutes" or "no humans". |
| Runs entirely in a browser tab. | "Runs entirely in a browser tab." |
| 100 presets. Zero samples. | 100 factory presets; no audio samples; every sound synthesized in real time. |
| Wavetable · 4-operator FM · Physical modelling · Ladder filter · plain JavaScript | The engine and filter list; AudioWorklet in plain JavaScript. |
| Knobs that turn themselves. / 6 guided sound tours | 6 animated sound tours in which the knobs turn themselves. |
| One tap: "more ethereal." | One-tap mood buttons ("more ethereal", …). **No number is stated:** the facts sheet says 14 buttons, but the app shows **16** (`src/demo/moods.js` `MOODS`). |
| It improvises, too. 7 styles. | Generative Jam in 7 styles. |
| 6 songs, composed by Claude. / You're hearing one right now. | 6 original songs composed by Claude agents. The bed is `neon-nights`, rendered by the app's engine. |
| So it tuned by sight: spectrograms + loudness meters. | Tuned every sound with loudness and spectral metrics and by looking at spectrogram images it rendered offline. |
| 47 Claude agents built it. (wave breakdown) | 47 agent runs: 10 + 1; 10 + 5 + 1 + 3 + 1; 5 + 5 + 4 + 1; 1. |
| 46,742 lines of code · 0 dependencies · 0 audio samples · 308 tests | The stated facts. |

**No URL appears on screen**; the GitHub link (https://github.com/pixbvr/aurora-synth) goes in the first reply.

## 10. Open questions and risks

- **Palette.** The sunset theater palette is warm and stands out in a blue-heavy feed, but the brand's "aurora" green only appears in the S05 flips. If the brand wants green for the hook and end card, start theater on Aurora Dreams. The curtains will then react to a different song than the bed, so the sync is no longer real, but the chord pillars still work.
- **Mood count.** The facts sheet says 14 mood buttons and the app has 16. Keep the number out of the video and the post, or correct the facts sheet.
- **"47 Claude agents".** This means 47 sub-agent runs, orchestrated by the Claude Code session. The thread copy spells out the waves.
