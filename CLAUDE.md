# desktop-pet（桌面小動物）

跨平台（macOS／Windows）Electron 桌面寵物。內建 26 隻：橘貓/三花貓/柴犬/柯爾鴨/倉鼠 5 隻＋十二生肖 12 隻＋台灣特有種 9 隻（石虎/藍鵲/黑熊/獼猴用使用者 IP 畫稿當參考，其餘文字生成）；上傳一張圖可請 Gemini 生成 8 格動作表匯入。多螢幕：每個螢幕一個覆蓋視窗，寵物模擬在主程序跑全域座標。
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

1. **`FRAME_NAMES` 的順序**（`renderer/shared/sprite-slicer.js`）＝ Gemini 提示詞的姿勢順序（`main/gemini.js` PROMPT）＝ 動作對應（`main/simulation.js` currentFrameName，另一份 FRAME_NAMES 也在此）＝ `pet.json` 的 frames 鍵。改任何一處要一起改，既有已匯入的寵物資料會失效。
2. **`pet.json` 與 `settings.json` schema**（`main/pets-store.js` 檔頭註解）：`userData/pets/<id>/` 與 `settings.json` 是使用者資料，改欄位要向下相容或寫遷移。`settings.counts` 取代了舊的 `currentPetId`（`readSettings` 讀到舊格式會自動轉），總數上限 `MAX_TOTAL_PETS`。
3. **IPC 通道名**：`main/preload.cjs` 白名單 ↔ `main/index.js` registerIpc ↔ 兩個 renderer。三處同步；preload 只暴露函式。overlay（drawer）：`pets:active`／`pets:changed`（拿幀圖）、`overlay:draw`（主程序每幀送本螢幕清單）、`overlay:mouse`（轉發按下/放開）、`overlay:menu`、`state:get`/`state:changed`。settings：`pets:list`/`setCount`/`delete`/`save` 等。
4. **點擊穿透邏輯**：改由主程序控制。`main/index.js` 的 sim loop 每幀用 `screen.getCursorScreenPoint()` 判斷游標是否壓在某螢幕的某寵物上，逐視窗設 `setIgnoreMouseEvents`；拖曳中全視窗關穿透以收 mouseup。renderer 不再自行切穿透。任何讓某視窗長時間不穿透的改動，會讓那個螢幕點不到桌面。
5. **切格器的兩個模式**：`keyEnclosed=false`（單張圖，只刪邊緣連通背景，保護淺色肚子）／`keyEnclosed=true`（AI 表，背景是我們指定的洋紅，可去封閉口袋）。搞反會挖穿角色或留洋紅點。改演算法先跑 `npm test`，fixture 是真實生成結果。
6. **金鑰**只經 `main/secrets.js`（safeStorage）。不進 settings.json、不進 log、不回明文給 renderer（只回尾四碼）。Gemini 呼叫金鑰走 header，不走 query string。
7. **打包設定**（package.json `build`）：`files` 白名單決定哪些東西進 app，`assets/builtin` 與 `renderer/shared` 缺一不可（main 與 renderer 都 import 後者）；`assets/sheets` 刻意排除（3 MB 原始表只給產出腳本用）。
8. **內建動物 id**：`builtin-<animal>`，`ensureBuiltinPets` 以 id 判斷已複製過就不覆蓋；改內建素材後，使用者端要刪 `userData/pets/builtin-<animal>/` 才會拿到新版。`pruneRemovedBuiltins` 會清掉 userData 裡已不再出貨的 builtin-*（升級收斂/改名用），只動 builtin-*、不碰 pet-*。

## 內建動物體型
`scripts/build-builtin.mjs` 的 `SIZES` 表決定每隻成品 PNG 高度＝`BASE_H×相對體型`（鼠 0.5、牛 1.6、熊 1.6…），螢幕上大小按真實體型；改體型改這張表重建即可，不動程式。

## 慣例
- ESM（`"type":"module"`），只有 preload 是 `.cjs`（sandbox 限制）。
- 沒有建置步驟：renderer 直接載 `.js` 模組，CSP `default-src 'self'`，不載外部資源。
- 正常運作時安靜；只有錯誤寫 `userData/logs/app.log`。
- **多螢幕架構**：模擬在 `main/simulation.js`（全域座標 actors[]、狀態機、hover/drag），`main/index.js` 跑 ~60fps loop 並每幀把「各螢幕上的寵物（本地座標＋幀名＋變形）」送給對應覆蓋視窗；`renderer/overlay/overlay.js` 只是 drawer（預載幀圖、收 `overlay:draw` 畫出、轉發滑鼠）。每個螢幕一個覆蓋視窗（`createOverlayWindows`），螢幕增減會 `buildOverlays` 重建。
- 主程序算寵物 bbox 需要幀像素大小 → `loadActivePets` 附 `sizes`（讀 PNG IHDR）。
