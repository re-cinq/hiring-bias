import fs from 'node:fs/promises';
import path from 'node:path';
import { mean, stdev, pearson, groupBy } from '../src/aggregate.js';
import { STRATEGIES, getStrategy } from '../src/promptStrategies.js';
import { keyFactorSignal, justificationSentiment, modalRecommend, recommendUnanimous } from '../src/coherenceMetrics.js';

const IN_DIR = 'results-prompt-lab';
const OUT_DIR = 'site/data/prompt-lab';
const BASELINE_RESUME = 'baseline';

async function loadAll() {
  const records = [];
  let strategyDirs = [];
  try { strategyDirs = await fs.readdir(IN_DIR); } catch { return records; }
  for (const strategy of strategyDirs) {
    const dir = path.join(IN_DIR, strategy);
    let files = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      records.push(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')));
    }
  }
  return records;
}

async function writeJson(relpath, data) {
  const full = path.join(OUT_DIR, relpath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(data, null, 2));
}

const scoreOf = (r) => r?.response?.score;
const scoresOf = (records) => records.map(scoreOf).filter((s) => typeof s === 'number');
const yesRate = (records) => {
  const n = records.length;
  return n ? records.filter((r) => r.response?.recommend_interview === 'yes').length / n : null;
};

// Pooled within-cell stdev: sqrt(Σ(n_c-1)s_c² / Σ(n_c-1)). Cells with <2 scored runs
// contribute nothing.
function pooledStdev(cells) {
  let num = 0, den = 0;
  for (const scores of cells) {
    if (scores.length < 2) continue;
    const s = stdev(scores);
    if (s == null) continue;
    num += (scores.length - 1) * s * s;
    den += scores.length - 1;
  }
  return den > 0 ? Math.sqrt(num / den) : null;
}

// The four metrics for one slice of records (already filtered to a strategy, and
// optionally to a single model). cellKey groups runs of the same prompt input.
function metricsFor(records) {
  const byCell = groupBy(records, (r) => `${r.variant}__${r.model}__${r.jd}`);
  const cellScoreSets = [...byCell.values()].map(scoresOf);

  // Stability.
  const stability = pooledStdev(cellScoreSets);

  // Coherence: score vs the model's own stated drivers.
  const scoreArr = [], signalArr = [], sentScoreArr = [], sentArr = [];
  for (const r of records) {
    const sc = scoreOf(r);
    if (typeof sc !== 'number') continue;
    scoreArr.push(sc); signalArr.push(keyFactorSignal(r.response));
    sentScoreArr.push(sc); sentArr.push(justificationSentiment(r.response?.justification));
  }
  const coherence = pearson(scoreArr, signalArr);
  const coherence_sentiment = pearson(sentScoreArr, sentArr);

  // Decision-flip (instability): cells whose runs are not unanimous on the recommendation.
  const cells = [...byCell.values()];
  const flippy = cells.filter((c) => !recommendUnanimous(c)).length;
  const flip_instability = cells.length ? flippy / cells.length : null;

  // Bias: |Δ score| and recommendation flips vs the baseline résumé, within model × JD.
  const byModelJd = groupBy(records, (r) => `${r.model}__${r.jd}`);
  const absDeltas = [];
  let biasFlipNum = 0, biasFlipDen = 0;
  for (const group of byModelJd.values()) {
    const byResume = groupBy(group, (r) => r.variant);
    const baseRecs = byResume.get(BASELINE_RESUME);
    if (!baseRecs) continue;
    const baseMean = mean(scoresOf(baseRecs));
    const baseRec = modalRecommend(baseRecs);
    for (const [resume, recs] of byResume) {
      if (resume === BASELINE_RESUME) continue;
      const m = mean(scoresOf(recs));
      if (baseMean != null && m != null) absDeltas.push(Math.abs(m - baseMean));
      const rec = modalRecommend(recs);
      if (baseRec != null && rec != null) { biasFlipDen++; if (rec !== baseRec) biasFlipNum++; }
    }
  }
  const bias_abs_delta = absDeltas.length ? mean(absDeltas) : null;
  const flip_bias = biasFlipDen ? biasFlipNum / biasFlipDen : null;

  return { stability, coherence, coherence_sentiment, bias_abs_delta, flip_instability, flip_bias, n_records: records.length };
}

function buildSummary(records, models) {
  const byStrategy = groupBy(records, (r) => r.strategy);
  const baselinePooled = byStrategy.has('baseline') ? metricsFor(byStrategy.get('baseline')) : null;

  const by_strategy = STRATEGIES.filter((s) => byStrategy.has(s.id)).map((s) => {
    const recs = byStrategy.get(s.id);
    const pooled = metricsFor(recs);
    const by_model = {};
    for (const model of models) {
      const mr = recs.filter((r) => r.model === model);
      if (mr.length) by_model[model] = metricsFor(mr);
    }
    const vs_baseline = baselinePooled && s.id !== 'baseline'
      ? {
          stability: diff(pooled.stability, baselinePooled.stability),
          coherence: diff(pooled.coherence, baselinePooled.coherence),
          bias_abs_delta: diff(pooled.bias_abs_delta, baselinePooled.bias_abs_delta),
          flip_instability: diff(pooled.flip_instability, baselinePooled.flip_instability),
          flip_bias: diff(pooled.flip_bias, baselinePooled.flip_bias)
        }
      : null;
    return { strategy: s.id, label: s.label, pooled, by_model, vs_baseline };
  });

  const resumes = [...new Set(records.map((r) => r.variant))].sort();
  const jds = [...new Set(records.map((r) => r.jd))].sort();
  return { generated_at: new Date().toISOString(), models, resumes, jds, strategies: by_strategy.map((s) => s.strategy), by_strategy };
}

const diff = (a, b) => (a != null && b != null) ? a - b : null;

// Per-cell files (résumé × model × JD), all strategies bundled together so the
// comparator page can switch Strategy A/B without another fetch. Shape mirrors
// data/diffs/*.json enough for verdict-card.js (runs[].response, scores, mean, recommend_rate).
function buildCells(records) {
  const cells = new Map();
  const byCell = groupBy(records, (r) => `${r.variant}__${r.model}__${r.jd}`);
  for (const [key, recs] of byCell) {
    const [variant, model, jd] = key.split('__');
    const byStrategy = groupBy(recs, (r) => r.strategy);
    const strategies = {};
    for (const [sid, srecs] of byStrategy) {
      const sorted = [...srecs].sort((a, b) => a.run - b.run);
      const scores = scoresOf(sorted);
      strategies[sid] = {
        runs: sorted.map((r) => ({ run: r.run, response: r.response })),
        scores,
        mean: mean(scores),
        recommend_rate: yesRate(sorted)
      };
    }
    cells.set(key, { variant, model, jd, strategies });
  }
  return cells;
}

function buildStrategiesDoc(records) {
  const byStrategy = groupBy(records, (r) => r.strategy);
  return STRATEGIES.map((s) => {
    const sample = byStrategy.get(s.id)?.[0]?.response ?? null;
    return { id: s.id, label: s.label, description: s.description, template: s.template, sample_output: sample };
  });
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (x, d = 2) => (x == null ? '–' : Number(x).toFixed(d));

// Which strategy wins each metric on the pooled numbers (lower better, except coherence).
function prerenderSummary(summary) {
  const rows = summary.by_strategy;
  const winner = (metric, lowerBetter) => {
    let best = null;
    for (const r of rows) {
      const v = r.pooled[metric];
      if (v == null) continue;
      if (best == null || (lowerBetter ? v < best.v : v > best.v)) best = { id: r.strategy, label: r.label, v };
    }
    return best;
  };
  const METRICS = [
    ['Stability (within-run score stdev — lower better)', 'stability', true],
    ['Score–feedback coherence (higher better)', 'coherence', false],
    ['Bias |Δ score| vs baseline résumé (lower better)', 'bias_abs_delta', true],
    ['Decision instability (recommend flips — lower better)', 'flip_instability', true],
    ['Decision bias flips (lower better)', 'flip_bias', true]
  ];
  const lines = METRICS.map(([title, key, low]) => {
    const w = winner(key, low);
    return `<tr><td>${esc(title)}</td><td><strong>${w ? esc(w.label) : '–'}</strong></td><td class="num">${w ? fmt(w.v) : '–'}</td></tr>`;
  }).join('\n');
  return `<div class="panel">
  <div class="panel-head"><span>BEST PROMPT PER METRIC (pooled across models)</span></div>
  <p class="dim">Aggregated over ${esc(summary.models.length)} models. Lower is better for stability, bias and flip rates; higher is better for coherence. Use the comparator below to inspect any pair head-to-head and see how each model reacts.</p>
  <table class="data"><thead><tr><th>Metric</th><th>Best strategy</th><th class="num">Value</th></tr></thead><tbody>
${lines}
  </tbody></table>
</div>`;
}

async function prerenderHtml(summaryHtml) {
  const file = 'site/prompt-lab.html';
  let html;
  try { html = await fs.readFile(file, 'utf8'); } catch { return; }
  const re = /(<!-- @PRERENDER:prompt-lab:START -->)[\s\S]*?(<!-- @PRERENDER:prompt-lab:END -->)/g;
  const next = html.replace(re, (_, a, b) => `${a}\n${summaryHtml}\n${b}`);
  if (next !== html) { await fs.writeFile(file, next); console.log('  prerendered prompt-lab.html'); }
}

async function main() {
  const records = await loadAll();
  if (!records.length) {
    console.error(`No records in ${IN_DIR}. Run \`npm run run:prompt-lab\` first.`);
    process.exit(1);
  }
  const models = [...new Set(records.map((r) => r.model))].sort();
  // Touch getStrategy so an unknown strategy id in the data fails loudly.
  for (const id of new Set(records.map((r) => r.strategy))) getStrategy(id);

  const summary = buildSummary(records, models);
  await writeJson('summary.json', summary);

  const cells = buildCells(records);
  for (const [key, cell] of cells) await writeJson(path.join('cells', `${key}.json`), cell);

  await writeJson('strategies.json', buildStrategiesDoc(records));
  await prerenderHtml(prerenderSummary(summary));

  console.log(`Prompt Lab built: ${records.length} records, ${summary.by_strategy.length} strategies, ${models.length} models, ${cells.size} cells.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
