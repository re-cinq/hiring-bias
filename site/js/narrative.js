import { mountChrome } from './nav.js';
import { loadJson, el, header, fmtNum, fmtPct, fmtSignedDelta, deltaClass } from './lib.js';
import { computeBiasIndex, renderBiasIndex, renderDimensionBias } from './bias-index.js';

await mountChrome();
document.getElementById('header').append(header('IDENTICAL RÉSUMÉ.  DIFFERENT NAME.  DIFFERENT VERDICT.', 'a counterfactual audit of LLM résumé scoring'));

const status = await loadJson('data/status.json');
const matrix = await loadJson('data/matrix.json');
const diffsIndex = await loadJson('data/diffs/index.json');

const MODEL_DISPLAY = {
  'claude-opus': 'Claude Opus',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro · Preview',
  'llama-4-maverick': 'Llama 4 Maverick',
  'qwen-3-next-80b': 'Qwen 3 Next 80B'
};

// Hero counterfactual = the top |Δ| pair in diffsIndex
const top = diffsIndex.find((d) => d.ci_overlap === false) ?? diffsIndex[0];
const hero = document.getElementById('hero');
hero.innerHTML = '';

if (top) {
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'THE STARKEST DELTA WE HAVE SO FAR')));
  const axisL = matrix.axis_labels?.[top.axis] ?? top.axis;
  const levelL = matrix.level_labels?.[top.axis]?.[top.level] ?? top.level;
  const jdL = matrix.jd_labels?.[top.jd] ?? top.jd;
  panel.append(el('p', {}, [
    'When the only change is ',
    el('strong', {}, levelL),
    ' (axis: ', el('em', { class: 'dim' }, axisL), '), ',
    el('strong', {}, MODEL_DISPLAY[top.model] ?? top.model),
    ' shifts its score by ',
    el('span', { class: deltaClass(top.delta) }, fmtSignedDelta(top.delta, 2)),
    ' on the role: ',
    el('em', {}, jdL),
    '.'
  ]));
  panel.append(el('p', {}, el('a', { href: `diff.html?variant=${top.axis}_${top.level}&model=${top.model}&jd=${top.jd}` }, 'See this counterfactual →')));
  hero.append(panel);
}

renderTopCounterfactuals(document.getElementById('topcounterfactuals'));

function renderTopCounterfactuals(host) {
  if (!host) return;
  host.innerHTML = '';
  const top = diffsIndex.slice(0, 12);
  if (!top.length) return;
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'TOP COUNTERFACTUALS — THE CASES WITH THE LARGEST Δ')));
  const grid = el('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '6px' } });
  for (const d of top) {
    const axisL = matrix.axis_labels?.[d.axis] ?? d.axis;
    const levelL = matrix.level_labels?.[d.axis]?.[d.level] ?? d.level;
    grid.append(el('a', {
      href: `diff.html?variant=${d.axis}_${d.level}&model=${d.model}&jd=${d.jd}`,
      class: 'tc-card'
    }, [
      el('span', { class: d.delta >= 0 ? 'accent' : 'alert' }, (d.delta >= 0 ? '+' : '') + d.delta.toFixed(2)),
      ' · ',
      `${axisL} · ${levelL}`,
      el('br'),
      el('span', { class: 'dim' }, `${MODEL_DISPLAY[d.model] ?? d.model} · ${matrix.jd_labels?.[d.jd] ?? d.jd}`)
    ]));
  }
  panel.append(grid);
  host.append(panel);
}

renderBiasIndex(document.getElementById('biasindex'), matrix, {
  title: 'WHICH MODELS ARE THE MOST DEMOGRAPHICALLY SENSITIVE?',
  description: 'For each model, the average absolute score change when one demographic signal on the résumé is altered. Higher = the model treats variants more differently. Most penalised / most rewarded shows the variant that triggered the largest swing in each direction.'
});

renderDimensionBias(document.getElementById('dimensionbias'), matrix);

const stats = document.getElementById('stats');
stats.innerHTML = '';
const wrap = el('div', { class: 'stats' });
const variantCount = 1 + matrix.axes.reduce((s, a) => s + (matrix.levels_by_axis?.[a]?.length ?? 0), 0);
wrap.append(stat('Resume variants tested', String(variantCount), `baseline + ${variantCount - 1} résumé variants`));
wrap.append(stat('Models evaluated', String(matrix.models.length), matrix.models.map((m) => MODEL_DISPLAY[m] ?? m).join(' · ')));
wrap.append(stat('Job descriptions', String(matrix.axes.length ? Object.keys(matrix.jd_labels ?? {}).length : 0), 'from junior fullstack to CTO'));
wrap.append(stat('Inference runs collected', status.n_records.toLocaleString(), `of ${status.expected_total_records.toLocaleString()} planned (${fmtPct(status.n_records / status.expected_total_records, 1)})`));
wrap.append(stat('API spend so far', `$${fmtNum(status.total_cost_usd, 2)}`, `${(status.total_input_tokens / 1e6).toFixed(1)}M input · ${(status.total_output_tokens / 1e6).toFixed(1)}M output tokens`));
wrap.append(stat('Bias dimensions', String(matrix.axes.length), matrix.axes.map((a) => matrix.axis_labels?.[a] ?? a).join(' · ')));
stats.append(wrap);

const nextsteps = document.getElementById('nextsteps');
nextsteps.innerHTML = '';
const ns = el('div', { class: 'panel' });
ns.append(el('div', { class: 'panel-head' }, el('span', {}, 'WHERE TO GO NEXT')));
const ul = el('ul');
ul.append(el('li', {}, [el('a', { href: 'heatmap.html' }, 'Bias Matrix'), ' — pick a (model, dimension) pair and see the wall of variants × jobs.']));
ul.append(el('li', {}, [el('a', { href: 'diff.html' }, 'Counterfactual Diff'), ' — pick one cell and read what the model actually said about each résumé.']));
ul.append(el('li', {}, [el('a', { href: 'resume-diff.html' }, 'Resume Diff'), ' — verify that the experiment is honest: usually only one line changes between any two variants.']));
ul.append(el('li', {}, [el('a', { href: 'methodology.html' }, 'Methodology'), ' — the prompt, the experiment design, the limitations.']));
ul.append(el('li', {}, [el('a', { href: 'downloads.html' }, 'Downloads'), ' — raw run-level JSON, aggregated CSV, the variant resumes themselves.']));
nextsteps.append(ns);
ns.append(ul);

function stat(label, value, sub) {
  const s = el('div', { class: 'stat' });
  s.append(el('div', { class: 'label' }, label));
  s.append(el('div', { class: 'value' }, value));
  s.append(el('div', { class: 'sub' }, sub));
  return s;
}
