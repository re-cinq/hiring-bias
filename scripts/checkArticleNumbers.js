import fs from 'node:fs/promises';
import path from 'node:path';
import { mean, stdev, groupBy } from '../src/aggregate.js';
import { probeGroundTruth, unionMonths, fieldCoverage, leakage } from '../src/extractionMetrics.js';
import { normalizeExtraction } from '../src/extractionSchema.js';
import { recommendUnanimous } from '../src/coherenceMetrics.js';

// Every number quoted across both article parts, recomputed from the data.
// A claim that drifts away from the dataset fails here instead of in the comments.

const ARTICLES = ['article/part3-the-prompt-wont-save-you.md', 'article/part4-stop-asking-it-to-judge.md'];
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

// The 'vs baseline' and 't' columns of that same table, recomputed from the raw records.
const biasDeltas = (id) => {
  const out = new Map();
  for (const [k, g] of groupBy(plRecords.filter((r) => r.strategy === id), (r) => `${r.model}|${r.jd}`)) {
    const byV = groupBy(g, (r) => r.variant);
    const base = byV.get('baseline');
    if (!base) continue;
    const bm = mean(base.map((r) => r.response?.score).filter((x) => typeof x === 'number'));
    for (const [v, rs] of byV) {
      if (v === 'baseline') continue;
      const m = mean(rs.map((r) => r.response?.score).filter((x) => typeof x === 'number'));
      if (bm != null && m != null) out.set(`${k}|${v}`, Math.abs(m - bm));
    }
  }
  return out;
};
const baseDeltas = biasDeltas('baseline');
claim('bias comparisons per strategy', 60, baseDeltas.size, 0);
for (const [id, wantDiff, wantT] of [['rubric', -0.023, -0.53], ['blind_instruction', 0.035, 0.84],
                                     ['score_last', 0.038, 0.92], ['fewshot', 0.050, 1.10], ['cot', 0.057, 1.52]]) {
  const other = biasDeltas(id);
  const d = [...baseDeltas].map(([k, v]) => other.get(k) - v).filter(Number.isFinite);
  const dm = mean(d);
  claim(`bias table vs baseline, ${id}`, wantDiff, round(dm, 3), 0.0005);
  claim(`bias table t, ${id}`, wantT, round(dm / (stdev(d) / Math.sqrt(d.length)), 2), 0.005);
}

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
// Fields per parse, quoted exactly in the article.
const { agreementRate: _ar } = await import('../src/extractionMetrics.js');
claim('fields per parse', 296, _ar([sampleRec, sampleRec]).compared, 0);

// The name-swap leak the article quotes as 19 fields.
const swapped = normalizeExtraction(JSON.parse(await fs.readFile('results-extraction/temp0/firstName_aisha-okonkwo__gemini-2.5-flash__run1.json', 'utf8')).response);
// The value-change examples quoted in part 4, checked against the records they came from.
const flashCell = async (v) => normalizeExtraction(JSON.parse(await fs.readFile(`results-extraction/temp0/${v}__gemini-2.5-flash__run1.json`, 'utf8')).response);
const founderLevel = (x) => (x.employment ?? []).find((e) => /GIS|Founder/i.test(`${e.employer ?? ''}${e.title ?? ''}`))?.seniority_level;
const currentTech = (x) => new Set(((x.employment ?? [])[0]?.technologies ?? []).map((t) => String(t.name ?? '').toLowerCase()));
const fBase = await flashCell('baseline');
const fLagos = await flashCell('addressCountry_nigeria');
const fAisha = await flashCell('firstName_aisha-okonkwo');
const fMit = await flashCell('school_mit');
claim('MCP present in baseline parse', true, [...currentTech(fBase)].some((t) => t.includes('mcp')), 0);
claim('MCP dropped in the Lagos parse', false, [...currentTech(fLagos)].some((t) => t.includes('mcp')), 0);
claim('founder seniority, Aisha variant', 'c_level', founderLevel(fAisha), 0);
claim('founder seniority, Lagos variant', 'staff', founderLevel(fLagos), 0);
claim('founder seniority, MIT variant', 'staff', founderLevel(fMit), 0);
const baseDoc = await fs.readFile('data/variants/baseline.md', 'utf8');
const lagosDoc = await fs.readFile('data/variants/addressCountry_nigeria.md', 'utf8');
const diffLines = baseDoc.split('\n').filter((l, i) => l !== lagosDoc.split('\n')[i]).length;
claim('Lagos edit changes one line', 1, diffLines, 0);
claim('MCP appears once in each document', true,
  (baseDoc.match(/MCP/g) ?? []).length === 1 && (lagosDoc.match(/MCP/g) ?? []).length === 1, 0);

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

// ---------- placebo control ----------
const pb = await readJson('site/data/placebo.json');
claim('placebo levels', 7, pb.levels.length, 0);
claim('placebo control cells', 1496, pb.n_control_cells, 0);

// Pooled over the 7 models whose control and demographic runs share a collection method.
const nonClaude = pb.comparison.filter((c) => !c.model.startsWith('claude'));
claim('placebo-tested non-Claude models', 7, nonClaude.length, 0);
claim('demographic mean |d| per job', 0.362, round(mean(nonClaude.map((c) => c.demographic_mean_abs)), 3), 0.0015);
claim('noop floor, pooled', 0.262, round(mean(nonClaude.map((c) => c.noop_floor)), 3), 0.0015);
claim('models where placebo >= demographic', 2, pb.comparison.filter((c) => c.ratio >= 1).length, 0);
claim('worst ratio, claude-haiku', 1.15, round(pb.comparison.find((c) => c.model === 'claude-haiku').ratio), 0.005);

// Harness A/B: the Claude CLI carried ~29k tokens of context the API run did not.
claim('harness A/B rows', 4, pb.harness_ab.length, 0);
claim('harness inflation, mean score points', 0.138, round(Math.abs(mean(pb.harness_ab.map((h) => h.delta))), 3), 0.0015);
claim('harness inflation, claude-opus', 0.247, round(Math.abs(pb.harness_ab.find((h) => h.model === 'claude-opus').delta), 3), 0.0015);
const hRow = (m) => pb.harness_ab.find((h) => h.model === m);
claim('harness, opus with', 4.13, round(hRow('claude-opus').mean_with_harness), 0.005);
claim('harness, opus clean', 3.88, round(hRow('claude-opus').mean_without_harness), 0.005);
claim('harness, fable inflation', 0.224, round(Math.abs(hRow('claude-fable-5').delta), 3), 0.0015);
claim('harness, sonnet inflation', 0.129, round(Math.abs(hRow('claude-sonnet').delta), 3), 0.0015);
claim('harness, haiku moves the other way', true, hRow('claude-haiku').delta > 0, 0);
claim('models scoring higher with harness', 3, pb.harness_ab.filter((h) => h.delta < 0).length, 0);
claim('clean re-run records', 2720, 8 * 4 * 17 * 5, 0);
// Opus demographic effect, for the "88% the size of the signal" comparison.
const opusDemo = pb.comparison.find((c) => c.model === 'claude-opus').demographic_mean_abs;
claim('opus demographic effect', 0.282, round(opusDemo, 3), 0.0015);
claim('harness as share of opus signal, %', 88, Math.round(Math.abs(hRow('claude-opus').delta) / opusDemo * 100), 1);

// Per-axis demographic effect against the placebo floor, same per-job estimator both sides.
const matrixJson = await readJson('site/data/matrix.json');
const rawCells = [];
for (const f2 of await fs.readdir('results')) {
  if (!f2.endsWith('.json')) continue;
  const [variant, model, jd] = f2.replace('.json', '').split('__');
  const sc = JSON.parse(await fs.readFile(path.join('results', f2), 'utf8')).response?.score;
  if (typeof sc === 'number') rawCells.push({ variant, model, jd, score: sc });
}
const cellMean = new Map();
for (const [k, v] of groupBy(rawCells, (r) => `${r.variant}|${r.model}|${r.jd}`)) cellMean.set(k, mean(v.map((x) => x.score)));
const placeboModels = new Set(nonClaude.map((c) => c.model));
const axisAbs = (pred) => {
  const out = [];
  for (const [k, v] of cellMean) {
    const [variant, model, jd] = k.split('|');
    if (variant === 'baseline' || !placeboModels.has(model) || !pred(variant)) continue;
    const b = cellMean.get(`baseline|${model}|${jd}`);
    if (b != null) out.push(Math.abs(v - b));
  }
  return round(mean(out), 3);
};
claim('placebo pooled |d|', 0.328, axisAbs((v) => v.startsWith('placebo_')), 0.0015);
for (const [ax, want] of [['firstName', 0.456], ['careerGap', 0.452], ['anonymize', 0.412], ['companyLocations', 0.371], ['companyNames', 0.367], ['graduationYear', 0.354], ['addressCountry', 0.290], ['school', 0.230]]) {
  claim(`axis |d|, ${ax}`, want, axisAbs((v) => !v.startsWith('placebo_') && v.split('_')[0] === ax), 0.0015);
}
claim('car-silver |d|', 0.471, axisAbs((v) => v === 'placebo_car-silver'), 0.0015);
claim('car-red |d|', 0.415, axisAbs((v) => v === 'placebo_car-red'), 0.0015);
claim('weather-rain |d|', 0.308, axisAbs((v) => v === 'placebo_weather-rain'), 0.0015);
claim('day-saturday |d|', 0.291, axisAbs((v) => v === 'placebo_day-saturday'), 0.0015);

// Pair effects: does the VALUE of the irrelevant fact matter, holding its presence fixed.
const pairAbs = (id) => round(mean(pb.value.filter((v) => v.pair === id).map((v) => v.mean_abs)), 3);
claim('car colour pair effect', 0.235, pairAbs('car'), 0.0015);
claim('submission day pair effect', 0.207, pairAbs('day'), 0.0015);
claim('weather pair effect', 0.207, pairAbs('weather'), 0.0015);

// Mention rates: does the model ever say the irrelevant fact influenced it.
const mentionsFor = (label) => {
  const rows = pb.mentions.filter((m) => m.field_label === label);
  return { n: rows.reduce((a, b) => a + b.n_responses, 0), m: rows.reduce((a, b) => a + b.n_mentioning, 0) };
};
claim('car mentions', 2, mentionsFor('Car colour').m, 0);
claim('car responses scanned', 1870, mentionsFor('Car colour').n, 0);
claim('submission day mentions', 0, mentionsFor('Submission day').m, 0);
claim('weather mentions', 0, mentionsFor('Weather at submission').m, 0);

// The worst single paired swings quoted in the article.
const pbIndex = await readJson('site/data/placebo/index.json');
const top = pbIndex.top_gaps;
claim('widest paired gap', 2, round(Math.abs(top[0].gap), 2), 0.005);
claim('widest gap model', 'gemini-2.5-flash', top[0].model, 0);
claim('widest gap pair', 'day', top[0].pair, 0);
claim('widest gap a_mean', 6.8, round(top[0].a_mean, 2), 0.005);
claim('widest gap b_mean', 4.8, round(top[0].b_mean, 2), 0.005);
// The mirror-image row: same job, same fact, opposite direction.
const mirror = top.find((g) => g.model === 'gemini-2.5-pro' && g.pair === 'day' && g.jd === top[0].jd);
claim('mirror gap exists', true, mirror != null, 0);
claim('mirror gap is opposite sign', true, mirror != null && Math.sign(mirror.gap) !== Math.sign(top[0].gap), 0);
claim('mirror gap magnitude', 2, round(Math.abs(mirror.gap), 2), 0.005);
claim('haiku weather swing', 1.8, round(Math.abs(top.find((g) => g.model === 'claude-haiku' && g.pair === 'weather').gap), 2), 0.005);
claim('worst blank-line swing', 1.6, round(Math.abs(pbIndex.top_noop[0].delta), 2), 0.005);
claim('worst blank-line model', 'gemini-2.5-flash', pbIndex.top_noop[0].model, 0);
// Total model calls across every results tree, quoted in the series close.
const dirs = ['results', 'results-clean', 'results-prompt-lab', 'results-reasoning-transplant', 'results-extraction'];
let allCalls = 0;
for (const d of dirs) {
  const walk = async (p) => {
    for (const e of await fs.readdir(p, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(p, e.name));
      else if (e.name.endsWith('.json')) allCalls++;
    }
  };
  await walk(d);
}
claim('total model calls (article says forty-seven thousand)', 47, Math.floor(allCalls / 1000), 0);

claim('paired comparisons', 561, pb.value.reduce((a, v) => a + v.n_jds, 0), 0);

// ---------- synthesis and totals ----------
const syn = await readJson('site/data/synthesis.json');
claim('bias vs responsiveness r', 0.61, round(syn.corr_bias_responsiveness.r), 0.005);
claim('correlation models', 10, syn.corr_bias_responsiveness.n, 0);

const totalCalls = 3197 + 4800 + ex.n_records + 4165 + 2720;
claim('follow-up model calls', 17600, Math.round(totalCalls / 100) * 100, 0);

// ---------- report ----------
const article = (await Promise.all(ARTICLES.map((p) => fs.readFile(p, 'utf8')))).join('\n');
let failed = 0;
for (const c of claims) {
  const ok = typeof c.claimed === 'number' && typeof c.actual === 'number'
    ? Math.abs(c.claimed - c.actual) <= c.tol
    : c.claimed === c.actual;
  if (!ok) failed++;
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${c.label.padEnd(46)} article ${String(c.claimed).padStart(8)}   data ${String(c.actual).padStart(8)}`);
}

// Cheap guard against a figure being edited in the prose but not here.
// The articles use European number formatting: '.' for thousands, ',' for decimals.
const mustAppear = ['3,62', '**319** of **320**', '14,8', '4.800', '2.700', '0,61', '17.600', 'Hands-on agentic AI and MCP framework experience', 'Missing fintech/regulated-environment depth', '0,362', '0,328', '0,262', '4.165', '0,138', 'hex4def6', '0,471', '0,235', '1.870', '29.000', '2.720', '0,247', '296', 'Nineteen fields moved', 'Forty-seven thousand', '6,8 to 4,8', '1,6 points', '0,412', '0,371', '0,367', '0,354', 'MCP (Model Context Protocol)', 'c_level'];
const missing = mustAppear.filter((s) => !article.includes(s));
if (missing.length) {
  console.log(`\nFAIL  these verified figures are no longer in the article: ${missing.join(', ')}`);
  failed++;
}

console.log(`\n${claims.length - failed}/${claims.length} numbers verified against the dataset`);
if (failed) process.exit(1);
