import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Sign-in. With a Supabase project configured, players sign in with an email link or GitHub, and every API call
 * carries the Supabase access token. Without one (local development), a player picks a test name and the server,
 * started with AUTH_DEV=1, accepts `dev:<name>`.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;

const DEV_KEY = 'fateweave.devName';

export interface SignedIn { token: () => Promise<string>; label: string; signOut: () => Promise<void> }

function fromSession(s: Session): SignedIn {
  return {
    label: s.user.user_metadata?.user_name ?? s.user.email ?? '玩家',
    token: async () => (await supabase!.auth.getSession()).data.session?.access_token ?? s.access_token,
    signOut: async () => { await supabase!.auth.signOut(); },
  };
}

function devSignedIn(name: string): SignedIn {
  return {
    label: name,
    token: async () => `dev:${name}`,
    signOut: async () => { try { localStorage.removeItem(DEV_KEY); } catch { /* storage unavailable */ } },
  };
}

export async function currentSignIn(): Promise<SignedIn | null> {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    return data.session ? fromSession(data.session) : null;
  }
  try {
    const name = localStorage.getItem(DEV_KEY);
    return name ? devSignedIn(name) : null;
  } catch {
    return null;
  }
}

export function onSignInChange(cb: (s: SignedIn | null) => void) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_e, session) => cb(session ? fromSession(session) : null));
  return () => data.subscription.unsubscribe();
}

export async function signInWithEmail(email: string) {
  const { error } = await supabase!.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } });
  if (error) throw error;
}

export async function signInWithGitHub() {
  const { error } = await supabase!.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.href.split('#')[0] } });
  if (error) throw error;
}

export function signInDev(name: string): SignedIn {
  try { localStorage.setItem(DEV_KEY, name); } catch { /* storage unavailable: signed in for this visit only */ }
  return devSignedIn(name);
}
