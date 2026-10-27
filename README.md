# FATEWEAVE 規則引擎雛形

企畫書 v0.3 第十六章第 1–5 步：Phase 0（規則驗證）與 Phase 1 的角色建立部分。

## 內容

| 路徑 | 說明 |
|---|---|
| `config/` | 可調整的規則資料：判定規則（v0.3 與 v0.2）、十項屬性、技能清單、12 種職業 |
| `src/rules/` | 規則引擎：判定、成功程度、自然骰、優劣勢、高風險標記、免擲骰／做不到 |
| `src/sim/` | 機率模擬器：逐一枚舉所有骰值，經由正式引擎計算精確機率 |
| `src/character/` | 角色建立：點數驗證、職業核心技能檢查、角色 ID、生命值 |
| `web/` | 瀏覽器試玩頁，打包成單一 HTML |
| `reports/` | 模擬器產生的成功率報告 |
| `tests/` | 自動化測試 |
| `CONFLICTS.md` | 企畫書內的規格衝突與建議 |

## 執行

需要 Node.js 20 以上。

```bash
npm install
npm test            # 執行測試
npm run typecheck   # TypeScript 型別檢查
npm run sim         # 產生 reports/sim-v0.3.md（加上 -- 0.2 產生 v0.2 報告）
npm run demo        # 在終端機建立角色並擲幾次骰
npm run build:web   # 產生 web/dist/fateweave-demo.html
```

## 設計重點

- **判定是純函式。** `resolveCheck(輸入, 骰值, 規則)` 對同樣的輸入與骰值永遠給出同樣的結果，所以伺服器可以保存骰值並重播判定。
- **骰子可以注入。** 正式擲骰用 `randomRng`（瀏覽器與 Node 都有的 `crypto` 亂數），測試用 `scriptedRng` 指定骰值。
- **模擬器不另寫一套規則。** 它把每一種骰值組合都丟進同一個 `resolveCheck`，所以模擬結果不會和遊戲實際規則不一致。
- **規則值都在設定檔裡。** 難度、上限、自然骰開關、災難是否需要高風險標記、生命值公式都能改設定檔調整，不必改程式。

## 還沒做的部分（第十六章第 6–9 步）

戰鬥與永久死亡流程、兩名玩家搶同一件唯一物品的測試、商店／委託／契約的端到端測試、伺服器（Express＋PostgreSQL）、Discord 與部署。
