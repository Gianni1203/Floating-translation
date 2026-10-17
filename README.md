# Pencil 論文閱讀器

在 iPad 上用 Apple Pencil 讀英文論文：

- **懸停**：筆尖停在單字上，顯示中文（離線字典，免費、免網路）
- **筆尖點一下**：翻譯整句（Claude API），可再按「解釋這句」
- **手指**：照常捲動；兩指捏合可縮放
- 字典查不到的術語（例如 beamforming）會自動依上下文問 Claude
- 翻過的句子會快取，同一句不會重複花費
- 會記住上次開的 PDF 和閱讀位置

## 部署到 GitHub Pages

1. 在 GitHub 建立新的 repository，例如 `paper-reader`（Public）。
2. 把這個資料夾裡的所有檔案上傳到 repository 根目錄（`index.html` 要在最外層）。
   網頁上傳：repository 頁面 → Add file → Upload files → 把整個資料夾內容拖進去 → Commit。
3. Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾 `/ (root)` → Save。
4. 約 1 分鐘後網址會是 `https://<你的帳號>.github.io/paper-reader/`。

API key 不在程式碼裡，repository 公開也不會外洩。

## 在 iPad 上使用

1. 用 Safari 開啟上面的網址。
2. 分享按鈕 → 加入主畫面，之後從主畫面開，會是全螢幕。
3. 第一次開啟：按「設定」填入 Claude API key → 按「測試連線」確認成功。
   （主畫面的 App 和 Safari 的儲存空間是分開的，在哪邊用就在哪邊填。）
4. 按「開啟 PDF」，從「檔案」選論文。

## 建議

- 在 Claude Console 設定每月花費上限，避免意外。
- 設定裡可以調整「停留多久才翻譯單字」與是否顯示藍色筆尖小圈。
- 掃描版 PDF 沒有文字層，無法查詢（大部分 IEEE、arXiv 論文沒問題）。

## 檔案說明

- `index.html`、`styles.css`、`app.js`：閱讀器本體
- `vendor/`：PDF.js 4.10.38（Apache-2.0）
- `dict/ecdict-tw.json`：由 ECDICT（MIT）篩選約 5.8 萬常用詞，以 OpenCC 轉台灣繁體
