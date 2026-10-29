import { useState } from 'react';
import { signIn, type SignedIn } from '../auth';
import { useAction } from '../hooks';

export function SignIn({ onSignedIn }: { onSignedIn: (s: SignedIn) => void }) {
  const [mode, setMode] = useState<'sign-in' | 'register'>('sign-in');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const { busy, error, run } = useAction();
  const registering = mode === 'register';
  const mismatch = registering && again !== '' && again !== password;

  return (
    <main className="page">
      <div className="hero">
        <h1>命運編織</h1>
        <p>開一個房間，選一套規則，把代碼給朋友。聊天、擲骰、角色卡都在同一個地方，數字自動幫你算好。</p>
      </div>
      <div className="card stack" style={{ maxWidth: 420 }}>
        <div className="switch" role="tablist">
          <button role="tab" aria-selected={!registering} onClick={() => setMode('sign-in')}>登入</button>
          <button role="tab" aria-selected={registering} onClick={() => setMode('register')}>建立帳號</button>
        </div>
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          if (mismatch) return;
          void run(async () => onSignedIn(await signIn(mode, name.trim(), password)));
        }}>
          <label>名字
            <input required autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="例如 luz" />
          </label>
          <label>密碼
            <input required type="password" autoComplete={registering ? 'new-password' : 'current-password'} minLength={registering ? 8 : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {registering && (
            <label>再輸入一次密碼
              <input required type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
          )}
          {registering && <p className="muted small">名字 2 到 20 個字，其他玩家會看到。密碼至少 8 個字，忘記了目前沒辦法找回，請記好。</p>}
          {mismatch && <p className="error">兩次輸入的密碼不一樣</p>}
          <button className="primary" disabled={busy || mismatch}>{registering ? '建立帳號並進入' : '登入'}</button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
