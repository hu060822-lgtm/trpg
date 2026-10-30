import { useState } from 'react';
import { signIn, type SignedIn } from '../auth';
import { useAction } from '../hooks';
import { ErrorNote } from '../parts/ui';

export function SignIn({ onSignedIn }: { onSignedIn: (s: SignedIn) => void }) {
  const [mode, setMode] = useState<'sign-in' | 'register'>('sign-in');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  // The repeat check speaks up once the player leaves the field (or presses the button), not while they type.
  const [checkAgain, setCheckAgain] = useState(false);
  const { busy, failure, run } = useAction();
  const registering = mode === 'register';
  const mismatch = registering && checkAgain && again !== password;

  return (
    <main className="page">
      <div className="hero">
        <h1>命運編織</h1>
        <p>開一個房間，選一套規則，把代碼給朋友。聊天、擲骰、角色卡都在同一個地方，數字自動幫你算好。</p>
      </div>
      <div className="card stack narrow-card">
        <div className="switch" role="group" aria-label="登入或建立帳號">
          <button type="button" aria-pressed={!registering} onClick={() => setMode('sign-in')}>登入</button>
          <button type="button" aria-pressed={registering} onClick={() => setMode('register')}>建立帳號</button>
        </div>
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          if (registering && again !== password) { setCheckAgain(true); return; }
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
              <input required type="password" autoComplete="new-password" value={again} aria-invalid={mismatch || undefined}
                aria-describedby={mismatch ? 'again-error' : undefined}
                onChange={(e) => { setAgain(e.target.value); if (e.target.value === password) setCheckAgain(false); }}
                onFocus={() => setCheckAgain(false)} onBlur={() => setCheckAgain(again !== '')} />
            </label>
          )}
          {mismatch && <p id="again-error" className="field-error">兩次的密碼還對不上，請再輸入一次相同的密碼。</p>}
          {registering && <p className="muted small">名字 2 到 20 個字，其他玩家會看到。密碼至少 8 個字，目前沒辦法找回，請記好。</p>}
          <button className="primary" disabled={busy}>{busy ? '連線中…' : registering ? '建立帳號並進入' : '登入'}</button>
        </form>
        <ErrorNote of={failure} />
      </div>
    </main>
  );
}
