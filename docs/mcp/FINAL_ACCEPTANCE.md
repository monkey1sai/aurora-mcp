# 最終本機驗收快照

2026-10-02 / Windows / Node22.22.0 / Wrangler4.133.0。上游 `aa204456bfbfff49f79322bfea4673f22d4b4de3`。GitHub fork已建立，實作尚未推送；公開MCP尚未部署。

## VERIFIED

- MCP26 tests、26 PASS、0 FAIL、0 SKIP。五軸、seed、九類SFX、100音色、六歌曲與六tours契約、七Jam、官方HTTP legacy/auto與stdio、WAV/resource/prompt、watchdog、stop/revoke、Init/null category、自訂及global Macro往返、Morph/global scope、滿額history仍可stop、DO替身TTL及quota。
- 最終相關原網站檢查54/54 PASS：modules、purity、syntax/import graph、params、magic/Morph、UI。Cloudflare最後dry-run成功，113個allowlisted實體檔案，bundle1919.71KiB/gzip378.54KiB，JOBS/BUDGET/LIMITER/ASSETS綁定齊全，沒有執行deploy。
- `npm ci --omit=dev --ignore-scripts`於獨立task-created副本安裝，HTTP啟動及health200。Node adapter為runtime dependency。
- 新版workerd官方client auto/legacy各發現27tools並建立queued。可見使用者Chrome開啟AdmissionBudget版本作品，按鈕渲染／上傳，再MCP取得artifact-ready。
- [新版下載證據](evidence/cloud-quota-whoosh.json)：108044bytes、0.75秒、24kHz、24-bit stereo。下載與MCP SHA-256相同：`31c8346f971cbb6288ef8f0daa8311776cfdbdf43a8a77b52acda14bd332e2b0`。重複PUT409。0.25秒tail不足有實際warning。
- [實際配額證據](evidence/cloud-budget.json)：當日已有7件，再接受13件後回覆DAILY_RENDER_BUDGET。這是實際SQLite DO admission，不是memoryStorage替身。
- [完整歌曲量測](evidence/full-song.json)：Neon Nights、6聲部、168.153846秒、24kHz、24-bit、24214202bytes、耗時46.625秒、量測峰值RSS223490048bytes。自然尾音不足有明確warning。
- 可見Chrome Studio→完整合成器→Studio：whoosh patch、BPM110、Master−6dB往返，返回顯示已匯入音色及globals。Init及Macro精確往返另由真實createStore測試。
- [原網站quick擴大檢查](evidence/source-tests.json)：255PASS、37warnings、1FAIL，`plain http → 403 (expected a redirect)`。仅對子程序localhost設定NO_PROXY後，[compat獨立重跑](evidence/compat-isolated.json)12/12PASS，含嚴格TLS、HTTP308及24平行請求。保留原失敗記錄；產品程式未為此改動，不將初始整套改稱全綠。
- Astra最後增量只讀審查未發現新增阻擋程式缺陷，可接受本機交付及Cloud部署候選準備。此為審查判斷，不是部署授權或公開驗收。

## 未通過與限制

- `verify-cloud.mjs` combined CLI harness曾遇Network connection lost及60秒handshake timeout，原因未定，不能標PASS。候選證據使用逐步官方client、可見Chrome、verify-artifact下載hash及verify-budget配額；combined harness不作發布gate。
- Cloud metrics為client-reported。server只驗證收到的WAV header、bytes及hash，沒有remote engine attestation。
- 最大180秒／8tracks／48kHz、32MBupload峰值記憶體、所有AI宿主與瀏覽器、無縫loop及正式主觀聽感评分未驗收。高負載可超過60秒watchdog。
- 公開端點、公開Chrome驗收、OAuth/private projects、帳號費用及無人值守遠端renderer未完成。Cloud需人操作renderUrl，Node可AI自主生成WAV。每日quota不是Cloudflare帳單硬上限。

來源以最後核對的Git snapshot及manifest為準；較早來源hash不證明遠端版本。原checkout既有3個untracked發布檔案保持原狀，新實作在獨立fork。

截圖：[Cloud本機完成](evidence/cloud-local-ready.png)。音訊：[Node Whoosh](evidence/starship-whoosh.wav)、[新版Cloud Whoosh](evidence/cloud-quota-whoosh.wav)。生成資料不含私人素材。
