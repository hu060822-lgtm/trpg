# 上線步驟：Render ＋ Supabase（＋ GitHub Pages）

```
玩家的瀏覽器 ──► 網頁版（Render 靜態網站，或 GitHub Pages）
      │
      └──► Render（遊戲伺服器，帳號密碼登入）──► Supabase PostgreSQL（資料）
```

GitHub Pages 只能放靜態網頁，不能跑伺服器，所以多人遊戲需要另外一台伺服器（Render）和資料庫（Supabase）。三個都有免費方案。

登入用遊戲自己的帳號：名字＋密碼，存在伺服器的資料庫，密碼只存 scrypt 雜湊。不需要 Email，也不需要 GitHub 帳號。伺服器仍然接受 Supabase Auth 的 token，之後要加回 Email 或第三方登入時可以用。

## 目前的部署（2026-10-29）

| 部分 | 位置 |
|---|---|
| 網頁版 | https://fateweave.onrender.com （Render 靜態網站 `fateweave`） |
| 伺服器 | https://fateweave-server.onrender.com （Render `fateweave-server`，新加坡，免費方案） |
| 資料庫 | Supabase 專案「trpg計畫」，帳號 `fateweave`，schema `fateweave` |

兩個 Render 服務目前從 `web-game` 分支自動部署，推送到這個分支就會更新。

## 1. Supabase（資料庫）

1. 建立專案，區域選離玩家近的（例如 Tokyo）。
2. 讓伺服器用自己的資料庫帳號，資料表放在 `fateweave` schema。這個 schema 不會經由 Supabase 的 Data API 公開。在 SQL Editor 執行：

   ```sql
   CREATE ROLE fateweave LOGIN PASSWORD '<一組長密碼>';
   GRANT fateweave TO postgres;
   CREATE SCHEMA fateweave AUTHORIZATION fateweave;
   ALTER ROLE fateweave SET search_path = fateweave;
   ```

3. 連線字串用 **Session pooler**：`postgres://fateweave.<專案代號>:<密碼>@aws-0-<區域>.pooler.supabase.com:5432/postgres`。
   - 不要用 Direct connection，它只走 IPv6，Render 連不到。
   - 如果日誌出現 `tenant/user ... not found`，把 `aws-0` 換成 `aws-1` 試試（看專案建立的時間）。

不用手動建表，伺服器啟動時會自己建。

## 2. Render

**伺服器**（`render.yaml` 的 Blueprint，或手動建 Web Service）：
- Build：`npm ci --include=dev`；Start：`npm run server`；
- 環境變數：
  - `DATABASE_URL`：上面的連線字串；
  - `CORS_ORIGINS`：網頁版的網址來源，逗號分隔，例如 `https://fateweave.onrender.com,https://hu060822-lgtm.github.io`。

**網頁版**（Static Site）：
- Build：`npm ci && npm --prefix client ci && npm --prefix client run build`；
- Publish directory：`client/dist`；
- 環境變數：`VITE_API_URL` 設成伺服器網址。

免費方案閒置 15 分鐘會休眠，下一個人進來時要等大約一分鐘伺服器才會醒來。網頁版連不上時會提示玩家稍等再試。

## 3. GitHub Pages（選用）

需要 repo 擁有者操作，而且 `.github/workflows/pages.yml` 只在 `main` 上執行：
1. **Settings → Pages**，Source 選 **GitHub Actions**；
2. **Settings → Secrets and variables → Actions → Variables** 新增 `VITE_API_URL`；
3. **Actions → Deploy web client → Run workflow**。

網址會是 `https://hu060822-lgtm.github.io/trpg/`，記得在伺服器的 `CORS_ORIGINS` 加上 `https://hu060822-lgtm.github.io`。

## 4. GM 與房間

沒有全站的主 GM。每個房間的建立者就是那個房間的 GM，GM 可以在房間的成員列表把其他人設成 GM（房間至少會留一位 GM）。其他人用房間的 6 碼加入代碼進來。

## 疑難排解

- **瀏覽器出現 CORS 錯誤**：`CORS_ORIGINS` 要和網頁的來源完全一樣，只寫到網域，不要加路徑。
- **密碼錯太多次**：同一個名字連續錯 5 次會鎖一分鐘。
- **忘記密碼**：目前沒有找回功能，GM 可以在資料庫刪掉 `accounts` 裡那一列，讓玩家用同一個名字重新註冊。舊角色的擁有者 ID 不變，所以會跟著回來。

## 本機試玩（不需要任何帳號）

```bash
npm install && (cd client && npm install)
AUTH_DEV=1 npm run server        # 終端機 1，資料放在 ./data/pglite
npm run web:dev                  # 終端機 2，打開 http://localhost:5173
```

本機建立名字叫 `gm` 的帳號就是主 GM。
