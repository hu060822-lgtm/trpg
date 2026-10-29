import { API_URL } from './api';

/**
 * Sign-in with a name and password kept by the game server; no email or outside account is needed. The server
 * answers with an API token, which stays in this browser until the player signs out.
 */
const KEY = 'fateweave.session';

export interface SignedIn { token: () => Promise<string>; label: string; signOut: () => Promise<void> }
interface Stored { token: string; name: string }

function signedIn(s: Stored): SignedIn {
  return {
    label: s.name,
    token: async () => s.token,
    signOut: async () => {
      try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
      await fetch(`${API_URL}/api/auth/sign-out`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` } }).catch(() => {});
    },
  };
}

export function currentSignIn(): SignedIn | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? signedIn(JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

/** Forgets a session the server no longer accepts. */
export function forgetSignIn() {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export async function signIn(mode: 'sign-in' | 'register', name: string, password: string): Promise<SignedIn> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/auth/${mode}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }),
    });
  } catch {
    throw new Error('連不上遊戲伺服器。伺服器閒置時會休眠，請等一分鐘再試一次。');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `伺服器回應 ${res.status}`);
  const stored: Stored = { token: data.token, name: data.name };
  try { localStorage.setItem(KEY, JSON.stringify(stored)); } catch { /* storage unavailable: signed in for this visit only */ }
  return signedIn(stored);
}
