import express, { type NextFunction, type Request, type Response } from 'express';
import { CombatError } from '../combat/engine';
import type { CombatAction } from '../combat/types';
import bestiaryJson from '../../config/bestiary.v03.json';
import { createCharacter, type CharacterDraft } from '../character/create';
import type { CombatantSetup } from '../combat/types';
import { StoreError } from '../persistence/combat-store';
import type { WorldStore } from '../persistence/world-store';
import { randomRng, type Rng } from '../rules/dice';
import type { RulesConfig } from '../rules/types';
import { WorldError, gmGrant } from '../world/engine';
import type { WorldActor, WorldCommand } from '../world/types';
import { Auth, type Principal } from './auth';

/**
 * The game server's HTTP API. Every response a player gets goes through the same redaction as the sandbox
 * (viewFor / historyFor / ledgerFor), and every change goes through the same store commands as the tests.
 * The server never trusts a role claim: GM power comes from the world's grant table, and `system` is refused.
 */
export interface ServerDeps {
  store: WorldStore;
  auth: Auth;
  rules: RulesConfig;
  rng?: Rng;
  now?: () => Date;
  /** Browser origins allowed to call the API (the GitHub Pages site). */
  corsOrigins?: string[];
  /** Runs before each API request; the server uses it to catch up on jobs missed while it was asleep. */
  beforeRequest?: () => Promise<void>;
}

/** The user a request acts as, after token checks and (for the bot) X-Act-As. */
interface Caller { userId: string; principal: Principal }
type Req = Request & { caller?: Caller };

interface Monster { id: string; name: string; attributes: CombatantSetup['attributes']; skills: Record<string, number>; maxHp: number; weaponId: string; armorId: string }
const BESTIARY = bestiaryJson.monsters as Monster[];
const STEMS = '甲乙丙丁戊己庚辛壬癸';

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
  const { store, auth, rules } = deps;
  const rng = deps.rng ?? randomRng;
  const now = deps.now ?? (() => new Date());
  const app = express();
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && deps.corsOrigins?.includes(origin)) {
      res.set({ 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST' });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  // ---------- authentication ----------
  app.use('/api', async (req: Req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const principal = await auth.verify(header.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!principal) return next(new HttpError(401, 'unauthenticated', '請先登入'));
    const actAs = req.get('x-act-as');
    if (actAs && principal.kind !== 'service') return next(new HttpError(403, 'forbidden', '只有服務 token 可以代替其他使用者操作'));
    req.caller = { userId: actAs ?? principal.userId, principal };
    await deps.beforeRequest?.();
    next();
  });

  const caller = (req: Req) => req.caller!;
  const worldOf = async (req: Request) => {
    const id = String(req.params.worldId);
    if (!(await store.worldIds()).includes(id)) throw new HttpError(404, 'not-found', `找不到世界 ${id}`);
    return id;
  };
  /** A request may ask to act as GM; the engine then checks the grant table. `system` is never accepted. */
  const actorFor = (req: Req, as: unknown): WorldActor => {
    if (as !== undefined && as !== 'player' && as !== 'gm') throw new HttpError(400, 'bad-role', 'as 只能是 player 或 gm');
    return { userId: caller(req).userId, role: as === 'gm' ? 'gm' : 'player' };
  };
  /** The GM grants this user holds, world by world. */
  const grantsOf = async (userId: string) => {
    const out = [];
    for (const w of await store.worldIds()) {
      const s = await store.load(w);
      if (gmGrant(s, { userId, role: 'gm' })) out.push({ worldId: w, ...s.gms[userId] });
    }
    return out;
  };

  // ---------- characters ----------
  app.get('/api/me', async (req: Req, res) => {
    const { userId, principal } = caller(req);
    res.json({ userId, name: principal.name ?? null, characters: await store.combat.charactersOf(userId), gmOf: await grantsOf(userId) });
  });

  /** Worlds and the outposts a new character may enter from. */
  app.get('/api/worlds', async (_req: Req, res) => {
    const out = [];
    for (const id of await store.worldIds()) {
      const s = await store.load(id);
      out.push({
        id, name: s.name, day: s.day, characters: Object.keys(s.characters).length,
        outposts: Object.values(s.locations).filter((l) => l.outpost).map((l) => ({ id: l.id, name: l.name })),
      });
    }
    res.json(out);
  });

  app.post('/api/characters', async (req: Req, res) => {
    const draft = req.body?.draft as CharacterDraft | undefined;
    if (!draft || typeof draft !== 'object') throw new HttpError(400, 'bad-request', '需要 draft');
    let c;
    try {
      c = createCharacter(draft, rules, now());
    } catch (e) {
      throw new HttpError(400, 'invalid-character', (e as Error).message);
    }
    await store.combat.saveNewCharacter(caller(req).userId, c);
    res.status(201).json(await store.combat.getCharacter(c.id));
  });

  app.get('/api/characters/:id', async (req: Req, res) => {
    const c = await store.combat.getCharacter(String(req.params.id));
    const { userId } = caller(req);
    if (c.ownerUserId !== userId && (await grantsOf(userId)).length === 0) throw new HttpError(403, 'forbidden', '只能查看自己的角色');
    res.json({ ...c, death: (await store.combat.deathRecord(c.id)) ?? null });
  });

  // ---------- world ----------
  app.post('/api/worlds/:worldId/join', async (req: Req, res) => {
    const worldId = await worldOf(req);
    const { characterId, locationId } = req.body ?? {};
    const c = await store.combat.getCharacter(String(characterId));
    if (c.ownerUserId !== caller(req).userId) throw new HttpError(403, 'forbidden', '只能讓自己的角色加入世界');
    const loc = (await store.load(worldId)).locations[String(locationId)];
    if (!loc?.outpost) throw new HttpError(400, 'bad-location', '新角色只能從據點進入世界');
    await store.join(worldId, c.id, loc.id);
    res.status(201).json((await store.viewFor(worldId, { userId: c.ownerUserId, role: 'player' })).world.characters[c.id]);
  });

  /** What this caller may see. `as=gm` gives the GM view only if the grant table says so. */
  app.get('/api/worlds/:worldId/view', async (req: Req, res) => {
    const worldId = await worldOf(req);
    const actor = actorFor(req, req.query.as);
    const v = await store.viewFor(worldId, actor);
    const after = Number(req.query.after ?? 0);
    res.json({ ...v, history: v.history.filter((e) => e.seq > after) });
  });

  app.post('/api/worlds/:worldId/commands', async (req: Req, res) => {
    const worldId = await worldOf(req);
    const { command, requestId, expected, as } = req.body ?? {};
    if (!command || typeof command.type !== 'string') throw new HttpError(400, 'bad-request', '需要 command');
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 100)) throw new HttpError(400, 'bad-request', 'requestId 必須是 100 字以內的字串');
    const actor = actorFor(req, as);
    const r = await store.submit(worldId, { actor, command: command as WorldCommand, requestId, expected }, rng, now());
    // The caller gets their own view of the outcome, never the raw state.
    const v = await store.viewFor(worldId, actor);
    const seqs = new Set(r.events.map((e) => e.seq));
    res.json({
      replayed: !!r.replayed,
      events: v.history.filter((e) => seqs.has(e.seq)),
      combatId: r.combat?.id ?? null,
      world: v.world,
    });
  });

  // ---------- combat ----------
  const combatFor = async (req: Req) => {
    const worldId = await worldOf(req);
    const combat = await store.combat.loadCombat(String(req.params.combatId));
    const { userId } = caller(req);
    const inIt = Object.values(combat.combatants).some((c) => c.controller === userId);
    if (!inIt && !gmGrant(await store.load(worldId), { userId, role: 'gm' })) throw new HttpError(403, 'forbidden', '你沒有參與這場戰鬥');
    return { worldId, combat };
  };

  /** Running combats this caller fights in; a GM of the world sees every one. */
  app.get('/api/worlds/:worldId/combats', async (req: Req, res) => {
    const worldId = await worldOf(req);
    const { userId } = caller(req);
    const gm = !!gmGrant(await store.load(worldId), { userId, role: 'gm' });
    const out = [];
    for (const id of await store.combat.activeCombatIds([`pvp-${worldId}-`, `fight-${worldId}-`])) {
      const c = await store.combat.loadCombat(id);
      if (gm || Object.values(c.combatants).some((x) => x.controller === userId)) out.push(c);
    }
    res.json(out);
  });

  /**
   * A GM starts a fight at a location: the characters there that they pick, against monsters from the bestiary.
   * Deaths in these fights are final (rules: only PvP deaths wait for a GM ruling).
   */
  app.post('/api/worlds/:worldId/combats', async (req: Req, res) => {
    const worldId = await worldOf(req);
    const { locationId, characters, monsters } = req.body ?? {};
    const s = await store.load(worldId);
    const grant = gmGrant(s, { userId: caller(req).userId, role: 'gm' });
    const loc = s.locations[String(locationId)];
    if (!loc) throw new HttpError(404, 'not-found', '找不到這個地點');
    if (!grant || !(grant.role === 'main' || (grant.role === 'scene' && grant.locations?.includes(loc.id)))) {
      throw new HttpError(403, 'forbidden', '只有主 GM 或這個地點的場景 GM 能開戰');
    }
    if (!Array.isArray(characters) || characters.length === 0 || !Array.isArray(monsters) || monsters.length === 0 || monsters.length > STEMS.length) {
      throw new HttpError(400, 'bad-request', '至少要有一位角色和一隻怪物');
    }
    const setups: CombatantSetup[] = [];
    for (const c of characters as { id: string; weaponId?: string; armorId?: string; band?: number }[]) {
      const wc = s.characters[c.id];
      if (!wc || wc.locationId !== loc.id) throw new HttpError(400, 'not-here', `${wc?.name ?? c.id} 不在${loc.name}`);
      setups.push(await store.combat.combatantFor(c.id, {
        id: c.id, side: 'party', band: c.band ?? 0, weaponId: c.weaponId ?? 'dagger', armorId: c.armorId ?? 'leather',
      }));
    }
    (monsters as { bestiaryId: string; band?: number }[]).forEach((m, i) => {
      const t = BESTIARY.find((x) => x.id === m.bestiaryId);
      if (!t) throw new HttpError(400, 'bad-request', `怪物圖鑑沒有 ${m.bestiaryId}`);
      setups.push({
        id: `m${i + 1}`, name: `${t.name}${monsters.length > 1 ? STEMS[i % STEMS.length] : ''}`, side: 'monsters', controller: 'gm',
        attributes: t.attributes, skills: t.skills, maxHp: t.maxHp, band: m.band ?? 3, weaponId: t.weaponId, armorId: t.armorId,
      });
    });
    const id = `fight-${worldId}-${Date.now().toString(36)}`;
    const combat = await store.combat.createCombat(id, setups, rng, now());
    await store.submit(worldId, {
      actor: { userId: caller(req).userId, role: 'gm' },
      command: { type: 'gmNarrate', locationId: loc.id, text: `戰鬥開始：${setups.map((x) => x.name).join('、')}` },
    }, rng, now());
    res.status(201).json(combat);
  });

  app.get('/api/worlds/:worldId/combats/:combatId', async (req: Req, res) => {
    const { combat } = await combatFor(req);
    res.json({ ...combat, events: await store.combat.events(combat.id) });
  });

  app.post('/api/worlds/:worldId/combats/:combatId/actions', async (req: Req, res) => {
    const { worldId, combat } = await combatFor(req);
    const { actionId, combatantId, round, action } = req.body ?? {};
    if (typeof actionId !== 'string' || typeof combatantId !== 'string' || typeof round !== 'number' || !action) {
      throw new HttpError(400, 'bad-request', '需要 actionId、combatantId、round 與 action');
    }
    // Monsters are moved by a GM of the world; everyone else only moves their own combatant.
    const isGm = !!gmGrant(await store.load(worldId), { userId: caller(req).userId, role: 'gm' });
    const role = combat.combatants[combatantId]?.controller === 'gm' && isGm ? 'gm' : 'player';
    const r = await store.submitCombat(worldId, combat.id, {
      actionId, combatantId, round, action: action as CombatAction, actor: { userId: caller(req).userId, role },
    }, rng, now());
    res.json({ state: r.state, events: r.events });
  });

  // ---------- service feed ----------
  /**
   * The bot's notification feed: raw history after `after`, with who owns each character and the GM grants,
   * so it can post public entries to the world channel, private ones by DM and GM entries to the GM channel.
   */
  app.get('/api/worlds/:worldId/feed', async (req: Req, res) => {
    if (caller(req).principal.kind !== 'service' || req.get('x-act-as')) throw new HttpError(403, 'forbidden', '只有服務 token 能讀取事件推播');
    const worldId = await worldOf(req);
    const s = await store.load(worldId);
    const after = Number(req.query.after ?? 0);
    res.json({
      events: await store.events(worldId, after),
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
