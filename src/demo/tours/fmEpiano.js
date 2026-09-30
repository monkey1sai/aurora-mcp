// Tour (b) FM 電鋼琴誕生 — sine → 1:1 modulator → decaying index → second carrier → 14× tine → velocity
// → key scaling → chorus → tremolo → room.
import { notes, chordAt } from './compile.js';

const soft = 0.4, hard = 0.9;
const ev = [
  // bar 1: Fmaj9 — soft chord, hard push
  ...chordAt(0, [41], 3.8, 0.62), ...chordAt(0, [57, 60, 64, 67], 1.6, soft, 0.012), ...chordAt(2.5, [57, 60, 64, 67], 1.2, hard, 0.01),
  // bar 2: Em7
  ...chordAt(4, [40], 3.8, 0.62), ...chordAt(4, [55, 59, 62, 64], 1.6, soft, 0.012), ...chordAt(6.5, [55, 59, 62, 64], 1.2, hard, 0.01),
  // bar 3: Dm9
  ...chordAt(8, [38], 3.8, 0.62), ...chordAt(8, [53, 57, 60, 64], 1.6, soft, 0.012), ...chordAt(10.5, [53, 57, 60, 64], 1.2, hard, 0.01),
  // bar 4: Cmaj7 → melody fill
  ...chordAt(12, [36], 3.8, 0.62), ...chordAt(12, [52, 55, 59, 62], 3.6, 0.55, 0.02),
  [13, 72, 0.45, 0.5], [13.5, 74, 0.45, 0.62], [14, 76, 0.9, 0.85], [15, 79, 0.9, 0.95],
];

export default {
  id: 'fm-epiano',
  title: 'Birth of an FM E-Piano',
  zh: 'FM 電鋼琴誕生',
  description: {
    zh: '只用四個正弦波：看頻率調變如何從一聲單調的「嗚」，長出 80 年代電鋼琴的金屬鐘鳴、力度咬感與搖曳顫音。',
    en: 'Four sine waves become a classic 80s electric piano: modulation, a 14× tine, velocity bite and tremolo.',
  },
  icon: 'keys',
  cover: { colors: ['#5cf2ff', '#7aa2ff', '#ff9fd6'] },
  bpm: 84,
  start: {
    category: 'keys',
    params: {
      'osc1.on': false, 'fm.on': true, 'fm.level': 0.9, 'fm.filt': 0, 'fm.algo': 3, 'fm.feedback': 0,
      'fm.op1.ratio': 1, 'fm.op1.level': 0.95, 'fm.op1.a': 0.001, 'fm.op1.d': 20, 'fm.op1.s': 1, 'fm.op1.r': 0.45, 'fm.op1.vel': 0.2, 'fm.op1.kscale': 0,
      'fm.op2.ratio': 1, 'fm.op2.level': 0, 'fm.op2.a': 0.001, 'fm.op2.d': 20, 'fm.op2.s': 1, 'fm.op2.r': 0.45, 'fm.op2.vel': 0, 'fm.op2.kscale': 0,
      'fm.op3.ratio': 1, 'fm.op3.detune': 3, 'fm.op3.level': 0, 'fm.op3.a': 0.001, 'fm.op3.d': 2.4, 'fm.op3.s': 0, 'fm.op3.r': 0.35, 'fm.op3.vel': 0.2,
      'fm.op4.ratio': 14, 'fm.op4.level': 0, 'fm.op4.a': 0.001, 'fm.op4.d': 0.32, 'fm.op4.s': 0, 'fm.op4.r': 0.2, 'fm.op4.vel': 0, 'fm.op4.kscale': 0,
      'aenv.a': 0, 'aenv.d': 10, 'aenv.s': 1, 'aenv.r': 0.6, 'amp.vel': 0.35, 'amp.level': -4,
      'chorus.mode': 'chorus', 'chorus.rate': 0.4, 'chorus.depth': 0.4, 'chorus.mix': 0,
      'lfo1.rate': 4.2, 'lfo1.mode': 'mono',
      'reverb.size': 0.5, 'reverb.decay': 2.2, 'reverb.damp': 0.45, 'reverb.mix': 0,
    },
    macros: [
      { name: '咬度 Bark', targets: [{ id: 'fm.op2.level', amount: 0.22 }, { id: 'fm.op4.level', amount: 0.15 }] },
      { name: '顫音 Tremolo', targets: [{ id: 'mod1.amt', amount: 0.3 }, { id: 'lfo1.rate', amount: 0.06 }] },
      { name: '合唱 Chorus', targets: [{ id: 'chorus.mix', amount: 0.3 }, { id: 'chorus.depth', amount: 0.2 }] },
      { name: '空間 Space', targets: [{ id: 'reverb.mix', amount: 0.25 }, { id: 'reverb.decay', amount: 0.15 }] },
    ],
  },
  phrase: { bpm: 84, lengthBeats: 16, loop: true, events: notes(ev) },
  steps: [
    {
      beat: 0, focus: 'fm.op1.level',
      caption: { zh: '純正弦波：只有基音，像音叉一樣乾淨 —— 但也有點單調。', en: 'A pure sine: just the fundamental, clean as a tuning fork — and a little dull.' },
    },
    {
      beat: 8, focus: 'fm.op2.level', ramp: [{ id: 'fm.op2.level', to: 0.5, beats: 6 }],
      caption: { zh: '運算子 2 以 1:1 的頻率去「調變」運算子 1：泛音一個個冒出來，調變越深越明亮。', en: 'Operator 2 modulates operator 1 at a 1:1 ratio: overtones appear, brighter as the depth grows.' },
    },
    {
      beat: 20, focus: 'fm.op2.d',
      set: { 'fm.op2.d': 1.6, 'fm.op2.s': 0.12, 'fm.op1.d': 5.5, 'fm.op1.s': 0 },
      ramp: [{ id: 'fm.op2.level', to: 0.36, beats: 2 }, { id: 'amp.level', to: 1, beats: 2 }],
      caption: { zh: '讓調變量隨時間衰減：音頭明亮、尾音柔和，音量也像被敲擊般慢慢消失。', en: 'Let the modulation decay: a bright attack, a soft tail, and a struck-key fade.' },
    },
    {
      beat: 32, focus: 'fm.op3.level', ramp: [{ id: 'fm.op3.level', to: 0.55, beats: 4 }],
      caption: { zh: '第二個載波（運算子 3），故意失諧 3 音分：兩個聲音交織出溫暖的拍頻。', en: 'A second carrier (op 3), detuned 3 cents: the two voices weave a warm beating.' },
    },
    {
      beat: 44, focus: 'fm.op4.level', ramp: [{ id: 'fm.op4.level', to: 0.25, beats: 3 }],
      caption: { zh: 'Tine 鈴聲：運算子 4 以 14 倍頻率調變、瞬間衰減 —— 敲出電鋼琴那聲清脆的「叮」。', en: 'The tine: op 4 at 14× the pitch, decaying in a flash — that glassy electric-piano “ding”.' },
    },
    {
      beat: 56, focus: 'fm.op2.vel',
      set: { 'fm.op1.vel': 0.35, 'fm.op2.vel': 0.85, 'fm.op3.vel': 0.5, 'fm.op4.vel': 0.75, 'amp.vel': 0.6 },
      caption: { zh: '力度感應：輕彈溫柔、重彈會「咬」—— 彈得越用力，調變越深、聲音越亮。', en: 'Velocity: play softly for warmth, hit hard for bite — harder means deeper modulation.' },
    },
    {
      beat: 68, focus: 'fm.op2.kscale',
      set: { 'fm.op1.kscale': -0.15, 'fm.op2.kscale': -0.35, 'fm.op3.kscale': -0.2, 'fm.op4.kscale': -0.5, 'fm.feedback': 0.08 },
      caption: { zh: '鍵盤縮放：高音區的調變自動變淺，整個音域都一樣甜美。', en: 'Key scaling: modulation eases off up high, so every register stays sweet.' },
    },
    {
      beat: 76, focus: 'chorus.mix', set: { 'chorus.on': true }, ramp: [{ id: 'chorus.mix', to: 0.35, beats: 4 }],
      caption: { zh: '合唱效果：80 年代電鋼琴的招牌光澤。', en: 'Chorus: the signature 80s electric-piano sheen.' },
    },
    {
      beat: 88, focus: 'mod1.amt', set: { 'mod1.src': 'lfo1', 'mod1.dst': 'amp.pan' }, ramp: [{ id: 'mod1.amt', to: 0.3, beats: 4 }],
      caption: { zh: '自動聲像顫音：LFO 讓聲音在左右之間搖擺，就像老式皮箱電鋼琴。', en: 'Auto-pan tremolo: an LFO swings the sound left and right, like a vintage suitcase piano.' },
    },
    {
      beat: 100, focus: 'reverb.mix', set: { 'reverb.on': true }, ramp: [{ id: 'reverb.mix', to: 0.2, beats: 4 }],
      caption: { zh: '再加一點房間殘響，讓琴聲有個空間。', en: 'A touch of room reverb gives the piano a space to live in.' },
    },
    {
      beat: 112, focus: 'macro1', macro: [{ index: 0, to: 0.85, beats: 4 }],
      caption: { zh: '巨集「咬度」：一顆旋鈕同時加深兩個調變器 —— 從溫柔到咬人，只要轉一下。', en: 'The Bark macro deepens both modulators at once — from mellow to biting with one turn.' },
    },
    { beat: 120, macro: [{ index: 0, to: 0, beats: 4 }] },
    {
      beat: 128,
      caption: { zh: '你的 FM 電鋼琴誕生了！彈彈看：輕彈溫柔、重彈會咬。', en: 'Your FM electric piano is born! Play it: soft is gentle, hard bites.' },
    },
  ],
};
