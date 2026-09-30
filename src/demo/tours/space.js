// Tour (e) 空間魔法 — dry pluck → tempo delay → ping-pong → feedback & tape → small room → cathedral →
// pre-delay → shimmer → near-infinite "freeze" decay.
import { notes } from './compile.js';

// sparse D-minor pentatonic phrase with plenty of room for echoes
const ev = [
  [0, 74, 0.3, 0.82], [1.5, 72, 0.3, 0.7], [2, 69, 0.3, 0.74], [4, 67, 0.3, 0.72], [5.5, 69, 0.3, 0.7], [6, 62, 0.6, 0.78],
  [8, 65, 0.3, 0.78], [9.5, 67, 0.3, 0.7], [10, 69, 0.3, 0.74], [12, 72, 0.3, 0.76], [13, 74, 0.3, 0.72], [14, 69, 1, 0.8],
];

export default {
  id: 'space-magic',
  title: 'Space Magic',
  zh: '空間魔法',
  description: {
    zh: '同一段乾乾的撥弦旋律，從無響室出發：延遲、乒乓、磁帶回聲、房間、大教堂、微光，直到聲音凍結成一片雲。',
    en: 'One dry pluck melody travels from an anechoic room through delays, rooms and cathedrals to a frozen cloud.',
  },
  icon: 'fx',
  cover: { colors: ['#a78bfa', '#5cf2ff', '#1b2f8f'] },
  bpm: 100,
  start: {
    category: 'pluck',
    params: {
      'osc1.level': 1, 'osc1.shape': 0.55, 'osc2.on': true, 'osc2.level': 0.55, 'osc2.shape': 0, 'osc2.oct': 1,
      'filter.type': 'ladder24', 'filter.cutoff': 1700, 'filter.res': 0.12, 'filter.key': 0.5, 'filter.env': 0.5, 'filter.drive': 0.25,
      'fenv.a': 0.001, 'fenv.d': 0.28, 'fenv.s': 0, 'fenv.r': 0.2,
      'aenv.a': 0.001, 'aenv.d': 0.6, 'aenv.s': 0, 'aenv.r': 0.35, 'aenv.curve': 0.35, 'amp.level': 6, 'amp.vel': 0.45,
      'delay.sync': '1/8D', 'delay.feedback': 0.35, 'delay.pingpong': 0, 'delay.tone': 0.55, 'delay.wobble': 0, 'delay.mix': 0,
      'reverb.size': 0.72, 'reverb.decay': 0.9, 'reverb.predelay': 0.01, 'reverb.damp': 0.45, 'reverb.mix': 0, 'reverb.shimmer': 0,
    },
    macros: [
      { name: '回聲 Echo', targets: [{ id: 'delay.mix', amount: 0.22 }, { id: 'delay.feedback', amount: 0.15 }] },
      { name: '空間 Space', targets: [{ id: 'reverb.mix', amount: 0.25 }] },
      { name: '微光 Shimmer', targets: [{ id: 'reverb.shimmer', amount: 0.35 }] },
      { name: '亮度 Bright', targets: [{ id: 'filter.cutoff', amount: 0.3 }] },
    ],
  },
  phrase: { bpm: 100, lengthBeats: 16, loop: true, events: notes(ev) },
  steps: [
    {
      beat: 0, focus: 'aenv.d',
      caption: { zh: '乾聲撥弦：沒有任何空間感，像在無響室裡彈奏 —— 每個音一結束就消失了。', en: 'A dry pluck: no space at all, like playing in an anechoic chamber — each note simply stops.' },
    },
    {
      beat: 16, focus: 'delay.mix', set: { 'delay.on': true }, ramp: [{ id: 'delay.mix', to: 0.3, beats: 4 }],
      caption: { zh: '延遲 Delay：聲音的回聲，時間對齊節拍（附點八分音符）—— 旋律自己跟自己合奏。', en: 'Delay: echoes locked to the tempo (a dotted eighth) — the melody now answers itself.' },
    },
    {
      beat: 28, focus: 'delay.pingpong', ramp: [{ id: 'delay.pingpong', to: 1, beats: 4 }],
      caption: { zh: '乒乓 Ping-Pong：回聲在左右聲道之間來回彈跳。', en: 'Ping-pong: the echoes bounce between the left and right speakers.' },
    },
    {
      beat: 40, focus: 'delay.feedback',
      ramp: [{ id: 'delay.feedback', to: 0.58, beats: 4 }, { id: 'delay.tone', to: 0.3, beats: 4 }, { id: 'delay.wobble', to: 0.4, beats: 4 }],
      caption: { zh: '回授更高、音色更暗、加一點磁帶抖動：像一台老舊的磁帶回聲機。', en: 'More feedback, a darker tone and tape wobble: a vintage tape echo.' },
    },
    {
      beat: 52, focus: 'reverb.mix', set: { 'reverb.on': true }, ramp: [{ id: 'reverb.mix', to: 0.3, beats: 4 }, { id: 'delay.mix', to: 0.22, beats: 4 }],
      caption: { zh: '殘響 Reverb：先是一個小房間 —— 聲音有了牆壁。', en: 'Reverb: a small room first — the sound gains walls.' },
    },
    {
      beat: 64, focus: 'reverb.decay', ramp: [{ id: 'reverb.decay', to: 6, beats: 8 }],
      caption: { zh: '殘響時間：尾音越拉越長，牆壁彷彿越推越遠 —— 從房間變成大教堂。', en: 'Decay time: the tail stretches and the walls seem to recede — from a room to a cathedral.' },
    },
    {
      beat: 76, focus: 'reverb.predelay', ramp: [{ id: 'reverb.predelay', to: 0.12, beats: 4 }],
      caption: { zh: '預延遲：讓乾聲先出來，殘響晚一點才綻開 —— 清楚又寬廣。', en: 'Pre-delay: the dry note speaks first and the reverb blooms a moment later — clear yet vast.' },
    },
    {
      beat: 88, focus: 'reverb.shimmer', ramp: [{ id: 'reverb.shimmer', to: 0.55, beats: 8 }],
      caption: { zh: '微光 Shimmer：殘響每繞一圈就升高一個八度，像天使合唱從遠方升起。', en: 'Shimmer: every pass rises an octave, like a distant choir of angels.' },
    },
    {
      beat: 100, focus: 'reverb.decay',
      ramp: [{ id: 'reverb.decay', to: 24, beats: 8 }, { id: 'reverb.mix', to: 0.42, beats: 8 }, { id: 'reverb.damp', to: 0.3, beats: 8 }, { id: 'delay.mix', to: 0.16, beats: 8 }],
      caption: { zh: '近乎無限的殘響：把時間拉到 24 秒，聲音幾乎凍結，一層層堆成一片雲。', en: 'Near-infinite decay: stretch it to 24 s and the sound freezes into a slowly growing cloud.' },
    },
    {
      beat: 116, focus: 'macro4', macro: [{ index: 3, to: 0.8, beats: 4 }],
      caption: { zh: '巨集「亮度」：撥弦變亮，雲裡的每一個回聲也跟著發光。', en: 'The Bright macro: the pluck brightens, and every echo in the cloud lights up with it.' },
    },
    { beat: 122, macro: [{ index: 3, to: 0, beats: 4 }] },
    {
      beat: 128,
      caption: { zh: '同一段旋律，完全不同的世界 —— 空間效果就是聲音的風景。', en: 'The same melody, a different world — space is the landscape of sound.' },
    },
  ],
};
