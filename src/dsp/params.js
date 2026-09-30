// Central parameter schema — the single contract shared by DSP (AudioWorklet + Node) and UI.
// Pure ES module: no browser or Node APIs.
//
// Value conventions
//   float / int : native units (Hz, seconds, dB, cents, semitones, 0..1 amounts)
//   enum        : option id string in presets/UI; the DSP value array stores the option INDEX
//   bool        : true/false in presets/UI; the DSP value array stores 1/0
//
// Normalised space (0..1) is used for knobs, macros and the modulation matrix.
// curve: 'lin' | 'exp' (log-scaled, min > 0) | 'pow' (value = min + (max-min) * n^k)

const P = [];

function add(id, spec) {
  P.push({ id, scope: 'patch', mod: false, curve: 'lin', unit: '', ...spec });
}
const float = (id, label, zh, min, max, def, extra = {}) =>
  add(id, { type: 'float', label, zh, min, max, def, ...extra });
const int = (id, label, zh, min, max, def, extra = {}) =>
  add(id, { type: 'int', label, zh, min, max, def, ...extra });
const bool = (id, label, zh, def, extra = {}) =>
  add(id, { type: 'bool', label, zh, def, min: 0, max: 1, ...extra });
const choice = (id, label, zh, options, labels, def, extra = {}) =>
  add(id, { type: 'enum', label, zh, options, labels: labels || options, def, min: 0, max: options.length - 1, ...extra });

// ───────────────────────── Voice / performance ─────────────────────────
choice('voice.mode', 'Voice Mode', '發聲模式', ['poly', 'mono', 'legato'], ['Poly', 'Mono', 'Legato'], 'poly', { group: 'voice' });
int('voice.poly', 'Polyphony', '複音數', 1, 16, 12, { group: 'voice' });
float('voice.glide', 'Glide', '滑音', 0, 2, 0, { group: 'voice', unit: 's', curve: 'pow', k: 3 });
int('voice.bend', 'Bend Range', '彎音範圍', 0, 24, 2, { group: 'voice', unit: 'st' });
float('voice.pitch', 'Pitch', '音高', -24, 24, 0, { group: 'voice', unit: 'st', mod: true });
float('voice.spread', 'Voice Spread', '聲部展開', 0, 1, 0, { group: 'voice', unit: '%' });

float('vib.depth', 'Vibrato', '顫音深度', 0, 100, 0, { group: 'vibrato', unit: 'ct', mod: true });
float('vib.rate', 'Vib Rate', '顫音速度', 0.5, 12, 5.5, { group: 'vibrato', unit: 'Hz', curve: 'exp', mod: true });
float('vib.delay', 'Vib Delay', '顫音延遲', 0, 3, 0.3, { group: 'vibrato', unit: 's', curve: 'pow', k: 2 });
float('vib.wheel', 'Wheel Vib', '轉輪顫音', 0, 100, 30, { group: 'vibrato', unit: 'ct' });

float('amp.level', 'Volume', '音量', -36, 6, 0, { group: 'amp', unit: 'dB', mod: true });
float('amp.vel', 'Velocity', '力度感應', 0, 1, 0.5, { group: 'amp', unit: '%' });
float('amp.pan', 'Pan', '聲像', -1, 1, 0, { group: 'amp', unit: 'pan', mod: true });

// ───────────────────────── Sources ─────────────────────────
export const WAVETABLES = ['analog', 'harmonic', 'vowels', 'pulse', 'organ', 'glass', 'sync', 'digital', 'strings', 'growl'];
export const WAVETABLE_LABELS = ['Analog Morph', 'Harmonic Sweep', 'Vowels', 'Pulse Width', 'Organ', 'Glass', 'Sync Sweep', 'Digital', 'Strings', 'Growl'];

for (const o of ['osc1', 'osc2']) {
  const n = o === 'osc1' ? '1' : '2';
  const g = { group: o };
  bool(`${o}.on`, 'On', `振盪器${n}`, o === 'osc1', g);
  float(`${o}.level`, 'Level', '音量', 0, 1, 0.8, { ...g, unit: '%', mod: true });
  choice(`${o}.mode`, 'Mode', '模式', ['classic', 'wavetable'], ['Classic', 'Wavetable'], 'classic', g);
  // classic: 0 sine → 1/3 triangle → 2/3 saw → 1 square (crossfade between neighbours)
  // wavetable: frame position within the selected table
  float(`${o}.shape`, 'Shape', '波形', 0, 1, 2 / 3, { ...g, mod: true });
  choice(`${o}.table`, 'Table', '波表', WAVETABLES, WAVETABLE_LABELS, 'analog', g);
  float(`${o}.pw`, 'Pulse Width', '脈衝寬度', 0.05, 0.95, 0.5, { ...g, unit: '%', mod: true });
  float(`${o}.sync`, 'Sync', '硬同步', 0, 1, 0, { ...g, unit: '%', mod: true });
  int(`${o}.oct`, 'Octave', '八度', -3, 3, 0, { ...g, unit: 'oct' });
  int(`${o}.semi`, 'Semi', '半音', -12, 12, 0, { ...g, unit: 'st' });
  float(`${o}.fine`, 'Fine', '微調', -100, 100, 0, { ...g, unit: 'ct', mod: true });
  int(`${o}.unison`, 'Unison', '齊奏數', 1, 8, 1, g);
  float(`${o}.detune`, 'Detune', '失諧', 0, 1, 0.2, { ...g, unit: '%', mod: true });
  float(`${o}.spread`, 'Width', '立體寬度', 0, 1, 0.7, { ...g, unit: '%' });
  float(`${o}.blend`, 'Blend', '中心/兩側', 0, 1, 0.5, { ...g, unit: '%', mod: true });
  choice(`${o}.phase`, 'Phase', '相位', ['free', 'reset', 'random'], ['Free', 'Reset', 'Random'], 'free', g);
  float(`${o}.drift`, 'Drift', '類比漂移', 0, 1, 0.1, { ...g, unit: '%' });
  float(`${o}.filt`, 'To Filter', '進濾波器', 0, 1, 1, { ...g, unit: '%' });
  float(`${o}.pan`, 'Pan', '聲像', -1, 1, 0, { ...g, unit: 'pan', mod: true });
}

// FM: 4 operators, 8 algorithms (see docs/ARCHITECTURE.md)
bool('fm.on', 'On', 'FM 引擎', false, { group: 'fm' });
float('fm.level', 'Level', '音量', 0, 1, 0.8, { group: 'fm', unit: '%', mod: true });
int('fm.algo', 'Algorithm', '演算法', 1, 8, 1, { group: 'fm' });
float('fm.feedback', 'Feedback', '回授', 0, 1, 0, { group: 'fm', unit: '%', mod: true });
int('fm.oct', 'Octave', '八度', -3, 3, 0, { group: 'fm', unit: 'oct' });
float('fm.fine', 'Fine', '微調', -100, 100, 0, { group: 'fm', unit: 'ct' });
float('fm.filt', 'To Filter', '進濾波器', 0, 1, 1, { group: 'fm', unit: '%' });
float('fm.pan', 'Pan', '聲像', -1, 1, 0, { group: 'fm', unit: 'pan', mod: true });
for (let i = 1; i <= 4; i++) {
  const g = { group: `fm.op${i}` };
  const op = `fm.op${i}`;
  float(`${op}.ratio`, 'Ratio', '頻率比', 0.125, 16, 1, { ...g, unit: 'ratio', curve: 'exp' });
  float(`${op}.detune`, 'Detune', '失諧', -20, 20, 0, { ...g, unit: 'ct' });
  float(`${op}.level`, 'Level', '強度', 0, 1, i === 1 ? 1 : 0.5, { ...g, unit: '%', mod: true });
  float(`${op}.a`, 'Attack', '起音', 0, 10, 0.001, { ...g, unit: 's', curve: 'pow', k: 3 });
  float(`${op}.d`, 'Decay', '衰減', 0.001, 20, 1, { ...g, unit: 's', curve: 'exp' });
  float(`${op}.s`, 'Sustain', '延持', 0, 1, 1, { ...g, unit: '%' });
  float(`${op}.r`, 'Release', '釋放', 0.001, 20, 0.3, { ...g, unit: 's', curve: 'exp' });
  float(`${op}.vel`, 'Vel Sens', '力度', 0, 1, 0.3, { ...g, unit: '%' });
  float(`${op}.kscale`, 'Key Scale', '鍵盤縮放', -1, 1, 0, { ...g, unit: '%' });
}

// Physical modelling: exciter → resonator
bool('phys.on', 'On', '物理模型', false, { group: 'phys' });
float('phys.level', 'Level', '音量', 0, 1, 0.8, { group: 'phys', unit: '%', mod: true });
choice('phys.model', 'Model', '模型', ['string', 'bar', 'bell', 'glass', 'membrane', 'plate'],
  ['String', 'Bar', 'Bell', 'Glass', 'Membrane', 'Plate'], 'string', { group: 'phys' });
choice('phys.exciter', 'Exciter', '激發', ['pluck', 'mallet', 'bow', 'breath'], ['Pluck', 'Mallet', 'Bow', 'Breath'], 'pluck', { group: 'phys' });
float('phys.hardness', 'Hardness', '硬度', 0, 1, 0.5, { group: 'phys', unit: '%', mod: true });
float('phys.position', 'Position', '激發位置', 0, 1, 0.25, { group: 'phys', unit: '%', mod: true });
float('phys.decay', 'Decay', '延音長度', 0.05, 30, 2, { group: 'phys', unit: 's', curve: 'exp', mod: true });
float('phys.brightness', 'Brightness', '亮度', 0, 1, 0.6, { group: 'phys', unit: '%', mod: true });
float('phys.inharm', 'Material', '材質/非諧', 0, 1, 0.1, { group: 'phys', unit: '%', mod: true });
float('phys.body', 'Body', '共鳴箱', 0, 1, 0.3, { group: 'phys', unit: '%', mod: true });
float('phys.pressure', 'Pressure', '持續激發', 0, 1, 0.5, { group: 'phys', unit: '%', mod: true });
float('phys.damp', 'Release Damp', '放鍵止音', 0, 1, 0.7, { group: 'phys', unit: '%' });
float('phys.spread', 'Width', '立體寬度', 0, 1, 0.3, { group: 'phys', unit: '%' });
int('phys.oct', 'Octave', '八度', -3, 3, 0, { group: 'phys', unit: 'oct' });
float('phys.fine', 'Fine', '微調', -100, 100, 0, { group: 'phys', unit: 'ct' });
float('phys.filt', 'To Filter', '進濾波器', 0, 1, 0, { group: 'phys', unit: '%' });
float('phys.pan', 'Pan', '聲像', -1, 1, 0, { group: 'phys', unit: 'pan', mod: true });

bool('noise.on', 'On', '噪音', false, { group: 'noise' });
float('noise.level', 'Level', '音量', 0, 1, 0.3, { group: 'noise', unit: '%', mod: true });
float('noise.color', 'Color', '音色', -1, 1, 0, { group: 'noise', unit: '%', mod: true });
float('noise.decay', 'Decay', '衰減', 0, 5, 0, { group: 'noise', unit: 's', curve: 'pow', k: 3 });
float('noise.width', 'Width', '立體寬度', 0, 1, 1, { group: 'noise', unit: '%' });
float('noise.filt', 'To Filter', '進濾波器', 0, 1, 1, { group: 'noise', unit: '%' });
float('noise.pan', 'Pan', '聲像', -1, 1, 0, { group: 'noise', unit: 'pan', mod: true });

// ───────────────────────── Filters ─────────────────────────
export const FILTER_TYPES = ['ladder24', 'ladder12', 'lp', 'bp', 'hp', 'notch', 'formant', 'comb'];
bool('filter.on', 'On', '濾波器', true, { group: 'filter' });
choice('filter.type', 'Type', '類型', FILTER_TYPES,
  ['Ladder 24', 'Ladder 12', 'SVF LP', 'SVF BP', 'SVF HP', 'SVF Notch', 'Formant', 'Comb'], 'ladder24', { group: 'filter' });
float('filter.cutoff', 'Cutoff', '截止頻率', 20, 20000, 8000, { group: 'filter', unit: 'Hz', curve: 'exp', mod: true });
float('filter.res', 'Resonance', '共振', 0, 1, 0.1, { group: 'filter', unit: '%', mod: true });
float('filter.drive', 'Drive', '推力', 0, 1, 0, { group: 'filter', unit: '%', mod: true });
float('filter.key', 'Key Track', '鍵盤追蹤', 0, 1, 0.3, { group: 'filter', unit: '%' });
float('filter.env', 'Env Amount', '包絡量', -1, 1, 0, { group: 'filter', unit: '%', mod: true });
float('filter.vel', 'Vel → Cutoff', '力度→亮度', 0, 1, 0, { group: 'filter', unit: '%' });
float('filter.vowel', 'Vowel', '母音', 0, 1, 0, { group: 'filter', unit: 'vowel', mod: true });

choice('filter2.type', 'Type', '類型', ['off', 'lp', 'hp', 'bp', 'notch'], ['Off', 'Low Pass', 'High Pass', 'Band Pass', 'Notch'], 'off', { group: 'filter2' });
float('filter2.cutoff', 'Cutoff', '截止頻率', 20, 20000, 1000, { group: 'filter2', unit: 'Hz', curve: 'exp', mod: true });
float('filter2.res', 'Resonance', '共振', 0, 1, 0.1, { group: 'filter2', unit: '%', mod: true });

// ───────────────────────── Envelopes ─────────────────────────
const ENV_DEFAULTS = {
  aenv: { a: 0.005, d: 0.3, s: 0.8, r: 0.3 },
  fenv: { a: 0.005, d: 0.4, s: 0.3, r: 0.4 },
  menv: { a: 0.01, d: 0.5, s: 0, r: 0.5 },
};
for (const e of ['aenv', 'fenv', 'menv']) {
  const d = ENV_DEFAULTS[e];
  const g = { group: e };
  float(`${e}.a`, 'Attack', '起音', 0, 10, d.a, { ...g, unit: 's', curve: 'pow', k: 3, mod: e !== 'aenv' });
  float(`${e}.d`, 'Decay', '衰減', 0.001, 10, d.d, { ...g, unit: 's', curve: 'exp', mod: e !== 'aenv' });
  float(`${e}.s`, 'Sustain', '延持', 0, 1, d.s, { ...g, unit: '%', mod: e !== 'aenv' });
  float(`${e}.r`, 'Release', '釋放', 0.001, 20, d.r, { ...g, unit: 's', curve: 'exp', mod: e !== 'aenv' });
  // 0 = convex/fast (punchy), 0.5 = natural, 1 = concave/slow (swell)
  float(`${e}.curve`, 'Curve', '曲線', 0, 1, 0.5, { ...g, unit: '%' });
}

// ───────────────────────── LFOs ─────────────────────────
export const SYNC_DIVS = ['off', '4/1', '2/1', '1/1', '1/2', '1/2T', '1/4', '1/4D', '1/4T', '1/8', '1/8D', '1/8T', '1/16', '1/16T', '1/32'];
for (const l of ['lfo1', 'lfo2']) {
  const g = { group: l };
  choice(`${l}.shape`, 'Shape', '波形', ['sine', 'tri', 'saw', 'ramp', 'square', 'sh', 'smooth'],
    ['Sine', 'Triangle', 'Saw Up', 'Saw Down', 'Square', 'Sample & Hold', 'Smooth Random'], 'sine', g);
  float(`${l}.rate`, 'Rate', '速度', 0.01, 40, l === 'lfo1' ? 2 : 0.5, { ...g, unit: 'Hz', curve: 'exp', mod: true });
  choice(`${l}.sync`, 'Sync', '節拍同步', SYNC_DIVS, SYNC_DIVS.map(s => (s === 'off' ? 'Free' : s)), 'off', g);
  float(`${l}.fade`, 'Fade In', '淡入', 0, 5, 0, { ...g, unit: 's', curve: 'pow', k: 2 });
  choice(`${l}.mode`, 'Mode', '模式', ['poly', 'mono'], ['Per Voice', 'Global'], 'poly', g);
  float(`${l}.phase`, 'Phase', '起始相位', 0, 1, 0, { ...g, unit: 'deg' });
}

// ───────────────────────── Mod matrix ─────────────────────────
export const MOD_SOURCES = ['none', 'lfo1', 'lfo2', 'menv', 'fenv', 'aenv', 'velocity', 'note', 'wheel', 'aftertouch', 'bend', 'random'];
export const MOD_SOURCE_LABELS = ['—', 'LFO 1', 'LFO 2', 'Mod Env', 'Filter Env', 'Amp Env', 'Velocity', 'Key', 'Mod Wheel', 'Aftertouch', 'Pitch Bend', 'Random'];
export const MOD_SLOTS = 8;
// MOD_DESTS is filled in after all params exist (every param with mod: true)
export const MOD_DESTS = ['none'];

// ───────────────────────── Performance ─────────────────────────
bool('arp.on', 'Arp', '琶音器', false, { group: 'arp' });
choice('arp.mode', 'Mode', '模式', ['up', 'down', 'updown', 'random', 'order', 'chord'], ['Up', 'Down', 'Up/Down', 'Random', 'As Played', 'Chord'], 'up', { group: 'arp' });
choice('arp.rate', 'Rate', '速度', ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'], null, '1/16', { group: 'arp' });
int('arp.oct', 'Octaves', '八度範圍', 1, 4, 1, { group: 'arp' });
float('arp.gate', 'Gate', '音長', 0.05, 1, 0.6, { group: 'arp', unit: '%' });
float('arp.swing', 'Swing', '搖擺', 0, 0.6, 0, { group: 'arp', unit: '%' });
bool('arp.latch', 'Latch', '保持', false, { group: 'arp' });

export const CHORDS = {
  off: [0], maj: [0, 4, 7], min: [0, 3, 7], sus2: [0, 2, 7], sus4: [0, 5, 7], '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], add9: [0, 4, 7, 14], min9: [0, 3, 7, 10, 14],
  power: [0, 7, 12], oct: [0, 12], stack4: [0, 5, 10, 15],
};
// Explicit option order: Object.keys(CHORDS) would enumerate the integer-like key '7' first and misalign the labels.
export const CHORD_IDS = ['off', 'maj', 'min', 'sus2', 'sus4', '7', 'maj7', 'min7', 'add9', 'min9', 'power', 'oct', 'stack4'];
choice('chord.type', 'Chord', '和弦', CHORD_IDS,
  ['Off', 'Major', 'Minor', 'Sus2', 'Sus4', 'Dom 7', 'Maj 7', 'Min 7', 'Add 9', 'Min 9', 'Power', 'Octave', 'Fourths'], 'off', { group: 'chord' });

export const SCALES = {
  off: null,
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10], pentMajor: [0, 2, 4, 7, 9], pentMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10], harmMinor: [0, 2, 3, 5, 7, 8, 11], inSen: [0, 1, 5, 7, 10], wholeTone: [0, 2, 4, 6, 8, 10],
};
int('scale.root', 'Key', '調性', 0, 11, 0, { group: 'scale', scope: 'global', unit: 'key' });
choice('scale.type', 'Scale', '音階鎖定', Object.keys(SCALES),
  ['Off', 'Major', 'Minor', 'Dorian', 'Mixolydian', 'Pentatonic Maj', 'Pentatonic Min', 'Blues', 'Harmonic Minor', 'In Sen', 'Whole Tone'], 'off', { group: 'scale', scope: 'global' });
float('global.bpm', 'Tempo', '速度', 40, 240, 110, { group: 'global', scope: 'global', unit: 'bpm' });
float('master.volume', 'Master', '總音量', -60, 6, -3, { group: 'global', scope: 'global', unit: 'dB' });

// ───────────────────────── Effects (global chain, patch scope) ─────────────────────────
bool('drive.on', 'Drive', '失真', false, { group: 'drive' });
choice('drive.type', 'Type', '類型', ['soft', 'tube', 'fold', 'crush'], ['Soft Clip', 'Tube', 'Wavefold', 'Bitcrush'], 'soft', { group: 'drive' });
float('drive.amount', 'Amount', '強度', 0, 1, 0.3, { group: 'drive', unit: '%' });
float('drive.tone', 'Tone', '音色', 0, 1, 0.5, { group: 'drive', unit: '%' });
float('drive.mix', 'Mix', '乾濕比', 0, 1, 1, { group: 'drive', unit: '%' });

bool('chorus.on', 'Chorus', '合唱', false, { group: 'chorus' });
choice('chorus.mode', 'Mode', '模式', ['chorus', 'ensemble', 'flanger'], ['Chorus', 'Ensemble', 'Flanger'], 'chorus', { group: 'chorus' });
float('chorus.rate', 'Rate', '速度', 0.02, 10, 0.6, { group: 'chorus', unit: 'Hz', curve: 'exp' });
float('chorus.depth', 'Depth', '深度', 0, 1, 0.5, { group: 'chorus', unit: '%' });
float('chorus.feedback', 'Feedback', '回授', 0, 0.9, 0, { group: 'chorus', unit: '%' });
float('chorus.mix', 'Mix', '乾濕比', 0, 1, 0.5, { group: 'chorus', unit: '%' });

bool('phaser.on', 'Phaser', '相位器', false, { group: 'phaser' });
float('phaser.rate', 'Rate', '速度', 0.02, 10, 0.3, { group: 'phaser', unit: 'Hz', curve: 'exp' });
float('phaser.depth', 'Depth', '深度', 0, 1, 0.7, { group: 'phaser', unit: '%' });
float('phaser.feedback', 'Feedback', '回授', 0, 0.95, 0.4, { group: 'phaser', unit: '%' });
choice('phaser.stages', 'Stages', '級數', ['4', '6', '8', '12'], null, '6', { group: 'phaser' });
float('phaser.mix', 'Mix', '乾濕比', 0, 1, 0.5, { group: 'phaser', unit: '%' });

bool('delay.on', 'Delay', '延遲', false, { group: 'delay' });
float('delay.time', 'Time', '時間', 0.01, 2, 0.375, { group: 'delay', unit: 's', curve: 'exp' });
choice('delay.sync', 'Sync', '節拍同步', ['off', '1/2', '1/4', '1/4D', '1/4T', '1/8', '1/8D', '1/8T', '1/16', '3/16'],
  ['Free', '1/2', '1/4', '1/4 D', '1/4 T', '1/8', '1/8 D', '1/8 T', '1/16', '3/16'], '1/8D', { group: 'delay' });
float('delay.feedback', 'Feedback', '回授', 0, 0.95, 0.35, { group: 'delay', unit: '%' });
float('delay.pingpong', 'Ping-Pong', '乒乓', 0, 1, 0.5, { group: 'delay', unit: '%' });
float('delay.tone', 'Tone', '音色', 0, 1, 0.5, { group: 'delay', unit: '%' });
float('delay.wobble', 'Wobble', '磁帶抖動', 0, 1, 0.1, { group: 'delay', unit: '%' });
float('delay.mix', 'Mix', '乾濕比', 0, 1, 0.25, { group: 'delay', unit: '%' });

bool('reverb.on', 'Reverb', '殘響', false, { group: 'reverb' });
float('reverb.size', 'Size', '空間大小', 0, 1, 0.6, { group: 'reverb', unit: '%' });
float('reverb.decay', 'Decay', '殘響時間', 0.2, 30, 3, { group: 'reverb', unit: 's', curve: 'exp' });
float('reverb.predelay', 'Pre-Delay', '預延遲', 0, 0.25, 0.02, { group: 'reverb', unit: 's' });
float('reverb.damp', 'Damping', '高頻衰減', 0, 1, 0.5, { group: 'reverb', unit: '%' });
float('reverb.mod', 'Modulation', '調變', 0, 1, 0.3, { group: 'reverb', unit: '%' });
float('reverb.width', 'Width', '立體寬度', 0, 1, 1, { group: 'reverb', unit: '%' });
float('reverb.shimmer', 'Shimmer', '微光', 0, 1, 0, { group: 'reverb', unit: '%' });
float('reverb.mix', 'Mix', '乾濕比', 0, 1, 0.3, { group: 'reverb', unit: '%' });

float('eq.low', 'Low', '低頻', -12, 12, 0, { group: 'eq', unit: 'dB' });
float('eq.mid', 'Mid', '中頻', -12, 12, 0, { group: 'eq', unit: 'dB' });
float('eq.midfreq', 'Mid Freq', '中頻頻點', 200, 8000, 1000, { group: 'eq', unit: 'Hz', curve: 'exp' });
float('eq.high', 'High', '高頻', -12, 12, 0, { group: 'eq', unit: 'dB' });
float('comp.amount', 'Glue', '壓縮黏合', 0, 1, 0, { group: 'eq', unit: '%' });

// ───────────────────────── Macros ─────────────────────────
for (let i = 1; i <= 4; i++) float(`macro${i}`, `Macro ${i}`, `巨集 ${i}`, 0, 1, 0, { group: 'macro', unit: '%' });

// Mod matrix slots (declared last so MOD_DESTS can list every modulatable param)
for (const p of P) if (p.mod) MOD_DESTS.push(p.id);
for (let i = 1; i <= MOD_SLOTS; i++) {
  const g = { group: 'mod' };
  choice(`mod${i}.src`, `Src ${i}`, `來源 ${i}`, MOD_SOURCES, MOD_SOURCE_LABELS, 'none', g);
  choice(`mod${i}.dst`, `Dst ${i}`, `目標 ${i}`, MOD_DESTS, null, 'none', g);
  float(`mod${i}.amt`, `Amt ${i}`, `量 ${i}`, -1, 1, 0, { ...g, unit: '%' });
}

// ───────────────────────── Index + helpers ─────────────────────────
export const PARAMS = P;
export const PARAM_COUNT = P.length;
export const PARAM_BY_ID = Object.create(null);
P.forEach((p, i) => { p.index = i; PARAM_BY_ID[p.id] = p; });

/** Index of a param in the DSP value array. Throws on unknown id (catches typos early). */
export function idx(id) {
  const p = PARAM_BY_ID[id];
  if (!p) throw new Error(`Unknown param: ${id}`);
  return p.index;
}

export const DEFAULTS = Object.freeze(Object.fromEntries(P.map(p => [p.id, p.def])));

function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

/** Native (preset/UI) value → normalised 0..1. Enums accept id string or index; bools accept boolean or number. */
export function toNorm(p, v) {
  if (typeof p === 'string') p = PARAM_BY_ID[p];
  if (p.type === 'enum') {
    const i = typeof v === 'number' ? v : p.options.indexOf(v);
    return p.options.length > 1 ? clamp01(i / (p.options.length - 1)) : 0;
  }
  if (p.type === 'bool') return v ? 1 : 0;
  const { min, max } = p;
  if (p.curve === 'exp') return clamp01(Math.log(v / min) / Math.log(max / min));
  if (p.curve === 'pow') return clamp01(Math.pow(Math.max(0, (v - min) / (max - min)), 1 / (p.k || 3)));
  return clamp01((v - min) / (max - min));
}

/** Normalised 0..1 → native value (enum → option id string, bool → boolean, int → rounded). */
export function fromNorm(p, n) {
  if (typeof p === 'string') p = PARAM_BY_ID[p];
  n = clamp01(n);
  if (p.type === 'enum') return p.options[Math.round(n * (p.options.length - 1))];
  if (p.type === 'bool') return n >= 0.5;
  const { min, max } = p;
  let v;
  if (p.curve === 'exp') v = min * Math.pow(max / min, n);
  else if (p.curve === 'pow') v = min + (max - min) * Math.pow(n, p.k || 3);
  else v = min + (max - min) * n;
  return p.type === 'int' ? Math.round(v) : v;
}

/** Same as fromNorm but returns the DSP numeric encoding (enum index, bool 0/1). */
export function fromNormNumeric(p, n) {
  if (typeof p === 'string') p = PARAM_BY_ID[p];
  if (p.type === 'enum') return Math.round(clamp01(n) * (p.options.length - 1));
  if (p.type === 'bool') return n >= 0.5 ? 1 : 0;
  return fromNorm(p, n);
}

const BOOL_TRUE = new Set(['true', 'on', 'yes']);
/**
 * Native preset/UI value → DSP numeric encoding. Always returns a valid value (never throws, never NaN); the
 * coercions agree with the UI's sanitizeValue (src/ui/app/store.js), bools also accept 'on'/'yes':
 *   enum:  finite number = option index (rounded, clamped to the options) · string = option id · else default
 *          (so phaser.stages 8 is index 8 → clamped, '8' is the id '8')
 *   bool:  boolean · number ≥ 0.5 · 'true'/'on'/'yes' or a numeric string ≥ 0.5 ('false', '0', 'off', '' → 0)
 *   float/int: number or numeric string, clamped to min..max (int rounded) · else default
 */
export function toNumeric(p, v) {
  if (typeof p === 'string') p = PARAM_BY_ID[p];
  if (p.type === 'enum') {
    const n = p.options.length;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return p.options.indexOf(p.def);
      const i = Math.round(v);
      return i < 0 ? 0 : i > n - 1 ? n - 1 : i;
    }
    const i = v == null ? -1 : p.options.indexOf(typeof v === 'string' ? v : String(v));
    return i < 0 ? p.options.indexOf(p.def) : i;
  }
  if (p.type === 'bool') {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v >= 0.5 ? 1 : 0; // (NaN → 0)
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      return BOOL_TRUE.has(s) || (s !== '' && Number(s) >= 0.5) ? 1 : 0;
    }
    return 0; // null / undefined / objects (as sanitizeValue)
  }
  let x = v;
  if (typeof x === 'string' && x.trim() !== '') x = Number(x);
  if (typeof x !== 'number' || !Number.isFinite(x)) return p.def;
  return Math.min(p.max, Math.max(p.min, p.type === 'int' ? Math.round(x) : x));
}

/** DSP numeric encoding → native preset/UI value. */
export function fromNumeric(p, x) {
  if (typeof p === 'string') p = PARAM_BY_ID[p];
  if (p.type === 'enum') return p.options[Math.max(0, Math.min(p.options.length - 1, Math.round(x)))];
  if (p.type === 'bool') return x >= 0.5;
  return x;
}

/** Full native values object: defaults overlaid with a patch's params. Unknown ids are dropped. */
export function resolveParams(params = {}) {
  const out = { ...DEFAULTS };
  for (const k in params) if (k in PARAM_BY_ID) out[k] = params[k];
  return out;
}

/** Float64Array of DSP numeric values (index-aligned with PARAMS) from a native values object. */
export function toValueArray(values) {
  const a = new Float64Array(PARAM_COUNT);
  for (let i = 0; i < PARAM_COUNT; i++) {
    const p = P[i];
    a[i] = toNumeric(p, values[p.id] !== undefined ? values[p.id] : p.def);
  }
  return a;
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export function noteName(n) { return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); }

/** Human-readable value, e.g. "1.20 kHz", "350 ms", "-3.0 dB", "+7 st", "42%". */
export function formatValue(p, v) {
  if (typeof p === 'string') p = PARAM_BY_ID[p];
  if (p.type === 'enum') {
    const i = typeof v === 'number' ? Math.round(v) : p.options.indexOf(v);
    return p.labels[i] ?? String(v);
  }
  if (p.type === 'bool') return v ? 'On' : 'Off';
  const sign = x => (x > 0 ? '+' : '');
  switch (p.unit) {
    case 'Hz': return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : v >= 100 ? `${Math.round(v)} Hz` : `${v.toFixed(v >= 10 ? 1 : 2)} Hz`;
    case 's': return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(v >= 10 ? 1 : 2)} s`;
    case 'dB': return `${sign(v)}${v.toFixed(1)} dB`;
    case 'ct': return `${sign(v)}${Math.round(v)} ct`;
    case 'st': return p.type === 'int' ? `${sign(v)}${v} st` : `${sign(v)}${v.toFixed(2)} st`;
    case 'oct': return `${sign(v)}${v} oct`;
    case '%': return p.min < 0 ? `${sign(v)}${Math.round(v * 100)}%` : `${Math.round(v * 100)}%`;
    case 'pan': return Math.abs(v) < 0.005 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`;
    case 'ratio': return `×${v.toFixed(v < 1 ? 3 : 2)}`;
    case 'bpm': return `${Math.round(v)} BPM`;
    case 'deg': return `${Math.round(v * 360)}°`;
    case 'key': return NOTE_NAMES[v] ?? String(v);
    case 'vowel': return ['A', 'E', 'I', 'O', 'U'][Math.min(4, Math.round(v * 4))];
    default: return p.type === 'int' ? String(v) : v.toFixed(2);
  }
}

/** Groups in display order, with labels for the UI. */
export const GROUPS = {
  osc1: { label: 'Osc 1', zh: '振盪器 1' }, osc2: { label: 'Osc 2', zh: '振盪器 2' },
  fm: { label: 'FM', zh: 'FM 合成' }, phys: { label: 'Physical', zh: '物理模型' }, noise: { label: 'Noise', zh: '噪音' },
  filter: { label: 'Filter', zh: '濾波器' }, filter2: { label: 'Filter 2', zh: '濾波器 2' },
  aenv: { label: 'Amp Env', zh: '音量包絡' }, fenv: { label: 'Filter Env', zh: '濾波包絡' }, menv: { label: 'Mod Env', zh: '調變包絡' },
  lfo1: { label: 'LFO 1', zh: 'LFO 1' }, lfo2: { label: 'LFO 2', zh: 'LFO 2' }, mod: { label: 'Mod Matrix', zh: '調變矩陣' },
  voice: { label: 'Voice', zh: '發聲' }, vibrato: { label: 'Vibrato', zh: '顫音' }, amp: { label: 'Amp', zh: '音量' },
  arp: { label: 'Arpeggiator', zh: '琶音器' }, chord: { label: 'Chord', zh: '和弦' }, scale: { label: 'Scale', zh: '音階' },
  drive: { label: 'Drive', zh: '失真' }, chorus: { label: 'Chorus', zh: '合唱' }, phaser: { label: 'Phaser', zh: '相位器' },
  delay: { label: 'Delay', zh: '延遲' }, reverb: { label: 'Reverb', zh: '殘響' }, eq: { label: 'EQ / Glue', zh: '等化/壓縮' },
  macro: { label: 'Macros', zh: '巨集' }, global: { label: 'Global', zh: '全域' },
};
for (let i = 1; i <= 4; i++) GROUPS[`fm.op${i}`] = { label: `Op ${i}`, zh: `運算子 ${i}` };

/** Tempo-synced division → length in beats (quarter notes). 'off' → 0. */
export function divToBeats(div) {
  if (!div || div === 'off') return 0;
  const m = /^(\d+)\/(\d+)([DT]?)$/.exec(div);
  if (!m) return 0;
  let beats = (4 * Number(m[1])) / Number(m[2]);
  if (m[3] === 'D') beats *= 1.5;
  if (m[3] === 'T') beats *= 2 / 3;
  return beats;
}
