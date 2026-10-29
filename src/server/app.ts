import express, { type NextFunction, type Request, type Response } from 'express';
import { randomRng, type Rng } from '../rules/dice';
import type { TableStore } from '../table/store';
import { Auth, AuthError, type Principal } from './auth';
import { tableErrorStatus, tableRoutes } from './table-routes';

/**
 * The game server's HTTP API: accounts and sign-in, then the rooms API (packs, rooms, chat, dice, sheets).
 * Dice are only rolled here, and every room check (member, GM) is made against the database, never a client claim.
 */
export interface ServerDeps {
  auth: Auth;
  table: TableStore;
  rng?: Rng;
  now?: () => Date;
  /** Browser origins allowed to call the API (the web client's sites). */
  corsOrigins?: string[];
}

/** The user a request acts as, after token checks and (for a service such as a bot) X-Act-As. */
interface Caller { userId: string; principal: Principal }
type Req = Request & { caller?: Caller };

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function createApp(deps: ServerDeps) {
  const { auth, table } = deps;
  const rng = deps.rng ?? randomRng;
  const now = deps.now ?? (() => new Date());
  const app = express();
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && deps.corsOrigins?.includes(origin)) {
      res.set({ 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PATCH' });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  // ---------- accounts ----------
  app.post('/api/auth/register', async (req, res) => {
    res.status(201).json(await auth.register(req.body?.name, req.body?.password, now()));
  });
  app.post('/api/auth/sign-in', async (req, res) => {
    res.json(await auth.signIn(req.body?.name, req.body?.password, now()));
  });

  // ---------- authentication ----------
  app.use('/api', async (req: Req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const principal = await auth.verify(header.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!principal) return next(new HttpError(401, 'unauthenticated', '請先登入'));
    const actAs = req.get('x-act-as');
    if (actAs && principal.kind !== 'service') return next(new HttpError(403, 'forbidden', '只有服務 token 可以代替其他使用者操作'));
    req.caller = { userId: actAs ?? principal.userId, principal };
    next();
  });

  app.post('/api/auth/sign-out', async (req: Req, res) => {
    await auth.revoke((req.get('authorization') ?? '').slice(7), now());
    res.json({ ok: true });
  });
  app.get('/api/me', (req: Req, res) => {
    res.json({ userId: req.caller!.userId, name: req.caller!.principal.name ?? null });
  });

  app.use('/api', tableRoutes(table, rng, now));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not-found', '沒有這個 API')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError || err instanceof AuthError) return res.status(err.status).json({ error: err.code, message: err.message });
    const t = tableErrorStatus(err);
    if (t) return res.status(t.status).json({ error: t.code, message: t.message, ...(t.problems ? { problems: t.problems } : {}) });
    if ((err as { type?: string }).type === 'entity.parse.failed') return res.status(400).json({ error: 'bad-json', message: 'JSON 格式錯誤' });
    console.error(err);
    return res.status(500).json({ error: 'internal', message: '伺服器錯誤' });
  });

  return app;
}
