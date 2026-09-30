// 音色導覽 Sound Tours tab: a gallery of tour cards (animated covers, steps, duration) → start a tour.

import { h } from '../app/dom.js';
import { t, getLang } from '../app/i18n.js';
import { dIcon } from './center.js';
import { compileTour } from '../../demo/tours/index.js';

const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/**
 * @param {{ tours: object[]|null (null = still loading), onStart(tour), player: {isActive, status, onChange, stop}, categories: object[] }} o
 * @returns {{ el, setTours(list), setVisible(bool), renderLang() }}
 */
export function createToursView({ tours = [], onStart, player, categories = [] }) {
  const hint = h('div.tv-hint', null, dIcon('tours', 18), h('p', null, h('b.tv-hint__main'), h('span.tv-hint__sub')));
  const grid = h('div.tv-grid', { role: 'list' });
  const el = h('div.tv', null, hint, grid);
  let list = tours;
  let cards = [];

  function card(tour, i) {
    const c = compileTour(tour);
    const secs = (c.endBeat * 60) / c.bpm;
    const cols = (tour.cover && tour.cover.colors) || ['#3ef0b0', '#5cf2ff', '#a78bfa'];
    const cat = categories.find(x => x.id === (tour.start && tour.start.category));
    const art = h('div.tv-art', { 'aria-hidden': 'true' },
      h('span.tv-art__blob'), h('span.tv-art__blob'), h('span.tv-art__blob'),
      h('span.tv-art__ic', null, dIcon(tour.icon || (cat && cat.icon) || 'sparkle', 34)),
      h('span.tv-art__n', null, String(i + 1).padStart(2, '0')),
      h('span.tv-art__steps', null, ...Array.from({ length: c.captionCount }, (_, k) => h('i', { style: `--k:${k}` }))));
    const title = h('h3.tv-card__title');
    const sub = h('span.tv-card__en');
    const desc = h('p.tv-card__desc');
    const meta = h('div.tv-card__meta');
    const startLbl = h('span');
    const start = h('button.tv-start', { type: 'button' }, dIcon('play', 15), startLbl);
    start.addEventListener('click', () => {
      if (player && player.isActive() && player.status().tour === tour) { player.stop({ revert: true }); return; }
      onStart(tour);
    });
    const el = h('article.tv-card', { role: 'listitem', '--c1': cols[0], '--c2': cols[1] || cols[0], '--c3': cols[2] || cols[1] || cols[0], style: `--i:${i}` },
      art, h('div.tv-card__body', null, h('div.tv-card__kick', null, cat ? h('span.tv-card__cat', { '--c': cat.color || cols[0] }, dIcon(cat.icon, 12), h('span.tv-card__catTxt')) : null, h('span.tv-card__live', null, h('i'), h('span.tv-card__liveTxt'))),
        title, sub, desc, meta, start));
    const render = () => {
      const en = getLang() === 'en';
      title.textContent = en ? tour.title : tour.zh;
      sub.textContent = en ? tour.zh : tour.title;
      const d = tour.description || '';
      desc.textContent = typeof d === 'object' ? (en ? d.en : d.zh) : d;
      meta.replaceChildren(
        h('span', null, dIcon('clock', 13), fmtTime(secs)),
        h('span', null, dIcon('steps', 13), `${c.captionCount} ${t('tourSteps')}`),
        h('span', null, dIcon('wave', 13), `${Math.round(c.bpm)} BPM`));
      const catTxt = el.querySelector('.tv-card__catTxt');
      if (catTxt && cat) catTxt.textContent = en ? cat.label : cat.zh;
      el.querySelector('.tv-card__liveTxt').textContent = t('tourLive');
      const active = player && player.isActive() && player.status().tour === tour;
      el.classList.toggle('is-active', !!active);
      start.replaceChildren(dIcon(active ? 'stop' : 'play', 15), startLbl);
      startLbl.textContent = t(active ? 'tourExit' : 'tourStart');
      start.setAttribute('aria-label', `${startLbl.textContent} — ${title.textContent}`);
    };
    render();
    return { el, render, tour };
  }

  function build() {
    grid.textContent = '';
    grid.setAttribute('aria-busy', String(list === null));
    // 'no tours yet' only for a settled, empty list — never while the data is still loading
    if (list === null) { grid.append(h('p.dc-empty.is-loading', null, t('toursLoading'))); cards = []; return; }
    cards = list.map((tr, i) => card(tr, i));
    for (const c of cards) grid.append(c.el);
    if (!list.length) grid.append(h('p.dc-empty', null, t('toursEmpty')));
  }
  function renderLang() {
    if (list === null) build();
    hint.querySelector('.tv-hint__main').textContent = t('tourHintMain');
    hint.querySelector('.tv-hint__sub').textContent = t('tourHint');
    for (const c of cards) c.render();
  }
  if (player && player.onChange) player.onChange(() => { for (const c of cards) c.render(); });
  build();
  renderLang();
  return {
    el,
    setTours(l) { list = Array.isArray(l) ? l : []; build(); renderLang(); },
    setVisible(v) { el.classList.toggle('is-visible', !!v); },
    renderLang,
  };
}
