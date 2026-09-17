# 桌面小動物 Desktop Pet

一隻會在桌面上隨機走、跑、跳的小動物。可以用滑鼠拖著走，放開後從那裡重新開始。
內建橘貓、柴犬、小灰鼠、可爾鴨，以及三隻倉鼠（四腳走、站姿、活潑）；上傳一張自己的圖，就能請 Gemini 畫出 8 個動作、變成你的專屬小動物。macOS 與 Windows 都能用。

## 使用

1. 啟動後小動物會出現在桌面上，系統匣（mac 右上角／Windows 右下角）會多一個貓頭圖示。
2. 點圖示 → 「設定…」可以換動物、匯入新動物、調大小、暫停。小動物上按右鍵也有同樣的選單。
3. 匯入新動物：
   - 有 Gemini 金鑰：選一張圖 → 「用 AI 生成動作」→ 約 10–30 秒 → 看到 8 格預覽 → 「採用這隻」。
   - 沒有金鑰：「改用單張圖」，小動物會用同一張圖做上下擺動與壓扁拉伸。
4. 金鑰在 <https://aistudio.google.com/apikey> 取得，貼進設定頁「Gemini 金鑰」。金鑰加密存在本機，不會傳到 Gemini 以外的地方。

生成動作的圖片建議：單一角色、側面或四分之三側面、背景乾淨。照片也可以，但畫風可能被畫成卡通。

## 開發

```
npm install
npm start
npm test
```

打包：`npm run dist:mac`（DMG）、`npm run dist:win`（NSIS 安裝檔 + 免安裝 exe），輸出在 `dist/`。
目前未做正式簽章：mac 第一次要在 app 上按右鍵 → 打開；Windows 會出現 SmartScreen 警告，按「其他資訊 → 仍要執行」。

## 資料位置

- macOS：`~/Library/Application Support/desktop-pet/`
- Windows：`%APPDATA%\desktop-pet\`

裡面有 `pets/`（每隻一個資料夾）、`settings.json`、`gemini.key`（加密）、`logs/app.log`（只記錯誤）。

## 正式簽章（給不特定人下載時）

需要付費的 Apple Developer Program。一次性準備：

1. **Developer ID 憑證**：Xcode → Settings → Accounts → 選 KUO YIN LEE 團隊 → Manage Certificates… → 左下「+」→ Developer ID Application。
2. **App 專用密碼**：account.apple.com →「登入與安全性」→「App 專用密碼」→ 產生一組。
3. 把 Apple ID 與這組密碼填進 `~/.config/desktop-pet/notarize.env`（範本已建，`APPLE_TEAM_ID` 已填）。

之後每次發佈：

```
npm run dist:mac:signed
```

會簽章、送 Apple notarize（通常 2–10 分鐘）並自動 staple。產物一樣在 `dist/`，對方雙擊即可開，不再出現「無法驗證開發者」。
`npm run dist:mac` 仍是開發用的未 notarize 版本。Windows 目前未簽章，SmartScreen 警告照舊。
