import fs from 'node:fs/promises';
import path from 'node:path';
import { mean, stdev, pearson, groupBy } from '../src/aggregate.js';
import { STRATEGIES, getStrategy } from '../src/promptStrategies.js';
import { keyFactorSignal, justificationSentiment, modalRecommend, recommendUnanimous } from '../src/coherenceMetrics.js';

const IN_DIR = 'results-prompt-lab';
const OUT_DIR = 'site/data/prompt-lab';
const BASELINE_RESUME = 'baseline';
const EXCLUDED_MODELS = new Set(['claude-fable-5']);

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
      const record = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      if (!EXCLUDED_MODELS.has(record.model)) records.push(record);
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

const round2 = (x) => Math.round(x * 100) / 100;

// The four metrics for one slice of records (already filtered to a strategy, and
// optionally to a single model). cellKey groups runs of the same prompt input.
function metricsFor(records) {
  const byCell = groupBy(records, (r) => `${r.variant}__${r.model}__${r.jd}`);
  const cellScoreSets = [...byCell.values()].map(scoresOf);

  // Stability.
  const stability = pooledStdev(cellScoreSets);
  const stabilityDist = cellScoreSets
    .filter((scores) => scores.length >= 2)
    .map((scores) => stdev(scores))
    .filter((s) => s != null)
    .map(round2);

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

  return {
    stability, coherence, coherence_sentiment, bias_abs_delta, flip_instability, flip_bias,
    // The per-cell values behind the two decomposable aggregates, so the site can draw
    // the distribution dots. Coherence and the flip rates have no meaningful per-cell value.
    dist: { stability: stabilityDist, bias_abs_delta: absDeltas.map(round2) },
    n_records: records.length
  };
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

  const byId = Object.fromEntries(summary.by_strategy.map((s) => [s.strategy, s]));
  const p = (id, k) => byId[id]?.pooled?.[k];
  const baseStab = fmt(p('baseline', 'stability'));
  const baseFlip = fmt(p('baseline', 'flip_instability'));
  const fsStab = fmt(p('fewshot', 'stability'));
  const fsFlip = fmt(p('fewshot', 'flip_instability'));
  const slStab = fmt(p('score_last', 'stability'));
  const slFlip = fmt(p('score_last', 'flip_instability'));

  return `<div class="panel">
  <div class="panel-head"><span>DOES PROMPT ENGINEERING FIX IT?</span></div>
  <p><strong>The assumption under test.</strong> That the instability and bias in LLM résumé screening are mostly a prompt problem, fixable with better prompt engineering. The sharpest version, argued widely, is that the naive prompt asks for the <em>score first</em> and writes everything after it to justify a number already chosen; make the model reason first and decide the score <em>last</em>, and the results should turn markedly more stable, coherent and fair.</p>
</div>
<div class="panel">
  <div class="panel-head"><span>HOW WE TEST IT</span></div>
  <p class="dim">Six prompt strategies, all emitting the identical output schema. Only the technique changes, and every strategy is scored on the same résumés, jobs and models.</p>
  <p class="dim"><strong>Step 1.</strong> Start from the naive production prompt, which asks for the score first and the justification after, and write variations that keep the exact same output fields but change only the technique. For example, <strong>Score last</strong> reorders the fields so the model writes strengths, concerns and justification first and commits to the number last; <strong>Few-shot examples</strong> prepends two worked evaluations to anchor the scale; <strong>Competency rubric</strong> forces one piece of résumé evidence per required competency before scoring.</p>
  <p class="dim"><strong>Step 2.</strong> Run every strategy over the identical set of résumés, jobs and models, several times each, so the only thing that differs between two runs of one cell is the prompt technique and ordinary sampling noise. For example, the baseline résumé for the CTO role is scored five times by each of the ${esc(summary.models.length)} models under every strategy.</p>
  <p class="dim"><strong>Step 3.</strong> From those runs compute the same set of metrics for every strategy: stability (how far the score wobbles across repeat runs of an identical input), coherence (whether the score lines up with the model's own stated key factors), bias (how far the score moves when only a demographic detail on the résumé changes), and decision flips (how often the yes or no call is not unanimous). For example, a cell scoring 7, 4, 6, 5, 8 across five identical runs feeds a high, meaning bad, stability number.</p>
  <p class="dim"><strong>Step 4.</strong> Compare each strategy against the baseline prompt on every metric. For example, Few-shot examples lands a pooled score stdev of ${fsStab} against the baseline's ${baseStab}, while Score last pushes run to run decision flips from ${baseFlip} up to ${slFlip}.</p>
  <p class="dim"><strong>Step 5.</strong> A strategy only counts as a fix if it clearly beats baseline on a metric without hurting the others. A wash, or a win on one metric paid for by a regression on another, means the technique is not buying real reliability. For example, Few-shot examples improves stability and both flip metrics at once, whereas Score last and Chain-of-thought make the score wobble more, not less.</p>
</div>
<div class="panel">
  <div class="panel-head"><span>BEST PROMPT PER METRIC (pooled across models)</span></div>
  <p class="dim">Aggregated over ${esc(summary.models.length)} models. Lower is better for stability, bias and flip rates; higher is better for coherence. Use the comparator below to inspect any pair head-to-head and see how each model reacts.</p>
  <table class="data"><thead><tr><th>Metric</th><th>Best strategy</th><th class="num">Value</th></tr></thead><tbody>
${lines}
  </tbody></table>
  <p><strong>What the results say about the assumption.</strong> It is largely <strong>dismissed</strong>. Prompt wording moves the numbers only a little, and the most-hyped fix backfires: reordering so the model decides the score last (the <strong>Score last</strong> strategy) made repeat-run scoring <em>less</em> stable, not more (score stdev ${slStab} against the baseline's ${baseStab}), and pushed run to run decision flips from ${baseFlip} up to ${slFlip}. The one technique that helps across the board is <strong>Few-shot examples</strong>, and even it only trims score stdev to ${fsStab} and decision flips to ${fsFlip} — a nudge, not a cure. What would have <em>supported</em> the assumption, a strategy that sharply cut both the score wobble and the flips at once, never appeared: the instability this study measures is largely intrinsic to the models, not an artifact the prompt can engineer away.</p>
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
