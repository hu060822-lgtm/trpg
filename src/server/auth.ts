import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * API tokens. Only a SHA-256 of each token is stored, so a leaked database does not leak working tokens.
 * A user token acts as its user. A service token (the Discord bot) may act on behalf of any user by naming them
 * in `X-Act-As`, and may read the raw event feed it needs to route notifications.
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

export interface Principal { userId: string; kind: 'user' | 'service' }

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Tokens {
  constructor(private db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  /** Returns the token once; it cannot be recovered later. */
  issue(userId: string, kind: Principal['kind'], label = '', now = new Date()): string {
    const token = `fw_${kind === 'service' ? 's' : 'u'}_${randomBytes(24).toString('base64url')}`;
    this.db.prepare('INSERT INTO api_tokens (token_hash, user_id, kind, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash(token), userId, kind, label, now.toISOString());
    return token;
  }

  revoke(token: string, now = new Date()) {
    this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ?').run(now.toISOString(), hash(token));
  }

  verify(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    const row = this.db.prepare('SELECT user_id, kind FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash(token)) as
      { user_id: string; kind: Principal['kind'] } | undefined;
    return row && { userId: row.user_id, kind: row.kind };
  }
}
