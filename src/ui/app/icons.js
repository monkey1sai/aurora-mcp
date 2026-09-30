// Inline SVG icon set (24×24, stroke-based, currentColor). No external assets.

const F = 'fill="currentColor" stroke="none"';

export const ICONS = {
  prev: '<path d="M15 18l-6-6 6-6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  up: '<path d="M7 14l5-5 5 5"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  star: '<path d="M12 3.6l2.55 5.2 5.7.83-4.13 4.02.98 5.68L12 16.64l-5.1 2.69.98-5.68L3.75 9.63l5.7-.83z"/>',
  save: '<path d="M5 4.5h10.6L19.5 8.4V19.5H5z"/><path d="M8.5 4.5v4.2h6V4.5"/><rect x="8.2" y="13" width="7.6" height="6.5" rx="1"/>',
  undo: '<path d="M9 14.5L4.5 10 9 5.5"/><path d="M4.5 10h10a5 5 0 010 10H11"/>',
  redo: '<path d="M15 14.5l4.5-4.5L15 5.5"/><path d="M19.5 10h-10a5 5 0 000 10H13"/>',
  dice: `<rect x="4" y="4" width="16" height="16" rx="3.6"/><circle cx="8.6" cy="8.6" r="1.25" ${F}/><circle cx="15.4" cy="8.6" r="1.25" ${F}/><circle cx="12" cy="12" r="1.25" ${F}/><circle cx="8.6" cy="15.4" r="1.25" ${F}/><circle cx="15.4" cy="15.4" r="1.25" ${F}/>`,
  mutate: '<path d="M4.5 19.5l10-10"/><path d="M14.5 3.5l1.1 2.4 2.4 1.1-2.4 1.1-1.1 2.4-1.1-2.4-2.4-1.1 2.4-1.1z"/><path d="M19 11.5l.7 1.3 1.3.7-1.3.7-.7 1.3-.7-1.3-1.3-.7 1.3-.7z"/>',
  play: `<path d="M7.5 4.8v14.4a.8.8 0 001.2.7l12-7.2a.8.8 0 000-1.4l-12-7.2a.8.8 0 00-1.2.7z" ${F}/>`,
  stop: `<rect x="6" y="6" width="12" height="12" rx="2.2" ${F}/>`,
  midi: `<circle cx="12" cy="12" r="8.6"/><circle cx="7.9" cy="11.2" r="1" ${F}/><circle cx="16.1" cy="11.2" r="1" ${F}/><circle cx="9.4" cy="14.8" r="1" ${F}/><circle cx="14.6" cy="14.8" r="1" ${F}/><circle cx="12" cy="16.2" r="1" ${F}/><path d="M10.4 4.2h3.2"/>`,
  menu: `<circle cx="5.5" cy="12" r="1.5" ${F}/><circle cx="12" cy="12" r="1.5" ${F}/><circle cx="18.5" cy="12" r="1.5" ${F}/>`,
  download: '<path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 20V9"/><path d="M7 13.5l5-5 5 5"/><path d="M5 4h14"/>',
  search: '<circle cx="11" cy="11" r="6.3"/><path d="M20 20l-4.4-4.4"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  panic: `<path d="M12 3.5l9 15.5H3z"/><path d="M12 10v4.2"/><circle cx="12" cy="16.6" r="1" ${F}/>`,
  help: `<circle cx="12" cy="12" r="8.8"/><path d="M9.6 9.6a2.5 2.5 0 014.9.7c0 1.7-2.5 2.1-2.5 3.7"/><circle cx="12" cy="16.9" r="1" ${F}/>`,
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/>',
  list: '<path d="M4 6.5h16M4 12h16M4 17.5h10"/>',
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6"/>',
  user: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>',
  globe: '<circle cx="12" cy="12" r="8.8"/><path d="M3.2 12h17.6"/><path d="M12 3.2c2.4 2.6 3.6 5.5 3.6 8.8s-1.2 6.2-3.6 8.8c-2.4-2.6-3.6-5.5-3.6-8.8s1.2-6.2 3.6-8.8z"/>',
  pedal: '<path d="M6.5 20h11"/><path d="M9 20l1.6-12.5h2.8L15 20"/><path d="M10.2 4.5h3.6"/>',
  tap: '<path d="M9.5 11.5V5.8a1.5 1.5 0 013 0V11"/><path d="M12.5 10.5V9.4a1.5 1.5 0 013 0v2"/><path d="M15.5 11.4a1.5 1.5 0 013 0v3c0 3.4-2.3 6.1-5.8 6.1-2.4 0-3.9-1.1-5.3-3.5l-1.8-3a1.4 1.4 0 012.3-1.6l1.6 2"/>',
  github: '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h.01M9 9.5h.01M12 9.5h.01M15 9.5h.01M18 9.5h.01M7.5 12.5h.01M10.5 12.5h.01M13.5 12.5h.01M16.5 12.5h.01M8 15.2h8"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  sliders: '<path d="M5 4v16M12 4v16M19 4v16"/><rect x="3" y="12.5" width="4" height="3.2" rx="1"/><rect x="10" y="7" width="4" height="3.2" rx="1"/><rect x="17" y="14.5" width="4" height="3.2" rx="1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  loop: '<path d="M17 3.5l3 3-3 3"/><path d="M20 6.5H9a5 5 0 00-5 5"/><path d="M7 20.5l-3-3 3-3"/><path d="M4 17.5h11a5 5 0 005-5"/>',
  // categories
  all: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6"/>',
  keys: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 13.5V19M12 5v14M16.5 13.5V19"/><rect x="6.3" y="5" width="2.4" height="8.5" rx=".5" ${F}/><rect x="15.3" y="5" width="2.4" height="8.5" rx=".5" ${F}/>`,
  pad: '<path d="M2.5 9.5c3.2-3.4 6.3-3.4 9.5 0s6.3 3.4 9.5 0"/><path d="M2.5 14.5c3.2-3.4 6.3-3.4 9.5 0s6.3 3.4 9.5 0" opacity=".55"/>',
  bass: `<path d="M5.5 8.6a4.3 4.3 0 018.6 0c0 5.1-4.1 8.5-8.6 10.6"/><circle cx="5.9" cy="8.6" r="1.4" ${F}/><circle cx="18" cy="7.4" r="1.1" ${F}/><circle cx="18" cy="12" r="1.1" ${F}/>`,
  lead: '<path d="M13.2 3L5 13.6h6.2L10.2 21l8.4-10.8h-6.3z"/>',
  pluck: `<path d="M3.5 12H8l2.5-5 2.5 5h7.5"/><circle cx="3.5" cy="12" r="1.2" ${F}/><circle cx="20.5" cy="12" r="1.2" ${F}/>`,
  bell: '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.6 2.2H4.4z"/><path d="M10 20.6a2.1 2.1 0 004 0"/><path d="M12 3v2"/>',
  strings: '<path d="M12 2.8v4"/><path d="M9.4 6.8h5.2c.9 1.2.9 2.4 0 3.4 1.9 1.3 2.1 4.6.5 6.6-1.4 1.8-4.8 1.8-6.2 0-1.6-2-1.4-5.3.5-6.6-.9-1-.9-2.2 0-3.4z"/><path d="M12 10.2v7.3"/><path d="M4 21L20 5" opacity=".5"/>',
  arp: '<path d="M4 18.5h4v-4h4v-4h4v-4h4"/>',
  fx: '<path d="M11 3l1.9 4.9 4.9 1.9-4.9 1.9L11 16.6l-1.9-4.9-4.9-1.9 4.9-1.9z"/><path d="M18.5 14.5l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>',
  drum: '<ellipse cx="12" cy="9" rx="8" ry="3"/><path d="M4 9v7c0 1.7 3.6 3 8 3s8-1.3 8-3V9"/><path d="M7.5 3.5l3.2 4.4M16.5 3.5l-3.2 4.4"/>',
  // sources
  osc: '<path d="M2.5 12c2.4-7 4.8-7 7.2 0s4.8 7 7.2 0c1.2-3.5 2.4-5.3 4.6-5.3"/>',
  fm: `<circle cx="12" cy="12" r="1.9" ${F}/><ellipse cx="12" cy="12" rx="9" ry="3.7"/><ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.7" transform="rotate(-60 12 12)"/>`,
  phys: '<path d="M8.6 3v7.2a3.4 3.4 0 006.8 0V3"/><path d="M12 13.6V21"/><path d="M5 5.5c-1 1.2-1 2.8 0 4M19 5.5c1 1.2 1 2.8 0 4" opacity=".55"/>',
  noise: '<path d="M2.5 12l1.4-4 1.5 7.5 1.5-10 1.5 12 1.4-9 1.5 6 1.5-7.5 1.4 9.5 1.5-6.5 1.5 4.5 1.4-3 1.5 1.5"/>',
  filter: '<path d="M2.5 8.5h8.5c3 0 3.6-1.8 5-1.8S18.5 11 21.5 18"/>',
  mod: '<path d="M3 12c2.4-6 4.3-6 6 0s3.6 6 6 0"/><path d="M17.5 8.5l3.5 3.5-3.5 3.5"/>',
  env: '<path d="M3 19l4-14 4.5 7H16l2.5 7"/>',
  perform: `<path d="M9 17.5V5l10.5-2v12.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17" cy="15.5" r="2.5"/>`,
  amp: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/>',
  // physical models
  'm-string': `<circle cx="3.8" cy="12" r="1.3" ${F}/><circle cx="20.2" cy="12" r="1.3" ${F}/><path d="M5.1 12c3.1-3.2 5.1-3.2 6.9 0s3.8 3.2 6.9 0"/>`,
  'm-bar': '<rect x="3" y="8.5" width="18" height="5.5" rx="1.6"/><path d="M7 14v4.5M17 14v4.5"/>',
  'm-bell': '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.6 2.2H4.4z"/><path d="M10 20.6a2.1 2.1 0 004 0"/>',
  'm-glass': '<path d="M7 3.2h10c0 5-2 8.6-5 8.6S7 8.2 7 3.2z"/><path d="M12 11.8V19"/><path d="M8.5 20.5h7"/>',
  'm-membrane': '<ellipse cx="12" cy="9" rx="8.5" ry="3.2"/><path d="M3.5 9v5.8c0 1.8 3.8 3.2 8.5 3.2s8.5-1.4 8.5-3.2V9"/><path d="M8 9.2c1.2.9 6.8.9 8 0" opacity=".5"/>',
  'm-plate': '<rect x="4" y="4" width="16" height="16" rx="1.6"/><path d="M4 12c2.7-2.2 5.3 2.2 8 0s5.3-2.2 8 0"/><path d="M12 4c-2.2 2.7 2.2 5.3 0 8s2.2 5.3 0 8" opacity=".55"/>',
  // exciters
  'x-pluck': '<path d="M12 20.5c-3.4-3-6.3-7.6-6.3-11.4a6.3 6.3 0 0112.6 0c0 3.8-2.9 8.4-6.3 11.4z"/>',
  'x-mallet': '<path d="M4.5 19.5l9.2-9.2"/><ellipse cx="16.4" cy="7.6" rx="4" ry="3.1" transform="rotate(-45 16.4 7.6)"/>',
  'x-bow': '<path d="M3.5 18.5L18.5 3.5"/><path d="M5.8 20.8L20.8 5.8"/><path d="M3.5 18.5l2.3 2.3M18.5 3.5l2.3 2.3"/>',
  'x-breath': '<path d="M3 9h10.5a2.5 2.5 0 10-2.5-2.5"/><path d="M3 13h14.5a2.5 2.5 0 11-2.5 2.5"/><path d="M3 17h6"/>',
};

/** SVG markup string for an icon. */
export function iconSvg(name, size = 18) {
  const body = ICONS[name] || ICONS.fx;
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** <span class="ic-wrap"> with the icon inside. */
export function icon(name, size = 18, cls = '') {
  const e = document.createElement('span');
  e.className = `ic-wrap ${cls}`.trim();
  e.innerHTML = iconSvg(name, size);
  return e;
}
