# Plan: 桌面小動物（desktop-pet）(2026-09-17)

## 風險級別
🟢 個人 sandbox。純本機桌面程式，不儲存任何個資；唯一對外連線是使用者自己的 Gemini 金鑰打 Gemini API。

## 目標部署環境
- 平台：macOS（Apple Silicon/Intel，DMG）＋ Windows（x64，NSIS 安裝檔與免安裝 exe）
- 帳號／專案：無雲端專案。GitHub 遠端待使用者決定（預設 goingli0324，SSH）。
- Gemini：使用者在設定頁自填金鑰，存本機 `safeStorage` 加密；開發期用 `~/.config/gemini-mcp/secrets.env` 的金鑰測試（已於 2026-09-17 實測可生圖，帳務正常）。

## 問題陳述
要一隻在桌面上跑跳、隨機移動、可被滑鼠拖拉的小動物；可切換動物，且能「上傳一張圖 → 自動變成會動的角色」。Mac 與 Windows 都要能用。

## 研究結論（2026-09-17）
1. **框架：Electron 44.4.1**（npm 當日最新）。理由：透明無框視窗 `transparent:true, frame:false`、`alwaysOnTop`、`setIgnoreMouseEvents(ignore, {forward:true})` 點擊穿透在 mac/win 皆為官方支援（electronjs.org custom-window-interactions）；`safeStorage` 加密金鑰；electron-builder 26.15.3 從 mac 直接出 DMG 與 Windows NSIS（本機無 wine，NSIS 不需 wine；若 icon 嵌入需 wine 再補）。voice-claude 已是 Electron 44 專案，慣例可直接對齊。Tauri 被否決：透明視窗在 Windows 仍有已知限制，且無既有慣例。
2. **生圖：Gemini `gemini-3.1-flash-image`**（依 [[genai-provider-policy]] 主力 Gemini；金鑰可見的圖像模型有 2.5-flash-image、3.1-flash-image、3-pro-image、nano-banana-pro-preview）。SDK `@google/genai` 2.23.0；但 app 內直接用 `fetch` 打 REST（`x-goog-api-key` header，**金鑰不走 query string**，見 clc-video-factory C-6 教訓），少一個相依。
3. **一次生成整張 sprite sheet，而非逐格分別生**。實測：文字提示 → 2×4 八姿勢一張 16:9（1376×768 JPEG，~10 秒，1.7K tokens）；以裁下的單格當參考圖 → 再生一張，角色花紋／腮紅／比例全部一致。逐格分開生會走樣（[[line-sticker-hamster-puns]] 教訓）。
4. **去背用邊緣連通泛洪，不用全域色鍵**：背景指定純洋紅 `#FF00FF`，四角取樣得背景色，從邊界往內泛洪只刪連得到邊界的背景，肚子的白／淺色不會被挖穿。Python 原型驗證通過，正式版在 renderer 用 Canvas 重寫同邏輯。
5. **切格用「2×4 先驗 ＋ 連通塊修正」混合法**：第二次實測姿勢畫太擠，第 7、8 格黏連只切出 7 塊。做法：連通塊依質心落入哪個格；同格多塊取 bbox 聯集（處理鬍鬚脫離）；一塊橫跨 >1.4 格寬則以格界切開。prompt 另加「每格留至少 15% 空邊」。
6. **輸出為 JPEG**：邊緣會有洋紅色暈。去背後對邊緣半透明像素做去汙（把洋紅分量往鄰近前景色拉），視覺上足夠。
7. aspectRatio 只接受固定清單（`2:1` 會 400），用 `16:9`。

## 採用方法與理由
### 架構
- **單一全螢幕透明覆蓋視窗**（work area 大小，`alwaysOnTop`、`skipTaskbar`、`hasShadow:false`、`visibleOnAllWorkspaces`），寵物在裡面用 Canvas 畫。不用「小視窗跟著移動」——每幀搬視窗在 Windows 會抖。
- 覆蓋視窗預設**點擊穿透**；renderer 用 `mousemove`（forward:true）判斷游標在不在寵物 bbox 上，只有壓在寵物上時 IPC 關掉穿透，離開即恢復。桌面其他地方完全不受影響。
- **設定視窗**（一般視窗，按需開啟）：動物清單、上傳圖片、生成進度、金鑰設定。
- **系統匣（tray）**：開設定、暫停／繼續、結束。寵物上按右鍵也出同樣選單。
- 多螢幕：MVP 只用主螢幕。

### 動物資料格式（`userData/pets/<id>/`）
- `pet.json`：`{ id, name, createdAt, source: 'builtin'|'ai'|'static', frames: { walk:[...], idle:[...], crouch, air, land }, scale }`
- 每格一張透明 PNG，統一縮放（同一比例、以腳底對齊）。
- 內建三隻（2026-09-17 使用者追加：貓、鼠、狗），原始表在 `assets/sheets/`，由 `scripts/build-builtin.mjs` 經正式切格器產出，**沒金鑰也能立刻玩**。

### 行為狀態機（動作隨機、路線隨機）— 2026-09-17 使用者定案：全螢幕自由漫遊
- 寵物可在主螢幕 work area 內任何位置，**無重力**。
- 狀態：`idle`（2–6 秒，idle 幀）→ 隨機抽 `walk`（隨機目標點、隨機速度，walk 幀）／`run`（同上但速度與幀率 2 倍）／`hop`（原地小跳：crouch→air→land，air 期間畫面 y 加拋物線位移，位置本身可帶隨機位移）／`sleep`（idle 幀慢速呼吸縮放，8–15 秒）。權重表集中在一個常數。
- 目標點抽樣：**走／跑只走接近水平的路線（±20°）**，水平距離至少 120px；垂直位移交給跳躍（每跳帶 −120～120px 的垂直 drift，空中沿拋物線連續位移，不是落地瞬移）。到達目標即回 `idle`。
  - 2026-09-17 使用者實看回饋：「有時是整張圖在滑不是走」。原因兩個：側面圖走垂直／斜線天生像滑行；走路幀差異偏小（柴犬相鄰幀 alpha 遮罩只差 4%）。對策即上述淺角度 ＋ 所有寵物走路加 3px 起伏（單張圖模式 6px ＋ 傾斜）。
- 面向：依水平位移方向翻轉；靜止時保留上一個方向。
- **拖拉**：mousedown 在寵物上 → `dragged`，跟著游標（air 幀）；放開 → 播一次 `land` → 回 `idle` 從放開處重新抽下一個動作。這就是「被拖拉後重新開始」。
- 每幀 `requestAnimationFrame`，用 dt 積分，不綁 fps；視窗失焦或系統休眠後 dt 上限 100ms，避免瞬移。

### 匯入流程（設定視窗）
1. 選圖（png/jpg/webp，≤ 10 MB）→ 預覽。
2. 有金鑰 → 呼叫 Gemini 生 sheet（顯示「生成中，約 10–20 秒」）→ 去背切格 → 8 格預覽 → 使用者按「採用」才存檔。
3. 生成失敗（無金鑰／逾時／配額／切不出 ≥ 6 格）→ **降級路徑**：以原圖單張去背做「程序式動畫」（走路上下彈跳＋輕微傾斜、跳躍壓扁拉伸、發呆呼吸），仍可用；畫面明講是降級並可事後重試生成。
4. 金鑰驗證失敗、網路錯誤都要有看得懂的錯誤文字，並寫 log（`userData/logs/`）。

### 檔案配置（對齊 voice-claude 慣例：ESM、`main/`＋`renderer/`、`plans/`、`啟動.command`）
```
desktop-pet/
  package.json            electron 44、electron-builder 26；scripts: start / dist:mac / dist:win
  main/index.js           app 啟動、tray、兩個視窗、IPC
  main/windows.js         createOverlayWindow / createSettingsWindow
  main/pets-store.js      pets 目錄讀寫、內建寵物複製、目前選用
  main/gemini.js          REST 呼叫、逾時、錯誤分類
  main/secrets.js         safeStorage 存取金鑰
  main/preload.js         contextBridge 暴露白名單 API
  renderer/overlay/       index.html, overlay.js（狀態機＋繪圖＋穿透切換）
  renderer/settings/      index.html, settings.js（清單／上傳／進度／金鑰）
  renderer/shared/sprite-slicer.js   去背＋切格（純 Canvas，無 native 相依）
  assets/builtin/cat/     預設橘貓 8 格 PNG ＋ pet.json
  assets/icon.png / icon.icns / icon.ico
  啟動.command            雙擊啟動（開發用）
  plans/                  本檔
  CLAUDE.md               連動禁區（骨架成形後由 project-guardrails 補）
```

## 要遵循的既有模式
- voice-claude：`"type":"module"`、`main/index.js` 入口、`啟動.command`、`plans/`。
- 全域 §七：金鑰只進 safeStorage，repo 只放 `.env.example`（本專案其實不需要 .env）。
- CSP：overlay 與 settings 頁面都設 `default-src 'self'`，不載外部資源。

## 連動禁區檢查
新專案、無既有 CLAUDE.md，無禁區可踩。Build 完成後跑 `project-guardrails` 把「pet.json schema」「IPC 通道名」「穿透切換邏輯」「電子簽章／打包設定」列為禁區。

## 驗收標準
- [ ] `npm start` 在 mac 上出現橘貓，在整個桌面隨機 idle／走／跑／原地跳，往左會翻面。
- [ ] 寵物以外的桌面區域可正常點擊（穿透生效）；壓在寵物上可拖，放開後從該處重新開始隨機動作。
- [ ] Tray 與右鍵選單：設定／暫停／結束皆可用。
- [ ] 設定視窗：可在內建貓與已匯入動物之間切換，切換即時反映到桌面。
- [ ] 上傳圖片 + 有效金鑰 → 20 秒內生成 8 格預覽 → 採用後桌面換成新動物；重啟後仍在。
- [ ] 無金鑰／金鑰錯／斷網：畫面有清楚錯誤文字，並可走降級（程序式動畫）路徑。
- [ ] `npm run dist:mac` 出 DMG（未簽章，首次開啟需右鍵開啟）；`npm run dist:win` 出 NSIS exe（在 mac 建置，Windows 端由使用者實機驗）。
- [ ] 照全域 §三輸出影響範圍清單 ＋ smoke 清單。

## 本輪 Verify 走哪幾道閘
- 閘 A 安全（web-security-reviewer）：**走**——雖是 🟢，但有「讀寫金鑰」與「上傳檔案送第三方 API」兩條路徑，全域 §七 規定新增金鑰路徑要列入安全閘。
- 閘 B UI/UX（ui-ux-deploy-reviewer）：**走**（設定視窗是使用者介面）。

## 風險與取捨
- **風格漂移**：參考圖若是照片或與模型偏好差很多的畫風，生出的 sheet 可能「同一隻但畫風變卡通」。prompt 要求「identical art style」，但不保證；列入 smoke 清單由使用者用真圖驗。
- **切格失敗率**：兩次實測一次完美、一次黏連。混合切格法應可救回多數，救不回就降級成程序式動畫，不會卡死。
- **Windows 實機未驗**：本機只有 mac。透明覆蓋視窗在 Windows 的已知風險：部分驅動下透明視窗會擋到全螢幕遊戲、DPI 縮放時座標要乘 `scaleFactor`。列 smoke 清單。
- **簽章**：`sign: null` 沒擋住 electron-builder 自動抓 keychain 裡的 Apple Development 憑證簽名（build log 有 signing 一行）。開發憑證在別台 Mac 一樣被 Gatekeeper 擋，需右鍵開啟；正式發佈要 Developer ID + notarize。Windows SmartScreen 會警告。
- **成本**：每次匯入約 1.8K tokens 一次生圖呼叫，由使用者自己的金鑰負擔。
- **動畫品質天花板**：8 格（走 4、idle 1、跳 3）是為了一張圖裝得下且切得開；要更多動作（睡、坐）需第二張 sheet，MVP 不做。

## Verify 結果（2026-09-17）
- **閘 A 安全**：無 Critical／High。M1（視窗導覽沒鎖）、M2（金鑰加密不可用時寫明文／解不開時狀態矛盾）已修；L1 fuses（保留 grantFileProtocolExtraPrivileges 預設）、L2（sender 檢查、外連白名單、savePet 驗 PNG magic 與 2 MB）、L3（>16M 像素先縮）、L4（每幀重算 hover、blur/mouseleave 結束拖拉）、L5（CSP 收緊、overlay 樣式外移）、L7（.DS_Store 略過、名稱去控制字元、log 1 MB 輪替）、I1（金鑰格式提示）皆已修。
- **閘 B UI/UX**：P0-1／P0-2（深色錯誤字與主按鈕對比）已修；P1-1～P1-7 已修（鍵盤可及、等待秒數＋spinner＋全鎖、首次啟動自動開設定＋入口提示、刪除確認說後果且不重生桌面那隻、錯誤文案指路、✕ 28px、設定視窗高度依工作區）。**未做**：P2-11 取消生成、P2-3 滑桿即時預覽（都要新 IPC，觸及禁區 #3，另開）。
- 回歸：`npm test` 4/4；CDP 拖拉流程 7 檢查點；首次啟動自動開設定；深色模式計算色值符合預期。

## Windows 簽章（2026-09-17 使用者裁決：先不要）
現況：Windows exe 未簽章，SmartScreen 會警告「其他資訊 → 仍要執行」。electron-builder 26 可在 Mac 上簽 Windows 檔，不需要 Windows 機器；卡的只有憑證，要使用者本人購買與身分驗證。日後要做時的選項（已查證，依據 electron-builder 官方 code-signing-win 文件）：
1. **Azure Trusted Signing**（建議）：約 US$10/月，SmartScreen 立即信任、無硬體 token；設定 `win.sign = { type: "azure", publisherName, endpoint, codeSigningAccountName, certificateProfileName }`，以 Azure Entra 環境變數認證。前置：Azure 付費帳號、Trusted Signing 帳戶、個人身分驗證（是否開放台灣個人申請時確認）。
2. **OV 憑證 .pfx**：Certum Open Source（約 €80/年，須 OSI 授權，repo 要補 LICENSE）或 SSL.com／Sectigo；預設 `signtool` 方法在 Mac 上用 osslsigncode 簽。SmartScreen 警告要靠下載量累積才消失。
3. **EV 憑證**：US$300–500/年，硬體 token，Mac 上走 `type: "pkcs11"`。
4. **SignPath Foundation**：開源免費，需申請審核並改成 GitHub Actions 雲端簽章。

## 多隻寵物（2026-09-18 使用者定案：混合多種、各自設數量）
- `settings.counts = { petId: n }` 取代 `currentPetId`；舊設定讀取時自動轉換；總數上限 99（`MAX_TOTAL_PETS`），超過會被 `setPetCount` 夾住。
- 覆蓋層改為 `actors[]`：每隻獨立狀態機、起手時間錯開；畫圖依腳底 y 排序（低的在前），拖著的那隻永遠最上；hover／拖拉只作用在游標下最前面那隻。
- 設定頁每張卡片一個「− 數字 ＋」，點縮圖在 0 與 1 之間切換；上方顯示總數。
- 實測：99 隻鴨 121 fps（M4 Pro）、上限夾住、拖其中一隻不影響其他隻。

## Windows 置頂被蓋（2026-09-18，使用者實機回報 → 已修）
症狀：Windows 上小動物會被其他視窗蓋住。無 Windows 機器，依 Electron 已知 issue 列三個假設，先做假設 1 給使用者驗。
**成立的是假設 1**：置頂視窗失焦後被之後啟用的視窗蓋過（electron#20933／#23614／#31536，搭配 focusable:false）。修法 `main/windows.js keepOnTop()`：失焦與每 2 秒重新 `setAlwaysOnTop(true, 'screen-saver')`（mac 用 floating）。使用者以 v0.1.4-beta.1 實測「完全不被蓋」。
