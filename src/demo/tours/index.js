// Sound Tours 音色導覽 — guided, self-playing sound-design lessons ("自動調整音色" showcase).
// Pure data + pure helpers (no DOM): played by src/ui/demo/tourPlayer.js, checked offline in Node.
//
// ─── Tour format ─────────────────────────────────────────────────────────────────────────────────────
// {
//   id: 'supersaw-pad',                       // stable id
//   title: 'Building a Supersaw Pad',         // English title
//   zh: '打造 Supersaw 鋪底',                  // Traditional Chinese title (primary in the UI)
//   description: { zh, en } | string,         // one or two sentences for the tour card
//   icon: 'pad',                              // category icon name (src/ui/app/icons.js) for the card
//   cover: { colors: ['#hex', …] },           // 2–3 colours for the card's animated gradient
//   bpm: 90,                                  // tempo of the phrase and of the step clock (beats)
//   start: {                                  // the patch the tour starts from (usually a simple init-like patch)
//     preset?: 'Factory Preset Name',         //   optional factory preset to start from…
//     params?: { 'param.id': nativeValue },   //   …overlaid with these params (missing → schema defaults)
//     macros?: [{ name, targets:[{id, amount}] }×4],  // macro definitions of the resulting patch
//     category?: 'pad',                       //   preset category when the result is kept
//   },
//   phrase: { bpm, lengthBeats, loop: true, events: [{beat, type:'on', note, vel, dur}] },
//                                             // sequencer song looped underneath so every change is heard
//   steps: [{                                 // beats count from the tour start (not the loop); compileTour sorts by beat
//     beat: 16,
//     caption?: { zh, en },                   // shown (typewriter) when the step starts; steps without a
//                                             //   caption silently automate under the previous caption
//     set?: { 'param.id': value },            // instant changes (enums, bools, numbers)
//     ramp?: [{ id, to, beats }],             // eased ramps in normalised space (knobs visibly move)
//     macro?: [{ index /*0..3*/, to /*0..1*/, beats }],  // macro ramps
//     focus?: 'param.id',                     // editor jumps to the control's tab and rings it with a glow
//   }],
//   endBeat?: number,                         // optional: when to show the "keep / revert" card
// }
// Each tour must end in a patch that sounds good on its own (checked with tools/render.mjs --patch).

import supersaw from './supersaw.js';
import fmEpiano from './fmEpiano.js';
import string from './string.js';
import acid from './acid.js';
import space from './space.js';
import epicLead from './epicLead.js';

export { compileTour, startPatch, finalState, rampValue, ease, patchValues, tourControlEvents } from './compile.js';

/** All tours in display order. */
export const TOURS = [supersaw, fmEpiano, string, acid, space, epicLead];

/** Tour by id (or undefined). */
export const tourById = id => TOURS.find(t => t.id === id);
