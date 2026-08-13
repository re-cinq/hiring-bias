import fs from 'node:fs/promises';
import path from 'node:path';
import { mean, groupBy } from '../src/aggregate.js';
import {
  agreementRate, ordinalDrift, offVocabRate, entryRecall, expectedEntryCounts,
  groundedness, attributionAccuracy, diffExtractions, allowedPathsFor, positiveControlOk, fieldCoverage,
  leakage, collectSpans, spanIsGrounded, pathCount
} from '../src/extractionMetrics.js';
import { normalizeExtraction } from '../src/extractionSchema.js';

const IN_DIR = 'results-extraction';
const VARIANTS_DIR = 'data/variants';
const OUT_DIR = 'site/data/extraction';
const BASELINE = 'baseline';

async function loadRecords() {
  const records = [];
  const arms = await fs.readdir(IN_DIR).catch(() => []);
  for (const arm of arms) {
    const files = await fs.readdir(path.join(IN_DIR, arm)).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const record = JSON.parse(await fs.readFile(path.join(IN_DIR, arm, file), 'utf8'));
      record.response = normalizeExtraction(record.response);
      records.push(record);
    }
  }
  return records;
}

async function loadVariants() {
  const files = await fs.readdir(VARIANTS_DIR);
  const texts = new Map();
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    texts.set(path.basename(file, '.md'), await fs.readFile(path.join(VARIANTS_DIR, file), 'utf8'));
  }
  return texts;
}

const responsesOf = (records) => [...records].sort((a, b) => a.run - b.run).map((r) => r.response);

// Non-allowed differing paths between two extractions, i.e. fields the axis had no
// business touching.
const leakCount = (a, b, allowed) => diffExtractions(a, b).filter((d) => !allowed(d.path)).length;

const meanOrNull = (xs) => (xs.length ? mean(xs) : null);

// Pairs within one cell measure sampling noise; pairs across baseline↔variant measure
// noise plus whatever the demographic swap moved. The difference is the signal.
//
// The floor pools within-baseline AND within-variant pairs. Using the variant's spread
// alone makes the estimator asymmetric — the cross comparison draws from two cells and so
// carries both cells' noise — which produced sharply negative "leakage" whenever the
// baseline cell happened to be the steadier of the two.
// Both sides need enough runs to estimate their own spread. A single baseline draw
// anchors the whole comparison on one arbitrary sample, which on a noisy model produces a
// confident number that means nothing.
const MIN_RUNS_FOR_LEAKAGE = 3;

function leakageFor(baselineRuns, variantRuns, variantName) {
  if (baselineRuns.length < MIN_RUNS_FOR_LEAKAGE || variantRuns.length < MIN_RUNS_FOR_LEAKAGE) {
    return {
      observed: null,
      noise_floor: null,
      net: null,
      insufficient_runs: { baseline: baselineRuns.length, variant: variantRuns.length },
      control_ok: true
    };
  }
  const allowed = allowedPathsFor(variantName);
  const cross = [];
  for (const b of baselineRuns) for (const v of variantRuns) cross.push(leakCount(b, v, allowed));

  const withinPairs = (runs) => {
    const out = [];
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) out.push(leakCount(runs[i], runs[j], allowed));
    }
    return out;
  };
  const within = [...withinPairs(baselineRuns), ...withinPairs(variantRuns)];
  const observed = meanOrNull(cross);
  const floor = meanOrNull(within);
  return {
    observed,
    noise_floor: floor,
    net: observed != null && floor != null ? observed - floor : null,
    control_ok: variantRuns.length > 0 && baselineRuns.length > 0
      && positiveControlOk(variantName, baselineRuns[0], variantRuns[0])
  };
}

function cellMetrics(runs, resumeText) {
  const expected = expectedEntryCounts(resumeText);
  const recallErrors = [];
  for (const run of runs) {
    const found = entryRecall(run);
    for (const [section, want] of Object.entries(expected)) {
      recallErrors.push(Math.abs((found[section] ?? 0) - want));
    }
  }
  const grounded = runs.map((r) => groundedness(r, resumeText).rate).filter((x) => x != null);
  const attribution = runs.map((r) => attributionAccuracy(r, resumeText));

  return {
    runs: runs.length,
    agreement: agreementRate(runs),
    agreement_exact: agreementRate(runs, { exact: true }).overall,
    ordinal_drift: ordinalDrift(runs),
    off_vocab_rate: meanOrNull(runs.map((r) => offVocabRate(r).rate)),
    entry_count_error: meanOrNull(recallErrors),
    field_coverage: meanOrNull(runs.map((r) => fieldCoverage(r).overall).filter((x) => x != null)),
    spans_provided: meanOrNull(runs.map((r) => groundedness(r, resumeText).checked)),
    groundedness: meanOrNull(grounded),
    attribution_recall: meanOrNull(attribution.map((a) => a.recall).filter((x) => x != null)),
    false_positives: meanOrNull(attribution.map((a) => a.false_positives.length)),
    misattributed: meanOrNull(attribution.map((a) => a.misattributed))
  };
}

// Pool per-cell numbers into one row. Agreement pools on the raw counts rather than
// averaging rates, so cells with more compared paths carry proportional weight.
function poolCells(cells) {
  const agreed = cells.reduce((s, c) => s + c.agreement.overall * c.agreement.compared, 0);
  const compared = cells.reduce((s, c) => s + c.agreement.compared, 0);
  const tierRate = (tier) => {
    const usable = cells.filter((c) => c.agreement.by_tier[tier] != null);
    return meanOrNull(usable.map((c) => c.agreement.by_tier[tier]));
  };
  const avg = (key) => meanOrNull(cells.map((c) => c[key]).filter((x) => x != null));
  return {
    cells: cells.length,
    agreement: compared ? agreed / compared : null,
    agreement_exact: avg('agreement_exact'),
    agreement_tier1: tierRate(1),
    agreement_tier2: tierRate(2),
    ordinal_drift: avg('ordinal_drift'),
    off_vocab_rate: avg('off_vocab_rate'),
    entry_count_error: avg('entry_count_error'),
    field_coverage: avg('field_coverage'),
    spans_provided: avg('spans_provided'),
    groundedness: avg('groundedness'),
    attribution_recall: avg('attribution_recall'),
    false_positives: avg('false_positives'),
    misattributed: avg('misattributed')
  };
}

function buildSummary(records, variantTexts) {
  const byArm = groupBy(records, (r) => `${r.model}__${r.arm}`);
  const rows = [];

  for (const [key, armRecords] of byArm) {
    const [model, arm] = key.split('__');
    const byVariant = groupBy(armRecords, (r) => r.variant);
    const cells = [];
    const leaks = [];

    const baselineRuns = byVariant.has(BASELINE) ? responsesOf(byVariant.get(BASELINE)) : [];

    for (const [variant, variantRecords] of byVariant) {
      const text = variantTexts.get(variant);
      if (!text) continue;
      const runs = responsesOf(variantRecords);
      cells.push({ variant, ...cellMetrics(runs, text) });
      if (variant !== BASELINE && baselineRuns.length) {
        leaks.push({ variant, axis: variant.split('_')[0], ...leakageFor(baselineRuns, runs, variant) });
      }
    }

    // A variant whose control failed never demonstrably applied its own edit, so its
    // leakage says nothing about bias. Counted and listed, never pooled.
    const netLeaks = leaks.filter((l) => l.control_ok).map((l) => l.net).filter((x) => x != null);
    rows.push({
      model,
      arm,
      temperature: armRecords[0]?.temperature ?? null,
      vendor: armRecords[0]?.vendor ?? null,
      pooled: poolCells(cells),
      leakage: {
        mean_net: meanOrNull(netLeaks),
        mean_observed: meanOrNull(leaks.filter((l) => l.control_ok).map((l) => l.observed).filter((x) => x != null)),
        mean_noise_floor: meanOrNull(leaks.filter((l) => l.control_ok).map((l) => l.noise_floor).filter((x) => x != null)),
        measured: netLeaks.length,
        skipped_thin_cells: leaks.filter((l) => l.insufficient_runs).length,
        controls_failed: leaks.filter((l) => !l.control_ok).map((l) => l.variant),
        by_variant: leaks
      },
      by_variant: cells
    });
  }

  rows.sort((a, b) => (a.model === b.model ? a.arm.localeCompare(b.arm) : a.model.localeCompare(b.model)));
  return {
    generated_at: new Date().toISOString(),
    models: [...new Set(records.map((r) => r.model))].sort(),
    arms: [...new Set(records.map((r) => r.arm))].sort(),
    variants: [...new Set(records.map((r) => r.variant))].sort(),
    n_records: records.length,
    by_model_arm: rows
  };
}

// ---- Samplable cells ------------------------------------------------------
// The summary answers "how far did it move"; these answer "what moved". One file per
// model × arm × variant, holding one full parse plus every path the repeat runs
// disagreed on, so the page can show the actual text behind an agreement number.

const CELLS_DIR = 'cells';
// A model at 0.7 agreement produces hundreds of moving paths. Ship the first slice and
// report the rest as a count rather than pretending the list is complete.
const MAX_LISTED_PATHS = 250;

const clip = (value) => (typeof value === 'string' && value.length > 240 ? `${value.slice(0, 240)}…` : value);

// Every path where at least one run disagreed with run 1, carrying each run's own value.
// Anchoring on run 1 is complete: two runs can only differ from each other if at least
// one of them also differs from the anchor.
function unstablePaths(runs) {
  const byPath = new Map();
  runs.slice(1).forEach((run, offset) => {
    for (const diff of diffExtractions(runs[0], run)) {
      const entry = byPath.get(diff.path)
        ?? { path: diff.path, tier: diff.tier, distance: diff.distance, values: Array(runs.length).fill(clip(diff.from)) };
      entry.values[offset + 1] = clip(diff.to);
      if (diff.distance != null) entry.distance = diff.distance;
      byPath.set(diff.path, entry);
    }
  });
  return [...byPath.values()].sort((a, b) => a.tier - b.tier || a.path.localeCompare(b.path));
}

const listed = (items) => ({ total: items.length, shown: items.slice(0, MAX_LISTED_PATHS) });

const clipDiff = (diff) => ({ path: diff.path, tier: diff.tier, from: clip(diff.from), to: clip(diff.to) });

// Baseline run 1 against variant run 1: a single readable pair, not the cross-product the
// leakage metric averages over. Sampling shows what one swap did, not what it does on average.
function baselineComparison(variant, baselineRun, variantRun) {
  const allowed = allowedPathsFor(variant);
  const diffs = diffExtractions(baselineRun, variantRun);
  return {
    leaked: listed(diffs.filter((d) => !allowed(d.path)).map(clipDiff)),
    allowed: listed(diffs.filter((d) => allowed(d.path)).map(clipDiff)),
    honeypot: leakage(baselineRun, variantRun, variant).honeypot.map(clipDiff)
  };
}

function sampleCell({ model, arm, temperature, variant, records, resumeText, baselineRun }) {
  const runs = records.map((r) => r.response);
  return {
    model,
    arm,
    temperature,
    variant,
    // Every run in full: the page diffs any two of them against each other, and a
    // reconstructed diff would not be the raw response the model actually returned.
    runs: records.map((r) => ({ run: r.run, response: r.response })),
    path_count: pathCount(runs[0]),
    unstable: listed(runs.length > 1 ? unstablePaths(runs) : []),
    vs_baseline: variant === BASELINE || !baselineRun ? null : baselineComparison(variant, baselineRun, runs[0]),
    ungrounded_spans: records.map((record) => ({
      run: record.run,
      spans: collectSpans(record.response).filter((span) => !spanIsGrounded(span, resumeText)).map(clip)
    }))
  };
}

async function writeCells(records, variantTexts) {
  const dir = path.join(OUT_DIR, CELLS_DIR);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const byArm = groupBy(records, (r) => `${r.model}__${r.arm}`);
  let written = 0;
  for (const [key, armRecords] of byArm) {
    const [model, arm] = key.split('__');
    const byVariant = groupBy(armRecords, (r) => r.variant);
    const ordered = (variantRecords) => [...variantRecords].sort((a, b) => a.run - b.run);
    const baselineRun = byVariant.has(BASELINE) ? ordered(byVariant.get(BASELINE))[0].response : null;

    for (const [variant, variantRecords] of byVariant) {
      const resumeText = variantTexts.get(variant);
      if (!resumeText) continue;
      const cell = sampleCell({
        model,
        arm,
        temperature: variantRecords[0]?.temperature ?? null,
        variant,
        records: ordered(variantRecords),
        resumeText,
        baselineRun
      });
      await fs.writeFile(path.join(dir, `${variant}__${model}__${arm}.json`), JSON.stringify(cell));
      written++;
    }
  }
  return written;
}

const fmt = (x, d = 3) => (x == null ? '   –  ' : Number(x).toFixed(d).padStart(6));

function printReport(summary) {
  console.log(`\n${summary.n_records} records | ${summary.models.length} models | arms: ${summary.arms.join(', ')}\n`);
  console.log('model                arm       cells  agree  tier1  tier2  ordDrift offVoc  entErr  covrge  ground  attrRec  netLeak  nLeak');
  for (const row of summary.by_model_arm) {
    const p = row.pooled;
    console.log([
      row.model.padEnd(20),
      row.arm.padEnd(9),
      String(p.cells).padStart(5),
      fmt(p.agreement),
      fmt(p.agreement_tier1),
      fmt(p.agreement_tier2),
      fmt(p.ordinal_drift),
      fmt(p.off_vocab_rate),
      fmt(p.entry_count_error),
      fmt(p.field_coverage),
      fmt(p.groundedness),
      fmt(p.attribution_recall),
      fmt(row.leakage.mean_net),
      String(row.leakage.measured).padStart(4)
    ].join(' '));
    if (row.leakage.controls_failed.length) {
      console.log(`  ! positive control failed: ${row.leakage.controls_failed.join(', ')}`);
    }
  }
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const num = (x, d = 3) => (x == null ? '–' : Number(x).toFixed(d));

// The verdict is written from the data rather than asserted, so a partial grid produces a
// hedged sentence instead of a confident wrong one.
function verdictText(summary) {
  const scored = summary.by_model_arm.filter((r) => r.pooled.agreement != null);
  if (!scored.length) return 'Not enough complete cells yet to say anything. Collection is still running.';

  const deterministic = scored.filter((r) => r.arm === 'temp0');
  const perfect = deterministic.filter((r) => r.pooled.agreement === 1);
  const best = scored.reduce((a, b) => (b.pooled.agreement > a.pooled.agreement ? b : a));
  const worst = scored.reduce((a, b) => (b.pooled.agreement < a.pooled.agreement ? b : a));

  const zeroTemp = deterministic.length
    ? `At temperature 0, where the parse should be reproducible by construction, agreement runs from ${num(Math.min(...deterministic.map((r) => r.pooled.agreement)))} to ${num(Math.max(...deterministic.map((r) => r.pooled.agreement)))}, and ${perfect.length} of ${deterministic.length} model arms reach a clean 1.000.`
    : 'No temperature-0 arm has completed yet.';

  return `Extraction is steadier than scoring, but it is not still. Agreement across repeat runs of an identical résumé ranges from ${num(worst.pooled.agreement)} (${esc(worst.model)}) to ${num(best.pooled.agreement)} (${esc(best.model)}). ${zeroTemp} Every field that changes between two readings of the same document is a field that anything built on top would have read differently the second time.`;
}

function prerenderSummary(summary) {
  const rows = summary.by_model_arm.map((row) => {
    const p = row.pooled;
    return `<tr><td>${esc(row.model)}</td><td>${esc(row.arm)}</td><td class="num">${p.cells}</td>`
      + `<td class="num">${num(p.agreement)}</td><td class="num">${num(p.agreement_tier1)}</td>`
      + `<td class="num">${num(p.agreement_tier2)}</td><td class="num">${num(p.ordinal_drift, 2)}</td>`
      + `<td class="num">${num(p.groundedness)}</td><td class="num">${num(row.leakage.mean_net, 2)}</td></tr>`;
  }).join('\n');

  return `<div class="panel">
  <div class="panel-head"><span>CAN YOU PARSE WITH THE MODEL AND SCORE WITH CODE?</span></div>
  <p><strong>The assumption under test.</strong> That the instability and bias in the first three experiments come from asking a model to <em>judge</em>. Use it only to <em>parse</em> the résumé into structured fields, score those fields in deterministic code, and the problem should disappear by construction. The reasoning-to-score link the transplant proved is severed, because there is no longer a score for reasoning to reach.</p>
</div>
<div class="panel">
  <div class="panel-head"><span>HOW WE TEST IT</span></div>
  <p class="dim">One parser prompt, no job description, run repeatedly over every résumé variant. The model is asked for structure and closed-vocabulary labels only. Every rank, total and presence check is done in code.</p>
  <ol class="steps">
    <li><span class="act">Ask the model to copy the résumé into a fixed set of fields. No score, no opinion of the candidate.</span>
        <span class="eg">Each job becomes an entry with an employer, dates, a seniority label from a fixed list, and a quote from the document proving the entry is real. The model never sees the job description, so it cannot judge relevance to anything.</span></li>
    <li><span class="act">Parse the identical document five times over.</span>
        <span class="eg">Nothing has changed between those runs, so any field that comes back different changed for no reason. That gives us the noise floor.</span></li>
    <li><span class="act">Parse each variant résumé, then compare it against the baseline parse.</span>
        <span class="eg">Swap the name to Aisha Okonkwo. The name field is allowed to change. If the job titles or the technologies change too, that is leakage.</span></li>
    <li><span class="act">Only count a change as leakage if it is bigger than the noise floor from step 2.</span>
        <span class="eg">If two runs of the same document already disagree on three fields, then three fields of difference after a name swap proves nothing.</span></li>
    <li><span class="act">Check the parse against the document itself, where a right answer exists.</span>
        <span class="eg">The résumé has 15 jobs, so a parse returning 13 is wrong. If the text says Kubernetes and the parse does not, that is a miss. If a quote is not in the document, the model invented it.</span></li>
    <li><span class="act">Read it. A parse that holds still can be scored by code. A parse that wobbles cannot.</span>
        <span class="eg">If the same document parses differently twice, the instability was never in the scoring step, and moving the scoring into code fixes nothing.</span></li>
  </ol>
</div>
<div class="panel">
  <div class="panel-head"><span>RESULTS BY MODEL AND ARM</span></div>
  <p class="dim">Agreement is the share of extracted field paths matching across repeat runs of an identical résumé, so 1.000 means the parse never moved. Tier 1 is transcribed and classified fact, tier 2 is the judgement fields. Ordinal drift is the mean rank distance on ordered labels such as seniority. Net leakage is how far a demographic swap moved fields it had no business touching, after subtracting what repeat runs move anyway.</p>
  <table class="data"><thead><tr><th>model</th><th>arm</th><th class="num">cells</th><th class="num">agreement</th><th class="num">tier 1</th><th class="num">tier 2</th><th class="num">ordinal drift</th><th class="num">grounded</th><th class="num">net leakage</th></tr></thead><tbody>
${rows}
  </tbody></table>
  <p><strong>What the results say about the assumption.</strong> ${verdictText(summary)}</p>
  <p class="dim">Collected over ${summary.n_records} parses across ${summary.models.length} model${summary.models.length === 1 ? '' : 's'} and ${summary.variants.length} résumé variant${summary.variants.length === 1 ? '' : 's'}.</p>
</div>`;
}

async function prerenderHtml(summaryHtml) {
  const file = 'site/extraction.html';
  let html;
  try { html = await fs.readFile(file, 'utf8'); } catch { return; }
  const re = /(<!-- @PRERENDER:extraction:START -->)[\s\S]*?(<!-- @PRERENDER:extraction:END -->)/g;
  const next = html.replace(re, (_, a, b) => `${a}\n${summaryHtml}\n${b}`);
  if (next !== html) { await fs.writeFile(file, next); console.log('  prerendered extraction.html'); }
}

async function main() {
  const records = await loadRecords();
  if (!records.length) {
    console.error(`No records in ${IN_DIR}. Run \`npm run run:extraction\` first.`);
    process.exit(1);
  }
  const variantTexts = await loadVariants();
  const summary = buildSummary(records, variantTexts);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  const cells = await writeCells(records, variantTexts);
  await prerenderHtml(prerenderSummary(summary));
  printReport(summary);
  console.log(`\nwrote ${OUT_DIR}/summary.json and ${cells} sample cells`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
