import fs from 'node:fs/promises';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { loadResults, groupBy, mean, stdev, recommendRate, tInterval95 } from '../src/aggregate.js';
import { AXIS_LEVELS } from '../src/generateVariants.js';
import { costFor } from '../src/pricing.js';

const RESULTS_DIR = 'results';
const VARIANTS_DIR = 'data/variants';
const JDS_DIR = 'data/jds';
const OUT_DIR = 'site/data';
const EXPECTED_RUNS_PER_CELL = 5;
const TOP_DIFFS_COUNT = 200;
const NGRAM_TOP_N = 12;

const JD_SENIORITY = {
  jd_junior_fullstack: 1,
  jd_junior_java: 1,
  jd_sde_security_embedded: 2,
  jd_senior_fullstack: 4,
  jd_senior_ide_jvm: 4,
  jd_senior_routing_cpp: 4,
  jd_cpp_finance: 5,
  jd_swe_manager_engineering_productivity: 6,
  jd_techlead_cloud_compute: 6,
  jd_senior_manager_cpp: 7,
  jd_head_of_dev_techlead: 7,
  jd_staff_swe_ai_native: 8,
  jd_staff_forward_deployed_genai: 8,
  jd_principal_swe_growth: 9,
  jd_principal_perf_architect: 9,
  jd_principal_engineer_specialized: 9,
  jd_cto_agentic_fintech: 10
};

const STOPWORDS = new Set([
  'the','a','an','of','to','in','on','for','and','or','but','is','are','was','were','be','been','being',
  'has','have','had','do','does','did','will','would','could','should','may','might','can','no','not',
  'this','that','these','those','it','its','he','she','they','them','their','his','her','i','you','we',
  'with','by','at','as','from','up','out','if','than','then','so','also','very','more','most','some',
  'any','all','each','only','own','same','such','too','about','into','over','under','between','through',
  'mentioned','noted','listed','given','seems','appears','seem','appear','strong','some','many','few','several'
]);

const PARSE_JD = (filename) => filename.replace(/^jd_/, '').replace(/\.md$/, '');

function titleCase(s) {
  return s.split('-').map((w) => w.length ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

function camelCaseToWords(s) {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function levelLabel(axis, levelId) {
  const entry = AXIS_LEVELS[axis]?.find((l) => l.id === levelId);
  if (entry && typeof entry.value === 'string' && entry.value.length < 60 && !/^Career gap/i.test(entry.value)) {
    return entry.value;
  }
  if (entry && typeof entry.value === 'number') return String(entry.value);
  if (axis === 'careerGap') return levelId === 'caregiving' ? 'Caregiving' : 'Unexplained';
  if (axis === 'companyNames') {
    const map = { faang: 'FAANG (Google/Meta/Amazon)', 'mid-tier': 'Mid-tier (Stripe/Shopify/Datadog)', 'unknown-regional': 'Unknown regional', 'non-western': 'Non-western (Naver/Tencent/MercadoLibre)' };
    return map[levelId] ?? titleCase(levelId);
  }
  if (axis === 'school') {
    const map = { mit: 'MIT', 'eth-zurich': 'ETH Zürich', 'iit-bombay': 'IIT Bombay', 'regional-unknown': 'Regional (unknown)' };
    return map[levelId] ?? titleCase(levelId);
  }
  if (axis === 'companyLocations') {
    const map = { us: 'United States', india: 'India', latam: 'LATAM (Brazil)', africa: 'Africa (Kenya)' };
    return map[levelId] ?? titleCase(levelId);
  }
  if (axis === 'addressCountry') {
    const map = { usa: 'USA (San Francisco)', nigeria: 'Nigeria (Lagos)', india: 'India (Bangalore)', brazil: 'Brazil (São Paulo)', romania: 'Romania (Bucharest)' };
    return map[levelId] ?? titleCase(levelId);
  }
  if (axis === 'graduationYear') return `Graduated ${levelId}`;
  return titleCase(levelId);
}

async function loadJdLabels() {
  const files = await fs.readdir(JDS_DIR);
  const labels = {};
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const id = file.replace(/\.md$/, '');
    const raw = await fs.readFile(path.join(JDS_DIR, file), 'utf8');
    const m = raw.match(/^# (.+)$/m);
    labels[id] = m ? m[1].trim() : id;
  }
  return labels;
}

const JD_SHORT = {
  jd_junior_fullstack: 'Jr. Fullstack',
  jd_junior_java: 'Jr. Java',
  jd_sde_security_embedded: 'SDE Security / Embedded',
  jd_senior_fullstack: 'Sr. Fullstack',
  jd_senior_ide_jvm: 'Sr. IDE / JVM',
  jd_senior_routing_cpp: 'Sr. Routing (C++)',
  jd_cpp_finance: 'C++ Finance',
  jd_swe_manager_engineering_productivity: 'SWE Manager — Eng Productivity',
  jd_techlead_cloud_compute: 'Tech Lead — Cloud',
  jd_senior_manager_cpp: 'Sr. Manager (C++)',
  jd_head_of_dev_techlead: 'Head of Dev',
  jd_staff_swe_ai_native: 'Staff SWE — AI Native',
  jd_staff_forward_deployed_genai: 'Staff Forward-Deployed (GenAI)',
  jd_principal_swe_growth: 'Principal SWE — Growth',
  jd_principal_perf_architect: 'Principal Perf Architect',
  jd_principal_engineer_specialized: 'Principal — Specialised',
  jd_cto_agentic_fintech: 'CTO — Agentic / Fintech'
};

function axisLabel(axis) {
  return camelCaseToWords(axis);
}

const AXIS_DESCRIPTIONS = {
  firstName: 'Names varied across ethnic and cultural backgrounds — same resume, different first name.',
  graduationYear: 'Older graduation years — same resume, candidate finished school earlier.',
  addressCountry: 'Country of residence — same resume, candidate lives somewhere else.',
  careerGap: 'A two-year break on the timeline, with or without an explanation.',
  companyLocations: 'Geographic location of past employers — same companies, different home countries.',
  companyNames: 'Prestige tier of past employers (FAANG, mid-tier, regional, non-Western).',
  school: 'University attended — same degree, different alma mater.'
};

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === 'object' && obj.constructor === Object) {
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return obj;
}

async function writeJson(relpath, data) {
  const full = path.join(OUT_DIR, relpath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(sortKeys(data), null, 2));
  const stat = await fs.stat(full);
  return { relpath, size: stat.size };
}

function axisOf(variant) {
  if (variant === 'baseline') return null;
  const i = variant.indexOf('_');
  return i === -1 ? null : variant.slice(0, i);
}

function levelOf(variant) {
  if (variant === 'baseline') return null;
  const i = variant.indexOf('_');
  return i === -1 ? null : variant.slice(i + 1);
}

function cellKey(variant, model, jd) { return `${variant}|${model}|${jd}`; }

function computeCells(records) {
  const groups = groupBy(records, (r) => cellKey(r.variant, r.model, r.jd));
  const cells = [];
  for (const [key, group] of groups) {
    const [variant, model, jd] = key.split('|');
    const scores = group.map((r) => r.response?.score).filter((s) => typeof s === 'number');
    const ci = tInterval95(scores);
    cells.push({
      variant, model, jd,
      n: group.length,
      scores,
      mean: mean(scores),
      stdev: stdev(scores),
      ci_lo: ci?.lo ?? null,
      ci_hi: ci?.hi ?? null,
      recommend_yes_rate: recommendRate(group),
      recommend: group.map((r) => r.response?.recommend_interview ?? null)
    });
  }
  return cells;
}

function indexBaselines(cells) {
  const baselines = new Map();
  for (const c of cells) {
    if (c.variant !== 'baseline') continue;
    baselines.set(`${c.model}|${c.jd}`, c);
  }
  return baselines;
}

function applyDeltas(cells, baselines) {
  for (const c of cells) {
    const b = baselines.get(`${c.model}|${c.jd}`);
    c.baseline_mean = b?.mean ?? null;
    c.baseline_recommend_rate = b?.recommend_yes_rate ?? null;
    c.delta = (c.mean != null && b?.mean != null) ? c.mean - b.mean : null;
    c.disparate_impact_ratio = (c.recommend_yes_rate != null && b?.recommend_yes_rate)
      ? c.recommend_yes_rate / b.recommend_yes_rate
      : null;
    c.significant = (c.delta != null && c.ci_lo != null && c.ci_hi != null && b?.mean != null)
      ? (c.ci_lo > b.mean || c.ci_hi < b.mean)
      : false;
  }
}

function buildMatrix(cells, axes, models, axisLabels, levelLabels, jdLabels, jdShortLabels, axisDescriptions) {
  const levelsByAxis = Object.fromEntries(axes.map((a) => [a, AXIS_LEVELS[a].map((l) => l.id)]));
  const matrix = {};
  for (const axis of axes) {
    matrix[axis] = {};
    for (const level of levelsByAxis[axis]) {
      matrix[axis][level] = {};
      for (const model of models) {
        const inCell = cells.filter((c) => axisOf(c.variant) === axis && levelOf(c.variant) === level && c.model === model && c.delta != null);
        if (inCell.length === 0) {
          matrix[axis][level][model] = null;
          continue;
        }
        const deltas = inCell.map((c) => c.delta);
        const sigCount = inCell.filter((c) => c.significant).length;
        matrix[axis][level][model] = {
          mean_delta: mean(deltas),
          mean_abs_delta: mean(deltas.map(Math.abs)),
          n_jds: inCell.length,
          sig_rate: sigCount / inCell.length,
          worst_jd: inCell.reduce((acc, c) => Math.abs(c.delta) > Math.abs(acc.delta) ? c : acc, inCell[0]).jd
        };
      }
    }
  }
  return { axes, models, levels_by_axis: levelsByAxis, matrix, axis_labels: axisLabels, axis_descriptions: axisDescriptions, level_labels: levelLabels, jd_labels: jdLabels, jd_short_labels: jdShortLabels };
}

function buildHeatmap(cells, axes, models) {
  const mat = (fill) => axes.map(() => models.map(() => fill));
  const mean_abs_delta = mat(null);
  const signed_mean_delta = mat(null);
  const significant_rate = mat(0);
  const worst_case = mat(null);

  for (let i = 0; i < axes.length; i++) {
    for (let j = 0; j < models.length; j++) {
      const axis = axes[i], model = models[j];
      const inCell = cells.filter((c) => axisOf(c.variant) === axis && c.model === model && c.delta != null);
      if (inCell.length === 0) continue;
      const abs = inCell.map((c) => Math.abs(c.delta));
      mean_abs_delta[i][j] = mean(abs);
      signed_mean_delta[i][j] = mean(inCell.map((c) => c.delta));
      significant_rate[i][j] = inCell.filter((c) => c.significant).length / inCell.length;
      const worst = inCell.reduce((acc, c) => (Math.abs(c.delta) > Math.abs(acc.delta) ? c : acc), inCell[0]);
      worst_case[i][j] = {
        variant: worst.variant, level: levelOf(worst.variant), jd: worst.jd,
        delta: worst.delta, baseline_mean: worst.baseline_mean, mean: worst.mean,
        significant: worst.significant
      };
    }
  }

  return { axes, models, mean_abs_delta, signed_mean_delta, significant_rate, worst_case };
}

function byAxisFile(axis, axisCells, baselines) {
  const levels = AXIS_LEVELS[axis]?.map((l) => l.id) ?? [...new Set(axisCells.map((c) => levelOf(c.variant)))].sort();
  const cells = axisCells.map((c) => ({
    level: levelOf(c.variant), model: c.model, jd: c.jd,
    n: c.n, scores: c.scores, recommend: c.recommend,
    mean: c.mean, stdev: c.stdev, ci_lo: c.ci_lo, ci_hi: c.ci_hi,
    recommend_yes_rate: c.recommend_yes_rate,
    baseline_mean: c.baseline_mean, baseline_recommend_rate: c.baseline_recommend_rate,
    delta: c.delta, disparate_impact_ratio: c.disparate_impact_ratio,
    significant: c.significant
  }));

  const samples = [];
  for (const level of levels) {
    const inLevel = axisCells.filter((c) => levelOf(c.variant) === level && c.delta != null);
    inLevel.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    samples.push({ level, top: inLevel.slice(0, 3).map((c) => ({
      level, model: c.model, jd: c.jd, mean: c.mean, delta: c.delta
    })) });
  }
  return { axis, levels, cells, sample_top_deltas: samples };
}

function byJdFile(jd, jdCells, jdSeniority) {
  const cells = jdCells.map((c) => ({
    variant: c.variant, axis: axisOf(c.variant), level: levelOf(c.variant), model: c.model,
    n: c.n, mean: c.mean, ci_lo: c.ci_lo, ci_hi: c.ci_hi,
    recommend_yes_rate: c.recommend_yes_rate,
    baseline_mean: c.baseline_mean, delta: c.delta, significant: c.significant
  }));
  return { jd, seniority: jdSeniority, cells };
}

function buildModels(records, cells, models) {
  const byModel = groupBy(records, (r) => r.model);
  const out = [];
  for (const model of models) {
    const group = byModel.get(model) ?? [];
    if (group.length === 0) continue;
    const inT = group.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0);
    const outT = group.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0);
    const cost = group.reduce((s, r) => s + costFor(model, r.usage), 0);
    const elapsed = group.map((r) => r.elapsed_ms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    const median = elapsed.length ? elapsed[Math.floor(elapsed.length / 2)] : null;

    const modelCells = cells.filter((c) => c.model === model && c.delta != null);
    const axisSens = {};
    for (const axis of Object.keys(AXIS_LEVELS)) {
      const inCell = modelCells.filter((c) => axisOf(c.variant) === axis);
      axisSens[axis] = inCell.length ? mean(inCell.map((c) => Math.abs(c.delta))) : null;
    }

    out.push({
      model, vendor: group[0].vendor, tier: group[0].tier,
      calls: group.length, input_tokens: inT, output_tokens: outT, cost_usd: cost,
      median_elapsed_ms: median, axis_sensitivity: axisSens
    });
  }

  const agreement = computeAgreement(records, models);
  return { models: out, agreement };
}

function computeAgreement(records, models) {
  const byCell = groupBy(records, (r) => `${r.variant}|${r.jd}|${r.run}`);
  const pairs = {};
  for (let i = 0; i < models.length; i++) {
    pairs[models[i]] = {};
    for (let j = 0; j < models.length; j++) {
      pairs[models[i]][models[j]] = { agree: 0, total: 0 };
    }
  }
  for (const [, group] of byCell) {
    for (let i = 0; i < group.length; i++) {
      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        const a = group[i], b = group[j];
        if (!pairs[a.model]?.[b.model]) continue;
        pairs[a.model][b.model].total++;
        if (a.response?.recommend_interview === b.response?.recommend_interview) {
          pairs[a.model][b.model].agree++;
        }
      }
    }
  }
  const matrix = {};
  for (const m1 of models) {
    matrix[m1] = {};
    for (const m2 of models) {
      const p = pairs[m1][m2];
      matrix[m1][m2] = p.total ? p.agree / p.total : null;
    }
  }
  return matrix;
}

function tokenize(text) {
  return (text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w.length >= 3 && !STOPWORDS.has(w));
}

function ngramsFromTexts(texts, n) {
  const counts = new Map();
  for (const t of texts) {
    const words = tokenize(t);
    for (let i = 0; i <= words.length - n; i++) {
      const g = words.slice(i, i + n).join(' ');
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  return counts;
}

function diffNgrams(levelTexts, baselineTexts, n) {
  const lv = ngramsFromTexts(levelTexts, n);
  const bl = ngramsFromTexts(baselineTexts, n);
  const ranked = [];
  for (const [g, lvCount] of lv) {
    const blCount = bl.get(g) ?? 0;
    if (lvCount < 2) continue;
    const ratio = (lvCount + 1) / (blCount + 1);
    ranked.push({ phrase: g, count: lvCount, baseline_count: blCount, ratio });
  }
  ranked.sort((a, b) => b.ratio - a.ratio || b.count - a.count);
  return ranked.slice(0, NGRAM_TOP_N);
}

function buildNgrams(records, axis, baselines) {
  const levels = AXIS_LEVELS[axis]?.map((l) => l.id) ?? [];
  const byLevel = {};
  const baselineConcerns = records.filter((r) => r.variant === 'baseline').flatMap((r) => r.response?.concerns ?? []);
  const baselineStrengths = records.filter((r) => r.variant === 'baseline').flatMap((r) => r.response?.strengths ?? []);
  for (const level of levels) {
    const levelRecs = records.filter((r) => axisOf(r.variant) === axis && levelOf(r.variant) === level);
    const concerns = levelRecs.flatMap((r) => r.response?.concerns ?? []);
    const strengths = levelRecs.flatMap((r) => r.response?.strengths ?? []);
    byLevel[level] = {
      top_concerns: [...diffNgrams(concerns, baselineConcerns, 2), ...diffNgrams(concerns, baselineConcerns, 3)]
        .sort((a, b) => b.ratio - a.ratio || b.count - a.count).slice(0, NGRAM_TOP_N),
      top_strengths: [...diffNgrams(strengths, baselineStrengths, 2), ...diffNgrams(strengths, baselineStrengths, 3)]
        .sort((a, b) => b.ratio - a.ratio || b.count - a.count).slice(0, NGRAM_TOP_N),
      n_concerns: concerns.length,
      n_strengths: strengths.length
    };
  }
  return { axis, by_level: byLevel };
}

function pickTopDiffs(cells, records, n) {
  const candidates = cells.filter((c) => c.delta != null && c.variant !== 'baseline');
  candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = candidates.slice(0, n);
  const out = [];
  for (const c of top) {
    const variantRec = records.find((r) => r.variant === c.variant && r.model === c.model && r.jd === c.jd);
    const baselineRec = records.find((r) => r.variant === 'baseline' && r.model === c.model && r.jd === c.jd);
    if (!variantRec || !baselineRec) continue;
    out.push({
      id: `${c.variant}__${c.model}__${c.jd}`,
      variant: c.variant, axis: axisOf(c.variant), level: levelOf(c.variant),
      model: c.model, jd: c.jd,
      delta: c.delta, ci_overlap: !c.significant,
      baseline: { mean: c.baseline_mean, recommend_rate: c.baseline_recommend_rate, sample: baselineRec.response },
      variant_data: { mean: c.mean, recommend_rate: c.recommend_yes_rate, sample: variantRec.response }
    });
  }
  return out;
}

async function loadVariantResumes() {
  const files = await fs.readdir(VARIANTS_DIR);
  const out = {};
  for (const file of files.sort()) {
    if (!file.endsWith('.md')) continue;
    const id = file.replace(/\.md$/, '');
    out[id] = await fs.readFile(path.join(VARIANTS_DIR, file), 'utf8');
  }
  return out;
}

async function gzipFile(srcText, relpath) {
  const full = path.join(OUT_DIR, relpath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await pipeline(Readable.from([srcText]), createGzip(), (await import('node:fs')).createWriteStream(full));
  const stat = await fs.stat(full);
  return { relpath, size: stat.size };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const records = await loadResults(RESULTS_DIR);
  if (records.length === 0) throw new Error(`No results in ${RESULTS_DIR}`);

  const axes = Object.keys(AXIS_LEVELS).sort();
  const models = [...new Set(records.map((r) => r.model))].sort();
  const jdFiles = (await fs.readdir(JDS_DIR)).filter((f) => f.endsWith('.md')).sort();
  const jds = jdFiles.map((f) => f.replace(/\.md$/, ''));
  const jdLabels = await loadJdLabels();
  const axisLabels = Object.fromEntries(axes.map((a) => [a, axisLabel(a)]));
  const axisDescriptions = Object.fromEntries(axes.map((a) => [a, AXIS_DESCRIPTIONS[a] ?? '']));
  const levelLabels = Object.fromEntries(axes.map((a) => [a, Object.fromEntries(AXIS_LEVELS[a].map((l) => [l.id, levelLabel(a, l.id)]))]));

  const cells = computeCells(records);
  const baselines = indexBaselines(cells);
  applyDeltas(cells, baselines);

  const outputs = [];

  const jdShortLabels = Object.fromEntries(jds.map((id) => [id, JD_SHORT[id] ?? jdLabels[id] ?? id]));
  outputs.push(await writeJson('summary.json', {
    generated_at: new Date().toISOString(),
    axes,
    axis_labels: axisLabels,
    models,
    jds: jds.map((id) => ({ id, label: jdLabels[id] ?? id, short_label: jdShortLabels[id], seniority: JD_SENIORITY[id] ?? 5 })),
    variants_by_axis: Object.fromEntries(axes.map((a) => [a, AXIS_LEVELS[a].map((l) => l.id)])),
    level_labels: levelLabels,
    n_records: records.length
  }));

  outputs.push(await writeJson('status.json', {
    generated_at: new Date().toISOString(),
    n_records: records.length,
    n_cells_complete: cells.length,
    n_cells_total: axes.reduce((s, a) => s + AXIS_LEVELS[a].length, 0) * models.length * jds.length + models.length * jds.length,
    expected_total_records: (axes.reduce((s, a) => s + AXIS_LEVELS[a].length, 0) + 1) * models.length * jds.length * EXPECTED_RUNS_PER_CELL,
    total_cost_usd: records.reduce((s, r) => s + costFor(r.model, r.usage), 0),
    total_input_tokens: records.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0),
    total_output_tokens: records.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0)
  }));

  outputs.push(await writeJson('heatmap.json', buildHeatmap(cells, axes, models)));
  outputs.push(await writeJson('matrix.json', buildMatrix(cells, axes, models, axisLabels, levelLabels, jdLabels, jdShortLabels, axisDescriptions)));

  outputs.push(await writeJson('models.json', buildModels(records, cells, models)));

  for (const axis of axes) {
    const axisCells = cells.filter((c) => axisOf(c.variant) === axis);
    outputs.push(await writeJson(`by-axis/${axis}.json`, byAxisFile(axis, axisCells, baselines)));
  }

  for (const jd of jds) {
    const jdCells = cells.filter((c) => c.jd === jd);
    outputs.push(await writeJson(`by-jd/${jd}.json`, byJdFile(jd, jdCells, JD_SENIORITY[jd] ?? 5)));
  }

  for (const axis of axes) {
    outputs.push(await writeJson(`ngrams/${axis}.json`, buildNgrams(records, axis, baselines)));
  }

  const topDiffs = pickTopDiffs(cells, records, TOP_DIFFS_COUNT);
  outputs.push(await writeJson('diffs/index.json', topDiffs.map((d) => ({
    id: d.id, variant: d.variant, axis: d.axis, level: d.level, model: d.model, jd: d.jd,
    delta: d.delta, ci_overlap: d.ci_overlap
  }))));
  for (const d of topDiffs) {
    outputs.push(await writeJson(`diffs/${d.id}.json`, d));
  }

  outputs.push(await writeJson('resumes.json', await loadVariantResumes()));

  const ndjson = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  outputs.push(await gzipFile(ndjson, 'raw/results.ndjson.gz'));

  console.log(`wrote ${outputs.length} files to ${OUT_DIR}/`);
  for (const o of outputs) {
    console.log(`  ${o.relpath.padEnd(40)} ${(o.size / 1024).toFixed(1)} KB`);
  }
}

main();
