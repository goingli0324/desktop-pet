# desktop-pet（桌面小動物）

跨平台（macOS／Windows）Electron 桌面寵物。內建 26 隻：橘貓/三花貓/柴犬/可爾鴨/倉鼠 5 隻＋十二生肖 12 隻＋台灣特有種 9 隻（石虎/藍鵲/黑熊/獼猴用使用者 IP 畫稿當參考，其餘文字生成）；上傳一張圖可請 Gemini 生成 8 格動作表匯入。
計畫與決策依據：`plans/2026-09-17-desktop-pet.md`。

## 常用指令

```
npm start          # 開發啟動（也可雙擊 啟動.command）
npm test           # 切格器測試（node --test）
npm run dist:mac          # DMG → dist/（開發用，未 notarize）
npm run dist:mac:signed   # Developer ID 簽章 + notarize，帳密讀 ~/.config/desktop-pet/notarize.env
npm run dist:win   # NSIS + portable exe → dist/（在 mac 上建置）
node scripts/build-builtin.mjs [<id>...]（id 見 scripts/build-builtin.mjs 的 ANIMALS）   # 從 assets/sheets/<animal>.png 重產內建素材（原始表不進打包）
```

## 連動禁區（修改前必讀）

1. **`FRAME_NAMES` 的順序**（`renderer/shared/sprite-slicer.js`）＝ Gemini 提示詞的姿勢順序（`main/gemini.js` PROMPT）＝ 覆蓋層的動作對應（`renderer/overlay/overlay.js` currentFrame）＝ `pet.json` 的 frames 鍵。改任何一處，四處要一起改，且既有已匯入的寵物資料會失效。
2. **`pet.json` 與 `settings.json` schema**（`main/pets-store.js` 檔頭註解）：`userData/pets/<id>/` 與 `settings.json` 是使用者資料，改欄位要向下相容或寫遷移。`settings.counts` 取代了舊的 `currentPetId`（`readSettings` 讀到舊格式會自動轉），總數上限 `MAX_TOTAL_PETS`。
3. **IPC 通道名**：`main/preload.cjs` 白名單 ↔ `main/index.js` registerIpc ↔ 兩個 renderer。新增功能一律三處同步；preload 只暴露函式，不暴露 `ipcRenderer`。目前：`pets:active`／`pets:changed`（overlay 拿整組含數量）、`pets:setCount`、`pets:list`、`pets:delete`、`pets:save`。
4. **點擊穿透邏輯**：`createOverlayWindow` 預設 `setIgnoreMouseEvents(true, {forward:true})`，只有 overlay.js 的 `setIgnore(false)` 會關掉。任何讓 overlay 長時間不穿透的改動，會讓整個桌面點不到。
5. **切格器的兩個模式**：`keyEnclosed=false`（單張圖，只刪邊緣連通背景，保護淺色肚子）／`keyEnclosed=true`（AI 表，背景是我們指定的洋紅，可去封閉口袋）。搞反會挖穿角色或留洋紅點。改演算法先跑 `npm test`，fixture 是真實生成結果。
6. **金鑰**只經 `main/secrets.js`（safeStorage）。不進 settings.json、不進 log、不回明文給 renderer（只回尾四碼）。Gemini 呼叫金鑰走 header，不走 query string。
7. **打包設定**（package.json `build`）：`files` 白名單決定哪些東西進 app，`assets/builtin` 與 `renderer/shared` 缺一不可（main 與 renderer 都 import 後者）；`assets/sheets` 刻意排除（3 MB 原始表只給產出腳本用）。
8. **內建動物 id**：`builtin-<animal>`，`ensureBuiltinPets` 以 id 判斷已複製過就不覆蓋；改內建素材後，使用者端要刪 `userData/pets/builtin-<animal>/` 才會拿到新版。

## 慣例
- ESM（`"type":"module"`），只有 preload 是 `.cjs`（sandbox 限制）。
- 沒有建置步驟：renderer 直接載 `.js` 模組，CSP `default-src 'self'`，不載外部資源。
- 正常運作時安靜；只有錯誤寫 `userData/logs/app.log`。
- 覆蓋層是多實例：`actors[]` 每隻獨立狀態機，`spawn()` 要先 `enter()` 再 `clampToScreen()`（後者要靠目前幀取尺寸）。
