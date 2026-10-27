# FATEWEAVE 規則引擎雛形

企畫書 v0.3 第十六章第 1–7 步：Phase 0（規則驗證）、Phase 1 的角色建立、Phase 2（戰鬥、傷勢、瀕死與永久死亡），以及 Phase 3（共享世界與多人互動）。

## 內容

| 路徑 | 說明 |
|---|---|
| `config/` | 可調整的規則資料：判定規則（v0.3 正式版、v0.2 歷史比較版）、十項屬性、技能清單、12 種職業、創角範例 |
| `src/rules/` | 規則引擎：判定、成功程度、自然骰、優劣勢、高風險標記、免擲骰／做不到 |
| `src/sim/` | 機率模擬器：逐一枚舉所有骰值，經由正式引擎計算精確機率 |
| `src/character/` | 角色建立：點數驗證、職業核心技能檢查、角色 ID、生命值 |
| `src/combat/` | 戰鬥引擎：先攻、行動點、距離、攻防、傷害、瀕死、救援、死亡、逾時；以及模擬用的簡單 AI |
| `src/world/` | 世界引擎：地點、NPC、唯一物品、場景時鐘、世界歷史與稽核、GM 權限、PvP 合法性、殘影、偷竊；以及依身分過濾的世界檢視 |
| `src/persistence/` | 原型資料庫（SQLite）：角色、戰鬥狀態、戰鬥事件、死亡紀錄、世界狀態（每個實體一列並帶版本號）、世界歷史 |
| `web/` | 瀏覽器試玩頁，打包成單一 HTML |
| `reports/` | 模擬器產生的成功率報告 |
| `tests/` | 自動化測試 |
| `docs/rules-v0.3.md` | 正式規則規格（判定、角色建立、技能） |
| `docs/combat-v0.3.md` | 戰鬥規格（Phase 2，數值暫定） |
| `docs/world-v0.3.md` | 共享世界與 PvP 規格（Phase 3，數值暫定） |
| `docs/plan-v0.3-revisions.md` | 企畫書需要修改的段落與替換文字 |
| `CONFLICTS.md` | 已裁決與尚待確認的規格衝突 |

## 執行

需要 Node.js 22.13 以上（使用內建的 `node:sqlite`）。

```bash
npm install
npm test            # 執行測試
npm run typecheck   # TypeScript 型別檢查
npm run sim         # 產生 reports/sim-v0.3.md（加上 -- 0.2 產生 v0.2 報告）
npm run sim:combat  # 戰鬥模擬，產生 reports/combat-sim-v0.3.md
npm run demo        # 在終端機建立角色並擲幾次骰
npm run build:web   # 產生 web/dist/fateweave-demo.html
```

## 設計重點

- **判定是純函式。** `resolveCheck(輸入, 骰值, 規則)` 對同樣的輸入與骰值永遠給出同樣的結果，所以伺服器可以保存骰值並重播判定。
- **骰子可以注入。** 正式擲骰用 `randomRng`（瀏覽器與 Node 都有的 `crypto` 亂數），測試用 `scriptedRng` 指定骰值。
- **模擬器不另寫一套規則。** 它把每一種骰值組合都丟進同一個 `resolveCheck`，所以模擬結果不會和遊戲實際規則不一致。
- **規則值都在設定檔裡。** 難度、上限、自然骰開關、災難是否需要高風險標記、生命值公式都能改設定檔調整，不必改程式。
- **正式遊戲只能用 v0.3。** v0.2 標為 `historical`，建立角色和正式擲骰遇到它會直接拒絕；模擬器可以用 `getRules('0.2', { allowHistorical: true })` 載入做比較。
- **沒有任何數值宣稱已經平衡。** HP 公式是原型暫定值，職業與判定數值都需要實際測試。

- **世界狀態只靠伺服器過濾。** 玩家拿到的資料一律經過 `viewFor` 與 `historyFor`，GM 備註、未發現的隱藏物品、別人的背包和不在場的紀錄根本不會送出去。
- **唯一物品只有一列。** 拿取、交易、偷竊都只更新同一列的持有者；資料庫禁止刪除物品、禁止復活已死 NPC、禁止修改或刪除世界歷史。

## 還沒做的部分（第十六章第 8–9 步）

商店／委託／契約（Phase 4）、伺服器（Express＋PostgreSQL）、Discord 與部署。
