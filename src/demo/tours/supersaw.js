// Tour (a) 打造 Supersaw 鋪底 — one saw → unison → detune → width → filter → envelope → ensemble → reverb → shimmer.
import { notes } from './compile.js';

const CH = [
  [45, 60, 64, 71], // Am9 (A2 | C4 E4 B4)
  [41, 60, 64, 69], // Fmaj7 (F2 | C4 E4 A4)
  [48, 62, 64, 67], // Cadd9 (C3 | D4 E4 G4)
  [43, 59, 62, 67], // G (G2 | B3 D4 G4)
];
const ev = [];
CH.forEach((c, i) => c.forEach((n, k) => ev.push([i * 4 + k * 0.01, n, 3.7 - k * 0.01, k === 0 ? 0.72 : 0.64])));

export default {
  id: 'supersaw-pad',
  title: 'Building a Supersaw Pad',
  zh: '打造 Supersaw 鋪底',
  description: {
    zh: '從一個鋸齒波開始，一步步疊出齊奏、失諧、寬度、濾波、合奏與微光殘響 —— 聽聽經典 Trance 鋪底是怎麼長出來的。',
    en: 'Start from one sawtooth and stack unison, detune, width, filtering, ensemble and a shimmering reverb.',
  },
  icon: 'pad',
  cover: { colors: ['#3ef0b0', '#5cf2ff', '#a78bfa'] },
  bpm: 90,
  start: {
    category: 'pad',
    params: {
      'osc1.level': 0.62, 'osc1.shape': 2 / 3, 'osc1.unison': 1, 'osc1.detune': 0, 'osc1.spread': 0, 'osc1.blend': 0.55, 'osc1.drift': 0.15,
      'osc1.phase': 'random',
      'filter.type': 'ladder24', 'filter.cutoff': 14000, 'filter.res': 0.08, 'filter.key': 0.35,
      'aenv.a': 0.02, 'aenv.d': 1, 'aenv.s': 1, 'aenv.r': 0.35,
      'amp.level': -3, 'amp.vel': 0.3, 'voice.poly': 10,
      'chorus.mode': 'ensemble', 'chorus.rate': 0.35, 'chorus.depth': 0.55, 'chorus.mix': 0,
      'reverb.size': 0.82, 'reverb.decay': 5.5, 'reverb.damp': 0.4, 'reverb.predelay': 0.03, 'reverb.mix': 0,
      'lfo1.rate': 0.11, 'lfo1.mode': 'mono',
      'osc2.shape': 1 / 3, 'osc2.oct': -1, 'osc2.level': 0,
    },
    macros: [
      { name: '亮度 Bright', targets: [{ id: 'filter.cutoff', amount: 0.3 }, { id: 'filter.res', amount: 0.06 }] },
      { name: '失諧 Detune', targets: [{ id: 'osc1.detune', amount: 0.3 }, { id: 'chorus.depth', amount: 0.2 }] },
      { name: '微光 Shimmer', targets: [{ id: 'reverb.shimmer', amount: 0.4 }] },
      { name: '空間 Space', targets: [{ id: 'reverb.mix', amount: 0.28 }, { id: 'reverb.decay', amount: 0.15 }] },
    ],
  },
  phrase: { bpm: 90, lengthBeats: 16, loop: true, events: notes(ev) },
  steps: [
    {
      beat: 0, focus: 'osc1.shape',
      caption: { zh: '一個鋸齒波：明亮、帶點嗡嗡聲 —— 所有 Supersaw 都從這裡開始。', en: 'One sawtooth wave: bright and buzzy. Every supersaw starts here.' },
    },
    {
      beat: 12, focus: 'osc1.unison', set: { 'osc1.unison': 7, 'osc1.detune': 0.04 },
      caption: { zh: '齊奏 Unison ×7：七個鋸齒波疊在一起。音高幾乎一樣時，只會輕輕地「晃」。', en: 'Unison ×7: seven saws stacked. At nearly the same pitch they only shimmer gently.' },
    },
    {
      beat: 20, focus: 'osc1.detune', ramp: [{ id: 'osc1.detune', to: 0.4, beats: 8 }],
      caption: { zh: '失諧 Detune：把七個聲部慢慢拉開，拍頻越來越密，變成厚實閃亮的超級鋸齒波。', en: 'Detune: pull the seven voices apart — the beating thickens into the classic supersaw.' },
    },
    {
      beat: 32, focus: 'osc1.spread', ramp: [{ id: 'osc1.spread', to: 1, beats: 6 }],
      caption: { zh: '立體寬度：把齊奏聲部分散到左右兩邊，聲音從中間往外包圍你。', en: 'Width: spread the unison voices left and right so the sound wraps around you.' },
    },
    {
      beat: 44, focus: 'filter.cutoff', ramp: [{ id: 'filter.cutoff', to: 2300, beats: 8 }, { id: 'filter.res', to: 0.16, beats: 8 }],
      caption: { zh: '低通濾波器：削掉刺耳的高頻，鋪底變得溫暖、退到背景。', en: 'Low-pass filter: shave off the harsh top so the pad turns warm and sits behind the music.' },
    },
    {
      beat: 56, focus: 'aenv.a', ramp: [{ id: 'aenv.a', to: 0.7, beats: 2 }, { id: 'aenv.r', to: 2.4, beats: 2 }],
      set: { 'osc2.on': true },
      caption: { zh: '慢起音、長釋放，再墊一層低八度的三角波：鋪底像呼吸一樣淡入淡出。', en: 'Slow attack, long release and a sub-octave triangle: the pad now breathes in and out.' },
    },
    { beat: 56, ramp: [{ id: 'osc2.level', to: 0.42, beats: 4 }] },
    {
      beat: 68, focus: 'chorus.mix', set: { 'chorus.on': true }, ramp: [{ id: 'chorus.mix', to: 0.42, beats: 6 }],
      caption: { zh: 'Ensemble 合奏效果：三組緩慢飄移的延遲線，帶來 70 年代弦樂機的流動感。', en: 'Ensemble chorus: three drifting delay lines give it that 70s string-machine motion.' },
    },
    {
      beat: 80, focus: 'reverb.mix', set: { 'reverb.on': true }, ramp: [{ id: 'reverb.mix', to: 0.34, beats: 6 }],
      caption: { zh: '大殘響：把整個聲音放進一座大廳，尾音在空間裡慢慢散開。', en: 'A big reverb places the sound in a hall; the tails bloom and fade.' },
    },
    {
      beat: 92, focus: 'reverb.shimmer', ramp: [{ id: 'reverb.shimmer', to: 0.5, beats: 8 }],
      caption: { zh: '微光 Shimmer：殘響每繞一圈就升高八度，長出一層閃閃發亮的光暈。', en: 'Shimmer: each pass through the reverb rises an octave — a glowing halo appears.' },
    },
    {
      beat: 104, focus: 'mod1.amt', set: { 'mod1.src': 'lfo1', 'mod1.dst': 'filter.cutoff' }, ramp: [{ id: 'mod1.amt', to: 0.12, beats: 4 }],
      caption: { zh: '最後一筆：讓緩慢的 LFO 推動濾波器，鋪底像潮汐一樣起伏。', en: 'Final touch: a slow LFO sweeps the filter so the pad rises and falls like a tide.' },
    },
    {
      beat: 116, focus: 'macro1', macro: [{ index: 0, to: 0.8, beats: 4 }],
      caption: { zh: '巨集「亮度」：一顆旋鈕同時打開濾波器、加一點共振 —— 看它自己轉起來。', en: 'The Bright macro: one knob opens the filter and adds a touch of resonance — watch it turn.' },
    },
    { beat: 122, macro: [{ index: 0, to: 0, beats: 4 }] },
    {
      beat: 128,
      caption: { zh: '完成！一個鋸齒波變成了寬廣的 Supersaw 鋪底。換你轉轉巨集旋鈕，或保留這個音色。', en: 'Done! One saw became a vast supersaw pad. Now turn the macros yourself, or keep this sound.' },
    },
  ],
};
