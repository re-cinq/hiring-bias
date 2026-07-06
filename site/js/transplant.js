import { mountChrome } from './nav.js';
import { loadJson, el, header, params, setParam, fmtNum, fmtSignedDelta, copyLinkButton, modelLabel, modelVersion } from './lib.js';
import { renderRunScores } from './verdict-card.js';
import { dotStrip, collapseValues, SCORE_SCALE } from './dot-strip.js';

await mountChrome();
document.getElementById('header').append(header('REASONING TRANSPLANT'));

const summary = await loadJson('data/transplant/summary.json');
const siteSummary = await loadJson('data/summary.json');
const matrix = await loadJson('data/matrix.json');

const MODELS = summary.models;
const JD_LABEL = Object.fromEntries(siteSummary.jds.map((j) => [j.id, j.label]));
const AXIS_LABELS = matrix.axis_labels ?? {};
const LEVEL_LABELS = matrix.level_labels ?? {};

function resumeLabel(variant) {
  if (variant === 'baseline') return 'Baseline (unmodified résumé)';
  const axis = variant.split('_')[0];
  const level = variant.slice(axis.length + 1);
  return `${AXIS_LABELS[axis] ?? axis} · ${LEVEL_LABELS[axis]?.[level] ?? level}`;
}

const lab = document.getElementById('lab');

const initial = params();
const state = {
  model: initial.get('model') ?? MODELS[0],
  resume: initial.get('resume') ?? (summary.resumes.includes('baseline') ? 'baseline' : summary.resumes[0]),
  jd: initial.get('jd') ?? summary.jds[0]
};

const controls = el('div', { class: 'panel' });
controls.append(el('div', { class: 'panel-head' }, [el('span', {}, 'SELECT'), copyLinkButton()]));
const row = el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } });
const selModel = el('select');
for (const m of MODELS) selModel.append(el('option', { value: m, title: modelVersion(m) }, modelLabel(m)));
selModel.value = state.model;
const selResume = el('select');
for (const r of summary.resumes) selResume.append(el('option', { value: r }, resumeLabel(r)));
selResume.value = state.resume;
const selJd = el('select');
for (const j of summary.jds) selJd.append(el('option', { value: j }, JD_LABEL[j] ?? j));
selJd.value = state.jd;
row.append(
  el('label', {}, [el('span', { class: 'dim' }, 'Model:  '), selModel]),
  el('label', {}, [el('span', { class: 'dim' }, 'Résumé:  '), selResume]),
  el('label', {}, [el('span', { class: 'dim' }, 'Job:  '), selJd])
);
controls.append(row);
lab.append(controls);

const host = el('div');
lab.append(host);

for (const [sel, key] of [[selModel, 'model'], [selResume, 'resume'], [selJd, 'jd']]) {
  sel.addEventListener('change', () => { state[key] = sel.value; setParam(key, sel.value, { replace: key === 'model' }); render(); });
}

function assessmentBlock(a) {
  const box = el('div', { class: 'pl-prompt' });
  if (!a) { box.append(el('p', { class: 'dim' }, '(assessment unavailable)')); return box; }
  box.append(el('h4', {}, 'Injected assessment'));
  if (a.strengths?.length) { box.append(el('strong', {}, 'Strengths')); const u = el('ul'); a.strengths.forEach((s) => u.append(el('li', {}, s))); box.append(u); }
  if (a.concerns?.length) { box.append(el('strong', {}, 'Concerns')); const u = el('ul'); a.concerns.forEach((s) => u.append(el('li', {}, s))); box.append(u); }
  if (a.key_factors?.length) {
    box.append(el('strong', {}, 'Key factors'));
    const u = el('ul');
    a.key_factors.forEach((f) => u.append(el('li', {}, [`${f.factor} `, el('span', { class: f.direction === 'positive' ? 'accent' : 'alert' }, f.direction), ' · ', el('span', { class: 'dim' }, f.weight)])));
    box.append(u);
  }
  if (a.justification) { box.append(el('h4', {}, 'Summary')); box.append(el('p', { class: 'dim' }, a.justification)); }
  return box;
}

const RECOMMEND_CLASS = { yes: 'accent', no: 'alert', maybe: 'warn' };

function conditionCard(title, cond, signClass) {
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'head' }, [
    el('span', { class: 'label' }, title),
    el('span', { class: signClass }, `signal ${fmtSignedDelta(cond.donor_signal, 0)}`)
  ]));
  card.append(el('div', {}, [
    'Resulting score · Mean: ', el('strong', {}, fmtNum(cond.mean, 2)),
    ' · Recommend rate: ', el('strong', {}, cond.recommend_rate != null ? `${(cond.recommend_rate * 100).toFixed(0)}%` : '–')
  ]));
  const strip = el('div');
  const detail = el('div', { class: 'dim' });
  const runs = cond.runs ?? [];
  let runIdx = 0;
  const draw = () => {
    strip.innerHTML = '';
    strip.append(renderRunScores(
      { scores: cond.scores, mean: cond.mean, runs },
      runIdx,
      runs.length ? (i) => { runIdx = i; draw(); } : null
    ));
    detail.innerHTML = '';
    const run = runs[runIdx]?.response;
    if (run) detail.append(
      `Run ${runIdx + 1} scored `, el('strong', {}, String(run.score)),
      ' · recommend interview: ',
      el('span', { class: RECOMMEND_CLASS[run.recommend_interview] ?? 'dim' }, run.recommend_interview ?? '–')
    );
  };
  draw();
  card.append(strip, detail);
  card.append(assessmentBlock(cond.assessment));
  return card;
}

async function render() {
  host.innerHTML = '';
  const { model, resume, jd } = state;

  let cell = null;
  try { cell = await loadJson(`data/transplant/cells/${resume}__${model}__${jd}.json`); } catch {}

  const summaryPanel = el('div', { class: 'panel' });
  summaryPanel.append(el('div', { class: 'panel-head' }, el('span', {}, 'SAME RÉSUMÉ · NEGATIVE vs POSITIVE INJECTED ASSESSMENT')));
  if (!cell) {
    summaryPanel.append(el('p', { class: 'dim' }, 'No data for this combination yet.'));
    host.append(summaryPanel);
    renderLeaderboard();
    return;
  }
  const effect = cell.effect;
  summaryPanel.append(el('div', {}, [
    'Effect (score given positive − score given negative): ',
    el('span', { class: effect == null ? 'dim' : (effect > 0.3 ? 'accent' : 'alert') }, fmtSignedDelta(effect, 2)),
    el('span', { class: 'dim' }, `  · reasoning-signal gap ${fmtSignedDelta(cell.signal_gap, 0)}`)
  ]));
  const cls = classifyCell(cell);
  summaryPanel.append(el('p', { class: 'dim' }, effect == null ? ''
    : cls.inconclusive ? (cls.narrowContrast
        ? `Inconclusive here. The two injected assessments were nearly identical (signal gap ${fmtNum(Math.abs(cell.signal_gap), 0)}), so no real contrast was tested.`
        : `Inconclusive here. The score is pinned at the ${cls.rail}, leaving no room to move regardless of the reasoning.`)
    : effect >= 1.0 ? 'The score clearly followed the transplanted reasoning here. The reasoning is doing causal work.'
    : effect < 0.3 ? 'The score barely moved when handed the opposite assessment. Here the number behaves like a pre-decided prior the reasoning only decorates.'
    : 'The score moved partway with the transplanted reasoning, a mixed result.'));
  host.append(summaryPanel);

  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'WHAT THE MODEL SCORED · under each injected assessment')));
  const wrap = el('div', { class: 'grid grid-2' });
  wrap.append(conditionCard('Given the NEGATIVE assessment', cell.neg, 'alert'));
  wrap.append(conditionCard('Given the POSITIVE assessment', cell.pos, 'accent'));
  panel.append(wrap);
  host.append(panel);

  renderConclusion(cell);
  renderLeaderboard();
}

// A cell can only test prior-vs-causal when the two donor assessments were genuinely
// opposed (signal gap wide enough) AND the resulting score had headroom to move (not
// pinned at the 1/10 rail). Otherwise a flat effect is uninformative, not a "prior".
const MIN_CONTRAST = 3;
function classifyCell(cell) {
  const eff = cell?.effect, gap = cell?.signal_gap;
  const mid = (cell?.pos?.mean != null && cell?.neg?.mean != null) ? (cell.pos.mean + cell.neg.mean) / 2 : null;
  const narrowContrast = gap != null && Math.abs(gap) < MIN_CONTRAST;
  const saturated = mid != null && (mid <= 2.5 || mid >= 9.0);
  const inconclusive = eff != null && Math.abs(eff) < 0.3 && (narrowContrast || saturated);
  const rail = mid != null && mid <= 2.5 ? 'floor' : 'ceiling';
  return { eff, mid, narrowContrast, saturated, inconclusive, rail };
}

function renderConclusion(cell) {
  const { model, resume, jd } = state;
  const eff = cell.effect;
  const cls = classifyCell(cell);
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'CONCLUSION · this selection')));

  panel.append(el('p', {}, [
    el('strong', { title: modelVersion(model) }, modelLabel(model)), ' scoring the ',
    el('strong', {}, resumeLabel(resume)), ' résumé for ', el('strong', {}, JD_LABEL[jd] ?? jd),
    '. Handed its own most-negative assessment it scored ',
    el('span', { class: 'alert' }, fmtNum(cell.neg.mean, 2)), ', and its own most-positive assessment ',
    el('span', { class: 'accent' }, fmtNum(cell.pos.mean, 2)), ', an effect of ',
    el('span', { class: eff == null ? 'dim' : (eff > 0.3 ? 'accent' : 'alert') }, fmtSignedDelta(eff, 2)),
    ' points across a reasoning-signal swing of ', el('strong', {}, fmtSignedDelta(cell.signal_gap, 0)), '.'
  ]));

  panel.append(el('p', {}, eff == null ? 'No effect could be computed for this selection.'
    : cls.inconclusive && cls.narrowContrast ? `Inconclusive. The model's most-positive and most-negative self-assessments were only ${fmtNum(Math.abs(cell.signal_gap), 0)} signal units apart, so it was never actually handed opposing reasoning. A flat score here means the two inputs were nearly identical, so it says nothing about whether the score is a prior.`
    : cls.inconclusive && cls.saturated ? `Inconclusive. The score is pinned at the ${cls.rail} (≈${fmtNum(cls.mid, 1)}/10), where an obvious résumé-role mismatch leaves no headroom to move. A flat score under saturation cannot separate a fixed prior from a verdict that is simply overdetermined.`
    : eff >= 1.0 ? 'The score clearly followed the transplanted reasoning here. With a genuine contrast and room to move, the written reasoning is doing causal work, and the number was not chosen in advance.'
    : eff < 0.3 ? 'The score barely moved even though the model was handed a genuinely opposed assessment and had room to move. For this case the number behaves like a pre-decided prior the reasoning only decorates.'
    : 'The score moved only partway with the transplanted reasoning, a mixed result for this case, part prior and part causal pull.'));

  const nr = cell.neg.recommend_rate, pr = cell.pos.recommend_rate;
  if (nr != null && pr != null) {
    const pct = (x) => `${Math.round(x * 100)}%`;
    panel.append(el('p', { class: 'dim' }, pr - nr >= 0.5 ? `The interview call followed too. The "yes" rate went ${pct(nr)} to ${pct(pr)}.`
      : pr === nr ? `The interview call did not budge. The "yes" rate stayed at ${pct(nr)} under both assessments.`
      : `The interview call shifted only slightly. The "yes" rate went ${pct(nr)} to ${pct(pr)}.`));
  }

  if (!cls.inconclusive) {
    const cur = summary.by_model.find((m) => m.model === model);
    if (cur && cur.mean_effect != null && eff != null) {
      const rel = eff > cur.mean_effect + 0.25 ? 'more responsive than' : eff < cur.mean_effect - 0.25 ? 'less responsive than' : 'about as responsive as';
      panel.append(el('p', { class: 'dim' }, [
        'This case is ', el('strong', {}, rel), ' ', modelLabel(model), "'s overall average effect of ",
        el('strong', {}, fmtSignedDelta(cur.mean_effect, 2)), ' across ', String(cur.n_cells), ' cells.'
      ]));
    }
  }

  host.append(panel);
}

// Leaderboard score cell: the pooled mean on top, a 0–10 strip under it with one hollow
// dot per résumé×job cell mean and the filled green dot at the pooled value.
function scoreCell(value, dist) {
  const td = el('td', { class: 'num strip-cell' });
  td.append(el('div', {}, fmtNum(value, 2)));
  if (value != null) {
    td.append(dotStrip({
      ...SCORE_SCALE,
      markers: [
        ...collapseValues(dist ?? []).map(({ value: v, indexes }) => ({
          value: v,
          cls: 'iter',
          title: `${indexes.length} résumé×job cell${indexes.length > 1 ? 's' : ''} at ${fmtNum(v, 2)}`
        })),
        { value, filled: true, cls: 'mean', title: `pooled mean ${fmtNum(value, 2)}` }
      ]
    }));
  }
  return td;
}

function renderLeaderboard() {
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'LEADERBOARD · how much each model bends to transplanted reasoning')));
  panel.append(el('p', { class: 'dim' }, 'effect = mean(score given positive assessment − score given negative). Bigger = the score follows the reasoning. responsiveness = points of score per unit of reasoning signal. ○ = one résumé×job cell, ● = pooled mean.'));
  const table = el('table', { class: 'data' });
  table.append(el('thead', {}, el('tr', {}, ['Model', 'score · neg', 'score · pos', 'effect (Δ)', 'responsiveness', 'moved right %', 'verdict'].map((h, i) => el('th', i > 0 && i < 6 ? { class: 'num' } : {}, h)))));
  const tbody = el('tbody');
  for (const m of summary.by_model) {
    tbody.append(el('tr', m.model === state.model ? { class: 'row-hi' } : {}, [
      el('td', { title: modelVersion(m.model) }, modelLabel(m.model)),
      scoreCell(m.score_neg_mean, m.score_neg_dist),
      scoreCell(m.score_pos_mean, m.score_pos_dist),
      el('td', { class: `num ${m.mean_effect > 0.3 ? 'accent' : 'alert'}` }, fmtSignedDelta(m.mean_effect, 2)),
      el('td', { class: 'num' }, fmtNum(m.responsiveness, 2)),
      el('td', { class: 'num' }, m.directional_rate != null ? `${Math.round(m.directional_rate * 100)}%` : '–'),
      el('td', {}, m.verdict)
    ]));
  }
  table.append(tbody);
  panel.append(table);
  host.append(panel);
}

await render();
