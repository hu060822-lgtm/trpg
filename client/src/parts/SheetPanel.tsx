import { labeller } from '../../../src/pack/pack';
import type { CharacterView, CheckMode, Pack, RollTarget } from '../api';
import { fmt } from './CharacterForm';

/** `1d20 + @score.body` → `1d20 + 體魄`: formulas in the words of the sheet. */
const words = (pack: Pack, src: string) => { const label = labeller(pack); return src.replace(/@([\w.]+)/g, (m, p: string) => label(p) ?? m); };
const signed = (n: number) => (n >= 0 ? `+${fmt(n)}` : fmt(n));

/**
 * A character sheet that rolls: tap an attribute or a skill for a check, or an action button for an attack with
 * its damage. Every number the server worked out shows the sum behind it.
 */
export function SheetPanel({ pack, character, mode, setMode, secret, setSecret, busy, roll, onEdit }: {
  pack: Pack;
  character: CharacterView;
  mode: CheckMode;
  setMode: (m: CheckMode) => void;
  secret: boolean;
  setSecret: (s: boolean) => void;
  busy: boolean;
  roll: (t: RollTarget) => void;
  onEdit: () => void;
}) {
  const { data, sheet, id } = character;
  const showMod = pack.modifier !== '@score';
  return (
    <div className="sheet">
      <div className="sheet-head">
        <h2>{character.name}</h2>
        <button className="link" onClick={onEdit}>編輯</button>
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
            <b>{showMod ? signed(sheet[`mod.${a.id}`]?.value ?? 0) : data.scores[a.id] ?? a.default}</b>
            {showMod && <small>{data.scores[a.id] ?? a.default}</small>}
          </button>
        ))}
      </div>

      {pack.actions.length > 0 && (
        <section className="block">
          <h3>動作</h3>
          <div className="actions">
            {pack.actions.map((a) => (
              <button key={a.id} disabled={busy} title={a.description} onClick={() => roll({ characterId: id, action: a.id })}>
                <b>{a.label}</b>
                <small>{words(pack, a.roll)}{a.damage ? `｜傷害 ${words(pack, a.damage)}` : ''}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {pack.derived.length > 0 && (
        <section className="block">
          <h3>數值</h3>
          <dl className="derived">
            {pack.derived.map((d) => (
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
                  <button disabled={busy} title={s.description} onClick={() => roll({ characterId: id, check: { skill: s.id }, mode })}>
                    <span>{s.name} <small className="muted">{pack.attributes.find((a) => a.id === s.attribute)?.abbr}</small></span>
                    <span className={rank ? 'rank' : 'rank none'}>{rank}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
