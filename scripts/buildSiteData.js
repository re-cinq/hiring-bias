import fs from 'node:fs/promises';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { loadResults, groupBy, mean, stdev, recommendRate, tInterval95 } from '../src/aggregate.js';
import { AXIS_LEVELS } from '../src/generateVariants.js';
import { costFor } from '../src/pricing.js';
import { mdToHtml, esc } from '../site/js/markdown.js';

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
  if (axis === 'anonymize') {
    const map = { name: 'Name blind', all: 'Fully blinded' };
    return map[levelId] ?? titleCase(levelId);
  }
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

const JD_SHORT = {
  jd_junior_fullstack: 'Jr. Fullstack',
  jd_junior_java: 'Jr. Java',
  jd_sde_security_embedded: 'SDE Security / Embedded',
  jd_senior_fullstack: 'Sr. Fullstack',
  jd_senior_ide_jvm: 'Sr. IDE / JVM',
  jd_senior_routing_cpp: 'Sr. Routing (C++)',
  jd_cpp_finance: 'C++ Finance',
  jd_swe_manager_engineering_productivity: 'SWE Manager, Eng Productivity',
  jd_techlead_cloud_compute: 'Tech Lead, Cloud',
  jd_senior_manager_cpp: 'Sr. Manager (C++)',
  jd_head_of_dev_techlead: 'Head of Dev',
  jd_staff_swe_ai_native: 'Staff SWE, AI Native',
  jd_staff_forward_deployed_genai: 'Staff Forward-Deployed (GenAI)',
  jd_principal_swe_growth: 'Principal SWE, Growth',
  jd_principal_perf_architect: 'Principal Perf Architect',
  jd_principal_engineer_specialized: 'Principal, Specialised',
  jd_cto_agentic_fintech: 'CTO, Agentic / Fintech'
};

function axisLabel(axis) {
  return camelCaseToWords(axis);
}

const AXIS_DESCRIPTIONS = {
  firstName: 'Names varied across ethnic and cultural backgrounds. Same résumé, different first name.',
  graduationYear: 'Older graduation years. Same résumé, candidate finished school earlier.',
  addressCountry: 'Country of residence. Same résumé, candidate lives somewhere else.',
  careerGap: 'A two-year break on the timeline, with or without an explanation.',
  companyLocations: 'Geographic location of past employers. Same companies, different home countries.',
  companyNames: 'Prestige tier of past employers (FAANG, mid-tier, regional, non-Western).',
  school: 'University attended. Same degree, different alma mater.',
  anonymize: 'Identifying signals removed (a blind résumé). Tests whether hiding name, employer, school and location reduces the bias seen in the other axes. A score change when a signal is removed reveals the model was relying on it.'
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

// Compact per-JD signed-delta series for the additive-light "bias fingerprint" waves
// on jds.html. One global variant ordering (axes order, then levels within each axis)
// keeps every row's x-axis aligned and comparable.
function buildWaves(cells, axes, models, axisLabels, levelLabels, modelLabels) {
  const variants = [];
  const axisBounds = [];
  for (const axis of axes) {
    const start = variants.length;
    for (const lvl of AXIS_LEVELS[axis]) {
      variants.push({
        id: `${axis}_${lvl.id}`,
        axis,
        level: lvl.id,
        label: `${axisLabels[axis] ?? axis} · ${levelLabels[axis]?.[lvl.id] ?? lvl.id}`
      });
    }
    axisBounds.push({ axis, start, end: variants.length });
  }

  const deltaByKey = new Map();
  let maxAbs = 0;
  for (const c of cells) {
    if (!axes.includes(axisOf(c.variant)) || c.delta == null) continue;
    deltaByKey.set(`${c.variant}|${c.model}|${c.jd}`, c.delta);
    if (Math.abs(c.delta) > maxAbs) maxAbs = Math.abs(c.delta);
  }

  const series = {};
  for (const jd of [...new Set(cells.map((c) => c.jd))]) {
    series[jd] = Object.fromEntries(models.map((model) =>
      [model, variants.map((v) => deltaByKey.get(`${v.id}|${model}|${jd}`) ?? null)]));
  }

  return {
    models,
    modelLabels: Object.fromEntries(models.map((m) => [m, modelLabels[m] ?? m])),
    variants,
    axisBounds,
    maxAbsDelta: Math.ceil(maxAbs * 10) / 10 || 1,
    series
  };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

function pearson(a, b) {
  const xs = [], ys = [];
  for (let i = 0; i < a.length; i++) if (a[i] != null && b[i] != null) { xs.push(a[i]); ys.push(b[i]); }
  if (xs.length < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { const ex = xs[i] - mx, ey = ys[i] - my; num += ex * ey; dx += ex * ex; dy += ey * ey; }
  return (dx === 0 || dy === 0) ? null : num / Math.sqrt(dx * dy);
}

// One signed-Δ vector per model, aligned over the shared (variant, jd) keys, so two
// models' vectors can be correlated to ask "do they react to demographics the same way?".
function modelDeltaVectors(cells, models, axes) {
  const used = cells.filter((c) => axes.includes(axisOf(c.variant)) && c.delta != null);
  const keys = [...new Set(used.map((c) => `${c.variant}|${c.jd}`))].sort();
  const idx = new Map(keys.map((k, i) => [k, i]));
  const vec = Object.fromEntries(models.map((m) => [m, new Array(keys.length).fill(null)]));
  for (const c of used) vec[c.model][idx.get(`${c.variant}|${c.jd}`)] = c.delta;
  return vec;
}

function agreementColor(c) {
  if (c == null) return 'transparent';
  const a = Math.min(1, Math.abs(c)).toFixed(2);
  return c >= 0 ? `rgba(111,174,114,${a})` : `rgba(184,91,91,${a})`;
}

function modelAgreementHtml(cells, axes, models) {
  const vec = modelDeltaVectors(cells, models, axes);
  const head = `<tr><th></th>${models.map((m) => `<th class="num">${esc(MODEL_SHORT[m] ?? m)}</th>`).join('')}</tr>`;
  const rows = models.map((rm) => {
    const tds = models.map((cm) => {
      if (rm === cm) return '<td class="num agree-cell" style="background:rgba(111,174,114,1)">1.00</td>';
      const c = pearson(vec[rm], vec[cm]);
      const txt = c == null ? '–' : (c >= 0 ? '+' : '') + c.toFixed(2);
      return `<td class="num agree-cell" style="background:${agreementColor(c)}">${txt}</td>`;
    }).join('');
    return `<tr><th>${esc(MODEL_SHORT[rm] ?? rm)}</th>${tds}</tr>`;
  }).join('');
  return `<div class="panel">
    <div class="panel-head"><span>DO THE MODELS SHARE THE SAME BIASES?</span></div>
    <p class="dim">Correlation of each model pair's signed Δ across every résumé variant × job. <span class="accent">+1</span> = the two models move scores in lockstep, a shared bias. <span class="dim">0</span> = unrelated. <span class="alert">−1</span> = opposite reactions. This is the number behind the colour-mixing waves on the jobs page.</p>
    <table class="data agreement"><thead>${head}</thead><tbody>${rows}</tbody></table>
  </div>`;
}

function variance(arr) {
  const m = mean(arr);
  return arr.length ? arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length : 0;
}

// Standard-normal CDF (Abramowitz & Stegun 7.1.26), enough for a two-sided p approximation.
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// Volcano data: one point per (variant, model, jd), effect size (Δ) vs significance
// (−log10 p of a Welch t-test, variant scores against the baseline scores for that model+jd).
function buildVolcano(cells, baselines, axes) {
  const points = [];
  for (const c of cells) {
    if (!axes.includes(axisOf(c.variant)) || c.delta == null) continue;
    const b = baselines.get(`${c.model}|${c.jd}`);
    if (!b?.scores?.length || !c.scores?.length) continue;
    const se = Math.sqrt(variance(c.scores) / c.scores.length + variance(b.scores) / b.scores.length);
    let neglog10p;
    if (se === 0) neglog10p = c.delta === 0 ? 0 : 8;
    else {
      const p = Math.max(2 * (1 - normalCdf(Math.abs(c.delta / se))), 1e-8);
      neglog10p = -Math.log10(p);
    }
    points.push({
      axis: axisOf(c.variant), level: levelOf(c.variant), model: c.model, jd: c.jd,
      delta: round3(c.delta), sig: round3(neglog10p), significant: c.significant
    });
  }
  return { threshold: round3(-Math.log10(0.05)), points };
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

// Per-cell sampling for the audit + diff UI. We expose two samples:
//   sample       , the lowest-run record (stable, backfill-safe; what the UI shows by default)
//   sample_median, the record whose score is closest to the cell mean (most-typical run; used
//                    as the second opinion in the audit so verdicts aren't held hostage to run 1).
function indexFirstRunRecord(records) {
  const byCell = new Map();
  for (const r of records) {
    const key = `${r.variant}__${r.model}__${r.jd}`;
    const existing = byCell.get(key);
    if (!existing || r.run < existing.run) byCell.set(key, r);
  }
  return byCell;
}

function indexMedianRunRecord(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.variant}__${r.model}__${r.jd}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = new Map();
  for (const [key, group] of groups) {
    const scored = group.filter((r) => typeof r.response?.score === 'number');
    if (scored.length === 0) continue;
    const m = mean(scored.map((r) => r.response.score));
    const pick = scored.reduce((acc, r) =>
      Math.abs(r.response.score - m) < Math.abs(acc.response.score - m) ? r : acc);
    out.set(key, pick);
  }
  return out;
}

function countRunsByCell(records) {
  const counts = new Map();
  for (const r of records) {
    const key = `${r.variant}__${r.model}__${r.jd}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// Group all run records per cell, sorted by run number ascending. Used to expose every
// per-run evaluation on the diff page so a reader can step through the 5 runs.
function indexAllRunsByCell(records) {
  const byCell = new Map();
  for (const r of records) {
    const key = `${r.variant}__${r.model}__${r.jd}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(r);
  }
  for (const arr of byCell.values()) arr.sort((a, b) => (a.run ?? 0) - (b.run ?? 0));
  return byCell;
}

function buildDiffObjects(cells, records) {
  const firstByCell = indexFirstRunRecord(records);
  const medianByCell = indexMedianRunRecord(records);
  const countByCell = countRunsByCell(records);
  const allByCell = indexAllRunsByCell(records);
  // Index baseline cells so we can pull baseline per-run scores for the run-bar display.
  const cellByKey = new Map(cells.map((c) => [`${c.variant}__${c.model}__${c.jd}`, c]));
  const out = [];
  for (const c of cells) {
    if (c.delta == null || c.variant === 'baseline') continue;
    const variantKey = `${c.variant}__${c.model}__${c.jd}`;
    const baselineKey = `baseline__${c.model}__${c.jd}`;
    const variantFirst = firstByCell.get(variantKey);
    const baselineFirst = firstByCell.get(baselineKey);
    if (!variantFirst || !baselineFirst) continue;
    const variantMedian = medianByCell.get(variantKey);
    const baselineMedian = medianByCell.get(baselineKey);
    const baselineCell = cellByKey.get(baselineKey);
    out.push({
      id: variantKey,
      variant: c.variant, axis: axisOf(c.variant), level: levelOf(c.variant),
      model: c.model, jd: c.jd,
      delta: c.delta, ci_overlap: !c.significant,
      n_runs_variant: countByCell.get(variantKey) ?? 0,
      n_runs_baseline: countByCell.get(baselineKey) ?? 0,
      baseline: {
        mean: c.baseline_mean,
        recommend_rate: c.baseline_recommend_rate,
        scores: baselineCell?.scores ?? null,
        sample: baselineFirst.response,
        sample_median: baselineMedian?.response ?? null,
        runs: (allByCell.get(baselineKey) ?? []).map((r) => ({ run: r.run, response: r.response }))
      },
      variant_data: {
        mean: c.mean,
        recommend_rate: c.recommend_yes_rate,
        scores: c.scores ?? null,
        sample: variantFirst.response,
        sample_median: variantMedian?.response ?? null,
        runs: (allByCell.get(variantKey) ?? []).map((r) => ({ run: r.run, response: r.response }))
      }
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
    // New shape stores first_run + median_run; old shape is a single flat verdict. Take median
    // as primary (more representative of the cell) and surface the run-1 second opinion separately.
    const isTwoVerdict = a.first_run && a.median_run;
    const primary = isTwoVerdict ? a.median_run : a;
    const second = isTwoVerdict ? a.first_run : null;
    out.set(a.id, {
      verdict: primary.verdict,
      confidence: primary.confidence,
      rationale: primary.rationale,
      bias_signals: primary.bias_signals ?? [],
      auditor: a.auditor ?? null,
      second_opinion: second ? {
        verdict: second.verdict,
        confidence: second.confidence,
        rationale: second.rationale,
        bias_signals: second.bias_signals ?? []
      } : null,
      verdicts_agree: isTwoVerdict ? primary.verdict === second.verdict : null
    });
  }
  return out;
}

// Loads the raw audit records (preserving first_run / median_run / samples_coincide), used for
// the stability stat and the audit-verdicts CSV. loadAudits() above embeds a flattened verdict
// per cell for the diff JSONs; this one keeps the structure intact.
async function loadAuditsRaw() {
  const out = [];
  if (!(await fs.access(AUDITS_DIR).then(() => true, () => false))) return out;
  const files = (await fs.readdir(AUDITS_DIR)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    out.push(JSON.parse(await fs.readFile(path.join(AUDITS_DIR, file), 'utf8')));
  }
  return out;
}

// Two-sample audit stability: of the audits where the auditor judged TWO genuinely different
// sampled pairs, how often did the verdict flip? Records where samples_coincide=true cannot
// disagree by construction (only one pair was actually judged) and so don't enter the denominator.
function auditStabilityStats(records) {
  const total = records.length;
  const verdicts = ['bias', 'justified', 'mixed'];
  const matrix = Object.fromEntries(verdicts.map((v) => [v, Object.fromEntries(verdicts.map((w) => [w, 0]))]));
  let coincide = 0, agree = 0, disagree = 0;
  for (const r of records) {
    if (!r.first_run || !r.median_run) continue;
    if (r.samples_coincide) { coincide++; continue; }
    if (r.verdicts_agree) agree++; else disagree++;
    const a = r.first_run.verdict, b = r.median_run.verdict;
    if (matrix[a] && matrix[a][b] != null) matrix[a][b]++;
  }
  const distinctPairs = agree + disagree;
  return {
    total,
    coincide,
    distinct_pairs: distinctPairs,
    disagree,
    disagree_pct: distinctPairs ? (100 * disagree / distinctPairs) : null,
    verdicts,
    matrix
  };
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function writeAuditVerdictsCsv(records) {
  const headers = [
    'id', 'variant', 'axis', 'level', 'model', 'jd', 'delta',
    'samples_coincide', 'first_verdict', 'first_confidence',
    'median_verdict', 'median_confidence', 'verdicts_agree', 'auditor', 'timestamp'
  ];
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push([
      r.id, r.variant, r.axis, r.level, r.model, r.jd, r.delta,
      r.samples_coincide, r.first_run?.verdict, r.first_run?.confidence,
      r.median_run?.verdict, r.median_run?.confidence, r.verdicts_agree,
      r.auditor, r.timestamp
    ].map(csvEscape).join(','));
  }
  const full = path.join(OUT_DIR, 'raw/audit-verdicts.csv');
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, lines.join('\n') + '\n');
  const stat = await fs.stat(full);
  return { relpath: 'raw/audit-verdicts.csv', size: stat.size };
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

  outputs.push(await writeJson('waves.json', buildWaves(cells, axes, models, axisLabels, levelLabels, MODEL_DISPLAY)));
  outputs.push(await writeJson('volcano.json', buildVolcano(cells, baselines, axes)));

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

  const auditsRaw = await loadAuditsRaw();
  const auditStability = auditStabilityStats(auditsRaw);
  outputs.push(await writeAuditVerdictsCsv(auditsRaw));

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
    axisLabels, levelLabels, axisDescriptions, auditStability
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
  'claude-sonnet': 'Claude Sonnet',
  'claude-haiku': 'Claude Haiku',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro · Preview',
  'llama-4-maverick': 'Llama 4 Maverick',
  'mistral-large': 'Mistral Large',
  'mistral-small': 'Mistral Small',
  'qwen-3-next-80b': 'Qwen 3 Next 80B'
};

const MODEL_SHORT = {
  'claude-opus': 'Opus',
  'claude-sonnet': 'Sonnet',
  'claude-haiku': 'Haiku',
  'gemini-2.5-flash': '2.5 Flash',
  'gemini-2.5-pro': '2.5 Pro',
  'gemini-3.1-pro-preview': '3.1 Pro',
  'llama-4-maverick': 'Llama 4',
  'mistral-large': 'Mistral L',
  'mistral-small': 'Mistral S',
  'qwen-3-next-80b': 'Qwen 3'
};

function modelDisplay(m) { return MODEL_DISPLAY[m] ?? m; }

function signedClass(v) {
  if (v == null) return 'dim';
  if (v > 0.02) return 'accent';
  if (v < -0.02) return 'alert';
  return 'dim';
}

function fmtSigned(v, digits = 2) {
  if (v == null) return '–';
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
  if (!entry) return '<span class="dim">–</span>';
  const lbl = `${esc(matrix.axis_labels?.[entry.axis] ?? entry.axis)} · ${esc(matrix.level_labels?.[entry.axis]?.[entry.level] ?? entry.level)}`;
  return `${lbl} <span class="${klass}">(${fmtSigned(entry.mean_delta, 2)})</span>`;
}

function biasIndexTableHtml(matrix, opts = {}) {
  const title = opts.title ?? 'GLOBAL BIAS INDEX · MEAN |Δ| ACROSS ALL CELLS';
  const description = opts.description ?? 'For each model, the average absolute score change when a demographic signal is altered, taken over every (axis, variant, JD) cell with data. Higher = the model is more sensitive to demographic signals; lower = more even-handed.';
  const stats = computeBiasIndexSnapshot(matrix);
  const worldMax = Math.max(...stats.map((s) => s.mean_abs ?? 0), 0.0001);
  const rows = stats.map((s) => {
    const pct = ((s.mean_abs ?? 0) / worldMax * 100).toFixed(0);
    return `<tr>
      <td>${esc(modelDisplay(s.model))}</td>
      <td style="width:20%"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:9px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent)"></div></div></div></td>
      <td class="num">${s.mean_abs != null ? s.mean_abs.toFixed(3) : '–'}</td>
      <td class="num ${signedClass(s.mean_signed)}">${fmtSigned(s.mean_signed, 3)}</td>
      <td class="num">${s.sig_frac != null ? (s.sig_frac * 100).toFixed(0) + '%' : '–'}</td>
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
      <td class="num">${s.mean_abs != null ? s.mean_abs.toFixed(3) : '–'}</td>
      <td class="num ${signedClass(s.mean_signed)}">${fmtSigned(s.mean_signed, 3)}</td>
      <td class="num">${s.sig_frac != null ? (s.sig_frac * 100).toFixed(0) + '%' : '–'}</td>
      <td class="num dim">${s.n}</td>
    </tr>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>WHICH DIMENSION TRIGGERS THE MOST BIAS?</span></div>
    <p class="dim">Same data, grouped by what we changed instead of who did the changing. The mean |Δ| pools every model, variant, and job for each demographic axis. The axis at the top is the one models react to most reliably.</p>
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

function variantCountOf(matrix) {
  return 1 + matrix.axes.reduce((s, a) => s + (matrix.levels_by_axis?.[a]?.length ?? 0), 0);
}

function statsHtml({ status, matrix, jdsCount }) {
  const variantCount = variantCountOf(matrix);
  const tiles = [
    ['Resume variants tested', String(variantCount), `baseline + ${variantCount - 1} résumé variants`],
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
    <div class="panel-head"><span>TOP COUNTERFACTUALS · CASES WITH THE LARGEST Δ</span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px">${items}</div>
  </div>`;
}

function heatmapSummaryHtml(matrix) {
  const stats = computeBiasIndexSnapshot(matrix);
  const lines = stats.slice(0, 3).map((s) => `<li><strong>${esc(modelDisplay(s.model))}</strong>: mean |Δ| ${s.mean_abs != null ? s.mean_abs.toFixed(3) : '–'}. Most penalised ${variantWithDeltaHtml(matrix, s.worst, 'alert')}, most rewarded ${variantWithDeltaHtml(matrix, s.best, 'accent')}.</li>`).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>WHAT THE WALL SHOWS · TOP MODELS BY BIAS INDEX</span></div>
    <p class="dim">The interactive 3D wall above lets you inspect every (variant, JD) cell for any (model, dimension) pair. Below is a static summary of the three most demographically-sensitive models. Pick another pair in the controls to update the wall.</p>
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

function deltaBarHtml(l, r) {
  if (l == null && r == null) return '<span class="dim">–</span>';
  const pos = (v) => `${Math.max(0, Math.min(100, (v + 3) / 6 * 100)).toFixed(1)}%`;
  const cls = (v) => v == null ? '' : (Math.abs(v) < 0.005 ? 'zero' : v > 0 ? 'pos' : 'neg');
  const leftDot = l == null ? '' : `<div class="marker filled ${cls(l)}" style="left:${pos(l)}" title="Left: ${fmtSigned(l, 3)}"></div>`;
  const rightDot = r == null ? '' : `<div class="marker hollow ${cls(r)}" style="left:${pos(r)}" title="Right: ${fmtSigned(r, 3)}"></div>`;
  return `<div class="delta-bar">
    <div class="tick" style="left:16.67%" title="−2"></div>
    <div class="tick" style="left:33.33%" title="−1"></div>
    <div class="tick center" style="left:50%" title="0 (baseline)"></div>
    <div class="tick" style="left:66.67%" title="+1"></div>
    <div class="tick" style="left:83.33%" title="+2"></div>
    ${leftDot}${rightDot}
  </div>
  <div class="delta-bar-scale"><span>-3</span><span>-2</span><span>-1</span><span>0</span><span>+1</span><span>+2</span><span>+3</span></div>`;
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
  const body = rows.map((s) => {
    let winner;
    if (s.diff == null) winner = '<span class="dim">no data</span>';
    else if (Math.abs(s.diff) < 0.005) winner = '<span class="dim">tie</span>';
    else winner = `<span class="${s.diff > 0 ? 'accent' : 'alert'}">${esc(s.diff > 0 ? rightLabel : leftLabel)}</span>`;
    return `<tr>
      <td rowspan="2">${esc(modelDisplay(s.model))}</td>
      <td class="num ${signedClass(s.l)}">${fmtSigned(s.l, 3)}</td>
      <td class="num ${signedClass(s.r)}">${fmtSigned(s.r, 3)}</td>
      <td rowspan="2">${winner}</td>
    </tr>
    <tr>
      <td class="delta-bar-cell" colspan="2">${deltaBarHtml(s.l, s.r)}</td>
    </tr>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>HOW EACH MODEL SCORES THESE TWO RÉSUMÉS</span></div>
    <p class="dim">Each model's average score change versus the unmodified baseline, pooled across all jobs with data. Bar scale is fixed −3 to +3.</p>
    <div class="bar-legend">
      <span><span class="swatch filled"></span> <strong>Left</strong> résumé</span>
      <span><span class="swatch hollow"></span> <strong>Right</strong> résumé</span>
      <span><span class="swatch tick"></span> baseline (Δ = 0)</span>
      <span class="accent"><span class="swatch filled" style="color:var(--accent)"></span> above baseline</span>
      <span class="alert"><span class="swatch filled" style="color:var(--alert)"></span> below baseline</span>
    </div>
    <table class="data rs-table">
      <thead><tr>
        <th>Model</th><th class="num">Left</th><th class="num">Right</th><th>Winner</th>
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
    : '<span class="dim">–</span>';

  const sections = [...grouped].map(([bucket, ids]) => {
    const rows = ids.map((id) => {
      const { best, worst } = computeJdCandidates(cells, id, matrix);
      const md = jdTexts[id] ?? '';
      const body = md ? mdToHtml(md) : '<p class="dim">(JD text not available)</p>';
      return `<details class="jd-row">
        <summary>
          <div class="jd-grid">
            <div class="jd-title"><strong>${esc(jdLabels[id] ?? id)}</strong><br><span class="dim">${esc(jdShortLabels[id] ?? '')} · seniority ${seniorityFor(id)}</span><canvas class="jd-wave" data-jd="${esc(id)}"></canvas></div>
            <div class="jd-best"><span class="dim">best candidate</span><br>${renderEntry(best, 'accent')}</div>
            <div class="jd-worst"><span class="dim">worst candidate</span><br>${renderEntry(worst, 'alert')}</div>
            <div class="jd-link"><a href="diff.html?jd=${esc(id)}">counterfactuals →</a></div>
          </div>
        </summary>
        <div class="jd-body">${body}</div>
      </details>`;
    }).join('\n');
    return `<div class="panel">
      <div class="panel-head"><span>${esc(bucket.toUpperCase())} · ${ids.length} ROLE${ids.length === 1 ? '' : 'S'}</span></div>
      ${rows}
    </div>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>${jds.length} JOB DESCRIPTIONS</span></div>
    <p>Every one of the ${variantCountOf(matrix)} résumé variants is scored against each of these jobs by each of the ${matrix.models.length} models in the study. Click any role to expand its full description and see which résumé variant scored best and worst on it.</p>
    <p class="dim">Each role shows a "bias fingerprint": one line per model, x = résumé variants grouped by dimension, y = score Δ vs the baseline résumé. Where the models agree, their colours add toward white. That brightness is shared bias.</p>
    <div class="wave-legend" id="wave-legend"></div>
  </div>
  ${sections}`;
}

function auditStabilityPanelHtml(stats) {
  if (!stats || stats.total === 0) return '';
  const pct = stats.disagree_pct == null ? '–' : stats.disagree_pct.toFixed(2) + '%';
  const denom = stats.distinct_pairs;
  return `<div class="panel">
    <div class="panel-head"><span>AUDITOR STABILITY · DOES THE JUDGE FLIP?</span></div>
    <p>Every audited cell is judged twice, once on the first-run sample and once on the median-typical sample. When the two samples are different evaluations, the auditor can in principle disagree with itself. This stat measures how often it does.</p>
    <p><strong>Disagreement rate (when two distinct sampled pairs were judged): <span class="alert">${pct}</span></strong> &nbsp;(${stats.disagree} of ${denom} cells).</p>
    ${confusionMatrixHtml(stats)}
    <p class="dim">Of <strong>${stats.total.toLocaleString()}</strong> total audited cells, <strong>${stats.coincide.toLocaleString()}</strong> had identical first-and-median samples (a single pair selected twice, no disagreement possible by construction) and were excluded from the denominator. The remaining <strong>${denom.toLocaleString()}</strong> cells had two genuinely different sampled pairs from the same cell, and on that set, the auditor returned a different verdict <strong>${pct}</strong> of the time. This is the empirical reason we aggregate over five runs per cell rather than relying on a single judgement: at temperature 0.7, even an LLM judge faced with two different samples of <em>the same</em> bias case will not always agree with itself.</p>
  </div>
  `;
}

// 3x3 confusion matrix of first-run vs median-run verdicts. Diagonals = agreement (accent-tinted),
// off-diagonals = disagreement (alert-tinted), with cell-shade intensity scaled to the count.
function confusionMatrixHtml(stats) {
  const verdicts = stats.verdicts;
  const mat = stats.matrix;
  let maxCount = 0;
  for (const a of verdicts) for (const b of verdicts) maxCount = Math.max(maxCount, mat[a][b]);
  const cell = (a, b) => {
    const c = mat[a][b];
    const intensity = maxCount ? c / maxCount : 0;
    const klass = a === b ? 'agree' : 'disagree';
    const alpha = (0.08 + 0.5 * intensity).toFixed(3);
    const bg = a === b
      ? `rgba(111, 174, 114, ${alpha})`
      : `rgba(184, 91, 91, ${alpha})`;
    return `<td class="num cm-${klass}" style="background:${bg}">${c}</td>`;
  };
  const header = verdicts.map((v) => `<th class="num">${v}</th>`).join('');
  const rowTotals = verdicts.map((a) => verdicts.reduce((s, b) => s + mat[a][b], 0));
  const rows = verdicts.map((a, i) => `
    <tr>
      <th class="cm-row">${a}</th>
      ${verdicts.map((b) => cell(a, b)).join('')}
      <td class="num dim cm-rowtotal">${rowTotals[i]}</td>
    </tr>`).join('');
  const colsTotal = verdicts.map((b) => verdicts.reduce((s, a) => s + mat[a][b], 0));
  const grandTotal = colsTotal.reduce((s, c) => s + c, 0);
  const flipBJ = mat.bias.justified;
  const flipJB = mat.justified.bias;
  const asymmetry = flipJB ? (flipBJ / flipJB).toFixed(2) : '–';
  return `<div class="cm-wrap">
    <p class="cm-howto"><strong>How to read this:</strong> each cell counts (variant × model × JD) pairs where the judge said <em>X</em> about the first sampled run and <em>Y</em> about the median-typical run. <span class="cm-key cm-key-agree">●</span> green = same verdict (judge agreed with itself); <span class="cm-key cm-key-disagree">●</span> red = different verdict (judge flipped).</p>
    <table class="data cm">
      <thead>
        <tr><th></th><th colspan="${verdicts.length}" class="cm-axis-label">JUDGE'S VERDICT ON THE MEDIAN-TYPICAL SAMPLE →</th><th></th></tr>
        <tr><th class="cm-axis-label rot">JUDGE'S VERDICT ON THE FIRST SAMPLE ↓</th>${header}<th class="num cm-axis-label">row total</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <th class="dim">col total</th>
          ${colsTotal.map((c) => `<td class="num dim">${c}</td>`).join('')}
          <td class="num dim"><strong>${grandTotal}</strong></td>
        </tr>
      </tfoot>
    </table>
    <p class="dim cm-caption">
      Diagonal cells (green) are where the auditor agreed with itself; off-diagonal cells (red) are flips. The largest flip cell is
      <strong>bias → justified</strong> at <strong>${flipBJ}</strong> cases, the judge said the first sample looked like bias but later judged the median sample as justified. The reverse direction, <strong>justified → bias</strong>, is only <strong>${flipJB}</strong> cases. That ${asymmetry}× asymmetry matters: it means a single-sample audit on the <em>first</em> run would systematically over-call bias compared to one that picks a more representative sample.
    </p>
  </div>
  `;
}

function methodologyHtml({ matrix, jds, jdLabels, auditStability }) {
  const dims = matrix.axes.map((axis) => {
    const levels = (matrix.levels_by_axis?.[axis] ?? []).map((id) => esc(matrix.level_labels?.[axis]?.[id] ?? id)).join(' · ');
    return `<tr><td>${esc(matrix.axis_labels?.[axis] ?? axis)}</td><td>${levels}</td></tr>`;
  }).join('\n');
  return `<div class="panel">
    <div class="panel-head"><span>DESIGN</span></div>
    <p>For each (axis, level, model, job description) cell we run the same prompt several times and record the response. For the injection axes, the only thing that varies is one demographic signal on the résumé. The rest of the document is byte-identical to the baseline.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>TWO ARMS · PROBE AND MITIGATION</span></div>
    <p><strong>Injection probes</strong> swap a single signal (name, country, school, employer, and so on) into an otherwise identical résumé and ask whether the verdict moves. <strong>The anonymization arm runs the opposite test:</strong> it <em>removes</em> identifying and prestige signals (the name, contact details, employers, schools, locations and dates are replaced with neutral placeholders) and asks whether blinding the résumé reduces the bias the probes expose.</p>
    <p>The logic is symmetric: if a candidate's qualifications are unchanged and the score still moves when a signal is <em>hidden</em>, the model was relying on that signal. <code>anonymize_name</code> blinds only identity (name, contact, personal links); <code>anonymize_all</code> additionally blinds employers, schools, locations and dates.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>INFERENCE SETTINGS</span></div>
    <p><strong>Temperature: 0.7</strong> for every model reached over an API (OpenAI-compatible, Google Gemini, Vertex AI for Llama and Qwen, Groq, Mistral). No other sampling parameters (top-p, top-k, seed) were set; provider defaults apply. Each cell was sampled <strong>5 times</strong> and the responses aggregated.</p>
    <p><strong>Caveat: Claude is not strictly comparable.</strong> <code>claude-opus</code> was invoked through the Claude CLI rather than the API, and the CLI call sets no explicit temperature, so Claude ran at the CLI's own default sampling rather than at 0.7. Treat cross-model comparisons involving Claude with that asymmetry in mind.</p>
    <p><strong>Why this matters for significance.</strong> 0.7 is a relatively high temperature, so run-to-run variance is substantial. With only 5 runs per cell the noise floor is high, which is why most per-cell deltas do not clear the 95% confidence threshold against baseline. A future run at lower temperature, or with more samples per cell, would tighten the confidence intervals.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>AUDIT METHODOLOGY · HOW VERDICTS ARE PRODUCED</span></div>
    <p>Each (variant, model, JD) cell with 5 collected runs is audited by <code>gemini-2.5-pro</code> acting as an LLM-as-judge. Cells with fewer than 5 runs are skipped until backfill completes, so every verdict is produced against a complete sample.</p>
    <p><strong>Two samples per cell, two verdicts.</strong> The auditor sees the cell's mean Δ and run count as statistical context, then judges <em>two</em> matched evaluation pairs from the run set: (1) the first run and (2) the run whose score sits closest to the cell's mean (the "most-typical" run). The site shows the median-run verdict as the headline; the first-run verdict is kept as a second opinion. A <code>verdicts_agree</code> flag marks cells where the two samples reached different conclusions, those are the cases where a single-pair audit would have been brittle.</p>
    <p><strong>What an audit verdict means and does not mean.</strong> A verdict is a judgement on the <em>reasoning</em> visible in one evaluation pair, not on the per-cell statistical effect. A "bias" verdict says the model's justification keyed off the demographic signal in the sample shown to the auditor; it does not by itself certify that the mean Δ over 5 runs would clear a 95% significance threshold. Read verdicts alongside the volcano plot and per-cell CIs.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>WHY THIS AUDIT EXISTS</span></div>
    <p>Aggregate score deltas tell you <em>that</em> a model shifted its verdict when a demographic signal changed. They do not tell you <em>why</em>. A 0.5-point drop on a candidate from Lagos could be the model penalizing the location, or it could be the model legitimately picking up on a different concern that happened to surface in that pair. The audit reads the model's own justification and decides which of those is happening, a kind of post-hoc explainability layer for the counterfactual signal.</p>
    <p>The verdict triple, <code>justified</code> / <code>bias</code> / <code>mixed</code>, plus the verbatim <code>bias_signals</code> quotes give a human reader something to grep for and verify directly against the model's own words. That is the artifact a reader can argue with: not an opaque score, but a quotation.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>JUDGE SELECTION · COSTS AND TRADEOFFS</span></div>
    <p>We considered five candidate judges before settling on <code>gemini-2.5-pro</code>. Costs below assume a complete corpus (~4,930 variant cells × ~1.8 prompts/cell × ~1.2k input / ~200 output tokens per prompt).</p>
    <table class="data">
      <thead><tr><th>Candidate</th><th class="num">Est. cost</th><th>Quality trade-off</th></tr></thead>
      <tbody>
        <tr><td><code>gemini-3.1-flash-lite</code> (batch)</td><td class="num">~$3</td><td class="dim">Cheapest. Risk of false negatives on subtle bias, under-calling justified what a stronger model would flag.</td></tr>
        <tr><td><code>gemini-2.5-flash</code></td><td class="num">~$8</td><td class="dim">Acceptable on clear cases. Same false-negative concern as Lite, smaller magnitude.</td></tr>
        <tr><td><strong><code>gemini-2.5-pro</code></strong> (chosen)</td><td class="num"><strong>~$31</strong></td><td>Strong nuanced reasoning. Reliable structured-JSON output. Best quality-for-money on this task and not one of the models being audited.</td></tr>
        <tr><td><code>gemini-3.1-pro-preview</code></td><td class="num">~$53</td><td class="dim">Highest quality but preview-tier (rate-limit and price churn risk).</td></tr>
        <tr><td><code>claude-opus</code></td><td class="num">~$294*</td><td class="dim">High quality but expensive at the API tier. Also one of the audited models, risk of self-judging.</td></tr>
      </tbody>
    </table>
    <p class="dim">* API-equivalent. The pilot audits were run via the Claude CLI subscription where token spend doesn't appear on an API invoice.</p>
    <p><strong>Why not a cheaper judge.</strong> Under-calling bias (false negatives) is the more damaging failure mode for an audit whose purpose is to surface bias. The Lite/Flash tiers historically trade reasoning depth for cost; on a binary "is this reasoning biased" task with subtle linguistic cues, that trade hurts the audit's headline claim more than it saves on the bill.</p>
    <p><strong>Why not cross-judge validation.</strong> A defensible alternative is running two judges per cell and treating disagreement as a third signal. We opted instead for the two-sample design (first-run + median-typical run, same judge) because it isolates a different error source, sample selection, that the current single-pair audit was most exposed to. Cross-judge can be layered on later without re-running collection.</p>
    <p><strong>Self-judging caveat.</strong> Every Gemini variant, including the chosen judge, is itself in the audited set, so the audit is asking <code>gemini-2.5-pro</code> to render verdicts on outputs from <code>gemini-2.5-pro</code>, <code>gemini-2.5-flash</code>, and <code>gemini-3.1-pro-preview</code> among others. Models are known to favour their own family's outputs in head-to-head judging; the structured rubric and verbatim <code>bias_signals</code> quotes blunt this but do not eliminate it. A fully external judge (e.g. a frontier OpenAI model not in this study) would close that gap at additional cost.</p>
  </div>
  ${auditStabilityPanelHtml(auditStability)}
  <div class="panel">
    <div class="panel-head"><span>BIAS DIMENSIONS</span></div>
    <table class="data">
      <thead><tr><th>Dimension</th><th>Variants tested</th></tr></thead>
      <tbody>${dims}</tbody>
    </table>
  </div>
  <div class="panel">
    <div class="panel-head"><span>JOB DESCRIPTIONS · ${jds.length} TOTAL</span></div>
    <ul>${jds.map((id) => `<li>${esc(jdLabels[id] ?? id)}</li>`).join('')}</ul>
  </div>`;
}

function downloadsHtml({ status, matrix }) {
  return `<div class="panel">
    <div class="panel-head"><span>${status.n_records.toLocaleString()} INFERENCES · $${status.total_cost_usd.toFixed(2)} SPENT</span></div>
    <table class="data">
      <thead><tr><th>File</th><th>Contents</th></tr></thead>
      <tbody>
        <tr><td><code>data.csv</code></td><td class="dim">Aggregated by (variant, model, jd). One row per cell with n, mean score, and recommend rate.</td></tr>
        <tr><td><code>summary.md</code></td><td class="dim">Same table as data.csv plus per-model cost &amp; token breakdown.</td></tr>
        <tr><td><code>matrix.json</code></td><td class="dim">Per-(axis, variant, model) mean Δ aggregated across JDs.</td></tr>
        <tr><td><code>results.ndjson.gz</code></td><td class="dim">Full run-level corpus. One JSON object per inference run.</td></tr>
        <tr><td><code>raw/audit-verdicts.csv</code></td><td class="dim">One row per audited cell. Both first-run and median-run verdicts plus the <code>verdicts_agree</code> flag, so you can recompute the disagreement rate yourself.</td></tr>
        <tr><td><code>resumes.json</code></td><td class="dim">Full text of all ${variantCountOf(matrix)} résumé variants.</td></tr>
      </tbody>
    </table>
  </div>`;
}

function aboutHtml({ status }) {
  return `<div class="panel">
    <div class="panel-head"><span>WHY</span></div>
    <p>LLMs are increasingly used to screen résumés. They are trained on data that contains real-world hiring bias. A counterfactual audit (change one thing, watch the verdict change) is the most direct test of whether that bias survived training.</p>
    <p>This site is a live readout of that audit while data collection runs.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>STATUS</span></div>
    <p>Inferences collected: <strong>${status.n_records.toLocaleString()}</strong> / ${status.expected_total_records.toLocaleString()} · API spend: <strong>$${status.total_cost_usd.toFixed(2)}</strong></p>
  </div>`;
}

async function prerenderHtml({ status, matrixData, topDiffs, axes, models, jds, jdLabels, jdShortLabels, jdTexts, cells, axisLabels, levelLabels, axisDescriptions, auditStability }) {
  const replacements = {
    'hero': heroHtml(topDiffs, matrixData),
    'bias-index': biasIndexTableHtml(matrixData, {
      title: 'WHICH MODELS ARE THE MOST DEMOGRAPHICALLY SENSITIVE?',
      description: 'Each row is one model. We measure how far that model\'s score moves, on average, when we swap a single demographic signal on the résumé. The higher the number, the less even-handed the model. "Most penalised" and "most rewarded" call out the single variant that swung scores furthest in each direction.'
    }),
    'dimension-bias': dimensionBiasTableHtml(matrixData),
    'stats': statsHtml({ status, matrix: matrixData, jdsCount: jds.length }),
    'heatmap-summary': heatmapSummaryHtml(matrixData),
    'top-counterfactuals': topCounterfactualsHtml(topDiffs, matrixData),
    'resume-diff-index': resumeDiffIndexHtml(matrixData),
    'jds': jdsPageHtml({ matrix: matrixData, jds, jdLabels, jdShortLabels, jdTexts, cells }),
    'methodology': methodologyHtml({ matrix: matrixData, jds, jdLabels, auditStability }),
    'downloads': downloadsHtml({ status, matrix: matrixData }),
    'about': aboutHtml({ status }),
    'model-agreement': modelAgreementHtml(cells, axes, models)
  };

  const siteDir = 'site';
  const htmlFiles = (await fs.readdir(siteDir)).filter((f) => f.endsWith('.html'));
  for (const file of htmlFiles) {
    const full = path.join(siteDir, file);
    let html = await fs.readFile(full, 'utf8');
    let changed = false;
    for (const [key, content] of Object.entries(replacements)) {
      const re = new RegExp(`(<!-- @PRERENDER:${key}:START -->)[\\s\\S]*?(<!-- @PRERENDER:${key}:END -->)`, 'g');
      // Use a callback so any `$` characters in content (e.g. dollar amounts) aren't
      // interpreted as regex back-references by String.prototype.replace.
      const next = html.replace(re, (_, startTag, endTag) => `${startTag}\n${content}\n${endTag}`);
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
