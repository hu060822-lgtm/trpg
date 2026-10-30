import { useState } from 'react';
import type { Api, FieldResult, FieldStart, MapObject, Token } from '../api';
import { DiceTray } from '../combat/DiceTray';
import { GesturePad } from '../combat/Gesture';
import { FIELD_ACTIONS, fieldActions, gapTo, isLockable, isTrap, type FieldAction } from '../../../src/table/fieldRules';
import { KINDS } from './MapObjects';
import { ErrorNote } from './ui';

/**
 * Doing something to a thing on the map: pick a token standing next to it and an action, throw the d20 in the tray,
 * do the action's gesture, and see whether it worked. The map changes by itself (the wall turns to rubble, the
 * climber stands on top) once the server settles it.
 */
export function FieldCard({ api, roomId, object: o, tokens, mine, gm, oneKey, contrast, onClose, onChanged }: {
  api: Api; roomId: string; object: MapObject; tokens: Token[]; mine: (t: Token) => boolean; gm: boolean; oneKey: boolean; contrast: boolean;
  onClose: () => void; onChanged: () => void;
}) {
  const offers = fieldActions(o);
  const near = tokens.filter((t) => (gm || mine(t)) && gapTo(t, o) <= 1);
  const [tokenId, setTokenId] = useState<string>(near[0]?.id ?? '');
  const [phase, setPhase] = useState<'pick' | 'dice' | 'gesture' | 'sending' | 'done'>('pick');
  const [action, setAction] = useState<FieldAction | null>(null);
  const [start, setStart] = useState<FieldStart | null>(null);
  const [result, setResult] = useState<FieldResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const k = KINDS[o.kind];
  const states = [
    isLockable(o.kind) && (o.props.locked ? '上鎖' : null),
    isTrap(o.kind) && o.props.armed === false && '已解除',
    o.open && (isLockable(o.kind) || o.kind === 'window' ? '開著' : o.kind === 'lever' ? '已拉下' : null),
  ].filter(Boolean) as string[];

  const begin = async (a: FieldAction, dc: number) => {
    setAction(a); setError(null);
    // No roll needed (a ladder, a lever): straight to the result.
    if (dc === 0) {
      setPhase('sending');
      try {
        const s = await api.fieldStart(roomId, { objectId: o.id, tokenId, action: a });
        setStart(s); setResult(s.result); setPhase('done'); onChanged();
      } catch (e) { setError(e as Error); setPhase('pick'); }
      return;
    }
    setPhase('dice');
  };
  const afterDice = () => {
    if (!start) return;
    if (start.result) { setResult(start.result); setPhase('done'); onChanged(); }
    else setPhase('gesture');
  };

  return (
    <div className="token-card field-card" role="dialog" aria-label={`${k.label}的互動`} onKeyDown={(e) => { if (e.key === 'Escape' && phase !== 'gesture') onClose(); }}>
      <div className="row">
        <b>{o.name && o.kind !== 'label' ? o.name : k.label}</b>
        {states.map((s) => <span key={s} className="badge">{s}</span>)}
        <span className="spacer" />
        <button className="link" onClick={onClose}>收起</button>
      </div>
      {phase === 'pick' && (
        <div className="stack tight">
          {offers.length === 0 && <p className="small muted">這個物件現在沒有可以做的事。</p>}
          {offers.length > 0 && near.length === 0 && <p className="small">先把你的代幣走到{k.label}旁邊（相鄰一格內）。</p>}
          {near.length > 1 && (
            <label className="tick">由誰來做
              <select value={tokenId} onChange={(e) => setTokenId(e.target.value)}>{near.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </label>
          )}
          {offers.length > 0 && (
            <div className="row wrap">
              {offers.map(({ action: a, dc }) => (
                <button key={a} className="primary" disabled={!tokenId} onClick={() => void begin(a, dc)}>
                  {FIELD_ACTIONS[a].label}{dc ? <small>　DC {dc}</small> : null}
                </button>
              ))}
            </div>
          )}
          {offers.length > 0 && <p className="small muted">先擲 d20 加技能，再做一個小操作（做得好最多再 +2），達到 DC 就成功。戰鬥中會用掉這回合的動作。</p>}
        </div>
      )}
      {phase === 'dice' && action && (
        <div className="stack tight">
          <p className="small"><b>{FIELD_ACTIONS[action].label}</b>：按住盤子、甩一下放開，擲出 d20。</p>
          <DiceTray mode="throw" dice={[{ sides: 20 }]} label={`${FIELD_ACTIONS[action].label}檢定`} small
            onThrow={async (launch) => {
              try {
                const s = await api.fieldStart(roomId, { objectId: o.id, tokenId, action, launch });
                setStart(s);
                return s.roll?.dice ?? [];
              } catch (e) { setError(e as Error); setPhase('pick'); return null; }
            }}
            onSettled={() => setTimeout(afterDice, 600)} />
          {start?.roll && <p className="small">擲出 <b>{start.roll.total}</b>（{start.roll.text}），DC {start.dc}{start.roll.natural === 20 ? '・大成功！' : start.roll.natural === 1 ? '・大失敗' : ''}</p>}
        </div>
      )}
      {phase === 'gesture' && start?.gesture && (
        <div className="stack tight">
          <p className="small">擲出 <b>{start.roll?.total}</b>，DC {start.dc}：做得好再 +1～+2。</p>
          <GesturePad kind={start.gesture} seed={start.seed} oneKey={oneKey} contrast={contrast}
            onDone={(input) => {
              setPhase('sending');
              void api.fieldFinish(roomId, start.id, input).then((r) => { setResult(r); setPhase('done'); onChanged(); }).catch((e) => { setError(e as Error); setPhase('done'); });
            }} />
        </div>
      )}
      {phase === 'sending' && <p className="small muted">結算中…</p>}
      {phase === 'done' && result && (
        <div className={`field-result ${result.success ? 'ok' : 'bad'}`} role="status">
          <b>{result.success ? '成功' : '失敗'}</b>
          <span>{result.text}</span>
          <div className="row"><button onClick={() => { setPhase('pick'); setStart(null); setResult(null); }}>再做一次</button><button className="link" onClick={onClose}>關閉</button></div>
        </div>
      )}
      <ErrorNote of={error} />
    </div>
  );
}
