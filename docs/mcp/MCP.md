# Aurora MCP

## 五個創作變量

以貝多芬式「短動機可以發展為完整作品」作為產品設計視角，並非歷史人物引述。

| 變量 | AI 應關注的問題 | 實作欄位／作用 |
|---|---|---|
| 動機與發展 motive | 作品有哪些可辨識的音程與節奏？如何重複、轉變？ | intervals、durations、development、transpose；repeat/transpose/invert/augment/fragment |
| 節奏與張力 rhythm | 哪裡推進、停頓與重音？ | bpm、bars、density、rest、swing、tension |
| 和聲與音高 harmony | 調性、音域與和聲走向如何服務場景？ | root、scale、octave、progression、atonal；音效可使用非調性 |
| 力度與表情 expression | 起音、音長與力度如何產生情緒？ | start、end、articulation、humanize；seeded velocity |
| 音色與空間 timbre | 聲音的材質、明暗與距離？ | preset、brightness、attack、release、space、width；映射原生合成器參數 |

五軸是可編輯作品資料。`update_axes` 後，呼叫 `compose_music` 重新生成音符；`apply_timbre` 將音色軸套用到指定聲部。SFX recipe 有自己的包絡／自動化決策，所有五軸均會保存在作品，但不保證每個 recipe 都直接使用所有動機與和聲欄位。需要精確控制時，編輯 notes、automation 與原生參數。

## AI 接入

標準 MCP client 可以透過 stdio 或 Streamable HTTP 使用；不宣稱沒有 MCP 支援的任意模型能直接接入，也尚未逐一驗收 Claude、ChatGPT、Cursor 等第三方宿主。

stdio 範例（路徑改成你的 fork checkout；部分宿主要求在 UI 中設定）：

```json
{
  "mcpServers": {
    "aurora": {
      "command": "node",
      "args": ["C:/path/to/aurora-mcp/mcp/stdio.mjs"]
    }
  }
}
```

HTTP 範例：先 `npm run mcp:http`，在支援 URL 型 MCP 的宿主新增 `http://127.0.0.1:8788/mcp`。這只供同一台主機上的 client 使用。公開 endpoint 必須在部署後以實際網址填入，不能把 loopback 當成遠端服務。

官方 SDK 2 的 client 若需使用新版協定，使用 `versionNegotiation: { mode: 'auto' }`。本服務也保留 legacy stateless HTTP 相容模式。參考 [官方 SDK migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) 與 [Cloudflare remote MCP 指南](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)。

建議 AI 工作順序：

1. `get_capabilities`：查實際 render 模式、資源限制與是否能控制瀏覽器。
2. `get_catalog`／`get_parameter_schema`：查音色、曲目、樂句與原生單位。
3. `create_project` → `compose_music`，或 `generate_jam`／`design_sound_effect`。
4. 用五軸、`set_parameters`、`set_track` 與音色操作修訂。每次保存回傳的完整 project。
5. `validate_project` → `render_audio`。只有 `artifact-ready` 才是音訊完成；`queued` 必須遵照 renderUrl 的操作要求。
6. 保存 WAV、project JSON 與 metrics。Node 的音訊 resource 是 `aurora://artifacts/{id}/wav`。

## 功能覆蓋

公開 Cloudflare 提供 39 tools；Node loopback 另有 `browser_command`，共 40 tools。

| 網站能力 | MCP 對應 | 範圍 |
|---|---|---|
| 音色、235 原生參數、4 Macro、8 調變路由 | get_catalog/get_parameter_schema/get_preset、set_parameters/set_macros/set_track | 含全部引擎、濾波、包絡、FX；global 與 patch 分開儲存 |
| 動機作曲與多聲部 | create_project/compose_music/generate_jam、add_track/remove_track/resize_project | 最多8聲部；7 Jam風格 |
| 場景音效 | design_sound_effect | impact/whoosh/riser/downer/ambience/ui/alarm/footstep/laser；可繼續改參數 |
| 魔法調音、Morph、突變／隨機、演化 | apply_mood/morph_patch/mutate_patch/evolve_sound | 重用網站共用運算；apply_mood 回傳網站變更摘要；Morph B 可為原廠音色、任意 patch 或 seeded 🎲 隨機 B；mutate_patch `category` 對應隨機音色分類；evolve_sound `algorithm:"website"` 使用網站自動演化（`src/demo/drift.js`）輸出明確自動化 |
| 自動變形、凍結／保留 | auto_morph、freeze_sound | auto_morph 依網站餘弦週期（3–40 s）掃動 A⇄B，輸出 `params` 自動化並含引擎切換前後的 duck；freeze_sound 依 sequencer 規則（寫入取消 ramp、新 ramp 取代舊 ramp）把某拍的狀態寫回音色並移除自動化 |
| 劇院模式 | theater_program | 全部音色／單一分類／示範曲連播、seeded 洗牌、每項依完整樂句次數決定停留；`medley` 產生可渲染的連續演出（最多 8 個音色、180 秒內），含示範巨集動作與切換時的輸出淡出淡入；示範曲連播只提供節目單 |
| 示範曲、聲音導覽、音色樂句 | load_demo_song/load_tour/apply_phrase、get_song_info/get_tour_info | 6完整曲／明確節錄、段落與聲部資訊；6導覽最終或時間軸、逐步雙語說明；apply_phrase `auto` 對應 ▶ 示範樂句，`macroRides` 加入示範巨集動作 |
| Jam 面板選項 | generate_jam | variation（無盡模式下一段）、主奏音色／角色、鼓組開關、pad/bass/extra 伴奏（null 靜音），回傳網站樂理檢查 |
| 音色瀏覽器、上一個／下一個 | search_presets/step_preset、get_catalog.details | 與網站相同的分類、標籤、多字搜尋及計數；details 含標籤、樂句說明、魔法範例、和弦、音階、Jam 預設 |
| 我的音色、★收藏、匯入／匯出 JSON | manage_library/get_preset(library)、import_preset/export_preset | 使用者音色庫由 client 保存並傳入，server 不儲存；匯入使用網站 `parsePresetFile` 清理，匯出為 `aurora-preset` v1 |
| 參數說明、A/B 比較 | get_parameter_help、compare_patches | 網站雙語說明與數值格式；逐項差異加網站變更排序 |
| 復原、保留、匯入／匯出 | 回傳 immutable project、export_project；Studio history/commit/revert/import | project 為 client-owned，expectedRevision 只檢查傳入 snapshot，沒有中央協作鎖 |
| 預聽、WAV | render_audio/get_render_result | Node自動render；Cloudflare排隊後由使用者瀏覽器render |
| 當前頁面控制 | browser_command | 僅loopback、使用者啟用30分鐘、可撤銷；queued與applied/audio-running分開 |
| 即時播放、表頭、Tap tempo、鍵盤／MIDI、視覺、劇院畫面、導覽動畫 | 完整合成器頁面 | 需要瀏覽器音訊或輸入裝置，遠端 MCP 不提供；Studio與完整合成器音色／globals可往返 |

`params` 自動化事件（含 `load_tour` timeline 與 `auto_morph`）由 renderer 拆成 sequencer 的 `param` 事件；修正前這類事件通過驗證但在渲染時被略過。

## 壓力測試與名曲驗證

`node mcp/stress/run.mjs <outDir> [--cloud <local workerd /mcp>] [--production <url>]` 用公有領域曲目（貝多芬《歡樂頌》、帕海貝爾《卡農》、葛利格《山魔王的大廳》、佩措爾德《G 大調小步舞曲》；只用旋律、原創編曲）經 MCP 建立、渲染並以純正弦參考旋律檢查音高（YIN）與起音時間；另測上限拒絕、並行、吞吐、預設 watchdog 與雲端大型專案。正式站只做列工具、驗證與必被拒的渲染請求，不建立 job、不佔每日配額。結果見 [stress-famous.json](evidence/stress-famous.json) 與 [cross-runtime-canon.json](evidence/cross-runtime-canon.json)。

- Node 渲染 watchdog 預設 60 秒；`AURORA_RENDER_TIMEOUT_MS`（1000–1800000）可調。180 秒、8 聲部、48 kHz 專案實測約 172 秒，預設值會回 `RENDER_TIMEOUT`。
- Node artifact 預算預設為同目錄 100 MB／1 小時，`AURORA_ARTIFACT_BUDGET_BYTES`（60000000–10000000000）可調；一個 48 kHz／24-bit 180 秒 WAV 約 51.8 MB，預設值下一小時內第二個同規格渲染會回 `STORAGE_LIMIT`。預算計入同一目錄所有未到期 artifact，多個 process 共用目錄時沒有跨 process 鎖。
- Studio 瀏覽器渲染預算依作品長度計算（每秒音訊 3 秒，60 秒–10 分鐘），舊版固定 60 秒會讓 MCP 已接受的長篇 job 無法完成。

四個 JSON resources：`aurora://axes`、`aurora://catalog`、`aurora://parameters`、`aurora://capabilities`。Prompt：`scene_sound`。

## Render 與儲存界線

共用模型上限：180秒（含尾音）、48kHz、8 tracks、8192 events、4096 automation、1.5MB project JSON、52MB WAV。輸出立體 PCM 16/24-bit；支援16/24/44.1/48kHz。限幅至 -0.3dBFS；末尾淡出與可能截斷自然尾音會回報 warning。`loop` 使用起訖淡出，沒有保證無縫循環；RMS是renderer統計，並非LUFS。

Node：每process一次render、watchdog預設60秒（`AURORA_RENDER_TIMEOUT_MS`可調）、可取消、worker old-generation256MB；ArrayBuffer仍由輸出／作品上限限制，這不是完整process記憶體硬上限。檔案位於`renders/mcp`，1小時到期，每分鐘清理同目錄符合UUID規則的任務檔；process關閉後沒有背景清理，下一次啟動/請求再清。總budget預設100MB包含WAV與JSON（`AURORA_ARTIFACT_BUDGET_BYTES`可調）；多process共用目錄未提供跨process鎖或嚴格總額保證。API只讀目前process建立的artifact，重啟後舊artifact id不可讀。

Cloudflare：公開、匿名、無私人圖庫或OAuth。`render_audio`建立SQLite Durable Object job；瀏覽器顯式render並PUT WAV，WAV格式/長度與SHA256由server驗證，音訊內容與metrics來源仍是client，沒有證明其必定來自合成器。WAV上限32MB，超出須降低取樣率／位元深度／長度。每IP60 requests/min；AdmissionBudget全域每日（UTC）5000 requests、20 jobs、100MB預約音訊，失敗job不退回當日額度。Body讀取30秒逾時。每job1小時alarm到期刪除；UUID為未列出的公開連結，持有連結的人能取用，不適合私人素材。配額並不是整個Cloudflare帳戶的費用上限；生產發布前須確認運算模式與帳戶預算。

## 建置與發布

`tools/build-mcp-site.mjs`僅複製index/studio/LICENSE/css/src/phrases/既有capture hook；不公開.git、server、node_modules或renders。`wrangler.mcp.jsonc`使用新worker`aurora-mcp`與JOBS/BUDGET/LIMITER/ASSETS，避免覆蓋既有`aurora-synth`。

本機準備：`npm ci --ignore-scripts` → `npm run test:mcp` → `npm run build` → `npm run mcp:cloud:dev`。生產命令`npm run deploy`會寫入Cloudflare及建立Durable Object migration，必須先取得具體部署授權。不要使用上游域名的舊部署命令。

本 fork 尚未 push 實作或 deploy；既有網站仍是原静態合成器。完整無人值守遠端render需要可長期執行Node或另有運算後端，不能把瀏覽器協作版當成此目標完成。
