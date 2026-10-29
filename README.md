# FATEWEAVE

可自定義的跑團工具。GM 開房間、選一套規則，玩家用代碼加入，在同一個地方聊天、擲骰、管理角色卡。遊戲規則寫成「規則包」（一個放 JSON 的 zip），要加新的系統或內容時匯入規則包就好，不用改程式。

目前完成三個階段：

1. 房間、聊天、`/r` 擲骰、規則包匯入與驗證、照規則包自動計算的角色卡；
2. 地圖：底圖、格線、拖放代幣、量尺、手動戰爭迷霧、即時同步，手機可以雙指縮放；
3. D&D 5E 基本規則包（SRD 5.2：12 職業、4 背景、9 種族、1–5 級特性）、一步一步的角色建立精靈（即時預覽角色卡）、豁免檢定，以及可以擴充既有規則包的追加包。

接下來是新手引導工具，最後把 FATEWEAVE 自己的規則做成規則包。

網頁版與伺服器放在 Render，資料存在 Supabase 的 PostgreSQL，玩家用名字＋密碼登入。上線步驟見 `docs/deploy.md`。

## 內容

| 路徑 | 說明 |
|---|---|
| `packs/` | 內建規則包。`simple-d20` 是最精簡的 d20 規則，也是寫規則包的範本；`srd-5e` 是 D&D 5E 基本規則（SRD 5.2，CC-BY-4.0），附角色建立器 |
| `src/pack/` | 規則包：算式與骰子語言（`expr.ts`）、格式驗證與角色卡計算（`pack.ts`）、zip 讀取（`zip.ts`） |
| `src/table/` | 房間：成員與 GM、只增不改的聊天與擲骰紀錄、角色卡（`store.ts`）；地圖、代幣與迷霧（`maps.ts`） |
| `src/server/` | 遊戲伺服器：HTTP API、帳號密碼登入、WebSocket 即時通知（見 `docs/server.md`） |
| `src/persistence/` | PostgreSQL 連線（正式用 Supabase，本機與測試用 PGlite） |
| `client/` | 網頁版（React） |
| `src/rules/`、`src/character/`、`src/combat/`、`src/sim/`、`config/` | FATEWEAVE v0.3 的規則引擎、創角、戰鬥與機率模擬。目前沒有接到伺服器，之後做 FATEWEAVE 規則包時再用 |
| `web/` | v0.3 規則測試頁，打包成單一 HTML（不連線） |
| `reports/` | 模擬器產生的成功率報告 |
| `tests/` | 自動化測試 |
| `docs/packs.md` | 規則包格式與算式語言 |
| `docs/server.md` | 伺服器 API 與權限 |
| `docs/deploy.md` | 目前的部署位置與上線步驟 |
| `docs/rules-v0.3.md`、`docs/combat-v0.3.md` | FATEWEAVE v0.3 規則與戰鬥規格 |
| `CONFLICTS.md` | 已裁決與尚待確認的規格衝突 |

## 執行

需要 Node.js 22.13 以上。

```bash
npm install
npm test            # 執行測試
npm run typecheck   # TypeScript 型別檢查
AUTH_DEV=1 npm run server   # 本機啟動伺服器（資料放在 ./data/pglite）
npm run web:dev     # 網頁版開發伺服器（先在 client/ 執行 npm install）
npm run admin       # 管理：列出、檢查、匯入規則包，發 token
npm run sim         # FATEWEAVE v0.3 機率報告
npm run build:web   # 產生 web/dist/fateweave-demo.html
```

## 設計重點

- **規則包裡沒有程式。** 所有計算都用一套很小的算式語言（數字、四則運算、骰子、少數函式、讀角色卡的值），別人寫的規則包可以放心匯入。
- **骰子只在伺服器擲。** 紀錄裡保留每顆骰子和整條算式，玩家看得到結果是怎麼來的。
- **角色卡的數字由伺服器算。** 玩家只送自己選的屬性、技能、輸入欄位和建立器的選擇（職業、背景…）；生命值、防禦這些照規則包的公式算，並附上計算過程。
- **房間紀錄只增不改。** 聊天和擲骰都帶序號，離線的人回來時讀「上次之後」發生的事；重送的請求不會說兩次或擲兩次。
- **沒有任何數值宣稱已經平衡。** 內建規則包的數字都是起點，需要實際跑團測試。
