import { mountChrome } from './nav.js';
import { loadJson, el, panel, table, header, fmtNum, fmtPct, fmtSignedDelta, modelLabel, modelVersion } from './lib.js';
import { sampler } from './placebo-sampler.js';

await mountChrome();
document.getElementById('header').append(header('THE CONTROL'));

const placebo = await loadJson('data/placebo.json');
const index = await loadJson('data/placebo/index.json');
const resumes = await loadJson('data/resumes.json');
const lab = document.getElementById('lab');

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
    el('p', { class: 'dim' }, 'The no-op floor is how far the score moves when the edit changes bytes and nothing else. The irrelevant-value effect is how far it moves between two values of a meaningless field. That is the same shape of comparison as swapping one name for another, which is why it is the number that belongs beside the demographic one. A ratio at or above 1 means that model\'s demographic reading is not separable from what this control moves on its own.'),
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
    el('p', { class: 'dim' }, 'Each level against the untouched résumé, averaged across every model and job description. This mixes two things that cannot be told apart here, the arrival of a bracketed metadata line and the value it carried. That is exactly why the verdict above uses the paired comparison instead.'),
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
    el('p', { class: 'dim' }, 'Two values of one meaningless field, differenced job description by job description and then pooled. The signed column says whether one value was systematically preferred. A value near zero with a large absolute figure means the model moved, but not in a consistent direction.'),
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

  return panel('THE INSTRUMENT CHECK · scoring with and without the CLI\'s own context',
    el('p', { class: 'dim' }, 'The four Claude slots run through the command-line tool, which until this experiment attached its own system prompt, tool definitions and CLAUDE.md to every call, around 29,000 tokens the seven API-called models never saw. These are the same cells scored both ways. A column of near-zero deltas means the earlier results stand. Anything larger means four of the eleven models were measured with a different instrument than the rest.'),
    table([
      { label: 'variant' }, { label: 'model' }, { label: 'with harness', num: true },
      { label: 'without', num: true }, { label: 'Δ', num: true }
    ], rows));
}

// The other half of the verdict. A score that moves is one thing; a score that moves while
// the model never once refers to what changed is another, and the two belong on one page.
function mentionsPanel() {
  if (!placebo.mentions?.length) return null;
  const total = placebo.mentions.reduce((sum, row) => sum + row.n_responses, 0);
  const mentioning = placebo.mentions.reduce((sum, row) => sum + row.n_mentioning, 0);

  const rows = placebo.mentions.map((row) => [
    { text: modelLabel(row.model), cls: 'model', title: modelVersion(row.model) },
    { text: row.field_label },
    { num: true, text: String(row.n_responses) },
    { num: true, text: String(row.n_mentioning) },
    { num: true, text: fmtPct(row.rate, 1), cls: row.n_mentioning ? 'alert' : 'accent' }
  ]);

  const headline = mentioning === 0
    ? el('p', { class: 'accent' }, `Not once. Across all ${total.toLocaleString()} evaluations that carried an irrelevant line, no model ever referred to the vehicle, the day of the week or the weather, not in a justification, a strength, a concern or a key factor.`)
    : el('p', { class: 'alert' }, `${mentioning} of ${total.toLocaleString()} evaluations refer to the irrelevant line.`);

  return panel('DID THE MODELS EVER MENTION IT?',
    headline,
    el('p', { class: 'dim' }, mentioning === 0
      ? 'This is what separates the control from the demographic axes. The scores above still moved. The models had a reason to give and gave a different one every time, because the thing that moved them was never available to them as a reason. They never noticed it. The search covers the justification, every strength, every concern and every key factor, looking for the subject of the injected line. For the car that means vehicle, Volkswagen, Golf and car. For the day it means Tuesday, Saturday, weekend and application received. For the weather it means weather, rain and temperature. The values themselves are not matched, because "clear" and "red" are ordinary words in hiring prose and would return nothing but false hits.'
      : 'Where a model does bring the line up, the drill-down below quotes the passage.'),
    table([
      { label: 'model' }, { label: 'field' }, { label: 'evaluations', num: true },
      { label: 'mentioning it', num: true }, { label: 'rate', num: true }
    ], rows));
}

lab.append(el('div', {}, [verdictPanel(), pairPanel(), presencePanel(), mentionsPanel(), harnessPanel()]));
lab.append(sampler(index, resumes));
