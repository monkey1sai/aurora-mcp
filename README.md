# AURORA 極光

在瀏覽器裡執行的混合式合成器：好聽、好看、好上手，也夠深入做聲音設計。還會自己演奏、自己調音色：打開「示範中心」，聽六首多聲部示範曲、看旋鈕在音色導覽裡自己轉動、讓它即興伴奏，或把整個畫面交給劇院模式。

> **English:** AURORA 極光 is a hybrid synthesizer that runs entirely in the browser — virtual-analog, wavetable, 4-op FM and physical-modelling engines, 100 presets, 6 demo songs, sound tours, a generative jam mode and a theater mode. Zero npm dependencies, no audio samples: every sound is synthesized live in an AudioWorklet. Built with [Claude Code](https://claude.com/claude-code).
>
> **Try it:** https://aurora.pixbvr.com · **Run locally:** Node 20+, then `npm start` and open http://localhost:5173 (click once to start audio). **Keys:** A–K play, Z / X octave, Esc Esc panic.

## Features 功能總覽

### 合成器 Synth

- **聲源 Sources**：兩組 VA／Wavetable 振盪器（PolyBLEP、mipmap 波表、Unison 齊奏）、4-op FM、物理模型（弦、木琴、鐘、玻璃、鼓皮、金屬板）、噪音
- **濾波 Filter**：ZDF Ladder 24/12、SVF、母音 Formant、Comb，再串一個 SVF
- **調變 Mod**：3 組 ADSR、2 組 LFO、8 槽調變矩陣、4 個巨集 Macro
- **效果 FX**：Drive → Chorus/Ensemble → Phaser → Delay → FDN Reverb（含 Shimmer）→ EQ → Glue 壓縮 → 透明限幅器
- **演奏 Perform**：琶音器、和弦記憶、音階鎖定
- **100 個出廠音色**：鍵盤、鋪底、貝斯、主奏、撥弦、鐘琴、弦樂／管樂、琶音／律動、音效／質感、打擊，每類 10 個。每個音色都有 4 個巨集和自己的示範樂句，響度對齊在約 −19 LUFS（見 [`docs/PRESETS.md`](docs/PRESETS.md)）
- **介面**：極光主視覺（WebGL2，會隨每個音符升起光柱）、示波器、頻譜、濾波響應曲線；復原／重做、儲存使用者音色、匯出／匯入 JSON、隨機與突變；中文／English 介面切換；手機版會改成精簡的演奏版面

### ▶ 示範 Demo

上方的 **▶ 示範** 用目前音色的示範樂句自動演奏，演奏時 4 個巨集旋鈕會跟著轉動（音色的 `demoMacros`，沒有的話就自動起伏），結束後巨集會回到原來的位置。

### 示範中心 Demo Center

點上方的 **示範中心** 開啟。底下的琴鍵保持可彈，而且同一時間只會有一個來源在播放：開始播示範曲、導覽、即興、劇院或 ▶ 示範時，前一個會自動停止。關掉示範中心不會停止播放，畫面角落會出現「正在播放」小膠囊，可以回到播放畫面或直接停止。

| 分頁 | 內容 |
|---|---|
| **示範曲 Songs** | 六首多聲部示範曲（見下表）。每個聲部都是一個出廠音色，可以看音符在琴卷上流動、段落時間軸與各聲部音量表；每個聲部可以靜音或獨奏，也可以按「用這個音色彈」直接把音色載入你的合成器。按 **一起彈** 會把鍵盤鎖定在歌曲的調性，隨便彈都和諧。 |
| **音色導覽 Sound Tours** | 六段自動調音導覽（約 1–2 分鐘）：示範中心會收起，字幕逐字出現，旋鈕自己轉動並亮起光圈，一步步做出經典音色。可以暫停、跳下一步、重來；結束時可以 **保留這個音色**（算一步復原）或 **還原**。 |
| **自動演奏 Jam** | 用你目前的音色即興：七種風格（氛圍、低傳真、合成器浪潮、浩室、電影感、東方五聲、8-bit），可以選調性、音階、速度、強度、8／16 小節，以及你的音色擔任旋律、和弦或貝斯。伴奏樂團（鼓組、貝斯、和弦、額外聲部）可以各自開關、換音色。**新點子** 換一段新的變奏，**無限** 會一直生成下一段；主奏的巨集也會自動轉動。換音色或改設定後，會在下一段套用。 |
| **魔法調音 Magic** | **魔法調音**：16 種「感覺」一鍵調整（更明亮、更溫暖、更空靈、更復古…），也可以直接打字描述，例如「溫暖一點，再寬一點」；每次調整算一步復原，可 A/B 比較或還原。**自動演化**：音色在設定的幅度與速度內緩緩漂移，可以凍結或停止。**A/B 音色變形**：選兩個音色，拖動滑桿在它們之間平滑變形，也可以自動來回；滿意就保留。 |
| **劇院模式 Theater** | 全螢幕極光視覺加大字幕，自動輪播全部音色、單一類別或示範曲（每個約 20–30 秒），字幕會顯示正在轉動的巨集。 |

**示範曲 Demo songs**

| 曲目 | 風格 | 調性・速度 | 長度 |
|---|---|---|---|
| 極光之夢 Aurora Dreams | 氛圍音樂 | D 大調・88 BPM | 2:32 |
| 霓虹夜色 Neon Nights | 合成器浪潮 | A 小調・104 BPM | 2:46 |
| 雨天 Lo-fi Lo-fi Rain | Lo-fi 嘻哈 | A 小調五聲・80 BPM | 2:18 |
| 水晶洞窟 Crystal Caves | 電影配樂 | E 小調・100 BPM | 2:14 |
| 脈動城市 Pulse City | 浩室舞曲 | F 小調・124 BPM | 2:19 |
| 絲路 Silk Road | 東方五聲音階 | D 宮調・90 BPM | 2:02 |

**音色導覽 Sound Tours**：打造 Supersaw 鋪底、FM 電鋼琴誕生、一根弦的旅程、酸性貝斯 Acid、空間魔法、從 Init 到史詩主奏。

示範曲播放時，你的合成器會跟著歌曲的速度（琶音器、同步 LFO 與延遲都會對拍），停止後恢復原本的速度。所有聲音加總後會經過一個安全限幅器（上限 −0.3 dBFS）。

- 歌曲格式、混音工具與作曲規則：[`docs/SONGS.md`](docs/SONGS.md)
- 導覽格式：`src/demo/tours/index.js` 開頭的註解

## Quick start 快速開始

需要 Node 20 以上（已在 Node 26 測試）與新版 Chrome／Edge／Safari／Firefox。**不需要 `npm install`。**

```bash
npm start            # → http://localhost:5173
```

打開網址後點一下頁面即可啟用音訊（瀏覽器的自動播放限制）。瀏覽器只在「安全連線」下提供 AudioWorklet（也就是發聲引擎）：網址必須是 `http://localhost` 或 `https://`。直接開 `file://`，或用 `http://192.168.x.x` 這種區網 IP 開啟，都只會有畫面、不會有聲音。

- 換埠號：`PORT=8080 npm start`
- 在手機或平板上玩：`npm run lan`（見下一節）
- 各個元件的獨立展示頁：`/docs/components-demo.html`、`/docs/visuals-demo.html`、`/docs/jam-demo.html`、`/docs/magic-demo.html`

### 在手機或平板上使用 Phone & tablet

手機必須用 **https** 連到電腦，否則沒有聲音（`HOST=0.0.0.0 npm start` 的 `http://IP` 在手機上是無聲模式，畫面會提醒你）。三種做法：

1. **區網 https（最簡單）**：手機和電腦連同一個 Wi-Fi，在電腦上執行

   ```bash
   npm run lan          # → https://192.168.x.x:5173/（終端機會列出電腦的區網網址）
   ```

   第一次會自動產生自簽憑證（存在 `.cert/`，不會被伺服器公開）。手機開啟網址時會看到「連線不是私人連線」的警告，這是自簽憑證的正常現象，只需接受一次：iPhone／iPad 的 Safari 點「顯示詳細資訊」→「瀏覽此網站」；Android 的 Chrome 點「進階」→「繼續前往」。手機上直接輸入 `192.168.x.x:5173`（沒打 https）也會自動轉到 https。只想在本機用 https：`HTTPS=1 npm start`。
2. **不想看到警告：用 [mkcert](https://github.com/FiloSottile/mkcert)**

   ```bash
   mkcert -install
   mkcert -cert-file .cert/cert.pem -key-file .cert/key.pem localhost 127.0.0.1 192.168.x.x   # 換成電腦的區網 IP
   npm run lan          # 有 .cert/cert.pem + key.pem 時會優先使用
   ```

   再把 `mkcert -CAROOT` 資料夾裡的 `rootCA.pem` 裝到手機並信任：iPhone／iPad 用 AirDrop 傳過去 →「設定」→「一般」→「VPN 與裝置管理」安裝描述檔 →「設定」→「一般」→「關於本機」→「憑證信任設定」打開完整信任；Android 在「設定」→「安全性」→「加密與憑證」→「安裝憑證」→「CA 憑證」。也可以用 `CERT_FILE`、`KEY_FILE` 指定其他憑證路徑。
3. **不在同一個網路**：用通道服務，例如安裝 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) 後執行 `cloudflared tunnel --url http://localhost:5173`，它會給你一個 `https://….trycloudflare.com` 網址；或把整個資料夾放到任何 https 靜態網站（GitHub Pages、Netlify、Cloudflare Pages；不需要建置步驟）。

手機上的小提醒：iPhone 的靜音開關開著也能發聲；播放示範曲、即興、導覽或劇院模式時螢幕不會自動關閉；接電話或切到別的 App 後回來，點一下畫面上的「聲音已暫停 — 點一下恢復」即可繼續。Safari（含所有 iPhone／iPad 瀏覽器）沒有 Web MIDI；iPhone 不支援全螢幕按鈕，劇院模式會自動隱藏它。

## Controls 操作與快捷鍵

| 輸入 | 操作 |
|---|---|
| 電腦鍵盤（Ableton 配置） | `A W S E D F T G Y H U J K O L P ; '` = C 到高八度的 F（一個半八度）；`Z`／`X` 降／升八度；`C`／`V` 降／升力度 |
| 螢幕鍵盤（滑鼠／觸控） | 點得越靠琴鍵下緣力度越大；按住拖曳可以滑奏；支援多點觸控 |
| MIDI（Web MIDI） | 音符、力度、CC1 調變輪、CC64 延音踏板、彎音輪、觸後（aftertouch）。第一次請按上方的 MIDI 按鈕（或 ⋯ 選單的「連接 MIDI 裝置」），瀏覽器會詢問權限；允許之後，下次開啟就會自動連線。需要 Chrome、Edge 或 Firefox（Safari／iOS 不支援） |
| 旋鈕 | 上下拖曳；按住 `Shift` 微調；雙擊回到預設值；也可以用滾輪或方向鍵。外圈的亮弧是調變／巨集的範圍 |

| 快捷鍵 | 作用 |
|---|---|
| `Space` | 播放／停止 ▶ 示範；有示範曲、即興或魔法試聽在播放時改成停止它；導覽進行中則是暫停／繼續 |
| `←` `→` | 上一個／下一個音色 |
| `/` | 搜尋音色 |
| `?` | 快捷鍵說明 |
| `⌘/Ctrl Z`、`⇧⌘/Ctrl Z`（或 `Ctrl Y`） | 復原、重做 |
| `⌘/Ctrl S` | 儲存音色 |
| `Esc` `Esc` | 全部靜音（Panic）：停止所有播放並放開所有音符 |
| 示範中心裡 | `Space` 播放／停止目前分頁的示範曲或即興；`←` `→` 切換分頁（焦點在分頁列上時）；`Esc` 關閉 |
| 劇院模式裡 | `←` `→` 切換、`Space` 暫停、`F` 全螢幕、`Esc` 離開 |

## Tests 測試

```bash
npm test                          # 完整測試（平行執行，M 系列 Mac 約 1–2 分鐘）
node tools/test.mjs --quick       # 快速版（示範曲只渲染前 8 小節）
node tools/test.mjs --full        # 所有音高、更多隨機參數
node tools/test.mjs --only engines,filters,fx
node tools/test.mjs --only songs  # 示範曲、Ensemble 與 worklet 的歌曲訊息
node tools/test.mjs --only magic  # 魔法調音、A/B 變形、自動演化
node tools/test.mjs --preset "Aurora Pad" --only presets
node tools/test.mjs --json report.json
```

測試項目：

- **tools**：分析工具的自我檢查，包括 FFT、BS.1770 響度基準值、真峰值、WAV／PNG 編解碼和示範樂句格式
- **modules / purity / syntax / params**：模組匯入、DSP 純度（不可用 `Math.random`、瀏覽器或 Node 全域物件）、import 路徑與 `index.html` 參照、參數表一致性
- **engines**：每個引擎的所有模式 × 極端參數 × 44.1／48／96 kHz × 音高 24–108，另外量測音準、混疊與 CPU
- **filters**：掃頻、快速調變、自激振盪，並比對 UI 曲線和實測響應
- **fx**：全部效果開啟並推到極端值、回授失控檢查、尾音與 CPU
- **synth**：API、延音踏板、Panic、Sequencer、偷聲部、壓力測試、隨機 patch 模糊測試，以及 audio path 的記憶體配置
- **presets**：每個出廠音色用它的 demo 樂句（含巨集轉動）渲染，檢查：沒有 NaN/Inf、峰值 ≤ 1.0、|DC| < 0.01、所有音符放開後會回到靜音（< −80 dBFS）、聲部都有釋放、巨集推到兩端也安全；並以 8 聲部和弦量測即時倍率（低於 2× 即時就算失敗）
- **worklet**：用 shim 在 Node 裡執行 `AudioWorkletProcessor`
- **songs**：六首示範曲的響度與峰值、各聲部取樣同步、無縫接續、聲部池、停止與 Panic、安全限幅器、audio path 記憶體配置，以及 worklet 的歌曲訊息
- **magic**：魔法調音（16 種感覺 × 100 個音色 × 不同強度與重複套用都安全、有聲音、音量有界）、文字描述解析、音色狀態的暫時修改／動畫／保留／還原／復原，以及 A/B 變形與自動演化的範圍
- **compat**：平台相容性：https 開發伺服器（自簽憑證、同一個埠號的 http→https 轉址、憑證快取）、安全連線檢查、iPhone 靜音開關、MIDI 不會自動跳出權限詢問、螢幕保持開啟、全螢幕、48 kHz 取樣率上限、損壞的已儲存資料，以及 DSP 在 16／22.05／192 kHz 下都乾淨（`--full` 時測全部音色）

只要有任何 FAIL，結束代碼就是 1。缺少或無法載入的模組會列為 FAIL，其餘測試照常進行。

## Render 離線渲染

**音色**

```bash
node tools/render.mjs --list                                   # 列出所有音色
node tools/render.mjs --preset "Aurora Pad"                    # 用音色預設的 demo 樂句
node tools/render.mjs --preset "Aurora Pad" --phrase keys,pad  # 指定一或多個樂句
node tools/render.mjs --preset "Deep Bass" --params '{"filter.cutoff":800}' --macros 0.5,,1
node tools/render.mjs --phrase single --note 36 --preset "Deep Bass"
node tools/render.mjs --all [--category pad] [--jobs 8]        # 全部音色，平行渲染
node tools/render.mjs --patch my-patch.json                    # 渲染匯出的 JSON patch
node tools/render.mjs --preset "Aurora Pad" --json             # 只輸出 metrics JSON
```

輸出位置是 `renders/<slug>/`：

- `<slug>-<phrase>.wav`：24-bit WAV
- `-spectrogram.png`：對數頻率 20 Hz–20 kHz 的頻譜圖（inferno 色表）
- `-waveform.png`：波形圖
- `.json`：量測數據，包括峰值、真峰值、LUFS、Crest、DC、頻譜重心、低中高頻能量、16 kHz 以上能量、立體聲相關度與寬度、起音時間、T60、尾音、底噪、即時倍率

每次渲染完都會更新 `renders/index.html`，可以在 <http://localhost:5173/renders/> 瀏覽、試聽和比較所有渲染結果。其他選項：`--sr`、`--bits 16|24|32`、`--bpm`、`--transpose`、`--tail`、`--colormap inferno|magma|aurora`、`--no-png`、`--seed`。

示範樂句定義在 `tools/phrases.mjs`，UI 的 ▶ 示範也共用這些樂句：`keys`、`pad`、`bass`、`lead`、`pluck`、`bell`、`arp`、`fx`、`drum`、`strings`、`scale`、`single`。

**示範曲與即興**（和瀏覽器裡播放的完全相同：每個聲部都經過 Ensemble 與安全限幅器）

```bash
node tools/render-song.mjs --list
node tools/render-song.mjs --song neon-nights                  # 混音、各聲部響度／峰值／CPU、各段落響度
node tools/render-song.mjs --song silk-road --solo Guzheng     # 只聽一個聲部（或 --parts a,b）
node tools/render-song.mjs --song crystal-caves --stems        # 另外輸出每個聲部的分軌
node tools/render-song.mjs --all                               # 六首全部 → renders/songs/
node tools/render-jam.mjs --style lofi --seed 7 --lead "Moonlit Suitcase"
node tools/render-jam.mjs --all                                # 每種風格 × 幾個主奏音色，含樂理與混音檢查
node tools/render-jam.mjs --test                               # 決定性與樂理檢查（不產生音訊）
```

其他選項：`--loops N`、`--beats N`（只渲染前 N 拍）、`--tail S`、`--sr`、`--bits`、`--no-png`、`--json`。寫新歌前請先讀 [`docs/SONGS.md`](docs/SONGS.md)。

## Architecture 架構

完整規格與模組介面請看 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；音色設計筆記在 [`docs/SOUND_DESIGN_NOTES.md`](docs/SOUND_DESIGN_NOTES.md)。

```
index.html, css/            介面外殼與樣式（Aurora 設計系統；demo*.css、jam.css 是示範中心）
src/ui/                     元件、鍵盤／MIDI、視覺化、音訊橋接（AudioWorkletNode）、瀏覽器相容性（compat.js）
src/ui/demo/                示範中心：示範曲、音色導覽、即興、魔法調音、劇院模式
src/demo/                   示範曲（songs/）、導覽（tours/）、即興產生器、魔法調音的配方
src/worklet/processor.js    AudioWorkletProcessor：你的合成器 + 示範曲的 Ensemble + 安全限幅器
src/dsp/params.js           參數表：DSP 與 UI 共用的唯一介面
src/dsp/synth.js …          聲部、調變、演奏層、Sequencer、效果、限幅器
src/dsp/ensemble.js         多聲部歌曲引擎（每個聲部是一個完整的 Synth，取樣同步）
src/dsp/engines/, fx/       振盪器、FM、物理模型、噪音；各種效果
src/presets/                出廠音色（每個都有 4 個巨集與 demo 樂句）
tools/                      serve（含 https／區網模式與自簽憑證 selfsigned）、render、render-song、render-jam、analyze、test、wav／png 編碼器、phrases
tools/video/, docs/video/    宣傳影片的錄製工具（無頭 Chrome 錄製真實 App）、動態字幕與分鏡
```

## License 授權

[MIT](LICENSE) © 2026 pixbvr。這個專案由 [Claude Code](https://claude.com/claude-code) 打造。
