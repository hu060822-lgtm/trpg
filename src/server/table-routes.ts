import express, { type Request } from 'express';
import { PackError } from '../pack/pack';
import { readPackZip } from '../pack/zip';
import type { Rng } from '../rules/dice';
import { TableError, type RollRequest, type TableStore } from '../table/store';
import type { Principal } from './auth';

type Req = Request & { caller?: { userId: string; principal: Principal } };

/**
 * The rooms API: packs, rooms, members, the log, chat, dice and character sheets. Mounted behind the sign-in check,
 * so every handler has a caller.
 */
export function tableRoutes(table: TableStore, rng: Rng, now: () => Date) {
  const r = express.Router();
  const who = (req: Req) => req.caller!;
  const nameOf = (req: Req) => who(req).principal.name ?? who(req).userId;

  r.get('/packs', async (_req, res) => { res.json(await table.listPacks()); });
  r.get('/packs/:key', async (req, res) => { res.json(await table.pack(String(req.params.key))); });
  r.post('/packs', express.raw({ type: () => true, limit: '5mb' }), async (req: Req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new TableError(400, 'bad-request', '請上傳規則包 zip 檔');
    const pack = readPackZip(new Uint8Array(req.body));
    const key = await table.savePack(pack, who(req).userId, false, now());
    res.status(201).json({ key, name: pack.manifest.name });
  });

  r.get('/rooms', async (req: Req, res) => { res.json(await table.roomsOf(who(req).userId)); });
  r.post('/rooms', async (req: Req, res) => {
    res.status(201).json(await table.createRoom(who(req).userId, nameOf(req), req.body?.name, String(req.body?.pack ?? ''), now()));
  });
  r.post('/rooms/join', async (req: Req, res) => { res.json(await table.join(who(req).userId, nameOf(req), req.body?.code, now())); });
  r.get('/rooms/:id', async (req: Req, res) => { res.json(await table.view(String(req.params.id), who(req).userId)); });
  r.get('/rooms/:id/log', async (req: Req, res) => {
    res.json(await table.log(String(req.params.id), who(req).userId, Number(req.query.after ?? 0) || 0));
  });
  r.post('/rooms/:id/members/:userId', async (req: Req, res) => {
    await table.setRole(String(req.params.id), who(req).userId, String(req.params.userId), req.body?.role, now());
    res.json({ ok: true });
  });

  /** `/r <formula>` and `/gr <formula>` (a roll only GMs see) in the chat box roll dice; anything else is said. */
  r.post('/rooms/:id/chat', async (req: Req, res) => {
    const { text, requestId } = req.body ?? {};
    const m = typeof text === 'string' ? /^\/(g?r)(?:oll)?\s+(.+)$/i.exec(text.trim()) : null;
    const room = String(req.params.id), user = who(req).userId;
    res.json(m
      ? await table.roll(room, user, requestId, { formula: m[2], secret: m[1].toLowerCase() === 'gr' }, rng, now())
      : await table.say(room, user, requestId, text, now()));
  });
  r.post('/rooms/:id/rolls', async (req: Req, res) => {
    const { requestId, ...body } = req.body ?? {};
    res.json(await table.roll(String(req.params.id), who(req).userId, requestId, body as RollRequest, rng, now()));
  });

  r.post('/rooms/:id/characters', async (req: Req, res) => {
    res.status(201).json(await table.createCharacter(String(req.params.id), who(req).userId, req.body?.name, req.body?.data, now()));
  });
  r.patch('/rooms/:id/characters/:cid', async (req: Req, res) => {
    const { version, name, data } = req.body ?? {};
    res.json(await table.updateCharacter(String(req.params.id), who(req).userId, String(req.params.cid), Number(version), { name, data }));
  });
  return r;
}

/** Maps the rooms API's errors to responses; anything else goes on to the main handler. */
export function tableErrorStatus(err: unknown): { status: number; code: string; message: string; problems?: unknown } | undefined {
  if (err instanceof TableError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof PackError) return { status: 400, code: 'invalid-pack', message: '規則包有問題，請修正後再上傳', problems: err.problems };
  if ((err as { type?: string }).type === 'entity.too.large') return { status: 413, code: 'too-large', message: '檔案太大（上限 5 MB）' };
  return undefined;
}
