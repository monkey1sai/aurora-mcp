// Text helpers: bilingual picking, "*highlight*" markup, splitting into animatable units,
// and continuous-gradient mapping across split units.

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

/** {en, zh} | string → string for lang */
export function pick(t, lang) {
  if (t == null) return '';
  if (typeof t === 'string' || typeof t === 'number') return String(t);
  return t[lang] ?? t.en ?? t.zh ?? '';
}

/** Parse "plain *highlighted* text\nsecond line" → [{text, hl, br}] */
export function parse(str) {
  const out = []; let hl = false; let buf = '';
  const flush = () => { if (buf) out.push({ text: buf, hl }); buf = ''; };
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\' && str[i + 1] === '*') { buf += '*'; i++; continue; }
    if (ch === '*') { flush(); hl = !hl; continue; }
    if (ch === '\n') { flush(); out.push({ br: true }); continue; }
    buf += ch;
  }
  flush();
  return out;
}

/**
 * Fill `el` with animatable units. by: 'char' (every glyph a unit, words kept unbreakable)
 * or 'word' (every word a unit; CJK glyphs are always their own unit so lines can wrap).
 * Returns { units: HTMLElement[], runs: HTMLElement[][] } — runs = consecutive highlighted units.
 */
export function split(el, str, { by = 'char', hlAll = false } = {}) {
  el.textContent = '';
  const units = []; const runs = []; let run = null;
  const mk = (txt, hl) => {
    const s = document.createElement('span');
    s.className = hl ? 'u hl' : 'u';
    s.textContent = txt;
    units.push(s);
    if (hl) { if (!run) { run = []; runs.push(run); } run.push(s); }
    return s;
  };
  for (const seg of parse(str)) {
    if (seg.br) { el.appendChild(document.createElement('br')); run = null; continue; }
    const hl = hlAll || seg.hl;
    if (!hl) run = null;
    // words = runs of non-space; CJK glyphs split individually
    const tokens = seg.text.match(/\s+|[^\s]+/g) || [];
    for (const tok of tokens) {
      if (/^\s+$/.test(tok)) { el.appendChild(document.createTextNode(' ')); continue; }
      const parts = []; let cur = '';
      for (const ch of tok) {
        if (CJK.test(ch)) { if (cur) parts.push(cur); cur = ''; parts.push(ch); } else cur += ch;
      }
      if (cur) parts.push(cur);
      // punctuation that must not start a line sticks to the previous CJK glyph
      for (let i = parts.length - 1; i > 0; i--) if (/^[，。、！？：；」』）》…,.!?:;)]+$/.test(parts[i])) { parts[i - 1] += parts[i]; parts.splice(i, 1); }
      for (const part of parts) {
        if (by === 'char') {
          const w = document.createElement('span'); w.className = 'wd';
          for (const ch of part) w.appendChild(mk(ch, hl));
          el.appendChild(w);
        } else el.appendChild(mk(part, hl));
      }
    }
  }
  return { units, runs };
}

/** Map one continuous gradient across every run of highlighted units (call after layout). */
export function mapGradient(runs, root) {
  for (const run of runs) mapRun(run, root);
}
export function mapRun(run, root) {
  if (!run.length) return;
  const base = root || run[0].parentElement;
  const rb = base.getBoundingClientRect();
  const sx = rb.width / (base.offsetWidth || rb.width || 1) || 1; // undo host CSS scale
  const rects = run.map(u => u.getBoundingClientRect());
  const left = Math.min(...rects.map(r => r.left)); const right = Math.max(...rects.map(r => r.right));
  const w = Math.max(1, (right - left) / sx);
  run.forEach((u, i) => { u.style.setProperty('--rw', w.toFixed(1) + 'px'); u.style.setProperty('--rx', ((rects[i].left - left) / sx).toFixed(1) + 'px'); });
  return w;
}

export const isCJK = s => CJK.test(s);
