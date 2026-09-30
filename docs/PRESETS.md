# AURORA 極光 — 出廠音色庫 Factory Presets

100 個出廠音色，10 個類別各 10 個；每個類別的第一個（★）是旗艦音色。
每個音色都有：一句中文描述、2–4 個英文標籤、剛好 4 個「中文 English」巨集、一個示範樂句（`demo`），
以及一段巨集自動演奏（`demoMacros`）。按下 ▶ 示範，樂句會自動彈奏，巨集旋鈕也會跟著轉動。

*100 factory presets, 10 per category, flagship first (★). Every preset: a zh-TW description, 2–4 tags, exactly
4 macros named "中文 English", a demo phrase and a demo macro ride.*

- 原始碼 Source：`src/presets/<category>.js`（每個檔案 `export default [ … ]`），由 `src/presets/index.js` 彙整
- 試聽 Listen：`node tools/render.mjs --all` → `renders/index.html`（`npm start` 後開 <http://localhost:5173/renders/>）
- 測試 Test：`node tools/test.mjs --only presets`（或 `--preset "<name>"`）

---

## 1. 音色格式 Preset format

```js
{
  name: 'Aurora Pad', category: 'pad', tags: ['lush', 'wide'],
  description: '一句中文描述（建議 ≤ 50 字，Play 畫面顯示一到兩行）',
  params: { 'osc1.unison': 7, … },              // 只寫和預設值不同的參數（native 單位）
  macros: [{ name: '光芒 Glow', targets: [{ id: 'filter.cutoff', amount: 0.3 }, …] }, ×4],
  demo: 'pad',                                   // tools/phrases.mjs 的樂句 id
  demoMacros: [{ index: 0, to: 0.8, beat: 4, beats: 6 }, …],   // ▶ 示範時的巨集自動演奏
}
```

規則 Rules（`tools/test.mjs` 與音色庫驗證腳本都會檢查）：

| 項目 | 規則 |
|---|---|
| params | id 必須存在於 `src/dsp/params.js`；數值在 min…max 內；enum 用 option id；不重複寫預設值；不寫 global 參數（`global.bpm`、`scale.*`、`master.volume`） |
| macros | 剛好 4 個；名稱「中文 English」；target 只能是 float/int 參數，amount −1…1（正規化空間，與基準值相加後夾在 0…1）；指向 `modN.amt` 時該調變槽必須接好 src 與 dst |
| demoMacros | `index` 0–3（該巨集要有 target），`to` 0–1，`beat ≥ 0`，`beats > 0`，整段落在示範樂句長度內。同一個巨集的下一段會接手上一段（從當下的值開始）。沒回到起始值的巨集，UI 在下一輪開頭用 1.5 拍滑回（`src/ui/demo/automation.js`） |
| 名稱 | 全音色庫唯一（不分大小寫）；歌曲、導覽與 jam 以名稱引用音色，改名前先搜尋 `src/demo/` |

**離線渲染會包含巨集演奏**：`tools/render.mjs` 用音色自己的示範樂句渲染時，會把 `demoMacros` 換成每 32 個取樣一步的
`macro` 事件（與 sequencer 的 `ramp-macro` 相同：正規化空間線性、從當下值開始），所以 WAV／頻譜圖／LUFS 就是 ▶ 示範聽到的聲音。
要渲染靜態巨集版本加 `--no-ride`；指定別的樂句（`--phrase scale`）時不加巨集演奏。`npm test` 的 presets 測試也用含巨集演奏的版本。

---

## 2. 品管標準與結果 QA targets and results

量測條件：`node tools/render.mjs --all`，48 kHz，每個音色用自己的示範樂句並包含巨集演奏；LUFS 為 BS.1770 integrated loudness。

| 項目 Criterion | 目標 Target | 結果 Result |
|---|---|---|
| 響度（旋律類 80 個） | −19 ± 1.5 LUFS | −20.3 … −17.6，平均 −19.1，標準差 0.6 |
| 響度（打擊 drum + 音效 fx，20 個） | −21 … −16 LUFS | −20.0 … −17.6，平均 −18.7，標準差 0.8 |
| 全部 100 個 | 切換音色不跳音量 | 中位數 −19.0，全距 2.7 LU |
| 峰值 Peak | ≤ −1 dBFS（true peak） | 最高 −1.5 dBFS（Bamboo Bloop） |
| 限幅器 Limiter | 示範時不動作、不抽吸 | 100 個示範全程增益衰減 0.00 dB（限幅器軟膝從 −1.3 dBFS 開始） |
| 和弦 Chords | 雙手 5 音和弦（C3 G3 C4 E4 G4，力度 0.9）不讓輸出限幅器壓超過 1.5 dB | `npm test` 的 playing checks：最深 0.94 dB（Photon Blaster），撥弦／敲擊類 ≤ 0.8 dB（原本 Walnut Upright 6.3、Pizzicato Hall 5.4、Bamboo Bloop 4.0 dB）；和弦記憶 maj7（力度 100/127）只剩 2 個音色會動到限幅器（Photon Blaster 1.24、Sunrise Anthem 0.49 dB） |
| 同鍵連按 Repeats | 同一個鍵連按 8 次，響度差 ≤ 3 LU | Faded Summer 9.7 → 1.8 LU、Bowed Nocturne 5.5 → 1.4 LU（playing checks） |
| 踏板巨集 Pedal | 名稱含 Pedal 的巨集推到 1，放鍵後的餘音（降 40 dB 所需時間）至少是 0 時的 2 倍 | Ivory Hall Grand 1.25 → 2.9 s、Felt Lullaby 0.55 → 3.3 s、Midnight Vibraphone 1.1 → 2.8 s |
| 巨集安全 Macros | 每個巨集 0／1、全部 0／1 都不爆音、不靜音 | `npm test`：100 個全部通過（無 NaN、峰值 ≤ 1、非靜音、DC < 0.01）；抽樣 30 個（每類 3 個）整段樂句：單一巨集造成的響度變化最大 3.3 LU |
| CPU | Node 單執行緒 ≥ 3× 即時 | 最慢 8.6×（見 §3） |
| 格式 Validation | 0 錯誤 | 0 錯誤；名稱無重複；每類 10 個 |

各類別響度（含巨集演奏）Loudness per category, LUFS:

| 類別 | 最低 min | 中位數 median | 最高 max |
|---|---|---|---|
| 鍵盤 Keys | −20.1 | −19.3 | −18.4 |
| 鋪底 Pad | −19.5 | −18.6 | −17.6 |
| 貝斯 Bass | −20.3 | −19.0 | −18.3 |
| 主奏 Lead | −20.3 | −19.1 | −18.5 |
| 撥弦 Pluck | −20.0 | −19.1 | −18.4 |
| 鐘琴 Bell | −20.1 | −19.3 | −18.4 |
| 弦樂/管樂 Strings & Winds | −19.9 | −19.0 | −18.2 |
| 琶音/律動 Arp & Groove | −19.9 | −19.3 | −18.2 |
| 音效/質感 FX & Texture | −20.0 | −19.1 | −17.6 |
| 打擊 Drum | −19.8 | −18.6 | −17.8 |

---

## 3. CPU：最重的 5 個音色 Heaviest presets

執行緒 CPU 時間（不受其他程序影響），Apple M5、Node 26；「8 聲部和弦」= 8 個音同時按 1.5 s + 0.5 s 釋放（`npm test` 的量法），「樂句」= 含巨集演奏的示範樂句。
數字是即時倍率，越大越輕；門檻是 3×，沒有音色需要簡化。

| # | 音色 | 類別 | 8 聲部和弦 | 示範樂句 | 主要成本 |
|---|---|---|---|---|---|
| 1 | Derelict Starship | fx | 8.6× | 22.5× | growl 波表 ×3 + saw + FM + 噪音 → 推力 Ladder，tube／phaser／delay／reverb |
| 2 | Faded Summer | keys | 9.0× | 12.5× | 波表 + FM + 噪音 + bitcrush + 延遲殘響 |
| 3 | Bronze Ride | drum | 15.0× | 9.2× | 32 模態金屬板 + FM 4-op + 噪音，長衰減讓聲部重疊 |
| 4 | Event Horizon | pad | 9.7× | 10.8× | saw ×5 + growl 波表 ×3 + 推力 Ladder + 相位器 + 8 s 殘響 |
| 5 | Seraphim Voices | pad | 10.2× | 13.5× | vowels 波表 ×5 + VA ×3 + 噪音 → formant 濾波，ensemble + shimmer 殘響 |

（機器負載很高時同樣的量測會降到 4–6×；仍高於 3×。）

---

## 4. 品管期間修正的引擎問題 Engine fixes made during preset QA

音色設計師回報的問題，在引擎端修正（前 → 後，同樣的重現條件）。

| 問題 | 修正 | 前 → 後 |
|---|---|---|
| **phys 弦模型高音區有 < 60 Hz「咚」聲**（`src/dsp/engines/phys.js`） | 撥弦／擊弦的輸出 DC blocker（0.3·f0）與撥弦積分器轉角（0.25·f0）改成全音域跟著 f0 走；原本上限 30／40 Hz，使低於 f0 的殘餘相對於基音放大約 f0/40 倍。弓／氣激發保持原設定 | 預設撥弦 60 Hz 以下能量：C4 −39 → −51 dB、C6 −20 → −53 dB、C7 −12 → −53 dB、F♯7 −8 → −53 dB；實際音色高音區（Ivory Hall Grand、Nylon Serenade、Golden Twelve…）−50…−64 → −74…−111 dB；調音誤差不變（最差 −0.17 cent） |
| **軟槌在高音區音量崩掉**（phys mallet） | 槌的接觸時間以 4-norm 軟性限制在約一個基音週期內（≥ 2 週期的 Hann 脈衝在 f0 有頻譜零點）。弦與模態模型都適用；接觸時間遠小於週期時不變 | hardness 0.16 弦（Felt Lullaby 設定）前 50 ms RMS：C5 −17 → −18、C7 −39 → −16、F♯7 −43 → −17 dB；bar 模型 C7 −30 → −16、F♯7 −40 → −16 dB |
| **reset() 後模態模型變吵／變無聲**（偷聲部時） | `reset()` 一併清掉 `lastLogDec`，否則下一個音會用 T60 = −1 設計模態 | 玻璃＋弓 4 kHz 以上能量 0.93 % → 0.03 %（全新引擎 0.03 %）；bar＋弓 1.08 % → 0.05 %；bar＋槌 reset 後 −200 dB（無聲）→ −15.6 dB（與全新相同）；poly 4 連續敲 10 下的峰值 −11…−11, −25, −28, −27 … → 全部 −11 dBFS；鋪底樂句 glass/bow poly 12 每小節高頻 0.23 %／0.45 % → 0.04 % |
| **全域（Global）LFO 的速度無法被調變矩陣改變**（`src/dsp/synth.js`） | 目標是 `lfoN.rate` 且 LFO 為 Global 模式時，套用全域來源：調變輪、觸後、彎音、以及同為 Global 的 LFO（巨集本來就有效）。每個聲部各自的來源（包絡、力度、音高、Random、Per-Voice LFO）無法驅動唯一的全域 LFO，照舊忽略 | Gospel Rotary + 調變輪 → lfo1.rate 0.3、輪推到底：0.80 Hz → 9.63 Hz。Midnight Vibraphone、Moonlit Carousel 原本無效的「調變輪 → 馬達速度」現在生效（深度調到 0.08：約 5 → 10 Hz） |
| **推力 Ladder 濾波器產生大量 DC**（聲部內沒有 DC blocker） | `src/dsp/voice.js`：主濾波器後加 8 Hz 一階 DC blocker（30 Hz 處 −0.2 dB） | saw → ladder24 drive 1 / res 0.5：DC 佔峰值 17 % → 0.0 %；30 Hz 以下能量 −16 → −79 dB；ladder12 drive 1 / res 0.7：21 % → 0.0 % |
| **離線渲染沒有巨集演奏**（`tools/render.mjs`） | 見 §1；新增 `--no-ride`；`--params` 超出範圍或無效 enum 會警告（原本默默夾值） | Aurora Symphony：靜態 −19.5 → 含演奏 −18.4 LUFS（與 ▶ 示範一致） |
| **只改音高的巨集被判定「沒有作用」**（`tools/test.mjs`） | 巨集測試加入音高偏移量：主峰的瞬時頻率（相位差法）在連續音高區段內相對中位數的 RMS（cents） | Nylon Serenade 揉弦 2.4 → 12.5 ct、Faded Summer 抖動 3.1 → 5.0 ct、Clockwork Music Box 發條 1.6 → 19.7 ct、Jade Guzheng 滑音 3.1 → 21.9 ct（門檻：變化 ≥ max(1.5 ct, 基準的 10 %)） |

`tools/test.mjs` 另外新增：preset 測試用含巨集演奏的版本渲染；檢查 `demoMacros` 格式與長度、巨集名稱「中文 English」、巨集指向沒接好的調變槽、每個類別至少 8 個音色。

---

## 5. 音色庫調整紀錄 Changes made by the librarian

| 音色 | 調整 | 原因 |
|---|---|---|
| Thunder Taiko | amp.level 6 → 4.5 | reset() 修正後被偷的聲部不再無聲，示範變成 −16.8 LUFS；調回 −17.7 |
| Varanasi Tabla | amp.level 6 → 4；描述縮短 | 同上（−16.0 → −17.4） |
| Bronze Ride | amp.level 0 → −2 | 同上（−16.7 → −18.7；前 2 秒後的敲擊原本逐漸變小聲） |
| Gravity Well | amp.level 3 → 2 | 巨集演奏把響度拉到 −16.5 LUFS；→ −17.0 |
| Acid Serpent | drive.amount 0.5 → 預設 0.3；截止 Cutoff 巨集加入 res −0.1、filter.drive +0.25 | 打開濾波器時高共振的 ladder 反而變小聲（演奏時 −21.2 LUFS），amp.level 已經是上限 +6；→ −20.3 |
| Bamboo Bloop | amp.level 3.4 → 3.9；移除 note → amp.level；水滴 Drop 巨集 +amp.level 0.03 | −21.3 LUFS 太小聲；第一拍兩個相差八度的音同時敲下，峰值限制了增益 → −19.9 LUFS、峰值 −1.5 dBFS |
| 7 個鐘琴音色 | 移除 `random → phys.decay`（mod8, 0.006） | 那是繞過 reset() 錯誤的權宜作法，引擎已修正；空出第 8 個調變槽。Wind Chime Garden 的 0.03 是刻意的隨機變化，保留 |
| Bowed Nocturne | 移除 voice.poly 16；aenv.r 1.3 → 2.4 s | 原本為了避免偷聲部後的雜音而縮短釋放；修正後 poly 8 也乾淨，鋪底換和弦更連貫 |
| Midnight Vibraphone、Moonlit Carousel | 調變輪 → lfo1.rate 0.15 → 0.08 | 全域 LFO 修正後生效；0.15 會讓馬達快到 17–25 Hz |
| Autumn Moon Erhu、Andes Pan Flute、Storm Ostinato | 移除重複寫的預設值 | delay.sync 1/8D、arp.mode up |
| Quicksilver Hats、Copper Cowbell | 描述縮短到 50 字左右 | 80／62 字在 Play 畫面會換很多行 |
| Faded Summer | osc1.phase free → reset；amp.level 1.5 → −0.5 | 波表 osc1 與 FM op1 同音高，free 相位讓兩者的相對相位每次按鍵都不同、互相抵消：同一個 E4 連按 8 次 −24…−34 LUFS（差 9.7 LU）→ 差 1.8 LU；相鄰半音最多跳 11.7 → 1.5 LU；示範 −19.7 → −19.2 LUFS。Lo-fi Rain 的 Keys 音軌 −1 → −1.5 dB 補回 |
| Walnut Upright、Pizzicato Hall、Bamboo Bloop、Golden Twelve、Jade Guzheng、Nylon Serenade、Versailles Harpsichord、Clockwork Music Box、Sugar Plum Celesta、Celestial Carillon、Rosewood Marimba | 加上並聯軟削波 drive（soft）：Walnut Upright 用 Lo-fi Rain 的設定（amount 0.4、mix 0.6、tone 0.35）；其他用 amount 0（單位增益 tanh，一般音量下幾乎是直通）、mix 0.4–1 | 撥弦／敲擊的起音比響度高約 20 dB，雙手 5 音和弦（力度 0.9）會讓輸出限幅器壓 1.4–6.3 dB（起音變軟、餘音被壓低 110–155 ms）→ 全部 ≤ 0.8 dB；示範響度變化 ≤ 0.3 LU。只調低 amp.level 行不通：Pizzicato Hall 調到 2 還壓 2.4 dB，示範卻掉到 −23 LUFS。amount 0.4 的版本在鐘琴和弦上失真較明顯（間隙能量 −17 dB，amount 0 為 −27…−45 dB），所以只給貝斯用。（目錄上 Bamboo Bloop 的 −18.4 LUFS 另外包含 phys 引擎的音高重調補償修正：水滴滑音原本被壓小聲，−19.9 → −18.4） |
| Velvet Dub Stabs | 加上軟削波 drive（amount 0、mix 1） | 起音比響度高 17 dB，當 Jam 主奏時把安全限幅器壓到 1.5–2.1 dB → ≤ 0.9 dB；示範 −19.0 → −18.7 LUFS |
| Bowed Nocturne | 關掉 chorus；reverb.mix 0.4 → 0.25；amp.level −4.5 → −5 | 近似正弦的音條經過慢速 chorus 與長殘響的梳狀起伏：同一個 E4 連按 8 次差 5.5 LU → 1.4 LU，C3–C5 持續音全距 8.3 → 5.7 LU；示範 −19.1 → −18.8 LUFS（寬度 0.56 → 0.44） |
| Ivory Hall Grand、Felt Lullaby | 踏板 Pedal 巨集加上 aenv.r（Ivory +0.1、Felt +0.3） | 原本只降低 phys.damp，但 1.5／2.5 s 的振幅釋放（Felt／Ivory）早就把琴弦的 7／9 s 衰減截掉：Pedal = 1 時放鍵後降 40 dB 只要 0.80／1.65 s → 3.3／2.9 s（Pedal = 0 不變）。Ivory 原本也用 +0.3，但釋放被推到 20 s 上限，示範樂句結束 8 s 後仍有 12 個聲部沒釋放（render.mjs：voices stuck）；+0.1 ≈ 6.8 s 釋放，餘音仍是 2.3 倍 |
| Anvil Kick | eq.low 3 → 6 dB（示範曲的大鼓推子：Neon Nights −4 → −2.5、Pulse City −4 → −3、Lo-fi Rain −3 → −2.5 dB） | phys 引擎修正（音高下降時模態輸出不再按 ω 比例暴增，兩個八度的俯衝原本是 +12 dB 的突波）後，靠音高包絡俯衝的大鼓少了那股低頻 boom：示範 −18.9 → −21.0 LUFS、三首示範曲裡的大鼓約少 3 LU。amp.level 已是上限 +6，改用低頻架式 EQ 補回低頻 → −19.4 LUFS；示範曲大鼓回到 −23.0…−23.7 LUFS，混音 pre-limit 仍 ≤ −1 dBFS |
| Gravity Well、Glass Rain、Bamboo Bloop | 不調整 | 同一個 phys 修正讓音高滑動的聲部變得連續：Gravity Well −17.0 → −19.4、Glass Rain −19.3 → −17.7、Bamboo Bloop −19.9 → −18.4 LUFS，都還在各自的目標範圍內 |

保留的權宜作法（不影響音色）：鋼琴類的 note → filter2 高通與 note → hardness、主奏類 filter2 高通 50–100 Hz、
Nylon Serenade 揉弦巨集的少量 decay、Quicksilver Hats 用 menv → amp.level 做鍵位決定的衰減、Stadium Clap 用 10.5 ms delay 做拍手連擊。

---

## 6. 給音色設計師 Notes for sound designers

- **Global LFO**：`lfoN.mode = 'mono'` 時，只有調變輪、觸後、彎音、另一個 Global LFO 與巨集能改它的速度；
  Per-Voice 來源（envelope、velocity、note、random、Per-Voice LFO）對 Global LFO 的 rate 沒有作用。
- **音量上限**：`amp.level` 最大 +6 dB，而且調變在正規化空間相加後夾在 0…1，靠近上限時正向調變會被截掉；需要更多音量時提高來源的 level。
- **高共振 ladder** 打開 cutoff 時響度可能下降（共振峰移到諧波較弱的高頻，通帶又被 res 削弱），截止巨集可以同時稍微降低 res。
- **八度疊音同時敲擊** 的峰值會相加（Bamboo Bloop），用峰值而不是響度決定上限時，可以減少低音區的音量。
- **偷聲部**：phys 模態與弦模型在偷聲部後已與全新聲部一致，不需要再用 poly 16 或短釋放迴避。
- **同音高的兩層**（例如振盪器 + FM 載波、兩個 oct 0 的振盪器）：其中一層是 `phase: 'free'` 時，兩層的相對相位每次按鍵都不同，
  同一個音會忽大忽小（Faded Summer 曾差 10 LU）。把自由相位那層設成 `reset`，或移開一個八度。
- **撥弦／敲擊的和弦峰值**：起音比響度高約 20 dB，5 音和弦的峰值會疊加。用 `drive.on` + `drive.amount: 0`（單位增益 soft clip）
  並調 `drive.mix` 削掉和弦起音的峰值，比調低 amp.level 好（示範響度幾乎不變）。`npm test` 的 playing checks 會檢查。
- **踏板巨集**：只降低 phys.damp 不夠，振幅包絡的 release 會先把尾音切掉；踏板巨集要一起拉長 `aenv.r`，但別推到 20 s 上限（釋放期間聲部不會被回收，停奏後仍在耗 CPU）：`aenv.r` 是指數刻度，+0.1 就約是 ×2.7。
- **近似正弦的持續音**（bowed bar、glass）加 chorus 或大量殘響，每個鍵與每次按鍵的響度會明顯不同；這類音色少用 chorus、殘響 mix 保守一點。

---

## 7. 尚未解決（在音色庫以外）Open issues outside the preset library

| 位置 | 問題 | 重現／數據 |
|---|---|---|
| `src/dsp/filter.js`（formant） | 響度隨音高變化 10–17 dB（固定共振峰遇上低次諧波） | saw unison 3、formant 1800 Hz / res 0.5，C2–C7 每音 −26 … −9 LUFS |
| `src/dsp/fx/comp.js` | 自動補償沒有把響度補回來；第一個起音在偵測器充電前通過 | Sunrise Anthem comp.amount 0.55：−19.1 → −20.2 LUFS，峰值不變 |
| `src/dsp/fx/delay.js:114-121, 181` | 載入音色後延遲第一次啟動有 20 ms 輸入淡入，極短延遲的效果在第一下少了約 20 dB | Stadium Clap 載入後第一擊 |
| `src/dsp/engines/osc.js` | `phase: 'reset'` + 寬 unison 的立體聲相關係數為負（−0.25），單聲道相容性差；2 聲部極小 detune 可能長時間接近反相 | Sunrise Anthem 兩個振盪器設 reset |
| FX 鏈 | chorus／phaser／delay／reverb 沒有低頻單聲道或低切選項，低音與鋪底只能用 filter2 高通或 dry 路徑迴避 | Tidal Reese 草稿 phaser 0.35：150 Hz 以下 side −10.7 dB |
| `src/dsp/params.js` | LFO 最高 40 Hz、`aenv.*` 與 `noise.decay` 不能調變、巨集不能指向 enum（節拍分割） | 設計限制 |
| `src/dsp/synth.js` | mono／legato 模式每次換音都滑音，沒有 303 式「只在重疊時滑」 | 符合文件描述的行為 |
| `tools/render-jam.mjs:205` | `leadFor.fx = 'Nebula Drift'`、`leadFor.drum = 'Membrane Kit'` 不存在（會退回第一個同類音色） | 建議改成 Singularity、Thunder Taiko |
| UI | 調變矩陣或 LFO「Global」模式的提示文字，應說明哪些來源能改變 Global LFO 的速度 | 見 §6 |
| `README.md` | render 說明還沒提到示範樂句會包含巨集演奏與 `--no-ride` | |
| `renders/` | 仍有舊名稱或非示範樂句的渲染（例：Golden Brass、Moonlit Erhu、Velvet Cello），圖庫會一起列出 | 刪除 `renders/` 後重新 `node tools/render.mjs --all` |

---

## 8. 音色目錄 Catalog

LUFS = 示範樂句（含巨集演奏）的 integrated loudness。引擎欄：`WT` = 波表，`×n` = unison 聲部數，`F2` = 第二濾波器，
`Phys model/exciter` = 物理模型／激發方式。

### 鍵盤 Keys (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Moonlit Suitcase** ★ | 月光下的皮箱電鋼琴：溫潤的音叉鐘鳴在左右聲道間搖曳，推起「綻放」便湧出一層絲絨般的鋪底。 | saw ×3 + FM algo 3 → Ladder 24 · chorus, delay 1/8D, reverb, glue | 咆哮 Bark · 顫音 Tremolo · 綻放 Bloom · 空間 Space | keys | -19.2 |
| 2 | **Ivory Hall Grand** | 音樂廳裡的平台鋼琴：琴槌力度決定明暗，低音渾厚、高音清亮，踩下踏板讓琴弦自由共鳴。 | Phys string/mallet + noise burst → F2 HP · reverb, glue | 觸鍵 Touch · 踏板 Pedal · 共鳴 Resonance · 音樂廳 Hall | keys | -19.9 |
| 3 | **Felt Lullaby** | 蓋上毛氈的直立鋼琴，貼近琴槌錄下的柔軟觸鍵與木頭機械聲，像深夜裡哼給自己聽的搖籃曲。 | Phys string/mallet + noise burst → SVF LP → F2 HP · reverb, glue | 氈布 Felt · 踏板 Pedal · 機械 Mechanics · 房間 Room | keys | -19.1 |
| 4 | **Platinum Ballad** | 八〇年代抒情金曲裡的數位電鋼琴：清脆閃亮的音叉叮噹，配上寬闊合唱與乒乓回音。 | FM algo 3 · chorus, delay 1/8D, reverb | 玻璃 Glass · 合唱 Chorus · 回音 Echo · 空間 Space | keys | -20.1 |
| 5 | **Amber Reeds** | 琥珀色燈光下的簧片電鋼琴，輕觸時圓潤帶鼻音，重擊時音箱發出沙啞咆哮。 | FM algo 3 → Ladder 12 · tube, reverb | 咆哮 Bark · 顫音 Tremolo · 鼻音 Nasal · 空間 Space | keys | -19.4 |
| 6 | **Gospel Rotary** | 週日教堂裡的拉桿風琴：轉動的號角喇叭把和弦甩向四方，拉滿音栓就是整座詩班的吶喊。 | WT Organ + FM algo 1 + noise burst → SVF LP → F2 HP · tube, chorus, reverb | 音栓 Drawbars · 轉速 Rotor · 打擊音 Percussion · 過載 Overdrive | keys | -18.4 |
| 7 | **Strut Clav** | 放克樂手最愛的撥弦鍵盤：短促帶勁的琴弦撥響，配上會說話的哇哇濾波與迷幻相位。 | Phys string/pluck → Ladder 24 → F2 HP · drive, phaser, reverb, glue | 哇音 Wah · 拾音 Pickup · 止音 Mute · 相位 Phaser | pluck | -20.0 |
| 8 | **Versailles Harpsichord** | 凡爾賽宮鏡廳裡的大鍵琴，羽管撥弦清脆閃亮，兩組琴弦微微錯開，迴盪著巴洛克的華麗。 | FM algo 3 + Phys string/pluck → SVF LP → F2 HP · drive, reverb | 琉特 Lute · 八度 Octave · 共鳴 Body · 殿堂 Hall | pluck | -18.8 |
| 9 | **Sunset Poly** | 夕陽灑落海岸公路，溫暖的類比複音合成器和弦透過經典立體合唱緩緩展開，是八〇年代合成器流行的招牌聲響。 | saw ×2 + square → Ladder 24 · chorus, delay 1/8D, reverb | 亮度 Bright · 衝擊 Punch · 合唱 Chorus · 空間 Space | keys | -19.4 |
| 10 | **Faded Summer** | 從抽屜深處翻出的舊錄音帶：走音晃動的電鋼琴、細碎的底噪與失真，一按下去就回到那年夏天。 | WT Digital + FM algo 3 + noise → Ladder 12 → F2 HP · bitcrush, delay 1/4, reverb | 抖動 Wow · 歲月 Age · 回音 Echo · 空間 Space | keys | -19.2 |

### 鋪底 Pad (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Aurora Pad** ★ | 超鋸齒與流動的母音波表交織，觸鍵綻放一抹 FM 晶光，如極光在夜空舒展 | saw ×7 + WT Vowels ×3 + FM algo 3 → SVF LP · ensemble, delay 1/4D, shimmer reverb, glue | 光芒 Glow · 流動 Motion · 空間 Space · 起音 Swell | pad | -18.6 |
| 2 | **Velvet Dusk** | 鋸齒與脈寬調變的經典類比雙振盪器，裹上合唱效果，如黃昏的絲絨餘暉 | saw ×2 + pulse → Ladder 24 · tube, chorus, delay 1/4, reverb, glue | 亮度 Bright · 合唱 Ensemble · 磁帶 Tape · 起音 Swell | pad | -19.2 |
| 3 | **Seraphim Voices** | 天使般柔和的「嗚—喔」合唱在穹頂下迴旋，微光殘響把人聲托向高處 | WT Vowels ×5 + VA morph ×3 + noise → Formant → F2 LP · ensemble, shimmer reverb, glue | 母音 Vowel · 氣息 Breath · 聲部 Voices · 天堂 Heaven | pad | -18.6 |
| 4 | **Prism Halo** | 玻璃波表與 FM 泛音層層折射，微光殘響把每個和弦化成懸浮的光環 | WT Glass ×4 + VA morph ×2 + FM algo 5 → SVF LP → F2 HP · delay 1/8D, shimmer reverb | 微光 Shimmer · 晶瑩 Sparkle · 深度 Depth · 回聲 Echo | pad | -19.5 |
| 5 | **Event Horizon** | 咆哮波表與深沉鋸齒在暗處緩緩蠕動，像被黑洞邊緣吞沒的電影配樂 | saw ×5 + WT Growl ×3 + noise → Ladder 24 → F2 HP · tube, phaser, reverb, glue | 張力 Tension · 黑暗 Darkness · 蠕動 Crawl · 深淵 Abyss | pad | -18.4 |
| 6 | **Kaleidoscope** | 隨節拍呼吸起伏的律動鋪底，數位波表不斷變換色彩，如萬花筒般旋轉 | WT Digital ×5 + WT Harmonic Sweep ×3 +1oct → SVF LP · phaser, delay 1/8D, reverb, glue | 律動 Pump · 變幻 Morph · 共振 Resonance · 回聲 Echo | pad | -17.6 |
| 7 | **Zephyr** | 柔和的正弦齊奏裹著吹管氣息與掠過的風聲，輕盈得像春日西風 | VA morph ×3 + WT Harmonic Sweep +1oct + Phys string/breath + noise → SVF BP → F2 LP · chorus, reverb | 氣息 Breath · 風速 Wind · 音色 Tone · 空間 Space | pad | -19.0 |
| 8 | **Bowed Nocturne** | 琴弓拉奏鐵琴音條的物理模型，金屬長音在夜色中吟唱，開啟馬達便泛起顫音 | sine ×2 +1oct + Phys bar/bow → SVF LP · delay 1/2, shimmer reverb | 弓壓 Bow · 馬達 Motor · 光暈 Halo · 空間 Space | pad | -18.8 |
| 9 | **Starfall Brass** | 八〇年代電影感銅管鋪底，濾波包絡吹出飽滿起音，觸後壓力讓它更明亮 | saw ×3 + saw → Ladder 24 · chorus, delay 1/4, reverb, glue | 咆哮 Blare · 亮度 Bright · 厚度 Stack · 空間 Space | pad | -18.1 |
| 10 | **First Light** | 從幽暗緩緩升起的泛音掃描，每個和弦都像地平線上逐漸亮起的第一道晨光 | WT Harmonic Sweep ×5 + WT Strings +1oct → Ladder 12 · ensemble, delay 1/2, shimmer reverb | 日出 Sunrise · 起音 Attack · 溫度 Warmth · 空間 Space | pad | -18.6 |

### 貝斯 Bass (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Tidal Reese** ★ | 深海潮汐般翻湧的 Reese 貝斯：多重失諧鋸齒波緩緩旋轉，底下是紋絲不動的純淨次低音。 | saw ×3 + saw ×5 + FM algo 1 → Ladder 24 → F2 HP · drive, glue · legato | 撕裂 Tear · 亮度 Bright · 流動 Motion · 次低音 Sub | bass | -20.1 |
| 2 | **Deep Bass** | 經典單音類比貝斯：鋸齒波與方波交疊，階梯濾波器一開一合，扎實撐起整首歌的低頻。 | saw + square → Ladder 24 · tube, glue · mono | 截止 Cutoff · 衝擊 Punch · 失真 Drive · 滑音 Glide | bass | -18.3 |
| 3 | **Acid Serpent** | 像毒蛇般扭動的 303 酸性貝斯：高共振濾波器隨重音尖叫，滑音在十六分音符之間蜿蜒。 | saw → Ladder 12 · drive, delay 3/16, glue · legato | 截止 Cutoff · 共振 Resonance · 包絡 Env Mod · 失真 Drive | bass | -20.3 |
| 4 | **Leviathan Growl** | 深海巨獸般低吼的說話貝斯：母音濾波器隨每個音張口咆哮，失真把中頻撕得粗糲。 | saw + square + FM algo 1 → Formant · drive, glue · mono | 母音 Vowel · 說話 Talk · 咆哮 Growl · 次低音 Sub | bass | -18.3 |
| 5 | **Seismic Wobble** | 地震般撼動地面的 Dubstep 擺動貝斯：濾波器跟著節拍 wub-wub，一轉旋鈕就切換成三連音。 | WT Growl + sine → SVF LP · drive, glue · mono | 擺動 Wobble · 速度 Rate · 咆哮 Growl · 次低音 Sub | bass | -19.8 |
| 6 | **Chrome Slap** | 鍍鉻般閃亮的 80 年代 FM 拍弦貝斯：彈得越用力，起音的金屬光澤就越刺眼。 | FM algo 2 → Ladder 24 · glue · mono | 撥擊 Slap · 厚度 Growl · 延持 Sustain · 亮度 Bright | bass | -18.8 |
| 7 | **Walnut Upright** | 胡桃木色的原聲低音提琴：物理模型琴弦與共鳴箱，指尖撥弦的溫潤木質感彷彿就在爵士酒館。 | Phys string/pluck → Ladder 24 · drive, reverb, glue | 撥弦 Pluck · 亮度 Tone · 延音 Sustain · 空間 Room | bass | -18.4 |
| 8 | **Rubber Pulse** | 橡皮筋般彈跳的合成流行貝斯：脈衝波緩緩呼吸，每個音都帶一點俏皮的回彈。 | pulse + saw +1oct → Ladder 12 · drive, glue · mono | 彈性 Snap · 脈寬 PWM · 亮度 Bright · 八度 Octave | bass | -19.5 |
| 9 | **Warehouse Organ** | 90 年代倉庫派對的浩室風琴貝斯：音栓風琴配上清脆鍵擊，短促又充滿律動。 | WT Organ +1oct + WT Organ +1oct + noise burst → Ladder 12 · tube, glue · mono | 音栓 Drawbars · 敲擊 Click · 衰減 Decay · 失真 Overdrive | bass | -18.9 |
| 10 | **Abyssal Sub** | 深淵般純淨的次低音：正弦波加上一抹溫暖泛音，連小喇叭都聽得見它的重量。 | sine + tri +1oct → Ladder 24 · tube, glue · mono | 泛音 Harmonics · 衝擊 Punch · 尾音 Tail · 滑音 Glide | bass | -19.1 |

### 主奏 Lead (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Polaris Sync** ★ | 硬同步鋸齒波隨每個音符呼嘯掃過，乒乓回聲把旋律拋向北極星 | saw+sync ×3 + VA morph -1oct → Ladder 24 → F2 HP · tube, delay 1/8D, reverb, glue · mono | 同步 Sync · 亮度 Bright · 咆哮 Grit · 空間 Space | lead | -18.9 |
| 2 | **Stellar Supersaw** | 七聲齊奏的超級鋸齒波鋪滿聲場，附點回聲讓旋律像星河般閃耀 | saw ×7 + saw ×5 +1oct → SVF LP · delay 1/8D, reverb, glue | 亮度 Bright · 齊奏 Detune · 閘門 Gate · 空間 Space | lead | -19.1 |
| 3 | **Monolith Solo** | 經典單音類比獨奏：飽和的階梯濾波器、一氣呵成的滑音與轉輪顫音 | saw + saw → Ladder 24 → F2 HP · tube, delay 1/4, reverb · legato | 截止 Cutoff · 共振 Emphasis · 包絡 Contour · 滑音 Glide | lead | -18.7 |
| 4 | **Cartridge Hero** | 插上卡匣主角登場：八位元脈衝波、延遲顫音與一點位元壓縮 | pulse + pulse +1oct → SVF LP · bitcrush, delay 1/8, reverb · mono | 脈寬 Pulse · 位元 Crush · 跳音 Blip · 回聲 Echo | lead | -19.1 |
| 5 | **Meadow Whistle** | 晚風吹過草原的口哨：純淨正弦帶著氣息與滑音，顫音在長音裡綻開 | sine + tri +1oct + noise → SVF BP · delay 1/4, reverb · legato | 氣息 Breath · 顫音 Vibrato · 泛音 Overtone · 空間 Space | lead | -18.9 |
| 6 | **Vowel Siren** | 會說話的合成人聲，在 A、E、I、O、U 母音之間吟唱變形 | saw ×5 + square -1oct + noise → Formant · chorus, delay 1/8D, reverb, glue · legato | 母音 Vowel · 嗓音 Voice · 說話 Talk · 空間 Space | lead | -20.3 |
| 7 | **Solar Brass** | 明亮的 FM 銅管主奏：越用力吹越金光燦爛，觸後壓力讓音色咆哮起來 | FM algo 2 → SVF LP → F2 HP · ensemble, delay 1/4D, reverb · legato | 銅亮 Brass · 咆哮 Growl · 合奏 Ensemble · 空間 Space | lead | -19.1 |
| 8 | **Molten Scream** | 熔岩般灼熱的失真主奏：共振濾波器在高音區嘶吼，推起調變輪就尖嘯 | saw ×4 + square → Ladder 24 → F2 HP · tube, delay 1/8D, reverb, glue · legato | 失真 Drive · 尖嘯 Scream · 哇音 Wah · 回聲 Echo | lead | -19.0 |
| 9 | **Bamboo Dizi** | 物理模型吹奏的竹笛，笛膜輕顫、氣息飽滿，適合悠揚的東方旋律 | Phys string/breath + noise burst → Ladder 24 · delay 1/4, reverb · legato | 氣壓 Breath · 亮度 Bright · 顫音 Vibrato · 空間 Space | lead | -18.5 |
| 10 | **Horizon Throw** | 電影感的波表主奏：音色緩緩變形，句尾的回聲一甩便在地平線上層層散開 | WT Strings ×3 + VA morph -1oct → Ladder 12 · ensemble, delay 1/4D, shimmer reverb · legato | 變形 Morph · 亮度 Bright · 回聲 Throw · 微光 Shimmer | lead | -19.1 |

### 撥弦 Pluck (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Starlight Harp** ★ | 星光灑落的豎琴，高八度玻璃泛音在微光殘響中緩緩升起 | WT Glass ×2 +1oct + Phys string/pluck → SVF HP → F2 LP · delay 1/4D, shimmer reverb | 亮度 Bright · 星塵 Stardust · 回聲 Echo · 餘韻 Ring | pluck | -18.8 |
| 2 | **Nylon Serenade** | 月光下的尼龍弦古典吉他，指尖撥奏溫暖圓潤，琴箱共鳴自然 | Phys string/pluck → SVF HP · drive, reverb | 音色 Tone · 悶音 Mute · 揉弦 Vibrato · 空間 Room | pluck | -19.8 |
| 3 | **Jade Guzheng** | 玉石般清亮的古箏，指甲撥弦帶出金屬光澤，揉弦與上滑音婉轉生情 | Phys string/pluck → SVF HP → F2 LP · drive, delay 1/8D, reverb | 亮度 Bright · 滑音 Slide · 揉弦 Vibrato · 空間 Space | pluck | -19.6 |
| 4 | **Dewdrop Kalimba** | 晨露般晶瑩的拇指琴，金屬簧片輕彈，木箱共鳴與乒乓回聲輕盈跳躍 | FM algo 3 + Phys bar/pluck → Ladder 24 · delay 1/8, reverb | 金屬 Tine · 木箱 Box · 回聲 Echo · 長度 Length | pluck | -18.9 |
| 5 | **Sunrise Anthem** | 日出時分的電音撥奏，超鋸齒齊奏配上快速濾波包絡與附點乒乓延遲 | saw ×7 + saw ×3 +1oct → Ladder 24 · delay 1/8D, reverb | 截止 Cutoff · 長度 Decay · 共振 Reso · 空間 Space | pluck | -19.0 |
| 6 | **Pizzicato Hall** | 音樂廳裡的弦樂撥奏群，短促圓潤的指撥在寬廣殘響中此起彼落 | Phys string/pluck → SVF HP · drive, ensemble, reverb | 力度 Snap · 群奏 Section · 長度 Length · 音樂廳 Hall | pluck | -20.0 |
| 7 | **Prism Shards** | 光線穿過稜鏡的數位碎片，波表位置隨每次撥奏迅速掃過 | WT Digital ×3 + VA morph → Ladder 24 · bitcrush, delay 3/16, reverb | 掃描 Scan · 衰減 Decay · 晶格 Crush · 回聲 Echo | pluck | -18.4 |
| 8 | **Golden Twelve** | 金色陽光般閃耀的十二弦鋼弦吉他，八度複弦與合唱交織出豐盈光澤 | Phys string/pluck → SVF HP → F2 LP · drive, chorus, reverb · chord oct | 亮度 Bright · 閃爍 Shimmer · 撥片 Pick · 空間 Space | pluck | -19.2 |
| 9 | **Cassette Bloom** | 舊卡帶裡綻放的 Lo-fi 撥音，FM 柔和鐘感帶著磁帶抖動與溫暖顆粒 | FM algo 3 → Ladder 12 · tube, chorus, delay 1/4, reverb | 磁帶 Wow · 溫暖 Warmth · 顆粒 Grit · 回聲 Echo | keys | -20.0 |
| 10 | **Bamboo Bloop** | 雨滴落在竹筒上的俏皮木質撥音，每一下都帶著「啵」的水滴音高滑升 | sine + Phys bar/mallet → SVF LP · drive, delay 1/16, reverb | 水滴 Drop · 竹管 Bamboo · 回聲 Echo · 長度 Length | pluck | -18.4 |

### 鐘琴 Bell (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Celestial Carillon** ★ | 青銅鐘樓在極光下齊鳴：低沉的嗡鳴、明亮的敲擊，與緩緩升起的天光殘響 | WT Vowels ×3 + Phys bell/mallet + noise burst → SVF HP · drive, shimmer reverb | 敲擊 Strike · 材質 Material · 聖詠 Choir · 天光 Shimmer | bell | -18.4 |
| 2 | **Midnight Vibraphone** | 深夜爵士酒吧裡的顫音琴：鋁板溫柔地發亮，馬達轉動帶出一圈圈呼吸般的顫音 | Phys bar/mallet → Ladder 24 · chorus, reverb | 琴槌 Mallet · 顫音 Tremolo · 踏板 Pedal · 空間 Room | keys | -19.9 |
| 3 | **Rosewood Marimba** | 玫瑰木琴鍵與共鳴管交融的溫暖馬林巴，毛線槌落下時圓潤而飽滿 | Phys bar/mallet + noise burst → Ladder 24 · drive, reverb | 琴槌 Mallet · 敲擊點 Position · 共鳴 Resonance · 空間 Room | pluck | -19.4 |
| 4 | **Glass Harmonica** | 沾濕的指尖摩擦旋轉的水晶碗，純淨的歌聲從玻璃裡緩緩浮現 | Phys glass/bow → Ladder 24 · reverb | 指壓 Pressure · 水晶 Crystal · 氣息 Breath · 空間 Space | pad | -18.8 |
| 5 | **Clockwork Music Box** | 轉緊發條的木頭音樂盒，鋼梳齒一根根被撥響，帶著一點舊時光的搖晃 | FM algo 3 + Phys bar/pluck → Ladder 24 · drive, chorus, reverb | 梳齒 Tine · 發條 Wind-up · 木盒 Box · 回憶 Memory | bell | -19.5 |
| 6 | **Sugar Plum Celesta** | 糖梅仙子的鋼片琴：小槌輕敲鋼片，木箱共鳴出甜美如糖霜的鐘音 | FM algo 3 + Phys bar/mallet → Ladder 24 · drive, chorus, reverb | 甜度 Sweetness · 鋼片 Steel · 延音 Sustain · 音樂廳 Hall | bell | -18.6 |
| 7 | **Ombak Gamelan** | 峇里島青銅鍵盤成對調音，兩片銅鍵之間的拍頻像海浪般起伏（ombak） | FM algo 8 + Phys bar/mallet → Ladder 24 · reverb | 波動 Ombak · 青銅 Bronze · 悶音 Damping · 廟宇 Temple | pluck | -19.1 |
| 8 | **Himalayan Singing Bowl** | 喜馬拉雅頌缽：毛氈槌輕敲後沿著缽緣研磨，低沉的嗡鳴與拍頻在空氣中久久迴旋 | FM algo 8 + Phys glass/mallet → SVF HP · reverb | 研磨 Rim · 敲擊 Strike · 拍頻 Beat · 冥想 Space | bell | -19.7 |
| 9 | **Frost Lantern** | 冰晶燈籠在雪夜裡叮噹作響：清脆的 FM 鐘聲下，玻璃般的光暈緩緩亮起 | WT Glass ×4 + FM algo 3 → SVF LP · delay 1/4D, shimmer reverb | 冰晶 Crystal · 光暈 Halo · 回聲 Echo · 極光 Aurora | pad | -18.6 |
| 10 | **Wind Chime Garden** | 微風吹過庭院的鋁管風鈴：按住和弦，鈴管便隨機地輕輕互撞，叮叮噹噹不停歇 | Phys bar/mallet → Ladder 24 · reverb · arp random 1/8 | 風力 Breeze · 鈴管 Tubes · 音域 Range · 庭院 Garden | arp | -20.1 |

### 弦樂/管樂 Strings & Winds (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Aurora Symphony** ★ | 波表弦群、物理擦弦與低音提琴層層交織，從極弱推到極強；轉動「極光」，整座音樂廳泛起微光 | WT Strings ×5 + WT Strings ×2 -1oct + Phys string/bow → SVF LP · ensemble, reverb, glue | 力度 Dynamics · 運弓 Bowing · 合奏 Ensemble · 極光 Aurora | strings | -18.4 |
| 2 | **Rosewood Cello** | 物理擦弦大提琴，琴身溫暖、揉弦緩緩浮現；推「聲部」巨集，獨奏瞬間化為整排大提琴 | WT Strings ×5 + Phys string/bow → SVF LP → F2 HP · ensemble, reverb | 弓壓 Pressure · 揉弦 Vibrato · 聲部 Section · 空間 Room | strings | -18.9 |
| 3 | **Autumn Moon Erhu** | 平湖秋月般的二胡，鼻音般的擦弦、深情揉弦與滑音，推調變輪揉得更深 | Phys string/bow → SVF LP → F2 HP · delay 1/8D, reverb · legato | 揉弦 Vibrato · 滑音 Glide · 鼻音 Nasal · 月色 Moonlight | lead | -19.1 |
| 4 | **Gilded Fanfare** | 金光閃閃的銅管聲部，FM 銅管疊上鋸齒波，下鍵越重越嘹亮，推調變輪就發出咆哮 | saw ×3 + FM algo 2 → Ladder 24 · chorus, reverb, glue | 咆哮 Bite · 漸強 Swell · 聲部 Section · 空間 Hall | keys | -19.3 |
| 5 | **Twilight Horn** | 暮色中的法國號，圓潤溫暖、慢慢綻放，彷彿從遠方的音樂廳傳來 | saw → Ladder 24 · chorus, reverb | 力度 Dynamics · 漸強 Swell · 聲部 Section · 空間 Hall | pad | -18.2 |
| 6 | **Andes Pan Flute** | 安地斯山的排笛，物理吹氣模型帶著氣音、顫音與山谷回聲 | Phys string/breath + noise burst → SVF LP → F2 HP · delay 1/8D, reverb · legato | 氣息 Breath · 顫音 Vibrato · 回聲 Echo · 山谷 Canyon | lead | -18.8 |
| 7 | **Ebony Clarinet** | 烏木單簧管，奇次泛音的木質音色與簧片氣息，低音溫潤、高音明亮 | pulse + noise → Ladder 24 → F2 HP · reverb · legato | 亮度 Bright · 氣息 Breath · 顫音 Vibrato · 空間 Room | lead | -19.2 |
| 8 | **Vesper Choir** | 晚禱合唱團，母音從「啊」慢慢轉成「喔」，在教堂殘響裡迴盪 | saw ×6 + WT Vowels ×3 + noise → Formant · ensemble, shimmer reverb | 母音 Vowel · 氣聲 Breath · 人數 Voices · 天堂 Heaven | strings | -18.5 |
| 9 | **String Machine '79** | 七〇年代弦樂機，鋸齒波加上 BBD 合奏與緩慢相位器，復古又夢幻 | saw ×2 + saw +1oct → SVF LP → F2 HP · ensemble, phaser, reverb | 亮度 Bright · 相位 Phaser · 八度 Octave · 空間 Space | pad | -19.5 |
| 10 | **Storm Ostinato** | 按住和弦，琶音器就奏出風暴般的十六分音符跳弓，電影配樂的緊張感一觸即發 | WT Strings ×4 + WT Strings ×2 -1oct + noise burst → Ladder 24 · delay 3/16, reverb, glue · arp up 1/16 | 音長 Length · 咬勁 Bite · 音域 Range · 殿堂 Hall | arp | -19.9 |

### 琶音/律動 Arp & Groove (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Borealis Sequencer** ★ | 柏林學派的十六分音符序列：鋸齒波穿過會呼吸的階梯濾波器，每一步都閃著玻璃般的 FM 微光，回聲在左右聲道間流轉 | saw ×2 + pulse -1oct + FM algo 3 → Ladder 24 · delay 3/16, reverb, glue · arp up 1/16 | 截止 Cutoff · 酸度 Acid · 律動 Motion · 空間 Space | arp | -19.4 |
| 2 | **Hyperion Gate** | 整個和弦每個十六分音符重擊一次、上下八度交替跳動，超鋸齒波門控的經典 Trance 能量 | saw ×7 + saw ×3 -1oct → SVF LP · delay 1/8D, reverb, glue · arp chord 1/16 | 濾波 Filter · 門控 Gate · 厚度 Detune · 空間 Space | arp | -19.8 |
| 3 | **Snowglobe Cascade** | 搖一搖水晶球：FM 鐘聲上下迴旋，乒乓回聲與微光殘響像雪花緩緩落下 | FM algo 3 · delay 1/8D, shimmer reverb · arp updown 1/16 | 亮度 Bright · 餘韻 Ring · 微光 Shimmer · 回聲 Echo | arp | -18.2 |
| 4 | **Paper Lantern Echoes** | 物理模型古箏撥弦由高而下，附點八分的乒乓回聲在夜空中交織成紙燈籠般的光點 | Phys string/pluck → SVF HP → F2 LP · delay 1/8D, reverb, glue · arp down 1/8 | 音色 Tone · 延音 Sustain · 回聲 Echo · 搖擺 Swing | arp | -19.1 |
| 5 | **Firefly Constellation** | 隨機跳躍的玻璃音點在三個八度間閃爍，每一顆音色與位置都不同，漂浮在微光殘響的星空裡 | WT Glass + sine +1oct → SVF LP · delay 1/4, shimmer reverb · arp random 1/8 | 閃爍 Twinkle · 亮度 Bright · 微光 Shimmer · 空間 Space | arp | -18.4 |
| 6 | **Midnight Freeway** | 午夜公路上的低音琶音：直行的十六分音符被附點八分的重音切出切分律動，微微搖擺 | saw ×2 -1oct + tri -2oct → Ladder 24 · tube, delay 1/8D, glue · arp up 1/16 | 截止 Cutoff · 重音 Accent · 咬勁 Grit · 搖擺 Swing | arp | -19.9 |
| 7 | **Pixel Quest** | 三十二分音符的 8-bit 急速琶音：窄脈衝方波緩緩掃動佔空比，配上短促回聲；轉開位元巨集，就回到老遊戲機的粗糙冒險關卡 | pulse → SVF LP · bitcrush, delay 1/8, reverb · arp up 1/32 | 脈寬 Duty · 位元 Crush · 音長 Gate · 回聲 Echo | arp | -18.7 |
| 8 | **Moonlit Carousel** | 三連音的顫音琴在月光下旋轉，馬達顫音輕輕起伏，底下墊著一層柔軟的暖色和聲 | tri ×2 -1oct + Phys bar/mallet → SVF LP · chorus, delay 1/4T, reverb · arp up 1/16T | 顫音 Tremolo · 暖墊 Warmth · 槌硬度 Mallet · 空間 Space | arp | -19.8 |
| 9 | **Obsidian Techno** | 黑曜石般冷硬的地下室 Techno：硬同步鋸齒波撞進過載的階梯濾波器，黑暗而催眠 | saw ×3 -1oct + saw+sync -1oct → Ladder 24 · tube, delay 1/8D, reverb, glue · arp down 1/16 | 截止 Cutoff · 酸度 Acid · 失真 Drive · 迴響 Dub | arp | -19.7 |
| 10 | **Velvet Dub Stabs** | 按住和弦就自動彈出帶搖擺的短促和弦，沉入深色的附點回聲與殘響，Dub Techno 式的絲絨律動 | saw ×2 + pulse → SVF LP · drive, chorus, delay 3/16, reverb, glue · arp chord 1/8 | 濾波 Filter · 搖擺 Swing · 音長 Length · 迴響 Dub | arp | -18.7 |

### 音效/質感 FX & Texture (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Singularity** ★ | 按住就開始升空的電影感上升音效：諧波波表與噪音一同攀升、顫動越來越急，最後沒入微光殘響 | WT Harmonic Sweep ×6 + saw ×3 + noise → SVF LP → F2 HP · delay 1/8D, shimmer reverb, glue | 上升 Rise · 張力 Tension · 氣流 Air · 空間 Space | fx | -18.9 |
| 2 | **Gravity Well** | 重擊瞬間的金屬爆裂與向下俯衝的次低頻，餘波在巨大空間裡迴盪 | sine -1oct + VA morph -1oct + Phys plate/mallet + noise burst → Ladder 24 · tube, reverb, glue | 墜落 Drop · 爆裂 Crack · 金屬 Metal · 空間 Space | fx | -19.4 |
| 3 | **Lunar Tide** | 月光下的潮汐：浪湧緩緩堆高、碎成浪花再退去，轉動「月光」讓海浪唱出和弦 | VA morph ×3 + noise → Ladder 24 → F2 HP · reverb, glue | 浪湧 Swell · 潮速 Tide · 浪花 Foam · 月光 Moonlight | fx | -20.0 |
| 4 | **Howling Canyon** | 穿過峽谷的風：氣流隨音高呼嘯，一陣陣襲來又遠去，調變輪讓風聲更尖銳 | noise → SVF LP → F2 HP · reverb | 陣風 Gust · 呼嘯 Howl · 寒意 Chill · 峽谷 Canyon | fx | -17.7 |
| 5 | **Photon Blaster** | 復古科幻雷射槍：同步鋸齒波一路俯衝，乒乓回聲在左右來回彈射 | saw+sync ×2 +1oct + tri → Ladder 24 · delay 1/8D, reverb, glue | 俯衝 Sweep · 長度 Length · 同步 Sync · 回聲 Echo | pluck | -19.4 |
| 6 | **Numbers Station** | 來自深空的神秘短波電台：機械嗓音不停低語，夾雜靜電與失真 | saw + FM algo 1 + noise → Formant → F2 BP · bitcrush, delay 1/8, reverb | 語速 Chatter · 調頻 Warp · 靜電 Static · 失真 Crush | fx | -19.2 |
| 7 | **Data Corruption** | 資料損毀般的故障切片：和弦被切成三十二分音符的碎片、八度翻轉與位元壓碎，每一拍都在斷裂重組 | WT Digital + pulse -1oct → Ladder 12 → F2 HP · bitcrush, delay 1/16, reverb · arp chord 1/32 | 故障 Glitch · 位元 Bits · 切片 Chop · 回聲 Echo | arp | -19.4 |
| 8 | **Glass Rain** | 按住和弦，音符就化作玻璃雨滴隨機灑落，輕重不一地濺在左右聲場，漣漪在殘響裡擴散 | sine +1oct + Phys glass/mallet + noise burst → SVF HP · delay 1/8D, reverb, glue · arp random 1/32 | 雨勢 Downpour · 水滴 Drop · 水花 Splash · 空間 Space | pad | -17.7 |
| 9 | **Derelict Starship** | 漂流在深空的廢棄星艦：低沉引擎轟鳴、金屬艙壁的呻吟與緩慢掃過的相位，轉動「脈動」讓引擎重新啟動 | WT Growl ×3 + saw + FM algo 2 + noise → Ladder 24 → F2 HP · tube, phaser, delay 1/4D, reverb | 深淵 Abyss · 機械 Machine · 脈動 Pulse · 空間 Space | fx | -17.6 |
| 10 | **Stardust Nebula** | 星塵般的顆粒雲：玻璃波表碎成閃爍的微粒，在左右聲場間飄散並沒入微光殘響 | WT Glass ×5 + Phys glass/bow → SVF LP → F2 HP · ensemble, delay 1/4D, shimmer reverb | 顆粒 Grain · 演化 Evolve · 微光 Shimmer · 亮度 Bright | fx | -17.6 |

### 打擊 Drum (10)

| # | 名稱 Name | 說明 | 引擎 Engines | 巨集 Macros | Demo | LUFS |
|---|---|---|---|---|---|---|
| 1 | **Thunder Taiko** ★ | 雷鳴般的太鼓群：物理鼓皮加上低頻衝擊與大殿殘響，低音區是大太鼓、高音區是締太鼓；C2–C5 最佳。 | sine -1oct + Phys membrane/mallet + noise burst → SVF BP · drive, reverb, glue | 張力 Tension · 鼓棒 Stick · 殿堂 Hall · 餘韻 Ring | drum | -17.7 |
| 2 | **Tectonic 808** | 板塊位移般的 808 長尾大鼓：正弦波從高處俯衝落地，管式飽和讓次低音在小喇叭上也聽得見；C1–C5 都好用。 | sine + noise burst → SVF BP · tube, glue · mono | 衝擊 Punch · 尾音 Decay · 失真 Drive · 音高 Tune | bass | -18.5 |
| 3 | **Anvil Kick** | 鐵砧般結實的大鼓：鼓皮物理模型加上瞬間俯衝的正弦波與踏板敲擊聲，緊實有力、穿透混音；C1–C5 都好用。 | sine + Phys membrane/mallet + noise burst → SVF BP · drive, reverb, glue · mono | 衝擊 Punch · 鼓腔 Body · 悶音 Muffle · 房間 Room | bass | -19.4 |
| 4 | **Cobalt Snare** | 鈷藍色的清脆小鼓：鼓皮共鳴、響線沙沙與鼓腔音調層層疊加，力度越輕越像幽靈音；C2–C5 皆可，越高越像短笛小鼓。 | VA morph + Phys membrane/mallet + noise burst → SVF HP → F2 LP · drive, reverb, glue | 響線 Snares · 音高 Tune · 厚度 Fat · 空間 Space | drum | -18.5 |
| 5 | **Stadium Clap** | 整座球場一起拍手：多層噪音爆發錯落疊加，再推進明亮的房間殘響；C2–C6 都能用，高音區更清脆。 | FM algo 1 + noise burst → SVF LP → F2 HP · drive, delay, reverb, glue | 人數 Crowd · 音色 Tone · 尾音 Tail · 空間 Space | drum | -19.8 |
| 6 | **Quicksilver Hats** | 水銀般流動的腳踏鈸：往高音逐漸從閉合張開成長嘶聲；F♯2 閉合、A♯2 開放，調變輪可把鈸踩開。 | square +1oct + square +1oct + noise → SVF BP → F2 HP · drive, reverb, glue | 開合 Open · 金屬 Metal · 音色 Tone · 空間 Space | drum | -18.2 |
| 7 | **Bronze Ride** | 溫潤青銅鑄造的疊音鈸：金屬板模型的密集泛音加上沙沙的嘶聲，力度越大越有鐘心的亮音；C3–C5 最自然。 | FM algo 5 + Phys plate/mallet + noise burst → SVF HP · reverb | 鐘心 Bell · 沙沙 Sizzle · 延音 Sustain · 空間 Space | drum | -18.7 |
| 8 | **Varanasi Tabla** | 恆河畔的塔布拉鼓：鼓皮會「唱」出音高，低音區是渾厚 Bayan、高音區是清亮 Dayan；調變輪可做掌壓滑音。 | Phys membrane/mallet → Ladder 24 · drive, reverb, glue | 音高 Tune · 指法 Stroke · 共鳴 Ring · 空間 Room | drum | -17.4 |
| 9 | **Copper Cowbell** | 銅鑄般的 808 牛鈴：兩組方波交織出金屬音色與鐘體共鳴，C3–C6 皆宜；轉開回聲巨集就是 Dub 律動。 | square +1oct + square +1oct + Phys bell/mallet → SVF BP → F2 LP · tube, delay 1/8D, reverb | 音高 Tune · 敲擊 Clank · 衰減 Decay · 回聲 Echo | drum | -18.3 |
| 10 | **Sandstorm Shaker** | 沙暴中翻滾的沙鈴：一粒一粒的沙粒質感隨機閃動、左右飄移，力度越大越明亮；整個鍵盤都能用。 | noise → SVF BP → F2 HP · drive, reverb | 沙粒 Grain · 長度 Length · 音色 Tone · 空間 Space | drum | -18.6 |
