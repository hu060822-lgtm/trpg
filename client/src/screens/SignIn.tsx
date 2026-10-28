import { useState } from 'react';
import { signInDev, signInWithEmail, signInWithGitHub, supabase, type SignedIn } from '../auth';
import { useAction } from '../hooks';

export function SignIn({ onSignedIn }: { onSignedIn: (s: SignedIn) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();

  return (
    <main className="page">
      <div className="hero">
        <h1>命運編織</h1>
        <p>一個世界，一位真人主持人，很多個不必同時上線的玩家。你離開時世界照樣運轉，回來時看看發生了什麼，再決定下一步。</p>
      </div>
      <div className="card stack" style={{ maxWidth: 420 }}>
        {supabase ? (
          sent ? (
            <p className="notice">登入連結已寄到 {email}，在這台裝置上打開信裡的連結就能進入。</p>
          ) : (
            <>
              <h2>登入</h2>
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => { await signInWithEmail(email.trim()); setSent(true); }); }}>
                <label>Email
                  <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </label>
                <button className="primary" disabled={busy}>寄登入連結給我</button>
              </form>
              <button disabled={busy} onClick={() => void run(signInWithGitHub)}>用 GitHub 帳號登入</button>
            </>
          )
        ) : (
          <>
            <h2>本機試玩</h2>
            <p className="muted small">這個版本沒有設定 Supabase，用一個名字登入就好。伺服器要用 AUTH_DEV=1 啟動，名字 gm 是預設的主 GM。</p>
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSignedIn(signInDev(name.trim())); }}>
              <label>名字
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="例如 luz" />
              </label>
              <button className="primary">進入</button>
            </form>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
