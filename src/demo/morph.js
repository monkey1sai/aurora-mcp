// Shared pure morph math: browser UI and MCP use the same implementation.
import { PARAM_BY_ID, toNorm, fromNorm } from '../dsp/params.js';
import { PATCH_IDS, blendValues, sanitizeValue } from '../ui/app/store.js';

/** Complete native patch values of a preset (defaults filled in, global params excluded, sanitised). */
export function presetValues(preset) {
  const params = (preset && preset.params) || {};
  const out = {};
  for (const id of PATCH_IDS) { const p = PARAM_BY_ID[id]; out[id] = sanitizeValue(p, params[id] !== undefined ? params[id] : p.def); }
  return out;
}

/** Values with the macro offsets baked in (what the engine hears) and macro knobs at 0. */
export function effectiveValues(values, macros) {
  const out = { ...values };
  const acc = new Map();
  (macros || []).forEach((m, i) => {
    const mv = +values[`macro${i + 1}`] || 0;
    if (!mv || !m || !m.targets) return;
    for (const t of m.targets) {
      const p = PARAM_BY_ID[t.id];
      if (!p || p.scope === 'global' || (p.type !== 'float' && p.type !== 'int')) continue;
      acc.set(t.id, (acc.has(t.id) ? acc.get(t.id) : toNorm(p, values[t.id])) + t.amount * mv);
    }
  });
  for (const [id, n] of acc) out[id] = sanitizeValue(PARAM_BY_ID[id], fromNorm(PARAM_BY_ID[id], n < 0 ? 0 : n > 1 ? 1 : n));
  for (let i = 1; i <= 4; i++) out[`macro${i}`] = 0;
  return out;
}

/** Undo effectiveValues for a macro set: base = eff − Σ amount·macro (clamped), macro knobs restored. */
export function unbakeMacros(eff, macros, macroValues) {
  const out = { ...eff };
  const acc = new Map();
  (macros || []).forEach((m, i) => {
    const mv = +macroValues[i] || 0;
    if (!mv || !m || !m.targets) return;
    for (const t of m.targets) {
      const p = PARAM_BY_ID[t.id];
      if (!p || p.scope === 'global' || (p.type !== 'float' && p.type !== 'int')) continue;
      acc.set(t.id, (acc.has(t.id) ? acc.get(t.id) : toNorm(p, eff[t.id])) - t.amount * mv);
    }
  });
  for (const [id, n] of acc) out[id] = sanitizeValue(PARAM_BY_ID[id], fromNorm(PARAM_BY_ID[id], n < 0 ? 0 : n > 1 ? 1 : n));
  for (let i = 1; i <= 4; i++) out[`macro${i}`] = +macroValues[i - 1] || 0;
  return out;
}

/**
 * The morph point between two patches: { values, macros } where values is complete (native) and macros are the
 * nearer side's definitions (t < ½ → A). t = 0 / 1 reproduce A / B exactly (macro knobs included).
 */
export function morphPatch(A, B, t) {
  if (!(t > 0)) return { values: { ...A.values }, macros: A.macros };
  if (t >= 1) return { values: { ...B.values }, macros: B.macros };
  // no position-based level dip: the kept/rested morph point must never sit on a muted engine
  const eff = blendValues(effectiveValues(A.values, A.macros), effectiveValues(B.values, B.macros), t, PATCH_IDS, { dip: false });
  const near = t < 0.5 ? A : B;
  const mv = [1, 2, 3, 4].map(i => +near.values[`macro${i}`] || 0);
  return { values: unbakeMacros(eff, near.macros, mv), macros: near.macros };
}
