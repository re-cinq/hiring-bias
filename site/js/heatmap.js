import { mountChrome } from './nav.js';
import { loadJson, el, header, fmtNum, fmtSignedDelta, deltaClass, setParam, params, modelLabel, modelVersion } from './lib.js';
import { wallView } from './charts.js';
import { dotStrip, collapseValues, DELTA_SCALE } from './dot-strip.js';

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

// Voxel colour saturates at |Δ| = 2 on a fixed absolute scale, the same for every model,
// so the wall is comparable across models and agrees with the fixed −3..+3 delta bar.
// A low-bias model like Fable (max |Δ| ≈ 1.2) reads pale, which is the truth; the old
// per-model normalisation made every model saturate and misrepresented small effects.
const WALL_DELTA_CAP = 2;


const root = document.getElementById('heatmap');
root.innerHTML = '';

const controls = el('div', { class: 'panel' });
controls.append(el('div', { class: 'panel-head' }, el('span', {}, 'SELECT')));
const controlsRow = el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } });
controls.append(controlsRow);

const initial = params();
const modelSel = el('select', { id: 'sel-model' });
for (const m of MODELS) modelSel.append(el('option', { value: m, title: modelVersion(m) }, modelLabel(m)));
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
  title: 'WALL, VARIANTS × JOB DESCRIPTIONS',
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

  const voxels = [];
  for (let li = 0; li < levels.length; li++) {
    for (let ji = 0; ji < jds.length; ji++) {
      const cell = cells.find((c) => c.level === levels[li].id && c.jd === jds[ji].id);
      if (!cell || cell.delta == null) continue;
      voxels.push({
        cellId: `${levels[li].id}|${jds[ji].id}`,
        x: ji * STEP,
        y: li * STEP,
        value: Math.max(-1, Math.min(1, cell.delta / WALL_DELTA_CAP)),
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

// Same visual language as the resume-diff bar: a filled dot for the mean shift and one
// hollow dot per run, but plotted in Δ-vs-baseline space (run score − baseline mean) so
// the fixed −3..+3 scale still reads as "how far from baseline". Runs sharing a score
// stack vertically so all of them stay visible.
function deltaWithCiBar(r) {
  const { delta, ci_lo: ciLo, ci_hi: ciHi, baseline_mean: baseline, scores, recommend } = r;
  if (delta == null) return el('span', { class: 'dim' }, '–');
  const sign = Math.abs(delta) < 0.005 ? 'zero' : delta > 0 ? 'pos' : 'neg';
  const ci = (baseline != null && ciLo != null && ciHi != null)
    ? {
        lo: ciLo - baseline,
        hi: ciHi - baseline,
        cls: sign,
        title: `95% CI: Δ ${fmtSignedDelta(ciLo - baseline, 2)} to ${fmtSignedDelta(ciHi - baseline, 2)}`
      }
    : null;

  // Mean marker paints first so per-run dots sit on top and stay hoverable.
  const markers = [{
    value: delta,
    filled: true,
    cls: sign,
    title: `mean Δ ${fmtSignedDelta(delta, 3)} · baseline ${fmtNum(baseline, 2)}`
  }];
  let stacked = false;
  if (Array.isArray(scores) && baseline != null) {
    for (const { value, indexes } of collapseValues(scores)) {
      if (indexes.length > 1) stacked = true;
      indexes.forEach((runI, k) => {
        const rec = Array.isArray(recommend) ? recommend[runI] : null;
        markers.push({
          value: value - baseline,
          dy: (k - (indexes.length - 1) / 2) * 7,
          cls: ['yes', 'no', 'maybe'].includes(rec) ? `iter ${rec}` : 'iter',
          title: `run ${runI + 1}${rec ? ` (${rec})` : ''} · score ${value} · Δ ${fmtSignedDelta(value - baseline, 0)}`
        });
      });
    }
  }
  return dotStrip({ ...DELTA_SCALE, ci, markers, cls: stacked ? 'runs' : '' });
}

function renderDetail({ model, axis, cells, levels, jds }) {
  detailHost.innerHTML = '';
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', { title: modelVersion(model) }, `SUMMARY · ${AXIS_LABELS[axis] ?? axis} × ${modelLabel(model)}`)));

  panel.append(el('p', { class: 'dim' }, 'Each row is one (variant, job) experiment. The bar plots every run\'s score change vs the unmodified baseline as a hollow dot (○), and the mean shift as a filled dot (●), on a fixed −3 to +3 scale. Runs with the same score stack. Same scale as the resume-diff page; open a diff to read the runs in full.'));

  const legend = el('div', { class: 'bar-legend' }, [
    el('span', {}, [el('span', { class: 'swatch filled', style: { color: 'var(--accent)' } }), ' mean Δ above baseline']),
    el('span', {}, [el('span', { class: 'swatch filled', style: { color: 'var(--alert)' } }), ' mean Δ below baseline']),
    el('span', {}, [el('span', { class: 'swatch hollow' }), ' individual run (stacked = same score)']),
    el('span', {}, [el('span', { class: 'swatch errbar pos' }), ' 95% CI']),
    el('span', {}, [el('span', { class: 'swatch tick' }), ' baseline (Δ = 0)'])
  ]);
  panel.append(legend);

  const table = el('table', { class: 'data hm-detail' });
  table.append(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Variant'),
    el('th', {}, 'Job description'),
    el('th', {}, 'Δ vs baseline (n reruns)'),
    el('th', {}, '')
  ])));
  const tbody = el('tbody');
  const ranked = cells.filter((c) => c.delta != null).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const levelMap = Object.fromEntries(levels.map((l) => [l.id, l.label]));
  const jdMap = Object.fromEntries(jds.map((j) => [j.id, j.fullLabel ?? j.label]));
  for (const r of ranked) {
    const sign = r.delta == null ? '' : (Math.abs(r.delta) < 0.005 ? 'dim' : r.delta > 0 ? 'accent' : 'alert');
    const caption = el('div', { class: 'delta-bar-caption' }, [
      el('span', { class: `delta ${sign}` }, fmtSignedDelta(r.delta, 2)),
      el('span', {}, `n=${r.n}`),
      r.significant ? el('span', { class: 'accent' }, '✓ significant') : el('span', { class: 'dim' }, 'within noise')
    ]);
    const cell = document.createElement('div');
    cell.append(deltaWithCiBar(r), caption);

    tbody.append(el('tr', { id: rowDomId(r.level, r.jd) }, [
      el('td', {}, levelMap[r.level] ?? r.level),
      el('td', {}, jdMap[r.jd] ?? r.jd),
      el('td', { class: 'hm-detail-bar' }, cell),
      el('td', {}, el('a', {
        href: `diff.html?variant=${axis}_${r.level}&model=${model}&jd=${r.jd}`
      }, 'diff →'))
    ]));
  }
  table.append(tbody);
  panel.append(table);
  detailHost.append(panel);
}
