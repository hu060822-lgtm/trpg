import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/persistence/db';
import { createApp } from '../src/server/app';
import type { Auth } from '../src/server/auth';
import { openGame } from '../src/server/boot';
import { attachRealtime, RoomHub } from '../src/server/realtime';
import WebSocket from 'ws';
import { freshDatabaseUrl } from './helpers/db';

const T0 = new Date('2026-10-28T12:00:00Z');
const JWT_SECRET = 'test-secret-at-least-32-characters-long';
let cleanup: () => Promise<void>;
let db: Database;
let auth: Auth;
let server: Server;
let base: string;
let tok: Record<'p1' | 'p2' | 'gm' | 'bot', string>;

beforeEach(async () => {
  let url: string;
  let table;
  let maps;
  ({ url, cleanup } = await freshDatabaseUrl());
  ({ db, table, maps, auth } = await openGame(url, { supabaseJwtSecret: JWT_SECRET, dev: true }));
  tok = {
    p1: await auth.issue('user:1', 'user'), p2: await auth.issue('user:2', 'user'),
    gm: await auth.issue('user:gm', 'user'), bot: await auth.issue('service:bot', 'service'),
  };
  // Every die shows 10, so totals are predictable.
  const hub = new RoomHub();
  server = createApp({ table, maps, auth, hub, rng: () => 10, now: () => T0, corsOrigins: ['https://luz.github.io'] }).listen(0);
  attachRealtime(server, auth, table, hub);
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

let n = 0;
const rid = () => `req-${++n}-${Date.now()}`;

/** The GM opens a room on the example pack; player 1 joins with the code and makes a character. */
async function table3() {
  const room = (await call(tok.gm, 'POST', '/api/rooms', { name: '星期五團', pack: 'simple-d20@1.0.0' })).body;
  expect(room.code).toMatch(/^[A-Z2-9]{6}$/);
  expect((await call(tok.p1, 'POST', '/api/rooms/join', { code: room.code.toLowerCase() })).status).toBe(200);
  const hero = await call(tok.p1, 'POST', `/api/rooms/${room.id}/characters`, {
    name: '灰鴉', data: { scores: { body: 2, agility: 2, mind: 1, presence: 1 }, ranks: { melee: 2, stealth: 1 }, inputs: { armor: 1 } },
  });
  expect(hero.status).toBe(201);
  return { room, hero: hero.body };
}

describe('authentication', () => {
  it('accounts: register, sign in, sign out; names are unique and passwords are never stored in the clear', async () => {
    const reg = await call(undefined, 'POST', '/api/auth/register', { name: 'Luz', password: 'weave-the-fate' });
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({ userId: 'pw:luz', name: 'Luz' });
    expect((await call(reg.body.token, 'GET', '/api/me')).body).toMatchObject({ userId: 'pw:luz', name: 'Luz' });
    expect((await call(undefined, 'POST', '/api/auth/register', { name: 'luz', password: 'another-password' })).status).toBe(409);
    expect((await call(undefined, 'POST', '/api/auth/register', { name: 'x', password: 'weave-the-fate' })).status).toBe(400);
    expect((await call(undefined, 'POST', '/api/auth/register', { name: 'mira', password: 'short' })).status).toBe(400);
    const stored = await db.one<{ password_hash: string }>("SELECT password_hash FROM accounts WHERE name_key = 'luz'");
    expect(stored!.password_hash).not.toContain('weave-the-fate');

    const login = await call(undefined, 'POST', '/api/auth/sign-in', { name: 'LUZ', password: 'weave-the-fate' });
    expect(login.body).toMatchObject({ userId: 'pw:luz', name: 'Luz' });
    expect((await call(undefined, 'POST', '/api/auth/sign-in', { name: 'luz', password: 'wrong-password' })).status).toBe(401);
    expect((await call(login.body.token, 'POST', '/api/auth/sign-out')).status).toBe(200);
    expect((await call(login.body.token, 'GET', '/api/me')).status).toBe(401);
    expect((await call(reg.body.token, 'GET', '/api/me')).status).toBe(200);
  });

  it('slows down password guessing: five wrong tries lock the name for a minute', async () => {
    await call(undefined, 'POST', '/api/auth/register', { name: 'mira', password: 'right-password' });
    for (let i = 0; i < 5; i++) expect((await call(undefined, 'POST', '/api/auth/sign-in', { name: 'mira', password: 'nope-nope' })).status).toBe(401);
    expect((await call(undefined, 'POST', '/api/auth/sign-in', { name: 'mira', password: 'right-password' })).status).toBe(429);
  });

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

  it('without the shared secret, asks Supabase Auth who an HS256 token belongs to, and remembers the answer', async () => {
    const asked: string[] = [];
    const fake = createServer((req, res) => {
      asked.push(`${req.url} ${req.headers.apikey} ${req.headers.authorization}`);
      const good = req.headers.authorization === 'Bearer ' + goodToken;
      res.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(good ? { id: 'remote-uuid', email: 'luz@example.com', user_metadata: {} } : { msg: 'bad jwt' }));
    }).listen(0);
    await new Promise((r) => fake.once('listening', r));
    const goodToken = await supabaseToken('remote-uuid');
    const other = await freshDatabaseUrl();
    const remote = await openGame(other.url, { supabaseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, supabaseAnonKey: 'anon-key' });
    expect(await remote.auth.verify(goodToken)).toMatchObject({ userId: 'sb:remote-uuid', name: 'luz' });
    expect(await remote.auth.verify(goodToken)).toMatchObject({ userId: 'sb:remote-uuid' });
    expect(await remote.auth.verify(await supabaseToken('x', {}, 'another-secret-another-secret-123'))).toBeUndefined();
    expect(asked).toHaveLength(2);
    expect(asked[0]).toBe(`/auth/v1/user anon-key Bearer ${goodToken}`);
    fake.close();
    await remote.db.close();
    await other.cleanup();
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

describe('rule packs', () => {
  const DIR = 'packs/simple-d20';
  const zipWith = (change: Record<string, string>) => zipSync(Object.fromEntries(Object.entries({
    ...Object.fromEntries(readdirSync(DIR).map((f) => [f, readFileSync(`${DIR}/${f}`, 'utf8')])), ...change,
  }).map(([k, v]) => [k, strToU8(v)])));
  const upload = (token: string, zip: Uint8Array) => fetch(`${base}/api/packs`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' }, body: Buffer.from(zip),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }));

  it('lists the built-in pack with its licence', async () => {
    const packs = (await call(tok.p1, 'GET', '/api/packs')).body;
    expect(packs).toContainEqual(expect.objectContaining({ key: 'simple-d20@1.0.0', name: '簡易 d20', builtin: true, license: 'CC0-1.0' }));
    expect((await call(tok.p1, 'GET', '/api/packs/simple-d20@1.0.0')).body.skills).toHaveLength(8);
  });

  it('imports a zip, refuses the same version twice, and explains what is wrong with a bad one', async () => {
    const manifest = JSON.stringify({ id: 'my-game', name: '我的遊戲', version: '0.1', license: 'CC-BY-4.0' });
    expect(await upload(tok.p1, zipWith({ 'manifest.json': manifest }))).toEqual({ status: 201, body: { key: 'my-game@0.1', name: '我的遊戲' } });
    expect((await upload(tok.p2, zipWith({ 'manifest.json': manifest }))).status).toBe(409);
    const bad = await upload(tok.p1, zipWith({ 'manifest.json': manifest.replace('0.1', '0.2'), 'sheet.json': JSON.stringify({ derived: [{ id: 'hp', label: 'HP', formula: '@vigor * 2' }] }) }));
    expect(bad.status).toBe(400);
    expect(bad.body.problems).toContainEqual(expect.objectContaining({ file: 'sheet.json', path: '.derived[0].formula', message: expect.stringContaining('@vigor') }));
    expect((await upload(tok.p1, strToU8('not a zip'))).body.problems[0].message).toContain('不是有效的 zip');
  });
  it('imports an add-on that extends a stored pack, as a new pack built on it', async () => {
    const addon = zipSync({
      'manifest.json': strToU8(JSON.stringify({ id: 'srd-plus', name: '5E 追加', version: '0.1', license: 'CC-BY-4.0', extends: 'srd-5e@1.0.0' })),
      'builder.json': strToU8(JSON.stringify({ steps: [{ id: 'background', label: '背景', options: [{ id: 'farmer', name: '農夫', grants: { ranks: { nature: 1 } } }] }] })),
    });
    expect(await upload(tok.p1, addon)).toEqual({ status: 201, body: { key: 'srd-plus@0.1', name: '5E 追加' } });
    const merged = (await call(tok.p1, 'GET', '/api/packs/srd-plus@0.1')).body;
    expect(merged.manifest.basedOn).toBe('srd-5e@1.0.0');
    expect(merged.builder.find((s: any) => s.id === 'background').options.map((o: any) => o.id)).toContain('farmer');
    expect(merged.skills).toHaveLength(18);
    const orphan = zipSync({ 'manifest.json': strToU8(JSON.stringify({ id: 'lost', name: '孤兒', version: '0.1', license: 'CC0-1.0', extends: 'nope@1.0.0' })) });
    expect((await upload(tok.p1, orphan)).status).toBe(404);
  });
});

describe('the 5E pack at the table', () => {
  it('a builder character gets its sheet, features and saving throws worked out on the server', async () => {
    const room = (await call(tok.gm, 'POST', '/api/rooms', { name: '地城', pack: 'srd-5e@1.0.0' })).body;
    await call(tok.p1, 'POST', '/api/rooms/join', { code: room.code });
    const data = {
      method: 'standard', scores: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 }, ranks: {}, inputs: { level: 1 },
      choices: { class: 'fighter', background: 'soldier', species: 'dwarf' },
      picks: { 'class.skills': ['perception', 'survival'], 'class.style': ['defense'], 'background.asi': { str: 2, con: 1 } },
    };
    const missing = await call(tok.p1, 'POST', `/api/rooms/${room.id}/characters`, { name: '索林', data: { ...data, choices: { class: 'fighter' } } });
    expect(missing).toMatchObject({ status: 400, body: { message: expect.stringContaining('還沒選背景') } });
    const hero = await call(tok.p1, 'POST', `/api/rooms/${room.id}/characters`, { name: '索林', data });
    expect(hero.status).toBe(201);
    const mine = (await call(tok.p1, 'GET', `/api/rooms/${room.id}`)).body.characters[0];
    expect(mine.data.picks['background.asi']).toEqual({ str: 2, con: 1 });
    expect(mine.sheet['score.str']).toEqual({ value: 17, text: '15 + 2' });
    expect(mine.sheet.hp.value).toBe(13);
    expect(mine.sheet.spell_dc.hidden).toBe(true);
    expect(mine.hiddenActions).toEqual(['spell']);
    expect(mine.features).toContainEqual(expect.objectContaining({ name: '二度活力', from: '戰士' }));
    const save = await call(tok.p1, 'POST', `/api/rooms/${room.id}/rolls`, { requestId: rid(), characterId: hero.body.id, check: { attribute: 'con', extra: 'save' } });
    expect(save.body).toMatchObject({ body: { label: '索林：體質豁免', total: 10 + 2 + 2 } });
    const story = { ...data, texts: { backstory: '  在山下的礦坑長大。  ', bonds: '要找回家族的戰錘', diary: '秘密', notes: '   ' } };
    const up = await call(tok.p1, 'PATCH', `/api/rooms/${room.id}/characters/${hero.body.id}`, { version: 1, data: story });
    expect(up).toMatchObject({ status: 400, body: { message: expect.stringContaining('沒有「diary」這個文字欄位') } });
    delete (story.texts as Record<string, string>).diary;
    expect((await call(tok.p1, 'PATCH', `/api/rooms/${room.id}/characters/${hero.body.id}`, { version: 1, data: story })).body.data.texts)
      .toEqual({ backstory: '在山下的礦坑長大。', bonds: '要找回家族的戰錘' });
    const long = { ...data, texts: { alignment: '守'.repeat(41) } };
    expect((await call(tok.p1, 'PATCH', `/api/rooms/${room.id}/characters/${hero.body.id}`, { version: 2, data: long })).body.message).toContain('陣營最多 40 字');
  });
});

describe('rooms', () => {
  it('a room has a code to join; only members can see it, and the creator is its GM', async () => {
    const { room } = await table3();
    expect((await call(tok.p2, 'GET', `/api/rooms/${room.id}`)).status).toBe(403);
    const view = (await call(tok.p1, 'GET', `/api/rooms/${room.id}`)).body;
    expect(view.me).toMatchObject({ userId: 'user:1', role: 'player' });
    expect(view.members.map((m: any) => [m.userId, m.role])).toEqual([['user:gm', 'gm'], ['user:1', 'player']]);
    expect((await call(tok.p1, 'GET', '/api/rooms')).body).toContainEqual(expect.objectContaining({ id: room.id, role: 'player', packName: '簡易 d20' }));
    expect((await call(tok.p1, 'POST', '/api/rooms/join', { code: 'ZZZZZZ' })).status).toBe(404);
  });

  it('works out sheets on the server; players see their own sheet and only the names of others', async () => {
    const { room, hero } = await table3();
    await call(tok.p2, 'POST', '/api/rooms/join', { code: room.code });
    const mine = (await call(tok.p1, 'GET', `/api/rooms/${room.id}`)).body.characters[0];
    expect(mine.sheet.defense).toEqual({ value: 13, text: '10 + 靈巧 2 + 護甲加值 1' });
    const theirs = (await call(tok.p2, 'GET', `/api/rooms/${room.id}`)).body.characters[0];
    expect(theirs).toEqual({ id: hero.id, ownerUserId: 'user:1', name: '灰鴉' });
    expect((await call(tok.gm, 'GET', `/api/rooms/${room.id}`)).body.characters[0].sheet.hp.value).toBe(14);
  });

  it('holds new characters to the creation budget and edits to a version check', async () => {
    const { room, hero } = await table3();
    const over = await call(tok.p1, 'POST', `/api/rooms/${room.id}/characters`, { name: '太強', data: { scores: { body: 4, agility: 4 } } });
    expect(over).toMatchObject({ status: 400, body: { message: expect.stringContaining('屬性點數用了') } });
    const up = await call(tok.p1, 'PATCH', `/api/rooms/${room.id}/characters/${hero.id}`, { version: 1, data: { ...hero.data, inputs: { level: 2, armor: 1 } } });
    expect(up.body.version).toBe(2);
    expect((await call(tok.p1, 'PATCH', `/api/rooms/${room.id}/characters/${hero.id}`, { version: 1, name: 'x' })).status).toBe(409);
    await call(tok.p2, 'POST', '/api/rooms/join', { code: room.code });
    expect((await call(tok.p2, 'PATCH', `/api/rooms/${room.id}/characters/${hero.id}`, { version: 2, name: '偷改' })).status).toBe(403);
    expect((await call(tok.gm, 'PATCH', `/api/rooms/${room.id}/characters/${hero.id}`, { version: 2, name: '灰鴉二世' })).status).toBe(200);
  });

  it('chat, /r and sheet rolls go into one log, each roll with its breakdown; a resend does not roll twice', async () => {
    const { room, hero } = await table3();
    await call(tok.p1, 'POST', `/api/rooms/${room.id}/chat`, { text: '有人在嗎？', requestId: rid() });
    const free = (await call(tok.p1, 'POST', `/api/rooms/${room.id}/chat`, { text: '/r 2d6+3', requestId: rid() })).body;
    expect(free.body).toMatchObject({ label: '擲骰', text: '2d6[10,10] + 3', total: 23 });
    const req = rid();
    const atk = (await call(tok.p1, 'POST', `/api/rooms/${room.id}/rolls`, { characterId: hero.id, action: 'melee_attack', requestId: req })).body;
    expect(atk.body).toMatchObject({ label: '灰鴉：近戰攻擊', text: '1d20[10] + 體魄 2 + 近戰 2', total: 14, damage: { text: '1d8[10] + 體魄 2', total: 12 } });
    const again = (await call(tok.p1, 'POST', `/api/rooms/${room.id}/rolls`, { characterId: hero.id, action: 'melee_attack', requestId: req })).body;
    expect(again.seq).toBe(atk.seq);
    const check = (await call(tok.p1, 'POST', `/api/rooms/${room.id}/rolls`, { characterId: hero.id, check: { skill: 'stealth' }, mode: 'advantage', requestId: rid() })).body;
    expect(check.body).toMatchObject({ label: '灰鴉：潛行檢定（優勢）', total: 13 });
    const log = (await call(tok.gm, 'GET', `/api/rooms/${room.id}/log`)).body;
    expect(log.map((e: any) => e.kind)).toEqual(['system', 'system', 'system', 'chat', 'roll', 'roll', 'roll']);
    expect((await call(tok.gm, 'GET', `/api/rooms/${room.id}/log?after=${atk.seq}`)).body).toHaveLength(1);
  });

  it("only the owner or a GM rolls for a character; a /gr roll is seen by GMs and the roller only", async () => {
    const { room, hero } = await table3();
    await call(tok.p2, 'POST', '/api/rooms/join', { code: room.code });
    expect((await call(tok.p2, 'POST', `/api/rooms/${room.id}/rolls`, { characterId: hero.id, action: 'melee_attack', requestId: rid() })).status).toBe(403);
    expect((await call(tok.gm, 'POST', `/api/rooms/${room.id}/rolls`, { characterId: hero.id, check: { attribute: 'mind' }, requestId: rid() })).status).toBe(200);
    const secret = (await call(tok.gm, 'POST', `/api/rooms/${room.id}/chat`, { text: '/gr 1d20', requestId: rid() })).body;
    expect(secret.body.secret).toBe(true);
    const seenBy = async (t: string) => (await call(t, 'GET', `/api/rooms/${room.id}/log`)).body.some((e: any) => e.seq === secret.seq);
    expect([await seenBy(tok.gm), await seenBy(tok.p1), await seenBy(tok.p2)]).toEqual([true, false, false]);
  });

  it('a bad formula is a 400 with a message the player can act on', async () => {
    const { room } = await table3();
    const r = await call(tok.p1, 'POST', `/api/rooms/${room.id}/chat`, { text: '/r 2d6+', requestId: rid() });
    expect(r).toMatchObject({ status: 400, body: { error: 'bad-formula', message: expect.stringContaining('不完整') } });
    expect((await call(tok.p1, 'POST', `/api/rooms/${room.id}/chat`, { text: 'hi' })).status).toBe(400);
  });

  it('GMs can make other members GMs, and a room always keeps at least one', async () => {
    const { room } = await table3();
    expect((await call(tok.p1, 'POST', `/api/rooms/${room.id}/members/user:gm`, { role: 'player' })).status).toBe(403);
    expect((await call(tok.gm, 'POST', `/api/rooms/${room.id}/members/user:gm`, { role: 'player' })).body.error).toBe('last-gm');
    expect((await call(tok.gm, 'POST', `/api/rooms/${room.id}/members/user:1`, { role: 'gm' })).status).toBe(200);
    expect((await call(tok.p1, 'GET', `/api/rooms/${room.id}`)).body.me.role).toBe('gm');
  });
});

describe('maps', () => {
  /** The GM's map with player 1's character token on it and a hidden goblin. */
  async function mapTable() {
    const t = await table3();
    await call(tok.p2, 'POST', '/api/rooms/join', { code: t.room.code });
    const map = await call(tok.gm, 'POST', `/api/rooms/${t.room.id}/maps`, { name: '地窖', cols: 10, rows: 8 });
    expect(map.status).toBe(201);
    return { ...t, map: map.body, url: `/api/rooms/${t.room.id}/maps/${map.body.id}` };
  }

  it('only GMs make maps; the first map opens itself and players see only the open map', async () => {
    const { room, map, url } = await mapTable();
    expect((await call(tok.p1, 'POST', `/api/rooms/${room.id}/maps`, { name: '偷做' })).status).toBe(403);
    expect((await call(tok.p1, 'GET', `/api/rooms/${room.id}`)).body.room.activeMapId).toBe(map.id);
    const second = (await call(tok.gm, 'POST', `/api/rooms/${room.id}/maps`, { name: '森林', cols: 5, rows: 5 })).body;
    expect((await call(tok.p1, 'GET', `/api/rooms/${room.id}/maps`)).body.maps.map((m: any) => m.name)).toEqual(['地窖']);
    expect((await call(tok.gm, 'GET', `/api/rooms/${room.id}/maps`)).body.maps).toHaveLength(2);
    expect((await call(tok.p1, 'GET', `/api/rooms/${room.id}/maps/${second.id}`)).status).toBe(403);
    await call(tok.gm, 'POST', `/api/rooms/${room.id}/maps/${second.id}/activate`);
    expect((await call(tok.p1, 'GET', `/api/rooms/${room.id}/maps/${second.id}`)).status).toBe(200);
    expect((await call(tok.p1, 'GET', url)).status).toBe(403);
    expect((await call(tok.p1, 'GET', `/api/rooms/${room.id}/log`)).body.at(-1).body.text).toBe('GM 打開了地圖「森林」');
  });

  it('players place and move only their own character tokens, inside the grid', async () => {
    const { room, hero, url } = await mapTable();
    expect((await call(tok.p1, 'POST', `${url}/tokens`, { name: '路人', x: 1, y: 1 })).status).toBe(403);
    const mine = await call(tok.p1, 'POST', `${url}/tokens`, { characterId: hero.id, x: 2, y: 3 });
    expect(mine).toMatchObject({ status: 201, body: { name: '灰鴉', x: 2, y: 3, ownerUserId: 'user:1', hidden: false } });
    expect((await call(tok.p1, 'POST', `${url}/tokens`, { characterId: hero.id })).status).toBe(409);
    const moved = await call(tok.p1, 'PATCH', `/api/rooms/${room.id}/tokens/${mine.body.id}`, { x: 99, y: -4 });
    expect(moved.body).toMatchObject({ x: 9, y: 0 });
    expect((await call(tok.p2, 'PATCH', `/api/rooms/${room.id}/tokens/${mine.body.id}`, { x: 1 })).status).toBe(403);
    expect((await call(tok.p1, 'PATCH', `/api/rooms/${room.id}/tokens/${mine.body.id}`, { hidden: true })).status).toBe(403);
    expect((await call(tok.gm, 'PATCH', `/api/rooms/${room.id}/tokens/${mine.body.id}`, { x: 4, y: 4, size: 2 })).body).toMatchObject({ x: 4, y: 4, size: 2 });
  });

  it('players never receive hidden tokens or tokens under fog; GMs see everything', async () => {
    const { url } = await mapTable();
    await call(tok.gm, 'POST', `${url}/tokens`, { name: '哥布林', x: 1, y: 1, hidden: true, color: '#d4505e' });
    await call(tok.gm, 'POST', `${url}/tokens`, { name: '石像', x: 5, y: 5 });
    expect((await call(tok.p2, 'GET', url)).body.tokens.map((t: any) => t.name)).toEqual(['石像']);
    await call(tok.gm, 'PATCH', url, { fogEnabled: true });
    expect((await call(tok.p2, 'GET', url)).body.tokens).toEqual([]);
    const revealed = await call(tok.gm, 'POST', `${url}/fog`, { cells: [5 * 10 + 5], covered: false });
    expect(revealed.body.fog[55]).toBe('0');
    expect((await call(tok.p2, 'GET', url)).body.tokens.map((t: any) => t.name)).toEqual(['石像']);
    expect((await call(tok.p2, 'POST', `${url}/fog`, { cells: 'all', covered: false })).status).toBe(403);
    expect((await call(tok.gm, 'GET', url)).body.tokens).toHaveLength(2);
  });

  it('only GMs lay out scenery; players get objects that are visible and partly out of the fog', async () => {
    const { room, url } = await mapTable();
    const wall = await call(tok.gm, 'POST', `${url}/objects`, { kind: 'wall', x: 2, y: 2, w: 4, h: 1 });
    expect(wall.status).toBe(201);
    expect(wall.body).toMatchObject({ kind: 'wall', x: 2, y: 2, w: 4, h: 1, rotation: 0, hidden: false });
    await call(tok.gm, 'POST', `${url}/objects`, { kind: 'trap', x: 7, y: 6, hidden: true, name: '落穴' });
    expect((await call(tok.p1, 'POST', `${url}/objects`, { kind: 'chest', x: 1, y: 1 })).status).toBe(403);
    expect((await call(tok.gm, 'POST', `${url}/objects`, { kind: 'spaceship' })).status).toBe(400);
    expect((await call(tok.p1, 'GET', url)).body.objects.map((o: any) => o.kind)).toEqual(['wall']);
    // Fog over the whole wall hides it; uncovering one of its squares shows all of it.
    await call(tok.gm, 'PATCH', url, { fogEnabled: true });
    expect((await call(tok.p1, 'GET', url)).body.objects).toEqual([]);
    await call(tok.gm, 'POST', `${url}/fog`, { cells: [2 * 10 + 5], covered: false });
    expect((await call(tok.p1, 'GET', url)).body.objects).toHaveLength(1);
    // Turned and stretched past the edge, it stays on the grid.
    const moved = await call(tok.gm, 'PATCH', `/api/rooms/${room.id}/objects/${wall.body.id}`, { x: 9, w: 1, h: 6, rotation: 90 });
    expect(moved.body).toMatchObject({ x: 9, y: 2, w: 1, h: 6, rotation: 90 });
    expect((await call(tok.gm, 'PATCH', `/api/rooms/${room.id}/objects/${wall.body.id}`, { rotation: 45 })).status).toBe(400);
    expect((await call(tok.p1, 'DELETE', `/api/rooms/${room.id}/objects/${wall.body.id}`)).status).toBe(403);
    expect((await call(tok.gm, 'DELETE', `/api/rooms/${room.id}/objects/${wall.body.id}`)).status).toBe(200);
    expect((await call(tok.gm, 'GET', url)).body.objects.map((o: any) => o.name)).toEqual(['落穴']);
  });

  it('keeps fog where a resized grid overlaps and clamps tokens back onto it', async () => {
    const { url } = await mapTable();
    await call(tok.gm, 'POST', `${url}/fog`, { cells: 'all', covered: false });
    const goblin = (await call(tok.gm, 'POST', `${url}/tokens`, { name: '哥布林', x: 9, y: 7 })).body;
    const small = (await call(tok.gm, 'PATCH', url, { cols: 4, rows: 3, cellDistance: 1.5, unit: '公尺' })).body;
    expect(small).toMatchObject({ cols: 4, rows: 3, cellDistance: 1.5, unit: '公尺', fog: '0'.repeat(12) });
    const grown = (await call(tok.gm, 'PATCH', url, { cols: 5 })).body;
    expect(grown.fog).toBe('00001'.repeat(3));
    expect((await call(tok.gm, 'GET', url)).body.tokens.find((t: any) => t.id === goblin.id)).toMatchObject({ x: 3, y: 2 });
    expect((await call(tok.gm, 'PATCH', url, { cols: 101 })).status).toBe(400);
  });

  it('stores a picture for the map and serves it only to those who may see the map', async () => {
    const { room, url } = await mapTable();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await fetch(base + `${url}/image`, { method: 'PUT', headers: { authorization: `Bearer ${tok.gm}`, 'content-type': 'image/png' }, body: png });
    expect((await up.json() as any).imageVersion).toBe(1);
    const got = await fetch(base + `${url}/image`, { headers: { authorization: `Bearer ${tok.p1}` } });
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(png);
    const bad = await fetch(base + `${url}/image`, { method: 'PUT', headers: { authorization: `Bearer ${tok.gm}`, 'content-type': 'text/html' }, body: '<script>' });
    expect(bad.status).toBe(400);
    const outsider = await fetch(base + `${url}/image`, { headers: { authorization: `Bearer ${tok.bot}` } });
    expect(outsider.status).toBe(403);
    expect((await call(tok.gm, 'DELETE', url)).status).toBe(200);
    expect((await call(tok.gm, 'GET', `/api/rooms/${room.id}`)).body.room.activeMapId).toBeNull();
  });

  it('tells members watching the room what changed, over a WebSocket', async () => {
    const { room, url } = await mapTable();
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const got: any[] = [];
    await new Promise((resolve) => ws.on('open', resolve));
    ws.on('message', (m) => got.push(JSON.parse(String(m))));
    ws.send(JSON.stringify({ token: tok.p1, room: room.id }));
    await expect.poll(() => got).toContainEqual({ type: 'ready' });
    await call(tok.gm, 'POST', `${url}/tokens`, { name: '石像', x: 5, y: 5 });
    await call(tok.gm, 'POST', `/api/rooms/${room.id}/chat`, { text: '/r 1d20', requestId: rid() });
    await expect.poll(() => got.map((e) => e.type)).toEqual(['ready', 'map', 'log']);
    ws.close();

    const stranger = new WebSocket(base.replace('http', 'ws') + '/ws');
    await new Promise((resolve) => stranger.on('open', resolve));
    const closed = new Promise<number>((resolve) => stranger.on('close', (code) => resolve(code)));
    stranger.send(JSON.stringify({ token: tok.bot, room: room.id }));
    expect(await closed).toBe(4001);
  });
});
