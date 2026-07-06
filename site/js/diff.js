import { mountChrome } from './nav.js';
import { loadJson, el, header, params, setParam, fmtSignedDelta, deltaClass, copyLinkButton, modelLabel, modelVersion } from './lib.js';
import { diffLines } from './linediff.js';
import { mdToHtml } from './markdown.js';
import { verdictCard } from './verdict-card.js';

await mountChrome();
document.getElementById('header').append(header('COUNTERFACTUAL DIFF'));

const summary = await loadJson('data/summary.json');
const matrix = await loadJson('data/matrix.json');
const resumes = await loadJson('data/resumes.json');
const diffsIndex = await loadJson('data/diffs/index.json');
const jdTexts = await loadJson('data/jds-text.json');

const AXES = matrix.axes;
const MODELS = matrix.models;
const AXIS_LABELS = matrix.axis_labels ?? {};
const LEVEL_LABELS = matrix.level_labels ?? {};
const LEVELS_BY_AXIS = matrix.levels_by_axis ?? {};


const AUDIT_CLASS = { bias: 'alert', justified: 'accent', mixed: 'dim' };
const AUDIT_LABEL = { bias: 'BIAS', justified: 'JUSTIFIED', mixed: 'MIXED' };

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
for (const m of MODELS) modelSel.append(el('option', { value: m, title: modelVersion(m) }, modelLabel(m)));
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

function jdLabel(jd) {
  return summary.jds.find((j) => j.id === jd)?.label ?? jd;
}

function jobDescription(jd) {
  const panel = el('div', { class: 'panel' });
  const details = el('details', { class: 'jd-row jd-collapse' });
  details.append(el('summary', {}, [
    el('span', { class: 'jd-caret' }, '▸'),
    el('span', { class: 'panel-head-text' }, `JOB DESCRIPTION · ${jdLabel(jd)}`)
  ]));
  const body = el('div', { class: 'jd-body' });
  body.innerHTML = mdToHtml(jdTexts[jd] ?? '');
  details.append(body);
  panel.append(details);
  return panel;
}

async function renderVerdict(variant, model, jd) {
  verdictHost.innerHTML = '';
  verdictHost.append(jobDescription(jd));
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'WHAT THE MODEL SAID · BASELINE vs VARIANT')));

  const id = `${variant}__${model}__${jd}`;
  let prebuilt = null;
  try { prebuilt = await loadJson(`data/diffs/${id}.json`); } catch {}

  if (prebuilt) {
    panel.append(renderSummaryBlock(prebuilt, variant));
    const cardsHost = el('div', { class: 'verdict-cards-host' });
    panel.append(cardsHost);

    let bIdx = 0, vIdx = 0;
    function rebuild() {
      cardsHost.innerHTML = '';
      cardsHost.append(renderRunCards(prebuilt, variant, bIdx, vIdx, {
        onSelectB: (i) => { if (i !== bIdx) { bIdx = i; rebuild(); } },
        onSelectV: (i) => { if (i !== vIdx) { vIdx = i; rebuild(); } }
      }));
    }
    rebuild();
  } else {
    const axis = variant.split('_')[0];
    const level = variant.slice(axis.length + 1);
    const byAxis = await loadJson(`data/by-axis/${axis}.json`);
    const cell = byAxis.cells.find((c) => c.level === level && c.model === model && c.jd === jd);
    if (!cell) {
      panel.append(el('p', { class: 'dim' }, 'No data yet for this combination. Pick a different cell.'));
    } else {
      const base = { mean: cell.baseline_mean, recommend_rate: cell.baseline_recommend_rate, sample: null };
      const vari = { mean: cell.mean, recommend_rate: cell.recommend_yes_rate, sample: null };
      panel.append(renderSummaryBlock({ delta: cell.delta, ci_overlap: !cell.significant, audit: null }, variant));
      const wrap = el('div', { class: 'grid grid-2' });
      wrap.append(verdictCard('Baseline (unmodified resume)', base, 0, null, null));
      wrap.append(verdictCard(`Variant · ${variantLabel(variant)}`, vari, 0, null, null));
      panel.append(wrap);
    }
  }

  panel.append(changeCaption(variant));
  verdictHost.append(panel);
}

// Aggregate summary (Δ, significance, plain-language, audit verdict). Stable across runs.
function renderSummaryBlock(prebuilt, variant) {
  const summary = el('div', { class: 'panel' });
  summary.append(el('div', { class: 'panel-head' }, el('span', {}, 'SUMMARY')));
  summary.append(el('div', {}, [
    `Δ score: `, el('span', { class: deltaClass(prebuilt.delta) }, fmtSignedDelta(prebuilt.delta, 2)),
    ' · ',
    prebuilt.ci_overlap ? el('span', { class: 'dim' }, 'CI overlaps baseline (not significant)') : el('span', { class: 'accent' }, '✓ CI excludes baseline (significant)')
  ]));
  summary.append(el('p', { class: 'plain-summary' }, plainSummary(prebuilt.delta, prebuilt.ci_overlap, variant)));
  if (prebuilt.audit?.verdict) summary.append(renderAudit(prebuilt.audit));
  return summary;
}

// Two cards. Run navigation is done by clicking a row in the runscores strip inside each card.
// The variant card's word-diff highlighting is re-computed against whichever baseline run is selected.
function renderRunCards(prebuilt, variant, bIdx, vIdx, handlers) {
  const baselineRun = prebuilt.baseline.runs?.[bIdx]?.response ?? prebuilt.baseline.sample;
  const wrap = el('div', { class: 'grid grid-2' });
  wrap.append(verdictCard('Baseline (unmodified resume)', prebuilt.baseline, bIdx, null, handlers.onSelectB));
  wrap.append(verdictCard(`Variant · ${variantLabel(variant)}`, prebuilt.variant_data, vIdx, baselineRun, handlers.onSelectV));
  return wrap;
}

// A math-free reading of the Δ score + significance, for non-statisticians.
function plainSummary(delta, ciOverlap, variant) {
  if (delta == null) return 'Not enough runs yet to compare this version against the unchanged résumé.';
  const what = variantLabel(variant);
  const abs = Math.abs(delta);
  const points = `${abs.toFixed(2)} ${abs >= 1.005 ? 'points' : 'point'} out of 10`;

  if (abs < 0.1) {
    return `Changing only "${what}" (nothing about the candidate's actual experience) left the score essentially unchanged (${points}). The model treated both résumés the same here.`;
  }

  const size = abs < 0.5 ? 'a little' : abs < 1.5 ? 'noticeably' : 'sharply';
  const dir = delta > 0 ? 'higher (it helped the candidate)' : 'lower (it hurt the candidate)';
  const lead = `Changing only "${what}" (nothing about the candidate's actual experience) made the model score this résumé ${size} ${dir}, by ${points} on average.`;
  const tail = ciOverlap
    ? ' But that gap is within the normal run-to-run wobble, so it might just be chance.'
    : ' This gap held up consistently across repeated runs, so it looks like a real effect, not luck.';
  return lead + tail;
}

function renderAudit(audit) {
  const box = el('div', { class: 'audit' });
  const klass = AUDIT_CLASS[audit.verdict] ?? 'dim';
  const auditorLabel = audit.auditor ? ` by ${audit.auditor}` : '';
  box.append(el('div', {}, [
    el('span', { class: 'dim' }, `AUDITOR VERDICT${auditorLabel}: `),
    el('span', { class: `audit-badge ${klass}` }, AUDIT_LABEL[audit.verdict] ?? audit.verdict.toUpperCase()),
    audit.confidence ? el('span', { class: 'dim' }, ` · ${audit.confidence} confidence`) : null
  ]));
  if (audit.rationale) box.append(el('p', { class: 'dim' }, audit.rationale));
  if (audit.bias_signals?.length) {
    const ul = el('ul');
    for (const s of audit.bias_signals) ul.append(el('li', { class: klass }, `"${s}"`));
    box.append(ul);
  }
  return box;
}

function variantLabel(variant) {
  const axis = variant.split('_')[0];
  const level = variant.slice(axis.length + 1);
  return `${AXIS_LABELS[axis] ?? axis} · ${LEVEL_LABELS[axis]?.[level] ?? level}`;
}
