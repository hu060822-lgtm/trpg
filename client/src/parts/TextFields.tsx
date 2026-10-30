import { useState } from 'react';
import type { PackText } from '../../../src/pack/pack';
import type { Pack } from '../api';
import { useAction } from '../hooks';
import { ErrorNote } from './ui';

/** The pack's text fields in their groups, in the order the pack lists them. */
export function groupsOf(pack: Pack): [string, PackText[]][] {
  const groups = new Map<string, PackText[]>();
  for (const t of pack.texts ?? []) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  return [...groups];
}

/** One field: a line for short answers, a box that grows for stories. Counts characters once it nears the limit. */
function TextField({ field: t, value, onChange }: { field: PackText; value: string; onChange: (v: string) => void }) {
  const near = value.length > t.max * 0.8;
  const over = value.length > t.max;
  const id = `text-${t.id}`;
  return (
    <div className="text-field">
      <label htmlFor={id}>{t.label}{near && <small className={over ? 'over' : 'muted'}>{value.length}／{t.max}</small>}</label>
      {t.description && <small className="muted" id={`${id}-hint`}>{t.description}</small>}
      {t.multiline ? (
        <textarea id={id} rows={value.length > 160 ? 6 : 3} value={value} placeholder={t.placeholder} aria-invalid={over || undefined}
          aria-describedby={t.description ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} value={value} placeholder={t.placeholder} aria-invalid={over || undefined}
          aria-describedby={t.description ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)} />
      )}
      {over && <p className="field-error">{t.label}最多 {t.max} 字，請刪掉 {value.length - t.max} 字。</p>}
    </div>
  );
}

/** Every text field, grouped under the pack's headings. */
export function TextFields({ pack, texts, onChange, only }: {
  pack: Pack;
  texts: Record<string, string>;
  onChange: (id: string, v: string) => void;
  /** Show just this group. */
  only?: string;
}) {
  return (
    <>
      {groupsOf(pack).filter(([g]) => !only || g === only).map(([group, fields]) => (
        <fieldset key={group} className="text-group">
          <legend>{group}</legend>
          {fields.map((t) => <TextField key={t.id} field={t} value={texts[t.id] ?? ''} onChange={(v) => onChange(t.id, v)} />)}
        </fieldset>
      ))}
    </>
  );
}

/**
 * The written part of a sheet: what is filled in shows as text, and each group can be edited in place and saved on
 * its own, so jotting a note mid-session does not mean opening the whole character form.
 */
export function StorySection({ pack, texts, canEdit, onSave }: {
  pack: Pack;
  texts: Record<string, string>;
  canEdit: boolean;
  onSave: (texts: Record<string, string>) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useAction();
  const groups = groupsOf(pack);
  if (!groups.length) return null;
  return (
    <>
      {groups.map(([group, fields]) => {
        const filled = fields.filter((t) => texts[t.id]?.trim());
        const open = editing === group;
        return (
          <section key={group} className="block story">
            <div className="story-head">
              <h3>{group}</h3>
              {canEdit && !open && (
                <button className="link" onClick={() => { setDraft({ ...texts }); setEditing(group); }}>{filled.length ? `編輯${group}` : `填寫${group}`}</button>
              )}
            </div>
            {open ? (
              <form className="stack" onSubmit={(e) => {
                e.preventDefault();
                if (fields.some((t) => (draft[t.id] ?? '').length > t.max)) return;
                void save.run(async () => { await onSave(draft); setEditing(null); });
              }} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}>
                <TextFields pack={pack} texts={draft} only={group} onChange={(id, v) => setDraft((d) => ({ ...d, [id]: v }))} />
                <ErrorNote of={save} />
                <div className="row">
                  <button className="primary" disabled={save.busy}>{save.busy ? '儲存中…' : `儲存${group}`}</button>
                  <button type="button" onClick={() => setEditing(null)}>取消</button>
                </div>
              </form>
            ) : filled.length ? (
              <dl className="story-list">
                {filled.map((t) => <div key={t.id}><dt>{t.label}</dt><dd>{texts[t.id]}</dd></div>)}
              </dl>
            ) : (
              <p className="muted small">還沒寫。{canEdit ? `按「填寫${group}」補上，GM 和你看得到，其他玩家看不到。` : ''}</p>
            )}
          </section>
        );
      })}
    </>
  );
}
