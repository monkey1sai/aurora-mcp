// Tour (f) 從 Init 到史詩主奏 — init saw → second detuned oscillator → hard sync → sync sweep from the envelope →
// legato glide → filter → delayed vibrato → drive → delay throws → hall.
import { notes } from './compile.js';

// E-minor melody with long notes (for vibrato) and legato runs (overlaps glide in legato mode)
const ev = [
  [0, 64, 1.55, 0.8], [1.5, 67, 0.55, 0.72], [2, 71, 2, 0.86],
  [4, 69, 0.55, 0.74], [4.5, 67, 0.55, 0.7], [5, 66, 0.55, 0.72], [5.5, 67, 2.4, 0.8],
  [8, 74, 1.05, 0.88], [9, 76, 2.9, 0.92],
  [12, 74, 0.55, 0.76], [12.5, 71, 0.55, 0.72], [13, 69, 0.55, 0.74], [13.5, 71, 2.3, 0.84],
];

// delay throws: open the delay on the long note at the end of each 16-beat phrase, close it for the next phrase
const throws = [];
for (const b of [112, 128, 144, 160]) {
  throws.push({ beat: b + 13.5, ramp: [{ id: 'delay.mix', to: 0.42, beats: 0.5 }] });
  throws.push({ beat: b + 16, ramp: [{ id: 'delay.mix', to: 0.06, beats: 0.75 }] });
}

export default {
  id: 'epic-lead',
  title: 'From Init to Epic Lead',
  zh: '從 Init 到史詩主奏',
  description: {
    zh: '從最陽春的 Init 音色出發：雙振盪器、硬同步嘯叫、滑音、延遲顫音、失真與「延遲拋送」，打造一支會唱歌的主奏。',
    en: 'From the plain init patch to a singing lead: dual oscillators, hard-sync scream, glide, delayed vibrato, drive and delay throws.',
  },
  icon: 'lead',
  cover: { colors: ['#ff6bd6', '#ffc46b', '#ff6b81'] },
  bpm: 110,
  start: {
    category: 'lead',
    params: {},
    macros: [
      { name: '嘯叫 Sync', targets: [{ id: 'osc1.sync', amount: 0.25 }, { id: 'mod1.amt', amount: 0.15 }] },
      { name: '顫音 Vibrato', targets: [{ id: 'vib.depth', amount: 0.25 }] },
      { name: '拋送 Throw', targets: [{ id: 'delay.mix', amount: 0.35 }, { id: 'delay.feedback', amount: 0.15 }] },
      { name: '失真 Drive', targets: [{ id: 'drive.amount', amount: 0.3 }] },
    ],
  },
  phrase: { bpm: 110, lengthBeats: 16, loop: true, events: notes(ev) },
  steps: [
    {
      beat: 0, focus: 'osc1.shape',
      caption: { zh: 'Init：合成器最原始的預設音色 —— 一個鋸齒波。每個好聲音都從這裡開始。', en: 'Init: the bare default patch — one sawtooth. Every great sound starts here.' },
    },
    {
      beat: 16, focus: 'osc2.fine', set: { 'osc2.on': true, 'osc2.fine': 9, 'osc1.fine': -4 }, ramp: [{ id: 'osc2.level', to: 0.6, beats: 4 }],
      caption: { zh: '第二個振盪器，微微失諧：兩個鋸齒波互相拍動，聲音變得又厚又活。', en: 'A second, slightly detuned oscillator: the two saws beat together — thicker and alive.' },
    },
    {
      beat: 32, focus: 'osc1.sync', ramp: [{ id: 'osc1.sync', to: 0.32, beats: 6 }],
      caption: { zh: '硬同步 Sync：振盪器 1 被迫不斷重置，長出尖銳、像在「說話」的泛音。', en: 'Hard sync: oscillator 1 is forced to restart each cycle, growing sharp, vocal overtones.' },
    },
    {
      beat: 44, focus: 'mod1.amt', set: { 'mod1.src': 'fenv', 'mod1.dst': 'osc1.sync', 'fenv.d': 0.6, 'fenv.s': 0.15 }, ramp: [{ id: 'mod1.amt', to: 0.3, beats: 2 }],
      caption: { zh: '讓濾波包絡掃動 Sync：每個音一開頭都「啾——」地嘯叫，再回到溫暖的音色。', en: 'Let the envelope sweep the sync: every note starts with a “yeow” scream, then settles.' },
    },
    {
      beat: 56, focus: 'voice.glide', set: { 'voice.mode': 'legato', 'voice.glide': 0.07 },
      caption: { zh: '單音 Legato 與滑音：主奏要像人聲一樣連貫，音與音之間滑過去。', en: 'Mono legato + glide: a lead should sing, sliding from note to note like a voice.' },
    },
    {
      beat: 68, focus: 'filter.cutoff', ramp: [{ id: 'filter.cutoff', to: 3600, beats: 4 }, { id: 'filter.res', to: 0.24, beats: 4 }, { id: 'filter.env', to: 0.25, beats: 4 }],
      caption: { zh: '濾波器收一點、加一點共振：去掉刺耳的高頻，讓聲音有「喉音」。', en: 'Tame the filter and add some resonance: less fizz, more throat.' },
    },
    {
      beat: 80, focus: 'vib.depth', set: { 'vib.delay': 0.45, 'vib.rate': 5.6 }, ramp: [{ id: 'vib.depth', to: 22, beats: 4 }],
      caption: { zh: '延遲顫音：長音先直直地唱出來，過一會兒才開始搖 —— 就像歌手和小提琴手。', en: 'Delayed vibrato: long notes start straight and bloom into vibrato — like a singer or violinist.' },
    },
    {
      beat: 96, focus: 'drive.amount', set: { 'drive.on': true, 'drive.type': 'soft', 'drive.tone': 0.45 }, ramp: [{ id: 'drive.amount', to: 0.4, beats: 4 }],
      caption: { zh: '一點失真：更有咬勁、更有存在感，在混音裡站得住。', en: 'A little drive: more bite and presence, so it cuts through a mix.' },
    },
    {
      beat: 112, focus: 'delay.mix', set: { 'delay.on': true, 'delay.sync': '1/4D', 'delay.feedback': 0.42, 'delay.pingpong': 0.8, 'delay.tone': 0.4, 'delay.mix': 0.06 },
      caption: { zh: '延遲拋送 Delay Throw：平常只留一點回聲，樂句尾巴再把延遲推滿 —— 回聲不會糊掉旋律。', en: 'Delay throws: keep the echo low, then push it only on phrase endings — no mush over the melody.' },
    },
    ...throws,
    {
      beat: 128, focus: 'reverb.mix', set: { 'reverb.on': true, 'reverb.size': 0.75, 'reverb.decay': 3.6, 'reverb.damp': 0.5 }, ramp: [{ id: 'reverb.mix', to: 0.22, beats: 4 }],
      caption: { zh: '最後加上大廳殘響 —— 史詩主奏完成！', en: 'Finally a hall reverb — your epic lead is ready!' },
    },
    {
      beat: 144, focus: 'macro1', macro: [{ index: 0, to: 0.8, beats: 4 }],
      caption: { zh: '巨集「嘯叫」：同時推高 Sync 與包絡掃動量 —— 主奏開始尖叫！', en: 'The Sync macro pushes the sync and its envelope sweep together — the lead starts to scream!' },
    },
    { beat: 152, macro: [{ index: 0, to: 0, beats: 4 }] },
    {
      beat: 160,
      caption: { zh: '從 Init 到史詩主奏，只用了十個步驟。接上 MIDI 鍵盤或用電腦鍵盤彈彈看！', en: 'Init to epic in ten steps. Play it with your MIDI or computer keyboard!' },
    },
  ],
};
