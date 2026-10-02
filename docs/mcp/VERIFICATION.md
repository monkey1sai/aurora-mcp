# 本機驗收記錄

**最新快照**：MCP26/26通過、production dependencies乾淨安裝HTTP200；新增配額版workerd已完成官方client→Chrome→artifact-ready→下載SHA-256→不可覆寫409，且實際每日20件quota拒絕已驗證。詳細結果及未通過項目見[最終驗收](FINAL_ACCEPTANCE.md)。以下較早量測留作歷史支持，不作當前測試總數、source hash或發布狀態依據。

日期：2026-10-02（Asia/Taipei）。環境：Windows、Node22.22.0、Wrangler4.133.0；上游基線aa204456。

## 已觀測證據

- Fork已建立：https://github.com/monkey1sai/aurora-mcp；實作尚未推送。
- 官方SDKHTTP legacy/auto及stdio：tool discovery、創作、參數修改、實際WAV、resource及prompt通過。
- 可見使用者Chrome、Node loopback8788：whoosh生成與播放啟動，實際下載`starship-whoosh.wav`，576044bytes、4秒、24kHz、24bit stereo。
- 可見Chrome、Cloudflare本機workerd8789：MCP建立queued job，使用者按鈕render並PUT，官方SDK查回artifact-ready，下載`cloud-whoosh.wav`108044bytes、0.75秒、24kHz、24bit stereo。
- Cloudflare回報hash與下載檔案hash相同：`31c8346f971cbb6288ef8f0daa8311776cfdbdf43a8a77b52acda14bd332e2b0`。tail warning為實際回報，不算失敗：0.25秒尾音需要淡出。
- 四個原審查findings及停止舊批次競態已修正；新增純記憶體來源函式／DO替身回歸5項通過，涵蓋delayed poll撤銷、decode停止、TTL房間回收、批次stop及16bit/immutable/到期upload。
- 最終當前來源MCP全套24項pass、0fail；既有source51項pass、dist42項pass。Wrangler fork cwd dry-run成功，bundle1919.55KiB/gzip378.51KiB，實體allowlist113files；未執行deploy。
- 完整`Aurora Dreams`6聲部Node render成功：154.727272727秒、24000Hz、24bit stereo、22280774bytes、約40093.5ms。自然尾音不足有明確TAIL_FADED_AT_BUDGET warning。
- 可見Chrome改48kHz後WAV快取失效，重新生成回報48000Hz/36000frames；完整合成器whoosh音色及globals往返成功。
- 可見Chrome loopback8790主動啟用room；官方SDK browser_command從queued到頁面顯示播放並套用AI room control acceptance；停用後顯示播放已停止，原room查詢BROWSER_OFFLINE。
- Astra獨立唯讀delta review在修正後未找到新增具體P0/P1/P2，這是審查判斷，不是production批准。
- 審查後來源hash：cloud-worker `8ACC4EAE5918C4CA4BEF90FA60CC435ED90E200246C6262467D568C1610106AF`；rooms `9124F1D61E092EBF3818630B84C65E7E2CF2BFC082E33E64B8FB1AFB1E0D2138`；studio `EDEF3102591741AA4A8353816DECC5E7827B21080B8DE3275C2DB68396D577AE`。

## 證據界線

測試音訊為本次生成、不含私人素材。Chrome可見頁面及下載證據為本機可用性；沒有進行正式主觀聽感評分，也沒有真實公開MCP站驗收。Node/DO測試替身不等同production alarm與memory峰值證據。最大180秒8聲部及32MB雲端上傳記憶體未實測。

未逐一驗證所有AI宿主、OAuth/private projects、公開無人值守render、production Durable Object費用。發布與遠端驗收尚未執行。

AdmissionBudget、body timeout、cloud／creation quota tests由本次主控apply_patch新增。工作期間亦讀到未列在較早摘要的同範圍lifecycle／Studio改動，作者未由摘要證明；已保留並納入獨立審查及當前回歸。不能推定仍有背景寫入；發布以最後核對的Git snapshot為準。

截圖：[Cloudflare本機完成頁面](evidence/cloud-local.png)。音訊：[Node生成](evidence/starship-whoosh.wav)、[Cloudflare協作生成](evidence/cloud-whoosh.wav)。
