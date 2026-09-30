// Toasts, modal dialogs, confirm, and popover menus (glass style, keyboard accessible).

import { h } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';

let toastHost = null;
const recent = new Map(); // message → time (dedupe floods)

/** Transient notification. kind: 'info' | 'ok' | 'warn' | 'error'. */
export function toast(message, { kind = 'info', ms = 2600 } = {}) {
  if (typeof document === 'undefined') return;
  const nowT = performance.now();
  if (recent.has(message) && nowT - recent.get(message) < 1500) return;
  recent.set(message, nowT);
  if (!toastHost) {
    toastHost = document.getElementById('toasts') || document.body.appendChild(h('div.toasts', { id: 'toasts', 'aria-live': 'polite' }));
  }
  const ic = { ok: 'check', warn: 'panic', error: 'panic', info: 'fx' }[kind] || 'fx';
  const el = h(`div.toast.toast--${kind}`, { role: kind === 'error' ? 'alert' : 'status' }, icon(ic, 16), h('span.toast__msg', null, message));
  toastHost.append(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  const close = () => { el.classList.remove('is-in'); el.classList.add('is-out'); setTimeout(() => el.remove(), 320); };
  const timer = setTimeout(close, kind === 'error' ? Math.max(ms, 6000) : ms);
  el.addEventListener('click', () => { clearTimeout(timer); close(); });
  while (toastHost.children.length > 4) toastHost.firstChild.remove();
}

/**
 * Modal dialog. content: Node. actions: [{ label, kind:'primary'|'ghost'|'danger', onClick(close) → false keeps open }].
 * Returns { el, close }. Esc / backdrop click closes (onClose called).
 */
export function openModal({ title, content, actions = [], onClose, cls = '' }) {
  const prevFocus = document.activeElement;
  const box = h(`div.modal ${cls}`.trim(), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' });
  const head = h('div.modal__head', null, h('h2.modal__title', null, title || ''),
    h('button.icon-btn.modal__x', { type: 'button', 'aria-label': t('cancel'), onclick: () => close() }, icon('x', 18)));
  const body = h('div.modal__body', null, content);
  const foot = h('div.modal__foot');
  for (const a of actions) {
    const b = h(`button.btn.btn--${a.kind || 'ghost'}`, { type: a.submit ? 'submit' : 'button' }, a.label);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const keep = a.onClick ? a.onClick(close) === false : false;
      if (!keep) close();
    });
    foot.append(b);
  }
  box.append(head, body);
  if (actions.length) box.append(foot);
  const back = h('div.modal-back', null, box);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('is-in'));
  setTimeout(() => {
    const first = box.querySelector('input, textarea, select') || foot.querySelector('.btn--primary') || box.querySelector('button');
    if (first) first.focus();
  }, 30);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    back.classList.remove('is-in');
    setTimeout(() => back.remove(), 220);
    if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (onClose) onClose();
  }
  return { el: box, close };
}

/** Promise<boolean> confirmation dialog. */
export function confirmDialog(message, { okLabel = t('ok'), danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title: message,
      content: h('div'),
      cls: 'modal--small',
      actions: [
        { label: t('cancel'), kind: 'ghost' },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

let current = null; // the open popover menu { anchor, close }

/**
 * Popover menu anchored to a button. items: [{ label, icon, onClick, disabled, sep }]
 * Toggles: opening it again from the same anchor closes it (returns null); another open menu closes first.
 */
export function openMenu(anchor, items) {
  if (current) {
    const same = current.anchor === anchor;
    current.close();
    if (same) return null;
  }
  const menu = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (it.sep) { menu.append(h('div.menu__sep', { role: 'separator' })); continue; }
    const b = h('button.menu__item', { type: 'button', role: 'menuitem', disabled: it.disabled || false },
      it.icon ? icon(it.icon, 16) : h('span.ic-wrap'), h('span', null, it.label), it.hint ? h('kbd', null, it.hint) : null);
    b.addEventListener('click', () => { close(); it.onClick && it.onClick(); });
    menu.append(b);
  }
  document.body.append(menu);
  const rc = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = `${Math.round(rc.bottom + 8)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, rc.right - w)))}px`;
  requestAnimationFrame(() => menu.classList.add('is-in'));
  const btns = [...menu.querySelectorAll('.menu__item:not([disabled])')];
  if (btns[0]) btns[0].focus();
  const onDown = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => {
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (btns[i - 1] || btns[btns.length - 1]).focus(); }
  };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  document.addEventListener('keydown', onKey, true);
  if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
  let closed = false;
  const ref = { anchor, close };
  current = ref;
  function close() {
    if (closed) return;
    closed = true;
    if (current === ref) current = null;
    if (anchor.setAttribute) anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    menu.classList.remove('is-in');
    setTimeout(() => menu.remove(), 160);
  }
  return { close };
}
