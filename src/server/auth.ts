import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import type { Database } from '../persistence/db';

/**
 * Who is calling. Three kinds of bearer token are accepted:
 * - a Supabase Auth access token (the web game's sign-in); the user id is `sb:<Supabase user id>`;
 * - an API token issued from the admin CLI (`fw_u_…` for a user, `fw_s_…` for a service such as a future bot).
 *   Only a SHA-256 of each is stored, so a leaked database does not leak working tokens;
 * - in development only (`AUTH_DEV=1`), `dev:<name>`, so the game can be tried locally without Supabase.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'service')),
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
`;

export interface Principal { userId: string; kind: 'user' | 'service'; name?: string }

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface AuthOptions {
  /** Supabase project URL; its JWKS verifies access tokens signed with the project's asymmetric keys. */
  supabaseUrl?: string;
  /** Legacy HS256 JWT secret, for projects that still sign with a shared secret. */
  supabaseJwtSecret?: string;
  /**
   * Public anon or publishable key. Without the shared secret, HS256 tokens are checked by asking Supabase Auth
   * who they belong to; answers are kept for a minute so polling clients don't call it on every request.
   */
  supabaseAnonKey?: string;
  dev?: boolean;
}

export class Auth {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private secret?: Uint8Array;
  private remote = new Map<string, { principal: Principal | undefined; until: number }>();

  private constructor(private db: Database, private opts: AuthOptions) {
    if (opts.supabaseUrl) this.jwks = createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', opts.supabaseUrl));
    if (opts.supabaseJwtSecret) this.secret = new TextEncoder().encode(opts.supabaseJwtSecret);
  }

  static async open(db: Database, opts: AuthOptions = {}) {
    await db.migrate(SCHEMA);
    return new Auth(db, opts);
  }

  /** Returns the token once; it cannot be recovered later. */
  async issue(userId: string, kind: Principal['kind'], label = '', now = new Date()): Promise<string> {
    const token = `fw_${kind === 'service' ? 's' : 'u'}_${randomBytes(24).toString('base64url')}`;
    await this.db.run('INSERT INTO api_tokens (token_hash, user_id, kind, label, created_at) VALUES ($1, $2, $3, $4, $5)',
      [hash(token), userId, kind, label, now.toISOString()]);
    return token;
  }

  async revoke(token: string, now = new Date()) {
    await this.db.run('UPDATE api_tokens SET revoked_at = $1 WHERE token_hash = $2', [now.toISOString(), hash(token)]);
  }

  async verify(token: string | undefined): Promise<Principal | undefined> {
    if (!token) return undefined;
    if (token.startsWith('fw_')) {
      const row = await this.db.one<{ user_id: string; kind: Principal['kind'] }>(
        'SELECT user_id, kind FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL', [hash(token)]);
      return row && { userId: row.user_id, kind: row.kind };
    }
    if (token.startsWith('dev:')) {
      const name = token.slice(4).trim();
      return this.opts.dev && /^[\w一-鿿-]{1,32}$/u.test(name) ? { userId: `dev:${name}`, kind: 'user', name } : undefined;
    }
    return this.verifySupabase(token);
  }

  private async verifySupabase(token: string): Promise<Principal | undefined> {
    let payload: JWTPayload | undefined;
    try {
      const { alg } = decodeProtectedHeader(token);
      if (alg === 'HS256' && this.secret) payload = (await jwtVerify(token, this.secret, { audience: 'authenticated' })).payload;
      else if (alg !== 'HS256' && this.jwks) payload = (await jwtVerify(token, this.jwks, { audience: 'authenticated' })).payload;
      else if (alg === 'HS256' && this.opts.supabaseUrl && this.opts.supabaseAnonKey) return await this.askSupabase(token);
    } catch {
      return undefined;
    }
    return payload && toPrincipal(payload);
  }

  private async askSupabase(token: string): Promise<Principal | undefined> {
    const key = hash(token);
    const now = Date.now();
    const hit = this.remote.get(key);
    if (hit && hit.until > now) return hit.principal;
    const res = await fetch(new URL('/auth/v1/user', this.opts.supabaseUrl), {
      headers: { apikey: this.opts.supabaseAnonKey!, authorization: `Bearer ${token}` },
    });
    if (res.status >= 500) throw new Error(`Supabase Auth answered ${res.status}`);
    const user = res.ok ? await res.json() as { id?: string; email?: string; user_metadata?: unknown } : undefined;
    const principal = user?.id ? toPrincipal({ sub: user.id, email: user.email, user_metadata: user.user_metadata }) : undefined;
    if (this.remote.size > 1000) this.remote.clear();
    this.remote.set(key, { principal, until: now + 60_000 });
    return principal;
  }
}

function toPrincipal(payload: JWTPayload): Principal | undefined {
  if (!payload.sub) return undefined;
  const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
  const email = typeof payload.email === 'string' ? payload.email : '';
  const name = [meta.name, meta.full_name, meta.user_name].find((v) => typeof v === 'string') as string | undefined;
  return { userId: `sb:${payload.sub}`, kind: 'user', name: name ?? email.split('@')[0] };
}
