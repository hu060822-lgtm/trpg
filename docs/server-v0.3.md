# 遊戲伺服器 v0.3（原型）

HTTP API，讓 Discord 機器人（以及之後的 React 前端）讀取和操作同一個世界。程式在 `src/server/`，測試在 `tests/server.test.ts`。

## 執行

```bash
npm run admin -- create-world --gm discord:<主GM的Discord ID>=main     # 建立世界（預設用 config/world-seed.json）
npm run admin -- issue-service-token "discord bot"                      # 機器人用的 token，只會顯示一次
npm run admin -- issue-token discord:<玩家ID>                            # 玩家自己要直接呼叫 API 時才需要
npm run server                                                          # 預設 :3000，資料庫 ./data/fateweave.db
```

環境變數：
- `DATABASE_PATH`：SQLite 檔案位置；
- `PORT`：監聽的埠號。

部署到 Render 用 `render.yaml`。資料庫放在持久磁碟 `/var/data`，所以需要付費方案（免費方案沒有磁碟，重啟就會清空）。

## 身分與權限

- 所有 `/api` 請求都要帶 `Authorization: Bearer <token>`。資料庫只存 token 的雜湊值。
- 使用者 ID 用 `discord:<Discord 使用者 ID>`，角色的擁有者也是這個 ID。
- **服務 token**（給 Discord 機器人用）：
  - 可以用 `X-Act-As: discord:<ID>` 代替某位使用者操作；
  - 可以讀取原始事件推播。
  - 一般使用者 token 不能做這兩件事。
- **GM 權限只看世界的 GM 授權表**。請求可以帶 `as: "gm"`，但沒有授權時拿到的資料和玩家一樣，GM 指令會被拒絕。
- `system` 身分只有伺服器內部排程能用，任何請求都不能宣稱。

## API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/health` | 健康檢查（不用 token） |
| GET | `/api/me` | 我的使用者 ID、角色、在哪些世界是 GM |
| POST | `/api/characters` | 建立角色（`{ draft }`，照 v0.3 創角規則驗證） |
| GET | `/api/characters/:id` | 角色卡，限擁有者與 GM |
| POST | `/api/worlds/:w/join` | 讓自己的角色進入世界（`{ characterId, locationId }`，只能從據點進入） |
| GET | `/api/worlds/:w/view?as=gm&after=<seq>` | 這個身分看得到的世界、歷史、稽核與帳本（和試玩頁同一套過濾） |
| POST | `/api/worlds/:w/commands` | 執行世界指令（`{ command, requestId?, expected?, as? }`）；交易類必須帶 `requestId`，重送不會重複執行 |
| GET | `/api/worlds/:w/combats/:c` | 戰鬥狀態與紀錄，限參與者與該世界的 GM |
| POST | `/api/worlds/:w/combats/:c/actions` | 戰鬥行動（`{ actionId, combatantId, round, action }`） |
| GET | `/api/worlds/:w/feed?after=<seq>` | 限服務 token：原始事件、角色擁有者、GM 授權，給機器人分送通知 |

錯誤回應統一是 `{ error, message }`：
- `401`：沒有登入；
- `403`：沒有權限；
- `404`：找不到；
- `409`：狀態已被別人改過，或請求 ID 衝突；
- `400`：其他規則錯誤，訊息是給玩家看的中文。

## 排程

伺服器每分鐘執行一次：
- 戰鬥逾時；
- 殘影到期；
- 委託與契約期限；
- 每日推進（UTC 換日時跑一次）。每日推進用資料庫記錄日期，重啟或多開伺服器都不會重複推進同一天。

## 還沒做

- **PostgreSQL**：目前仍用 SQLite，store 的介面已經集中，換資料庫時不影響 API。
- **Discord 帳號登入**（OAuth，給網頁前端用）：目前玩家透過 Discord 機器人操作，不需要自己拿 token。
- **速率限制**。
