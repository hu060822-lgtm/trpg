# 上線步驟：GitHub Pages ＋ Render ＋ Supabase

```
玩家的瀏覽器 ──► GitHub Pages（網頁版，靜態檔案）
      │
      ├──► Supabase Auth（登入）
      └──► Render（遊戲伺服器）──► Supabase PostgreSQL（資料）
```

GitHub Pages 只能放靜態網頁，不能跑伺服器，所以多人遊戲需要另外一台伺服器（Render）和資料庫（Supabase）。三個都有免費方案。

**前提：** 這個分支要先合併進 `main`。Pages 的自動部署和 Render 的 Blueprint 都看 `main`。

## 1. Supabase

1. 在 supabase.com 建立專案，區域選離玩家近的（例如 Tokyo 或 Singapore），記下資料庫密碼。
2. **Authentication → URL Configuration**：
   - Site URL 填 `https://hu060822-lgtm.github.io/trpg/`；
   - Redirect URLs 加上同一個網址，本機開發再加 `http://localhost:5173/`。
3. **Authentication → Sign In / Providers**：
   - Email 預設開啟，玩家會收到登入連結；
   - 想讓玩家用 GitHub 登入，要另外到 GitHub 建一個 OAuth App，callback 填 `https://<專案代號>.supabase.co/auth/v1/callback`，再把 Client ID 和 Secret 填回 Supabase。
4. 記下三個值：
   - **Project URL**（Project Settings → Data API），例如 `https://abcd.supabase.co`；
   - **anon 或 publishable key**（Project Settings → API Keys）。這把是公開金鑰，可以放進網頁；
   - **資料庫連線字串**：按上方 **Connect**，選 **Session pooler**，把 `[YOUR-PASSWORD]` 換成資料庫密碼。不要用 Direct connection，它只走 IPv6，Render 連不到。

不用手動建表，伺服器啟動時會自己建。

建議讓伺服器用自己的資料庫帳號，資料表放在 `fateweave` schema。這個 schema 不會經由 Supabase 的 Data API 公開。在 SQL Editor 執行：

```sql
CREATE ROLE fateweave LOGIN PASSWORD '<另一組密碼>';
GRANT fateweave TO postgres;
CREATE SCHEMA fateweave AUTHORIZATION fateweave;
ALTER ROLE fateweave SET search_path = fateweave;
```

連線字串的使用者名稱改成 `fateweave.<專案代號>`。

## 2. Render

1. 在 render.com 選 **New → Blueprint**，連到 `hu060822-lgtm/trpg`，它會讀 `render.yaml` 建立免費的 `fateweave-server`。
2. 填環境變數：
   - `DATABASE_URL`：Supabase 的 Session pooler 連線字串；
   - `SUPABASE_URL`：Supabase 的 Project URL；
   - `SUPABASE_ANON_KEY`：Supabase 的 anon 或 publishable key；
   - `CORS_ORIGINS`：`https://hu060822-lgtm.github.io`；
   - `INITIAL_GMS`：先留空，第 4 步再填。
3. 部署完成後打開 `https://<服務名稱>.onrender.com/health`，看到 `{"ok":true}` 就成功了。

免費方案閒置 15 分鐘會休眠，下一個人進來時要等大約一分鐘伺服器才會醒來。網頁版連不上時會提示玩家稍等再試。

## 3. GitHub Pages

1. 到 repo 的 **Settings → Pages**，Source 選 **GitHub Actions**。
2. 到 **Settings → Secrets and variables → Actions → Variables** 新增三個 repository variable：
   - `VITE_API_URL`：Render 服務的網址，例如 `https://fateweave-server.onrender.com`；
   - `VITE_SUPABASE_URL`：Supabase 的 Project URL；
   - `VITE_SUPABASE_ANON_KEY`：Supabase 的 anon 或 publishable key。
3. 到 **Actions → Deploy web client → Run workflow**（之後每次推到 `main` 都會自動部署）。
4. 網址是 `https://hu060822-lgtm.github.io/trpg/`。

## 4. 讓自己成為主 GM

1. 打開網頁版並登入，大廳會顯示你的使用者 ID（`sb:` 開頭）。
2. 回到 Render，把 `INITIAL_GMS` 設成 `sb:<你的ID>=main`，存檔後 Render 會重新啟動伺服器。
3. 重新整理網頁，大廳會出現 GM 桌。

之後要加其他 GM，可以在 `INITIAL_GMS` 加上更多人，用逗號分隔，例如 `sb:aaa=main,sb:bbb=scene:ruins,road,sb:ccc=arbiter`。也可以在自己電腦上用管理工具：

```bash
DATABASE_URL='<Session pooler 連線字串>' npm run admin -- set-gm <世界ID> sb:<ID> main
```

## 疑難排解

- **登入後網頁一直顯示「沒有登入」（401）**：確認 Render 有填 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY`。也可以改填 Project Settings → JWT Keys 的 Legacy JWT secret 到 `SUPABASE_JWT_SECRET`，少一次查詢。
- **瀏覽器出現 CORS 錯誤**：`CORS_ORIGINS` 要和網頁的來源完全一樣，只寫到網域，不要加 `/trpg/`。
- **登入連結打開後回到 localhost**：Supabase 的 Site URL 或 Redirect URLs 沒有填 Pages 的網址。

## 本機試玩（不需要任何帳號）

```bash
npm install && (cd client && npm install)
AUTH_DEV=1 npm run server        # 終端機 1
npm run web:dev                  # 終端機 2，打開 http://localhost:5173
```

不設定 Supabase 時，登入畫面改成輸入測試名字。用 `gm` 這個名字登入就是主 GM。
