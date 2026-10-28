import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import seed from '../config/world-seed.json';
import { exampleBuild } from '../src/character/create';
import { CombatStore } from '../src/persistence/combat-store';
import { WorldStore } from '../src/persistence/world-store';
import { RULES_V03 as R } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import { createApp } from '../src/server/app';
import { Tokens } from '../src/server/auth';
import { Scheduler } from '../src/server/scheduler';
import type { WorldSeed } from '../src/world/engine';

const T0 = new Date('2026-10-28T12:00:00Z');
let store: WorldStore;
let tokens: Tokens;
let server: Server;
let base: string;
let tok: Record<'p1' | 'p2' | 'gm' | 'bot', string>;

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fw-server-')), 'game.db');
  store = new WorldStore(new CombatStore(path, R), R);
  tokens = new Tokens(store.combat.db);
  store.createWorld(seed as WorldSeed, { 'discord:gm': { role: 'main' } });
  tok = {
    p1: tokens.issue('discord:1', 'user'), p2: tokens.issue('discord:2', 'user'),
    gm: tokens.issue('discord:gm', 'user'), bot: tokens.issue('service:discord', 'service'),
  };
  // Rolls of 10 keep every check deterministic.
  server = createApp({ store, tokens, rules: R, rng: () => 10, now: () => T0 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { server.close(); store.combat.close(); });

async function call(token: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

/** Creates a character for a token's user and walks it into the world at the plaza. */
async function enter(token: string, classId: string, name: string) {
  const c = await call(token, 'POST', '/api/characters', { draft: { ...exampleBuild(classId, R), name } });
  expect(c.status).toBe(201);
  const j = await call(token, 'POST', '/api/worlds/greystone/join', { characterId: c.body.id, locationId: 'plaza' });
  expect(j.status).toBe(201);
  return c.body.id as string;
}

describe('authentication', () => {
  it('needs a token, and only the bot may act on behalf of someone else', async () => {
    expect((await call(undefined, 'GET', '/api/me')).status).toBe(401);
    expect((await call('fw_u_forged', 'GET', '/api/me')).status).toBe(401);
    expect((await call(tok.p1, 'GET', '/api/me', undefined, { 'x-act-as': 'discord:2' })).status).toBe(403);
    const asP2 = await call(tok.bot, 'GET', '/api/me', undefined, { 'x-act-as': 'discord:2' });
    expect(asP2.body.userId).toBe('discord:2');
  });

  it('a revoked token stops working', async () => {
    tokens.revoke(tok.p1);
    expect((await call(tok.p1, 'GET', '/api/me')).status).toBe(401);
  });
});

describe('characters and joining', () => {
  it('validates the build, and new characters enter only at an outpost', async () => {
    const bad = await call(tok.p1, 'POST', '/api/characters', { draft: { ...exampleBuild('guardian', R), skills: {} } });
    expect(bad.status).toBe(400);
    const c = await call(tok.p1, 'POST', '/api/characters', { draft: { ...exampleBuild('guardian', R), name: '灰鴉' } });
    expect((await call(tok.p1, 'POST', '/api/worlds/greystone/join', { characterId: c.body.id, locationId: 'ruins' })).status).toBe(400);
    expect((await call(tok.p2, 'POST', '/api/worlds/greystone/join', { characterId: c.body.id, locationId: 'plaza' })).status).toBe(403);
    expect((await call(tok.p1, 'POST', '/api/worlds/greystone/join', { characterId: c.body.id, locationId: 'plaza' })).status).toBe(201);
    const me = await call(tok.p1, 'GET', '/api/me');
    expect(me.body.characters.map((x: { name: string }) => x.name)).toEqual(['灰鴉']);
  });

  it('a character sheet is for its owner and GMs only', async () => {
    const id = await enter(tok.p1, 'guardian', '灰鴉');
    expect((await call(tok.p1, 'GET', `/api/characters/${id}`)).status).toBe(200);
    expect((await call(tok.p2, 'GET', `/api/characters/${id}`)).status).toBe(403);
    expect((await call(tok.gm, 'GET', `/api/characters/${id}`)).status).toBe(200);
  });
});

describe('world view and commands', () => {
  it('players get the redacted view; asking for the GM view without a grant gets nothing extra', async () => {
    await enter(tok.p1, 'guardian', '灰鴉');
    const p = await call(tok.p1, 'GET', '/api/worlds/greystone/view');
    expect(p.body.world.locations.plaza.gmNotes).toBe('');
    const fake = await call(tok.p1, 'GET', '/api/worlds/greystone/view?as=gm');
    expect(fake.body.world.locations.plaza.gmNotes).toBe('');
    expect(fake.body.audit).toEqual([]);
    const gm = await call(tok.gm, 'GET', '/api/worlds/greystone/view?as=gm');
    expect(gm.body.world.locations.plaza.gmNotes).not.toBe('');
  });

  it('GM commands need a grant; the system role can never be claimed', async () => {
    const forged = await call(tok.p1, 'POST', '/api/worlds/greystone/commands', { as: 'gm', command: { type: 'gmPublish', title: 'x', body: 'x' } });
    expect(forged.status).toBe(403);
    expect((await call(tok.p1, 'POST', '/api/worlds/greystone/commands', { as: 'system', command: { type: 'advanceDay' } })).status).toBe(400);
    const ok = await call(tok.gm, 'POST', '/api/worlds/greystone/commands', { as: 'gm', command: { type: 'gmPublish', title: '鐘聲', body: '第一聲鐘響' } });
    expect(ok.status).toBe(200);
    const seen = await call(tok.p1, 'GET', '/api/worlds/greystone/view');
    expect(seen.body.history.map((e: { kind: string }) => e.kind)).toContain('worldEvent');
  });

  it('a value-moving command needs a request id, and a retry is not applied twice', async () => {
    const id = await enter(tok.p1, 'guardian', '灰鴉');
    const grant = { as: 'gm', command: { type: 'gmGrantCoins', characterId: id, amount: 10, reason: '起始資金' } };
    expect((await call(tok.gm, 'POST', '/api/worlds/greystone/commands', grant)).body.error).toBe('request-id-required');
    const first = await call(tok.gm, 'POST', '/api/worlds/greystone/commands', { ...grant, requestId: 'g-1' });
    const again = await call(tok.gm, 'POST', '/api/worlds/greystone/commands', { ...grant, requestId: 'g-1' });
    expect([first.body.replayed, again.body.replayed]).toEqual([false, true]);
    const me = await call(tok.p1, 'GET', '/api/worlds/greystone/view');
    expect(me.body.world.characters[id].coins).toBe(10);
    expect(me.body.ledger).toHaveLength(1);
  });

  it("one player cannot command another player's character", async () => {
    const id = await enter(tok.p1, 'guardian', '灰鴉');
    await enter(tok.p2, 'scout', '夜鶯');
    const r = await call(tok.p2, 'POST', '/api/worlds/greystone/commands', { command: { type: 'move', characterId: id, to: 'market' } });
    expect(r.status).toBe(403);
  });
});

describe('PvP combat through the API', () => {
  it('a legal attack opens a combat that only its participants and GMs can read', async () => {
    const a = await enter(tok.p1, 'guardian', '灰鴉');
    const b = await enter(tok.p2, 'scout', '夜鶯');
    for (const [t, id] of [[tok.p1, a], [tok.p2, b]] as const) {
      await call(t, 'POST', '/api/worlds/greystone/commands', { command: { type: 'move', characterId: id, to: 'market' } });
      await call(t, 'POST', '/api/worlds/greystone/commands', { command: { type: 'move', characterId: id, to: 'road' } });
    }
    const atk = await call(tok.p1, 'POST', '/api/worlds/greystone/commands', { command: { type: 'attack', characterId: a, targetId: b } });
    expect(atk.status).toBe(200);
    const cid = atk.body.combatId as string;
    expect(cid).toMatch(/^pvp-/);
    expect((await call(tok.p2, 'GET', `/api/worlds/greystone/combats/${cid}`)).status).toBe(200);
    const outsider = tokens.issue('discord:3', 'user');
    expect((await call(outsider, 'GET', `/api/worlds/greystone/combats/${cid}`)).status).toBe(403);
    expect((await call(tok.gm, 'GET', `/api/worlds/greystone/combats/${cid}`)).status).toBe(200);
  });
});

describe('bot feed and scheduler', () => {
  it('only the service token reads the raw feed, which carries owners for routing', async () => {
    const id = await enter(tok.p1, 'guardian', '灰鴉');
    await call(tok.p1, 'POST', '/api/worlds/greystone/commands', { command: { type: 'search', characterId: id } });
    expect((await call(tok.p1, 'GET', '/api/worlds/greystone/feed')).status).toBe(403);
    expect((await call(tok.bot, 'GET', '/api/worlds/greystone/feed', undefined, { 'x-act-as': 'discord:1' })).status).toBe(403);
    const feed = await call(tok.bot, 'GET', '/api/worlds/greystone/feed?after=0');
    expect(feed.body.owners[id]).toBe('discord:1');
    expect(feed.body.events.some((e: { visibility: string }) => e.visibility === 'private')).toBe(true);
    const later = await call(tok.bot, 'GET', `/api/worlds/greystone/feed?after=${feed.body.events.at(-1).seq}`);
    expect(later.body.events).toEqual([]);
  });

  it('runs the daily tick once per UTC date, however often it ticks', () => {
    const sched = new Scheduler(store, scriptedRng([]));
    const day0 = store.load('greystone').day;
    sched.tick(new Date('2026-10-29T00:00:30Z'));
    sched.tick(new Date('2026-10-29T00:01:30Z'));
    expect(store.load('greystone').day).toBe(day0 + 1);
    expect(new Scheduler(store, scriptedRng([])).tick(new Date('2026-10-29T08:00:00Z'))[0].daily).toBe(false);
    sched.tick(new Date('2026-10-30T00:00:30Z'));
    expect(store.load('greystone').day).toBe(day0 + 2);
  });
});
