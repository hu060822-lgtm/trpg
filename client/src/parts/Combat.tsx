import { useState } from 'react';
import { COMBAT_V03 as CFG, canAct, weapon } from '../../../src/combat/engine';
import type { CombatAction, CombatEvent, Combatant } from '../../../src/combat/types';
import { RULES_V03 as R } from '../../../src/rules/config';
import type { Api, Combat } from '../api';
import { useAction } from '../hooks';

const COND: Record<string, string> = {
  healthy: '健康', wounded: '受傷', severe: '重傷', dying: '瀕死', stable: '昏迷', dead: '死亡', escaped: '已脫離', deathPending: '待 GM 確認',
};
const TIER: Record<string, string> = Object.fromEntries(R.tiers.map((t) => [t.key, t.name]));

export function describeCombatEvent(c: Combat, e: CombatEvent): string | null {
  const d = e.data as Record<string, any>;
  const name = (id?: string) => (id ? c.combatants[id]?.name ?? id : '');
  const who = name(e.combatantId);
  switch (e.kind) {
    case 'combatStarted': return `戰鬥開始。行動順序：${(d.order as string[]).map(name).join('、')}`;
    case 'moved': return `${who} 移動到${CFG.bands.names[d.to]}`;
    case 'attack': return `${who} 攻擊 ${name(d.targetId)}：d20 ${d.d20.join('／')}，合計 ${d.total} 對防禦 ${d.defense}，${TIER[d.tier]}${d.damage ? `，造成 ${d.damage} 點傷害` : ''}`;
    case 'defend': return `${who}${d.automatic ? '逾時，自動' : ''}採取防禦姿態`;
    case 'potion': return `${who} 讓 ${name(d.targetId)} 喝下藥水，生命回到 ${d.hp}`;
    case 'rescue': return `${who} 救援 ${name(d.targetId)}：合計 ${d.total}，${TIER[d.tier]}`;
    case 'revivedToFight': return `${who} 重新站起來，生命 ${d.hp}`;
    case 'stabilized': return `${who} 穩定下來${d.reason === 'protected' ? '（離線保護）' : ''}`;
    case 'dying': return `${who} 倒下，進入瀕死`;
    case 'dyingHit': return `${who} 瀕死時再受傷，失敗累積 ${d.failures}`;
    case 'deathSave': return d.result === 'natural-20' ? `${who} 瀕死判定擲出自然 20，自行穩定`
      : `${who} 瀕死判定：d20 ${d.d20}，合計 ${d.total}，${d.success ? '成功' : '失敗'}（成功 ${d.successes}／失敗 ${d.failures}）`;
    case 'deathPending': return `${who} 的死亡要等 GM 確認`;
    case 'death': return `${who} 永久死亡`;
    case 'escapeAttempt': return `${who} 嘗試脫離：合計 ${d.total}，${TIER[d.tier]}`;
    case 'escaped': return `${who} 脫離戰鬥`;
    case 'timeout': return `${who} 的回合逾時`;
    case 'combatEnded': return `戰鬥結束`;
    default: return null;
  }
}

/** One fight: the field by distance band, whose turn it is, and the actions open to whoever controls that combatant. */
export function CombatPanel({ api, worldId, combat, mine, onChange }: {
  api: Api; worldId: string; combat: Combat; mine: (c: Combatant) => boolean; onChange: () => void;
}) {
  const { busy, error, run } = useAction();
  const [target, setTarget] = useState('');
  const turn = combat.turn;
  const actor = turn ? combat.combatants[turn.combatantId] : undefined;
  const myTurn = !!actor && mine(actor);
  const fighters = combat.order.map((id) => combat.combatants[id]);
  const foes = actor ? fighters.filter((f) => f.side !== actor.side && canAct(f)) : [];
  const downAllies = actor ? fighters.filter((f) => f.side === actor.side && f.id !== actor.id && (f.condition === 'dying' || f.condition === 'stable')) : [];
  const act = (action: CombatAction) => run(async () => { await api.act(worldId, combat, actor!.id, action); onChange(); });
  const chosen = foes.find((f) => f.id === target) ?? foes[0];
  const events = (combat.events ?? []).slice(-10).map((e) => ({ seq: e.seq, text: describeCombatEvent(combat, e) })).filter((e) => e.text);

  return (
    <div className="fight">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>戰鬥　第 {combat.round} 輪</h2>
        {actor && <span className="small">輪到 <b>{actor.name}</b>，行動點 {turn!.ap}{turn!.kind === 'deathSave' ? '，瀕死判定' : ''}，期限 {new Date(turn!.deadline).toLocaleString()}</span>}
      </div>
      <div className="bands" style={{ ['--bands' as string]: CFG.bands.count }}>
        {CFG.bands.names.map((band, i) => (
          <div key={band} className="band">
            <small>{band}</small>
            {fighters.filter((f) => f.band === i).map((f) => (
              <div key={f.id} className={`fighter ${f.id === actor?.id ? 'turn' : ''} ${f.controller === 'gm' ? 'foe' : ''} ${canAct(f) ? '' : 'down'}`}>
                <b>{f.name}</b>
                <div className="hp"><span style={{ width: `${(f.hp / f.maxHp) * 100}%` }} /></div>
                <span className="muted">{f.hp}/{f.maxHp}，{f.pendingDeath ? COND.deathPending : COND[f.condition] ?? f.condition}{f.defending ? '，防禦中' : ''}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {myTurn && actor && (
        <div className="stack card">
          {turn!.kind === 'deathSave' ? (
            <div className="row">
              <span>{actor.name} 倒下了，命運由這一擲決定。</span>
              <button className="primary" disabled={busy} onClick={() => void act({ type: 'deathSave' })}>擲瀕死判定</button>
            </div>
          ) : (
            <>
              <div className="row">
                <span className="muted small">{actor.name} 使用{weapon(actor.weaponId).name}</span>
                {foes.length > 0 && (
                  <>
                    <select aria-label="攻擊目標" value={chosen?.id} onChange={(e) => setTarget(e.target.value)}>
                      {foes.map((f) => <option key={f.id} value={f.id}>{f.name}（{CFG.bands.names[f.band]}）</option>)}
                    </select>
                    <button className="primary" disabled={busy || !chosen} onClick={() => void act({ type: 'attack', targetId: chosen!.id })}>攻擊</button>
                  </>
                )}
                <button disabled={busy} onClick={() => void act({ type: 'defend' })}>防禦</button>
              </div>
              <div className="row">
                {actor.band > 0 && <button disabled={busy} onClick={() => void act({ type: 'move', to: actor.band - 1 })}>靠近（到{CFG.bands.names[actor.band - 1]}）</button>}
                {actor.band < CFG.bands.count - 1 && <button disabled={busy} onClick={() => void act({ type: 'move', to: actor.band + 1 })}>後退（到{CFG.bands.names[actor.band + 1]}）</button>}
                {actor.potions > 0 && <button disabled={busy} onClick={() => void act({ type: 'usePotion' })}>喝藥水（剩 {actor.potions}）</button>}
                {downAllies.map((a) => <button key={a.id} disabled={busy} onClick={() => void act({ type: 'rescue', targetId: a.id, useMedkit: actor.medkits > 0 })}>救援 {a.name}</button>)}
                <button disabled={busy} onClick={() => void act({ type: 'escape' })}>嘗試脫離</button>
                <button disabled={busy} onClick={() => void act({ type: 'endTurn' })}>結束回合</button>
              </div>
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}
      <ul className="list small muted">{events.map((e) => <li key={e.seq}>{e.text}</li>)}</ul>
    </div>
  );
}
