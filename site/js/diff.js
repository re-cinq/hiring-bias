import { mountChrome } from './nav.js';
import { loadJson, el, header, params, setParam, badges, pill, fmtNum, fmtSignedDelta, deltaClass, copyLinkButton } from './lib.js';
import { diffLines } from './linediff.js';

await mountChrome();
document.getElementById('header').append(header('COUNTERFACTUAL DIFF', 'one line changes on the résumé — read what the model said about each version'));

const summary = await loadJson('data/summary.json');
const matrix = await loadJson('data/matrix.json');
const resumes = await loadJson('data/resumes.json');
const diffsIndex = await loadJson('data/diffs/index.json');

const AXES = matrix.axes;
const MODELS = matrix.models;
const AXIS_LABELS = matrix.axis_labels ?? {};
const LEVEL_LABELS = matrix.level_labels ?? {};
const LEVELS_BY_AXIS = matrix.levels_by_axis ?? {};

const MODEL_DISPLAY = {
  'claude-opus': 'Claude Opus',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro · Preview',
  'llama-4-maverick': 'Llama 4 Maverick',
  'qwen-3-next-80b': 'Qwen 3 Next 80B'
};
const modelLabel = (m) => MODEL_DISPLAY[m] ?? m;

const initial = params();
const variantParam = initial.get('variant') ?? diffsIndex[0]?.variant ?? 'firstName_aisha-okonkwo';
const modelParam = initial.get('model') ?? diffsIndex[0]?.model ?? MODELS[0];
const jdParam = initial.get('jd') ?? diffsIndex[0]?.jd ?? summary.jds[0].id;

const page = document.getElementById('page');
page.innerHTML = '';

const controls = el('div', { class: 'panel' });
controls.append(el('div', { class: 'panel-head' }, [el('span', {}, 'SELECT'), copyLinkButton()]));
const row = el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } });
controls.append(row);

const variantSel = el('select');
const allVariants = [];
for (const axis of AXES) {
  for (const id of LEVELS_BY_AXIS[axis] || []) {
    const v = `${axis}_${id}`;
    allVariants.push({ id: v, label: `${AXIS_LABELS[axis]} · ${LEVEL_LABELS[axis]?.[id] ?? id}` });
  }
}
allVariants.sort((a, b) => a.label.localeCompare(b.label));
for (const v of allVariants) variantSel.append(el('option', { value: v.id }, v.label));
variantSel.value = variantParam;

const modelSel = el('select');
for (const m of MODELS) modelSel.append(el('option', { value: m }, modelLabel(m)));
modelSel.value = modelParam;

const jdSel = el('select');
const sortedJds = [...summary.jds].sort((a, b) => a.seniority - b.seniority);
for (const j of sortedJds) jdSel.append(el('option', { value: j.id }, j.label));
jdSel.value = jdParam;

row.append(
  el('label', {}, [el('span', { class: 'dim' }, 'Variant:  '), variantSel]),
  el('label', {}, [el('span', { class: 'dim' }, 'Model:  '), modelSel]),
  el('label', {}, [el('span', { class: 'dim' }, 'Job:  '), jdSel])
);
page.append(controls);

const verdictHost = el('div');
page.append(verdictHost);

variantSel.addEventListener('change', onChange);
modelSel.addEventListener('change', onChange);
jdSel.addEventListener('change', onChange);

await render();

async function onChange() {
  setParam('variant', variantSel.value, { replace: true });
  setParam('model', modelSel.value);
  setParam('jd', jdSel.value);
  await render();
}

async function render() {
  await renderVerdict(variantSel.value, modelSel.value, jdSel.value);
}

function changeCaption(variant) {
  const wrap = el('div', { class: 'change-caption' });
  wrap.append(el('div', { class: 'change-head' }, [
    el('span', { class: 'dim' }, 'ONE LINE CHANGED · '),
    el('span', {}, variantLabel(variant)),
    el('a', { href: `resume-diff.html?from=baseline&to=${variant}`, class: 'change-full' }, 'full résumé diff →')
  ]));

  const lines = diffLines(resumes['baseline'] ?? '', resumes[variant] ?? '');
  const changed = lines.filter((l) => l.kind !== 'ctx' && l.text.trim());
  if (!changed.length) {
    wrap.append(el('div', { class: 'dim' }, '(identical)'));
    return wrap;
  }
  const box = el('div', { class: 'linediff' });
  for (const l of changed) {
    box.append(el('div', { class: `line ${l.kind}` }, [
      el('span', { class: 'pfx' }, l.kind === 'add' ? '+ ' : '- '),
      el('span', {}, l.text.trim())
    ]));
  }
  wrap.append(box);
  return wrap;
}

async function renderVerdict(variant, model, jd) {
  verdictHost.innerHTML = '';
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'WHAT THE MODEL SAID — BASELINE vs VARIANT')));

  const id = `${variant}__${model}__${jd}`;
  let prebuilt = null;
  try { prebuilt = await loadJson(`data/diffs/${id}.json`); } catch {}

  if (prebuilt) {
    panel.append(renderVerdictCards(prebuilt.baseline, prebuilt.variant_data, variant, model, jd, prebuilt.delta, prebuilt.ci_overlap));
  } else {
    const axis = variant.split('_')[0];
    const level = variant.slice(axis.length + 1);
    const byAxis = await loadJson(`data/by-axis/${axis}.json`);
    const cell = byAxis.cells.find((c) => c.level === level && c.model === model && c.jd === jd);
    if (!cell) {
      panel.append(el('p', { class: 'dim' }, 'no data yet for this combination — pick a different cell.'));
    } else {
      const base = { mean: cell.baseline_mean, recommend_rate: cell.baseline_recommend_rate, sample: null };
      const vari = { mean: cell.mean, recommend_rate: cell.recommend_yes_rate, sample: null };
      panel.append(renderVerdictCards(base, vari, variant, model, jd, cell.delta, !cell.significant));
    }
  }

  panel.append(changeCaption(variant));
  verdictHost.append(panel);
}

function renderVerdictCards(baseline, variantData, variant, model, jd, delta, ciOverlap) {
  const wrap = el('div', { class: 'grid grid-2' });

  wrap.append(verdictCard('Baseline (unmodified resume)', baseline));
  wrap.append(verdictCard(`Variant — ${variantLabel(variant)}`, variantData));

  const summary = el('div', { class: 'panel' });
  summary.append(el('div', { class: 'panel-head' }, el('span', {}, 'SUMMARY')));
  summary.append(el('div', {}, [
    `Δ score: `, el('span', { class: deltaClass(delta) }, fmtSignedDelta(delta, 2)),
    ' · ',
    ciOverlap ? el('span', { class: 'dim' }, 'CI overlaps baseline — not significant') : el('span', { class: 'accent' }, '✓ CI excludes baseline — significant')
  ]));

  const both = document.createElement('div');
  both.append(summary, wrap);
  return both;
}

function verdictCard(title, data) {
  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'head' }, [
    el('span', { class: 'label' }, title),
    data.sample ? pill(data.sample.recommend_interview) : el('span', {})
  ]));

  card.append(el('div', {}, [
    'Score: ', el('strong', {}, data.sample?.score ?? fmtNum(data.mean, 2) ?? '—'),
    ' · Mean: ', el('strong', {}, fmtNum(data.mean, 2)),
    ' · Recommend rate: ', el('strong', {}, data.recommend_rate != null ? `${(data.recommend_rate * 100).toFixed(0)}%` : '—')
  ]));
  card.append(badges(Math.round((data.mean ?? 0)), 10));

  if (data.sample?.justification) {
    card.append(el('h4', {}, 'Justification'));
    card.append(el('p', { class: 'dim' }, data.sample.justification));
  }
  if (data.sample?.strengths?.length) {
    card.append(el('h4', {}, 'Strengths'));
    const ul = el('ul');
    for (const s of data.sample.strengths) ul.append(el('li', {}, s));
    card.append(ul);
  }
  if (data.sample?.concerns?.length) {
    card.append(el('h4', {}, 'Concerns'));
    const ul = el('ul');
    for (const c of data.sample.concerns) ul.append(el('li', {}, c));
    card.append(ul);
  }
  if (data.sample?.key_factors?.length) {
    card.append(el('h4', {}, 'Key factors'));
    const ul = el('ul');
    for (const f of data.sample.key_factors) {
      ul.append(el('li', {}, [
        `${f.factor} `,
        el('span', { class: f.direction === 'positive' ? 'accent' : 'alert' }, f.direction),
        ` · `,
        el('span', { class: 'dim' }, f.weight)
      ]));
    }
    card.append(ul);
  }
  return card;
}

function variantLabel(variant) {
  const axis = variant.split('_')[0];
  const level = variant.slice(axis.length + 1);
  return `${AXIS_LABELS[axis] ?? axis} · ${LEVEL_LABELS[axis]?.[level] ?? level}`;
}
