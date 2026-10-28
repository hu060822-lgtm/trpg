/**
 * The bot's view of the game server. It holds the service token and always names the Discord user it acts
 * for, so the server applies that player's permissions and redaction: the bot never sees more than the
 * person asking would.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class GameApi {
  constructor(private base: string, private serviceToken: string, private fetchImpl: typeof fetch = fetch) {}

  /** `as` is a Discord user id; omit it only for the service's own feed. */
  async call<T = any>(method: string, path: string, opts: { as?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${this.serviceToken}`,
        'content-type': 'application/json',
        ...(opts.as ? { 'x-act-as': `discord:${opts.as}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
    if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.message ?? `伺服器回應 ${res.status}`);
    return body as T;
  }

  me(discordId: string) { return this.call('GET', '/api/me', { as: discordId }); }
  view(worldId: string, discordId: string, gm = false) { return this.call('GET', `/api/worlds/${worldId}/view${gm ? '?as=gm' : ''}`, { as: discordId }); }
  character(id: string, discordId: string) { return this.call('GET', `/api/characters/${encodeURIComponent(id)}`, { as: discordId }); }
  feed(worldId: string, after: number) { return this.call('GET', `/api/worlds/${worldId}/feed?after=${after}`); }
}
