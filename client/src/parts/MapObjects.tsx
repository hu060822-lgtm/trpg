import { useState, type ReactNode } from 'react';
import type { Api, MapObject, MapObjectKind } from '../api';
import { useAction } from '../hooks';
import { Confirm, ErrorNote, IconButton } from './ui';

interface Kind { label: string; group: string; w: number; h: number; stretch?: boolean; art: ReactNode }

// Drawn on a 100 × 100 square. Earthy colours that read on both the felt and a dark picture.
const STONE = '#8d867a', STONE_DARK = '#5b554c', WOOD = '#8a5a34', WOOD_DARK = '#5a3a20', GOLD = '#f0b552';
export const KINDS: Record<MapObjectKind, Kind> = {
  wall: { label: '牆', group: '建築', w: 4, h: 1, stretch: true, art: <>
    <rect x="0" y="8" width="100" height="84" fill={STONE} stroke={STONE_DARK} strokeWidth="6" />
    <path d="M0 50H100M25 8V50M75 8V50M50 50V92" stroke={STONE_DARK} strokeWidth="4" />
  </> },
  door: { label: '門', group: '建築', w: 1, h: 1, art: <>
    <rect x="4" y="32" width="92" height="36" rx="3" fill={WOOD} stroke={WOOD_DARK} strokeWidth="5" />
    <path d="M36 32V68M64 32V68" stroke={WOOD_DARK} strokeWidth="3" /><circle cx="80" cy="50" r="5" fill={GOLD} />
  </> },
  window: { label: '窗', group: '建築', w: 1, h: 1, art: <>
    <rect x="4" y="38" width="92" height="24" fill="#9fc7d9" stroke={STONE_DARK} strokeWidth="5" /><path d="M50 38V62" stroke={STONE_DARK} strokeWidth="4" />
  </> },
  pillar: { label: '柱子', group: '建築', w: 1, h: 1, art: <>
    <circle cx="50" cy="50" r="38" fill={STONE} stroke={STONE_DARK} strokeWidth="6" /><circle cx="50" cy="50" r="22" fill="none" stroke={STONE_DARK} strokeWidth="3" />
  </> },
  stairs: { label: '樓梯', group: '建築', w: 2, h: 2, stretch: true, art: <>
    <rect x="4" y="4" width="92" height="92" fill={STONE} stroke={STONE_DARK} strokeWidth="5" />
    <path d="M4 22H96M4 40H96M4 58H96M4 76H96" stroke={STONE_DARK} strokeWidth="4" /><path d="M50 84V16M38 28L50 16L62 28" stroke="#f2ead8" strokeWidth="5" fill="none" />
  </> },
  rubble: { label: '碎石', group: '建築', w: 2, h: 2, stretch: true, art: <>
    <path d="M10 30L24 18L34 30L26 40ZM56 16L72 12L76 26L62 30ZM40 52L58 44L66 60L48 66ZM14 70L28 62L36 78L20 86ZM72 70L88 66L90 84L74 86Z" fill={STONE} stroke={STONE_DARK} strokeWidth="3" />
  </> },
  table: { label: '桌子', group: '家具', w: 2, h: 1, stretch: true, art: <>
    <rect x="6" y="14" width="88" height="72" rx="10" fill={WOOD} stroke={WOOD_DARK} strokeWidth="5" /><path d="M14 50H86" stroke={WOOD_DARK} strokeWidth="2" opacity="0.6" />
  </> },
  chair: { label: '椅子', group: '家具', w: 1, h: 1, art: <>
    <rect x="26" y="34" width="48" height="44" rx="5" fill={WOOD} stroke={WOOD_DARK} strokeWidth="5" /><rect x="26" y="20" width="48" height="12" rx="3" fill={WOOD_DARK} />
  </> },
  bed: { label: '床', group: '家具', w: 1, h: 2, stretch: true, art: <>
    <rect x="10" y="4" width="80" height="92" rx="6" fill="#b7a58a" stroke={WOOD_DARK} strokeWidth="5" /><rect x="18" y="10" width="64" height="18" rx="5" fill="#efe6d2" />
    <rect x="10" y="40" width="80" height="56" rx="4" fill="#7d6aa8" />
  </> },
  chest: { label: '寶箱', group: '家具', w: 1, h: 1, art: <>
    <rect x="14" y="28" width="72" height="50" rx="6" fill={WOOD} stroke={WOOD_DARK} strokeWidth="5" /><path d="M14 46H86" stroke={GOLD} strokeWidth="6" />
    <rect x="44" y="40" width="12" height="14" rx="2" fill={GOLD} />
  </> },
  barrel: { label: '木桶', group: '家具', w: 1, h: 1, art: <>
    <circle cx="50" cy="50" r="36" fill={WOOD} stroke={WOOD_DARK} strokeWidth="5" /><circle cx="50" cy="50" r="24" fill="none" stroke={WOOD_DARK} strokeWidth="4" /><circle cx="50" cy="50" r="6" fill={WOOD_DARK} />
  </> },
  crate: { label: '木箱', group: '家具', w: 1, h: 1, art: <>
    <rect x="16" y="16" width="68" height="68" fill="#a87a4c" stroke={WOOD_DARK} strokeWidth="5" /><path d="M16 16L84 84M84 16L16 84" stroke={WOOD_DARK} strokeWidth="5" />
  </> },
  bookshelf: { label: '書架', group: '家具', w: 2, h: 1, stretch: true, art: <>
    <rect x="2" y="20" width="96" height="60" fill={WOOD_DARK} />
    {[8, 18, 26, 36, 46, 54, 64, 74, 82].map((x, i) => <rect key={x} x={x} y="28" width="7" height="44" fill={['#a8433f', '#3f6b8a', '#c79a3c', '#4f7d52'][i % 4]} />)}
  </> },
  altar: { label: '祭壇', group: '家具', w: 2, h: 1, stretch: true, art: <>
    <rect x="6" y="22" width="88" height="56" rx="4" fill="#c9c1b0" stroke={STONE_DARK} strokeWidth="5" />
    <circle cx="30" cy="50" r="6" fill={GOLD} /><circle cx="70" cy="50" r="6" fill={GOLD} /><path d="M50 36V64M40 46H60" stroke={STONE_DARK} strokeWidth="5" />
  </> },
  statue: { label: '雕像', group: '家具', w: 1, h: 1, art: <>
    <rect x="18" y="62" width="64" height="24" rx="3" fill={STONE_DARK} /><circle cx="50" cy="30" r="14" fill={STONE} /><path d="M32 64C32 44 68 44 68 64Z" fill={STONE} />
  </> },
  tree: { label: '樹', group: '自然', w: 2, h: 2, art: <>
    <circle cx="50" cy="50" r="44" fill="#2f6b45" /><circle cx="38" cy="40" r="22" fill="#3f8a59" /><circle cx="62" cy="58" r="20" fill="#3f8a59" />
    <circle cx="50" cy="50" r="7" fill={WOOD_DARK} />
  </> },
  bush: { label: '灌木', group: '自然', w: 1, h: 1, art: <>
    <circle cx="36" cy="54" r="22" fill="#4f8f5a" /><circle cx="62" cy="46" r="24" fill="#5ea567" /><circle cx="56" cy="66" r="16" fill="#4f8f5a" />
  </> },
  rock: { label: '岩石', group: '自然', w: 1, h: 1, art: <>
    <path d="M14 64L26 28L58 16L86 40L80 76L44 86Z" fill={STONE} stroke={STONE_DARK} strokeWidth="5" /><path d="M26 28L50 50L80 76M50 50L58 16" stroke={STONE_DARK} strokeWidth="3" fill="none" />
  </> },
  water: { label: '水', group: '自然', w: 3, h: 2, stretch: true, art: <>
    <rect x="0" y="0" width="100" height="100" rx="14" fill="#2f6f8f" opacity="0.85" />
    <path d="M10 34Q22 26 34 34T58 34T82 34M18 64Q30 56 42 64T66 64T90 64" stroke="#9fd0e4" strokeWidth="4" fill="none" />
  </> },
  fire: { label: '火堆', group: '自然', w: 1, h: 1, art: <>
    <path d="M26 82H74M30 74L70 86M70 74L30 86" stroke={WOOD_DARK} strokeWidth="7" />
    <path d="M50 14C64 34 74 44 70 62C66 76 34 76 30 62C27 50 38 44 40 30C46 40 46 46 50 50C54 40 52 28 50 14Z" fill="#e2762e" />
    <path d="M50 40C58 52 60 58 56 66C52 72 46 72 44 66C42 58 48 54 50 40Z" fill={GOLD} />
  </> },
  trap: { label: '陷阱', group: '機關', w: 1, h: 1, art: <>
    <circle cx="50" cy="50" r="38" fill="rgba(212,80,94,0.18)" stroke="#d4505e" strokeWidth="5" strokeDasharray="10 8" />
    <path d="M34 66L42 40L50 66L58 40L66 66" stroke="#d4505e" strokeWidth="6" fill="none" strokeLinejoin="round" />
  </> },
  label: { label: '文字標籤', group: '機關', w: 3, h: 1, art: null },
};
const GROUPS = ['建築', '家具', '自然', '機關'];

/** An object drawn at its size. Rotation turns the picture inside the squares it covers. */
export function ObjectArt({ o, cell }: { o: MapObject; cell: number }) {
  const k = KINDS[o.kind];
  if (o.kind === 'label') {
    return <span className="object-label" style={{ fontSize: Math.min(cell * 0.5, (o.w * cell) / Math.max(2, [...(o.name || '標籤')].length) * 1.2) }}>{o.name || '標籤'}</span>;
  }
  const turned = o.rotation === 90 || o.rotation === 270;
  const w = (turned ? o.h : o.w) * cell, h = (turned ? o.w : o.h) * cell;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio={k?.stretch ? 'none' : 'xMidYMid meet'} aria-hidden
      style={{ width: w, height: h, transform: `translate(-50%, -50%) rotate(${o.rotation}deg)` }}>
      {k?.art}
    </svg>
  );
}

/** The GM's box of scenery: tap one and it lands in the middle of the screen, ready to drag. */
export function ObjectPalette({ onPick, busy, onClose }: { onPick: (kind: MapObjectKind) => void; busy: boolean; onClose: () => void }) {
  return (
    <div className="token-card palette" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="row">
        <b>布置物件</b>
        <span className="muted small">點一下放到畫面中央，再拖到想要的位置。</span>
        <span className="spacer" />
        <button className="link" onClick={onClose}>收起</button>
      </div>
      {GROUPS.map((g) => (
        <div key={g} className="palette-group">
          <span className="muted small">{g}</span>
          <div className="palette-items">
            {(Object.entries(KINDS) as [MapObjectKind, Kind][]).filter(([, k]) => k.group === g).map(([kind, k]) => (
              <button key={kind} className="palette-item" disabled={busy} onClick={() => onPick(kind)} aria-label={`放上${k.label}`}>
                {k.art ? <svg viewBox="0 0 100 100" aria-hidden>{k.art}</svg> : <span className="palette-text" aria-hidden>文</span>}
                <span>{k.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function defaultsFor(kind: MapObjectKind) {
  const k = KINDS[kind];
  return { kind, w: k.w, h: k.h, name: kind === 'label' ? '房間名稱' : '' };
}

/** Edits the selected object: name, size, turn, hide from players, copy or remove. */
export function ObjectCard({ api, roomId, object: o, onClose, onChanged, onCopy }: {
  api: Api; roomId: string; object: MapObject; onClose: () => void; onChanged: () => Promise<void>; onCopy: () => void;
}) {
  const act = useAction();
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState(o.name);
  const k = KINDS[o.kind];
  const save = (change: Parameters<Api['updateObject']>[2]) => void act.run(async () => { await api.updateObject(roomId, o.id, change); await onChanged(); });
  const size = (what: 'w' | 'h', label: string) => (
    <span className="tick">{label}
      <span className="stepper">
        <button type="button" className="icon" aria-label={`${label}減一格`} data-tip={`${label}減一格`} disabled={o[what] <= 1 || act.busy} onClick={() => save({ [what]: o[what] - 1 })}>−</button>
        <b>{o[what]}</b>
        <button type="button" className="icon" aria-label={`${label}加一格`} data-tip={`${label}加一格`} disabled={act.busy} onClick={() => save({ [what]: o[what] + 1 })}>＋</button>
      </span>
    </span>
  );
  return (
    <div className="token-card" onKeyDown={(e) => { if (e.key === 'Escape' && !asking) onClose(); }}>
      <div className="row">
        <b>{k.label}{o.name && o.kind !== 'label' ? `：${o.name}` : ''}</b>
        {o.hidden && <span className="badge secret">只有 GM 看得到</span>}
        <span className="spacer" />
        <button className="link" onClick={onClose}>收起</button>
      </div>
      <div className="row">
        <label className="grow">{o.kind === 'label' ? '標籤文字' : '名稱（選填，GM 才看得到）'}
          <input maxLength={40} value={name} placeholder={o.kind === 'label' ? '大廳' : '上鎖的門'} onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name.trim() !== o.name) save({ name }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </label>
      </div>
      <div className="row">
        {size('w', '寬')}
        {size('h', '高')}
        {o.kind !== 'label' && <IconButton label="轉 90 度" disabled={act.busy} onClick={() => save({ rotation: (o.rotation + 90) % 360, w: o.h, h: o.w })}>⟳</IconButton>}
        <label className="tick"><input type="checkbox" checked={o.hidden} onChange={(e) => save({ hidden: e.target.checked })} />對玩家隱藏</label>
        <button disabled={act.busy} onClick={onCopy}>複製一個</button>
        <button className="danger" disabled={act.busy} onClick={() => setAsking(true)}>移除物件</button>
      </div>
      <ErrorNote of={act} />
      {asking && (
        <Confirm title={`移除「${o.name || k.label}」？`} action="移除物件" body="物件會從這張地圖拿掉，位置和設定不會保留。" onClose={() => setAsking(false)}
          onConfirm={() => void act.run(async () => { await api.removeObject(roomId, o.id); onClose(); await onChanged(); })} />
      )}
    </div>
  );
}
