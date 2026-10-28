import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import seed from '../config/world-seed.json';
import { createCharacter, exampleBuild } from '../src/character/create';
import { GameApi } from '../src/bot/api';
import { COMMANDS, handleCommand, type CommandInput } from '../src/bot/commands';
import { embed, type Reply } from '../src/bot/format';
import { Notifier, route, type Outgoing } from '../src/bot/notifier';
import { CombatStore } from '../src/persistence/combat-store';
import { WorldStore } from '../src/persistence/world-store';
import { RULES_V03 as R } from '../src/rules/config';
import { scriptedRng } from '../src/rules/dice';
import { createApp } from '../src/server/app';
import { Tokens } from '../src/server/auth';
import type { WorldSeed } from '../src/world/engine';

const T0 = new Date('2026-10-28T12:00:00Z');
let store: WorldStore;
let server: Server;
let api: GameApi;

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fw-bot-')), 'game.db');
  store = new WorldStore(new CombatStore(path, R), R);
  const tokens = new Tokens(store.combat.db);
  store.createWorld(seed as WorldSeed, { 'discord:100': { role: 'main' }, 'discord:300': { role: 'arbiter' }, 'discord:400': { role: 'scene', locations: ['ruins'] } });
  store.combat.saveNewCharacter('discord:1', createCharacter({ ...exampleBuild('guardian', R), name: '灰鴉' }, R, T0, 'crow'));
  store.combat.saveNewCharacter('discord:2', createCharacter({ ...exampleBuild('scout', R), name: '夜鶯' }, R, T0, 'nightingale'));
  store.join('greystone', 'crow', 'ruins');
  store.join('greystone', 'nightingale', 'ruins');
  server = createApp({ store, tokens, rules: R, rng: () => 10, now: () => T0 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  api = new GameApi(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokens.issue('service:discord', 'service'));
});
afterEach(() => { server.close(); store.combat.close(); });

const run = (userId: string, command: string, options: CommandInput['options'] = {}, sub?: string) =>
  handleCommand(api, 'greystone', { userId, command, sub, options });
const text = (r: Reply) => JSON.stringify(r.embeds);
const send = (userId: string, command: object, requestId?: string) =>
  store.submit('greystone', { actor: { userId: `discord:${userId}`, role: 'player' }, command: command as never, requestId }, () => 10, T0);

describe('player commands', () => {
  it('show the caller\'s own character privately', async () => {
    const r = await run('1', 'me');
    expect(r.ephemeral).toBe(true);
    expect(text(r)).toContain('灰鴉');
    expect(text(r)).toContain('沉鐘遺跡');
    expect(text(r)).toContain('HP');
  });

  it('a user without a character is told how to start', async () => {
    expect(text(await run('999', 'me'))).toContain('還沒有角色');
  });

  it('look shows what anyone there could see, never hidden items or GM notes', async () => {
    const t = text(await run('1', 'look'));
    expect(t).toContain('夜鶯');
    expect(t).toContain('沉鐘之心');
    expect(t).not.toContain('褪色的地圖'); // hidden, not yet found
    expect(t).not.toContain('第二道封印'); // GM note
  });

  it('bag and log never leak another player\'s belongings or private results', async () => {
    send('2', { type: 'take', characterId: 'nightingale', itemId: 'bell-heart' });
    send('2', { type: 'search', characterId: 'nightingale' });
    expect(text(await run('2', 'bag'))).toContain('沉鐘之心');
    expect(text(await run('1', 'bag'))).not.toContain('沉鐘之心');
    const mine = text(await run('2', 'log'));
    const theirs = text(await run('1', 'log'));
    expect(mine).toContain('私人');
    expect(theirs).not.toContain('私人');
  });

  it('sheet shows attributes and skills by their Chinese names', async () => {
    const t = text(await run('2', 'sheet'));
    expect(t).toContain('敏捷');
    expect(t).toContain('潛行');
  });

  it('team and deals show only the caller\'s own', async () => {
    send('1', { type: 'createTeam', characterId: 'crow', teamId: 'crows', name: '鴉群', policy: 'leader' }, 'r1');
    expect(text(await run('1', 'team'))).toContain('鴉群');
    expect(text(await run('2', 'team'))).toContain('沒有隊伍');
  });
});

describe('GM commands', () => {
  it('are refused to players', async () => {
    expect(text(await run('1', 'gm', {}, 'rulings'))).toContain('不是這個世界的 GM');
  });

  it('the main GM sees everyone\'s whereabouts and the audit trail; other GMs do not', async () => {
    const where = text(await run('100', 'gm', {}, 'where'));
    expect(where).toContain('灰鴉');
    expect(where).toContain('夜鶯');
    expect(text(await run('100', 'gm', {}, 'audit'))).toContain('稽核');
    expect(text(await run('300', 'gm', {}, 'where'))).toContain('只有主 GM');
    expect(text(await run('400', 'gm', {}, 'audit'))).toContain('只有主 GM');
  });

  it('an arbiter sees open rulings and disputes', async () => {
    send('1', { type: 'take', characterId: 'crow', itemId: 'bell-heart' });
    store.submit('greystone', { actor: { userId: 'discord:2', role: 'player' }, command: { type: 'steal', characterId: 'nightingale', targetId: 'crow', itemId: 'bell-heart' } }, scriptedRng([20, 20, 1, 1, 1, 1]), T0);
    const t = text(await run('300', 'gm', {}, 'rulings'));
    expect(t).toMatch(/唯一物品被偷/);
  });
});

describe('notifications', () => {
  it('routes public entries to the world channel, GM entries to the GM channel and the rest by DM', () => {
    const out = route({
      owners: { crow: 'discord:1', nightingale: 'discord:2', npcish: 'not-discord' },
      gms: {},
      events: [
        { seq: 1, day: 1, at: '', kind: 'worldEvent', actor: { userId: 'x', role: 'gm' }, text: '鐘響', visibility: 'public', audience: [], data: {} },
        { seq: 2, day: 1, at: '', kind: 'x', actor: { userId: 'x', role: 'gm' }, text: '密報', visibility: 'gm', audience: [], data: {} },
        { seq: 3, day: 1, at: '', kind: 'x', actor: { userId: 'x', role: 'player' }, text: '有人走來', visibility: 'scene', audience: ['crow', 'nightingale', 'npcish'], data: {} },
        { seq: 4, day: 1, at: '', kind: 'x', actor: { userId: 'x', role: 'player' }, text: '你找到了', visibility: 'private', audience: ['crow'], data: {} },
      ],
    });
    expect(out.map((m) => [m.seq, m.to])).toEqual([
      [1, { kind: 'world' }], [2, { kind: 'gm' }], [3, { kind: 'dm', discordId: '1' }], [3, { kind: 'dm', discordId: '2' }], [4, { kind: 'dm', discordId: '1' }],
    ]);
  });

  it('delivers each entry once, and a failed DM does not hold up the rest', async () => {
    let cursor = 0;
    const sent: Outgoing[] = [];
    const n = new Notifier(api, 'greystone', async (m) => {
      if (m.to.kind === 'dm' && m.to.discordId === '2') throw new Error('DMs closed');
      sent.push(m);
    }, { load: () => cursor, save: (s) => { cursor = s; } });
    send('1', { type: 'search', characterId: 'crow' });
    store.submit('greystone', { actor: { userId: 'discord:100', role: 'gm' }, command: { type: 'gmPublish', title: '鐘聲', body: '第一聲鐘響' } }, scriptedRng([]), T0);
    await n.poll();
    expect(sent.some((m) => m.to.kind === 'world' && m.text.includes('鐘'))).toBe(true);
    expect(sent.some((m) => m.to.kind === 'dm' && m.to.discordId === '1')).toBe(true);
    const before = sent.length;
    await n.poll();
    expect(sent.length).toBe(before);
  });
});

describe('Discord limits', () => {
  it('command definitions are valid for registration', () => {
    for (const c of COMMANDS) {
      expect(c.name).toMatch(/^[a-z]{1,32}$/);
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('embeds are cut to Discord\'s size limits', () => {
    const e = embed({ title: 'x'.repeat(300), description: 'y'.repeat(5000), fields: Array.from({ length: 30 }, () => ({ name: 'n', value: 'v'.repeat(2000) })) });
    expect(e.title.length).toBe(256);
    expect(e.description!.length).toBe(4096);
    expect(e.fields).toHaveLength(25);
    expect(e.fields![0].value.length).toBe(1024);
  });
});
