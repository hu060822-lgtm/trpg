# 遊戲伺服器 v0.3

HTTP API，讓網頁版（`client/`）和之後的工具讀取和操作同一個世界。程式在 `src/server/`，測試在 `tests/server.test.ts`。部署步驟見 `docs/deploy.md`。

## 執行

```bash
AUTH_DEV=1 npm run server        # 本機試玩：資料放在 ./data/pglite，測試帳號 dev:gm 是主 GM
npm run admin                    # 管理指令說明（建立世界、設定 GM、發 token）
```

環境變數：

| 變數 | 說明 |
|---|---|
| `DATABASE_URL` | `postgres://…`（Supabase）；沒設定時用本機的 PGlite 目錄 `./data/pglite` |
| `PORT` | 預設 3000 |
| `SUPABASE_URL` | 用 Supabase 專案的金鑰驗證登入 |
| `SUPABASE_JWT_SECRET` | 舊式共用密鑰。可以不填，改填 `SUPABASE_ANON_KEY` |
| `SUPABASE_ANON_KEY` | Supabase 的公開金鑰。舊專案用共用密鑰簽登入，沒有密鑰時伺服器會拿這把金鑰去問 Supabase 這是誰，答案保留一分鐘 |
| `AUTH_DEV=1` | 接受 `dev:<名字>` 登入，只能在本機用，正式環境絕對不要設 |
| `CORS_ORIGINS` | 網頁版的網址來源，逗號分隔，例如 `https://hu060822-lgtm.github.io` |
| `INITIAL_GMS` | 第一個世界的 GM，例如 `sb:<使用者ID>=main`。資料庫是空的時候會建立種子世界；之後每次啟動，名單上還沒有權限的人會補上權限，已有的權限不會被改 |

## 資料庫

- 正式環境用 Supabase 的 PostgreSQL；本機與測試用 PGlite（編譯成 WebAssembly 的 PostgreSQL），兩邊跑同一套 SQL、觸發器和交易。
- 伺服器啟動時自動建表。多台同時啟動時用 advisory lock 排隊。
- 世界和戰鬥在寫入時用 `FOR UPDATE` 鎖住，同時送出的兩個指令會依序處理，不會互相覆蓋。
- 只增不改的帳本、世界歷史、不可復活等規則寫在資料庫觸發器裡，直接改資料庫也改不掉。
- 測試預設用 PGlite。設定 `TEST_DATABASE_URL=postgres://…` 時改在真的 PostgreSQL 上跑，每個測試用一個新 schema。

## 身分與權限

所有 `/api` 請求都要帶 `Authorization: Bearer <token>`。接受三種 token：

- **Supabase 登入**（網頁版）：使用者 ID 是 `sb:<Supabase 使用者 ID>`，網頁大廳會顯示這個 ID；
- **管理工具發的 API token**：`fw_u_…` 是使用者，`fw_s_…` 是服務。資料庫只存雜湊值。服務 token 可以用 `X-Act-As` 代替使用者操作，也可以讀事件推播；
- **`dev:<名字>`**：只有 `AUTH_DEV=1` 時才接受。

其他規則：

- GM 權限只看世界的 GM 授權表。請求帶 `as: "gm"` 但沒有授權時，拿到的資料和玩家一樣，GM 指令會被拒絕。
- 戰鬥中的怪物只有該世界的 GM 能操作。
- `system` 身分只有伺服器內部排程能用。

## API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/health` | 健康檢查（不用 token） |
| GET | `/api/me` | 我的使用者 ID、名字、角色、在哪些世界是 GM |
| GET | `/api/worlds` | 世界列表與可以進入的據點 |
| POST | `/api/characters` | 建立角色（`{ draft }`，照 v0.3 創角規則驗證） |
| GET | `/api/characters/:id` | 角色卡，限擁有者與 GM |
| POST | `/api/worlds/:w/join` | 讓自己的角色進入世界（`{ characterId, locationId }`，只能從據點進入） |
| GET | `/api/worlds/:w/view?as=gm&after=<seq>` | 這個身分看得到的世界、歷史、稽核與帳本 |
| POST | `/api/worlds/:w/commands` | 執行世界指令（`{ command, requestId?, expected?, as? }`）；交易類必須帶 `requestId`，重送不會重複執行 |
| GET | `/api/worlds/:w/combats` | 進行中的戰鬥 |
| POST | `/api/worlds/:w/combats` | 限 GM：用怪物圖鑑開戰（`{ locationId, characters, monsters }`） |
| GET | `/api/worlds/:w/combats/:c` | 戰鬥狀態與紀錄，限參與者與該世界的 GM |
| POST | `/api/worlds/:w/combats/:c/actions` | 戰鬥行動（`{ actionId, combatantId, round, action }`） |
| GET | `/api/worlds/:w/feed?after=<seq>` | 限服務 token：原始事件，給之後的機器人分送通知 |

錯誤回應統一是 `{ error, message }`：
- `401`：沒有登入；
- `403`：沒有權限；
- `404`：找不到；
- `409`：狀態已被別人改過，或請求 ID 衝突；
- `400`：其他規則錯誤，訊息是給玩家看的中文。

## 排程

伺服器每分鐘處理一次以下工作：
- 戰鬥逾時；
- 殘影到期；
- 委託與契約期限；
- 每日推進（UTC 換日時跑一次，用資料庫記錄日期，重啟或多開都不會重複推進同一天）。

Render 免費方案閒置 15 分鐘會休眠，休眠時排程不會跑。所以每個請求進來時，如果距離上次處理超過 30 秒，會先補跑一次。

限制：休眠好幾天後醒來，每日推進只會跑一次，不會把錯過的每一天都補上。

## 還沒做

- 速率限制。
- 網頁版即時推送：目前每 4 秒輪詢一次。
