import fs from 'node:fs/promises';
import path from 'node:path';
import { mean, groupBy } from '../src/aggregate.js';
import {
  agreementRate, ordinalDrift, offVocabRate, entryRecall, expectedEntryCounts,
  groundedness, attributionAccuracy, diffExtractions, allowedPathsFor, positiveControlOk
} from '../src/extractionMetrics.js';

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
      records.push(JSON.parse(await fs.readFile(path.join(IN_DIR, arm, file), 'utf8')));
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
function leakageFor(baselineRuns, variantRuns, variantName) {
  const allowed = allowedPathsFor(variantName);
  const cross = [];
  for (const b of baselineRuns) for (const v of variantRuns) cross.push(leakCount(b, v, allowed));

  const within = [];
  for (let i = 0; i < variantRuns.length; i++) {
    for (let j = i + 1; j < variantRuns.length; j++) within.push(leakCount(variantRuns[i], variantRuns[j], allowed));
  }
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

    const netLeaks = leaks.map((l) => l.net).filter((x) => x != null);
    rows.push({
      model,
      arm,
      temperature: armRecords[0]?.temperature ?? null,
      vendor: armRecords[0]?.vendor ?? null,
      pooled: poolCells(cells),
      leakage: {
        mean_net: meanOrNull(netLeaks),
        mean_observed: meanOrNull(leaks.map((l) => l.observed).filter((x) => x != null)),
        mean_noise_floor: meanOrNull(leaks.map((l) => l.noise_floor).filter((x) => x != null)),
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

const fmt = (x, d = 3) => (x == null ? '   –  ' : Number(x).toFixed(d).padStart(6));

function printReport(summary) {
  console.log(`\n${summary.n_records} records | ${summary.models.length} models | arms: ${summary.arms.join(', ')}\n`);
  console.log('model                arm       cells  agree  tier1  tier2  ordDrift offVoc  entErr  ground  attrRec  netLeak');
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
      fmt(p.groundedness),
      fmt(p.attribution_recall),
      fmt(row.leakage.mean_net)
    ].join(' '));
    if (row.leakage.controls_failed.length) {
      console.log(`  ! positive control failed: ${row.leakage.controls_failed.join(', ')}`);
    }
  }
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
  printReport(summary);
  console.log(`\nwrote ${OUT_DIR}/summary.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
