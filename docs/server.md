# 遊戲伺服器

HTTP API，網頁版（`client/`）透過它開房間、聊天、擲骰和管理角色卡。程式在 `src/server/`、`src/table/`、`src/pack/`，測試在 `tests/server.test.ts`。部署步驟見 `docs/deploy.md`，規則包格式見 `docs/packs.md`。

## 執行

```bash
AUTH_DEV=1 npm run server        # 本機：資料放在 ./data/pglite，可以用 dev:<名字> 當 token
npm run admin                    # 管理指令：規則包、發 token
```

環境變數：

| 變數 | 說明 |
|---|---|
| `DATABASE_URL` | `postgres://…`（Supabase）；沒設定時用本機的 PGlite 目錄 `./data/pglite` |
| `PORT` | 預設 3000 |
| `AUTH_DEV=1` | 接受 `dev:<名字>` 當 token，只能在本機用，正式環境絕對不要設 |
| `CORS_ORIGINS` | 網頁版的網址來源，逗號分隔，例如 `https://fateweave.onrender.com` |

## 資料庫

- 正式環境用 Supabase 的 PostgreSQL；本機與測試用 PGlite，兩邊跑同一套 SQL。
- 伺服器啟動時自動建表，並載入 `packs/` 裡的內建規則包。
- 房間紀錄只增不改，由資料庫觸發器保證。
- 測試預設用 PGlite。設定 `TEST_DATABASE_URL=postgres://…` 時改在真的 PostgreSQL 上跑。

## 帳號

玩家用名字＋密碼登入（`POST /api/auth/register`、`POST /api/auth/sign-in`，回傳 token）。使用者 ID 是 `pw:<小寫名字>`。密碼用 scrypt 雜湊，同一個名字連續錯 5 次會鎖一分鐘。`POST /api/auth/sign-out` 讓目前的 token 失效。

其他 `/api` 請求都要帶 `Authorization: Bearer <token>`。管理工具可以發 `fw_u_…`（使用者）和 `fw_s_…`（服務，可以用 `X-Act-As` 代替使用者操作）token，資料庫只存雜湊值。

## 房間與權限

- 建立房間的人是 GM。GM 可以把其他成員設成 GM，房間至少留一位 GM。
- 其他人用 6 碼加入代碼進房，進來是玩家。
- 只有成員看得到房間。玩家看得到自己角色的完整角色卡，別人的角色只看得到名字；GM 全部看得到。
- 角色卡的數字全部在伺服器上照規則包算，玩家只送自己選的屬性、技能等級和輸入欄位。建立角色時會檢查創角點數。修改角色要帶版本號，被別人改過就回 409。
- 骰子只在伺服器擲。只有角色的擁有者或 GM 能替那個角色擲骰。`/gr` 的結果只有 GM 和擲骰的人看得到。
- 聊天和擲骰都要帶 `requestId`，網路不穩重送時不會說兩次或擲兩次。

## API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/health` | 健康檢查（不用 token） |
| GET | `/api/me` | 我的使用者 ID 和名字 |
| GET | `/api/packs` | 規則包列表 |
| GET | `/api/packs/:key` | 規則包內容（`key` 是 `id@version`） |
| POST | `/api/packs` | 上傳規則包 zip（request body 就是 zip 檔），有問題時回 400 並附 `problems` |
| GET | `/api/rooms` | 我加入的房間 |
| POST | `/api/rooms` | 開房間（`{ name, pack }`） |
| POST | `/api/rooms/join` | 用代碼加入（`{ code }`） |
| GET | `/api/rooms/:id` | 房間、我的身分、成員、角色卡、規則包摘要 |
| GET | `/api/rooms/:id/log?after=<seq>` | 這個序號之後的紀錄 |
| POST | `/api/rooms/:id/members/:userId` | 限 GM：設定身分（`{ role: "gm" | "player" }`） |
| POST | `/api/rooms/:id/chat` | 說話（`{ text, requestId }`）；`/r 2d6+1` 擲骰，`/gr …` 暗骰 |
| POST | `/api/rooms/:id/rolls` | 擲骰（`{ requestId, formula }`、`{ requestId, characterId, check: { skill } 或 { attribute }, mode }`、或 `{ requestId, characterId, action }`） |
| POST | `/api/rooms/:id/characters` | 建立角色（`{ name, data: { scores, ranks, inputs } }`） |
| PATCH | `/api/rooms/:id/characters/:cid` | 修改角色（`{ version, name?, data? }`） |
| GET | `/api/rooms/:id/maps` | 地圖列表和玩家目前看到的地圖（玩家只拿到打開的那張） |
| POST | `/api/rooms/:id/maps` | 限 GM：新地圖（`{ name, cols, rows }`，最多 100×100 格）；房間的第一張地圖會自動打開 |
| GET | `/api/rooms/:id/maps/:mid` | 地圖、迷霧和代幣。玩家拿不到隱藏代幣和站在迷霧裡的代幣（自己的除外） |
| PATCH | `/api/rooms/:id/maps/:mid` | 限 GM：名稱、格數、每格距離與單位、格線、迷霧開關。改格數時重疊部分的迷霧保留 |
| DELETE | `/api/rooms/:id/maps/:mid` | 限 GM：刪除地圖與上面的代幣 |
| POST | `/api/rooms/:id/maps/:mid/activate` | 限 GM：打開這張地圖給玩家看，並寫進紀錄 |
| PUT / GET | `/api/rooms/:id/maps/:mid/image` | 限 GM 上傳底圖（PNG、JPEG、WebP、GIF，4 MB 以內，request body 就是圖片）；看得到地圖的人可以下載 |
| POST | `/api/rooms/:id/maps/:mid/fog` | 限 GM：`{ cells: [格子編號…] 或 "all", covered }`，格子編號是 `y × 寬 + x` |
| POST | `/api/rooms/:id/maps/:mid/tokens` | 放代幣。GM 可以放任何代幣（可隱藏）；玩家只能放自己的角色，每張地圖一次 |
| PATCH | `/api/rooms/:id/tokens/:tid` | 移動或修改代幣。擁有者可以移動、改名、改顏色；只有 GM 能改大小和隱藏 |
| DELETE | `/api/rooms/:id/tokens/:tid` | 擁有者或 GM 移除代幣 |

錯誤回應統一是 `{ error, message }`：`401` 沒有登入、`403` 沒有權限、`404` 找不到、`409` 已被別人改過、`400` 其他錯誤（訊息是給玩家看的中文）。

## 即時同步

伺服器在 `/ws` 開一個 WebSocket。瀏覽器連上後先送 `{ token, room }`，伺服器確認身分和房間成員資格後回 `{ type: "ready" }`，之後房間有變化時送出 `{ type: "log" }`、`{ type: "room" }`、`{ type: "maps" }` 或 `{ type: "map", mapId }`。訊息只說「哪裡變了」，瀏覽器再用一般 API 去拿，所以每個人拿到的仍然只有自己看得到的內容。

連線斷掉時網頁版會自動重連，期間改回定時輪詢。目前只有一台伺服器，通知只在同一個程序內轉送；之後如果開多台，要改用 PostgreSQL 的 LISTEN/NOTIFY 之類的方式。

## 還沒做

- 速率限制。
- 多台伺服器之間的即時通知。
