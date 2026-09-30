// Tour (c) 一根弦的旅程 — physical-model string: pluck → hardness → position → body → decay → width →
// stiffness (inharmonicity) → bar → bell → glass.
import { notes } from './compile.js';

// G-major pentatonic arpeggios over G – Em – C – D (8th notes, letting each string ring)
const ARP = [
  [55, 62, 67, 71, 69, 67], [52, 59, 64, 67, 71, 69], [48, 55, 62, 64, 67, 69], [50, 57, 62, 67, 71, 74],
];
const POS = [0, 0.5, 1, 1.5, 2.5, 3];
const ev = [];
ARP.forEach((bar, b) => bar.forEach((n, k) => ev.push([b * 4 + POS[k], n, k === 0 ? 3.5 : 1.4, k === 0 ? 0.78 : 0.66 + (k % 2) * 0.08])));

export default {
  id: 'string-journey',
  title: 'Journey of a String',
  zh: '一根弦的旅程',
  description: {
    zh: '物理模型合成：從一根被撥動的弦出發，調整硬度、撥弦位置、共鳴箱與材質，最後變成馬林巴、教堂鐘與水晶杯。',
    en: 'Physical modelling: pluck a string, shape it with hardness, position, body and stiffness — then morph into a marimba, a bell and crystal glass.',
  },
  icon: 'pluck',
  cover: { colors: ['#ffc46b', '#3ef0b0', '#8fd8ff'] },
  bpm: 96,
  start: {
    category: 'pluck',
    params: {
      'osc1.on': false, 'phys.on': true, 'phys.level': 0.9, 'phys.filt': 0,
      'phys.model': 'string', 'phys.exciter': 'pluck', 'phys.hardness': 0.5, 'phys.position': 0.25, 'phys.decay': 2,
      'phys.brightness': 0.6, 'phys.inharm': 0.02, 'phys.body': 0, 'phys.spread': 0, 'phys.damp': 0.55,
      'aenv.a': 0, 'aenv.d': 10, 'aenv.s': 1, 'aenv.r': 2.5, 'amp.level': 3.5, 'amp.vel': 0.4,
      'reverb.size': 0.6, 'reverb.decay': 3.2, 'reverb.damp': 0.4, 'reverb.mix': 0,
    },
    macros: [
      { name: '硬度 Hardness', targets: [{ id: 'phys.hardness', amount: 0.3 }, { id: 'phys.brightness', amount: 0.12 }] },
      { name: '材質 Material', targets: [{ id: 'phys.inharm', amount: 0.3 }] },
      { name: '延音 Sustain', targets: [{ id: 'phys.decay', amount: 0.2 }] },
      { name: '空間 Space', targets: [{ id: 'reverb.mix', amount: 0.3 }, { id: 'reverb.decay', amount: 0.15 }] },
    ],
  },
  phrase: { bpm: 96, lengthBeats: 16, loop: true, events: notes(ev) },
  steps: [
    {
      beat: 0, focus: 'phys.model',
      caption: { zh: '撥一根弦：一小段雜訊在延遲線裡來回反射、逐漸衰減，就成了有音高的弦聲（Karplus-Strong）。', en: 'Pluck a string: a burst of noise bounces around a delay line and decays into a pitched tone (Karplus-Strong).' },
    },
    {
      beat: 8, focus: 'phys.hardness', ramp: [{ id: 'phys.hardness', to: 0.12, beats: 4 }],
      caption: { zh: '撥弦硬度：軟一點，像用指腹撥 —— 圓潤、柔和。', en: 'Hardness: softer, like plucking with a fingertip — round and mellow.' },
    },
    {
      beat: 16, ramp: [{ id: 'phys.hardness', to: 0.82, beats: 4 }],
      caption: { zh: '硬一點，像用彈片或指甲 —— 清脆、明亮。', en: 'Harder, like a pick or a fingernail — crisp and bright.' },
    },
    {
      beat: 24, focus: 'phys.position', ramp: [{ id: 'phys.position', to: 0.06, beats: 4 }, { id: 'phys.hardness', to: 0.6, beats: 4 }],
      caption: { zh: '撥弦位置：靠近琴橋撥，聲音變細、帶鼻音 —— 就像吉他手在琴橋邊彈。', en: 'Pluck position: near the bridge the tone turns thin and nasal, like a guitarist picking by the bridge.' },
    },
    {
      beat: 32, focus: 'phys.body', ramp: [{ id: 'phys.body', to: 0.6, beats: 4 }, { id: 'phys.position', to: 0.2, beats: 4 }],
      caption: { zh: '共鳴箱：六個木頭共振峰讓弦有了琴身 —— 更溫暖、更像真的樂器。', en: 'Body: six wooden resonances give the string a soundbox — warmer and more real.' },
    },
    {
      beat: 40, focus: 'phys.decay', ramp: [{ id: 'phys.decay', to: 5.5, beats: 4 }, { id: 'phys.spread', to: 0.45, beats: 4 }],
      caption: { zh: '延音與寬度：弦振動得更久；兩根微微失諧的弦讓聲音向左右展開。', en: 'Sustain and width: the string rings longer, and two slightly detuned strings spread it wide.' },
    },
    {
      beat: 48, focus: 'phys.inharm', ramp: [{ id: 'phys.inharm', to: 0.45, beats: 6 }],
      caption: { zh: '材質／非諧性：弦變得僵硬，泛音被往上拉伸 —— 越來越像鋼琴、甚至金屬。', en: 'Stiffness: overtones stretch upward — the string turns piano-like, then metallic.' },
    },
    {
      beat: 59.5, focus: 'phys.model',
      set: { 'amp.level': -1.5, 'phys.model': 'bar', 'phys.exciter': 'mallet', 'phys.hardness': 0.5, 'phys.position': 0.85, 'phys.decay': 3.5, 'phys.inharm': 0.04, 'phys.body': 0.55, 'phys.brightness': 0.45 },
      caption: { zh: '換成「音條」模型、用琴槌敲：同樣的旋律，變成了溫暖的木琴／鐵琴。', en: 'Switch to a bar struck by a mallet: the same melody becomes a marimba-like bar.' },
    },
    {
      beat: 71.5, focus: 'phys.model',
      set: { 'amp.level': 1.5, 'phys.model': 'bell', 'phys.hardness': 0.7, 'phys.position': 0.3, 'phys.decay': 6, 'phys.inharm': 0.12, 'phys.body': 0.2, 'phys.brightness': 0.55, 'phys.spread': 0.6, 'phys.damp': 0.3 },
      caption: { zh: '鐘：教堂鐘的分音 —— 低八度的「哼音」、小三度、五度……一記敲擊，一整片和聲。', en: 'Bell: church-bell partials — the low hum, a minor third, a fifth… one strike, a whole chord.' },
    },
    {
      beat: 83.5, focus: 'phys.model',
      set: { 'amp.level': -3.5, 'phys.model': 'glass', 'phys.hardness': 0.85, 'phys.position': 0.4, 'phys.decay': 5, 'phys.inharm': 0.1, 'phys.body': 0.1, 'phys.brightness': 0.8, 'phys.spread': 0.7, 'reverb.on': true },
      ramp: [{ id: 'reverb.mix', to: 0.3, beats: 4 }],
      caption: { zh: '玻璃：稀疏又明亮的分音，加上殘響 —— 像在大廳裡敲響一只水晶杯。', en: 'Glass: sparse, bright partials plus reverb — a crystal glass ringing in a hall.' },
    },
    {
      beat: 96, focus: 'macro2', macro: [{ index: 1, to: 0.7, beats: 6 }],
      caption: { zh: '巨集「材質」：轉動它，分音的比例跟著滑動 —— 水晶杯慢慢變成另一種金屬。', en: 'The Material macro slides the partial ratios — the crystal glass slowly turns into another metal.' },
    },
    { beat: 104, macro: [{ index: 1, to: 0, beats: 6 }] },
    {
      beat: 112,
      caption: { zh: '從一根弦到一只水晶杯：物理模型只改了幾個「材料」參數。保留這個音色，或再走一次旅程。', en: 'From a string to crystal glass by changing a few “material” settings. Keep it, or take the journey again.' },
    },
  ],
};
