// Browser prototype: character creation + action checks, driven by the same engine as the tests.
import {
  ATTRIBUTES, CLASSES, SKILLS, attributeCreationMax, attributeTotal, createCharacter, exampleBuild, skillTierName,
  skillTotal, validateDraft,
  type Character, type CharacterDraft,
} from '../src/character/create';
import { normalize, performCheck } from '../src/rules/check';
import { DEFAULT_RULES as C } from '../src/rules/config';
import { randomRng } from '../src/rules/dice';
import { distribution } from '../src/sim/enumerate';
import type { AttributeCode, RollMode } from '../src/rules/types';
import { initCombat } from './combat-ui';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let draft: CharacterDraft = { ...exampleBuild('scout', C), name: '灰鴉' };
let hero: Character | null = null;
let rollCount = 0;

/** Roll visibility, as in VTT whisper/blind rolls: what the player sees vs what the GM sees. */
type RollVis = 'public' | 'whisper' | 'blind';
interface RollEntry { id: string; label: string; body: string; vis: RollVis; hiddenTn: string }
const rolls: RollEntry[] = [];
let logAs: 'player' | 'gm' = 'player';
const VIS_TAG: Record<RollVis, string> = { public: '公開', whisper: '密骰：只有你與 GM', blind: 'GM 暗骰' };

function renderLog() {
  $('log').innerHTML = rolls.map((r) => {
    const head = `<div class="r-head"><span>${esc(logAs === 'player' && r.vis === 'blind' ? r.hiddenTn : r.label)}</span><span class="r-vis v-${r.vis}">${VIS_TAG[r.vis]}</span><code>${r.id}</code></div>`;
    if (logAs === 'player' && r.vis === 'blind') return `<li class="result">${head}<div class="r-detail">GM 替你擲了一次骰。骰值、難度與結果都保密，GM 會用敘事告訴你發生了什麼。</div></li>`;
    return `<li class="result">${head}${r.body}</li>`;
  }).join('');
  $('log-empty').hidden = rolls.length > 0;
}

/** One-click rolls for the character's strongest pairings, like a VTT macro bar. */
function renderMacros() {
  const src = source();
  const cls = CLASSES.find((c) => c.id === (hero ?? draft).classId)!;
  const pairs: [AttributeCode, string][] = [];
  for (const a of cls.coreAttributes) for (const s of cls.coreSkills) pairs.push([a, s]);
  pairs.push(['PER', 'scouting'], ['INS', 'insight']);
  const seen = new Set<string>();
  $('macros').innerHTML = pairs.filter(([a, s]) => !seen.has(a + s) && seen.add(a + s)).map(([a, s]) => {
    const an = ATTRIBUTES.find((x) => x.code === a)!.name;
    const sn = SKILLS.find((x) => x.id === s)!.name;
    return `<button type="button" data-attr="${a}" data-skill="${s}"><b>${esc(an)}＋${esc(sn)}</b><small>D20 ＋ ${src.attributes[a] + (src.skills[s] ?? 0)}</small></button>`;
  }).join('');
}

// ---------- character creation ----------

function renderClassInfo() {
  const cls = CLASSES.find((c) => c.id === draft.classId)!;
  const attr = cls.coreAttributes.map((a) => ATTRIBUTES.find((x) => x.code === a)!.name).join('、');
  const skills = cls.coreSkills.map((s) => SKILLS.find((x) => x.id === s)!.name).join('、');
  $('class-info').innerHTML =
    `<span><b>${esc(cls.role)}</b></span><span>核心屬性 ${esc(attr)}</span><span>核心技能 ${esc(skills)}</span><span>特性「${esc(cls.feature)}」</span>`;
}

function stepper(kind: 'attr' | 'skill', key: string, label: string, value: number, max: number, core: boolean) {
  return `<div class="stepper${core ? ' core' : ''}${value > 0 ? ' set' : ''}">
    <span class="st-label">${esc(label)}${core ? '<i title="職業核心">核心</i>' : ''}</span>
    <span class="st-ctrl">
      <button type="button" data-kind="${kind}" data-key="${key}" data-d="-1" aria-label="${esc(label)} 減一" ${value <= 0 ? 'disabled' : ''}>−</button>
      <output>${value}</output>
      <button type="button" data-kind="${kind}" data-key="${key}" data-d="1" aria-label="${esc(label)} 加一" ${value >= max ? 'disabled' : ''}>＋</button>
    </span></div>`;
}

function renderSheet() {
  const cls = CLASSES.find((c) => c.id === draft.classId)!;
  $('attrs').innerHTML = ATTRIBUTES.map((a) =>
    stepper('attr', a.code, `${a.name} ${a.code}`, draft.attributes[a.code], attributeCreationMax(C), cls.coreAttributes.includes(a.code)),
  ).join('');

  const cats = [...new Set(SKILLS.map((s) => s.category))];
  $('skills').innerHTML = cats.map((cat) => `<fieldset><legend>${esc(cat)}</legend>${SKILLS.filter((s) => s.category === cat)
    .map((s) => stepper('skill', s.id, s.name, draft.skills[s.id] ?? 0, C.skill.creationMax, cls.coreSkills.includes(s.id)))
    .join('')}</fieldset>`).join('');

  const attrTarget = C.attribute.creationPoints;
  const attrLeft = attrTarget - attributeTotal(draft);
  const skillLeft = C.skill.creationPoints - skillTotal(draft);
  const core = cls.coreSkills.reduce((s, id) => s + (draft.skills[id] ?? 0), 0);
  $('attr-left').textContent = `剩餘 ${attrLeft}`;
  $('attr-left').dataset.state = attrLeft === 0 ? 'ok' : attrLeft < 0 ? 'bad' : 'todo';
  $('skill-left').textContent = `剩餘 ${skillLeft}｜核心 ${core}/${C.skill.creationCoreMin}`;
  $('skill-left').dataset.state = skillLeft === 0 && core >= C.skill.creationCoreMin ? 'ok' : skillLeft < 0 ? 'bad' : 'todo';

  const errors = validateDraft(draft, C);
  $('errors').innerHTML = errors.map((e) => `<li>${esc(e.message)}</li>`).join('');
  $<HTMLButtonElement>('create').disabled = errors.length > 0;
  $('create-hint').textContent = errors.length ? `還有 ${errors.length} 項需要修正` : '配置合法，可以建立角色';
  renderClassInfo();
}

function onStep(e: Event) {
  const btn = (e.target as HTMLElement).closest('button[data-kind]') as HTMLButtonElement | null;
  if (!btn) return;
  const d = Number(btn.dataset.d);
  const key = btn.dataset.key!;
  if (btn.dataset.kind === 'attr') {
    const code = key as AttributeCode;
    draft.attributes[code] = Math.max(0, Math.min(attributeCreationMax(C), draft.attributes[code] + d));
  } else {
    const v = Math.max(0, Math.min(C.skill.creationMax, (draft.skills[key] ?? 0) + d));
    if (v) draft.skills[key] = v; else delete draft.skills[key];
  }
  renderSheet();
}

function renderHero() {
  const card = $('hero');
  if (!hero) { card.hidden = true; return; }
  card.hidden = false;
  const cls = CLASSES.find((c) => c.id === hero!.classId)!;
  $('hero-name').textContent = hero.name;
  $('hero-meta').textContent = `${cls.name}｜HP ${hero.hp}/${hero.maxHp}｜規則 v${hero.rulesVersion}`;
  $('hero-id').textContent = hero.id;
}

// ---------- action check ----------

function source(): { attributes: Record<AttributeCode, number>; skills: Record<string, number> } {
  return hero ?? draft;
}

function fillCheckSelects() {
  const src = source();
  const aSel = $<HTMLSelectElement>('chk-attr');
  const sSel = $<HTMLSelectElement>('chk-skill');
  const a = aSel.value || 'AGI';
  const s = sSel.value || 'stealth';
  aSel.innerHTML = ATTRIBUTES.map((x) => `<option value="${x.code}">${esc(x.name)} ${src.attributes[x.code]}</option>`).join('');
  sSel.innerHTML = SKILLS.map((x) => {
    const lv = src.skills[x.id] ?? 0;
    return `<option value="${x.id}">${esc(x.name)} ${lv}（${skillTierName(lv, C)}）</option>`;
  }).join('');
  aSel.value = a; sSel.value = s;
  $('check-source').textContent = hero ? `使用角色「${hero.name}」` : '使用目前的配置（尚未建立角色）';
  renderMacros();
}

function currentInput() {
  const src = source();
  const attr = $<HTMLSelectElement>('chk-attr').value as AttributeCode;
  const skill = $<HTMLSelectElement>('chk-skill').value;
  return {
    attribute: src.attributes[attr],
    skill: src.skills[skill] ?? 0,
    situational: Number($<HTMLInputElement>('chk-sit').value),
    equipment: Number($<HTMLInputElement>('chk-gear').value),
    tn: Number($<HTMLSelectElement>('chk-tn').value),
    mode: ($<HTMLInputElement>('chk-form').querySelector('input[name="mode"]:checked') as HTMLInputElement).value as RollMode,
    highRisk: $<HTMLInputElement>('chk-risk').checked,
  };
}

function renderOdds() {
  const input = currentInput();
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  const n = normalize(input, C);
  $('sit-val').textContent = signed(input.situational);
  $('gear-val').textContent = signed(input.equipment);
  $('mod-total').textContent = n.modifierCapped
    ? `合計 ${signed(input.situational + input.equipment)}，超過上限，只套用 ${signed(n.modifier)}`
    : `合計 ${signed(n.modifier)}`;
  $('mod-total').dataset.state = n.modifierCapped ? 'bad' : 'ok';
  const d = distribution(input, C);
  const bonus = input.attribute + input.skill + n.modifier;
  $('odds-formula').textContent = `D20 ＋ ${input.attribute}（屬性）＋ ${input.skill}（技能）${n.modifier ? ` ${n.modifier > 0 ? '＋' : '−'} ${Math.abs(n.modifier)}（修正）` : ''} ＝ D20 ＋ ${bonus}，目標 ${input.tn}`;
  const head = $('odds-head');
  if (d.preCheck === 'auto') {
    head.innerHTML = '<span class="pill ok">免擲骰</span> 最低總值已達目標，自動普通成功';
  } else if (d.preCheck === 'impossible') {
    head.innerHTML = '<span class="pill bad">做不到</span> 最高總值也到不了目標，需要工具、情報、合作或更多時間';
  } else {
    head.innerHTML = `<span class="pill">成功率 ${(d.pSuccess * 100).toFixed(1)}%</span> 精確枚舉所有骰值`;
  }
  $('odds-bar').innerHTML = C.tiers.map((t) => {
    const p = d.tiers[t.key];
    return p > 0 ? `<span class="seg t-${t.key}" style="flex:${p}" title="${esc(t.name)} ${(p * 100).toFixed(1)}%"></span>` : '';
  }).join('');
  $('odds-legend').innerHTML = C.tiers.map((t) =>
    `<li class="t-${t.key}"><i></i>${esc(t.name)}<b>${(d.tiers[t.key] * 100).toFixed(1)}%</b></li>`).join('');
}

function roll(e: Event) {
  e.preventDefault();
  const input = currentInput();
  const out = performCheck(input, randomRng, C);
  const attrName = ATTRIBUTES.find((a) => a.code === $<HTMLSelectElement>('chk-attr').value)!.name;
  const skillName = SKILLS.find((s) => s.id === $<HTMLSelectElement>('chk-skill').value)!.name;
  const diff = C.difficulties.find((x) => x.tn === input.tn)!;
  const label = `${attrName}＋${skillName}｜${diff.name} ${diff.tn}${input.mode === 'advantage' ? '｜優勢' : input.mode === 'disadvantage' ? '｜劣勢' : ''}${input.highRisk ? '｜高風險' : ''}`;
  rollCount++;
  const id = `CHK-${String(rollCount).padStart(4, '0')}`;
  let body: string;
  if (out.kind === 'skill-required') {
    body = `<div class="r-tier t-failure">未擲骰</div><div class="r-detail">這個行動要求受過訓練的技能等級。</div>`;
  } else if (out.kind === 'impossible') {
    body = `<div class="r-tier t-failure">未擲骰</div><div class="r-detail">以目前條件做不到。GM 應說明可以改變哪些條件。</div>`;
  } else if (out.kind === 'auto') {
    body = `<div class="r-tier t-success">普通成功</div><div class="r-detail">免擲骰：最低可能總值 ${1 + input.attribute + input.skill + out.result.input.modifier} ≥ ${input.tn}</div>`;
  } else {
    const r = out.result;
    const dice = r.rolls.d20.map((v) => `<span class="die${v === r.d20 ? ' used' : ''}${v === 20 ? ' n20' : v === 1 ? ' n1' : ''}">${v}</span>`).join('');
    const nat = r.natural && r.tier !== r.rawTier ? `（自然 ${r.natural}：${C.tiers.find((t) => t.key === r.rawTier)!.name} → ${r.tierName}）` : '';
    body = `<div class="r-dice">${dice}</div>
      <div class="r-tier t-${r.tier}">${esc(r.tierName)}</div>
      <div class="r-detail">總值 ${r.total} − 目標 ${r.input.tn} ＝ 差距 ${r.margin > 0 ? '+' : ''}${r.margin}${esc(nat)}</div>`;
  }
  const vis = ($<HTMLInputElement>('chk-form').querySelector('input[name="vis"]:checked') as HTMLInputElement).value as RollVis;
  rolls.unshift({ id, label, body, vis, hiddenTn: `${attrName}＋${skillName}｜難度保密` });
  renderLog();
}

// ---------- boot ----------

function boot() {
  const clsSel = $<HTMLSelectElement>('cls');
  clsSel.innerHTML = CLASSES.map((c) => `<option value="${c.id}">${esc(c.name)}｜${esc(c.role)}</option>`).join('');
  clsSel.value = draft.classId;
  $<HTMLInputElement>('name').value = draft.name;
  $<HTMLSelectElement>('chk-tn').innerHTML = C.difficulties.map((d) => `<option value="${d.tn}">${esc(d.name)} ${d.tn}</option>`).join('');
  $<HTMLSelectElement>('chk-tn').value = '14';

  $('name').addEventListener('input', (e) => { draft.name = (e.target as HTMLInputElement).value; renderSheet(); });
  clsSel.addEventListener('change', () => { draft.classId = clsSel.value; renderSheet(); renderMacros(); });
  $('attrs').addEventListener('click', (e) => { onStep(e); fillCheckSelects(); renderOdds(); });
  $('skills').addEventListener('click', (e) => { onStep(e); fillCheckSelects(); renderOdds(); });
  $('example').addEventListener('click', () => {
    draft = { ...exampleBuild(clsSel.value, C), name: draft.name };
    renderSheet(); fillCheckSelects(); renderOdds();
  });
  $('create').addEventListener('click', () => {
    hero = createCharacter(structuredClone(draft), C);
    renderHero(); fillCheckSelects(); renderOdds();
  });
  $('chk-form').addEventListener('input', renderOdds);
  $('chk-form').addEventListener('change', renderOdds);
  $('chk-form').addEventListener('submit', roll);
  $('macros').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-attr]');
    if (!b) return;
    $<HTMLSelectElement>('chk-attr').value = b.dataset.attr!;
    $<HTMLSelectElement>('chk-skill').value = b.dataset.skill!;
    renderOdds();
    $<HTMLFormElement>('chk-form').requestSubmit();
  });
  $('log-as').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-as]');
    if (!b) return;
    logAs = b.dataset.as as 'player' | 'gm';
    for (const x of $('log-as').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    renderLog();
  });

  renderSheet(); renderHero(); fillCheckSelects(); renderOdds();
  initCombat(() => ({ draft: hero ?? draft, created: !!hero }));
}

boot();
