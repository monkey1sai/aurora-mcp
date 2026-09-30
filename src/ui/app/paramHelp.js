// One-line explanations of synth jargon (zh + English), shown as the tooltip of an editor control and read by
// screen readers as its description. Keyed by param id; `*` stands for any source/effect prefix.

import { getLang } from './i18n.js';

/** id (or '*.suffix' for every group) → [zh, en] */
const HELP = {
  '*.pw': ['脈衝寬度：改變方波的胖瘦，越窄聲音越尖細、越像鼻音', 'Pulse width: how wide the square wave is — narrower sounds thinner and nasal'],
  '*.sync': ['硬同步：讓振盪器不斷被重新起振，產生尖銳、會「嘶吼」的泛音', 'Hard sync: restarts the oscillator again and again for biting, tearing overtones'],
  '*.unison': ['齊奏數：同時疊幾個略有不同的聲部，數量越多越厚', 'Unison voices: stacked copies of the oscillator — more voices, thicker sound'],
  'osc1.detune': ['失諧：把齊奏聲部的音高錯開，產生合唱般的晃動與厚度', 'Detune: spreads the unison voices in pitch for a lush, chorus-like shimmer'],
  'osc2.detune': ['失諧：把齊奏聲部的音高錯開，產生合唱般的晃動與厚度', 'Detune: spreads the unison voices in pitch for a lush, chorus-like shimmer'],
  'osc1.spread': ['立體寬度：把齊奏聲部分散到左右聲道', 'Stereo spread: pans the unison voices across left and right'],
  'osc2.spread': ['立體寬度：把齊奏聲部分散到左右聲道', 'Stereo spread: pans the unison voices across left and right'],
  '*.blend': ['中心/兩側：中間主聲部與兩側失諧聲部的音量比例', 'Center / sides: level of the centre voice against the detuned side voices'],
  '*.drift': ['類比漂移：模擬老式類比合成器微微飄移的音高，讓聲音更溫暖、有生命', 'Analog drift: slow random pitch wander like a vintage synth — warmer, more alive'],
  '*.filt': ['進濾波器：這個聲源送進濾波器的比例（其餘直接輸出）', 'To filter: how much of this source goes through the filter (the rest bypasses it)'],
  '*.phase': ['相位：每個音從波形的哪裡開始；固定相位讓起音更整齊', 'Phase: where each note starts in the waveform — fixed phase gives tighter attacks'],
  'osc1.table': ['波表：一組會隨「波形」旋鈕漸變的波形', 'Wavetable: a set of waveforms the Shape knob morphs through'],
  'osc2.table': ['波表：一組會隨「波形」旋鈕漸變的波形', 'Wavetable: a set of waveforms the Shape knob morphs through'],
  'fm.algo': ['演算法：四個運算子之間誰調變誰的接法', 'Algorithm: how the four operators modulate each other'],
  'fm.feedback': ['回授：運算子調變自己，越多越粗糙、越像噪音', 'Feedback: an operator modulating itself — more is grittier, toward noise'],
  '*.ratio': ['頻率比：運算子相對於音高的倍數；整數比聽起來和諧，非整數像鐘聲', 'Ratio: operator frequency as a multiple of the note — whole numbers sound harmonic, others bell-like'],
  '*.kscale': ['鍵盤縮放：越往高音，這個運算子越小聲', 'Key scaling: this operator gets quieter higher up the keyboard'],
  'phys.hardness': ['硬度：激發物（槌、撥片、弓）的軟硬，越硬越亮', 'Hardness: how hard the mallet / pick / bow is — harder is brighter'],
  'phys.position': ['激發位置：敲或撥在琴弦（或板）的哪個位置，會改變音色', 'Position: where the string or bar is struck — changes the tone colour'],
  'phys.inharm': ['材質/非諧：泛音偏離整數倍的程度，越高越像金屬或鐘', 'Inharmonicity: overtones drifting from whole multiples — higher sounds metallic'],
  'phys.body': ['共鳴箱：加上樂器箱體的共鳴', 'Body: adds the resonance of an instrument body'],
  'phys.pressure': ['持續激發：像拉弓或吹氣一樣持續供給能量，讓聲音延續', 'Pressure: keeps feeding energy like a bow or breath so the note sustains'],
  'phys.damp': ['放鍵止音：放開琴鍵後聲音停得多快', 'Damping: how quickly the note stops after you let go'],
  'filter.cutoff': ['截止頻率：濾波器從哪裡開始削掉聲音；調低變悶、調高變亮', 'Cutoff: where the filter starts removing sound — lower is darker, higher brighter'],
  'filter2.cutoff': ['截止頻率：濾波器從哪裡開始削掉聲音；調低變悶、調高變亮', 'Cutoff: where the filter starts removing sound — lower is darker, higher brighter'],
  'filter.res': ['共振：強調截止頻率附近的聲音，高了會「嗚哇」、甚至自己鳴叫', 'Resonance: boosts sound around the cutoff — high values whistle and squelch'],
  'filter2.res': ['共振：強調截止頻率附近的聲音，高了會「嗚哇」、甚至自己鳴叫', 'Resonance: boosts sound around the cutoff — high values whistle and squelch'],
  'filter.drive': ['推力：把聲音推進濾波器讓它飽和，變得更粗、更溫暖', 'Drive: pushes the signal into the filter for thicker, warmer saturation'],
  'filter.key': ['鍵盤追蹤：彈越高的音，濾波器開得越大，讓高低音亮度一致', 'Key tracking: higher notes open the filter more so brightness stays even'],
  'filter.env': ['包絡量：濾波包絡對截止頻率的影響，造成「哇」的一下', 'Envelope amount: how far the filter envelope sweeps the cutoff — the “wow”'],
  'filter.vowel': ['母音：Formant 濾波器模仿的人聲母音', 'Vowel: which vowel the formant filter imitates'],
  '*.curve': ['曲線：包絡各段是直線還是彎曲（更自然的起落）', 'Curve: straight or curved envelope segments (curved feels more natural)'],
  'lfo1.fade': ['淡入：按下琴鍵後 LFO 慢慢出現', 'Fade in: the LFO eases in after each key press'],
  'lfo2.fade': ['淡入：按下琴鍵後 LFO 慢慢出現', 'Fade in: the LFO eases in after each key press'],
  'voice.glide': ['滑音：音與音之間滑過去的時間', 'Glide: time to slide in pitch from one note to the next'],
  'voice.spread': ['聲部展開：每個複音聲部放在不同的左右位置', 'Voice spread: places each voice at a different stereo position'],
  'arp.gate': ['音長：每個琶音音符響多久（相對於步長）', 'Gate: how long each arpeggio note sounds, relative to the step'],
  'arp.swing': ['搖擺：讓反拍晚一點，產生律動感', 'Swing: delays every other step for a groovier feel'],
  'arp.latch': ['保持：放開琴鍵後琶音繼續', 'Latch: the arpeggio keeps going after you let go'],
  'chorus.depth': ['深度：合唱晃動的幅度', 'Depth: how far the chorus wobbles'],
  '*.feedback': ['回授：輸出再送回輸入，重複或共鳴更強', 'Feedback: output fed back into the input for more repeats or resonance'],
  'phaser.stages': ['級數：相位器的階數，越多「刷刷」聲越明顯', 'Stages: more stages make the phaser sweep deeper'],
  'delay.pingpong': ['乒乓：回音在左右聲道之間來回彈跳', 'Ping-pong: echoes bounce between left and right'],
  'delay.wobble': ['磁帶抖動：模仿老式磁帶延遲的音高搖晃', 'Wobble: tape-style pitch wow and flutter on the echoes'],
  'reverb.predelay': ['預延遲：原聲與殘響之間的間隔，讓聲音不被糊掉', 'Pre-delay: a gap before the reverb starts, keeping the dry sound clear'],
  'reverb.damp': ['高頻衰減：殘響中的高音消失得多快，越高越溫暖', 'Damping: how fast highs fade in the tail — more is warmer'],
  'reverb.shimmer': ['微光：在殘響裡加入高八度的光暈', 'Shimmer: adds an octave-up halo to the reverb tail'],
  '*.mix': ['乾濕比：原聲與效果聲的比例', 'Mix: balance of the dry sound and the effect'],
  'comp.amount': ['壓縮黏合：讓整體音量更緊密、更一致', 'Glue: gentle compression that holds the mix together'],
  'amp.vel': ['力度感應：彈得越用力越大聲的程度', 'Velocity: how much harder playing gets louder'],
};

/** [zh, en] explanation for a param id, or null. */
export function paramHelp(id) {
  if (!id) return null;
  if (HELP[id]) return HELP[id];
  const d = id.lastIndexOf('.');
  return d > 0 ? HELP[`*${id.slice(d)}`] || null : null;
}

/** Text in the current language first, the other one after it. */
export function paramHelpText(id) {
  const e = paramHelp(id);
  if (!e) return '';
  return getLang() === 'en' ? `${e[1]}\n${e[0]}` : `${e[0]}\n${e[1]}`;
}

/** Give every `[data-param]` control under root its explanation (tooltip + screen-reader description). */
export function applyParamHelp(root) {
  if (!root || !root.querySelectorAll) return;
  for (const el of root.querySelectorAll('[data-param]')) {
    const txt = paramHelpText(el.dataset.param);
    if (!txt) continue;
    if (el.dataset.help === txt) continue;
    el.dataset.help = txt;
    el.title = txt;
    const focusable = el.matches('[role="slider"], [role="switch"], button') ? el : el.querySelector('[role="slider"], [role="switch"], [role="radiogroup"], button');
    if (focusable) focusable.setAttribute('aria-description', txt.split('\n')[0]);
  }
}
