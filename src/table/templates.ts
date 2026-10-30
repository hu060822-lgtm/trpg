import type { ObjectInput } from './maps';
import type { MapObjectKind } from './types';

/**
 * Ready-made battle maps a GM can start from: a mine, a town square, a goblin lair and so on. Each template is a grid
 * size plus a recipe that lays out objects; the recipe takes a seed, so two goblin lairs are not the same lair, but one
 * seed always gives the same map (the tests rely on that). Everything a template lays down is an ordinary object the
 * GM can move, change or delete afterwards.
 */

export interface MapTemplate {
  id: string;
  name: string;
  /** One line for the picker. */
  blurb: string;
  /** What it is for, so the picker can group them. */
  group: '地城' | '野外' | '城鎮' | '特殊';
  cols: number;
  rows: number;
  build: (p: Plan) => void;
}

export type Placed = ObjectInput & { kind: MapObjectKind; x: number; y: number; w: number; h: number };

/** A small seeded random source, so a template plus a seed is always the same map. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Side = 'n' | 's' | 'e' | 'w';
interface Opening { side: Side; at: number; kind?: 'door' | 'gate' | 'window' | 'cracked_wall' | 'gap'; locked?: boolean; width?: number }

/** The recipe's drawing board: places objects and remembers which squares are taken so scattered things don't pile up. */
export class Plan {
  readonly objects: Placed[] = [];
  private taken: Uint8Array;
  readonly random: () => number;
  constructor(readonly cols: number, readonly rows: number, seed: number) {
    this.taken = new Uint8Array(cols * rows);
    this.random = mulberry32(seed);
  }

  int(lo: number, hi: number) { return lo + Math.floor(this.random() * (hi - lo + 1)); }
  chance(p: number) { return this.random() < p; }
  pickOne<T>(xs: readonly T[]): T { return xs[Math.floor(this.random() * xs.length)]; }

  free(x: number, y: number, w = 1, h = 1) {
    if (x < 0 || y < 0 || x + w > this.cols || y + h > this.rows) return false;
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (this.taken[j * this.cols + i]) return false;
    return true;
  }
  claim(x: number, y: number, w = 1, h = 1) {
    for (let j = Math.max(0, y); j < Math.min(this.rows, y + h); j++) for (let i = Math.max(0, x); i < Math.min(this.cols, x + w); i++) this.taken[j * this.cols + i] = 1;
  }

  /** Puts one object down. Things clipped by the edge are trimmed; things wholly off the map are skipped. */
  put(kind: MapObjectKind, x: number, y: number, w = 1, h = 1, extra: Omit<ObjectInput, 'kind' | 'x' | 'y' | 'w' | 'h'> = {}) {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.cols, x + w), y1 = Math.min(this.rows, y + h);
    if (x1 <= x0 || y1 <= y0) return;
    this.objects.push({ kind, x: x0, y: y0, w: x1 - x0, h: y1 - y0, ...extra });
    this.claim(x0, y0, x1 - x0, y1 - y0);
  }

  /** A straight run of wall (or fence, cliff…) with gaps where the openings are. */
  line(kind: MapObjectKind, x: number, y: number, len: number, vertical: boolean, gaps: { at: number; width: number }[] = []) {
    let start = 0;
    const cuts = [...gaps].sort((a, b) => a.at - b.at);
    for (const g of [...cuts, { at: len, width: 0 }]) {
      const run = g.at - start;
      if (run > 0) vertical ? this.put(kind, x, y + start, 1, run) : this.put(kind, x + start, y, run, 1);
      start = g.at + g.width;
    }
  }

  /** Walls round a room, with doors, gates, windows or plain gaps; `at` counts from the room's corner along that side. */
  room(x: number, y: number, w: number, h: number, openings: Opening[] = [], wall: MapObjectKind = 'wall') {
    const on = (s: Side) => openings.filter((o) => o.side === s).map((o) => ({ at: o.at, width: o.width ?? 1 }));
    this.line(wall, x, y, w, false, on('n'));
    this.line(wall, x, y + h - 1, w, false, on('s'));
    this.line(wall, x, y + 1, h - 2, true, on('w').map((g) => ({ ...g, at: g.at - 1 })));
    this.line(wall, x + w - 1, y + 1, h - 2, true, on('e').map((g) => ({ ...g, at: g.at - 1 })));
    for (const o of openings) {
      const kind = o.kind ?? 'door';
      if (kind === 'gap') continue;
      const vertical = o.side === 'e' || o.side === 'w';
      const px = o.side === 'w' ? x : o.side === 'e' ? x + w - 1 : x + o.at;
      const py = o.side === 'n' ? y : o.side === 's' ? y + h - 1 : y + o.at;
      const width = o.width ?? 1;
      this.put(kind, px, py, vertical ? 1 : width, vertical ? width : 1, { rotation: vertical ? 90 : 0, ...(o.locked ? { props: { locked: true } } : {}) });
    }
  }

  /** Lays ground (water, mud, grass) without claiming it, so other scatter can still avoid or overlap as asked. */
  ground(kind: MapObjectKind, x: number, y: number, w: number, h: number, extra: Omit<ObjectInput, 'kind' | 'x' | 'y' | 'w' | 'h'> = {}) {
    this.put(kind, x, y, w, h, extra);
  }

  /** A winding band (a river, a lava flow, a road of mud) from one edge to the other. */
  river(kind: MapObjectKind, width: number, vertical: boolean, start?: number, wiggle = 1) {
    const span = vertical ? this.cols : this.rows;
    const len = vertical ? this.rows : this.cols;
    let at = start ?? Math.floor(span / 2 - width / 2);
    // Rows that sit at the same offset are merged into one object; each run reaches one row into the next so the
    // band reads as one flow, and it only bends every few rows.
    let runStart = 0, runAt = at;
    for (let i = 0; i <= len; i++) {
      if (i === len || at !== runAt) {
        const end = Math.min(len, i + 1);
        vertical ? this.ground(kind, runAt, runStart, width, end - runStart) : this.ground(kind, runStart, runAt, end - runStart, width);
        runStart = i; runAt = at;
      }
      if (i - runStart >= 2 && this.chance(0.35)) at = Math.max(1, Math.min(span - width - 1, at + this.int(-wiggle, wiggle)));
    }
  }

  /** Drops `n` objects on free squares inside an area (the whole map by default). Gives up quietly when full. */
  scatter(kind: MapObjectKind, n: number, area: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: this.cols, h: this.rows },
    size: [number, number] = [1, 1], extra: Omit<ObjectInput, 'kind' | 'x' | 'y' | 'w' | 'h'> = {}) {
    let placed = 0;
    for (let tries = 0; placed < n && tries < n * 40; tries++) {
      const x = area.x + this.int(0, Math.max(0, area.w - size[0]));
      const y = area.y + this.int(0, Math.max(0, area.h - size[1]));
      if (!this.free(x, y, size[0], size[1])) continue;
      this.put(kind, x, y, size[0], size[1], extra);
      placed++;
    }
  }

  /** A trap the players can't see until the GM shows it. */
  trap(x: number, y: number, name = '陷阱') {
    if (this.free(x, y)) this.put('trap', x, y, 1, 1, { name, hidden: true });
  }

  label(text: string, x: number, y: number, w = 4) { this.objects.push({ kind: 'label', name: text, x, y, w, h: 1 }); }
}

const T = (t: MapTemplate) => t;

export const MAP_TEMPLATES: MapTemplate[] = [
  // ---------- 地城 ----------
  T({
    id: 'mine', name: '廢棄礦坑', group: '地城', cols: 28, rows: 20, blurb: '支撐柱、礦車軌道、崩塌的坑道和閃著光的礦脈。',
    build(p) {
      p.room(0, 0, 28, 20, [{ side: 's', at: 3, kind: 'gap', width: 2 }]);
      p.line('wall', 9, 1, 11, true, [{ at: 4, width: 2 }]);
      p.line('wall', 19, 7, 12, true, [{ at: 6, width: 2 }]);
      p.line('wall', 10, 7, 9, false, [{ at: 4, width: 2 }]);
      p.ground('log', 2, 12, 14, 1, { name: '礦車軌道' });
      p.put('cart', 6, 11, 2, 1, { name: '礦車' });
      p.scatter('pillar', 6, { x: 1, y: 1, w: 26, h: 18 });
      p.scatter('rubble', 5, { x: 1, y: 1, w: 26, h: 18 }, [2, 1]);
      p.put('cracked_wall', 19, 2, 1, 2, { name: '鬆動的岩壁' });
      p.scatter('crystal', 5, { x: 20, y: 1, w: 7, h: 18 });
      p.put('pit', 12, 3, 2, 2, { name: '豎井' });
      p.put('rope', 14, 3, 1, 1);
      p.scatter('crate', 3, { x: 1, y: 13, w: 8, h: 6 });
      p.scatter('barrel', 2, { x: 1, y: 13, w: 8, h: 6 });
      p.put('lever', 24, 17);
      p.put('chest', 25, 2, 1, 1, { props: { locked: true }, name: '工頭的箱子' });
      p.trap(14, 13, '落石'); p.trap(22, 10, '瓦斯');
    },
  }),
  T({
    id: 'goblin_lair', name: '哥布林巢穴', group: '地城', cols: 26, rows: 20, blurb: '洞口的路障、篝火大廳、關俘虜的籠子、首領的骨頭王座。',
    build(p) {
      p.room(0, 0, 26, 20, [{ side: 's', at: 11, kind: 'gap', width: 3 }]);
      p.put('barricade', 9, 16, 2, 1, { name: '粗糙路障' }); p.put('barricade', 15, 16, 2, 1);
      p.trap(12, 17, '絆索'); p.trap(13, 15, '尖木坑');
      p.put('fire', 12, 9, 2, 2, { name: '營火' });
      p.scatter('sack', 4, { x: 2, y: 6, w: 20, h: 8 });
      p.scatter('bush', 3, { x: 1, y: 14, w: 24, h: 5 });
      p.line('wall', 6, 1, 7, true, [{ at: 3, width: 1 }]);
      p.put('cage', 2, 2, 2, 2, { name: '俘虜籠', props: { locked: true } });
      p.put('cage', 2, 5, 1, 1, { props: { locked: true } });
      p.line('wall', 19, 1, 7, true, [{ at: 5, width: 1 }]);
      p.put('throne', 22, 2, 2, 1, { name: '骨頭王座' });
      p.put('treasure', 24, 4); p.put('chest', 21, 5, 1, 1, { props: { locked: true } });
      p.put('weapon_rack', 7, 12, 2, 1);
      p.scatter('stalagmite', 5, { x: 1, y: 1, w: 24, h: 18 });
      p.scatter('rubble', 3);
      p.label('首領房', 20, 1, 4); p.label('牢房', 1, 1, 4);
    },
  }),
  T({
    id: 'crypt', name: '地下墓穴', group: '地城', cols: 24, rows: 24, blurb: '石棺排成列的走廊、封住的墓室、地上的符文陣。',
    build(p) {
      p.room(0, 0, 24, 24, [{ side: 'n', at: 11, kind: 'gate', width: 2 }]);
      p.room(2, 2, 8, 8, [{ side: 'e', at: 4 }]);
      p.room(14, 2, 8, 8, [{ side: 'w', at: 4, locked: true }]);
      p.room(2, 14, 8, 8, [{ side: 'e', at: 3, kind: 'cracked_wall' }]);
      p.room(14, 14, 8, 8, [{ side: 'w', at: 3 }]);
      for (let y = 3; y <= 8; y += 2) { p.put('altar', 4, y, 2, 1, { name: '石棺' }); p.put('altar', 16, y, 2, 1, { name: '石棺' }); }
      p.put('rune_circle', 10, 10, 4, 4, { name: '封印陣' });
      p.put('statue', 11, 15); p.put('statue', 12, 15);
      p.put('treasure', 18, 18); p.put('chest', 17, 19, 1, 1, { props: { locked: true } });
      p.put('brazier', 3, 15); p.put('brazier', 8, 20);
      p.scatter('web', 4, { x: 1, y: 1, w: 22, h: 22 });
      p.scatter('rubble', 3, { x: 10, y: 1, w: 4, h: 22 });
      p.trap(11, 6, '刀刃陷阱'); p.trap(12, 18, '毒針'); p.trap(19, 5, '落地門');
      p.put('lever', 20, 20, 1, 1, { name: '墓門機關' });
    },
  }),
  T({
    id: 'cave', name: '天然洞窟', group: '地城', cols: 28, rows: 20, blurb: '鐘乳石、地下水池、發光蘑菇和一段要爬上去的岩棚。',
    build(p) {
      p.line('cliff', 0, 0, 28, false); p.line('cliff', 0, 19, 28, false, [{ at: 2, width: 3 }]);
      p.line('cliff', 0, 1, 18, true); p.line('cliff', 27, 1, 18, true);
      p.ground('water', 10, 7, 6, 5, { name: '地下水池' });
      p.line('cliff', 18, 1, 9, true, [{ at: 4, width: 1 }]);
      p.put('ladder', 18, 5);
      p.scatter('stalagmite', 10, { x: 1, y: 1, w: 26, h: 18 });
      p.scatter('mushroom', 7, { x: 1, y: 1, w: 17, h: 18 });
      p.scatter('crystal', 4, { x: 19, y: 1, w: 8, h: 9 });
      p.scatter('rock', 5);
      p.scatter('rubble', 3, undefined, [2, 1]);
      p.put('pit', 6, 14, 2, 2, { name: '深坑' });
      p.put('treasure', 24, 3);
    },
  }),
  T({
    id: 'prison', name: '地牢牢房', group: '地城', cols: 24, rows: 18, blurb: '一排牢房、守衛室、刑具和通往地面的樓梯。',
    build(p) {
      p.room(0, 0, 24, 18);
      for (let i = 0; i < 5; i++) {
        const x = 1 + i * 4;
        p.line('wall', x + 3, 1, 5, true);
        p.put('gate', x + 1, 5, 1, 1, { name: `牢房 ${i + 1}`, props: { locked: true } });
        p.line('wall', x, 5, 1, false); p.line('wall', x + 2, 5, 1, false);
        if (p.chance(0.7)) p.put('bed', x, 1, 1, 2); else p.put('sack', x + 1, 2);
      }
      p.room(14, 10, 10, 8, [{ side: 'w', at: 3 }]);
      p.put('table', 17, 12, 2, 1); p.put('chair', 16, 12); p.put('chair', 19, 12);
      p.put('weapon_rack', 21, 11, 2, 1); p.put('chest', 22, 15, 1, 1, { name: '鑰匙箱', props: { locked: true } });
      p.put('stairs', 1, 15, 2, 2, { name: '往上的樓梯' });
      p.put('anvil', 6, 12); p.put('brazier', 8, 12); p.put('rope', 5, 9);
      p.put('lever', 13, 7, 1, 1, { name: '牢門總開關' });
      p.trap(10, 15, '壓力板');
      p.label('守衛室', 15, 16, 4);
    },
  }),
  T({
    id: 'dragon_lair', name: '巨龍巢穴', group: '地城', cols: 30, rows: 24, blurb: '熔岩河、堆成山的寶藏、碎裂的石柱和焦黑的骨頭。',
    build(p) {
      p.line('cliff', 0, 0, 30, false); p.line('cliff', 0, 23, 30, false, [{ at: 13, width: 4 }]);
      p.line('cliff', 0, 1, 22, true); p.line('cliff', 29, 1, 22, true);
      p.river('lava', 2, false, 14, 1);
      p.put('bridge', 14, 13, 2, 4, { name: '石橋', rotation: 90 });
      p.put('treasure', 12, 3, 3, 2, { name: '龍的寶藏' }); p.put('treasure', 16, 4, 2, 2);
      p.scatter('chest', 3, { x: 8, y: 2, w: 14, h: 6 }, [1, 1], { props: { locked: true } });
      p.scatter('pillar', 6, { x: 2, y: 2, w: 26, h: 10 });
      p.scatter('rubble', 6, undefined, [2, 1]);
      p.scatter('rock', 5, { x: 1, y: 17, w: 28, h: 5 });
      p.scatter('fire', 3, { x: 2, y: 2, w: 26, h: 10 });
      p.scatter('crystal', 3, { x: 1, y: 1, w: 28, h: 10 });
      p.put('cracked_wall', 28, 6, 1, 3, { name: '裂開的岩壁' });
    },
  }),
  T({
    id: 'spider_nest', name: '蜘蛛巢', group: '地城', cols: 24, rows: 20, blurb: '滿是蛛網的洞穴，繭吊在角落，中間是個大坑。',
    build(p) {
      p.line('cliff', 0, 0, 24, false); p.line('cliff', 0, 19, 24, false, [{ at: 2, width: 2 }]);
      p.line('cliff', 0, 1, 18, true); p.line('cliff', 23, 1, 18, true);
      p.put('pit', 10, 8, 4, 4, { name: '巢穴深坑' });
      p.put('rope', 14, 9, 1, 1, { name: '垂下的蛛絲' });
      p.scatter('web', 16, { x: 1, y: 1, w: 22, h: 18 }, [1, 1]);
      p.scatter('web', 3, { x: 1, y: 1, w: 22, h: 18 }, [2, 2]);
      p.scatter('sack', 5, { x: 1, y: 1, w: 22, h: 7 }, [1, 1], { name: '繭' });
      p.scatter('stalagmite', 6);
      p.scatter('mushroom', 3);
      p.put('treasure', 20, 2);
    },
  }),
  T({
    id: 'ice_cavern', name: '冰封洞窟', group: '地城', cols: 26, rows: 20, blurb: '滑溜的冰面、凍住的瀑布、冰晶柱和半埋在雪裡的寶箱。',
    build(p) {
      p.line('cliff', 0, 0, 26, false); p.line('cliff', 0, 19, 26, false, [{ at: 11, width: 3 }]);
      p.line('cliff', 0, 1, 18, true); p.line('cliff', 25, 1, 18, true);
      p.ground('ice', 4, 5, 8, 6, { name: '冰湖' }); p.ground('ice', 14, 9, 7, 5);
      p.ground('water', 7, 7, 2, 2, { name: '冰窟窿' });
      p.scatter('crystal', 8, undefined, [1, 1], { name: '冰柱' });
      p.scatter('rock', 6);
      p.put('cliff', 20, 1, 1, 6, { name: '凍住的瀑布' });
      p.put('chest', 22, 3, 1, 1, { props: { locked: true } });
      p.put('pit', 16, 3, 2, 1, { name: '冰縫' });
    },
  }),

  // ---------- 野外 ----------
  T({
    id: 'grassland', name: '開闊草原', group: '野外', cols: 30, rows: 20, blurb: '高草叢、零星的樹和大石頭，一條小溪穿過。適合騎兵和伏擊。',
    build(p) {
      p.river('water', 2, true, 20, 1);
      p.scatter('tall_grass', 8, undefined, [3, 2]);
      p.scatter('tall_grass', 6, undefined, [2, 2]);
      p.scatter('tree', 5);
      p.scatter('rock', 5);
      p.scatter('bush', 6);
      p.scatter('log', 2, undefined, [2, 1]);
    },
  }),
  T({
    id: 'forest', name: '森林小徑', group: '野外', cols: 28, rows: 22, blurb: '密林中的一條路，倒下的樹幹、灌木叢和一間獵人小屋。',
    build(p) {
      p.ground('mud', 0, 10, 28, 2, { name: '泥濘小路' });
      p.scatter('tree', 30, { x: 0, y: 0, w: 28, h: 9 });
      p.scatter('tree', 30, { x: 0, y: 13, w: 28, h: 9 });
      p.scatter('bush', 10);
      p.put('log', 12, 9, 3, 1, { name: '倒下的樹' });
      p.room(20, 15, 6, 5, [{ side: 'n', at: 2 }]);
      p.put('bed', 21, 17, 1, 2); p.put('fire', 24, 16); p.put('crate', 24, 18);
      p.scatter('mushroom', 4);
      p.trap(6, 11, '捕獸夾');
    },
  }),
  T({
    id: 'swamp', name: '沼澤', group: '野外', cols: 28, rows: 22, blurb: '泥沼、水塘和腐朽的木棧道，霧裡藏著東西。',
    build(p) {
      for (let i = 0; i < 7; i++) p.ground('water', p.int(0, 24), p.int(0, 18), p.int(2, 4), p.int(2, 3));
      for (let i = 0; i < 9; i++) p.ground('mud', p.int(0, 24), p.int(0, 18), p.int(2, 5), p.int(1, 3));
      p.put('bridge', 3, 10, 10, 1, { name: '木棧道' });
      p.put('bridge', 13, 6, 1, 5, { rotation: 90 });
      p.scatter('tall_grass', 10, undefined, [2, 1]);
      p.scatter('tree', 8);
      p.scatter('log', 3, undefined, [2, 1]);
      p.scatter('mushroom', 5);
      p.put('tent', 22, 2, 3, 3, { name: '女巫小屋' });
      p.put('well', 21, 6, 1, 1, { name: '冒泡的鍋' });
    },
  }),
  T({
    id: 'river_crossing', name: '渡河', group: '野外', cols: 30, rows: 20, blurb: '一條湍急的河，一座窄橋，兩岸各有掩體。',
    build(p) {
      p.river('water', 4, true, 13, 0);
      p.put('bridge', 12, 9, 6, 2, { name: '木橋' });
      p.scatter('rock', 4, { x: 0, y: 0, w: 12, h: 20 });
      p.scatter('rock', 4, { x: 18, y: 0, w: 12, h: 20 });
      p.scatter('tree', 6, { x: 0, y: 0, w: 11, h: 20 });
      p.scatter('tree', 6, { x: 19, y: 0, w: 11, h: 20 });
      p.put('barricade', 20, 8, 1, 2); p.put('barricade', 20, 11, 1, 2);
      p.scatter('bush', 6);
      p.put('rope', 12, 3, 1, 1, { name: '渡河繩' });
    },
  }),
  T({
    id: 'cliff_pass', name: '山隘', group: '野外', cols: 30, rows: 20, blurb: '兩邊是峭壁的窄道，上方岩棚可以埋伏，路上有落石。',
    build(p) {
      p.put('cliff', 0, 0, 30, 5, { name: '北側峭壁' });
      p.put('cliff', 0, 15, 30, 5, { name: '南側峭壁' });
      p.put('cliff', 8, 5, 4, 2); p.put('cliff', 19, 13, 5, 2);
      p.put('ladder', 12, 5); p.put('rope', 18, 14);
      p.scatter('rock', 8, { x: 0, y: 5, w: 30, h: 10 });
      p.scatter('rubble', 5, { x: 0, y: 5, w: 30, h: 10 }, [2, 1]);
      p.put('barricade', 26, 8, 1, 4, { name: '關卡' });
      p.trap(15, 10, '落石');
    },
  }),
  T({
    id: 'camp', name: '野營地', group: '野外', cols: 24, rows: 18, blurb: '圍著營火的帳篷、馬車、柵欄，夜襲的好地方。',
    build(p) {
      p.room(3, 2, 18, 14, [{ side: 's', at: 8, kind: 'gap', width: 2 }, { side: 'n', at: 4, kind: 'gap', width: 1 }], 'fence');
      p.put('fire', 11, 8, 2, 2, { name: '營火' });
      p.put('tent', 5, 4, 3, 3); p.put('tent', 15, 4, 3, 3); p.put('tent', 5, 10, 3, 3);
      p.put('cart', 15, 11, 3, 2, { name: '補給馬車' });
      p.scatter('crate', 3, { x: 4, y: 3, w: 16, h: 12 });
      p.scatter('barrel', 2, { x: 4, y: 3, w: 16, h: 12 });
      p.put('weapon_rack', 9, 4, 2, 1);
      p.scatter('tree', 8, { x: 0, y: 0, w: 24, h: 18 });
      p.scatter('bush', 4);
    },
  }),

  // ---------- 城鎮 ----------
  T({
    id: 'town_square', name: '市鎮廣場', group: '城鎮', cols: 30, rows: 22, blurb: '噴泉、攤販、四周的店面和巷子。',
    build(p) {
      p.room(1, 1, 8, 6, [{ side: 's', at: 3 }, { side: 's', at: 6, kind: 'window' }]);
      p.room(21, 1, 8, 6, [{ side: 's', at: 4 }]);
      p.room(1, 15, 8, 6, [{ side: 'n', at: 4 }]);
      p.room(21, 15, 8, 6, [{ side: 'n', at: 3 }, { side: 'n', at: 1, kind: 'window' }]);
      p.label('鐵匠鋪', 2, 2, 4); p.label('旅店', 22, 2, 4); p.label('雜貨店', 2, 16, 4); p.label('神殿', 22, 16, 4);
      p.put('anvil', 4, 4); p.put('bed', 25, 3, 1, 2); p.put('altar', 24, 18, 2, 1); p.put('bookshelf', 3, 19, 3, 1);
      p.put('well', 14, 10, 2, 2, { name: '噴泉' });
      p.put('statue', 14, 8);
      p.scatter('cart', 2, { x: 10, y: 3, w: 10, h: 16 }, [2, 1], { name: '攤車' });
      p.scatter('crate', 5, { x: 10, y: 2, w: 10, h: 18 });
      p.scatter('barrel', 4, { x: 10, y: 2, w: 10, h: 18 });
      p.scatter('tree', 4, { x: 9, y: 1, w: 12, h: 20 });
    },
  }),
  T({
    id: 'tavern', name: '酒館', group: '城鎮', cols: 22, rows: 16, blurb: '吧台、圓桌、壁爐和樓梯，一場酒館鬥毆隨時開打。',
    build(p) {
      p.room(0, 0, 22, 16, [{ side: 's', at: 10, width: 2 }, { side: 's', at: 4, kind: 'window' }, { side: 's', at: 16, kind: 'window' }, { side: 'n', at: 19 }]);
      p.put('table', 2, 2, 8, 1, { name: '吧台' });
      p.put('barrel', 2, 1); p.put('barrel', 4, 1); p.put('bookshelf', 6, 1, 3, 1, { name: '酒架' });
      p.put('fire', 20, 7, 1, 2, { name: '壁爐' });
      for (const [x, y] of [[4, 6], [9, 6], [14, 6], [4, 10], [9, 10], [14, 10]] as const) {
        p.put('table', x, y, 2, 2);
        p.put('chair', x - 1, y); p.put('chair', x + 2, y + 1); if (p.chance(0.5)) p.put('chair', x, y + 2);
      }
      p.put('stairs', 18, 1, 2, 3, { name: '上二樓' });
      p.put('crate', 1, 13); p.put('chest', 1, 4, 1, 1, { name: '錢箱', props: { locked: true } });
    },
  }),
  T({
    id: 'village', name: '小村莊', group: '城鎮', cols: 30, rows: 24, blurb: '散落的農舍、菜園柵欄、水井和村口的路。',
    build(p) {
      p.ground('mud', 13, 0, 3, 24, { name: '村道' });
      const houses = [[2, 2], [2, 13], [19, 3], [20, 14]] as const;
      for (const [x, y] of houses) {
        p.room(x, y, 7, 6, [{ side: x < 13 ? 'e' : 'w', at: 2 }, { side: 'n', at: 3, kind: 'window' }]);
        p.put('bed', x + 1, y + 1, 1, 2); p.put('table', x + 3, y + 3, 2, 1);
      }
      p.room(3, 9, 7, 3, [{ side: 'e', at: 1, kind: 'gap' }], 'fence');
      p.scatter('bush', 3, { x: 4, y: 10, w: 5, h: 1 });
      p.put('well', 16, 11, 1, 1);
      p.scatter('tree', 8);
      p.scatter('sack', 3); p.scatter('barrel', 3); p.put('cart', 17, 19, 2, 1);
    },
  }),
  T({
    id: 'market', name: '露天市集', group: '城鎮', cols: 28, rows: 20, blurb: '一排排帳篷攤位、貨箱堆、人潮擁擠的窄道。',
    build(p) {
      for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
        const x = 2 + col * 5, y = 2 + row * 6;
        if (p.chance(0.8)) p.put('tent', x, y, 3, 2, { name: '攤位' });
        p.scatter(p.pickOne(['crate', 'barrel', 'sack'] as const), 2, { x, y: y + 2, w: 4, h: 2 });
      }
      p.put('cart', 24, 9, 2, 1); p.put('well', 13, 9, 1, 1);
      p.scatter('table', 3, undefined, [2, 1]);
    },
  }),
  T({
    id: 'castle_hall', name: '城堡大廳', group: '城鎮', cols: 26, rows: 22, blurb: '兩排石柱、紅毯盡頭的王座、側門和守衛的武器架。',
    build(p) {
      p.room(0, 0, 26, 22, [{ side: 's', at: 12, kind: 'gate', width: 2 }, { side: 'w', at: 10 }, { side: 'e', at: 10, locked: true }]);
      for (let y = 4; y <= 17; y += 3) { p.put('pillar', 7, y); p.put('pillar', 18, y); }
      p.put('throne', 12, 2, 2, 1, { name: '王座' });
      p.put('stairs', 10, 3, 6, 1, { name: '王座台階' });
      p.put('statue', 9, 2); p.put('statue', 16, 2);
      p.put('brazier', 3, 3); p.put('brazier', 22, 3);
      p.put('weapon_rack', 2, 18, 2, 1); p.put('weapon_rack', 22, 18, 2, 1);
      p.put('table', 2, 7, 1, 3); p.put('table', 23, 7, 1, 3);
      p.put('bookshelf', 1, 13, 1, 3);
    },
  }),

  // ---------- 特殊 ----------
  T({
    id: 'temple', name: '荒廢神廟', group: '特殊', cols: 24, rows: 22, blurb: '傾倒的神像、祭壇、符文陣，牆上有裂縫可以鑽。',
    build(p) {
      p.room(1, 1, 22, 20, [{ side: 's', at: 10, width: 2 }, { side: 'e', at: 5, kind: 'cracked_wall' }, { side: 'w', at: 14, kind: 'cracked_wall' }]);
      p.put('altar', 10, 3, 4, 1, { name: '主祭壇' });
      p.put('rune_circle', 9, 6, 6, 6, { name: '召喚陣' });
      for (let y = 5; y <= 17; y += 4) { p.put('pillar', 4, y); p.put('pillar', 19, y); }
      p.put('statue', 6, 3); p.put('statue', 17, 3);
      p.put('rubble', 5, 14, 2, 2, { name: '倒下的神像' });
      p.scatter('rubble', 4, { x: 2, y: 2, w: 20, h: 18 });
      p.put('brazier', 9, 3); p.put('brazier', 14, 3);
      p.put('chest', 20, 2, 1, 1, { props: { locked: true } });
      p.trap(11, 14, '神聖符文'); p.trap(12, 4, '祭壇詛咒');
      p.put('lever', 2, 2, 1, 1, { name: '暗門機關' });
    },
  }),
  T({
    id: 'library', name: '法師圖書館', group: '特殊', cols: 24, rows: 18, blurb: '一排排書架、閱讀桌、魔法陣和鎖著的禁書區。',
    build(p) {
      p.room(0, 0, 24, 18, [{ side: 's', at: 11, width: 2 }]);
      for (let x = 2; x <= 12; x += 3) p.put('bookshelf', x, 2, 1, 6);
      p.room(16, 1, 7, 7, [{ side: 'w', at: 3, locked: true }]);
      p.label('禁書區', 17, 2, 4);
      p.put('bookshelf', 18, 4, 4, 1); p.put('chest', 21, 6, 1, 1, { props: { locked: true } });
      p.put('table', 4, 11, 3, 2); p.put('table', 10, 11, 3, 2);
      p.scatter('chair', 4, { x: 3, y: 10, w: 11, h: 4 });
      p.put('rune_circle', 17, 10, 4, 4, { name: '傳送陣' });
      p.put('crystal', 22, 12); p.put('brazier', 16, 9);
      p.put('stairs', 1, 14, 2, 3, { name: '螺旋梯' });
      p.trap(16, 4, '警報符文');
    },
  }),
  T({
    id: 'arena', name: '競技場', group: '特殊', cols: 24, rows: 24, blurb: '圓形沙地、觀眾席欄杆、鐵柵門和場中的障礙物。',
    build(p) {
      p.room(1, 1, 22, 22, [{ side: 'n', at: 10, kind: 'gate', width: 2, locked: true }, { side: 's', at: 10, kind: 'gate', width: 2 }], 'fence');
      p.room(0, 0, 24, 24, [], 'wall');
      p.put('pillar', 7, 7); p.put('pillar', 16, 7); p.put('pillar', 7, 16); p.put('pillar', 16, 16);
      p.put('spikes', 11, 11, 2, 2, { name: '尖刺陣' });
      p.scatter('barricade', 3, { x: 3, y: 3, w: 18, h: 18 }, [2, 1]);
      p.scatter('rock', 3, { x: 3, y: 3, w: 18, h: 18 });
      p.put('weapon_rack', 3, 20, 2, 1); p.put('weapon_rack', 19, 3, 2, 1);
      p.put('lever', 22, 12, 1, 1, { name: '放出野獸' });
      p.put('cage', 2, 11, 1, 2, { name: '野獸籠', props: { locked: true } });
    },
  }),
  T({
    id: 'ruins', name: '古代遺跡', group: '特殊', cols: 28, rows: 22, blurb: '斷牆殘柱、長滿草的庭院和一口通往地下的井。',
    build(p) {
      p.room(3, 3, 10, 8, [{ side: 'e', at: 3, kind: 'gap', width: 2 }, { side: 's', at: 4, kind: 'cracked_wall' }]);
      p.room(16, 10, 9, 9, [{ side: 'w', at: 4, kind: 'gap', width: 2 }, { side: 'n', at: 6, kind: 'cracked_wall' }]);
      p.scatter('rubble', 8, undefined, [1, 1]);
      p.scatter('pillar', 6);
      p.scatter('tall_grass', 6, undefined, [2, 2]);
      p.scatter('tree', 5); p.scatter('bush', 5);
      p.put('well', 7, 6, 1, 1, { name: '通往地下的井' }); p.put('rope', 8, 6);
      p.put('statue', 20, 14); p.put('rune_circle', 3, 15, 3, 3);
      p.put('treasure', 22, 12);
      p.trap(10, 14, '坍塌地板');
    },
  }),
  T({
    id: 'bandit_hideout', name: '盜賊藏身處', group: '特殊', cols: 26, rows: 20, blurb: '廢棄倉庫改的據點：貨箱迷宮、瞭望台、暗門和贓物。',
    build(p) {
      p.room(0, 0, 26, 20, [{ side: 's', at: 4, width: 2 }, { side: 'e', at: 14, locked: true }, { side: 'n', at: 20, kind: 'window' }]);
      p.scatter('crate', 14, { x: 2, y: 2, w: 14, h: 15 }, [2, 1]);
      p.scatter('crate', 6, { x: 2, y: 2, w: 14, h: 15 });
      p.scatter('barrel', 5, { x: 2, y: 2, w: 14, h: 15 });
      p.room(17, 1, 8, 7, [{ side: 's', at: 2 }]);
      p.put('table', 19, 3, 2, 2); p.put('chair', 18, 3); p.put('chair', 21, 4);
      p.put('chest', 23, 2, 1, 1, { name: '贓物箱', props: { locked: true } }); p.put('treasure', 23, 5);
      p.put('ladder', 16, 12); p.put('bridge', 17, 12, 7, 1, { name: '瞭望走道', height: 10 });
      p.put('bed', 22, 15, 1, 2); p.put('bed', 20, 15, 1, 2);
      p.trap(5, 17, '絆鈴'); p.trap(24, 14, '弩箭陷阱');
    },
  }),
];

export const templateById = (id: string) => MAP_TEMPLATES.find((t) => t.id === id);

/** Lays out a template: the grid size plus every object, ready to insert. */
export function buildTemplate(t: MapTemplate, seed: number): { cols: number; rows: number; objects: Placed[] } {
  const p = new Plan(t.cols, t.rows, seed);
  t.build(p);
  return { cols: t.cols, rows: t.rows, objects: p.objects };
}

/** What the browser needs for its picker; the recipes stay on the server. */
export const templateList = () => MAP_TEMPLATES.map(({ id, name, blurb, group, cols, rows }) => ({ id, name, blurb, group, cols, rows }));
