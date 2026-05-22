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
const AUDITS_DIR = 'data/audits';
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

async function loadJdTexts() {
  const files = await fs.readdir(JDS_DIR);
  const texts = {};
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const id = file.replace(/\.md$/, '');
    texts[id] = await fs.readFile(path.join(JDS_DIR, file), 'utf8');
  }
  return texts;
}

function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  let inPara = false;
  const closePara = () => { if (inPara) { out.push('</p>'); inPara = false; } };
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closePara(); closeList(); continue; }
    let m;
    if ((m = line.match(/^# (.+)$/))) { closePara(); closeList(); out.push(`<h2>${esc(m[1])}</h2>`); }
    else if ((m = line.match(/^## (.+)$/))) { closePara(); closeList(); out.push(`<h3>${esc(m[1])}</h3>`); }
    else if ((m = line.match(/^### (.+)$/))) { closePara(); closeList(); out.push(`<h4>${esc(m[1])}</h4>`); }
    else if ((m = line.match(/^[-*] (.+)$/))) {
      closePara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${esc(m[1])}</li>`);
    } else {
      closeList();
      if (!inPara) { out.push('<p>'); inPara = true; }
      else out.push(' ');
      out.push(esc(line));
    }
  }
  closePara();
  closeList();
  return out.join('');
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

function indexFirstRecord(records) {
  const byCell = new Map();
  for (const r of records) {
    const key = `${r.variant}__${r.model}__${r.jd}`;
    if (!byCell.has(key)) byCell.set(key, r);
  }
  return byCell;
}

function buildDiffObjects(cells, records) {
  const recByCell = indexFirstRecord(records);
  const out = [];
  for (const c of cells) {
    if (c.delta == null || c.variant === 'baseline') continue;
    const variantRec = recByCell.get(`${c.variant}__${c.model}__${c.jd}`);
    const baselineRec = recByCell.get(`baseline__${c.model}__${c.jd}`);
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

async function loadAudits() {
  const out = new Map();
  if (!(await fs.access(AUDITS_DIR).then(() => true, () => false))) return out;
  const files = (await fs.readdir(AUDITS_DIR)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const a = JSON.parse(await fs.readFile(path.join(AUDITS_DIR, file), 'utf8'));
    out.set(a.id, { verdict: a.verdict, confidence: a.confidence, rationale: a.rationale, bias_signals: a.bias_signals ?? [] });
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
  const jdTexts = await loadJdTexts();
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

  const allDiffs = buildDiffObjects(cells, records);
  const audits = await loadAudits();
  for (const d of allDiffs) d.audit = audits.get(d.id) ?? null;
  const topDiffs = [...allDiffs].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, TOP_DIFFS_COUNT);
  outputs.push(await writeJson('diffs/index.json', topDiffs.map((d) => ({
    id: d.id, variant: d.variant, axis: d.axis, level: d.level, model: d.model, jd: d.jd,
    delta: d.delta, ci_overlap: d.ci_overlap
  }))));
  outputs.push(...await Promise.all(allDiffs.map((d) => writeJson(`diffs/${d.id}.json`, d))));

  outputs.push(await writeJson('resumes.json', await loadVariantResumes()));
  outputs.push(await writeJson('jds-text.json', jdTexts));

  const ndjson = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  outputs.push(await gzipFile(ndjson, 'raw/results.ndjson.gz'));

  const status = {
    n_records: records.length,
    n_cells_complete: cells.length,
    n_cells_total: axes.reduce((s, a) => s + AXIS_LEVELS[a].length, 0) * models.length * jds.length + models.length * jds.length,
    expected_total_records: (axes.reduce((s, a) => s + AXIS_LEVELS[a].length, 0) + 1) * models.length * jds.length * EXPECTED_RUNS_PER_CELL,
    total_cost_usd: records.reduce((s, r) => s + costFor(r.model, r.usage), 0)
  };
  const matrixData = buildMatrix(cells, axes, models, axisLabels, levelLabels, jdLabels, jdShortLabels, axisDescriptions);
  const topDiffsForPrerender = topDiffs.slice(0, 12);
  await prerenderHtml({
    status, matrixData, topDiffs: topDiffsForPrerender,
    axes, models, jds, jdLabels, jdShortLabels, jdTexts, cells,
    axisLabels, levelLabels, axisDescriptions
  });
  await writeSitemap();
  await writeRobots();

  console.log(`wrote ${outputs.length} files to ${OUT_DIR}/`);
  for (const o of outputs) {
    console.log(`  ${o.relpath.padEnd(40)} ${(o.size / 1024).toFixed(1)} KB`);
  }
}

const MODEL_DISPLAY = {
  'claude-opus': 'Claude Opus',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro · Preview',
  'llama-4-maverick': 'Llama 4 Maverick',
  'qwen-3-next-80b': 'Qwen 3 Next 80B'
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function modelDisplay(m) { return MODEL_DISPLAY[m] ?? m; }

function signedClass(v) {
  if (v == null) return 'dim';
  if (v > 0.02) return 'accent';
  if (v < -0.02) return 'alert';
  return 'dim';
}

function fmtSigned(v, digits = 2) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + Number(v).toFixed(digits);
}

function computeBiasIndexSnapshot(matrix) {
  const stats = {};
  for (const m of matrix.models) stats[m] = { absSum: 0, signedSum: 0, n: 0, sigN: 0, worst: null, best: null };
  for (const axis of matrix.axes) {
    for (const level of matrix.levels_by_axis?.[axis] ?? []) {
      for (const m of matrix.models) {
        const cell = matrix.matrix?.[axis]?.[level]?.[m];
        if (!cell || cell.mean_delta == null) continue;
        const s = stats[m];
        s.absSum += Math.abs(cell.mean_delta);
        s.signedSum += cell.mean_delta;
        s.n++;
        if (cell.sig_rate >= 0.5) s.sigN++;
        if (!s.worst || cell.mean_delta < s.worst.mean_delta) s.worst = { axis, level, mean_delta: cell.mean_delta };
        if (!s.best || cell.mean_delta > s.best.mean_delta) s.best = { axis, level, mean_delta: cell.mean_delta };
      }
    }
  }
  return matrix.models.map((m) => ({
    model: m,
    n: stats[m].n,
    mean_abs: stats[m].n ? stats[m].absSum / stats[m].n : null,
    mean_signed: stats[m].n ? stats[m].signedSum / stats[m].n : null,
    sig_frac: stats[m].n ? stats[m].sigN / stats[m].n : null,
    worst: stats[m].worst,
    best: stats[m].best
  })).sort((a, b) => (b.mean_abs ?? -1) - (a.mean_abs ?? -1));
}

function computeDimensionBiasSnapshot(matrix) {
  const stats = {};
  for (const axis of matrix.axes) stats[axis] = { absSum: 0, signedSum: 0, n: 0, sigN: 0 };
  for (const axis of matrix.axes) {
    for (const level of matrix.levels_by_axis?.[axis] ?? []) {
      for (const m of matrix.models) {
        const cell = matrix.matrix?.[axis]?.[level]?.[m];
        if (!cell || cell.mean_delta == null) continue;
        stats[axis].absSum += Math.abs(cell.mean_delta);
        stats[axis].signedSum += cell.mean_delta;
        stats[axis].n++;
        if (cell.sig_rate >= 0.5) stats[axis].sigN++;
      }
    }
  }
  return matrix.axes.map((axis) => ({
    axis,
    label: matrix.axis_labels?.[axis] ?? axis,
    n: stats[axis].n,
    mean_abs: stats[axis].n ? stats[axis].absSum / stats[axis].n : null,
    mean_signed: stats[axis].n ? stats[axis].signedSum / stats[axis].n : null,
    sig_frac: stats[axis].n ? stats[axis].sigN / stats[axis].n : null
  })).sort((a, b) => (b.mean_abs ?? -1) - (a.mean_abs ?? -1));
}

function variantWithDeltaHtml(matrix, entry, klass) {
  if (!entry) return '<span class="dim">—</span>';
  const lbl = `${esc(matrix.axis_labels?.[entry.axis] ?? entry.axis)} · ${esc(matrix.level_labels?.[entry.axis]?.[entry.level] ?? entry.level)}`;
  return `${lbl} <span class="${klass}">(${fmtSigned(entry.mean_delta, 2)})</span>`;
}

function biasIndexTableHtml(matrix, opts = {}) {
  const title = opts.title ?? 'GLOBAL BIAS INDEX — MEAN |Δ| ACROSS ALL CELLS';
  const description = opts.description ?? 'For each model, the average absolute score change when a demographic signal is altered, taken over every (axis, variant, JD) cell with data. Higher = the model is more sensitive to demographic signals; lower = more even-handed.';
  const stats = computeBiasIndexSnapshot(matrix);
  const worldMax = Math.max(...stats.map((s) => s.mean_abs ?? 0), 0.0001);
  const rows = stats.map((s) => {
    const pct = ((s.mean_abs ?? 0) / worldMax * 100).toFixed(0);
    return `<tr>
      <td>${esc(modelDisplay(s.model))}</td>
      <td style="width:20%"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:9px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent)"></div></div></div></td>
      <td class="num">${s.mean_abs != null ? s.mean_abs.toFixed(3) : '—'}</td>
      <td class="num ${signedClass(s.mean_signed)}">${fmtSigned(s.mean_signed, 3)}</td>
      <td class="num">${s.sig_frac != null ? (s.sig_frac * 100).toFixed(0) + '%' : '—'}</td>
      <td class="num dim">${s.n}</td>
      <td>${variantWithDeltaHtml(matrix, s.worst, 'alert')}</td>
      <td>${variantWithDeltaHtml(matrix, s.best, 'accent')}</td>
    </tr>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>${esc(title)}</span></div>
    <p class="dim">${esc(description)}</p>
    <table class="data">
      <thead><tr>
        <th>Model</th><th>Bias index</th><th class="num">Mean |Δ|</th><th class="num">Mean signed Δ</th>
        <th class="num">% sig</th><th class="num">Cells</th><th>Most penalised</th><th>Most rewarded</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function dimensionBiasTableHtml(matrix) {
  const stats = computeDimensionBiasSnapshot(matrix);
  const worldMax = Math.max(...stats.map((s) => s.mean_abs ?? 0), 0.0001);
  const rows = stats.map((s) => {
    const pct = ((s.mean_abs ?? 0) / worldMax * 100).toFixed(0);
    return `<tr>
      <td>${esc(s.label)}</td>
      <td style="width:20%"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:9px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent)"></div></div></div></td>
      <td class="num">${s.mean_abs != null ? s.mean_abs.toFixed(3) : '—'}</td>
      <td class="num ${signedClass(s.mean_signed)}">${fmtSigned(s.mean_signed, 3)}</td>
      <td class="num">${s.sig_frac != null ? (s.sig_frac * 100).toFixed(0) + '%' : '—'}</td>
      <td class="num dim">${s.n}</td>
    </tr>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>WHICH DIMENSION TRIGGERS THE MOST BIAS?</span></div>
    <p class="dim">Each demographic dimension, averaged over all variants × models × JDs with data. The axis with the largest mean |Δ| is the one models are most reactive to.</p>
    <table class="data">
      <thead><tr><th>Dimension</th><th>Bias index</th><th class="num">Mean |Δ|</th><th class="num">Mean signed Δ</th><th class="num">% sig</th><th class="num">Cells</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function heroHtml(topDiffs, matrix) {
  const top = topDiffs.find((d) => d.ci_overlap === false) ?? topDiffs[0];
  if (!top) return '';
  const axisL = matrix.axis_labels?.[top.axis] ?? top.axis;
  const levelL = matrix.level_labels?.[top.axis]?.[top.level] ?? top.level;
  const jdL = matrix.jd_labels?.[top.jd] ?? top.jd;
  return `<div class="panel">
    <div class="panel-head"><span>THE STARKEST DELTA WE HAVE SO FAR</span></div>
    <p>When the only change is <strong>${esc(levelL)}</strong> (axis: <em class="dim">${esc(axisL)}</em>), <strong>${esc(modelDisplay(top.model))}</strong> shifts its score by <span class="${signedClass(top.delta)}">${fmtSigned(top.delta, 2)}</span> on the role: <em>${esc(jdL)}</em>.</p>
    <p><a href="diff.html?variant=${esc(top.axis)}_${esc(top.level)}&model=${esc(top.model)}&jd=${esc(top.jd)}">See this counterfactual →</a></p>
  </div>`;
}

function statsHtml({ status, matrix, jdsCount }) {
  const tiles = [
    ['Resume variants tested', '28', 'baseline + 27 single-axis mutations'],
    ['Models evaluated', String(matrix.models.length), matrix.models.map((m) => modelDisplay(m)).join(' · ')],
    ['Job descriptions', String(jdsCount), 'from junior fullstack to CTO'],
    ['Inference runs collected', status.n_records.toLocaleString(), `of ${status.expected_total_records.toLocaleString()} planned (${(status.n_records / status.expected_total_records * 100).toFixed(1)}%)`],
    ['API spend so far', `$${status.total_cost_usd.toFixed(2)}`, 'OpenAI/Anthropic/Google/Alibaba/Meta APIs'],
    ['Bias dimensions', String(matrix.axes.length), matrix.axes.map((a) => matrix.axis_labels?.[a] ?? a).join(' · ')]
  ];
  const tilesHtml = tiles.map(([label, value, sub]) => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`).join('\n');
  return `<div class="stats">${tilesHtml}</div>`;
}

function topCounterfactualsHtml(topDiffs, matrix) {
  const items = topDiffs.map((d) => {
    const label = `${esc(matrix.axis_labels?.[d.axis] ?? d.axis)} · ${esc(matrix.level_labels?.[d.axis]?.[d.level] ?? d.level)}`;
    const href = `diff.html?variant=${esc(d.axis)}_${esc(d.level)}&model=${esc(d.model)}&jd=${esc(d.jd)}`;
    return `<a href="${href}" class="card" style="text-align:left;padding:6px 8px;font-size:11px;line-height:1.3;text-decoration:none">
      <span class="${d.delta >= 0 ? 'accent' : 'alert'}">${fmtSigned(d.delta, 2)}</span> · ${label}<br>
      <span class="dim">${esc(modelDisplay(d.model))} · ${esc(matrix.jd_labels?.[d.jd] ?? d.jd)}</span>
    </a>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>TOP COUNTERFACTUALS — JUMP TO THE CASES WITH THE LARGEST Δ</span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px">${items}</div>
  </div>`;
}

function heatmapSummaryHtml(matrix) {
  const stats = computeBiasIndexSnapshot(matrix);
  const lines = stats.slice(0, 3).map((s) => `<li><strong>${esc(modelDisplay(s.model))}</strong>: mean |Δ| ${s.mean_abs != null ? s.mean_abs.toFixed(3) : '—'} — most penalised ${variantWithDeltaHtml(matrix, s.worst, 'alert')}, most rewarded ${variantWithDeltaHtml(matrix, s.best, 'accent')}.</li>`).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>WHAT THE WALL SHOWS — TOP MODELS BY BIAS INDEX</span></div>
    <p class="dim">The interactive 3D wall lets you inspect every (variant, JD) cell for any (model, dimension) pair. Static summary of the three most demographically-sensitive models below; pick another pair in the controls to update.</p>
    <ul>${lines}</ul>
  </div>`;
}

function variantLabelFromId(matrix, id) {
  if (id === 'baseline') return 'baseline (unmodified)';
  const idx = id.indexOf('_');
  if (idx < 0) return id;
  const axis = id.slice(0, idx);
  const level = id.slice(idx + 1);
  return `${matrix.axis_labels?.[axis] ?? axis} · ${matrix.level_labels?.[axis]?.[level] ?? level}`;
}

function variantDelta(matrix, id, model) {
  if (id === 'baseline') return 0;
  const idx = id.indexOf('_');
  if (idx < 0) return null;
  const axis = id.slice(0, idx);
  const level = id.slice(idx + 1);
  return matrix.matrix?.[axis]?.[level]?.[model]?.mean_delta ?? null;
}

function resumeComparisonHtml(matrix, fromId, toId) {
  const leftLabel = variantLabelFromId(matrix, fromId);
  const rightLabel = variantLabelFromId(matrix, toId);
  const rows = matrix.models.map((m) => {
    const l = variantDelta(matrix, fromId, m);
    const r = variantDelta(matrix, toId, m);
    const diff = l == null || r == null ? null : r - l;
    return { model: m, l, r, diff };
  });
  const worldMax = Math.max(...rows.map((s) => (s.diff == null ? 0 : Math.abs(s.diff))), 0.0001);
  const body = rows.map((s) => {
    let stronger;
    if (s.diff == null) stronger = '<span class="dim">no data</span>';
    else if (Math.abs(s.diff) < 0.005) stronger = '<span class="dim">tie</span>';
    else stronger = `<span class="${s.diff > 0 ? 'accent' : 'alert'}">${s.diff > 0 ? `Right · ${esc(rightLabel)}` : `Left · ${esc(leftLabel)}`}</span>`;
    const half = (Math.abs(s.diff ?? 0) / worldMax) * 50;
    const left = (s.diff ?? 0) >= 0 ? 50 : 50 - half;
    const barColor = (s.diff ?? 0) >= 0 ? 'var(--accent)' : 'var(--alert)';
    const bar = s.diff == null ? '<span class="dim">—</span>'
      : `<div style="position:relative;height:9px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden"><div style="position:absolute;top:0;height:100%;width:${half.toFixed(0)}%;left:${left.toFixed(0)}%;background:${barColor}"></div><div style="position:absolute;left:50%;top:0;width:1px;height:100%;background:var(--border)"></div></div>`;
    return `<tr>
      <td>${esc(modelDisplay(s.model))}</td>
      <td class="num ${signedClass(s.l)}">${fmtSigned(s.l, 3)}</td>
      <td class="num ${signedClass(s.r)}">${fmtSigned(s.r, 3)}</td>
      <td>${stronger}</td>
      <td style="width:20%">${bar}</td>
      <td class="num dim">${s.diff == null ? '—' : Math.abs(s.diff).toFixed(3)}</td>
    </tr>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>HOW EACH MODEL SCORES THESE TWO RÉSUMÉS</span></div>
    <p class="dim">Each model’s mean score change versus the unmodified baseline, for the left and right résumé (averaged over all JDs with data). <span class="accent">Green</span> = the right résumé scored higher, <span class="alert">red</span> = the left scored higher. Margin is the size of that gap.</p>
    <table class="data">
      <thead><tr>
        <th>Model</th><th class="num">Left Δ (${esc(leftLabel)})</th><th class="num">Right Δ (${esc(rightLabel)})</th>
        <th>Stronger résumé</th><th>Margin</th><th class="num">|Δ|</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function resumeDiffIndexHtml(matrix) {
  return resumeComparisonHtml(matrix, 'baseline', 'firstName_aisha-okonkwo');
}

function computeJdCandidates(cells, jdId, matrix) {
  const inJd = cells.filter((c) => c.jd === jdId && c.variant !== 'baseline' && c.delta != null);
  let best = null, worst = null;
  for (const c of inJd) {
    const axisName = c.variant.indexOf('_') >= 0 ? c.variant.slice(0, c.variant.indexOf('_')) : '';
    const levelName = c.variant.indexOf('_') >= 0 ? c.variant.slice(c.variant.indexOf('_') + 1) : c.variant;
    const label = `${matrix.axis_labels?.[axisName] ?? axisName} · ${matrix.level_labels?.[axisName]?.[levelName] ?? levelName}`;
    const entry = { variant: c.variant, label, model: c.model, delta: c.delta };
    if (!best || c.delta > best.delta) best = entry;
    if (!worst || c.delta < worst.delta) worst = entry;
  }
  return { best, worst };
}

function jdsPageHtml({ matrix, jds, jdLabels, jdShortLabels, jdTexts, cells }) {
  const buckets = [
    { min: 1, max: 2, label: 'Junior' },
    { min: 3, max: 5, label: 'Mid / Senior' },
    { min: 6, max: 7, label: 'Manager / Tech Lead' },
    { min: 8, max: 8, label: 'Staff' },
    { min: 9, max: 9, label: 'Principal' },
    { min: 10, max: 10, label: 'Executive' }
  ];
  const seniorityFor = (id) => JD_SENIORITY[id] ?? 5;
  const sorted = [...jds].sort((a, b) => seniorityFor(a) - seniorityFor(b) || a.localeCompare(b));
  const grouped = new Map();
  for (const id of sorted) {
    const s = seniorityFor(id);
    const bucket = buckets.find((b) => s >= b.min && s <= b.max)?.label ?? 'Other';
    if (!grouped.has(bucket)) grouped.set(bucket, []);
    grouped.get(bucket).push(id);
  }
  const renderEntry = (entry, klass) => entry
    ? `${esc(entry.label)} <span class="${klass}">(${fmtSigned(entry.delta, 2)})</span><br><span class="dim">on ${esc(modelDisplay(entry.model))}</span>`
    : '<span class="dim">—</span>';

  const sections = [...grouped].map(([bucket, ids]) => {
    const rows = ids.map((id) => {
      const { best, worst } = computeJdCandidates(cells, id, matrix);
      const md = jdTexts[id] ?? '';
      const body = md ? mdToHtml(md) : '<p class="dim">(JD text not available)</p>';
      return `<details class="jd-row">
        <summary>
          <div class="jd-grid">
            <div class="jd-title"><strong>${esc(jdLabels[id] ?? id)}</strong><br><span class="dim">${esc(jdShortLabels[id] ?? '')} · seniority ${seniorityFor(id)}</span></div>
            <div class="jd-best"><span class="dim">best candidate</span><br>${renderEntry(best, 'accent')}</div>
            <div class="jd-worst"><span class="dim">worst candidate</span><br>${renderEntry(worst, 'alert')}</div>
            <div class="jd-link"><a href="diff.html?jd=${esc(id)}">counterfactuals →</a></div>
          </div>
        </summary>
        <div class="jd-body">${body}</div>
      </details>`;
    }).join('\n');
    return `<div class="panel">
      <div class="panel-head"><span>${esc(bucket.toUpperCase())} — ${ids.length} ROLE${ids.length === 1 ? '' : 'S'}</span></div>
      ${rows}
    </div>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>${jds.length} JOB DESCRIPTIONS</span></div>
    <p>Every one of the 28 résumé variants is scored against each of these jobs by each of the ${matrix.models.length} models in the study. Click any role to expand its full description and see which résumé variant scored best and worst on it.</p>
  </div>
  ${sections}`;
}

function methodologyHtml({ matrix, jds, jdLabels }) {
  const dims = matrix.axes.map((axis) => {
    const levels = (matrix.levels_by_axis?.[axis] ?? []).map((id) => esc(matrix.level_labels?.[axis]?.[id] ?? id)).join(' · ');
    return `<tr><td>${esc(matrix.axis_labels?.[axis] ?? axis)}</td><td>${levels}</td></tr>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>DESIGN</span></div>
    <p>For each (axis, level, model, job description) cell we run the same prompt several times and record the response. The only thing that varies within an axis is one demographic signal on the résumé — the rest of the document is byte-identical to the baseline.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>INFERENCE SETTINGS</span></div>
    <p><strong>Temperature: 0.7</strong> for every model reached over an API (OpenAI-compatible, Google Gemini, Vertex AI for Llama and Qwen, Groq, Mistral). No other sampling parameters (top-p, top-k, seed) were set — provider defaults apply. Each cell was sampled <strong>5 times</strong> and the responses aggregated.</p>
    <p><strong>Caveat — Claude is not strictly comparable.</strong> <code>claude-opus</code> was invoked through the Claude CLI rather than the API, and the CLI call sets no explicit temperature, so Claude ran at the CLI's own default sampling rather than at 0.7. Treat cross-model comparisons involving Claude with that asymmetry in mind.</p>
    <p><strong>Why this matters for significance.</strong> 0.7 is a relatively high temperature, so run-to-run variance is substantial. With only 5 runs per cell the noise floor is high — which is why most per-cell deltas do not clear the 95% confidence threshold against baseline. A future run at lower temperature, or with more samples per cell, would tighten the confidence intervals.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>BIAS DIMENSIONS</span></div>
    <table class="data">
      <thead><tr><th>Dimension</th><th>Variants tested</th></tr></thead>
      <tbody>${dims}</tbody>
    </table>
  </div>
  <div class="panel">
    <div class="panel-head"><span>JOB DESCRIPTIONS — ${jds.length} TOTAL</span></div>
    <ul>${jds.map((id) => `<li>${esc(jdLabels[id] ?? id)}</li>`).join('')}</ul>
  </div>`;
}

function downloadsHtml({ status }) {
  return `<div class="panel">
    <div class="panel-head"><span>${status.n_records.toLocaleString()} INFERENCES · $${status.total_cost_usd.toFixed(2)} SPENT</span></div>
    <table class="data">
      <thead><tr><th>File</th><th>Contents</th></tr></thead>
      <tbody>
        <tr><td><code>data.csv</code></td><td class="dim">Aggregated by (variant, model, jd). One row per cell — n, mean score, recommend rate.</td></tr>
        <tr><td><code>summary.md</code></td><td class="dim">Same table as data.csv plus per-model cost &amp; token breakdown.</td></tr>
        <tr><td><code>matrix.json</code></td><td class="dim">Per-(axis, variant, model) mean Δ aggregated across JDs.</td></tr>
        <tr><td><code>results.ndjson.gz</code></td><td class="dim">Full run-level corpus. One JSON object per inference run.</td></tr>
        <tr><td><code>resumes.json</code></td><td class="dim">Full text of all 28 résumé variants.</td></tr>
      </tbody>
    </table>
  </div>`;
}

function aboutHtml({ status }) {
  return `<div class="panel">
    <div class="panel-head"><span>WHY</span></div>
    <p>LLMs are increasingly used to screen résumés. They are trained on data that contains real-world hiring bias. A counterfactual audit — change one thing and watch the verdict change — is the most direct test of whether that bias survived training.</p>
    <p>This site is a live readout of that audit while data collection runs.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>STATUS</span></div>
    <p>Inferences collected: <strong>${status.n_records.toLocaleString()}</strong> / ${status.expected_total_records.toLocaleString()} · API spend: <strong>$${status.total_cost_usd.toFixed(2)}</strong></p>
  </div>`;
}

async function prerenderHtml({ status, matrixData, topDiffs, axes, models, jds, jdLabels, jdShortLabels, jdTexts, cells, axisLabels, levelLabels, axisDescriptions }) {
  const replacements = {
    'hero': heroHtml(topDiffs, matrixData),
    'bias-index': biasIndexTableHtml(matrixData, {
      title: 'WHICH MODELS ARE THE MOST DEMOGRAPHICALLY SENSITIVE?',
      description: 'For each model, the average absolute score change when one demographic signal on the résumé is altered. Higher = the model treats variants more differently.'
    }),
    'dimension-bias': dimensionBiasTableHtml(matrixData),
    'stats': statsHtml({ status, matrix: matrixData, jdsCount: jds.length }),
    'heatmap-summary': heatmapSummaryHtml(matrixData),
    'top-counterfactuals': topCounterfactualsHtml(topDiffs, matrixData),
    'resume-diff-index': resumeDiffIndexHtml(matrixData),
    'jds': jdsPageHtml({ matrix: matrixData, jds, jdLabels, jdShortLabels, jdTexts, cells }),
    'methodology': methodologyHtml({ matrix: matrixData, jds, jdLabels }),
    'downloads': downloadsHtml({ status }),
    'about': aboutHtml({ status })
  };

  const siteDir = 'site';
  const htmlFiles = (await fs.readdir(siteDir)).filter((f) => f.endsWith('.html'));
  for (const file of htmlFiles) {
    const full = path.join(siteDir, file);
    let html = await fs.readFile(full, 'utf8');
    let changed = false;
    for (const [key, content] of Object.entries(replacements)) {
      const re = new RegExp(`(<!-- @PRERENDER:${key}:START -->)[\\s\\S]*?(<!-- @PRERENDER:${key}:END -->)`, 'g');
      const next = html.replace(re, `$1\n${content}\n$2`);
      if (next !== html) { html = next; changed = true; }
    }
    if (changed) {
      await fs.writeFile(full, html);
      console.log(`  prerendered ${file}`);
    }
  }
}

async function writeSitemap() {
  const pages = ['index.html', 'heatmap.html', 'diff.html', 'resume-diff.html', 'jds.html', 'methodology.html', 'downloads.html', 'about.html'];
  const today = new Date().toISOString().slice(0, 10);
  const urls = pages.map((p) => `  <url>
    <loc>${p === 'index.html' ? '/' : `/${p}`}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
  </url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  await fs.writeFile('site/sitemap.xml', xml);
  console.log('  wrote site/sitemap.xml');
}

async function writeRobots() {
  const robots = `User-agent: *
Allow: /

Sitemap: /sitemap.xml
`;
  await fs.writeFile('site/robots.txt', robots);
}

main();
