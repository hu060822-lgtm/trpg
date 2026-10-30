import { useEffect, useRef, useState } from 'react';
import type { Api, MapInfo, MapSummary, MapTemplateInfo } from '../api';
import { useAction } from '../hooks';
import { Confirm, ErrorNote } from './ui';

/** Shrinks a big picture before upload (longest side 2400 px, WebP) so it loads quickly on phones. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.86));
    return out && (out.size < file.size || k < 1) ? out : file;
  } catch {
    return file;
  }
}

/** The GM's map desk: every map in the room, a new blank map, and the open map's grid, picture and fog. */
export function MapManager({ api, roomId, map, activeMapId, onDone, compact }: {
  api: Api; roomId: string; map: MapInfo | null; activeMapId: string | null; onDone: (selected: string | null) => void; compact?: boolean;
}) {
  const [list, setList] = useState<MapSummary[]>([]);
  const [name, setName] = useState('');
  const [cols, setCols] = useState(20);
  const [rows, setRows] = useState(15);
  const [templates, setTemplates] = useState<MapTemplateInfo[]>([]);
  const [template, setTemplate] = useState('');
  const act = useAction();
  const [asking, setAsking] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { void api.mapTemplates().then(setTemplates).catch(() => {}); }, [api]);
  const chosen = templates.find((t) => t.id === template);
  const groups = [...new Set(templates.map((t) => t.group))];
  useEffect(() => { if (!compact) void api.maps(roomId).then((r) => setList(r.maps)).catch(() => {}); }, [api, roomId, compact, map?.version]);

  const create = (
    <form className="stack" onSubmit={(e) => {
      e.preventDefault();
      void act.run(async () => {
        const m = await api.createMap(roomId, chosen ? { name: name.trim() || chosen.name, template: chosen.id } : { name: name.trim() || '新地圖', cols, rows });
        setName(''); onDone(m.id);
      });
    }}>
      {templates.length > 0 && (
        <label>從範本開始
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">空白地圖</option>
            {groups.map((g) => <optgroup key={g} label={g}>{templates.filter((t) => t.group === g).map((t) => <option key={t.id} value={t.id}>{t.name}（{t.cols}×{t.rows}）</option>)}</optgroup>)}
          </select>
        </label>
      )}
      {chosen && <p className="small muted">{chosen.blurb}每次建立的擺設都會有點不同，建好之後每個物件都可以再移動、修改或刪除。陷阱預設對玩家隱藏。</p>}
      <label>地圖名稱<input maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.name ?? '例如 廢棄礦坑'} /></label>
      {!chosen && (
        <div className="row">
          <label>寬（格）<input type="number" inputMode="numeric" min={1} max={100} value={cols} onChange={(e) => setCols(Number(e.target.value))} /></label>
          <label>高（格）<input type="number" inputMode="numeric" min={1} max={100} value={rows} onChange={(e) => setRows(Number(e.target.value))} /></label>
        </div>
      )}
      <button className="primary" disabled={act.busy}>{chosen ? `用「${chosen.name}」建立地圖` : '建立地圖'}</button>
    </form>
  );
  if (compact || !map) return <>{create}<ErrorNote of={act} /></>;

  const set = (s: Parameters<Api['updateMap']>[2]) => void act.run(async () => { await api.updateMap(roomId, map.id, s); onDone(map.id); });
  return (
    <div className="stack">
      <section className="block">
        <h3>這個房間的地圖</h3>
        <ul className="list framed">
          {list.map((m) => (
            <li key={m.id}>
              <button className="link" onClick={() => onDone(m.id)} aria-current={m.id === map.id}>{m.id === map.id ? `▸ ${m.name}` : m.name}</button>
              {m.id === activeMapId ? <span className="badge gm">玩家看到這張</span>
                : <button className="small" disabled={act.busy} onClick={() => void act.run(async () => { await api.activateMap(roomId, m.id); onDone(m.id); })}>打開給玩家</button>}
            </li>
          ))}
        </ul>
      </section>

      <section className="block stack">
        <h3>「{map.name}」</h3>
        <MapFields key={map.version} map={map} busy={act.busy} onSave={set} />
        <label className="tick"><input type="checkbox" checked={map.showGrid} onChange={(e) => set({ showGrid: e.target.checked })} />顯示格線</label>
        <label className="tick"><input type="checkbox" checked={map.fogEnabled} onChange={(e) => set({ fogEnabled: e.target.checked })} />戰爭迷霧（玩家只看得到揭開的格子）</label>
        {map.fogEnabled && (
          <div className="row">
            <button disabled={act.busy} onClick={() => void act.run(async () => { await api.fog(roomId, map.id, 'all', true); onDone(map.id); })}>全部遮蔽</button>
            <button disabled={act.busy} onClick={() => void act.run(async () => { await api.fog(roomId, map.id, 'all', false); onDone(map.id); })}>全部揭開</button>
          </div>
        )}
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void act.run(async () => { await api.uploadMapImage(roomId, map.id, await shrink(f)); onDone(map.id); });
        }} />
        <button disabled={act.busy} onClick={() => file.current?.click()}>{act.busy ? '處理中…' : map.imageVersion ? '換一張底圖' : '上傳底圖'}</button>
        <p className="muted small">圖片會鋪滿整個格線範圍。如果圖片本身畫了格子，把寬、高調成一樣的格數就會對齊。</p>
        <button className="danger" disabled={act.busy} onClick={() => setAsking(true)}>刪除這張地圖</button>
        {asking && (
          <Confirm title={`刪除地圖「${map.name}」？`} action="刪除地圖" onClose={() => setAsking(false)}
            body="地圖、底圖、迷霧和上面所有代幣都會一起刪掉，無法復原。角色卡不受影響。"
            onConfirm={() => void act.run(async () => { await api.deleteMap(roomId, map.id); onDone(null); })} />
        )}
      </section>

      <section className="block">
        <h3>新地圖</h3>
        {create}
      </section>
      <ErrorNote of={act} />
    </div>
  );
}

function MapFields({ map, busy, onSave }: { map: MapInfo; busy: boolean; onSave: (s: Parameters<Api['updateMap']>[2]) => void }) {
  const [f, setF] = useState({ name: map.name, cols: map.cols, rows: map.rows, cellDistance: map.cellDistance, unit: map.unit });
  const dirty = f.name !== map.name || f.cols !== map.cols || f.rows !== map.rows || f.cellDistance !== map.cellDistance || f.unit !== map.unit;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave(f); }}>
      <label>名稱<input maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <div className="row">
        <label>寬（格）<input type="number" min={1} max={100} value={f.cols} onChange={(e) => setF({ ...f, cols: Number(e.target.value) })} /></label>
        <label>高（格）<input type="number" min={1} max={100} value={f.rows} onChange={(e) => setF({ ...f, rows: Number(e.target.value) })} /></label>
      </div>
      <div className="row">
        <label>每格距離<input type="number" min={0.1} step={0.5} value={f.cellDistance} onChange={(e) => setF({ ...f, cellDistance: Number(e.target.value) })} /></label>
        <label>單位<input maxLength={8} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></label>
      </div>
      {dirty && <button className="primary" disabled={busy}>儲存變更</button>}
    </form>
  );
}
