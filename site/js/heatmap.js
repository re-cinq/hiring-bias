import { mountChrome } from './nav.js';
import { loadJson, el, header, fmtNum, fmtSignedDelta, deltaClass, setParam, params } from './lib.js';
import { wallView } from './charts.js';

await mountChrome();
document.getElementById('header').append(header('BIAS MATRIX                 '));

const matrix = await loadJson('data/matrix.json');
const summary = await loadJson('data/summary.json');
const MODELS = matrix.models;
const AXES = matrix.axes;
const AXIS_LABELS = matrix.axis_labels ?? {};
const AXIS_DESCRIPTIONS = matrix.axis_descriptions ?? {};
const LEVEL_LABELS = matrix.level_labels ?? {};
const JD_LABELS = matrix.jd_labels ?? {};
const JD_SHORT = matrix.jd_short_labels ?? {};
const JD_SENIORITY = Object.fromEntries(summary.jds.map((j) => [j.id, j.seniority]));

const MODEL_DISPLAY = {
  'claude-opus': 'Claude Opus',
  'claude-sonnet': 'Claude Sonnet',
  'claude-haiku': 'Claude Haiku',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro · Preview',
  'llama-4-maverick': 'Llama 4 Maverick',
  'mistral-large': 'Mistral Large',
  'mistral-small': 'Mistral Small',
  'qwen-3-next-80b': 'Qwen 3 Next 80B'
};
const modelLabel = (m) => MODEL_DISPLAY[m] ?? m;

const root = document.getElementById('heatmap');
root.innerHTML = '';

const controls = el('div', { class: 'panel' });
controls.append(el('div', { class: 'panel-head' }, el('span', {}, 'SELECT')));
const controlsRow = el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } });
controls.append(controlsRow);

const initial = params();
const modelSel = el('select', { id: 'sel-model' });
for (const m of MODELS) modelSel.append(el('option', { value: m }, modelLabel(m)));
modelSel.value = initial.get('model') ?? MODELS[0];

const axisSel = el('select', { id: 'sel-axis' });
for (const a of AXES) axisSel.append(el('option', { value: a }, AXIS_LABELS[a] ?? a));
axisSel.value = initial.get('axis') ?? AXES[0];

controlsRow.append(
  el('label', {}, [el('span', { class: 'dim' }, 'Model:  '), modelSel]),
  el('label', {}, [el('span', { class: 'dim' }, 'Dimension:  '), axisSel])
);

root.append(controls);
const chartHost = el('div');
root.append(chartHost);
const detailHost = el('div', { id: 'detail' });
root.append(detailHost);

const cache = new Map();
async function loadAxis(axis) {
  if (!cache.has(axis)) cache.set(axis, await loadJson(`data/by-axis/${axis}.json`));
  return cache.get(axis);
}

const initData = await loadAxis(axisSel.value);
const initLevels = matrix.levels_by_axis[axisSel.value].map((id) => ({ id, label: LEVEL_LABELS[axisSel.value]?.[id] ?? id }));
const initJds = orderedJdsFor(initData);

const view = wallView({
  container: chartHost,
  title: 'WALL — VARIANTS × JOB DESCRIPTIONS',
  levels: initLevels,
  jds: initJds,
  modelLabel: modelLabel(modelSel.value),
  axisLabel: AXIS_LABELS[axisSel.value] ?? axisSel.value,
  axisDescription: AXIS_DESCRIPTIONS[axisSel.value] ?? '',
  onSelect: (meta, cellId) => syncTableSelection(cellId)
});

function rowDomId(level, jd) {
  return `row-${level}-${jd}`.replace(/[^a-z0-9-]/gi, '_');
}

function syncTableSelection(cellId) {
  document.querySelectorAll('tr.row-sel').forEach((tr) => tr.classList.remove('row-sel'));
  if (!cellId) return;
  const [level, jd] = cellId.split('|');
  const tr = document.getElementById(rowDomId(level, jd));
  if (tr) tr.classList.add('row-sel');
}

function orderedJdsFor(data) {
  const ids = [...new Set(data.cells.map((c) => c.jd))];
  ids.sort((a, b) => (JD_SENIORITY[a] ?? 5) - (JD_SENIORITY[b] ?? 5) || a.localeCompare(b));
  return ids.map((id) => ({
    id,
    label: JD_SHORT[id] ?? JD_LABELS[id] ?? id,
    fullLabel: JD_LABELS[id] ?? id
  }));
}

await rebuildWall();
modelSel.addEventListener('change', onChange);
axisSel.addEventListener('change', onChange);

async function onChange() {
  setParam('model', modelSel.value, { replace: true });
  setParam('axis', axisSel.value, { replace: false });
  await rebuildWall();
}

async function rebuildWall() {
  const axis = axisSel.value;
  const model = modelSel.value;
  const data = await loadAxis(axis);
  const levels = matrix.levels_by_axis[axis].map((id) => ({ id, label: LEVEL_LABELS[axis]?.[id] ?? id }));
  const jds = orderedJdsFor(data);
  const STEP = 8 * 1.4;
  const cells = data.cells.filter((c) => c.model === model);
  const maxAbs = Math.max(...cells.map((c) => Math.abs(c.delta ?? 0)), 0.0001);

  const voxels = [];
  for (let li = 0; li < levels.length; li++) {
    for (let ji = 0; ji < jds.length; ji++) {
      const cell = cells.find((c) => c.level === levels[li].id && c.jd === jds[ji].id);
      if (!cell || cell.delta == null) continue;
      voxels.push({
        cellId: `${levels[li].id}|${jds[ji].id}`,
        x: ji * STEP,
        y: li * STEP,
        value: cell.delta / maxAbs,
        meta: {
          ...cell,
          level: levels[li].id,
          levelLabel: levels[li].label,
          jdLabel: jds[ji].fullLabel ?? jds[ji].label
        }
      });
    }
  }

  view.setSelected({
    levels, jds,
    modelLabel: modelLabel(model),
    axisLabel: AXIS_LABELS[axis] ?? axis,
    axisDescription: AXIS_DESCRIPTIONS[axis] ?? ''
  });
  view.setVoxels(voxels);
  renderDetail({ model, axis, cells, levels, jds });
}

function renderDetail({ model, axis, cells, levels, jds }) {
  detailHost.innerHTML = '';
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, `SUMMARY · ${AXIS_LABELS[axis] ?? axis} × ${modelLabel(model)}`)));

  panel.append(el('p', { class: 'dim' }, [
    'Each row is one (variant, job) experiment for this model, repeated several times. ',
    el('strong', {}, 'n'), ' is the number of reruns. ',
    el('strong', {}, 'Mean'), ' is the model\'s average score for the variant across those reruns; ',
    el('strong', {}, 'Baseline'), ' is its average for the unmodified résumé on the same job. ',
    el('strong', {}, 'Δ'), ' is Mean minus Baseline (negative = the variant was penalised, positive = boosted). ',
    el('strong', {}, '95% CI'), ' is the range we expect the variant\'s true average to fall in 95 times out of 100. ',
    el('strong', {}, 'Sig'), ' shows ✓ when the baseline sits outside that range, meaning the gap is unlikely to be run-to-run noise.'
  ]));

  const table = el('table', { class: 'data' });
  table.append(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Variant'),
    el('th', {}, 'Job description'),
    el('th', { class: 'num', title: 'Number of reruns we collected for this cell. More reruns means a tighter confidence interval.' }, 'n'),
    el('th', { class: 'num', title: 'Average score the model gave the variant across all reruns.' }, 'Mean'),
    el('th', { class: 'num', title: 'Average score the model gave the unmodified résumé on the same job. The reference point.' }, 'Baseline'),
    el('th', { class: 'num', title: 'Mean minus Baseline. Negative = the variant was penalised, positive = boosted.' }, 'Δ'),
    el('th', { class: 'num', title: '95% confidence interval for the variant\'s mean score. The range the true average likely lies in.' }, '95% CI'),
    el('th', { title: '✓ when the baseline falls outside the variant\'s 95% CI. The gap is unlikely to be run-to-run noise.' }, 'Sig'),
    el('th', {}, '')
  ])));
  const tbody = el('tbody');
  const ranked = cells.filter((c) => c.delta != null).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const levelMap = Object.fromEntries(levels.map((l) => [l.id, l.label]));
  const jdMap = Object.fromEntries(jds.map((j) => [j.id, j.fullLabel ?? j.label]));
  for (const r of ranked) {
    tbody.append(el('tr', { id: rowDomId(r.level, r.jd) }, [
      el('td', {}, levelMap[r.level] ?? r.level),
      el('td', {}, jdMap[r.jd] ?? r.jd),
      el('td', { class: 'num' }, r.n),
      el('td', { class: 'num' }, fmtNum(r.mean, 2)),
      el('td', { class: 'num' }, fmtNum(r.baseline_mean, 2)),
      el('td', { class: `num ${deltaClass(r.delta)}` }, fmtSignedDelta(r.delta)),
      el('td', { class: 'num dim' }, `${fmtNum(r.ci_lo, 1)}…${fmtNum(r.ci_hi, 1)}`),
      el('td', {}, r.significant ? el('span', { class: 'accent' }, '✓') : el('span', { class: 'dim' }, '–')),
      el('td', {}, el('a', {
        href: `diff.html?variant=${axis}_${r.level}&model=${model}&jd=${r.jd}`
      }, 'diff →'))
    ]));
  }
  table.append(tbody);
  panel.append(table);
  detailHost.append(panel);
}
