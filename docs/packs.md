# 規則包格式

規則包是一個 zip，裡面放幾個 JSON 檔（和選用的圖片）。整個遊戲系統（屬性、技能、角色卡的計算、擲骰按鈕、檢定方式、創角點數、規則說明）都寫在這些檔案裡，跑團工具本身不知道「力量」或「護甲等級」是什麼。

範本：`packs/simple-d20/`（CC0，可以直接複製來改）。

## 檢查與匯入

```bash
npm run admin -- check-pack packs/my-pack        # 只檢查，不匯入（資料夾或 zip 都可以）
npm run admin -- import-pack my-pack.zip         # 檢查後加進資料庫
```

網頁版也可以上傳 zip（`POST /api/packs`）。有問題時會一次列出全部，每條都寫明哪個檔案、哪個欄位、哪裡不對。

## zip 的內容

- 只認得最上層的這些檔案：`manifest.json`（必要）、`attributes.json`、`skills.json`、`sheet.json`、`actions.json`、`checks.json`（必要）、`creation.json`、`glossary.json`。
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
| `sheet.json` | `inputs`：玩家自己填的數字（等級、護甲加值），有 `min`、`max`、`default`。`derived`：角色卡自動算的數字，例如 `{ "id": "hp", "label": "生命值", "formula": "8 + 2 * @score.body" }` |
| `actions.json` | `list`：角色卡上的擲骰按鈕，`roll` 是命中或檢定公式，選填 `damage` |
| `checks.json` | 檢定怎麼擲。`die`（如 `1d20`）、選填 `advantage`（`2d20kh1`）、`disadvantage`（`2d20kl1`）；`attribute` 和 `skill` 是公式範本，`{d20}` 會換成擲的骰子，`{attr}`、`{skill}` 換成被檢定的 id；選填 `critical`、`fumble`（自然骰的數字）和 `difficulties`（難度清單） |
| `creation.json` | 創角限制。`attributes.budget` 是屬性點數上限；有 `costs`（例如 5E 購點：`{"8":0,"9":1,…,"15":9}`）時照表扣點，沒有就直接加總屬性值。`skills.maxRank` 是創角時技能等級上限，`skills.budget` 是技能點數上限 |
| `glossary.json` | `list`：規則說明，`id`、`title`、`text`、選填 `tags`，玩家可以在房間裡搜尋 |

id 一律用小寫英文字母開頭，只含小寫英數字與底線，最多 32 字。

## 算式語言

公式裡可以用：

- 數字和 `+ - * /`、括號、比較（`< <= > >= == !=`，成立是 1，不成立是 0）；
- 骰子：`2d6`、`d20`、`d%`、`4d6kh3`（擲 4 顆留最高 3 顆）、`2d20kl1`（留最低 1 顆）、`roll(@level, 6)`（骰子數量用算的）；
- 函式：`floor`、`ceil`、`round`、`abs`、`min`、`max`、`if(條件, 是, 否)`；
- 角色卡的值，前面加 `@`：
  - `@score.<屬性>`：屬性值；
  - `@mod.<屬性>`：調整值；
  - `@rank.<技能>`：技能等級；
  - `@<輸入或計算欄位的 id>`，例如 `@level`、`@hp`。

計算欄位可以互相引用，但不能繞成一圈。匯入時會檢查每條公式都能解析、引用的值都存在。

上限：一條公式 500 字、一次最多 100 顆骰子、骰子最多 1000 面。

擲骰一律在伺服器上進行，紀錄裡會保留每顆骰子的結果和整條算式，例如 `1d20[14] + 體魄 2 + 近戰 1 = 17`。

## 授權

內建規則包都要寫明授權。之後加入的 5E 規則包只會用 SRD 5.2（CC-BY-4.0）裡的內容，並在 `attribution` 寫上要求的聲明。
