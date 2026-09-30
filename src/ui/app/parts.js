// Layout building blocks for the editor panels: glass cards, labelled sections, knob rows, icon choosers.

import { h } from './dom.js';
import { icon } from './icons.js';
import { groupLabel, pairLabel } from './i18n.js';
import { PARAM_BY_ID } from '../../dsp/params.js';

/** Title element from a {zh,en} pair. */
export function titleEl(pair, tag = 'h3', cls = 'card__title') {
  return h(`${tag}.${cls}`, null, h('span.t-main', null, pair.zh), pair.en ? h('span.t-sub', null, pair.en) : null);
}

/**
 * Glass card. opts: { group (GROUPS id for the title) | title {zh,en}, icon, accent (css colour), cls, extra (header nodes) }
 * → { el, head, body }
 */
export function card({ group, title, icon: ic, accent, cls = '', extra = [] } = {}) {
  const pair = title || groupLabel(group);
  const head = h('header.card__head', null,
    ic ? h('span.card__icon', null, icon(ic, 17)) : null,
    titleEl(pair),
    h('span.card__spacer'),
    ...extra);
  const body = h('div.card__body');
  const el = h(`section.card ${cls}`.trim(), accent ? { '--acc': accent } : null, head, body);
  if (group) el.dataset.group = group;
  return { el, head, body };
}

/** Labelled sub-section inside a card. */
export function section(key, ...kids) {
  const pair = typeof key === 'object' ? key : pairLabel(key, '');
  return h('div.sect', null, h('div.sect__label', null, h('span', null, pair.zh), pair.en ? h('small', null, pair.en) : null), h('div.sect__row', null, ...kids));
}

/** A row of controls. */
export function row(...kids) { return h('div.krow', null, ...kids); }

/**
 * Icon chooser bound to an enum param (e.g. phys.model with pictograms).
 * items: [{ value, icon, label:{zh,en} }]
 */
export function iconChoice(scope, store, id, items, { accent, cls = '' } = {}) {
  const p = PARAM_BY_ID[id];
  const el = h(`div.ichoice ${cls}`.trim(), { role: 'radiogroup', 'aria-label': `${p.zh} ${p.label}`, 'data-param': id, '--acc': accent || null });
  const btns = items.map((it) => {
    const b = h('button.ichoice__btn', { type: 'button', role: 'radio', title: `${it.label.zh} ${it.label.en || ''}`.trim() },
      it.icon ? icon(it.icon, 22) : null,
      it.svg ? h('span.ichoice__svg', { html: it.svg }) : null,
      h('span.ichoice__lbl', null, it.label.zh), it.label.en ? h('small.ichoice__sub', null, it.label.en) : null);
    b.addEventListener('click', () => store.set(id, it.value, { origin: el }));
    el.append(b);
    return b;
  });
  el.addEventListener('keydown', (e) => {
    const cur = items.findIndex(it => it.value === store.get(id));
    let d = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') d = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') d = -1;
    else return;
    e.preventDefault();
    const n = (cur + d + items.length) % items.length;
    store.set(id, items[n].value, { origin: el });
    btns[n].focus();
  });
  const render = () => {
    const v = store.get(id);
    btns.forEach((b, i) => {
      const on = items[i].value === v;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  scope.add(store.subscribe(id, render));
  render();
  return el;
}

/** Small "disabled because…" overlay/hint on an element. */
export function setDisabled(el, disabled, hint) {
  el.classList.toggle('is-disabled', !!disabled);
  if (hint !== undefined) el.title = disabled ? hint : '';
}
