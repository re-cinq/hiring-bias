import { mountChrome } from './nav.js';
import { loadJson, el, header, params, setParam } from './lib.js';
import { renderLineDiff } from './linediff.js';
import { renderResumeComparison } from './bias-index.js';

await mountChrome();

const resumes = await loadJson('data/resumes.json');
const summary = await loadJson('data/summary.json');
const matrix = await loadJson('data/matrix.json');
document.getElementById('header').append(header('RESUME DIFF'));
const LEVEL_LABELS = matrix.level_labels ?? {};

const variantIds = Object.keys(resumes).sort((a, b) => {
  if (a === 'baseline') return -1;
  if (b === 'baseline') return 1;
  return a.localeCompare(b);
});

function variantLabel(id) {
  if (id === 'baseline') return 'baseline (unmodified)';
  const m = id.match(/^([a-zA-Z]+)_(.+)$/);
  if (!m) return id;
  const [, axis, level] = m;
  const axisLabel = matrix.axis_labels?.[axis] ?? axis;
  const levelLabel = LEVEL_LABELS[axis]?.[level] ?? level;
  return `${axisLabel} · ${levelLabel}`;
}

const page = document.getElementById('page');
page.innerHTML = '';

const controls = el('div', { class: 'panel' });
controls.append(el('div', { class: 'panel-head' }, el('span', {}, 'SELECT TWO VARIANTS')));
const controlsRow = el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } });
controls.append(controlsRow);

const initial = params();

const fromSel = el('select', { id: 'sel-from' });
const toSel = el('select', { id: 'sel-to' });
for (const v of variantIds) {
  fromSel.append(el('option', { value: v }, variantLabel(v)));
  toSel.append(el('option', { value: v }, variantLabel(v)));
}
fromSel.value = initial.get('from') ?? 'baseline';
toSel.value = initial.get('to') ?? 'firstName_aisha-okonkwo';

controlsRow.append(
  el('label', {}, [el('span', { class: 'dim' }, 'Left:  '), fromSel]),
  el('label', {}, [el('span', { class: 'dim' }, 'Right:  '), toSel]),
  el('button', {
    onclick: () => {
      const a = fromSel.value;
      fromSel.value = toSel.value;
      toSel.value = a;
      onChange();
    }
  }, '[swap]')
);
page.append(controls);

const indexHost = el('div');
page.append(indexHost);

const diffHost = el('div');
page.append(diffHost);

fromSel.addEventListener('change', onChange);
toSel.addEventListener('change', onChange);

function onChange() {
  setParam('from', fromSel.value, { replace: true });
  setParam('to', toSel.value, { replace: false });
  render();
}

render();

function render() {
  const from = fromSel.value;
  const to = toSel.value;
  const fromText = resumes[from] ?? '';
  const toText = resumes[to] ?? '';

  diffHost.innerHTML = '';
  const panel = el('div', { class: 'panel' });
  const head = el('div', { class: 'panel-head' });
  head.append(el('span', {}, `${variantLabel(from)}  →  ${variantLabel(to)}`));
  panel.append(head);

  if (from === to) {
    panel.append(el('p', { class: 'dim' }, '(same variant on both sides — pick two different variants to see a diff)'));
  } else {
    panel.append(renderLineDiff(fromText, toText, { context: 2 }));
  }

  diffHost.append(panel);

  renderResumeComparison(indexHost, matrix, from, to);
}

