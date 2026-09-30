// Director-side stage extras for the X film (loaded into tools/video/director.html by the timelines):
//   await ctx.evalDirector(async () => { await import('/tools/video/timelines/stage.js'); return director.vx.install(); });
//   ctx.director.vx.frame(true)  ·  ctx.director.vx.spec.show({...})  ·  ctx.director.vx.gallery.show({...})
//
// Layers (stage = 1920×1080):
//   #vx-bg      under the camera: dark aurora-tinted backdrop (visible when the camera shows the app < 1×)
//   #vx-frame   inside the camera, behind the app iframe: a generic, unbranded browser window (title bar, 3 dots,
//               one tab "AURORA 極光", no URL) — moves and scales with the camera
//   #vx-layer   above the camera, below the overlay: full-frame shots that are not the app (spectrogram, renders gallery)

const W = 1920, H = 1080;
const $ = s => document.querySelector(s);
const mk = (tag, cls, parent, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; if (parent) parent.appendChild(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CSS = `
#vx-bg { position: absolute; inset: 0; opacity: 0; pointer-events: none;
  background:
    radial-gradient(60% 55% at 18% 18%, rgba(62, 240, 176, .20), transparent 70%),
    radial-gradient(55% 60% at 85% 12%, rgba(167, 139, 250, .26), transparent 70%),
    radial-gradient(70% 60% at 60% 110%, rgba(255, 107, 214, .20), transparent 70%),
    radial-gradient(50% 50% at 50% 50%, #0c1020, #05060b); }
#vx-frame { position: absolute; left: -2px; top: -54px; width: 1924px; height: 1136px; border-radius: 20px; display: none; pointer-events: none;
  background: #151927; box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .10), 0 50px 140px rgba(0, 0, 0, .75), 0 0 120px rgba(92, 242, 255, .12); }
#vx-frame .vx-bar { position: absolute; left: 0; right: 0; top: 0; height: 54px; display: flex; align-items: flex-end; padding: 0 0 0 26px; gap: 11px;
  border-radius: 20px 20px 0 0; background: linear-gradient(#1b2030, #151927); }
#vx-frame .vx-dot { width: 15px; height: 15px; border-radius: 50%; margin-bottom: 19px; flex: none; }
#vx-frame .vx-tab { position: relative; margin-left: 30px; height: 40px; min-width: 300px; padding: 0 22px; display: flex; align-items: center; gap: 12px;
  border-radius: 12px 12px 0 0; background: #07080d; color: #e7ebff; font: 500 19px/1 Inter, "Noto Sans TC", system-ui, sans-serif; letter-spacing: .01em; }
#vx-frame .vx-fav { width: 20px; height: 20px; border-radius: 50%; flex: none;
  background: conic-gradient(from 200deg, #3ef0b0, #5cf2ff, #a78bfa, #ff6bd6, #3ef0b0);
  -webkit-mask: radial-gradient(circle, transparent 5px, #000 5.5px); mask: radial-gradient(circle, transparent 5px, #000 5.5px); }
#vx-frame .vx-x { margin-left: auto; color: #6d7597; font-size: 18px; }
html.vx-framed #app { border-radius: 0 0 18px 18px; }
#vx-layer { position: absolute; inset: 0; z-index: 5; pointer-events: none; overflow: hidden; }
#vx-layer > * { position: absolute; inset: 0; visibility: hidden; }
#vx-layer > .is-on { visibility: visible; }
.vx-spec { z-index: 2; background: radial-gradient(90% 80% at 50% 45%, #0d1122, #05060b); }
.vx-spec__box { position: absolute; left: 0; top: 0; width: 2400px; height: 1000px; transform-origin: 0 0; }
.vx-spec__box img { position: absolute; left: 0; top: 0; width: 2400px; height: 1000px; display: block; border-radius: 10px;
  box-shadow: 0 30px 120px rgba(0, 0, 0, .7), 0 0 0 1px rgba(255, 255, 255, .06); }
.vx-spec__ph { position: absolute; top: 22px; width: 4px; margin-left: -2px; height: 956px; border-radius: 3px; background: #fff;
  box-shadow: 0 0 12px #fff, 0 0 30px rgba(92, 242, 255, .95), 0 0 70px rgba(167, 139, 250, .8); }
.vx-spec__ph::before { content: ""; position: absolute; left: -9px; top: -6px; width: 22px; height: 22px; border-radius: 50%; background: #fff;
  box-shadow: 0 0 16px #fff, 0 0 40px rgba(92, 242, 255, 1); }
.vx-spec__shade { position: absolute; top: 30px; height: 940px; left: 0; background: rgba(5, 6, 11, .45); }
.vx-spec__tag { position: absolute; top: 44px; left: 18px; padding: 8px 16px 9px; border-radius: 999px; white-space: nowrap;
  font: 700 26px/1 "JetBrains Mono", ui-monospace, monospace; letter-spacing: .08em; color: #05060b; background: #fff;
  box-shadow: 0 0 24px rgba(92, 242, 255, .9); }
.vx-gal { z-index: 1; background: #0a0c14; perspective: 2200px; perspective-origin: 50% 20%; }
.vx-gal img { position: absolute; left: 0; top: 0; width: 1920px; height: auto; display: block; transform-origin: 0 0; }
.vx-gal__fade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(10, 12, 20, .0) 60%, rgba(10, 12, 20, .85)); }
/* build-log excerpt (real transcript lines + the spectrograms the agent was shown) */
.vx-log { z-index: 3; background: radial-gradient(70% 60% at 50% 38%, #10152a, #05060b 75%); }
.vx-log__win { position: absolute; left: 248px; top: 22px; width: 1424px; border-radius: 22px; overflow: hidden; background: #0a0d17;
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .09), 0 40px 120px rgba(0, 0, 0, .7), 0 0 90px rgba(92, 242, 255, .10); }
.vx-log__bar { height: 52px; display: flex; align-items: center; gap: 11px; padding: 0 22px; background: linear-gradient(#171b2b, #11141f);
  font: 500 21px/1 "JetBrains Mono", ui-monospace, monospace; color: #8a93b8; letter-spacing: .02em; }
.vx-log__bar i { width: 13px; height: 13px; border-radius: 50%; flex: none; }
.vx-log__bar b { margin-left: 14px; color: #dfe5ff; font-weight: 600; }
.vx-log__bar em { margin-left: auto; font-style: normal; color: #05060b; background: #5cf2ff; padding: 6px 12px 7px; border-radius: 999px; font-weight: 700; letter-spacing: .08em; font-size: 18px; }
.vx-log__rows { position: relative; height: 196px; overflow: hidden; }
.vx-log__page { position: absolute; left: 0; right: 0; top: 0; padding: 18px 34px 0; }
.vx-log__row { height: 44px; display: flex; align-items: center; gap: 14px; white-space: nowrap; font: 500 29px/1 "JetBrains Mono", ui-monospace, monospace; color: #e7ebff; }
.vx-log__row .d { color: #3ef0b0; font-size: 22px; }
.vx-log__row .t { font-weight: 700; }
.vx-log__row .a { color: #b4bcdd; }
.vx-log__row.is-out { color: #8a93b8; padding-left: 36px; }
.vx-log__img { position: relative; width: 1344px; height: 480px; margin: 0 40px 18px; }
.vx-log__img img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; border-radius: 8px; }
.vx-log__box { position: absolute; border-radius: 10px; border: 5px solid #ff6b81; box-shadow: 0 0 0 2px rgba(0, 0, 0, .35), 0 0 34px rgba(255, 107, 129, .75), inset 0 0 34px rgba(255, 107, 129, .35); }
.vx-log__box.is-ok { border-color: #3ef0b0; box-shadow: 0 0 0 2px rgba(0, 0, 0, .35), 0 0 34px rgba(62, 240, 176, .7), inset 0 0 30px rgba(62, 240, 176, .25); }
.vx-log__wipe { position: absolute; top: -6px; bottom: -6px; left: 0; width: 6px; margin-left: -3px; border-radius: 3px; background: #fff; opacity: 0;
  box-shadow: 0 0 14px #fff, 0 0 40px rgba(62, 240, 176, .95), 0 0 90px rgba(92, 242, 255, .8); }
.vx-log__tag { position: absolute; left: calc(100% + 22px); top: 44%; transform: translateY(-50%); padding: 10px 22px 12px; border-radius: 999px; white-space: nowrap;
  font: 800 44px/1 Inter, "Noto Sans TC", system-ui, sans-serif; letter-spacing: -.01em; color: #fff; background: #ff4d6d; box-shadow: 0 10px 40px rgba(255, 77, 109, .55); }
.vx-log__box.is-ok .vx-log__tag { color: #04121a; background: #3ef0b0; box-shadow: 0 10px 40px rgba(62, 240, 176, .5); }
`;

const vx = {
  installed: false,
  install() {
    if (vx.installed) return true;
    const st = mk('style', null, document.head); st.id = 'vx-style'; st.textContent = CSS;
    const stage = $('#stage'), camera = $('#camera'), iframe = $('#app');
    const bg = mk('div', null, null); bg.id = 'vx-bg'; stage.insertBefore(bg, camera);
    const fr = mk('div', null, null); fr.id = 'vx-frame'; camera.insertBefore(fr, iframe);
    const bar = mk('div', 'vx-bar', fr);
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const d = mk('div', 'vx-dot', bar); d.style.background = c; }
    const tab = mk('div', 'vx-tab', bar);
    mk('span', 'vx-fav', tab);
    mk('span', null, tab, 'AURORA 極光');
    mk('span', 'vx-x', tab, '×');
    const layer = mk('div', null, null); layer.id = 'vx-layer'; stage.insertBefore(layer, $('#overlay-root'));
    vx.installed = true;
    return true;
  },
  /** dark aurora-tinted backdrop under the camera */
  bg(on = true, { ms = 0 } = {}) {
    const el = $('#vx-bg');
    if (!ms) { el.style.opacity = on ? '1' : '0'; return; }
    return el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: on ? 1 : 0 }], { duration: ms, fill: 'forwards', easing: 'ease-out' }).finished.then(() => { el.style.opacity = on ? '1' : '0'; });
  },
  /** browser window around the app (moves with the camera) */
  frame(on = true) {
    $('#vx-frame').style.display = on ? 'block' : 'none';
    document.documentElement.classList.toggle('vx-framed', !!on);
    return on;
  },
  /** hide every full-frame layer at once (a hard cut back to the app) */
  cut() {
    for (const el of document.querySelectorAll('#vx-layer > *')) el.classList.remove('is-on');
    for (const a of document.querySelectorAll('#vx-layer *')) for (const an of a.getAnimations()) an.cancel();
    return true;
  },

  /* ── spectrogram of the song you are hearing, with a live playhead ── */
  spec: {
    el: null, meta: null,
    async load({ src = '/renders/video/assets/neon-nights-spectrogram-2400.png', meta = '/renders/video/assets/spectrogram.json' } = {}) {
      vx.install();
      if (vx.spec.el) return true;
      vx.spec.meta = await (await fetch(meta)).json();
      const el = mk('div', 'vx-spec', $('#vx-layer'));
      const box = mk('div', 'vx-spec__box', el);
      const img = mk('img', null, box); img.src = src; img.decoding = 'sync';
      await img.decode().catch(() => new Promise(r => { img.onload = r; img.onerror = r; }));
      mk('div', 'vx-spec__shade', box);
      const ph = mk('div', 'vx-spec__ph', box);
      mk('div', 'vx-spec__tag', ph);
      vx.spec.el = el;
      return { w: img.naturalWidth, h: img.naturalHeight };
    },
    /** show at song time t0 → t1 (seconds) over ms of real time; the camera pushes from s0 to s1 toward the playhead */
    show({ t0, t1, ms, s0 = 0.8, s1 = 1.0, ease = 'cubic-bezier(.3,.1,.3,1)', anchorX = 0.56, tag = '', delay = 0 } = {}) {
      const { el, meta } = vx.spec;
      el.querySelector('.vx-spec__tag').textContent = tag;
      el.querySelector('.vx-spec__tag').style.display = tag ? '' : 'none';
      const box = el.querySelector('.vx-spec__box'), ph = el.querySelector('.vx-spec__ph'), shade = el.querySelector('.vx-spec__shade');
      const xOf = t => meta.x0 + (t / meta.duration) * (meta.x1 - meta.x0);
      const xa = xOf(t0), xb = xOf(t1);
      // box transform: stage = img · s + (x, y); the playhead lands at anchorX of the frame, image centred vertically
      const tf = (s, x) => `translate(${(W * anchorX - x * s).toFixed(2)}px, ${((H - meta.height * s) / 2 + 30).toFixed(2)}px) scale(${s})`;
      el.classList.add('is-on');
      const lin = { duration: ms, delay, easing: 'linear', fill: 'both' };
      box.animate([{ transform: tf(s0, xa) }, { transform: tf(s1, xb) }], { duration: ms, delay, easing: ease, fill: 'both' });
      ph.animate([{ transform: `translateX(${xa}px)` }, { transform: `translateX(${xb}px)` }], lin);
      shade.style.width = '0px';
      shade.animate([{ left: `${xa}px`, width: `${meta.x1 - xa}px` }, { left: `${xb}px`, width: `${meta.x1 - xb}px` }], lin);
      ph.style.left = '0px';
      return { xa, xb };
    },
    hide() { if (vx.spec.el) vx.spec.el.classList.remove('is-on'); },
  },

  /* ── /renders/ gallery (113 offline renders with spectrograms + metrics), as a tall still of the page
        (tools/video/make-assets.mjs): one composited layer, so the fast scroll stays at 60 fps ── */
  gallery: {
    el: null, img: null,
    async load({ src = '/renders/video/assets/renders-gallery-tall.jpg' } = {}) {
      vx.install();
      if (vx.gallery.el) return true;
      const el = mk('div', 'vx-gal', $('#vx-layer'));
      const img = mk('img', null, el); img.src = src; img.decoding = 'sync';
      await img.decode().catch(() => new Promise(r => { img.onload = r; img.onerror = r; }));
      mk('div', 'vx-gal__fade', el);
      vx.gallery.el = el; vx.gallery.img = img;
      return { w: img.naturalWidth, h: img.naturalHeight };
    },
    /** show and scroll from y0 to y1 (px of the page) over ms, scaled by s, with an optional 3-D tilt (deg) */
    show({ y0 = 0, y1 = 2400, ms = 2300, tilt = 0, s = 1, ease = 'cubic-bezier(.35,.05,.25,1)', delay = 0 } = {}) {
      const { el, img } = vx.gallery;
      el.classList.add('is-on');
      const x = (W - W * s) / 2;
      const tf = y => `translate(${x}px, ${-y * s}px) rotateX(${tilt}deg) scale(${s})`;
      img.animate([{ transform: tf(y0) }, { transform: tf(y1) }], { duration: ms, delay, easing: ease, fill: 'both' });
      return true;
    },
    hide() { if (vx.gallery.el) vx.gallery.el.classList.remove('is-on'); },
  },
};

/* ── build-log excerpt (tools/video/make-buildlog.mjs): the sound designer agent renders Bowed Moonglass, reads the
      spectrogram, sees broadband noise, tracks down a voice-steal bug, works around it and reads the clean result ── */
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
vx.log = {
  el: null, meta: null,
  async load({ base = '/renders/video/assets/buildlog/' } = {}) {
    vx.install();
    if (vx.log.el) return true;
    const meta = vx.log.meta = await (await fetch(base + 'moonglass.json')).json();
    const el = mk('div', 'vx-log', $('#vx-layer'));
    const win = mk('div', 'vx-log__win', el);
    const bar = mk('div', 'vx-log__bar', win);
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const d = mk('i', null, bar); d.style.background = c; }
    const title = mk('b', null, bar); const note = mk('span', null, bar); const pill = mk('em', null, bar);
    const rows = mk('div', 'vx-log__rows', win);
    const pages = ['before', 'after'].map(k => {
      const pg = mk('div', 'vx-log__page', rows);
      for (const r of meta.lines[k]) {
        const row = mk('div', 'vx-log__row', pg, `<span class="d">⏺</span><span class="t">${r.tool}</span><span class="a">${esc(r.text)}</span>`);
        row.dataset.k = k;
        if (r.out) mk('div', 'vx-log__row is-out', pg, `⎿&nbsp; ${esc(r.out)}`);
      }
      return pg;
    });
    const box = mk('div', 'vx-log__img', win);
    const imgs = [];
    for (const f of ['before.jpg', 'after.jpg']) {
      const img = mk('img', null, box); img.src = base + f; img.decoding = 'sync';
      await img.decode().catch(() => new Promise(r => { img.onload = r; img.onerror = r; }));
      imgs.push(img);
    }
    const sx = 1344 / 1400, sy = 480 / 500, nb = meta.noiseBox;
    const mark = k => { const b = mk('div', 'vx-log__box' + (k ? ' is-ok' : ''), box); Object.assign(b.style, { left: nb.x * sx + 'px', top: nb.y * sy + 'px', width: nb.w * sx + 'px', height: nb.h * sy + 'px' }); mk('div', 'vx-log__tag', b); return b; };
    const wipe = mk('div', 'vx-log__wipe', box);
    vx.log.el = el; vx.log.parts = { title, note, pill, pages, imgs, marks: [mark(0), mark(1)], win, wipe };
    return { w: imgs[0].naturalWidth, h: imgs[0].naturalHeight };
  },
  /** play the excerpt: page 1 (render → read → "noise") from `delay`, page 2 (repro → workaround → read → "clean")
      `beat2` ms later. Every move is a WAAPI animation scheduled with a delay (compositor-timed, no JS on the beat). */
  show({ delay = 0, beat2 = 2308, lang = 'en' } = {}) {
    const P = vx.log.parts, m = vx.log.meta, zh = lang === 'zh';
    P.title.textContent = 'Claude Code';
    P.note.textContent = `· ${zh ? m.agent.zh : m.agent.en} · ${m.date}`;
    P.pill.textContent = zh ? '真實紀錄節錄' : 'REAL LOG EXCERPT';
    P.marks[0].firstChild.textContent = zh ? '雜訊' : 'noise';
    P.marks[1].firstChild.textContent = zh ? '乾淨了 ✓' : 'clean ✓';
    for (const a of vx.log.el.querySelectorAll('*')) for (const an of a.getAnimations()) an.cancel();
    vx.log.el.classList.add('is-on');
    const A = (node, kf, o) => node.animate(kf, { fill: 'both', easing: 'cubic-bezier(.16,1,.3,1)', ...o, delay: delay + (o.delay || 0) });
    const [pA, pB] = P.pages;
    // page 1 rows type in, page 2 waits below the fold; at beat2 the rows scroll one page up
    const rowsA = [...pA.children], rowsB = [...pB.children];
    rowsA.forEach((r, i) => A(r, [{ opacity: 0, transform: 'translateX(-16px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: 40 + i * 110 }));
    A(pA, [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-196px)', opacity: 0 }], { duration: 360, delay: beat2 - 60, easing: 'cubic-bezier(.6,0,.3,1)' });
    A(pB, [{ transform: 'translateY(196px)' }, { transform: 'translateY(0)' }], { duration: 360, delay: beat2 - 60, easing: 'cubic-bezier(.6,0,.3,1)' });
    rowsB.forEach((r, i) => A(r, [{ opacity: 0, transform: 'translateX(-16px)' }, { opacity: 1, transform: 'none' }], { duration: 240, delay: beat2 + 40 + i * 150 }));
    // images: "before" appears as the Read line lands; "after" wipes in left → right on page 2's Read
    const [iA, iB] = P.imgs;
    A(iA, [{ opacity: 0, transform: 'scale(.97)', filter: 'brightness(2)' }, { opacity: 1, transform: 'none', filter: 'brightness(1)' }], { duration: 360, delay: 300 });
    // "after" sweeps in left → right behind a glowing line: the haze is cleaned away as the line passes
    const WIPE = 900, W0 = beat2 + 480;
    A(iB, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }], { duration: WIPE, delay: W0, easing: 'linear' });
    A(P.wipe, [{ left: '0px', opacity: 1 }, { left: '1344px', opacity: 1 }], { duration: WIPE, delay: W0, easing: 'linear', fill: 'none' });
    // the noise box draws on the haze, then hands over to the green "clean" box once the sweep has passed it
    const [bA, bB] = P.marks;
    A(bA, [{ opacity: 0, transform: 'scale(1.18)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 1150, easing: 'cubic-bezier(.3,1.35,.5,1)' });
    A(bA, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: W0 - 40, fill: 'forwards' });   // (not 'both': its before-phase would show the box from frame 1)
    A(bB, [{ opacity: 0, transform: 'scale(1.18)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: W0 + WIPE * 0.62, easing: 'cubic-bezier(.3,1.35,.5,1)' });
    // a slow push over the whole shot
    A(P.win, [{ transform: 'scale(1)' }, { transform: 'scale(1.075)' }], { duration: beat2 * 2, delay: 0, easing: 'linear' });
    return true;
  },
  hide() { if (vx.log.el) vx.log.el.classList.remove('is-on'); },
};

window.director.vx = vx;
export default vx;
