import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleBuild } from '../src/character/create';
import type { Database } from '../src/persistence/db';
import type { WorldStore } from '../src/persistence/world-store';
import { RULES_V03 as R } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import { createApp } from '../src/server/app';
import type { Auth } from '../src/server/auth';
import { ensureWorld, openGame } from '../src/server/boot';
import { Scheduler } from '../src/server/scheduler';
import { freshDatabaseUrl } from './helpers/db';

const T0 = new Date('2026-10-28T12:00:00Z');
const JWT_SECRET = 'test-secret-at-least-32-characters-long';
let cleanup: () => Promise<void>;
let db: Database;
let store: WorldStore;
let auth: Auth;
let server: Server;
let base: string;
let tok: Record<'p1' | 'p2' | 'gm' | 'bot', string>;

beforeEach(async () => {
  let url: string;
  ({ url, cleanup } = await freshDatabaseUrl());
  ({ db, store, auth } = await openGame(url, { supabaseJwtSecret: JWT_SECRET, dev: true }));
  await ensureWorld(store, { 'user:gm': { role: 'main' } });
  tok = {
    p1: await auth.issue('user:1', 'user'), p2: await auth.issue('user:2', 'user'),
    gm: await auth.issue('user:gm', 'user'), bot: await auth.issue('service:bot', 'service'),
  };
  // Rolls of 10 keep every check deterministic.
  server = createApp({ store, auth, rules: R, rng: () => 10, now: () => T0, corsOrigins: ['https://luz.github.io'] }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.close();
  await db.close();
  await cleanup();
});

/** A Supabase-style access token, signed with the project's (legacy, shared) JWT secret. */
const supabaseToken = (sub: string, claims: Record<string, unknown> = {}, secret = JWT_SECRET) =>
  new SignJWT({ email: 'luz@example.com', user_metadata: { user_name: 'luz' }, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
    .sign(new TextEncoder().encode(secret));

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
    expect((await call(tok.p1, 'GET', '/api/me', undefined, { 'x-act-as': 'user:2' })).status).toBe(403);
    const asP2 = await call(tok.bot, 'GET', '/api/me', undefined, { 'x-act-as': 'user:2' });
    expect(asP2.body.userId).toBe('user:2');
  });

  it('a revoked token stops working', async () => {
    await auth.revoke(tok.p1);
    expect((await call(tok.p1, 'GET', '/api/me')).status).toBe(401);
  });

  it('accepts a Supabase sign-in, and refuses one signed with the wrong key, for another audience or expired', async () => {
    const me = await call(await supabaseToken('0b6f-uuid'), 'GET', '/api/me');
    expect(me.body).toMatchObject({ userId: 'sb:0b6f-uuid', name: 'luz' });
    expect((await call(await supabaseToken('x', {}, 'another-secret-another-secret-123'), 'GET', '/api/me')).status).toBe(401);
    expect((await call(await supabaseToken('x', { aud: 'anon' }), 'GET', '/api/me')).status).toBe(401);
    expect((await call(await supabaseToken('x', { exp: Math.floor(Date.now() / 1000) - 60 }), 'GET', '/api/me')).status).toBe(401);
  });

  it('development tokens work only when the server is started in development mode', async () => {
    expect((await call('dev:luz', 'GET', '/api/me')).body.userId).toBe('dev:luz');
    const other = await freshDatabaseUrl();
    const prod = await openGame(other.url);
    expect(await prod.auth.verify('dev:luz')).toBeUndefined();
    await prod.db.close();
    await other.cleanup();
  });

  it('answers the GitHub Pages origin with CORS headers, and no other origin', async () => {
    const ok = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { origin: 'https://luz.github.io' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://luz.github.io');
    const other = await fetch(`${base}/api/me`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
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
    const outsider = await auth.issue('user:3', 'user');
    expect((await call(outsider, 'GET', `/api/worlds/greystone/combats/${cid}`)).status).toBe(403);
    expect((await call(tok.gm, 'GET', `/api/worlds/greystone/combats/${cid}`)).status).toBe(200);
  });
});

describe('bot feed and scheduler', () => {
  it('only the service token reads the raw feed, which carries owners for routing', async () => {
    const id = await enter(tok.p1, 'guardian', '灰鴉');
    await call(tok.p1, 'POST', '/api/worlds/greystone/commands', { command: { type: 'search', characterId: id } });
    expect((await call(tok.p1, 'GET', '/api/worlds/greystone/feed')).status).toBe(403);
    expect((await call(tok.bot, 'GET', '/api/worlds/greystone/feed', undefined, { 'x-act-as': 'user:1' })).status).toBe(403);
    const feed = await call(tok.bot, 'GET', '/api/worlds/greystone/feed?after=0');
    expect(feed.body.owners[id]).toBe('user:1');
    expect(feed.body.events.some((e: { visibility: string }) => e.visibility === 'private')).toBe(true);
    const later = await call(tok.bot, 'GET', `/api/worlds/greystone/feed?after=${feed.body.events.at(-1).seq}`);
    expect(later.body.events).toEqual([]);
  });

  it('runs the daily tick once per UTC date, however often it ticks', async () => {
    const sched = await Scheduler.open(store, scriptedRng([]));
    const day0 = (await store.load('greystone')).day;
    await sched.tick(new Date('2026-10-29T00:00:30Z'));
    await sched.tick(new Date('2026-10-29T00:01:30Z'));
    expect((await store.load('greystone')).day).toBe(day0 + 1);
    expect((await (await Scheduler.open(store, scriptedRng([]))).tick(new Date('2026-10-29T08:00:00Z')))[0].daily).toBe(false);
    await sched.tick(new Date('2026-10-30T00:00:30Z'));
    expect((await store.load('greystone')).day).toBe(day0 + 2);
  });

  it('a server that slept catches up on its first request, and only once per window', async () => {
    const sched = await Scheduler.open(store, scriptedRng([]));
    const day0 = (await store.load('greystone')).day;
    await Promise.all([sched.catchUp(new Date('2026-11-02T09:00:00Z')), sched.catchUp(new Date('2026-11-02T09:00:01Z'))]);
    expect((await store.load('greystone')).day).toBe(day0 + 1);
    await sched.catchUp(new Date('2026-11-03T00:00:05Z'), 60_000); // a new date, outside the window: ticks again
    expect((await store.load('greystone')).day).toBe(day0 + 2);
  });

  it('lists worlds with the outposts a new character may enter from', async () => {
    const w = await call(tok.p1, 'GET', '/api/worlds');
    expect(w.body[0]).toMatchObject({ id: 'greystone' });
    expect(w.body[0].outposts.map((o: { id: string }) => o.id)).toContain('plaza');
  });
});
