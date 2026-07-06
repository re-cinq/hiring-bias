import { mountChrome } from './nav.js';
import { loadJson, el, header, params, setParam, fmtNum, fmtSignedDelta, copyLinkButton, modelLabel, modelVersion } from './lib.js';
import { verdictCard } from './verdict-card.js';
import { dotStrip, collapseValues } from './dot-strip.js';

await mountChrome();
document.getElementById('header').append(header('PROMPT LAB'));

const summary = await loadJson('data/prompt-lab/summary.json');
const strategiesDoc = await loadJson('data/prompt-lab/strategies.json');
// Reuse the existing label infrastructure for résumé variants and job descriptions.
const matrix = await loadJson('data/matrix.json');
const siteSummary = await loadJson('data/summary.json');

const MODELS = summary.models;
const STRAT_LABEL = Object.fromEntries(strategiesDoc.map((s) => [s.id, s.label]));
const STRAT_TEMPLATE = Object.fromEntries(strategiesDoc.map((s) => [s.id, s.template]));
const STRATS = summary.strategies;
const JD_LABEL = Object.fromEntries(siteSummary.jds.map((j) => [j.id, j.label]));

const AXIS_LABELS = matrix.axis_labels ?? {};
const LEVEL_LABELS = matrix.level_labels ?? {};

function resumeLabel(variant) {
  if (variant === 'baseline') return 'Baseline (unmodified résumé)';
  const axis = variant.split('_')[0];
  const level = variant.slice(axis.length + 1);
  return `${AXIS_LABELS[axis] ?? axis} · ${LEVEL_LABELS[axis]?.[level] ?? level}`;
}

// Largest value of an open-ended metric anywhere in the summary (values and their
// distributions), rounded up to 0.5, so its strip domain covers all data.
function dataMax(key) {
  let max = 0;
  for (const s of summary.by_strategy) {
    for (const bucket of [s.pooled, ...Object.values(s.by_model ?? {})]) {
      if (typeof bucket?.[key] === 'number' && bucket[key] > max) max = bucket[key];
      for (const v of bucket?.dist?.[key] ?? []) if (v > max) max = v;
    }
  }
  return Math.max(0.5, Math.ceil(max * 2) / 2);
}

// Metric definitions. lowerBetter drives the green/red coloring of deltas; domain is the
// metric's own scale for the distribution strips (rates 0–1, correlation −1..1, the
// open-ended ones sized to the data).
const METRICS = [
  { key: 'stability', label: 'Stability (score stdev)', lowerBetter: true, domain: [0, dataMax('stability')] },
  { key: 'coherence', label: 'Coherence (score vs reasoning, r)', lowerBetter: false, domain: [-1, 1] },
  { key: 'bias_abs_delta', label: 'Bias (|Δ score| vs baseline résumé)', lowerBetter: true, domain: [0, dataMax('bias_abs_delta')] },
  { key: 'flip_instability', label: 'Decision flips (run-to-run)', lowerBetter: true, domain: [0, 1] },
  { key: 'flip_bias', label: 'Decision flips (identity swap)', lowerBetter: true, domain: [0, 1] }
];

const byStrategy = Object.fromEntries(summary.by_strategy.map((s) => [s.strategy, s]));

function metricVal(strategyId, model, key) {
  const s = byStrategy[strategyId];
  if (!s) return null;
  const bucket = model === '__pooled__' ? s.pooled : s.by_model?.[model];
  return bucket?.[key] ?? null;
}

// Per-cell (résumé × job) values behind an aggregate metric, as hollow-dot markers.
// Identical values collapse into one dot whose tooltip carries the count.
function metricDistPoints(strategyId, model, key) {
  const s = byStrategy[strategyId];
  const bucket = model === '__pooled__' ? s?.pooled : s?.by_model?.[model];
  return collapseValues(bucket?.dist?.[key] ?? []).map(({ value, indexes }) => ({
    value,
    title: `${indexes.length} résumé×job cell${indexes.length > 1 ? 's' : ''} at ${fmtNum(value, 2)}`
  }));
}

// One metric cell: the number on top, the distribution strip under it. points are the
// hollow dots ({ value, title }); the filled green dot is the cell's own value.
function metricCell(m, value, points, { text = null, cls = '' } = {}) {
  const td = el('td', { class: `num strip-cell ${cls}`.trim() });
  td.append(el('div', {}, text ?? fmtNum(value, 2)));
  if (value != null) {
    const [min, max] = m.domain;
    td.append(dotStrip({
      min, max,
      ticks: min < 0 ? [{ at: 0, center: true, label: '0' }] : [],
      scaleLabels: [String(min), String(max)],
      markers: [
        ...points.map((p) => ({ value: p.value, cls: 'iter', title: p.title })),
        { value, filled: true, cls: 'mean', title: `${m.label}: ${fmtNum(value, 2)}` }
      ]
    }));
  }
  return td;
}

// Green when the change is an improvement for this metric's direction, red when worse.
function goodBadClass(delta, lowerBetter) {
  if (delta == null || Math.abs(delta) < 0.005) return 'dim';
  const improved = lowerBetter ? delta < 0 : delta > 0;
  return improved ? 'accent' : 'alert';
}

const initial = params();
const state = {
  a: initial.get('a') ?? 'baseline',
  b: initial.get('b') ?? (STRATS.find((s) => s !== 'baseline') ?? 'baseline'),
  model: initial.get('model') ?? MODELS[0],
  resume: initial.get('resume') ?? (summary.resumes.includes('baseline') ? 'baseline' : summary.resumes[0]),
  jd: initial.get('jd') ?? summary.jds[0]
};

const lab = document.getElementById('lab');

// ---- Controls -------------------------------------------------------------
const controls = el('div', { class: 'panel' });
controls.append(el('div', { class: 'panel-head' }, [el('span', {}, 'COMPARE'), copyLinkButton()]));
const row = el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } });

function strategySelect(value) {
  const sel = el('select');
  for (const id of STRATS) sel.append(el('option', { value: id }, STRAT_LABEL[id] ?? id));
  sel.value = value;
  return sel;
}
const selA = strategySelect(state.a);
const selB = strategySelect(state.b);
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
  el('label', {}, [el('span', { class: 'dim' }, 'Strategy A:  '), selA]),
  el('label', {}, [el('span', { class: 'dim' }, 'Strategy B:  '), selB]),
  el('label', {}, [el('span', { class: 'dim' }, 'Model:  '), selModel]),
  el('label', {}, [el('span', { class: 'dim' }, 'Résumé:  '), selResume]),
  el('label', {}, [el('span', { class: 'dim' }, 'Job:  '), selJd])
);
controls.append(row);
lab.append(controls);

const comparatorHost = el('div');
const reactionHost = el('div');
lab.append(comparatorHost, reactionHost);

for (const [sel, key, replace] of [[selA, 'a', true], [selB, 'b', false], [selModel, 'model', false], [selResume, 'resume', false], [selJd, 'jd', false]]) {
  sel.addEventListener('change', () => {
    state[key] = sel.value;
    setParam(key, sel.value, { replace });
    render();
  });
}

// ---- Render ---------------------------------------------------------------
const cellCache = new Map();
async function loadCell(resume, model, jd) {
  const key = `${resume}__${model}__${jd}`;
  if (cellCache.has(key)) return cellCache.get(key);
  let cell = null;
  try { cell = await loadJson(`data/prompt-lab/cells/${key}.json`); } catch {}
  cellCache.set(key, cell);
  return cell;
}

async function render() {
  await renderComparator();
  renderReaction();
}

async function renderComparator() {
  comparatorHost.innerHTML = '';
  const { a, b, model, resume, jd } = state;

  const pairTable = el('div', { class: 'panel' });
  pairTable.append(el('div', { class: 'panel-head' }, el('span', {}, `METRICS · ${STRAT_LABEL[a]} vs ${STRAT_LABEL[b]} · ${modelLabel(model)}`)));
  pairTable.append(metricPairTable(a, b, model));
  comparatorHost.append(pairTable);

  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'WHAT THE MODEL SAID · A vs B')));

  const cell = await loadCell(resume, model, jd);
  const aData = cell?.strategies?.[a];
  const bData = cell?.strategies?.[b];
  if (!aData || !bData) {
    panel.append(el('p', { class: 'dim' }, 'No data for this combination yet. Pick a different résumé, model or job.'));
    comparatorHost.append(panel);
    return;
  }

  const dScore = (bData.mean != null && aData.mean != null) ? bData.mean - aData.mean : null;
  panel.append(el('div', {}, [
    'Δ mean score (B − A): ',
    el('span', { class: goodBadClass(dScore, false) === 'dim' ? 'dim' : (dScore > 0 ? 'accent' : 'alert') }, fmtSignedDelta(dScore, 2)),
    el('span', { class: 'dim' }, '  (just this résumé × job, the table above pools across all of them)')
  ]));

  const cardsHost = el('div');
  panel.append(cardsHost);
  let aIdx = 0, bIdx = 0;
  function rebuild() {
    cardsHost.innerHTML = '';
    const aRun = aData.runs?.[aIdx]?.response ?? aData.sample;
    const wrap = el('div', { class: 'grid grid-2' });
    wrap.append(verdictCard(`A · ${STRAT_LABEL[a]}`, aData, aIdx, null, (i) => { if (i !== aIdx) { aIdx = i; rebuild(); } }, promptBlock(a)));
    wrap.append(verdictCard(`B · ${STRAT_LABEL[b]}`, bData, bIdx, aRun, (i) => { if (i !== bIdx) { bIdx = i; rebuild(); } }, promptBlock(b)));
    cardsHost.append(wrap);
  }
  rebuild();
  comparatorHost.append(panel);
}

// The exact prompt this strategy sends, shown plain under the scores inside the card.
function promptBlock(strategyId) {
  const box = el('div', { class: 'pl-prompt' });
  box.append(el('h4', {}, 'Prompt'));
  box.append(el('pre', {}, STRAT_TEMPLATE[strategyId] ?? '(prompt unavailable)'));
  return box;
}

function metricPairTable(a, b, model) {
  const table = el('table', { class: 'data' });
  table.append(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Metric'), el('th', { class: 'num' }, STRAT_LABEL[a]), el('th', { class: 'num' }, STRAT_LABEL[b]), el('th', { class: 'num' }, 'Δ (B − A)')
  ])));
  const tbody = el('tbody');
  for (const m of METRICS) {
    const va = metricVal(a, model, m.key);
    const vb = metricVal(b, model, m.key);
    const d = (va != null && vb != null) ? vb - va : null;
    tbody.append(el('tr', {}, [
      el('td', {}, m.label),
      metricCell(m, va, metricDistPoints(a, model, m.key)),
      metricCell(m, vb, metricDistPoints(b, model, m.key)),
      el('td', { class: `num ${goodBadClass(d, m.lowerBetter)}` }, d == null ? '–' : fmtSignedDelta(d, 2))
    ]));
  }
  table.append(tbody);
  return table;
}

// "How do the models react" — for the selected A→B switch, one row per model showing
// the change in each metric, so you can see which models the prompt change helps.
function renderReaction() {
  reactionHost.innerHTML = '';
  const { a, b } = state;
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, `HOW EACH MODEL REACTS · switching ${STRAT_LABEL[a]} → ${STRAT_LABEL[b]}`)));
  panel.append(el('p', { class: 'dim' }, 'Δ for each metric (B − A), per model. Green marks a switch that improved that metric for that model, red marks one that made it worse.'));

  const table = el('table', { class: 'data' });
  table.append(el('thead', {}, el('tr', {}, [el('th', {}, 'Model'), ...METRICS.map((m) => el('th', { class: 'num' }, m.label))])));
  const tbody = el('tbody');
  for (const model of MODELS) {
    const cells = METRICS.map((m) => {
      const va = metricVal(a, model, m.key);
      const vb = metricVal(b, model, m.key);
      const d = (va != null && vb != null) ? vb - va : null;
      return el('td', { class: `num ${goodBadClass(d, m.lowerBetter)}` }, d == null ? '–' : fmtSignedDelta(d, 2));
    });
    tbody.append(el('tr', {}, [el('td', { title: modelVersion(model) }, modelLabel(model)), ...cells]));
  }
  table.append(tbody);
  panel.append(table);
  reactionHost.append(panel);

  reactionHost.append(leaderboardPanel());
  reactionHost.append(strategyReferencePanel());
}

// Pooled leaderboard: every strategy on every metric, baseline highlighted, Δ-vs-baseline colored.
function leaderboardPanel() {
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'LEADERBOARD · all strategies, pooled across models')));
  const table = el('table', { class: 'data' });
  table.append(el('thead', {}, el('tr', {}, [el('th', {}, 'Strategy'), ...METRICS.map((m) => el('th', { class: 'num' }, m.label))])));
  const tbody = el('tbody');
  for (const sid of STRATS) {
    const isBase = sid === 'baseline';
    const cells = METRICS.map((m) => {
      const v = metricVal(sid, '__pooled__', m.key);
      const base = metricVal('baseline', '__pooled__', m.key);
      const d = (!isBase && v != null && base != null) ? v - base : null;
      const txt = fmtNum(v, 2) + (d != null ? ` (${fmtSignedDelta(d, 2)})` : '');
      // Hollow dots: the per-model values behind this pooled number.
      const points = MODELS
        .map((mm) => ({ mm, value: metricVal(sid, mm, m.key) }))
        .filter((p) => p.value != null)
        .map((p) => ({ value: p.value, title: `${modelLabel(p.mm)}: ${fmtNum(p.value, 2)}` }));
      return metricCell(m, v, points, { text: txt, cls: d != null ? goodBadClass(d, m.lowerBetter) : '' });
    });
    tbody.append(el('tr', { class: isBase ? 'row-hi' : '' }, [el('td', {}, isBase ? `${STRAT_LABEL[sid]} ★` : STRAT_LABEL[sid]), ...cells]));
  }
  table.append(tbody);
  panel.append(table);
  return panel;
}

function strategyReferencePanel() {
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'THE STRATEGIES · prompts and sample output')));
  for (const s of strategiesDoc) {
    const details = el('details', { class: 'jd-collapse' });
    details.append(el('summary', {}, [el('span', { class: 'jd-caret' }, '▸'), el('span', { class: 'panel-head-text' }, ` ${s.label}`)]));
    details.append(el('p', { class: 'dim' }, s.description));
    details.append(el('h4', {}, 'Prompt template'));
    details.append(el('pre', {}, s.template));
    if (s.sample_output) {
      details.append(el('h4', {}, 'Sample output'));
      details.append(el('pre', {}, JSON.stringify(s.sample_output, null, 2)));
    }
    panel.append(details);
  }
  return panel;
}

await render();
