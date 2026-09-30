// Preset browser sidebar: search, category chips with icons, ★ favourites, user presets, tag filter.
// Arrow keys browse (and audition) presets; double-click loads + plays the demo.

import { h, storage } from './dom.js';
import { icon } from './icons.js';
import { t, tx, getLang, splitName } from './i18n.js';
import { confirmDialog } from './modals.js';

/**
 * opts: { library, categories, onSelect(entry), onDemo(entry) }
 * → { el, setCurrent(key), step(dir) → entry|null, focusSearch(), render() }
 */
export function createPresetBrowser({ library, categories, onSelect, onDemo }) {
  const el = h('aside.sidebar', { 'aria-label': t('presets') });
  const input = h('input.search__input', { type: 'search', 'data-i18n-placeholder': 'search', placeholder: t('search'), 'aria-label': t('search'), spellcheck: 'false', autocomplete: 'off' });
  const clear = h('button.icon-btn.search__clear', { type: 'button', 'aria-label': t('clearFilter') }, icon('x', 14));
  const search = h('div.search', null, icon('search', 16, 'search__ic'), input, clear);
  const chips = h('div.chips', { role: 'tablist', 'aria-label': t('category') });
  const tagBar = h('div.tagbar');
  // role=list (not listbox) so the computer-keyboard piano keeps playing while the list has focus
  const list = h('div.plist', { role: 'list', tabindex: 0, 'aria-label': t('presets') });
  const foot = h('div.sb-foot');
  const close = h('button.icon-btn.sb-close', { type: 'button', 'aria-label': t('close'), 'data-i18n-aria': 'close', title: t('close'), 'data-i18n-title': 'close' }, icon('x', 18));
  el.append(h('div.sb-head', null, h('div.sb-title', null, icon('list', 17), tx('presets'), close), search), chips, tagBar, list, foot);

  let cat = storage.get('aurora.browserCat', 'all');
  let query = '';
  let tag = null;
  let current = null;
  let visible = [];

  close.addEventListener('click', () => document.documentElement.classList.remove('drawer-open'));
  input.addEventListener('input', () => { query = input.value.trim().toLowerCase(); render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); list.focus(); step(1, true); }
    else if (e.key === 'Enter' && visible[0]) { onSelect(visible[0]); }
    else if (e.key === 'Escape') { input.value = ''; query = ''; render(); }
  });
  clear.addEventListener('click', () => { input.value = ''; query = ''; tag = null; render(); input.focus(); });

  const CHIP_DEFS = () => [
    { id: 'all', icon: 'all', zh: t('all', 'zh'), en: t('all', 'en') },
    { id: 'fav', icon: 'star', zh: t('favourites', 'zh'), en: t('favourites', 'en') },
    { id: 'user', icon: 'user', zh: t('user', 'zh'), en: t('user', 'en') },
    ...categories.map(c => ({ id: c.id, icon: c.icon, zh: c.zh, en: c.label, color: c.color })),
  ];

  function matches(p) {
    if (cat === 'fav' && !library.isFav(p.key)) return false;
    if (cat === 'user' && p.source !== 'user') return false;
    if (cat !== 'all' && cat !== 'fav' && cat !== 'user' && p.category !== cat) return false;
    if (tag && !(p.tags || []).includes(tag)) return false;
    if (query) {
      const c = categories.find(x => x.id === p.category);
      const hay = `${p.name} ${p.description || ''} ${(p.tags || []).join(' ')} ${c ? `${c.zh} ${c.label}` : ''}`.toLowerCase();
      if (!query.split(/\s+/).every(q => hay.includes(q))) return false;
    }
    return true;
  }

  function renderChips() {
    chips.textContent = '';
    const all = library.all();
    for (const d of CHIP_DEFS()) {
      const n = d.id === 'all' ? all.length : d.id === 'fav' ? all.filter(p => library.isFav(p.key)).length : d.id === 'user' ? all.filter(p => p.source === 'user').length : all.filter(p => p.category === d.id).length;
      if ((d.id === 'user' || d.id === 'fav') && !n && cat !== d.id) continue;
      const lbl = getLang() === 'en' ? d.en : d.zh;
      const b = h('button.chip', { type: 'button', role: 'tab', 'aria-selected': String(cat === d.id), title: `${d.zh} ${d.en}`, '--c': d.color || null },
        icon(d.icon, 15), h('span.chip__lbl', null, lbl), h('span.chip__n', null, String(n)));
      b.classList.toggle('is-on', cat === d.id);
      b.addEventListener('click', () => { cat = d.id; storage.set('aurora.browserCat', cat); render(); });
      chips.append(b);
    }
  }

  function row(p) {
    const c = categories.find(x => x.id === p.category);
    const fav = library.isFav(p.key);
    const favBtn = h('button.prow__fav', { type: 'button', 'aria-label': t('favourite'), 'aria-pressed': String(fav), tabindex: -1 }, icon('star', 15));
    favBtn.classList.toggle('is-on', fav);
    favBtn.addEventListener('click', (e) => { e.stopPropagation(); library.toggleFav(p.key); });
    const nm = splitName(p.name);
    const main = h('span.prow__main', null,
      h('span.prow__name', null, nm.zh && nm.en ? (getLang() === 'en' ? nm.en : nm.zh) : p.name),
      h('span.prow__tags', null, ...(p.tags || []).slice(0, 3).map(tg => {
        const s = h('span.prow__tag', null, `#${tg}`);
        s.addEventListener('click', (e) => { e.stopPropagation(); tag = tag === tg ? null : tg; render(); });
        return s;
      })));
    const r = h('div.prow', { role: 'listitem', 'aria-current': current === p.key ? 'true' : null, '--c': c ? c.color : 'var(--a-cyan)', title: p.description || p.name, 'data-key': p.key },
      h('span.prow__ic', null, icon(c ? c.icon : 'fx', 16)), main,
      p.source === 'user' ? h('span.prow__user', { title: t('user') }, icon('user', 12)) : null, favBtn);
    if (p.source === 'user') {
      const del = h('button.prow__del', { type: 'button', 'aria-label': t('deletePreset'), title: t('deletePreset'), tabindex: -1 }, icon('trash', 14));
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await confirmDialog(`${t('deleteConfirm')}「${p.name}」`, { danger: true, okLabel: t('deletePreset') })) library.deleteUser(p.key);
      });
      r.insertBefore(del, favBtn);
    }
    r.classList.toggle('is-current', current === p.key);
    r.addEventListener('click', () => onSelect(p));
    r.addEventListener('dblclick', () => onDemo && onDemo(p));
    return r;
  }

  function render() {
    renderChips();
    clear.hidden = !query && !tag;
    tagBar.textContent = '';
    if (tag) {
      const b = h('button.chip.chip--tag.is-on', { type: 'button' }, h('span', null, `#${tag}`), icon('x', 12));
      b.addEventListener('click', () => { tag = null; render(); });
      tagBar.append(b);
    }
    const all = library.all();
    visible = all.filter(matches);
    list.textContent = '';
    if (!visible.length) {
      list.append(h('div.plist__empty', null, icon('search', 22), h('span', null, t('noResults'))));
    } else if (cat === 'all' && !query && !tag) {
      // grouped by category with sticky headers
      for (const c of categories) {
        const items = visible.filter(p => p.category === c.id);
        if (!items.length) continue;
        // one section per category so each sticky header is pushed away by the next one
        const sec = h('div.plist__sec', null, h('div.plist__group', { '--c': c.color }, icon(c.icon, 13), h('span', null, getLang() === 'en' ? c.label : c.zh), h('small', null, String(items.length))));
        for (const p of items) sec.append(row(p));
        list.append(sec);
      }
      const others = visible.filter(p => !categories.some(c => c.id === p.category));
      for (const p of others) list.append(row(p));
      visible = [...categories.flatMap(c => visible.filter(p => p.category === c.id)), ...others];
    } else {
      for (const p of visible) list.append(row(p));
    }
    foot.textContent = `${visible.length} / ${all.length} ${t('presetCount')}`;
    const cur = list.querySelector('.prow.is-current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function step(dir, load = true) {
    const pool = visible.length ? visible : library.all();
    if (!pool.length) return null;
    let i = pool.findIndex(p => p.key === current);
    i = i < 0 ? (dir > 0 ? 0 : pool.length - 1) : (i + dir + pool.length) % pool.length;
    const p = pool[i];
    if (load) onSelect(p);
    return p;
  }

  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter' && onDemo) { const p = library.get(current); if (p) onDemo(p); }
  });

  library.onChange(render);
  render();

  return {
    el,
    render,
    setCurrent(key) {
      current = key;
      for (const r of list.querySelectorAll('.prow')) {
        const on = r.dataset.key === key;
        r.classList.toggle('is-current', on);
        if (on) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current');
        if (on) r.scrollIntoView({ block: 'nearest' });
      }
    },
    step,
    getCategory: () => cat,
    focusSearch() { input.focus(); input.select(); },
  };
}
