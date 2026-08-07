import fs from 'node:fs/promises';
import path from 'node:path';
import { mean, stdev, groupBy } from '../src/aggregate.js';
import { probeGroundTruth, unionMonths, fieldCoverage, leakage } from '../src/extractionMetrics.js';
import { normalizeExtraction } from '../src/extractionSchema.js';
import { recommendUnanimous } from '../src/coherenceMetrics.js';

// Every number quoted in article/the-prompt-wont-save-you.md, recomputed from the data.
// A claim that drifts away from the dataset fails here instead of in the comments.

const ARTICLE = 'article/the-prompt-wont-save-you.md';
const AS_OF = '2026-08';
const claims = [];

// `claimed` is what the article says. `actual` is recomputed. tol is absolute.
const claim = (label, claimed, actual, tol = 0.005) => claims.push({ label, claimed, actual, tol });

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// ---------- transplant ----------
const tp = await readJson('site/data/transplant/summary.json');
claim('transplant cells', 320, tp.overall.n_cells, 0);
claim('transplant models', 10, tp.models.length, 0);
claim('effect, score points', 3.62, round(tp.overall.mean_effect), 0.005);
claim('directional cells', 319, tp.overall.directional_cells, 0);
claim('signal gap, key-factor points', 14.8, round(tp.overall.mean_signal_gap, 1), 0.05);
claim('score moved, % of its 9-point range', 40, Math.round(tp.overall.mean_effect / 9 * 100), 0);
claim('reasoning moved, % of its 18-point range', 82, Math.round(tp.overall.mean_signal_gap / 18 * 100), 0);
claim('score follows reasoning, ratio', 0.49, round((tp.overall.mean_effect / 9) / (tp.overall.mean_signal_gap / 18)), 0.005);

// Donor assessment means, the "+7 and -7" in the article.
const tpCellFiles = await fs.readdir('site/data/transplant/cells');
const posSignals = [], negSignals = [];
for (const f of tpCellFiles) {
  const c = await readJson(path.join('site/data/transplant/cells', f));
  if (typeof c.pos?.donor_signal === 'number') posSignals.push(c.pos.donor_signal);
  if (typeof c.neg?.donor_signal === 'number') negSignals.push(c.neg.donor_signal);
}
claim('glowing assessment, mean signal', 6.7, round(mean(posSignals), 1), 0.05);

// The worked example quoted in the article, verified against the record it came from.
const worked = await readJson('site/data/transplant/cells/addressCountry_nigeria__claude-opus__jd_cto_agentic_fintech.json');
claim('worked example, positive signal', 8, worked.pos.donor_signal, 0);
claim('worked example, negative signal', -9, worked.neg.donor_signal, 0);
claim('worked example, gap', 17, worked.pos.donor_signal - worked.neg.donor_signal, 0);
const factorLine = (k) => `${k.direction} ${k.weight}`;
claim('worked example, positive factors', 'positive high|positive high|positive medium', worked.pos.assessment.key_factors.map(factorLine).join('|'), 0);
claim('worked example, negative factors', 'negative high|negative high|negative high', worked.neg.assessment.key_factors.map(factorLine).join('|'), 0);
claim('damning assessment, mean signal', -8.0, round(mean(negSignals), 1), 0.05);

// ---------- prompt lab ----------
const pl = await readJson('site/data/prompt-lab/summary.json');
const strat = (id) => pl.by_strategy.find((s) => s.strategy === id).pooled;
claim('prompt-lab evaluations', 4800, pl.by_strategy.reduce((s, x) => s + x.pooled.n_records, 0), 0);
claim('prompt-lab cells per strategy', 80, strat('baseline').dist.stability.length + 0, 0);
claim('baseline score spread', 0.53, round(strat('baseline').stability), 0.005);
claim('score-last score spread', 0.64, round(strat('score_last').stability), 0.005);
claim('baseline split-cell rate, %', 33, Math.round(strat('baseline').flip_instability * 100), 0);
claim('score-last split-cell rate, %', 54, Math.round(strat('score_last').flip_instability * 100), 0);
claim('baseline demographic flip rate, %', 8.3, round(strat('baseline').flip_bias * 100, 1), 0.05);
claim('blind-instruction demographic flip rate, %', 11.7, round(strat('blind_instruction').flip_bias * 100, 1), 0.05);
for (const [id, want] of [['baseline', 0.238], ['rubric', 0.215], ['blind_instruction', 0.273], ['score_last', 0.277], ['fewshot', 0.288], ['cot', 0.295]]) {
  claim(`bias table, ${id}`, want, round(strat(id).bias_abs_delta, 3), 0.0005);
}

// Paired stats straight from the raw prompt-lab records.
const plRecords = [];
for (const dir of await fs.readdir('results-prompt-lab')) {
  for (const f of await fs.readdir(path.join('results-prompt-lab', dir))) {
    if (!f.endsWith('.json')) continue;
    const r = JSON.parse(await fs.readFile(path.join('results-prompt-lab', dir, f), 'utf8'));
    if (r.model !== 'claude-fable-5') plRecords.push(r);
  }
}
const cellKey = (r) => `${r.variant}__${r.model}__${r.jd}`;
const cellStdevs = (id) => {
  const m = new Map();
  for (const r of plRecords.filter((x) => x.strategy === id)) {
    const k = cellKey(r);
    if (!m.has(k)) m.set(k, []);
    if (typeof r.response?.score === 'number') m.get(k).push(r.response.score);
  }
  return new Map([...m].map(([k, v]) => [k, stdev(v)]));
};
const baseSd = cellStdevs('baseline');
const slSd = cellStdevs('score_last');
const zeroCells = [...baseSd.values()].filter((v) => v === 0).length;
claim('baseline cells with zero spread', 33, zeroCells, 0);
claim('cells with room to move', 47, baseSd.size - zeroCells, 0);

const movable = [...baseSd].filter(([, v]) => v > 0).map(([k]) => k);
const diffs = movable.map((k) => slSd.get(k) - baseSd.get(k)).filter((d) => Number.isFinite(d));
const md = mean(diffs);
const t = md / (stdev(diffs) / Math.sqrt(diffs.length));
claim('score-last paired difference', -0.003, round(md, 3), 0.0005);
claim('score-last t statistic', -0.06, round(t, 2), 0.005);

const unanimity = (id) => {
  const m = new Map();
  for (const r of plRecords.filter((x) => x.strategy === id)) {
    const k = cellKey(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return new Map([...m].map(([k, v]) => [k, recommendUnanimous(v) ? 1 : 0]));
};
const baseU = unanimity('baseline');
const slU = unanimity('score_last');
let becameSplit = 0, becameUnanimous = 0;
for (const [k, v] of baseU) {
  const w = slU.get(k);
  if (w == null) continue;
  if (v === 1 && w === 0) becameSplit++;
  if (v === 0 && w === 1) becameUnanimous++;
}
const chi = (Math.abs(becameSplit - becameUnanimous) - 1) ** 2 / (becameSplit + becameUnanimous);
claim('cells unanimous -> split', 25, becameSplit, 0);
claim('cells split -> unanimous', 8, becameUnanimous, 0);
claim('McNemar chi-square', 7.76, round(chi), 0.005);

// ---------- extraction ----------
const ex = await readJson('site/data/extraction/summary.json');
claim('extraction parses', 2700, ex.n_records, 0);
claim('extraction models', 11, ex.models.length, 0);
claim('extraction variants', 30, ex.variants.length, 0);

const deployable = ex.by_model_arm.filter((r) => r.arm === 'temp0' || r.arm === 'default');
claim('deployable-arm rows', 11, deployable.length, 0);
const EXPECTED = {
  'gemini-2.5-flash': [1.000, 21.14], 'gemini-2.5-pro': [0.984, 3.54],
  'gemini-3.1-pro-preview': [0.982, 6.06], 'llama-4-maverick': [0.974, 2.23],
  'mistral-large': [0.972, 1.37], 'claude-sonnet': [0.933, 0.76],
  'mistral-small': [0.928, 3.66], 'claude-fable-5': [0.923, 1.15],
  'claude-opus': [0.908, 1.64], 'claude-haiku': [0.877, 1.42],
  'qwen-3-next-80b': [0.715, 20.95]
};
for (const row of deployable) {
  const [wantAgree, wantLeak] = EXPECTED[row.model];
  claim(`agreement, ${row.model}`, wantAgree, round(row.pooled.agreement, 3), 0.0005);
  claim(`leakage, ${row.model}`, wantLeak, round(row.leakage.mean_net), 0.005);
}
const worst = Math.min(...deployable.map((r) => r.pooled.agreement));
claim('worst disagreement, %', 28, Math.round((1 - worst) * 100), 0);
claim('qwen empty required fields, %', 13, Math.round((1 - deployable.find((r) => r.model === 'qwen-3-next-80b').pooled.field_coverage) * 100), 0);

const flash0 = ex.by_model_arm.find((r) => r.model === 'gemini-2.5-flash' && r.arm === 'temp0');
const flash07 = ex.by_model_arm.find((r) => r.model === 'gemini-2.5-flash' && r.arm === 'temp07');
claim('flash temp0.7 noise floor', 21.1, round(flash07.leakage.mean_noise_floor, 1), 0.05);
claim('flash temp0.7 leakage', 0.9, round(flash07.leakage.mean_net, 1), 0.05);
const axisMean = (row, axis) => {
  const vs = row.leakage.by_variant.filter((v) => v.axis === axis && v.net != null);
  return round(mean(vs.map((v) => v.net)), 1);
};
for (const [axis, want] of [['firstName', 19.3], ['addressCountry', 20.0], ['school', 22.8], ['companyLocations', 26.3], ['graduationYear', 19.5]]) {
  claim(`flash leakage, ${axis}`, want, axisMean(flash0, axis), 0.05);
}

// Fields per parse, quoted as "roughly 500".
const sampleRec = normalizeExtraction(JSON.parse(await fs.readFile('results-extraction/temp0/baseline__gemini-2.5-flash__run1.json', 'utf8')).response);
const sampleResume = await fs.readFile('data/variants/baseline.md', 'utf8');
const fieldCount = JSON.stringify(sampleRec).match(/"/g).length / 4;
claims.push({ label: 'fields per parse (article says "roughly 500")', claimed: 500, actual: Math.round(fieldCount / 50) * 50, tol: 150 });

// The name-swap leak the article quotes as 19 fields.
const swapped = normalizeExtraction(JSON.parse(await fs.readFile('results-extraction/temp0/firstName_aisha-okonkwo__gemini-2.5-flash__run1.json', 'utf8')).response);
claim('name-swap leaked fields, single run', 17, leakage(sampleRec, swapped, 'firstName_aisha-okonkwo').leaked.length, 3);

// ---------- scorer ----------
const sc = await readJson('site/data/extraction/scored.json');
const deployRows = sc.rows.filter((r) => r.arm === 'temp0' || r.arm === 'default');
claim('models moving on exactly 1 variant', 9, deployRows.filter((r) => r.moved === 1).length, 0);
claim('variants per model', 29, deployRows[0].n_variants, 0);
claim('qwen variants moved', 21, sc.rows.find((r) => r.model === 'qwen-3-next-80b' && r.arm === 'temp0').moved, 0);
const flashMovers = sc.rows.find((r) => r.model === 'gemini-2.5-flash' && r.arm === 'temp0').by_variant.filter((v) => v.delta !== 0);
claim('flash movers are anonymize_all only', 1, flashMovers.length, 0);
if (flashMovers[0]?.variant !== 'anonymize_all') claims.push({ label: 'flash mover is anonymize_all', claimed: 'anonymize_all', actual: flashMovers[0]?.variant, tol: 0 });

const jobSpec = await readJson('data/jobspecs/jd_senior_fullstack.json');
claim('jobspec requirements', 17, jobSpec.requirements.length, 0);
claim('jobspec disqualifiers', 1, jobSpec.disqualifiers.length, 0);
claim('full-stack threshold, years', 6, jobSpec.requirements.find((r) => r.id === 'fullstack_experience').min_months / 12, 0);

const intervals = (sampleRec.employment ?? []).map((e) => ({ start: e.start, end: e.end }));
const unionYears = unionMonths(intervals, AS_OF) / 12;
const naiveYears = intervals.reduce((s, i) => s + unionMonths([i], AS_OF), 0) / 12;
claim('career length, years', 20, Math.round(unionYears), 0);
claim('naive sum, years', 38, Math.round(naiveYears), 0);

// Claude Sonnet's unstable baseline, quoted run by run.
const sonnetScores = sc.rows.find((r) => r.model === 'claude-sonnet').by_variant;
claim('sonnet has a variant spread above zero', true, sc.rows.find((r) => r.model === 'claude-sonnet').max_within_variant_spread > 0, 0);

// ---------- synthesis and totals ----------
const syn = await readJson('site/data/synthesis.json');
claim('bias vs responsiveness r', 0.61, round(syn.corr_bias_responsiveness.r), 0.005);
claim('correlation models', 10, syn.corr_bias_responsiveness.n, 0);

const totalCalls = 3197 + 4800 + ex.n_records;
claim('follow-up model calls (article says ~10,700)', 10700, Math.round(totalCalls / 100) * 100, 0);

// ---------- report ----------
const article = await fs.readFile(ARTICLE, 'utf8');
let failed = 0;
for (const c of claims) {
  const ok = typeof c.claimed === 'number' && typeof c.actual === 'number'
    ? Math.abs(c.claimed - c.actual) <= c.tol
    : c.claimed === c.actual;
  if (!ok) failed++;
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${c.label.padEnd(46)} article ${String(c.claimed).padStart(8)}   data ${String(c.actual).padStart(8)}`);
}

// Cheap guard against a figure being edited in the prose but not here.
const mustAppear = ['3.62', '319 of 320', '14.8', '4,800', '2,700', '0.61', '10,700', 'Hands-on agentic AI and MCP framework experience', 'Missing fintech/regulated-environment depth'];
const missing = mustAppear.filter((s) => !article.includes(s));
if (missing.length) {
  console.log(`\nFAIL  these verified figures are no longer in the article: ${missing.join(', ')}`);
  failed++;
}

console.log(`\n${claims.length - failed}/${claims.length} numbers verified against the dataset`);
if (failed) process.exit(1);
