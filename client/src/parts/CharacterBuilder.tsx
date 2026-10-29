import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeSheet, methodsOf, pointsSpent, validateCharacter, type PackChoice, type PackMethod, type PackOption, type PackStep } from '../../../src/pack/pack';
import type { CharacterData, Pack } from '../api';
import { useAction, useDraft } from '../hooks';
import { fmt } from './CharacterForm';
import { ErrorNote, IconButton } from './ui';

type Page =
  | { id: 'start'; label: string }
  | { id: string; label: string; step: PackStep }
  | { id: 'scores' | 'skills' | 'more' | 'review'; label: string };

interface Draft { name: string; data: CharacterData; page: number }

const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));
const sameNumbers = (a: number[], b: number[]) => [...a].sort((x, y) => y - x).join(',') === [...b].sort((x, y) => y - x).join(',');

/** Starting scores for a method: an array is dealt out in order, a point buy starts everyone at its cheapest score. */
function scoresFor(pack: Pack, m: PackMethod | undefined): Record<string, number> {
  if (m?.kind === 'array') return Object.fromEntries(pack.attributes.map((a, i) => [a.id, m.values[i] ?? a.default]));
  if (m?.kind === 'pointbuy' && Object.keys(m.costs).length) {
    const cheapest = Math.min(...Object.keys(m.costs).map(Number));
    return Object.fromEntries(pack.attributes.map((a) => [a.id, cheapest]));
  }
  return Object.fromEntries(pack.attributes.map((a) => [a.id, a.default]));
}

function fresh(pack: Pack): Draft {
  const m = methodsOf(pack)[0];
  return {
    name: '', page: 0,
    data: {
      method: m?.id, scores: scoresFor(pack, m), ranks: {}, choices: {}, picks: {},
      inputs: Object.fromEntries(pack.inputs.map((i) => [i.id, i.default])),
    },
  };
}

/** Whether every choice inside the option picked for this step is made in full. */
function choiceDone(ch: PackChoice, p: string[] | Record<string, number> | undefined) {
  if (p === undefined) return false;
  if (ch.kind === 'bonus') return !Array.isArray(p) && (ch.patterns ?? []).some((pat) => sameNumbers(pat, Object.values(p).filter((v) => v !== 0)));
  return Array.isArray(p) && p.length === ch.count;
}

/**
 * Builds a character one step at a time from the pack's builder: class, background, species, then scores, with
 * the finished sheet growing beside it. Everything is kept in this browser until it is saved, and the server
 * checks every choice again.
 */
export function CharacterBuilder({ pack, draftKey, onSave, onClose }: {
  pack: Pack;
  draftKey: string;
  onSave: (name: string, data: CharacterData) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draft, setDraft, dropDraft] = useDraft<Draft>(draftKey, () => fresh(pack));
  const base = fresh(pack).data;
  const data: CharacterData = {
    ...base, ...draft.data,
    scores: { ...base.scores, ...draft.data.scores }, inputs: { ...base.inputs, ...draft.data.inputs },
    choices: draft.data.choices ?? {}, picks: draft.data.picks ?? {}, ranks: draft.data.ranks ?? {},
  };
  const setData = (f: (d: CharacterData) => CharacterData) => setDraft((d) => ({ ...d, data: f({ ...data, ...d.data, choices: d.data.choices ?? {}, picks: d.data.picks ?? {} }) }));
  const methods = methodsOf(pack);

  const pages: Page[] = [
    { id: 'start', label: '開始' },
    ...pack.builder.map((step) => ({ id: step.id, label: step.label, step })),
    { id: 'scores', label: '屬性' },
    ...(pack.creation.skills.maxRank > 0 ? [{ id: 'skills' as const, label: '技能' }] : []),
    ...(pack.inputs.length ? [{ id: 'more' as const, label: '裝備與等級' }] : []),
    { id: 'review', label: '確認' },
  ];
  const at = Math.min(draft.page, pages.length - 1);
  const page = pages[at];
  const go = (i: number) => setDraft((d) => ({ ...d, page: Math.max(0, Math.min(pages.length - 1, i)) }));

  const key = JSON.stringify(data);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const problems = useMemo(() => validateCharacter(pack, data, true), [pack, key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sheet = useMemo(() => { try { return computeSheet(pack, data); } catch { return null; } }, [pack, key]);

  const done = (p: Page): boolean => {
    if (p.id === 'start') return draft.name.trim().length > 0;
    if ('step' in p) {
      const option = p.step.options.find((o) => o.id === data.choices?.[p.step.id]);
      return !!option && (option.choices ?? []).every((ch) => choiceDone(ch, data.picks?.[`${p.step.id}.${ch.id}`]));
    }
    if (p.id === 'scores') return !problems.some((x) => pack.attributes.some((a) => x.startsWith(a.name)) || x.includes('屬性'));
    if (p.id === 'skills') return !problems.some((x) => x.includes('技能點數') || x.includes('的等級要在'));
    return true;
  };

  // Each step's heading takes focus so a screen reader announces where the player is now.
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } heading.current?.focus(); }, [at]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) onClose(); };
    addEventListener('keydown', esc);
    return () => { document.body.style.overflow = prev; removeEventListener('keydown', esc); };
  }, [onClose]);

  const save = useAction();
  const [tried, setTried] = useState(false);
  const create = () => {
    setTried(true);
    if (problems.length || !draft.name.trim()) return;
    void save.run(async () => { await onSave(draft.name.trim(), data); dropDraft(); });
  };

  // Portalled to the page body: the room's columns would otherwise trap a fixed panel inside them.
  return createPortal(
    <div className="builder" role="dialog" aria-modal="true" aria-labelledby="builder-title">
      <header className="builder-bar">
        <h1 id="builder-title">建立角色<small>{pack.manifest.name}</small></h1>
        <IconButton label="先離開（進度會留著）" onClick={onClose}>✕</IconButton>
      </header>

      <nav className="builder-rail" aria-label="建立步驟">
        <ol>
          {pages.map((p, i) => (
            <li key={p.id}>
              <button type="button" aria-current={i === at ? 'step' : undefined} className={done(p) && p.id !== 'review' ? 'done' : undefined} onClick={() => go(i)}>
                <span className="step-mark" aria-hidden>{done(p) && p.id !== 'review' ? '✓' : i + 1}</span>
                <span>{p.label}</span>
                {'step' in p && data.choices?.[p.id] && <small>{p.step.options.find((o) => o.id === data.choices?.[p.id])?.name}</small>}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <main className="builder-main">
        <div key={page.id} className="builder-page">
          <h2 ref={heading} tabIndex={-1}>{page.id === 'start' ? '你的角色叫什麼？' : page.label}</h2>
          {page.id === 'start' && <StartPage pack={pack} pages={pages} name={draft.name} setName={(name) => setDraft((d) => ({ ...d, name }))} tried={tried} />}
          {'step' in page && <StepPage pack={pack} step={page.step} data={data} setData={setData} />}
          {page.id === 'scores' && <ScoresPage pack={pack} methods={methods} data={data} setData={setData} sheet={sheet} />}
          {page.id === 'skills' && <SkillsPage pack={pack} data={data} setData={setData} sheet={sheet} />}
          {page.id === 'more' && <MorePage pack={pack} data={data} setData={setData} />}
          {page.id === 'review' && (
            <>
              <p className="muted">檢查一下角色卡。之後升級、換裝備，都可以在角色卡按「編輯角色」調整。</p>
              {problems.length > 0 && (
                <div className="problems" role={tried ? 'alert' : undefined}>
                  <p>還有 {problems.length} 件事要處理：</p>
                  <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
                </div>
              )}
              {!draft.name.trim() && <p className="field-error">回到第一步替角色取個名字。</p>}
              <Preview pack={pack} name={draft.name} data={data} sheet={sheet} full />
            </>
          )}
        </div>

        {page.id !== 'review' && (
          <details className="builder-peek">
            <summary>看目前的角色卡</summary>
            <Preview pack={pack} name={draft.name} data={data} sheet={sheet} />
          </details>
        )}

        <ErrorNote of={save} />
        <div className="builder-nav">
          {at > 0 && <button type="button" onClick={() => go(at - 1)}>上一步</button>}
          <span className="grow" />
          {page.id === 'start' && <button type="button" className="link" onClick={() => setDraft(fresh(pack))}>全部重來</button>}
          {page.id === 'review'
            ? <button type="button" className="primary" disabled={save.busy} onClick={create}>{save.busy ? '建立中…' : '建立角色'}</button>
            : <button type="button" className="primary" onClick={() => go(at + 1)}>下一步：{pages[at + 1].label}</button>}
        </div>
      </main>

      <aside className="builder-aside" aria-label="角色卡預覽">
        <Preview pack={pack} name={draft.name} data={data} sheet={sheet} />
      </aside>
    </div>,
    document.body,
  );
}

function StartPage({ pack, pages, name, setName, tried }: { pack: Pack; pages: Page[]; name: string; setName: (v: string) => void; tried: boolean }) {
  const [left, setLeft] = useState(false);
  const missing = (tried || left) && !name.trim();
  return (
    <div className="stack">
      <label>角色名稱
        <input autoFocus maxLength={40} value={name} aria-invalid={missing || undefined} aria-describedby={missing ? 'builder-name-error' : undefined}
          onChange={(e) => { setName(e.target.value); setLeft(false); }} onBlur={() => setLeft(true)} />
      </label>
      {missing && <p id="builder-name-error" className="field-error">替角色取個名字，其他人會在紀錄和地圖上看到它。</p>}
      <section className="primer">
        <h3>第一次玩？</h3>
        <p>照順序做完這幾步就能上桌，每一步都可以回頭改：</p>
        <ol>
          {pages.filter((p) => 'step' in p).map((p) => (
            <li key={p.id}><b>{p.label}</b>　{'step' in p && p.step.description}</li>
          ))}
          <li><b>屬性</b>　決定角色天生的強項與弱項。選「{methodsOf(pack)[0]?.label}」最快。</li>
        </ol>
        <p className="muted small">右邊（手機在下方）的角色卡會跟著你的選擇即時算好。做到一半離開，進度會留在這個瀏覽器。</p>
      </section>
    </div>
  );
}

/** What an option gives, in words: hit die, proficiencies, bonuses. Read from the grants, so any pack works. */
function GrantSummary({ pack, option }: { pack: Pack; option: PackOption }) {
  const g = option.grants ?? {};
  const lines: string[] = [];
  for (const [k, v] of Object.entries(g.values ?? {})) {
    const value = pack.values.find((x) => x.id === k);
    if (value && v !== value.default) lines.push(`${value.label} ${v}`);
  }
  const flags = Object.entries(g.flags ?? {}).filter(([, v]) => v).map(([k]) => pack.flags.find((f) => f.id === k)?.label ?? k);
  if (flags.length) lines.push(flags.join('、'));
  const ranks = Object.keys(g.ranks ?? {}).map((k) => pack.skills.find((s) => s.id === k)?.name ?? k);
  if (ranks.length) lines.push(`技能熟練：${ranks.join('、')}`);
  for (const [k, v] of Object.entries(g.bonuses ?? {})) lines.push(`${pack.attributes.find((a) => a.id === k)?.name ?? k} ${signed(v)}`);
  if (!lines.length) return null;
  return <ul className="grants">{lines.map((l) => <li key={l}>{l}</li>)}</ul>;
}

function StepPage({ pack, step, data, setData }: { pack: Pack; step: PackStep; data: CharacterData; setData: (f: (d: CharacterData) => CharacterData) => void }) {
  const chosen = step.options.find((o) => o.id === data.choices?.[step.id]);
  const choose = (o: PackOption) => setData((d) => {
    if (d.choices?.[step.id] === o.id) return d;
    // Picks inside the previous option no longer apply.
    const picks = Object.fromEntries(Object.entries(d.picks ?? {}).filter(([k]) => !k.startsWith(`${step.id}.`)));
    return { ...d, choices: { ...d.choices, [step.id]: o.id }, picks };
  });
  return (
    <div className="stack">
      {step.description && <p className="muted">{step.description}</p>}
      <div className="option-grid" role="radiogroup" aria-label={step.label}>
        {step.options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={chosen?.id === o.id} className="option" onClick={() => choose(o)}>
            <b>{o.name}</b>
            {o.description && <small>{o.description.split('。')[0]}。</small>}
            {o.tags && o.tags.length > 0 && <span className="tags">{o.tags.join('、')}</span>}
          </button>
        ))}
      </div>
      {chosen && (
        <section className="option-detail" aria-live="polite">
          <h3>{chosen.name}</h3>
          {chosen.description && <p>{chosen.description}</p>}
          <GrantSummary pack={pack} option={chosen} />
          {(chosen.choices ?? []).map((ch) => <ChoiceField key={ch.id} pack={pack} step={step} choice={ch} data={data} setData={setData} />)}
          <Features option={chosen} />
        </section>
      )}
    </div>
  );
}

function Features({ option }: { option: PackOption }) {
  const all = option.grants?.features ?? [];
  if (!all.length) return null;
  const now = all.filter((f) => f.level <= 1);
  const later = all.filter((f) => f.level > 1);
  return (
    <div className="features">
      {now.map((f) => <details key={f.name}><summary><span>{f.name}</span></summary><p>{f.text}</p></details>)}
      {later.length > 0 && (
        <details className="later">
          <summary><span>之後的等級會得到</span><small className="muted">{later.length} 項</small></summary>
          {later.map((f) => <p key={`${f.level}-${f.name}`}><b>{f.level} 級・{f.name}</b>　{f.text}</p>)}
        </details>
      )}
    </div>
  );
}

function ChoiceField({ pack, step, choice: ch, data, setData }: {
  pack: Pack; step: PackStep; choice: PackChoice; data: CharacterData; setData: (f: (d: CharacterData) => CharacterData) => void;
}) {
  const key = `${step.id}.${ch.id}`;
  const value = data.picks?.[key];
  const set = (v: string[] | Record<string, number>) => setData((d) => ({ ...d, picks: { ...d.picks, [key]: v } }));
  const [full, setFull] = useState(false);
  // What the character already has without this choice decides which skills make sense to pick.
  const others = useMemo(() => {
    try { return computeSheet(pack, { ...data, picks: { ...data.picks, [key]: [] } }).values; } catch { return null; }
  }, [pack, data, key]);

  if (ch.kind === 'bonus') return <BonusField pack={pack} choice={ch} value={Array.isArray(value) ? undefined : value} set={set} />;

  const picked = Array.isArray(value) ? value : [];
  const toggle = (id: string) => {
    if (picked.includes(id)) { setFull(false); set(picked.filter((x) => x !== id)); return; }
    if (picked.length >= (ch.count ?? 1)) {
      if (ch.count === 1) { set([id]); return; }
      setFull(true);
      return;
    }
    set([...picked, id]);
  };
  const counter = <span className={`counter${picked.length === ch.count ? ' done' : ''}`}>已選 {picked.length}／{ch.count}</span>;

  if (ch.kind === 'pick') {
    return (
      <fieldset className="choice">
        <legend>{ch.label}{counter}</legend>
        {ch.description && <p className="muted small">{ch.description}</p>}
        <div className="pick-list">
          {(ch.options ?? []).map((o) => (
            <button key={o.id} type="button" role={ch.count === 1 ? 'radio' : 'checkbox'} aria-checked={picked.includes(o.id)} className="option" onClick={() => toggle(o.id)}>
              <b>{o.name}</b><small>{o.text}</small>
            </button>
          ))}
        </div>
        {full && <p className="field-error">已經選滿 {ch.count} 個了，先取消一個再選。</p>}
      </fieldset>
    );
  }

  const pool = ch.from ?? pack.skills.map((s) => s.id);
  return (
    <fieldset className="choice">
      <legend>{ch.label}{counter}</legend>
      {ch.description && <p className="muted small">{ch.description}</p>}
      {ch.kind === 'expertise' && <p className="muted small">專精讓熟練加值變成兩倍，只能選已經熟練的技能。先選好上面的技能和背景。</p>}
      <div className="chips">
        {pool.map((id) => {
          const s = pack.skills.find((x) => x.id === id);
          const rank = others?.get(`rank.${id}`) ?? 0;
          const blocked = ch.kind === 'expertise' ? rank < 1 : rank >= 1;
          const on = picked.includes(id);
          return (
            <button key={id} type="button" role="checkbox" aria-checked={on} className={`chip${blocked && !on ? ' blocked' : ''}`}
              title={blocked ? (ch.kind === 'expertise' ? '還不熟練' : '已經從別的地方熟練了') : undefined}
              onClick={() => toggle(id)}>
              {s?.name ?? id}
              {blocked && !on && <small>{ch.kind === 'expertise' ? '未熟練' : '已熟練'}</small>}
            </button>
          );
        })}
      </div>
      {full && <p className="field-error">已經選滿 {ch.count} 個了，先取消一個再選。</p>}
    </fieldset>
  );
}

/** Spreads bonuses over attributes, e.g. +2 to one and +1 to another, or +1 to three. */
function BonusField({ pack, choice: ch, value, set }: { pack: Pack; choice: PackChoice; value: Record<string, number> | undefined; set: (v: Record<string, number>) => void }) {
  const from = ch.from ?? pack.attributes.map((a) => a.id);
  const patterns = ch.patterns ?? [];
  const given = Object.entries(value ?? {}).filter(([, v]) => v !== 0).sort((x, y) => y[1] - x[1]);
  const [pattern, setPattern] = useState(() => Math.max(0, patterns.findIndex((p) => sameNumbers(p, given.map(([, v]) => v)))));
  const pat = [...(patterns[pattern] ?? [])].sort((x, y) => y - x);
  // Slot i holds the attribute that gets pat[i]; read back from the stored bonuses in the same order.
  const slots = pat.map((_, i) => given[i]?.[0] ?? '');
  const name = (id: string) => pack.attributes.find((a) => a.id === id)?.name ?? id;
  const store = (s: string[]) => set(Object.fromEntries(s.map((id, i) => [id, pat[i]] as const).filter(([id]) => id)));
  const pickPattern = (i: number) => {
    setPattern(i);
    const p = [...patterns[i]].sort((x, y) => y - x);
    // When the pattern uses every allowed attribute there is nothing to decide.
    set(p.length === from.length ? Object.fromEntries(from.map((id, j) => [id, p[j]])) : {});
  };
  return (
    <fieldset className="choice">
      <legend>{ch.label}</legend>
      <p className="muted small">可以加在{from.map(name).join('、')}。加值會直接算進屬性，上限仍然是 {pack.attributes[0]?.max}。</p>
      <div className="modes row" role="radiogroup" aria-label="分法">
        {patterns.map((p, i) => (
          <button key={i} type="button" role="radio" aria-checked={i === pattern} onClick={() => pickPattern(i)}>{p.map(signed).join('／')}</button>
        ))}
      </div>
      <div className="slots">
        {pat.map((n, i) => (
          <label key={i} className="field">
            <span>{signed(n)} 加在</span>
            <select value={slots[i]} onChange={(e) => {
              const next = [...slots];
              const was = next.indexOf(e.target.value);
              if (was >= 0) next[was] = next[i];
              next[i] = e.target.value;
              store(next);
            }}>
              <option value="">選一項屬性</option>
              {from.map((id) => <option key={id} value={id}>{name(id)}</option>)}
            </select>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const METHOD_HELP: Record<PackMethod['kind'], string> = {
  array: '把這組數字分給每項屬性，各用一次。最快也最平衡，推薦第一次玩的人。',
  pointbuy: '用點數買每項屬性，越高越貴。想要精準控制強弱時用。',
  free: '自己擲骰（例如 4d6 去掉最低的一顆）或照 GM 給的數字填。伺服器只檢查上下限。',
};

function ScoresPage({ pack, methods, data, setData, sheet }: {
  pack: Pack; methods: PackMethod[]; data: CharacterData; setData: (f: (d: CharacterData) => CharacterData) => void; sheet: ReturnType<typeof computeSheet> | null;
}) {
  const method = methods.find((m) => m.id === data.method) ?? methods[0];
  const setScore = (id: string, v: number) => setData((d) => ({ ...d, scores: { ...d.scores, [id]: v } }));
  const spent = method.kind === 'pointbuy' ? pointsSpent(pack, method, data.scores) : 0;
  const bonus = (id: string) => (sheet?.values.get(`score.${id}`) ?? 0) - (data.scores[id] ?? 0);
  return (
    <div className="stack">
      {methods.length > 1 && (
        <div className="modes row" role="radiogroup" aria-label="屬性的決定方式">
          {methods.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={m.id === method.id}
              onClick={() => setData((d) => (d.method === m.id ? d : { ...d, method: m.id, scores: scoresFor(pack, m) }))}>{m.label}</button>
          ))}
        </div>
      )}
      <p className="muted small">{METHOD_HELP[method.kind]}</p>
      {method.kind === 'pointbuy' && (
        <p><span className={`counter${spent === method.budget ? ' done' : spent > method.budget ? ' over' : ''}`}>剩 {method.budget - spent} 點</span>
          {Object.keys(method.costs).length > 0 && <small className="muted">　購點表：{Object.entries(method.costs).map(([v, c]) => `${v}=${c}`).join('、')}</small>}</p>
      )}
      <div className="score-table" role="table" aria-label="屬性">
        <div role="row" className="score-row head">
          <span role="columnheader">屬性</span><span role="columnheader">基礎</span><span role="columnheader">加值</span><span role="columnheader">最後</span><span role="columnheader">調整值</span>
        </div>
        {pack.attributes.map((a) => {
          const v = data.scores[a.id] ?? a.default;
          const b = bonus(a.id);
          const priced = method.kind === 'pointbuy' && Object.keys(method.costs).length ? Object.keys(method.costs).map(Number) : null;
          const lo = priced ? Math.min(...priced) : a.min;
          const hi = priced ? Math.max(...priced) : a.max;
          return (
            <div role="row" key={a.id} className="score-row" title={a.description}>
              <span role="rowheader"><b>{a.name}</b>{a.description && <small className="muted">{a.description}</small>}</span>
              <span role="cell">
                {method.kind === 'array' ? (
                  <select aria-label={`${a.name}的基礎值`} value={v} onChange={(e) => {
                    const n = Number(e.target.value);
                    // Taking a number another attribute holds swaps the two, so each number stays used once.
                    setData((d) => {
                      const other = pack.attributes.find((x) => x.id !== a.id && (d.scores[x.id] ?? x.default) === n);
                      return { ...d, scores: { ...d.scores, [a.id]: n, ...(other ? { [other.id]: d.scores[a.id] ?? a.default } : {}) } };
                    });
                  }}>
                    {[...new Set(method.values)].sort((x, y) => y - x).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                ) : (
                  <span className="stepper">
                    <button type="button" className="icon" aria-label={`${a.name}減一`} data-tip={`${a.name}減一`} disabled={v <= lo} onClick={() => setScore(a.id, v - 1)}>−</button>
                    <b key={v} className="bump" aria-live="polite">{v}</b>
                    <button type="button" className="icon" aria-label={`${a.name}加一`} data-tip={`${a.name}加一`} disabled={v >= hi} onClick={() => setScore(a.id, v + 1)}>＋</button>
                  </span>
                )}
              </span>
              <span role="cell" className={b ? 'plus' : 'muted'}>{b ? signed(b) : '—'}</span>
              <span role="cell"><b className="final">{sheet?.values.get(`score.${a.id}`) ?? v}</b></span>
              <span role="cell">{signed(sheet?.values.get(`mod.${a.id}`) ?? 0)}</span>
            </div>
          );
        })}
      </div>
      {pack.builder.length > 0 && <p className="muted small">「加值」來自前面選的{pack.builder.map((s) => s.label).join('、')}。</p>}
    </div>
  );
}

function SkillsPage({ pack, data, setData, sheet }: { pack: Pack; data: CharacterData; setData: (f: (d: CharacterData) => CharacterData) => void; sheet: ReturnType<typeof computeSheet> | null }) {
  const budget = pack.creation.skills.budget;
  const spent = pack.skills.reduce((s, x) => s + (data.ranks[x.id] ?? 0), 0);
  const max = pack.creation.skills.maxRank;
  return (
    <div className="stack">
      <p className="muted small">每個技能最多 {max} 級。{budget !== undefined && <span className={`counter${spent === budget ? ' done' : spent > budget ? ' over' : ''}`}>剩 {budget - spent} 點</span>}</p>
      <div className="form-grid">
        {pack.skills.map((s) => {
          const v = data.ranks[s.id] ?? 0;
          const from = (sheet?.values.get(`rank.${s.id}`) ?? 0) > v;
          return (
            <div key={s.id} className="field" title={s.description}>
              <span>{s.name}{from && <small className="muted">（已熟練）</small>}</span>
              <span className="stepper">
                <button type="button" className="icon" aria-label={`${s.name}減一`} data-tip={`${s.name}減一`} disabled={v <= 0} onClick={() => setData((d) => ({ ...d, ranks: { ...d.ranks, [s.id]: v - 1 } }))}>−</button>
                <b key={v} className="bump">{v}</b>
                <button type="button" className="icon" aria-label={`${s.name}加一`} data-tip={`${s.name}加一`} disabled={v >= max} onClick={() => setData((d) => ({ ...d, ranks: { ...d.ranks, [s.id]: v + 1 } }))}>＋</button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MorePage({ pack, data, setData }: { pack: Pack; data: CharacterData; setData: (f: (d: CharacterData) => CharacterData) => void }) {
  return (
    <div className="stack">
      <p className="muted small">還沒決定裝備可以先跳過，角色卡上的數字會照預設值算，之後再改。</p>
      {pack.inputs.map((i) => (
        <label key={i.id} className="input-row">
          <span><b>{i.label}</b>{i.description && <small className="muted">{i.description}</small>}</span>
          <input type="number" inputMode="numeric" min={i.min} max={i.max} value={data.inputs[i.id] ?? i.default}
            onChange={(e) => setData((d) => ({ ...d, inputs: { ...d.inputs, [i.id]: Number(e.target.value) } }))} />
        </label>
      ))}
    </div>
  );
}

/** The sheet as it stands: what each choice so far adds up to. */
function Preview({ pack, name, data, sheet, full }: { pack: Pack; name: string; data: CharacterData; sheet: ReturnType<typeof computeSheet> | null; full?: boolean }) {
  if (!sheet) return <p className="muted small">角色卡還算不出來，先完成前面的選擇。</p>;
  const picked = pack.builder.map((s) => s.options.find((o) => o.id === data.choices?.[s.id])?.name).filter(Boolean);
  const proficient = pack.skills.filter((s) => (sheet.values.get(`rank.${s.id}`) ?? 0) > 0);
  const derived = pack.derived.filter((d) => !sheet.shown[d.id]?.hidden);
  return (
    <div className={`preview${full ? ' full' : ''}`}>
      <div className="preview-head">
        <h3>{name.trim() || '還沒取名字'}</h3>
        {picked.length > 0 && <p className="muted small">{picked.join('・')}</p>}
      </div>
      <div className="attrs">
        {pack.attributes.map((a) => (
          <div key={a.id} className="attr">
            <span>{a.name}</span>
            <b>{pack.modifier !== '@score' ? signed(sheet.values.get(`mod.${a.id}`) ?? 0) : sheet.values.get(`score.${a.id}`)}</b>
            {pack.modifier !== '@score' && <small>{sheet.values.get(`score.${a.id}`)}</small>}
          </div>
        ))}
      </div>
      <dl className="derived">
        {(full ? derived : derived.slice(0, 6)).map((d) => (
          <div key={d.id}><dt>{d.label}</dt><dd><b>{fmt(sheet.shown[d.id]?.value)}</b>{full && <small>{sheet.shown[d.id]?.text}</small>}</dd></div>
        ))}
      </dl>
      {proficient.length > 0 && (
        <p className="small"><span className="muted">熟練　</span>{proficient.map((s) => `${s.name}${(sheet.values.get(`rank.${s.id}`) ?? 0) > 1 ? '（專精）' : ''}`).join('、')}</p>
      )}
      {sheet.features.length > 0 && (full ? (
        <div className="features">
          {sheet.features.map((f, i) => <details key={`${f.name}-${i}`}><summary><span>{f.name}</span><small className="muted">{f.from}</small></summary><p>{f.text}</p></details>)}
        </div>
      ) : <p className="small"><span className="muted">特性　</span>{sheet.features.map((f) => f.name).join('、')}</p>)}
    </div>
  );
}
