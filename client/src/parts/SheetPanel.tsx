import { useMemo } from 'react';
import { checkBonus, computeSheet, labeller, type CheckTarget } from '../../../src/pack/pack';
import type { CharacterView, CheckMode, Pack, RollTarget } from '../api';
import { fmt } from './CharacterForm';
import { StorySection } from './TextFields';

/** `1d20 + @score.body` → `1d20 + 體魄`: formulas in the words of the sheet. */
const words = (pack: Pack, src: string, values?: Map<string, number>) => {
  const label = labeller(pack);
  // `roll(1, @melee_die)` reads better as the die it is on this sheet: 1d8.
  const dice = values ? src.replace(/roll\((\d+),\s*@([\w.]+)\)/g, (m, n: string, p: string) => (values.has(p) ? `${n}d${values.get(p)}` : m)) : src;
  return dice.replace(/@([\w.]+)/g, (m, p: string) => label(p) ?? m);
};
const signed = (n: number) => (n >= 0 ? `+${fmt(n)}` : fmt(n));

/**
 * A character sheet that rolls: tap an attribute or a skill for a check, or an action button for an attack with
 * its damage. Every number the server worked out shows the sum behind it.
 */
export function SheetPanel({ pack, character, mode, setMode, secret, setSecret, busy, roll, onEdit, onSaveTexts }: {
  pack: Pack;
  character: CharacterView;
  mode: CheckMode;
  setMode: (m: CheckMode) => void;
  secret: boolean;
  setSecret: (s: boolean) => void;
  busy: boolean;
  roll: (t: RollTarget) => void;
  onEdit: () => void;
  /** Saves the sheet's written fields (story, notes) without opening the whole form. */
  onSaveTexts: (texts: Record<string, string>) => Promise<unknown>;
}) {
  const { data, sheet, id } = character;
  const showMod = pack.modifier !== '@score';
  // The server's sheet is the record; the browser works the same sheet out again only to print check bonuses.
  const local = useMemo(() => { try { return computeSheet(pack, data); } catch { return null; } }, [pack, data]);
  const bonus = (t: CheckTarget) => { try { return local ? signed(checkBonus(pack, local, t)) : ''; } catch { return ''; } };
  const score = (a: Pack['attributes'][number]) => sheet[`score.${a.id}`]?.value ?? data.scores[a.id] ?? a.default;
  const hidden = new Set(character.hiddenActions ?? []);
  const features = character.features ?? [];
  return (
    <div className="sheet">
      <div className="sheet-head">
        <h2>{character.name}</h2>
        <button className="link" onClick={onEdit}>編輯角色</button>
      </div>

      <div className="modes row" role="group" aria-label="擲骰方式">
        {pack.checks.advantage || pack.checks.disadvantage ? (
          (['normal', 'advantage', 'disadvantage'] as const).filter((m) => m === 'normal' || pack.checks[m]).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{{ normal: '一般', advantage: '優勢', disadvantage: '劣勢' }[m]}</button>
          ))
        ) : null}
        <label className="tick"><input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />暗骰（只有 GM 看得到）</label>
      </div>

      <div className="attrs">
        {pack.attributes.map((a) => (
          <button key={a.id} className="attr" disabled={busy} title={`${a.name}檢定${a.description ? `：${a.description}` : ''}`}
            onClick={() => roll({ characterId: id, check: { attribute: a.id }, mode })}>
            <span>{a.name}</span>
            <b>{showMod ? signed(sheet[`mod.${a.id}`]?.value ?? 0) : score(a)}</b>
            {showMod && <small title={sheet[`score.${a.id}`]?.text}>{score(a)}</small>}
          </button>
        ))}
      </div>

      {(pack.checks.extra ?? []).map((x) => (
        <section key={x.id} className="block">
          <h3>{x.label}</h3>
          <div className="saves">
            {pack.attributes.map((a) => {
              // A save formula such as `… + @flag.save_{attr} * @prof` names the flag that marks proficiency.
              const flag = /@flag\.(\w*)\{attr\}/.exec(x.formula)?.[1];
              const proficient = flag !== undefined && (local?.values.get(`flag.${flag}${a.id}`) ?? 0) > 0;
              return (
                <button key={a.id} disabled={busy} className={proficient ? 'on' : undefined} title={`${a.name}${x.label}${proficient ? '（熟練）' : ''}`}
                  onClick={() => roll({ characterId: id, check: { attribute: a.id, extra: x.id }, mode })}>
                  <span>{a.abbr ?? a.name}</span><b>{bonus({ attribute: a.id, extra: x.id })}</b>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {pack.actions.length > 0 && (
        <section className="block">
          <h3>動作</h3>
          <div className="actions">
            {pack.actions.filter((a) => !hidden.has(a.id)).map((a) => (
              <button key={a.id} disabled={busy} title={a.description} onClick={() => roll({ characterId: id, action: a.id })}>
                <b>{a.label}</b>
                <small>{words(pack, a.roll)}{a.damage ? `｜傷害 ${words(pack, a.damage, local?.values)}` : ''}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {pack.derived.length > 0 && (
        <section className="block">
          <h3>數值</h3>
          <dl className="derived">
            {pack.derived.filter((d) => !sheet[d.id]?.hidden).map((d) => (
              <div key={d.id} title={d.description}><dt>{d.label}</dt><dd><b>{fmt(sheet[d.id]?.value)}</b><small>{sheet[d.id]?.text}</small></dd></div>
            ))}
            {pack.inputs.map((i) => (
              <div key={i.id} title={i.description}><dt>{i.label}</dt><dd><b>{data.inputs[i.id] ?? i.default}</b></dd></div>
            ))}
          </dl>
        </section>
      )}

      {pack.skills.length > 0 && (
        <section className="block">
          <h3>技能（點一下擲檢定）</h3>
          <ul className="skills">
            {pack.skills.map((s) => {
              const rank = data.ranks[s.id] ?? 0;
              return (
                <li key={s.id}>
                  <button disabled={busy} title={s.description} data-rank={rank || undefined} onClick={() => roll({ characterId: id, check: { skill: s.id }, mode })}>
                    <span>{s.name} <small className="muted">{pack.attributes.find((a) => a.id === s.attribute)?.abbr}</small></span>
                    <span className={rank ? 'rank' : 'rank none'} title={rank ? `等級 ${rank}` : '未受訓練'}>{bonus({ skill: s.id }) || rank}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {features.length > 0 && (
        <section className="block">
          <h3>特性</h3>
          <div className="features">
            {features.map((f, i) => (
              <details key={`${f.from}-${f.name}-${i}`}>
                <summary><span>{f.name}</span><small className="muted">{f.from}{f.level > 1 ? `・${f.level} 級` : ''}</small></summary>
                <p>{f.text}</p>
              </details>
            ))}
          </div>
        </section>
      )}

      <StorySection pack={pack} texts={data.texts ?? {}} canEdit onSave={onSaveTexts} />
    </div>
  );
}
