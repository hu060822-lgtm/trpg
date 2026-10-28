# Discord 機器人 v0.3（原型）

讓玩家和 GM 在 Discord 裡**查資訊**，並把世界紀錄推播到頻道和私訊。程式在 `src/bot/`，測試在 `tests/bot.test.ts`。

這一版機器人**只讀不寫**：移動、交易、戰鬥等行動還是走 HTTP API（或之後的網頁）。在 Discord 裡直接行動是之後的步驟。

## 1. 運作方式

- 機器人用一把**服務 token** 呼叫遊戲伺服器，每次都帶 `X-Act-As: discord:<下指令的人的 Discord ID>`。伺服器用這個身分過濾資料，所以機器人拿到的和那位玩家自己呼叫 API 拿到的完全一樣，不會多看到別人的背包、GM 備註或不在場的紀錄。
- 機器人不存任何遊戲資料，只存推播進度（`BOT_STATE_PATH`）。
- 一個機器人服務一個 Discord 伺服器和一個世界。

## 2. 斜線指令

所有回覆都只有下指令的人看得到（ephemeral）。

| 指令 | 內容 |
|---|---|
| `/me` | 角色狀態：HP、位置、錢幣、是否瀕死／死亡 |
| `/sheet` | 完整角色卡：屬性與技能 |
| `/look` | 所在地點：在場的人、NPC、地上看得到的東西、出口 |
| `/bag` | 背包、錢幣、鎖定中的東西 |
| `/log [count]` | 自己看得到的最近紀錄（預設 10 筆，最多 30） |
| `/team` | 自己的隊伍、金庫、進行中的提案（只有隊員看得到金庫） |
| `/deals` | 自己參與的交易、契約、委託 |
| `/board` | 委託板（公開） |
| `/gm rulings` | 待處理的裁決單、交易爭議、待驗收委託（主 GM 與仲裁 GM） |
| `/gm where` | 所有角色的位置與狀態（主 GM） |
| `/gm log [count]` | 這位 GM 看得到的完整世界紀錄 |
| `/gm audit [count]` | 變更稽核（主 GM） |

- 有多個角色的玩家可以加 `character:` 選項指定角色名稱。
- `/gm` 會用 `as=gm` 向伺服器要 GM 檢視，伺服器再查世界的 GM 授權表。沒有授權的人會收到「你不是這個世界的 GM」，Discord 身分組不會給任何權限。
- 回覆會依 Discord 嵌入訊息的限制截斷（標題 256 字、內文 4096 字、最多 25 欄、每欄 1024 字），被截掉的地方以「…」結尾。

## 3. 推播

機器人每 15 秒讀一次伺服器的事件推播（`GET /api/worlds/:w/feed`，只有服務 token 能讀），依照每筆紀錄的可見度送到：

| 可見度 | 送到 |
|---|---|
| 公開 | 世界頻道（`WORLD_CHANNEL_ID`） |
| GM | GM 頻道（`GM_CHANNEL_ID`） |
| 場景、私人 | 私訊給在場或被指名的角色的擁有者，每位玩家只收一次 |

- 每送完一批就存下進度，所以重新啟動不會重送。
- 第一次啟動時從最新的紀錄開始，不會把整個歷史倒進頻道。
- 私訊失敗（例如玩家關掉私訊）只會記一行錯誤並跳過，不會卡住後面的推播。那位玩家還是可以用 `/log` 看到。
- **GM 頻道要設成只有 GM 看得到**，這是 Discord 端的設定，機器人沒辦法替你檢查。

## 4. 設定步驟

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 建立應用程式，加一個 Bot，複製 token 和 Application ID。
2. 用 OAuth2 URL 產生器勾選 `bot` 和 `applications.commands`，權限勾 `Send Messages`，把機器人邀請進你的 Discord 伺服器。
3. 在遊戲伺服器上：
   ```bash
   npm run admin -- create-world --gm discord:<主GM的Discord ID>=main
   npm run admin -- issue-service-token discord-bot      # 只會顯示一次
   ```
4. 設定環境變數後啟動：`npm run bot`

| 變數 | 說明 |
|---|---|
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_APP_ID` | Application ID |
| `DISCORD_GUILD_ID` | Discord 伺服器 ID（指令只註冊在這個伺服器，更新會立刻生效） |
| `GAME_API_URL` | 遊戲伺服器網址，例如 `https://fateweave-server.onrender.com` |
| `GAME_SERVICE_TOKEN` | 第 3 步發的服務 token |
| `WORLD_ID` | 這個 Discord 伺服器玩的世界 |
| `WORLD_CHANNEL_ID` | 公開紀錄的頻道 |
| `GM_CHANNEL_ID` | GM 紀錄的頻道 |
| `BOT_STATE_PATH` | 推播進度檔，預設 `./data/bot-state.json` |

Discord 的 ID 要先在「使用者設定 → 進階」打開開發者模式，再對伺服器、頻道或使用者按右鍵「複製 ID」。

## 5. 部署（Render）

`render.yaml` 多了一個 `fateweave-bot` 背景服務，Discord 相關的值要在 Render 後台填。

注意：背景服務沒有掛磁碟，重新部署後推播進度會不見，機器人會從最新的紀錄重新開始，**停機期間的紀錄不會補送**（玩家仍可用 `/log` 查）。要補送的話可以替它掛一個磁碟，再把 `BOT_STATE_PATH` 指到磁碟上。

## 6. 還沒做的部分

- 在 Discord 裡直接行動（移動、交易、投票、GM 裁決）。
- 角色建立和加入世界目前要用 API；之後可以做 Discord 登入的網頁。
- 一個機器人同時服務多個世界。
