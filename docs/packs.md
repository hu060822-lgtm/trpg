# 規則包格式

規則包是一個 zip，裡面放幾個 JSON 檔（和選用的圖片）。整個遊戲系統（屬性、技能、角色卡的計算、擲骰按鈕、檢定方式、創角點數、規則說明）都寫在這些檔案裡，跑團工具本身不知道「力量」或「護甲等級」是什麼。

範本：`packs/simple-d20/`（CC0，最精簡，可以直接複製來改）；`packs/srd-5e/`（CC-BY-4.0，D&D 5E 基本規則，示範角色建立器、豁免和追加包能用的所有欄位）。

## 檢查與匯入

```bash
npm run admin -- check-pack packs/my-pack        # 只檢查，不匯入（資料夾或 zip 都可以）
npm run admin -- import-pack my-pack.zip         # 檢查後加進資料庫
```

網頁版也可以上傳 zip（`POST /api/packs`）。有問題時會一次列出全部，每條都寫明哪個檔案、哪個欄位、哪裡不對。

## zip 的內容

- 只認得最上層的這些檔案：`manifest.json`（必要）、`attributes.json`、`skills.json`、`sheet.json`、`actions.json`、`checks.json`（必要）、`creation.json`、`builder.json`、`glossary.json`。
- `assets/` 裡只能放圖片（png、jpg、webp、gif、svg）。
- 整個 zip 包在一個資料夾裡也可以。
- 上限：zip 5 MB、解開後 20 MB、500 個檔案。
- **不能放程式。** 所有計算都用下面的算式語言，所以別人寫的規則包可以放心匯入。
- 同一個 `id` 加同一個 `version` 只能匯入一次。要改內容就把版本號加一。

## 各檔案

| 檔案 | 內容 |
|---|---|
| `manifest.json` | `id`（小寫英數與連字號）、`name`、`version`（1.0 或 1.0.0）、`license`、選填 `author`、`attribution`（例如 CC-BY 要求的聲明）、`description` |
| `attributes.json` | `list`：每個屬性有 `id`、`name`、`min`、`max`、`default`，選填 `abbr`、`description`。`modifier`：從屬性值算調整值的公式，用 `@score` 代表屬性值，例如 5E 的 `floor((@score - 10) / 2)`；沒寫就是屬性值本身 |
| `skills.json` | `list`：`id`、`name`、`attribute`（對應哪個屬性） |
| `sheet.json` | `inputs`：玩家自己填的數字（等級、護甲加值），有 `min`、`max`、`default`。`derived`：角色卡自動算的數字，例如 `{ "id": "hp", "label": "生命值", "formula": "8 + 2 * @score.body" }`，選填 `showIf`（算出 0 時角色卡不顯示，例如不施法的職業不顯示法術豁免 DC）。`values`：由建立器的選項決定的數字（生命骰、速度），有 `default`，公式裡寫 `@<id>`。`flags`：由選項打開的開關（豁免熟練），預設 0，公式裡寫 `@flag.<id>`。`texts`：玩家自己寫的文字欄位（背景故事、個性、裝備、筆記），每個有 `id`、`label`，選填 `group`（分組標題）、`multiline`（預設 true；false 是單行）、`max`（字數上限，預設多行 4000、單行 120）、`placeholder`、`description`；沒寫 `texts` 的規則包會有「背景故事、外貌、裝備與物品、筆記」四欄 |
| `actions.json` | `list`：角色卡上的擲骰按鈕，`roll` 是命中或檢定公式，選填 `damage`、`showIf` |
| `checks.json` | 檢定怎麼擲。`die`（如 `1d20`）、選填 `advantage`（`2d20kh1`）、`disadvantage`（`2d20kl1`）；`attribute` 和 `skill` 是公式範本，`{d20}` 會換成擲的骰子，`{attr}`、`{skill}` 換成被檢定的 id；選填 `critical`、`fumble`（自然骰的數字）和 `difficulties`（難度清單）。`extra` 是其他照屬性擲的檢定，例如豁免：`{ "id": "save", "label": "豁免", "formula": "{d20} + @mod.{attr} + @flag.save_{attr} * @prof" }`，角色卡會多一排按鈕；公式裡有 `@flag.<前綴>{attr}` 時，對應的開關打開就標成熟練 |
| `creation.json` | 創角限制。`attributes.methods` 列出決定屬性的方式，玩家選一種：`{ "kind": "array", "values": [15,14,13,12,10,8] }`（每個數字用一次）、`{ "kind": "pointbuy", "budget": 27, "costs": {"8":0,…,"15":9} }`（照表扣點；`costs` 是空的就直接加總屬性值）、`{ "kind": "free" }`（只檢查上下限），每種都要有 `id`、`label`。舊寫法 `attributes.budget`＋`costs` 仍然可以用。`skills.maxRank` 是創角時技能等級上限，`skills.budget` 是技能點數上限 |
| `builder.json` | 角色建立器的步驟，見下面「角色建立器」 |
| `glossary.json` | `list`：規則說明，`id`、`title`、`text`、選填 `tags`，玩家可以在房間裡搜尋 |

id 一律用小寫英文字母開頭，只含小寫英數字與底線，最多 32 字。

## 角色建立器

`builder.json` 的 `steps` 是建立角色時一頁一頁的選擇（例如職業、背景、種族）。每一步玩家選一個選項：

```json
{ "steps": [
  { "id": "class", "label": "職業", "description": "給新手看的說明",
    "options": [
      { "id": "fighter", "name": "戰士", "description": "…", "tags": ["近戰", "新手友善"],
        "grants": {
          "values": { "hit_die": 10 },
          "flags": { "save_str": 1, "save_con": 1 },
          "ranks": { "athletics": 1 },
          "bonuses": { "str": 1 },
          "features": [ { "level": 1, "name": "二度活力", "text": "…" } ]
        },
        "choices": [
          { "id": "skills", "label": "選 2 項技能", "kind": "skills", "count": 2, "from": ["athletics", "perception"] },
          { "id": "style", "label": "戰鬥風格", "kind": "pick", "count": 1, "options": [ { "id": "defense", "name": "防禦", "text": "…" } ] }
        ] } ] } ] }
```

- `grants`：選了就拿到。`values` 設定數值、`flags` 打開開關、`ranks` 把技能提高到至少這個等級（5E 的 1 是熟練、2 是專精）、`bonuses` 加在屬性上（加完不能超過上限）、`features` 是在 `level` 級以後（看角色卡的 `level` 欄位）顯示的特性。
- `choices`：選項裡的細項，玩家要全部選完才能建立。
  - `skills`：從 `from`（沒寫就是全部技能）選 `count` 個，每個變成等級 1。已經從別的地方熟練的技能不能重複選。
  - `expertise`：從已經熟練的技能選 `count` 個，變成等級 2。
  - `bonus`：照 `patterns` 其中一種分法把加值分給 `from` 裡的屬性，例如 `[[2, 1], [1, 1, 1]]`。
  - `pick`：從 `options` 選 `count` 個，文字會放進角色卡的特性。
- 角色存的是選了什麼（`choices`、`picks`、`method`），角色卡的數字每次都照規則包重算，伺服器也會重新檢查每個選擇。
- 有 `builder.json` 的規則包，網頁版會用一步一步的建立精靈；沒有的話用單頁表單。

## 追加包

追加包只放要加的東西，`manifest.json` 寫 `"extends": "srd-5e@1.0.0"`（要擴充的規則包，必須已經匯入）：

```jsonc
// manifest.json
{ "id": "srd-plus", "name": "5E 追加背景", "version": "0.1", "license": "CC-BY-4.0", "extends": "srd-5e@1.0.0" }
// builder.json：只寫新的選項
{ "steps": [ { "id": "background", "label": "背景", "options": [ { "id": "farmer", "name": "農夫", "grants": { "ranks": { "nature": 1 } } } ] } ] }
```

匯入時會跟原本的規則包合併成一個新的規則包（`basedOn` 記著它從哪裡來），原本的不會被改：

- 有 `id` 的清單照 `id` 合併：同 id 的項目蓋掉原本的，新的 id 接在後面（步驟裡的選項也一樣）；
- 其他物件逐欄合併，沒寫的欄位保留原本的；
- `attribution` 接在原本的後面。

開房間時選合併後的新規則包就能用。

## 算式語言

公式裡可以用：

- 數字和 `+ - * /`、括號、比較（`< <= > >= == !=`，成立是 1，不成立是 0）；
- 骰子：`2d6`、`d20`、`d%`、`4d6kh3`（擲 4 顆留最高 3 顆）、`2d20kl1`（留最低 1 顆）、`roll(@level, 6)`（骰子數量用算的）；
- 函式：`floor`、`ceil`、`round`、`abs`、`min`、`max`、`if(條件, 是, 否)`；
- 角色卡的值，前面加 `@`：
  - `@score.<屬性>`：屬性值；
  - `@mod.<屬性>`：調整值；
  - `@rank.<技能>`：技能等級；
  - `@<輸入、數值或計算欄位的 id>`，例如 `@level`、`@hit_die`、`@hp`；
  - `@flag.<開關>`：建立器打開的開關，0 或 1。

計算欄位可以互相引用，但不能繞成一圈。匯入時會檢查每條公式都能解析、引用的值都存在。

上限：一條公式 500 字、一次最多 100 顆骰子、骰子最多 1000 面。

擲骰一律在伺服器上進行，紀錄裡會保留每顆骰子的結果和整條算式，例如 `1d20[14] + 體魄 2 + 近戰 1 = 17`。

## 授權

內建規則包都要寫明授權。`srd-5e` 只用 SRD 5.2（CC-BY-4.0）裡的內容，並在 `attribution` 寫上要求的聲明；文字是中文改寫與摘要，完整規則以原文為準。
