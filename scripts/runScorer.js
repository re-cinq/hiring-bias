import fs from 'node:fs/promises';
import path from 'node:path';
import { score } from '../src/scorer.js';
import { probeGroundTruth } from '../src/extractionMetrics.js';
import { normalizeExtraction } from '../src/extractionSchema.js';
import { mean, stdev, groupBy } from '../src/aggregate.js';

// Scores every collected extraction with the deterministic scorer and asks the question the
// whole architecture rests on: once a human-written function computes the number, does
// changing a demographic line still move it?

const IN_DIR = 'results-extraction';
const VARIANTS_DIR = 'data/variants';
const SPEC = 'data/jobspecs/jd_senior_fullstack.json';
const OUT = 'site/data/extraction/scored.json';
const AS_OF = '2026-08';
const BASELINE = 'baseline';

const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

async function main() {
  const jobSpec = JSON.parse(await fs.readFile(SPEC, 'utf8'));

  const probesByVariant = new Map();
  for (const file of await fs.readdir(VARIANTS_DIR)) {
    if (!file.endsWith('.md')) continue;
    const name = path.basename(file, '.md');
    probesByVariant.set(name, probeGroundTruth(await fs.readFile(path.join(VARIANTS_DIR, file), 'utf8')));
  }

  const scored = [];
  for (const arm of await fs.readdir(IN_DIR)) {
    for (const file of await fs.readdir(path.join(IN_DIR, arm))) {
      if (!file.endsWith('.json')) continue;
      const record = JSON.parse(await fs.readFile(path.join(IN_DIR, arm, file), 'utf8'));
      const extraction = normalizeExtraction(record.response);
      const probes = probesByVariant.get(record.variant);
      if (!probes) continue;
      const result = score({ extraction, probes }, jobSpec, AS_OF);
      scored.push({ model: record.model, arm: record.arm, variant: record.variant, run: record.run, score: result.score });
    }
  }

  const rows = [];
  for (const [key, records] of groupBy(scored, (r) => `${r.model}__${r.arm}`)) {
    const [model, arm] = key.split('__');
    const byVariant = groupBy(records, (r) => r.variant);
    const baseScores = (byVariant.get(BASELINE) ?? []).map((r) => r.score);
    if (!baseScores.length) continue;
    const baseMean = mean(baseScores);

    const deltas = [];
    let withinSpread = 0;
    for (const [variant, recs] of byVariant) {
      const scores = recs.map((r) => r.score);
      withinSpread = Math.max(withinSpread, (stdev(scores) ?? 0));
      if (variant === BASELINE) continue;
      deltas.push({ variant, delta: round(mean(scores) - baseMean), spread: round(stdev(scores) ?? 0) });
    }
    rows.push({
      model,
      arm,
      baseline_score: round(baseMean),
      max_within_variant_spread: round(withinSpread),
      mean_abs_delta: round(mean(deltas.map((d) => Math.abs(d.delta)))),
      max_abs_delta: round(Math.max(...deltas.map((d) => Math.abs(d.delta)))),
      moved: deltas.filter((d) => d.delta !== 0).length,
      n_variants: deltas.length,
      by_variant: deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    });
  }

  rows.sort((a, b) => (b.mean_abs_delta ?? 0) - (a.mean_abs_delta ?? 0));
  await fs.writeFile(OUT, JSON.stringify({ generated_at: new Date().toISOString(), job: jobSpec.id, as_of: AS_OF, rows }, null, 2));

  console.log(`Scored ${scored.length} extractions against ${jobSpec.id} v${jobSpec.version}\n`);
  console.log('model                arm      baseline  run-spread  mean|Δ|  max|Δ|  moved');
  for (const r of rows) {
    console.log([
      r.model.padEnd(22), r.arm.padEnd(8),
      String(r.baseline_score).padStart(8),
      String(r.max_within_variant_spread).padStart(11),
      String(r.mean_abs_delta).padStart(8),
      String(r.max_abs_delta).padStart(7),
      `${r.moved}/${r.n_variants}`.padStart(7)
    ].join(' '));
  }
  console.log(`\nwrote ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
