import express, { type Request } from 'express';
import { buildPack, mergePackFiles, PackError } from '../pack/pack';
import { readPackZipFiles } from '../pack/zip';
import type { Rng } from '../rules/dice';
import type { EncounterStore } from '../table/encounters';
import { MAP_LIMITS, type MapStore } from '../table/maps';
import { TableError, type RollRequest, type TableStore } from '../table/store';
import type { Principal } from './auth';
import type { RoomHub } from './realtime';

type Req = Request & { caller?: { userId: string; principal: Principal } };

/**
 * The rooms API: packs, rooms, members, the log, chat, dice and character sheets. Mounted behind the sign-in check,
 * so every handler has a caller.
 */
export function tableRoutes({ table, maps, encounters, hub, rng, now }: { table: TableStore; maps: MapStore; encounters: EncounterStore; hub: RoomHub; rng: Rng; now: () => Date }) {
  const r = express.Router();
  const room = (req: Request) => String(req.params.id);
  const who = (req: Req) => req.caller!;
  const nameOf = (req: Req) => who(req).principal.name ?? who(req).userId;

  r.get('/packs', async (_req, res) => { res.json(await table.listPacks()); });
  r.get('/packs/:key', async (req, res) => { res.json(await table.pack(String(req.params.key))); });
  r.post('/packs', express.raw({ type: () => true, limit: '5mb' }), async (req: Req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new TableError(400, 'bad-request', '請上傳規則包 zip 檔');
    let files = readPackZipFiles(new Uint8Array(req.body));
    // An add-on names the pack it extends; it becomes a new pack made of both, so rooms pick it like any other.
    const base = (files.manifest as { extends?: unknown } | undefined)?.extends;
    if (typeof base === 'string') files = mergePackFiles(await table.packFiles(base), files, base);
    const pack = buildPack(files);
    const key = await table.savePack(pack, who(req).userId, false, now(), files);
    res.status(201).json({ key, name: pack.manifest.name });
  });

  r.get('/rooms', async (req: Req, res) => { res.json(await table.roomsOf(who(req).userId)); });
  r.post('/rooms', async (req: Req, res) => {
    res.status(201).json(await table.createRoom(who(req).userId, nameOf(req), req.body?.name, String(req.body?.pack ?? ''), now()));
  });
  r.post('/rooms/join', async (req: Req, res) => { res.json(await table.join(who(req).userId, nameOf(req), req.body?.code, now())); });
  r.get('/rooms/:id', async (req: Req, res) => { res.json(await table.view(String(req.params.id), who(req).userId)); });
  r.delete('/rooms/:id', async (req: Req, res) => {
    await table.deleteRoom(room(req), who(req).userId, req.body?.confirm);
    hub.publish(room(req), { type: 'room' });
    res.json({ ok: true });
  });
  r.get('/rooms/:id/log', async (req: Req, res) => {
    res.json(await table.log(String(req.params.id), who(req).userId, Number(req.query.after ?? 0) || 0));
  });
  r.post('/rooms/:id/members/:userId', async (req: Req, res) => {
    await table.setRole(String(req.params.id), who(req).userId, String(req.params.userId), req.body?.role, now());
    hub.publish(room(req), { type: 'room' });
    hub.publish(room(req), { type: 'maps' });
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
    hub.publish(room, { type: 'log' });
  });
  r.post('/rooms/:id/rolls', async (req: Req, res) => {
    const { requestId, ...body } = req.body ?? {};
    res.json(await table.roll(room(req), who(req).userId, requestId, body as RollRequest, rng, now()));
    hub.publish(room(req), { type: 'log' });
  });

  r.post('/rooms/:id/characters', async (req: Req, res) => {
    res.status(201).json(await table.createCharacter(room(req), who(req).userId, req.body?.name, req.body?.data, now()));
    hub.publish(room(req), { type: 'room' });
    hub.publish(room(req), { type: 'log' });
  });
  r.patch('/rooms/:id/characters/:cid', async (req: Req, res) => {
    const { version, name, data } = req.body ?? {};
    res.json(await table.updateCharacter(room(req), who(req).userId, String(req.params.cid), Number(version), { name, data }));
    hub.publish(room(req), { type: 'room' });
  });

  // ---------- maps ----------
  const mapId = (req: Request) => String(req.params.mid);
  const changed = (req: Request, id: string) => hub.publish(room(req), { type: 'map', mapId: id });
  r.get('/rooms/:id/maps', async (req: Req, res) => { res.json(await maps.list(room(req), who(req).userId)); });
  r.post('/rooms/:id/maps', async (req: Req, res) => {
    const m = await maps.create(room(req), who(req).userId, req.body ?? {}, now());
    hub.publish(room(req), { type: 'maps' });
    res.status(201).json(m);
  });
  r.get('/rooms/:id/maps/:mid', async (req: Req, res) => { res.json(await maps.view(room(req), who(req).userId, mapId(req))); });
  r.patch('/rooms/:id/maps/:mid', async (req: Req, res) => {
    const m = await maps.update(room(req), who(req).userId, mapId(req), req.body ?? {});
    changed(req, m.id);
    hub.publish(room(req), { type: 'maps' });
    res.json(m);
  });
  r.delete('/rooms/:id/maps/:mid', async (req: Req, res) => {
    await maps.remove(room(req), who(req).userId, mapId(req));
    hub.publish(room(req), { type: 'maps' });
    res.json({ ok: true });
  });
  r.post('/rooms/:id/maps/:mid/activate', async (req: Req, res) => {
    const m = await maps.activate(room(req), who(req).userId, mapId(req));
    await table.note(room(req), who(req).userId, `GM 打開了地圖「${m.name}」`, now());
    hub.publish(room(req), { type: 'maps' });
    hub.publish(room(req), { type: 'log' });
    res.json(m);
  });
  r.put('/rooms/:id/maps/:mid/image', express.raw({ type: () => true, limit: MAP_LIMITS.imageBytes }), async (req: Req, res) => {
    const m = await maps.setImage(room(req), who(req).userId, mapId(req), String(req.get('content-type') ?? '').split(';')[0], Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    changed(req, m.id);
    hub.publish(room(req), { type: 'maps' });
    res.json(m);
  });
  r.get('/rooms/:id/maps/:mid/image', async (req: Req, res) => {
    const img = await maps.image(room(req), who(req).userId, mapId(req));
    res.set({ 'content-type': img.type, 'cache-control': 'private, max-age=86400' }).send(img.bytes);
  });
  r.post('/rooms/:id/maps/:mid/fog', async (req: Req, res) => {
    const { cells, covered } = req.body ?? {};
    const m = await maps.fog(room(req), who(req).userId, mapId(req), cells === 'all' ? 'all' : cells, !!covered);
    changed(req, m.id);
    res.json(m);
  });
  r.post('/rooms/:id/maps/:mid/tokens', async (req: Req, res) => {
    const t = await maps.addToken(room(req), who(req).userId, mapId(req), req.body ?? {}, now());
    changed(req, t.mapId);
    res.status(201).json(t);
  });
  r.patch('/rooms/:id/tokens/:tid', async (req: Req, res) => {
    const body = { ...(req.body ?? {}) };
    // In a fight, a combatant walks by the rules; the encounter moves it and the rest of the edit goes on as usual.
    if (body.x !== undefined || body.y !== undefined) {
      const current = await maps.token(room(req), who(req).userId, String(req.params.tid));
      const to = { x: Math.round(Number(body.x ?? current.x)), y: Math.round(Number(body.y ?? current.y)) };
      if ((to.x !== current.x || to.y !== current.y) && await encounters.move(room(req), who(req).userId, current.id, to, now())) {
        delete body.x; delete body.y;
        hub.publish(room(req), { type: 'encounter' });
        hub.publish(room(req), { type: 'log' });
      }
    }
    const t = await maps.updateToken(room(req), who(req).userId, String(req.params.tid), body);
    changed(req, t.mapId);
    res.json(t);
  });
  r.put('/rooms/:id/tokens/:tid/image', express.raw({ type: () => true, limit: MAP_LIMITS.tokenImageBytes }), async (req: Req, res) => {
    const t = await maps.setTokenImage(room(req), who(req).userId, String(req.params.tid), String(req.get('content-type') ?? '').split(';')[0], Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    changed(req, t.mapId);
    res.json(t);
  });
  r.delete('/rooms/:id/tokens/:tid/image', async (req: Req, res) => {
    const t = await maps.setTokenImage(room(req), who(req).userId, String(req.params.tid), '', null);
    changed(req, t.mapId);
    res.json(t);
  });
  r.get('/rooms/:id/tokens/:tid/image', async (req: Req, res) => {
    const img = await maps.tokenImage(room(req), who(req).userId, String(req.params.tid));
    res.set({ 'content-type': img.type, 'cache-control': 'private, max-age=86400' }).send(img.bytes);
  });
  r.delete('/rooms/:id/tokens/:tid', async (req: Req, res) => {
    changed(req, await maps.removeToken(room(req), who(req).userId, String(req.params.tid)));
    res.json({ ok: true });
  });
  r.post('/rooms/:id/maps/:mid/objects', async (req: Req, res) => {
    const o = await maps.addObject(room(req), who(req).userId, mapId(req), req.body ?? {}, now());
    changed(req, o.mapId);
    res.status(201).json(o);
  });
  r.patch('/rooms/:id/objects/:oid', async (req: Req, res) => {
    const o = await maps.updateObject(room(req), who(req).userId, String(req.params.oid), req.body ?? {});
    changed(req, o.mapId);
    res.json(o);
  });
  r.delete('/rooms/:id/objects/:oid', async (req: Req, res) => {
    changed(req, await maps.removeObject(room(req), who(req).userId, String(req.params.oid)));
    res.json({ ok: true });
  });

  // ---------- interactive combat ----------
  const fought = (req: Request) => {
    hub.publish(room(req), { type: 'encounter' });
    hub.publish(room(req), { type: 'log' });
  };
  r.get('/rooms/:id/encounter', async (req: Req, res) => {
    res.json(await encounters.current(room(req), who(req).userId, Number(req.query.after ?? 0) || 0));
  });
  r.post('/rooms/:id/encounter', async (req: Req, res) => {
    const out = await encounters.start(room(req), who(req).userId, req.body ?? {}, now());
    fought(req);
    if (out.encounter) changed(req, out.encounter.mapId);
    res.status(201).json(out);
  });
  r.post('/rooms/:id/encounter/command', async (req: Req, res) => {
    const { requestId, ...cmd } = req.body ?? {};
    const out = await encounters.command(room(req), who(req).userId, requestId, cmd, now());
    fought(req);
    if (out.encounter) changed(req, out.encounter.mapId);
    res.json(out);
  });
  r.get('/rooms/:id/encounter/events', async (req: Req, res) => {
    res.json(await encounters.events(room(req), who(req).userId, Number(req.query.after ?? 0) || 0));
  });
  r.post('/rooms/:id/encounter/rest', async (req: Req, res) => {
    await encounters.rest(room(req), who(req).userId, now());
    hub.publish(room(req), { type: 'log' });
    hub.publish(room(req), { type: 'encounter' });
    res.json({ ok: true });
  });
  r.get('/rooms/:id/patterns', async (req: Req, res) => { res.json(await encounters.patterns(room(req), who(req).userId)); });
  r.post('/rooms/:id/patterns', async (req: Req, res) => { res.status(201).json(await encounters.savePattern(room(req), who(req).userId, req.body ?? {}, now())); });
  r.delete('/rooms/:id/patterns/:pid', async (req: Req, res) => {
    await encounters.removePattern(room(req), who(req).userId, String(req.params.pid));
    res.json({ ok: true });
  });
  r.get('/combat-prefs', async (req: Req, res) => { res.json(await encounters.prefs(who(req).userId)); });
  r.put('/combat-prefs', async (req: Req, res) => { res.json(await encounters.setPrefs(who(req).userId, req.body ?? {})); });
  return r;
}

/** Maps the rooms API's errors to responses; anything else goes on to the main handler. */
export function tableErrorStatus(err: unknown): { status: number; code: string; message: string; problems?: unknown } | undefined {
  if (err instanceof TableError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof PackError) return { status: 400, code: 'invalid-pack', message: '規則包有問題，請修正後再上傳', problems: err.problems };
  if ((err as { type?: string }).type === 'entity.too.large') return { status: 413, code: 'too-large', message: '檔案太大' };
  return undefined;
}
