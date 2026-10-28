import express, { type NextFunction, type Request, type Response } from 'express';
import { CombatError } from '../combat/engine';
import type { CombatAction } from '../combat/types';
import { createCharacter, type CharacterDraft } from '../character/create';
import { StoreError } from '../persistence/combat-store';
import type { WorldStore } from '../persistence/world-store';
import { randomRng, type Rng } from '../rules/dice';
import type { RulesConfig } from '../rules/types';
import { WorldError, gmGrant } from '../world/engine';
import type { WorldActor, WorldCommand } from '../world/types';
import { Tokens, type Principal } from './auth';

/**
 * The game server's HTTP API. Every response a player gets goes through the same redaction as the sandbox
 * (viewFor / historyFor / ledgerFor), and every change goes through the same store commands as the tests.
 * The server never trusts a role claim: GM power comes from the world's grant table, and `system` is refused.
 */
export interface ServerDeps {
  store: WorldStore;
  tokens: Tokens;
  rules: RulesConfig;
  rng?: Rng;
  now?: () => Date;
}

/** The user a request acts as, after token checks and (for the bot) X-Act-As. */
interface Caller { userId: string; principal: Principal }
type Req = Request & { caller?: Caller };

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const STATUS: [RegExp, number][] = [
  [/^(forbidden|not-yours|not-invited)$/, 403],
  [/^(not-found|unknown-.*)$/, 404],
  [/^(conflict|stale|request-reused|already-.*)$/, 409],
];

export function createApp(deps: ServerDeps) {
  const { store, tokens, rules } = deps;
  const rng = deps.rng ?? randomRng;
  const now = deps.now ?? (() => new Date());
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  // ---------- authentication ----------
  app.use('/api', (req: Req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const principal = tokens.verify(header.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!principal) return next(new HttpError(401, 'unauthenticated', '需要有效的 API token'));
    const actAs = req.get('x-act-as');
    if (actAs && principal.kind !== 'service') return next(new HttpError(403, 'forbidden', '只有服務 token 可以代替其他使用者操作'));
    req.caller = { userId: actAs ?? principal.userId, principal };
    next();
  });

  const caller = (req: Req) => req.caller!;
  const worldOf = (req: Request) => {
    const id = String(req.params.worldId);
    if (!store.worldIds().includes(id)) throw new HttpError(404, 'not-found', `找不到世界 ${id}`);
    return id;
  };
  /** A request may ask to act as GM; the engine then checks the grant table. `system` is never accepted. */
  const actorFor = (req: Req, as: unknown): WorldActor => {
    if (as !== undefined && as !== 'player' && as !== 'gm') throw new HttpError(400, 'bad-role', 'as 只能是 player 或 gm');
    return { userId: caller(req).userId, role: as === 'gm' ? 'gm' : 'player' };
  };
  const isGmAnywhere = (userId: string) => store.worldIds().some((w) => !!gmGrant(store.load(w), { userId, role: 'gm' }));

  // ---------- characters ----------
  app.get('/api/me', (req: Req, res) => {
    const { userId } = caller(req);
    const gmOf = store.worldIds().filter((w) => gmGrant(store.load(w), { userId, role: 'gm' })).map((w) => ({ worldId: w, ...store.load(w).gms[userId] }));
    res.json({ userId, characters: store.combat.charactersOf(userId), gmOf });
  });

  app.post('/api/characters', (req: Req, res) => {
    const draft = req.body?.draft as CharacterDraft | undefined;
    if (!draft || typeof draft !== 'object') throw new HttpError(400, 'bad-request', '需要 draft');
    let c;
    try {
      c = createCharacter(draft, rules, now());
    } catch (e) {
      throw new HttpError(400, 'invalid-character', (e as Error).message);
    }
    store.combat.saveNewCharacter(caller(req).userId, c);
    res.status(201).json(store.combat.getCharacter(c.id));
  });

  app.get('/api/characters/:id', (req: Req, res) => {
    const c = store.combat.getCharacter(String(req.params.id));
    const { userId } = caller(req);
    if (c.ownerUserId !== userId && !isGmAnywhere(userId)) throw new HttpError(403, 'forbidden', '只能查看自己的角色');
    res.json({ ...c, death: store.combat.deathRecord(c.id) ?? null });
  });

  // ---------- world ----------
  app.post('/api/worlds/:worldId/join', (req: Req, res) => {
    const worldId = worldOf(req);
    const { characterId, locationId } = req.body ?? {};
    const c = store.combat.getCharacter(String(characterId));
    if (c.ownerUserId !== caller(req).userId) throw new HttpError(403, 'forbidden', '只能讓自己的角色加入世界');
    const loc = store.load(worldId).locations[String(locationId)];
    if (!loc?.outpost) throw new HttpError(400, 'bad-location', '新角色只能從據點進入世界');
    store.join(worldId, c.id, loc.id);
    res.status(201).json(store.viewFor(worldId, { userId: c.ownerUserId, role: 'player' }).world.characters[c.id]);
  });

  /** What this caller may see. `as=gm` gives the GM view only if the grant table says so. */
  app.get('/api/worlds/:worldId/view', (req: Req, res) => {
    const worldId = worldOf(req);
    const actor = actorFor(req, req.query.as);
    const v = store.viewFor(worldId, actor);
    const after = Number(req.query.after ?? 0);
    res.json({ ...v, history: v.history.filter((e) => e.seq > after) });
  });

  app.post('/api/worlds/:worldId/commands', (req: Req, res) => {
    const worldId = worldOf(req);
    const { command, requestId, expected, as } = req.body ?? {};
    if (!command || typeof command.type !== 'string') throw new HttpError(400, 'bad-request', '需要 command');
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 100)) throw new HttpError(400, 'bad-request', 'requestId 必須是 100 字以內的字串');
    const actor = actorFor(req, as);
    const r = store.submit(worldId, { actor, command: command as WorldCommand, requestId, expected }, rng, now());
    // The caller gets their own view of the outcome, never the raw state.
    const v = store.viewFor(worldId, actor);
    const seqs = new Set(r.events.map((e) => e.seq));
    res.json({
      replayed: !!r.replayed,
      events: v.history.filter((e) => seqs.has(e.seq)),
      combatId: r.combat?.id ?? null,
      world: v.world,
    });
  });

  // ---------- combat ----------
  const combatFor = (req: Req) => {
    const worldId = worldOf(req);
    const combat = store.combat.loadCombat(String(req.params.combatId));
    const { userId } = caller(req);
    const inIt = Object.values(combat.combatants).some((c) => c.controller === userId);
    if (!inIt && !gmGrant(store.load(worldId), { userId, role: 'gm' })) throw new HttpError(403, 'forbidden', '你沒有參與這場戰鬥');
    return { worldId, combat };
  };

  app.get('/api/worlds/:worldId/combats/:combatId', (req: Req, res) => {
    const { combat } = combatFor(req);
    res.json({ ...combat, events: store.combat.events(combat.id) });
  });

  app.post('/api/worlds/:worldId/combats/:combatId/actions', (req: Req, res) => {
    const { worldId, combat } = combatFor(req);
    const { actionId, combatantId, round, action } = req.body ?? {};
    if (typeof actionId !== 'string' || typeof combatantId !== 'string' || typeof round !== 'number' || !action) {
      throw new HttpError(400, 'bad-request', '需要 actionId、combatantId、round 與 action');
    }
    const r = store.submitCombat(worldId, combat.id, {
      actionId, combatantId, round, action: action as CombatAction, actor: { userId: caller(req).userId, role: 'player' },
    }, rng, now());
    res.json({ state: r.state, events: r.events });
  });

  // ---------- service feed ----------
  /**
   * The bot's notification feed: raw history after `after`, with who owns each character and the GM grants,
   * so it can post public entries to the world channel, private ones by DM and GM entries to the GM channel.
   */
  app.get('/api/worlds/:worldId/feed', (req: Req, res) => {
    if (caller(req).principal.kind !== 'service' || req.get('x-act-as')) throw new HttpError(403, 'forbidden', '只有服務 token 能讀取事件推播');
    const worldId = worldOf(req);
    const s = store.load(worldId);
    const after = Number(req.query.after ?? 0);
    res.json({
      events: store.events(worldId).filter((e) => e.seq > after),
      owners: Object.fromEntries(Object.values(s.characters).map((c) => [c.id, c.ownerUserId])),
      gms: s.gms,
    });
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'not-found', '沒有這個 API')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof WorldError || err instanceof StoreError || err instanceof CombatError) {
      const code = (err as { code: string }).code;
      const status = STATUS.find(([re]) => re.test(code))?.[1] ?? 400;
      return res.status(status).json({ error: code, message: err.message });
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') return res.status(400).json({ error: 'bad-json', message: 'JSON 格式錯誤' });
    console.error(err);
    return res.status(500).json({ error: 'internal', message: '伺服器錯誤' });
  });

  return app;
}
