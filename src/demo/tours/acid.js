// Tour (d) 酸性貝斯 Acid — raw saw → low cutoff → resonance → filter envelope → accent → legato glide →
// drive → the classic cutoff sweep → 3/16 delay.
import { notes } from './compile.js';

// 16th-step 303 line in A minor: [step, note, accent, slide]
const A1 = 33, C2 = 36, D2 = 38, E2 = 40, G2 = 43, A2 = 45, C3 = 48;
const BARS = [
  [[0, A1, 1, 0], [2, A2, 0, 0], [3, A1, 0, 1], [4, C2, 0, 0], [5, A1, 0, 0], [6, E2, 1, 0], [8, A1, 0, 0], [9, A2, 1, 1], [10, G2, 0, 0], [11, A2, 0, 0], [12, C2, 0, 0], [14, D2, 1, 1], [15, E2, 0, 0]],
  [[0, A1, 1, 0], [1, A1, 0, 0], [3, A2, 0, 1], [4, G2, 0, 0], [6, A1, 0, 0], [7, C3, 1, 0], [8, A2, 0, 1], [9, E2, 0, 0], [10, A1, 0, 0], [12, G2, 1, 1], [13, A2, 0, 0], [14, C2, 0, 0], [15, E2, 1, 0]],
];
const ev = [];
BARS.forEach((bar, b) => bar.forEach(([s, n, acc, slide], i) => {
  const next = bar[i + 1] ? bar[i + 1][0] : 16;
  const beat = b * 4 + s / 4;
  // slides overlap the next note so legato mode glides into it
  const dur = slide ? (next - s) / 4 + 0.04 : Math.min(0.2, (next - s) / 4 - 0.03);
  ev.push([beat, n, dur, acc ? 1 : 0.68]);
}));

export default {
  id: 'acid-bass',
  title: 'Acid Bass',
  zh: '酸性貝斯 Acid',
  description: {
    zh: 'TB-303 的招牌聲音是怎麼來的？Ladder 濾波器、高共振、濾波包絡、重音、滑音與失真 —— 一步步把鋸齒波變得「酸」起來。',
    en: 'Where the TB-303 sound comes from: ladder filter, resonance, envelope, accents, slides and drive.',
  },
  icon: 'bass',
  cover: { colors: ['#b8f36b', '#3ef0b0', '#ffc46b'] },
  bpm: 124,
  start: {
    category: 'bass',
    params: {
      'osc1.level': 0.9, 'osc1.shape': 2 / 3, 'osc1.phase': 'reset', 'osc1.drift': 0.05,
      'filter.type': 'ladder24', 'filter.cutoff': 9000, 'filter.res': 0.08, 'filter.key': 0.5, 'filter.env': 0, 'filter.vel': 0, 'filter.drive': 0.2,
      'fenv.a': 0.001, 'fenv.d': 0.22, 'fenv.s': 0, 'fenv.r': 0.12, 'fenv.curve': 0.25,
      'aenv.a': 0.001, 'aenv.d': 0.3, 'aenv.s': 0.9, 'aenv.r': 0.06, 'amp.level': 3.5, 'amp.vel': 0.35,
      'voice.mode': 'poly', 'voice.glide': 0,
      'drive.type': 'tube', 'drive.amount': 0, 'drive.tone': 0.55,
      'delay.sync': '3/16', 'delay.feedback': 0.32, 'delay.pingpong': 0.7, 'delay.tone': 0.35, 'delay.mix': 0,
      'comp.amount': 0.3,
    },
    macros: [
      { name: '截止 Cutoff', targets: [{ id: 'filter.cutoff', amount: 0.3 }] },
      { name: '共振 Resonance', targets: [{ id: 'filter.res', amount: 0.18 }] },
      { name: '包絡 Env Mod', targets: [{ id: 'filter.env', amount: 0.3 }, { id: 'fenv.d', amount: 0.15 }] },
      { name: '失真 Drive', targets: [{ id: 'drive.amount', amount: 0.35 }] },
    ],
  },
  phrase: { bpm: 124, lengthBeats: 8, loop: true, events: notes(ev) },
  steps: [
    {
      beat: 0, focus: 'osc1.shape',
      caption: { zh: '原始的鋸齒波低音線：節奏對了，但還一點都不「酸」。', en: 'A raw sawtooth bassline: the groove is there, but it isn’t acid yet.' },
    },
    {
      beat: 8, focus: 'filter.cutoff', ramp: [{ id: 'filter.cutoff', to: 360, beats: 6 }, { id: 'amp.level', to: 5.5, beats: 6 }],
      caption: { zh: '把 Ladder 濾波器關低：高頻消失，只剩下低沉悶悶的嗡嗡聲。', en: 'Close the ladder filter: the highs vanish, leaving a dark, muffled hum.' },
    },
    {
      beat: 16, focus: 'filter.res', ramp: [{ id: 'filter.res', to: 0.78, beats: 6 }],
      caption: { zh: '共振 Resonance：在截止頻率上長出一個尖銳的峰 —— 聽到那個「啾」了嗎？酸味來了。', en: 'Resonance: a sharp peak rises at the cutoff — hear that squelch? Here comes the acid.' },
    },
    {
      beat: 24, focus: 'filter.env', ramp: [{ id: 'filter.env', to: 0.58, beats: 4 }],
      caption: { zh: '濾波包絡：每個音符一開始把濾波器掃開、再迅速關上 —— 「哇呦」的咬字感。', en: 'Filter envelope: every note flicks the filter open and shut — the talking “wow”.' },
    },
    {
      beat: 32, focus: 'filter.vel', set: { 'filter.vel': 0.45 },
      caption: { zh: '重音 Accent：力度大的音符更亮、更尖 —— 303 的樂句就是靠重音在說話。', en: 'Accent: louder notes open the filter further — 303 lines speak through their accents.' },
    },
    {
      beat: 40, focus: 'voice.glide', set: { 'voice.mode': 'legato', 'voice.glide': 0.06 },
      caption: { zh: 'Legato 與滑音：重疊的音符會「滑」過去 —— 這就是 303 的招牌 Slide。', en: 'Legato + glide: overlapping notes slide into each other — the famous 303 slide.' },
    },
    {
      beat: 48, focus: 'drive.amount', set: { 'drive.on': true }, ramp: [{ id: 'drive.amount', to: 0.55, beats: 4 }, { id: 'amp.level', to: 6, beats: 4 }],
      caption: { zh: '電子管失真：把訊號推進飽和，聲音更粗、更兇、更有顆粒。', en: 'Tube drive: push it into saturation — thicker, meaner, grittier.' },
    },
    {
      beat: 56, focus: 'filter.cutoff', ramp: [{ id: 'filter.cutoff', to: 1500, beats: 8 }],
      caption: { zh: '最經典的一招：慢慢把截止頻率轉開……', en: 'The classic move: slowly open the cutoff…' },
    },
    {
      beat: 64, ramp: [{ id: 'filter.cutoff', to: 520, beats: 8 }, { id: 'filter.res', to: 0.84, beats: 8 }],
      caption: { zh: '……再關回來，同時把共振推得更高。整首酸浩室就靠這兩個旋鈕。', en: '…then close it again while pushing the resonance. Whole acid tracks live on these two knobs.' },
    },
    {
      beat: 72, focus: 'delay.mix', set: { 'delay.on': true }, ramp: [{ id: 'delay.mix', to: 0.16, beats: 4 }, { id: 'filter.cutoff', to: 700, beats: 4 }],
      caption: { zh: '3/16 延遲：回聲落在反拍上，在左右聲道間彈跳，律動更迷幻。', en: 'A 3/16 delay: echoes land off the beat and bounce left and right.' },
    },
    {
      beat: 84, focus: 'macro1', macro: [{ index: 0, to: 0.75, beats: 4 }],
      caption: { zh: '巨集「截止」就是你的 303 旋鈕 —— 看，它正在自己來一段濾波器獨奏。', en: 'The Cutoff macro is your 303 knob — watch it play a filter solo on its own.' },
    },
    { beat: 88, macro: [{ index: 0, to: 0.2, beats: 2 }, { index: 2, to: 0.7, beats: 4 }] },
    { beat: 92, macro: [{ index: 0, to: 0, beats: 4 }, { index: 2, to: 0, beats: 4 }] },
    {
      beat: 96,
      caption: { zh: '酸性貝斯完成！轉轉「截止」與「共振」，自己來一段濾波器獨奏。', en: 'Acid bass done! Grab the Cutoff and Resonance macros and play your own filter solo.' },
    },
  ],
};
