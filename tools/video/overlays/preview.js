// Preview / test bench for the overlay layer. URL params:
//   ?bg=shot|app|gradient|none   sample background (default shot = static app screenshot)
//   ?lang=en|zh                  caption language
//   ?clean=1                     no control bar, stage drawn 1:1 at the top-left (for screenshots / recording)
//   ?autoplay=film|<scene>       start a scene on load (film loops)
//   ?hud=1                       show per-frame overlay cost in the bar
import { createOverlay } from './overlay.js';

const q = new URLSearchParams(location.search);
const clean = q.has('clean');
if (clean) document.body.classList.add('clean');
const stage = document.getElementById('stage');
const bg = document.getElementById('bg');
const langSel = document.getElementById('lang');
const bgSel = document.getElementById('bgsel');

// ── stage scaling ──
const fitStage = () => {
  if (clean) { stage.style.transform = ''; return; }
  const wrap = document.getElementById('wrap').getBoundingClientRect();
  const s = Math.min(wrap.width / 1920, wrap.height / 1080);
  stage.style.transform = `scale(${s})`;
  stage.style.position = 'absolute';
  stage.style.left = ((wrap.width - 1920 * s) / 2) + 'px'; stage.style.top = ((wrap.height - 1080 * s) / 2) + 'px';
};
addEventListener('resize', fitStage); fitStage();

// ── background ──
function setBg(kind) {
  bg.className = ''; bg.innerHTML = '';
  if (kind === 'shot') bg.innerHTML = '<img src="./assets/app-sample.jpg" alt="">';
  else if (kind === 'gradient') bg.className = 'gradient';
  else if (kind === 'app') {
    const f = document.createElement('iframe'); f.src = '../../../index.html'; bg.appendChild(f);
    f.addEventListener('load', () => setTimeout(() => { try { f.contentDocument.querySelector('.splash__start')?.click(); } catch {} }, 900));
  }
  bgSel.value = kind;
}
setBg(q.get('bg') || 'shot');
bgSel.onchange = () => setBg(bgSel.value);

// ── overlay ──
const ov = createOverlay(document.getElementById('overlay'), { lang: q.get('lang') || 'en' });
window.ov = ov;
langSel.value = ov.lang;
langSel.onchange = () => ov.setLang(langSel.value);

const T = {
  hook: [{ en: "Claude can't hear.", zh: 'Claude 聽不見。', size: 'l' }, { en: 'It built this anyway.', zh: '卻做出了這台合成器。', key: true }],
  sound: { en: '🔊 Sound on', zh: '🔊 請開聲音' },
  live: { en: 'Every sound is synthesized *live*', zh: '每個聲音都是*即時合成*' },
  zero: { en: '0 samples', zh: '零取樣' },
  looking: { en: 'Claude tuned every sound by *looking* at spectrograms.', zh: 'Claude 靠*看*頻譜圖，調出每一個聲音。' },
  presets: { en: '100 presets · 10 categories', zh: '100 個音色 · 10 種分類' },
  tours: { en: 'Knobs turn *themselves* in 6 animated sound tours', zh: '6 段音色導覽，旋鈕*自己轉*' },
  tab: { en: 'Runs entirely in a browser tab', zh: '完全在瀏覽器分頁裡執行' },
};
window.T = T;

const scenes = {
  async hook() {
    ov.badge(T.sound, { delay: 900, ms: 3600 });
    await ov.hook(T.hook);
    await ov.wait(1600);
    await ov.clearHook();
  },
  async captions() {
    await ov.caption(T.live, { style: 'label', kicker: T.zero, ms: 2200 });
    await ov.caption(T.looking, { style: 'statement', ms: 2600 });
    await ov.caption(T.presets, { position: 'top', style: 'label', ms: 1800 });
    await ov.caption({ en: 'A synth that *lives* in a browser tab', zh: '一台*住在*瀏覽器分頁裡的合成器' }, { position: 'center', style: 'statement', ms: 2000 });
  },
  async badges() {
    const a = await ov.badge(T.sound);
    const b = await ov.badge({ en: '100% real-time synthesis · 0 samples', zh: '100% 即時合成 · 零取樣' }, { icon: 'spark', position: 'top-left' });
    const c = await ov.badge({ en: '✓ 308 automated tests', zh: '✓ 308 項自動化測試' }, { position: 'bottom-right' });
    await ov.wait(2600);
    await Promise.all([a.remove(), b.remove(), c.remove()]);
  },
  async cursor() {
    await ov.cursor.show({ x: 1500, y: 760 });
    await ov.spotlight({ x: 330, y: 296, w: 680, h: 170 }, { ms: 750 });
    ov.caption(T.tours, { style: 'label', ms: 3600 });
    await ov.cursor.moveTo(580, 360);
    const ring = await ov.highlightRing({ x: 535, y: 310, w: 92, h: 150 }, { label: { en: 'Motion', zh: '流動' } });
    await ov.cursor.click(580, 356);
    await ov.wait(900);
    ring.remove();
    await ov.spotlight({ x: 940, y: 10, w: 250, h: 40 }, { ms: 700, radius: 16 });
    const r2 = await ov.highlightRing({ x: 940, y: 12, w: 92, h: 36 }, { radius: 18, label: { en: 'Auto-play demos', zh: '自動示範' }, labelPos: 'below' });
    await ov.cursor.click(985, 30);
    await ov.wait(1000);
    r2.remove(); ov.spotlight(null); await ov.cursor.hide();
  },
  async counter() {
    const h = await ov.counter({ value: 46742, label: { en: 'lines of code', zh: '行程式碼' }, sub: { en: 'zero dependencies', zh: '零相依套件' }, dim: true });
    await ov.wait(1400);
    await h.remove();
  },
  async stats() {
    const h = await ov.stats([
      { value: 47, label: { en: 'agent runs', zh: '個 agent' } },
      { value: 46742, label: { en: 'lines of code', zh: '行程式碼' } },
      { value: 0, label: { en: 'dependencies', zh: '相依套件' } },
      { value: 100, label: { en: 'factory presets', zh: '個原廠音色' } },
      { value: 6, label: { en: 'original songs', zh: '首原創示範曲' } },
    ], { title: { en: 'Built by Claude Code', zh: 'Claude Code 打造' } });
    await ov.wait(1600);
    await h.remove();
  },
  async swarm() {
    const h = await ov.swarm();
    await ov.wait(1500);
    await h.remove();
  },
  async flash() {
    ov.flash(.5, 500);
    await ov.wait(400);
    ov.flash(.35, 420, { color: 'white' });
    await ov.wait(400);
    ov.flash(.5, 500);
    await ov.wait(100);
    ov.flash(.5, 500); // → skipped (limit: 3 per second)
    await ov.wait(800);
  },
  async end() {
    await ov.endCard({ ms: 2600, loopOut: true });
    await ov.backdrop.hide({ ms: 400 });
  },
  async film() {
    // A sample cut (~40 s) that exercises everything the director will use.
    ov.badge(T.sound, { delay: 800, ms: 3800 });
    await ov.hook(T.hook);
    await ov.wait(1500);
    await ov.clearHook();
    ov.caption(T.tab, { style: 'label', ms: 2000 });
    await ov.wait(600);
    await scenes.cursor();
    await ov.caption(T.looking, { style: 'statement', ms: 2600 });
    await scenes.counter();
    await scenes.swarm();
    await scenes.stats();
    ov.flash(.45, 520);
    await ov.endCard({ ms: 3000, loopOut: true });
  },
  async sky() { ov.backdrop.now(); await ov.wait(6000); },
  async clear() { await ov.clear(); },
};

let running = null;
window.scene = async name => {
  const my = Symbol(); running = my;
  await ov.ready;
  await scenes[name]();
  return running === my;
};
window.scenes = scenes;
for (const b of document.querySelectorAll('[data-run]')) b.onclick = async () => { if (b.dataset.run !== 'clear') await ov.clear({ ms: 200 }); window.scene(b.dataset.run); };

// ── HUD: per-frame overlay JS cost + frame interval ──
const hud = document.getElementById('hud');
if (!clean || q.has('hud')) {
  let last = performance.now(); const dts = [];
  const f = t => { dts.push(t - last); last = t; if (dts.length > 120) dts.shift(); requestAnimationFrame(f); };
  requestAnimationFrame(f);
  setInterval(() => {
    const p = ov.perf(); const avgDt = dts.reduce((a, b) => a + b, 0) / (dts.length || 1);
    hud.textContent = `overlay js  avg ${p.avg.toFixed(2)}  p95 ${p.p95.toFixed(2)}  max ${p.max.toFixed(2)} ms\nfps ${(1000 / avgDt).toFixed(1)}   frames ${p.frames}`;
  }, 500);
}

const auto = q.get('autoplay');
ov.ready.then(async () => {
  // best practice: fetch every glyph the film will show before the first frame
  await ov.preload([T, { en: 'Built by Claude Code Auto-play demos Motion lines of code zero dependencies agent runs factory presets original songs dependencies 308 automated tests 100% real-time synthesis · 0 samples A synth that lives in a browser tab', zh: '個原廠音色首原創示範曲相依套件行程式碼零相依套件個 agent 打造自動示範流動一台住在瀏覽器分頁裡的合成器項自動化測試即時合成零取樣' }]);
  document.documentElement.dataset.ready = '1';
  // the film ends parked on the opening frame's sky, so it loops straight back into the hook (like on X)
  if (auto) { do { await window.scene(auto); if (auto !== 'film') await ov.clear({ ms: 300 }); } while (auto === 'film'); }
});
