import { mountChrome } from './nav.js';
import { loadJson, el, header, fmtNum, fmtSignedDelta, modelLabel, modelVersion } from './lib.js';

await mountChrome();
document.getElementById('header').append(header('THE CONTROL'));

const placebo = await loadJson('data/placebo.json');
const lab = document.getElementById('lab');

function panel(title, ...children) {
  const box = el('div', { class: 'panel' });
  if (title) box.append(el('div', { class: 'panel-head' }, el('span', {}, title)));
  for (const child of children) if (child) box.append(child);
  return box;
}

function table(headers, rows) {
  const head = el('tr', {}, headers.map((h) => el('th', { class: h.num ? 'num' : '' }, h.label)));
  const body = el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c) =>
    el('td', { class: `${c.num ? 'num' : ''} ${c.cls ?? ''}`.trim() }, c.text)))));
  return el('table', { class: 'data' }, [el('thead', {}, head), body]);
}

const num = (value, digits = 3) => ({ num: true, text: value == null ? '–' : fmtNum(value, digits) });

// The headline. One row per model: how far an irrelevant value moves the score, against
// how far a demographic one does. A ratio at or above 1 means the two are the same size.
function verdictPanel() {
  const rows = placebo.comparison.map((row) => [
    { text: modelLabel(row.model), cls: 'model', title: modelVersion(row.model) },
    num(row.noop_floor),
    num(row.placebo_value_effect),
    { text: row.worst_pair ?? '–' },
    num(row.demographic_mean_abs),
    row.ratio == null
      ? num(null)
      : { num: true, text: fmtNum(row.ratio, 2), cls: row.ratio >= 1 ? 'alert' : 'accent' }
  ]);

  return panel('IS THE BIAS BIGGER THAN THE NOISE?',
    el('p', { class: 'dim' }, 'The no-op floor is how far the score moves when the edit changes bytes and nothing else. The irrelevant-value effect is how far it moves between two values of a meaningless field — the same shape of comparison as swapping one name for another, which is why it is the number that belongs beside the demographic one. A ratio at or above 1 means that model’s demographic reading is not separable from what this control moves on its own.'),
    table([
      { label: 'model' }, { label: 'no-op floor', num: true }, { label: 'irrelevant value', num: true },
      { label: 'worst field' }, { label: 'demographic mean |Δ|', num: true }, { label: 'ratio', num: true }
    ], rows));
}

// Adding the line at all, level by level. Separated from the value effect on purpose:
// a model that dislikes bracketed metadata is making a judgement, not wobbling.
function presencePanel() {
  const byLevel = new Map();
  for (const row of placebo.presence) {
    if (!byLevel.has(row.level)) byLevel.set(row.level, []);
    byLevel.get(row.level).push(row);
  }
  const labels = Object.fromEntries(placebo.levels.map((l) => [l.id, l.label]));

  const rows = [...byLevel.entries()].map(([level, entries]) => {
    const deltas = entries.map((e) => e.mean_delta).filter((d) => d != null);
    const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
    const worst = entries.reduce((acc, e) => (acc == null || Math.abs(e.mean_delta) > Math.abs(acc.mean_delta) ? e : acc), null);
    return [
      { text: labels[level] ?? level },
      { num: true, text: meanDelta == null ? '–' : fmtSignedDelta(meanDelta, 3), cls: meanDelta < 0 ? 'alert' : '' },
      { text: worst ? `${modelLabel(worst.model)} (${fmtSignedDelta(worst.mean_delta, 2)})` : '–' }
    ];
  });

  return panel('WHAT ADDING THE LINE DID',
    el('p', { class: 'dim' }, 'Each level against the untouched résumé, averaged across every model and job description. This mixes two things that cannot be told apart here — the arrival of a bracketed metadata line, and the value it carried — which is exactly why the verdict above uses the paired comparison instead.'),
    table([{ label: 'edit' }, { label: 'mean Δ vs baseline', num: true }, { label: 'moved most' }], rows));
}

function pairPanel() {
  const rows = placebo.value
    .slice()
    .sort((a, b) => b.mean_abs - a.mean_abs)
    .map((row) => [
      { text: placebo.pairs.find((p) => p.id === row.pair)?.label ?? row.pair },
      { text: modelLabel(row.model) },
      num(row.mean_abs),
      { num: true, text: fmtSignedDelta(row.mean_signed, 3) },
      { num: true, text: String(row.n_jds) }
    ]);

  return panel('THE PAIRED COMPARISON, FIELD BY MODEL',
    el('p', { class: 'dim' }, 'Two values of one meaningless field, differenced job description by job description and then pooled. The signed column says whether one value was systematically preferred; a value near zero with a large absolute figure means the model moved, but not in a consistent direction.'),
    table([
      { label: 'field' }, { label: 'model' }, { label: 'mean |Δ|', num: true },
      { label: 'mean signed Δ', num: true }, { label: 'JDs', num: true }
    ], rows));
}

// The instrument check. Four of eleven models were scored through a CLI that attached
// ~29k tokens of its own context; this is what that was worth.
function harnessPanel() {
  if (!placebo.harness_ab?.length) return null;
  const rows = placebo.harness_ab.map((row) => [
    { text: row.variant },
    { text: modelLabel(row.model) },
    num(row.mean_with_harness, 2),
    num(row.mean_without_harness, 2),
    { num: true, text: fmtSignedDelta(row.delta, 2), cls: Math.abs(row.delta) >= 0.5 ? 'alert' : '' }
  ]);

  return panel('THE INSTRUMENT CHECK · scoring with and without the CLI’s own context',
    el('p', { class: 'dim' }, 'The four Claude slots run through the command-line tool, which until this experiment attached its own system prompt, tool definitions and CLAUDE.md to every call — around 29,000 tokens the seven API-called models never saw. These are the same cells scored both ways. A column of near-zero deltas means the earlier results stand; anything larger means four of the eleven models were measured with a different instrument than the rest.'),
    table([
      { label: 'variant' }, { label: 'model' }, { label: 'with harness', num: true },
      { label: 'without', num: true }, { label: 'Δ', num: true }
    ], rows));
}

lab.append(el('div', {}, [verdictPanel(), pairPanel(), presencePanel(), harnessPanel()]));
