// Language support: Traditional Chinese first (zh-TW) with English sub-labels; toggle 中 / EN.
// Elements opt in with data-i18n="key" (text), data-i18n-title, data-i18n-placeholder, data-i18n-aria,
// or the bilingual pair produced by bi(key) (primary in the current language, secondary in the other).

import { GROUPS } from '../../dsp/params.js';

const KEY = 'aurora.lang';

/** key → [zh, en] */
const DICT = {
  // app / splash
  appSubtitle: ['混合式合成器', 'Hybrid Synthesizer'],
  tapToStart: ['點一下開始', 'Tap to start'],
  startHint: ['電腦鍵盤 A–K 彈奏 · Z / X 切換八度 · 支援 MIDI', 'Play with A–K · Z / X octave · MIDI ready'],
  loadingEngine: ['正在啟動音訊引擎…', 'Starting audio engine…'],
  audioFailed: ['音訊引擎載入失敗，目前為無聲模式', 'Audio engine failed to load — running silent'],
  audioError: ['音訊引擎錯誤', 'Audio engine error'],
  audioUnsupported: ['此瀏覽器不支援 AudioWorklet', 'AudioWorklet is not supported in this browser'],
  visualsFailed: ['視覺化模組載入失敗', 'Visualizer failed to load'],
  // tabs
  tabSources: ['聲源', 'Sources'],
  tabFilter: ['濾波', 'Filter'],
  tabMod: ['調變', 'Mod'],
  tabFx: ['效果', 'FX'],
  tabPerform: ['演奏', 'Perform'],
  // top bar
  presets: ['音色庫', 'Presets'],
  save: ['儲存', 'Save'],
  undo: ['復原', 'Undo'],
  redo: ['重做', 'Redo'],
  mutate: ['突變', 'Mutate'],
  random: ['隨機', 'Random'],
  demo: ['示範', 'Demo'],
  stop: ['停止', 'Stop'],
  tempo: ['速度', 'Tempo'],
  tap: ['點擊', 'Tap'],
  master: ['總音量', 'Master'],
  more: ['更多', 'More'],
  exportJson: ['匯出音色 JSON', 'Export preset JSON'],
  importJson: ['匯入音色 JSON', 'Import preset JSON'],
  panic: ['全部靜音', 'Panic (all notes off)'],
  help: ['操作說明', 'Help & shortcuts'],
  language: ['English', '中文'],
  modified: ['已修改', 'Modified'],
  prevPreset: ['上一個音色', 'Previous preset'],
  nextPreset: ['下一個音色', 'Next preset'],
  favourite: ['加入最愛', 'Favourite'],
  midiNone: ['無 MIDI 裝置', 'No MIDI device'],
  midiUnsupported: ['MIDI 無法使用', 'MIDI unavailable'],
  midiDevices: ['個 MIDI 裝置', 'MIDI device(s)'],
  midiConnect: ['連接 MIDI 裝置', 'Connect MIDI device'],
  midiNoBrowser: ['此瀏覽器沒有 Web MIDI（Safari／iOS 不支援），請改用 Chrome、Edge 或 Firefox', 'This browser has no Web MIDI (Safari / iOS) — use Chrome, Edge or Firefox'],
  midiNeedsHttps: ['MIDI 需要 https 或 localhost 連線', 'MIDI needs https or localhost'],
  cpu: ['CPU', 'CPU'],
  voices: ['聲部', 'Voices'],
  editView: ['編輯', 'Edit'],
  collapse: ['收合視覺區', 'Collapse play view'],
  expand: ['展開視覺區', 'Expand play view'],
  // browser
  search: ['搜尋音色、標籤…', 'Search presets, tags…'],
  all: ['全部', 'All'],
  favourites: ['我的最愛', 'Favourites'],
  user: ['我的音色', 'My presets'],
  noResults: ['沒有符合的音色', 'No matching presets'],
  deletePreset: ['刪除此音色', 'Delete preset'],
  deleteConfirm: ['確定要刪除這個使用者音色嗎？', 'Delete this user preset?'],
  clearFilter: ['清除篩選', 'Clear filter'],
  factory: ['原廠', 'Factory'],
  presetCount: ['個音色', 'presets'],
  // play view
  macros: ['巨集', 'Macros'],
  xyPad: ['XY 控制板', 'XY Pad'],
  scope: ['示波器', 'Scope'],
  spectrum: ['頻譜', 'Spectrum'],
  // keyboard dock
  octave: ['八度', 'Octave'],
  bend: ['彎音', 'Bend'],
  modWheel: ['調變輪', 'Mod'],
  hold: ['延音', 'Hold'],
  velocity: ['力度', 'Velocity'],
  // editor
  sourceMix: ['聲源混音', 'Source mix'],
  waveform: ['波形', 'Waveform'],
  unison: ['齊奏', 'Unison'],
  pitch: ['音高', 'Pitch'],
  output: ['輸出', 'Output'],
  tone: ['音色', 'Tone'],
  algorithm: ['演算法', 'Algorithm'],
  operators: ['運算子', 'Operators'],
  carrier: ['載波', 'Carrier'],
  modulator: ['調變', 'Mod'],
  model: ['模型', 'Model'],
  exciter: ['激發方式', 'Exciter'],
  resonator: ['共鳴體', 'Resonator'],
  envelopes: ['包絡', 'Envelopes'],
  matrix: ['調變矩陣', 'Mod Matrix'],
  source: ['來源', 'Source'],
  destination: ['目標', 'Destination'],
  amount: ['量', 'Amount'],
  clear: ['清除', 'Clear'],
  signalFlow: ['訊號流', 'Signal flow'],
  sourceOff: ['此聲源已關閉 — 打開開關即可使用', 'This source is off — switch it on to use it'],
  lfoSynced: ['節拍同步', 'Tempo-synced'],
  vowelHint: ['母音 (Formant 專用)', 'Vowel (formant only)'],
  macroHint: ['巨集控制', 'Macro'],
  macroTargets: ['控制目標', 'Targets'],
  modArcHint: ['外圈亮弧 = 調變範圍', 'Outer arc = modulation range'],
  arpStep: ['琶音步進', 'Arp step'],
  globalHint: ['全域設定（不隨音色改變）', 'Global (kept across presets)'],
  // modals
  savePreset: ['儲存音色', 'Save preset'],
  name: ['名稱', 'Name'],
  category: ['分類', 'Category'],
  tags: ['標籤（以逗號分隔）', 'Tags (comma separated)'],
  description: ['描述', 'Description'],
  cancel: ['取消', 'Cancel'],
  ok: ['確定', 'OK'],
  overwrite: ['已有同名的使用者音色，要覆蓋嗎？', 'A user preset with this name exists. Overwrite?'],
  saved: ['已儲存到「我的音色」', 'Saved to My presets'],
  imported: ['已匯入音色', 'Imported preset(s)'],
  importFailed: ['匯入失敗：不是有效的音色檔', 'Import failed: not a valid preset file'],
  exported: ['已匯出 JSON', 'Exported JSON'],
  mutated: ['已突變：微調了參數', 'Mutated: small variations applied'],
  randomized: ['已隨機生成新音色', 'Generated a random patch'],
  undone: ['已復原', 'Undone'],
  redone: ['已重做', 'Redone'],
  demoPlaying: ['示範樂句播放中', 'Demo phrase playing'],
  demoUnavailable: ['找不到示範樂句', 'Demo phrases unavailable'],
  storageFull: ['無法寫入瀏覽器儲存空間', 'Browser storage unavailable'],
  panicDone: ['已全部靜音', 'All notes off'],
  // help
  helpTitle: ['操作說明', 'Help & shortcuts'],
  // Demo Center 示範中心
  dcOpen: ['示範中心', 'Demo Center'],
  dcTitle: ['示範中心', 'Demo Center'],
  dcTagline: ['聽、看、學 —— 讓 AURORA 自己演奏、自己調音色', 'Listen, watch, learn — AURORA plays and designs sounds by itself'],
  dcClose: ['關閉示範中心', 'Close Demo Center'],
  dcSongs: ['示範曲', 'Songs'],
  dcTours: ['音色導覽', 'Sound Tours'],
  dcJam: ['自動演奏', 'Jam'],
  dcMagic: ['魔法調音', 'Magic'],
  dcTheater: ['劇院模式', 'Theater'],
  dcSongsDesc: ['多聲部示範曲：每個聲部都是一個出廠音色，看音符在琴卷上流動，隨時換成你的音色來彈', 'Multi-part songs built from factory presets — watch the notes flow and grab any part’s sound'],
  dcToursDesc: ['自動調整音色：跟著導覽，看旋鈕自己轉動，一步步做出經典聲音', 'Auto sound design: watch the knobs turn by themselves as classic sounds are built step by step'],
  dcJamDesc: ['讓 AURORA 即興：自動生成旋律、和弦與律動', 'Let AURORA improvise melodies, chords and grooves'],
  dcMagicDesc: ['智慧調音、音色演化與變形：讓聲音自己長出新的樣子', 'Smart tweaks, evolving and morphing: let the sound grow into something new'],
  dcTheaterDesc: ['放鬆欣賞：全螢幕極光視覺，自動輪播音色或示範曲', 'Lean back: full-screen aurora visuals cycling through presets or songs'],
  dcSoon: ['此功能即將推出', 'Coming soon'],
  dcPanelFailed: ['面板載入失敗', 'Panel failed to load'],
  magicSmart: ['智慧調音', 'Smart Tweaks'],
  magicEvolve: ['音色演化', 'Evolve'],
  magicMorph: ['音色變形', 'Morph'],
  npJam: ['自動演奏中', 'Jam is playing'],
  npMagic: ['魔法調音進行中', 'Magic is running'],
  // songs
  songPlay: ['播放', 'Play'],
  songStop: ['停止', 'Stop'],
  songLoop: ['循環播放', 'Loop'],
  songPartsN: ['個聲部', 'parts'],
  songSections: ['段落', 'Sections'],
  songPlayAlong: ['一起彈', 'Play along'],
  songPlayAlongOn: ['已鎖定音階', 'Scale locked:'],
  songPlayAlongOff: ['已解除音階鎖定', 'Scale lock released'],
  songPlayAlongTip: ['把鍵盤鎖定在這首歌的調性，隨便彈都和諧', 'Lock the keyboard to the song’s key so anything you play fits'],
  songPlayAlongHint: ['用電腦鍵盤 A–K 或下方琴鍵，隨便彈都好聽', 'Play along on A–K or the keys below — every note fits'],
  songUseSound: ['用這個音色彈', 'Play this sound'],
  songUsing: ['已載入音色', 'Loaded sound'],
  songMute: ['靜音', 'Mute'],
  songSolo: ['獨奏', 'Solo'],
  songsEmpty: ['還沒有示範曲', 'No demo songs yet'],
  songsLoading: ['正在載入示範曲…', 'Loading songs…'],
  songUnavailable: ['合奏引擎尚未就緒，暫時無法播放示範曲', 'The ensemble engine is not available yet'],
  songNeedsAudio: ['請先點一下畫面啟動音訊', 'Tap the page to start audio first'],
  songError: ['示範曲載入失敗', 'Song failed to load'],
  // tours
  tourBadge: ['音色導覽', 'Sound Tour'],
  tourStart: ['開始導覽', 'Start tour'],
  tourSteps: ['個步驟', 'steps'],
  tourLive: ['導覽中', 'Playing'],
  tourPause: ['暫停', 'Pause'],
  tourResume: ['繼續', 'Resume'],
  tourNext: ['下一步', 'Next step'],
  tourRestart: ['從頭開始', 'Restart'],
  tourExit: ['結束導覽', 'End tour'],
  tourKeep: ['保留這個音色', 'Keep this sound'],
  tourRevert: ['還原', 'Revert'],
  tourReplay: ['再聽一次', 'Replay'],
  tourKept: ['已保留音色（⌘/Ctrl Z 可復原）', 'Sound kept (⌘/Ctrl Z to undo)'],
  tourReverted: ['已還原原本的音色', 'Your original sound is back'],
  tourHintMain: ['看旋鈕自己轉動', 'Watch the knobs move'],
  tourHint: ['導覽開始後示範中心會收起：字幕出現在視覺區，正在調整的旋鈕會發光。空白鍵暫停。', 'The center closes during a tour: captions appear over the visualizer and the knob being changed glows. Space pauses.'],
  toursEmpty: ['還沒有音色導覽', 'No tours yet'],
  toursLoading: ['正在載入音色導覽…', 'Loading tours…'],
  // theater
  thTitle: ['劇院模式', 'Theater mode'],
  thDesc: ['把燈關暗，讓 AURORA 帶你逛一圈：巨大的極光視覺、優雅的字幕，每個音色都會自己演奏並轉動巨集旋鈕。', 'Dim the lights and let AURORA give you a tour: huge aurora visuals, elegant captions, and every preset playing itself while its macros move.'],
  thSource: ['播放內容', 'Play'],
  thSeconds: ['每個音色約', 'About per preset'],
  thShuffle: ['隨機順序', 'Shuffle'],
  thEnter: ['進入劇院', 'Enter theater'],
  thExit: ['離開劇院', 'Exit theater'],
  thKeys: ['← → 切換 · 空白鍵 暫停 · F 全螢幕 · Esc 離開', '← → switch · Space pause · F full screen · Esc exit'],
  thUpNext: ['下一個', 'Up next'],
  thSection: ['段落', 'Section'],
  thChanging: ['正在調整', 'Now changing'],
  thFullscreen: ['全螢幕', 'Full screen'],
  thPrev: ['上一個', 'Previous'],
  thNext: ['下一個', 'Next'],
  thUseSound: ['使用這個音色', 'Use this sound'],
  thEmpty: ['這個分類沒有音色', 'No presets in this category'],
  thQueue: ['播放清單', 'Playlist'],
  thQueueShuffled: ['隨機順序播放，點一個從它開始', 'Plays shuffled — click one to start there'],
  thQueueHint: ['點一個從它開始', 'Click one to start there'],
  thStartHere: ['從這裡開始', 'Start here'],
  thMore: ['還有', 'more'],
  // app shell: recoverable edits, storage, audio failure, a11y names
  importStorageFull: ['瀏覽器儲存空間已滿（或被封鎖），音色沒有匯入', 'Browser storage is full (or blocked) — nothing was imported'],
  thSecondsAria: ['每個音色播放的秒數', 'Seconds per preset'],
  audioFailedLong: ['音訊引擎無法啟動，目前為無聲模式（瀏覽器可能不支援 AudioWorklet，或需要 https 連線）— 可按右上角「無聲 · 重試」再試一次', 'The audio engine could not start, so AURORA is silent (the browser may lack AudioWorklet, or the page needs https) — press “Silent · Retry” at the top right'],
  audioFailedDemo: ['音訊引擎無法啟動，示範不會有聲音（瀏覽器可能不支援 AudioWorklet，或需要 https 連線）', 'The audio engine is not running, so demos are silent (the browser may lack AudioWorklet, or the page needs https)'],
  audioRetry: ['重試', 'Retry'],
  audioDetails: ['詳細資訊', 'Details'],
  audioBadge: ['無聲 · 重試', 'Silent · Retry'],
  audioBadgeOff: ['啟動音訊', 'Start audio'],
  editOpen: ['編輯音色', 'Edit the sound'],
  editDone: ['完成', 'Done'],
  octDown: ['降八度 (Z)', 'Octave down (Z)'],
  octUp: ['升八度 (X)', 'Octave up (X)'],
  sustainPedal: ['延音踏板', 'Sustain pedal'],
  close: ['關閉', 'Close'],
  regionPlay: ['演奏區', 'Play'],
  regionEditor: ['音色編輯器', 'Sound editor'],
  regionKeyboard: ['琴鍵', 'Keyboard'],
  coachTitle: ['新手提示', 'Quick start'],
  coachPlay: ['彈琴：用電腦鍵盤 A–K（Z / X 換八度），或點下方琴鍵', 'Play: computer keys A–K (Z / X change octave) or click the keys below'],
  coachPlayTouch: ['彈琴：點下方琴鍵，‹ › 換八度，「延音」讓音持續', 'Play: tap the keys below — ‹ › change octave, Hold sustains'],
  coachMacros: ['轉 M1–M4 巨集旋鈕：一個動作就改變整個音色（點 M1… 看它控制什麼）', 'Turn the M1–M4 macros: one move reshapes the whole sound (tap M1… to see what it drives)'],
  coachCenter: ['打開「示範中心」：示範曲、音色導覽、自動演奏與劇院模式', 'Open the Demo Center: songs, sound tours, auto-jam and theater mode'],
  coachTry: ['打開', 'Open'],
  coachOk: ['知道了', 'Got it'],
  coachShow: ['顯示新手提示', 'Show quick start'],
  editsUndoable: ['已切換音色 — 剛才未儲存的修改可用「復原」找回（⌘/Ctrl Z）', 'Preset switched — Undo (⌘/Ctrl Z) brings your unsaved edits back'],
};

let lang = 'zh';
try {
  const saved = globalThis.localStorage?.getItem(KEY);
  if (saved === 'en' || saved === 'zh') lang = saved;
} catch { /* ignore */ }

const listeners = new Set();

export const getLang = () => lang;
export const other = () => (lang === 'zh' ? 'en' : 'zh');

/** Translate a key (falls back to the key itself). */
export function t(key, l = lang) {
  const e = DICT[key];
  if (!e) return key;
  return l === 'en' ? e[1] : e[0];
}

export function setLang(l) {
  if (l !== 'zh' && l !== 'en') return;
  if (l === lang) return;
  lang = l;
  try { globalThis.localStorage?.setItem(KEY, l); } catch { /* ignore */ }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l === 'zh' ? 'zh-Hant' : 'en';
    applyI18n(document);
  }
  for (const fn of listeners) { try { fn(l); } catch (e) { console.error(e); } }
}

export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Refresh every data-i18n element under root. */
export function applyI18n(root) {
  if (!root || !root.querySelectorAll) return;
  for (const e of root.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll('[data-i18n-sub]')) e.textContent = t(e.dataset.i18nSub, other());
  for (const e of root.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  for (const e of root.querySelectorAll('[data-i18n-placeholder]')) e.placeholder = t(e.dataset.i18nPlaceholder);
  for (const e of root.querySelectorAll('[data-i18n-aria]')) e.setAttribute('aria-label', t(e.dataset.i18nAria));
}

/** Text node span bound to a key. */
export function tx(key, tag = 'span', cls = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.dataset.i18n = key;
  e.textContent = t(key);
  return e;
}

/** Bilingual label: <span class="bi"><span class="bi__main">聲源</span><span class="bi__sub">Sources</span></span> */
export function bi(key, cls = '') {
  const e = document.createElement('span');
  e.className = `bi ${cls}`.trim();
  const a = document.createElement('span');
  a.className = 'bi__main';
  a.dataset.i18n = key;
  a.textContent = t(key);
  const b = document.createElement('span');
  b.className = 'bi__sub';
  b.dataset.i18nSub = key;
  b.textContent = t(key, other());
  e.append(a, b);
  return e;
}

/** Split "亮度 Bright" → { zh: '亮度', en: 'Bright' } (either part may be empty). */
export function splitName(name) {
  const s = String(name || '').trim();
  const m = /^(.*?[⺀-鿿豈-﫿].*?)\s+([A-Za-z0-9][\w .&/+'’-]*)$/.exec(s);
  if (m) return { zh: m[1], en: m[2] };
  if (/[⺀-鿿豈-﫿]/.test(s)) return { zh: s, en: '' };
  return { zh: '', en: s };
}

/** Label override for components ({zh: primary, en: secondary}) ordered by the current language. */
export function pairLabel(zh, en) {
  zh = zh || ''; en = en || '';
  if (lang === 'en') return { zh: en || zh, en: en ? zh : '' };
  return { zh: zh || en, en: zh ? en : '' };
}

/** Component label for a schema param. */
export function paramLabel(p) { return pairLabel(p.zh, p.label); }

/** Label pair for a GROUPS entry. */
export function groupLabel(id) {
  const g = GROUPS[id] || { zh: id, label: id };
  return pairLabel(g.zh, g.label);
}

/** Label pair for a preset/macro name like "亮度 Bright". */
export function nameLabel(name) {
  const { zh, en } = splitName(name);
  return pairLabel(zh, en);
}

/** Single display string for a bilingual name in the current language. */
export function nameText(name) {
  const { zh, en } = splitName(name);
  if (lang === 'en') return en || zh;
  return zh || en;
}
