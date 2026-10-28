import { useMemo, useState } from 'react';
import {
  ATTRIBUTES, CLASSES, SKILLS, attributeCreationMax, attributeTotal, exampleBuild, maxHp, skillTierName, skillTotal, validateDraft,
  type CharacterDraft,
} from '../../../src/character/create';
import { RULES_V03 as R } from '../../../src/rules/config';
import type { AttributeCode } from '../../../src/rules/types';
import type { Api } from '../api';
import { useAction } from '../hooks';

const empty = (): CharacterDraft => ({
  name: '', classId: CLASSES[0].id, skills: {},
  attributes: Object.fromEntries(ATTRIBUTES.map((a) => [a.code, 0])) as Record<AttributeCode, number>,
});

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <span className="stepper">
      <button aria-label={`${label}減一`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <b>{value}</b>
      <button aria-label={`${label}加一`} disabled={value >= max} onClick={() => onChange(value + 1)}>＋</button>
    </span>
  );
}

export function CreateCharacter({ api, go }: { api: Api; go: (p: string) => void }) {
  const [d, setD] = useState<CharacterDraft>(empty);
  const { busy, error, run } = useAction();
  const cls = CLASSES.find((c) => c.id === d.classId)!;
  const errors = useMemo(() => validateDraft(d, R), [d]);
  const attrLeft = R.attribute.creationPoints - attributeTotal(d);
  const skillLeft = R.skill.creationPoints - skillTotal(d);
  const categories = [...new Set(SKILLS.map((s) => s.category))];

  return (
    <main className="page stack">
      <h1>建立角色</h1>
      <p className="muted">規則 v0.3：屬性共 {R.attribute.creationPoints} 點，技能共 {R.skill.creationPoints} 點、每項最多 {R.skill.creationMax} 點，職業核心技能合計至少 {R.skill.creationCoreMin} 點。角色死亡是永久的。</p>

      <div className="card stack">
        <label>角色名稱<input value={d.name} maxLength={24} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
      </div>

      <div className="card stack">
        <h2>職業</h2>
        <div className="picker">
          {CLASSES.map((c) => (
            <button key={c.id} aria-pressed={c.id === d.classId} onClick={() => setD({ ...d, classId: c.id })}>
              <b>{c.name}</b><br /><span className="muted small">{c.role}</span>
            </button>
          ))}
        </div>
        <p className="small">
          核心屬性：{cls.coreAttributes.map((a) => ATTRIBUTES.find((x) => x.code === a)!.name).join('、')}；
          核心技能：{cls.coreSkills.map((k) => SKILLS.find((x) => x.id === k)!.name).join('、')}；特色：{cls.feature}
        </p>
        <div className="row">
          <button onClick={() => setD({ ...exampleBuild(d.classId, R), name: d.name })}>套用這個職業的範例配點</button>
          <span className="muted small">範例只是合法的起點，不是最強配法。</span>
        </div>
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>屬性</h2>
          <span className={`counter ${attrLeft === 0 ? 'done' : ''}`}>剩 {attrLeft} 點</span>
        </div>
        <div className="grid2">
          {ATTRIBUTES.map((a) => (
            <div key={a.code} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{a.name} <span className="muted small">{a.code}</span></span>
              <Stepper label={a.name} value={d.attributes[a.code]} min={R.attribute.min}
                max={Math.min(attributeCreationMax(R), d.attributes[a.code] + Math.max(0, attrLeft))}
                onChange={(v) => setD({ ...d, attributes: { ...d.attributes, [a.code]: v } })} />
            </div>
          ))}
        </div>
        <p className="muted small">生命值 {maxHp(d.attributes, R)}（{R.hp.base}＋{R.hp.perVit}×體魄，原型暫定公式）</p>
      </div>

      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>技能</h2>
          <span className={`counter ${skillLeft === 0 ? 'done' : ''}`}>剩 {skillLeft} 點</span>
        </div>
        {categories.map((cat) => (
          <div key={cat} className="stack">
            <h3 className="muted">{cat}</h3>
            <div className="grid2">
              {SKILLS.filter((s) => s.category === cat).map((s) => {
                const v = d.skills[s.id] ?? 0;
                return (
                  <div key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span>{s.name}{cls.coreSkills.includes(s.id) && <span className="muted small">（核心）</span>} <span className="muted small">{skillTierName(v, R)}</span></span>
                    <Stepper label={s.name} value={v} min={0} max={Math.min(R.skill.creationMax, v + Math.max(0, skillLeft))}
                      onChange={(n) => setD({ ...d, skills: { ...d.skills, [s.id]: n } })} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {errors.length > 0 && <ul className="muted small">{errors.map((e) => <li key={e.field + e.message}>{e.message}</li>)}</ul>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="primary" disabled={busy || errors.length > 0} onClick={() => void run(async () => {
          await api.createCharacter({ ...d, name: d.name.trim() });
          go('');
        })}>建立 {d.name.trim() || '角色'}</button>
        <button onClick={() => go('')}>取消</button>
      </div>
    </main>
  );
}
