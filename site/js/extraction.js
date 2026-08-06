import { mountChrome } from './nav.js';
import { loadJson, el, header, fmtNum } from './lib.js';

await mountChrome();
document.getElementById('header').append(header('EXTRACTION LAB'));

const summary = await loadJson('data/extraction/summary.json');
const lab = document.getElementById('lab');

const ARM_LABEL = { temp0: 'temperature 0', temp07: 'temperature 0.7', default: 'CLI default' };

// Lower is better for drift, off-vocab, entry error and leakage; higher is better for the
// agreement and groundedness columns.
const COLUMNS = [
  { key: 'agreement', label: 'agreement', from: 'pooled', digits: 3, higherBetter: true },
  { key: 'agreement_tier1', label: 'tier 1', from: 'pooled', digits: 3, higherBetter: true },
  { key: 'agreement_tier2', label: 'tier 2', from: 'pooled', digits: 3, higherBetter: true },
  { key: 'ordinal_drift', label: 'ordinal drift', from: 'pooled', digits: 2 },
  { key: 'off_vocab_rate', label: 'off-vocab', from: 'pooled', digits: 3 },
  { key: 'entry_count_error', label: 'entry error', from: 'pooled', digits: 2 },
  { key: 'groundedness', label: 'grounded', from: 'pooled', digits: 3, higherBetter: true },
  { key: 'attribution_recall', label: 'attr. recall', from: 'pooled', digits: 3, higherBetter: true },
  { key: 'mean_net', label: 'net leakage', from: 'leakage', digits: 2 }
];

function summaryTable() {
  const table = el('table', { class: 'data' });
  const head = el('tr', {}, el('th', {}, 'model'), el('th', {}, 'arm'), el('th', { class: 'num' }, 'cells'));
  for (const column of COLUMNS) head.append(el('th', { class: 'num' }, column.label));
  table.append(el('thead', {}, head));

  const body = el('tbody');
  for (const row of summary.by_model_arm) {
    const tr = el('tr', {},
      el('td', {}, row.model),
      el('td', {}, ARM_LABEL[row.arm] ?? row.arm),
      el('td', { class: 'num' }, String(row.pooled.cells)));
    for (const column of COLUMNS) {
      const value = row[column.from]?.[column.key];
      tr.append(el('td', { class: 'num' }, value == null ? '–' : fmtNum(value, column.digits)));
    }
    body.append(tr);
  }
  table.append(body);
  return table;
}

function controlWarnings() {
  const failed = summary.by_model_arm.filter((r) => r.leakage.controls_failed.length);
  if (!failed.length) return null;
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'CELLS EXCLUDED BY A FAILED POSITIVE CONTROL')));
  panel.append(el('p', { class: 'dim' },
    'A variant whose control fails never applied its own edit, so the cell says nothing about bias. Listed here rather than pooled into the numbers above.'));
  for (const row of failed) {
    panel.append(el('p', { class: 'dim' }, `${row.model} · ${ARM_LABEL[row.arm] ?? row.arm}: ${row.leakage.controls_failed.join(', ')}`));
  }
  return panel;
}

const main = el('div', { class: 'panel' });
main.append(el('div', { class: 'panel-head' }, el('span', {}, 'EVERY MODEL, EVERY ARM')));
main.append(el('p', { class: 'dim' },
  'One row per model per temperature arm. Agreement is the share of extracted field paths that match across repeat runs of an identical résumé, so 1.000 means the parse never moved. Net leakage is how many fields shifted on a demographic swap beyond what repeat runs of the same document shift anyway.'));
main.append(summaryTable());
lab.append(main);

const warnings = controlWarnings();
if (warnings) lab.append(warnings);
