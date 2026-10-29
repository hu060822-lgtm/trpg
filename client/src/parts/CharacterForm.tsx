import { useMemo, useState } from 'react';
import { computeSheet, validateCharacter } from '../../../src/pack/pack';
import type { CharacterData, Pack } from '../api';
import { useAction, useDraft } from '../hooks';
import { ErrorNote } from './ui';

const defaults = (pack: Pack): CharacterData => ({
  scores: Object.fromEntries(pack.attributes.map((a) => [a.id, a.default])),
  ranks: Object.fromEntries(pack.skills.map((s) => [s.id, 0])),
  inputs: Object.fromEntries(pack.inputs.map((i) => [i.id, i.default])),
});

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <span className="stepper">
      <button type="button" className="icon" aria-label={`${label}減一`} data-tip={`${label}減一`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <b key={value} className="bump" aria-live="polite">{value}</b>
      <button type="button" className="icon" aria-label={`${label}加一`} data-tip={`${label}加一`} disabled={value >= max} onClick={() => onChange(value + 1)}>＋</button>
    </span>
  );
}

/**
 * Builds or edits a character from whatever the room's rule pack defines. Points left, limits and the sheet's
 * worked-out numbers update as the player clicks; the server checks everything again when it is saved.
 */
export function CharacterForm({ pack, initial, creating, draftKey, onSave, onCancel }: {
  pack: Pack;
  initial?: { name: string; data: CharacterData };
  creating: boolean;
  /** Where an unfinished new character is kept in this browser until it is saved. */
  draftKey?: string;
  onSave: (name: string, data: CharacterData) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const start = (): { name: string; data: CharacterData } => {
    const d = defaults(pack);
    return initial
      ? { name: initial.name, data: { scores: { ...d.scores, ...initial.data.scores }, ranks: { ...d.ranks, ...initial.data.ranks }, inputs: { ...d.inputs, ...initial.data.inputs } } }
      : { name: '', data: d };
  };
  const [draft, setDraft, dropDraft] = useDraft(draftKey ?? null, start);
  // A saved draft from an older version of the pack may miss attributes or skills; fill them in from the defaults.
  const base = defaults(pack);
  const name = draft.name;
  const data: CharacterData = { scores: { ...base.scores, ...draft.data.scores }, ranks: { ...base.ranks, ...draft.data.ranks }, inputs: { ...base.inputs, ...draft.data.inputs } };
  const setName = (v: string) => setDraft((d) => ({ ...d, name: v }));
  const setData = (f: (d: CharacterData) => CharacterData) => setDraft((d) => ({ ...d, data: f(d.data) }));
  const [tried, setTried] = useState(false);
  const [nameLeft, setNameLeft] = useState(false);
  const save = useAction();
  const set = (part: keyof CharacterData, id: string, v: number) => setData((d) => ({ ...d, [part]: { ...d[part], [id]: v } }));

  const { budget, costs } = pack.creation.attributes;
  const attrSpent = pack.attributes.reduce((s, a) => s + (costs ? costs[String(data.scores[a.id])] ?? 0 : data.scores[a.id]), 0);
  const skillBudget = pack.creation.skills.budget;
  const skillSpent = pack.skills.reduce((s, x) => s + (data.ranks[x.id] ?? 0), 0);
  const maxRank = creating ? pack.creation.skills.maxRank : Math.max(pack.creation.skills.maxRank, 20);
  const key = JSON.stringify(data);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const problems = useMemo(() => validateCharacter(pack, data, creating), [pack, key, creating]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sheet = useMemo(() => { try { return computeSheet(pack, data).shown; } catch { return {}; } }, [pack, key]);
  const nameMissing = (tried || nameLeft) && !name.trim();
  // With a cost table, only scores the table prices can be bought at creation.
  const canBuy = (v: number) => !creating || !costs || Object.hasOwn(costs, String(v));

  return (
    <form className="stack sheet-form" noValidate onSubmit={(e) => {
      e.preventDefault();
      setTried(true);
      if (problems.length || !name.trim()) {
        (e.currentTarget.querySelector('[aria-invalid="true"], .problems') as HTMLElement | null)?.scrollIntoView({ block: 'center' });
        return;
      }
      void save.run(async () => { await onSave(name.trim(), data); dropDraft(); });
    }}>
      <label>角色名稱
        <input required maxLength={40} value={name} aria-invalid={nameMissing || undefined} aria-describedby={nameMissing ? 'name-error' : undefined}
          onChange={(e) => { setName(e.target.value); setNameLeft(false); }} onFocus={() => setNameLeft(false)} onBlur={() => setNameLeft(true)} />
      </label>
      {nameMissing && <p id="name-error" className="field-error">替角色取個名字，其他人會在紀錄和地圖上看到它。</p>}

      <fieldset>
        <legend>屬性{creating && budget !== undefined && <span className={`counter${attrSpent === budget ? ' done' : attrSpent > budget ? ' over' : ''}`}>剩 {budget - attrSpent} 點</span>}</legend>
        <div className="form-grid">
          {pack.attributes.map((a) => (
            <div key={a.id} className="field" title={a.description}>
              <span>{a.name}{sheet[`mod.${a.id}`] && pack.modifier !== '@score' && <small className="muted">（調整值 {fmt(sheet[`mod.${a.id}`].value)}）</small>}</span>
              <Stepper label={a.name} value={data.scores[a.id]} min={a.min} max={a.max}
                onChange={(v) => { if (canBuy(v)) set('scores', a.id, v); }} />
            </div>
          ))}
        </div>
        {creating && costs && <p className="muted small">購點表：{Object.entries(costs).map(([v, c]) => `${v}=${c}`).join('、')}</p>}
      </fieldset>

      {pack.skills.length > 0 && (
        <fieldset>
          <legend>技能{creating && skillBudget !== undefined && <span className={`counter${skillSpent === skillBudget ? ' done' : skillSpent > skillBudget ? ' over' : ''}`}>剩 {skillBudget - skillSpent} 點</span>}</legend>
          {creating && <p className="muted small">每個技能最多 {pack.creation.skills.maxRank} 級。</p>}
          <div className="form-grid">
            {pack.skills.map((s) => (
              <div key={s.id} className="field" title={s.description}>
                <span>{s.name} <small className="muted">{pack.attributes.find((a) => a.id === s.attribute)?.abbr ?? ''}</small></span>
                <Stepper label={s.name} value={data.ranks[s.id] ?? 0} min={0} max={maxRank} onChange={(v) => set('ranks', s.id, v)} />
              </div>
            ))}
          </div>
        </fieldset>
      )}

      {pack.inputs.length > 0 && (
        <fieldset>
          <legend>其他</legend>
          <div className="form-grid">
            {pack.inputs.map((i) => (
              <label key={i.id} className="field" title={i.description}>
                <span>{i.label}</span>
                <input type="number" inputMode="numeric" min={i.min} max={i.max} value={data.inputs[i.id]}
                  onChange={(e) => set('inputs', i.id, Number(e.target.value))} />
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {pack.derived.length > 0 && (
        <fieldset>
          <legend>自動計算</legend>
          <dl className="derived">
            {pack.derived.map((d) => (
              <div key={d.id}><dt>{d.label}</dt><dd><b>{fmt(sheet[d.id]?.value)}</b><small>{sheet[d.id]?.text}</small></dd></div>
            ))}
          </dl>
        </fieldset>
      )}

      {tried && problems.length > 0 && <ul className="problems" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <ErrorNote of={save} />
      <div className="row">
        <button className="primary" disabled={save.busy}>{save.busy ? '儲存中…' : creating ? '建立角色' : '儲存角色'}</button>
        {onCancel && <button type="button" onClick={onCancel}>取消</button>}
        {creating && <button type="button" className="link" onClick={() => setDraft(start())}>全部重來</button>}
      </div>
    </form>
  );
}

export const fmt = (n: number | undefined) => (n === undefined ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1));
