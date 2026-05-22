import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { activeModels } from './providers/index.js';
import { buildPrompt } from './prompt.js';

const RUNS_PER_CELL = Number(process.env.BIAS_RUNS_PER_CELL ?? 5);
const CONCURRENCY = Number(process.env.BIAS_CONCURRENCY ?? 4);
const VARIANTS_DIR = 'data/variants';
const JDS_DIR = 'data/jds';
const RESULTS_DIR = 'results';

function enforce(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function loadMarkdownFiles(dir) {
  const entries = await fs.readdir(dir);
  const out = [];
  for (const file of entries) {
    if (!file.endsWith('.md')) continue;
    const content = await fs.readFile(path.join(dir, file), 'utf8');
    out.push({ name: path.basename(file, '.md'), content });
  }
  return out;
}

function resultPath(variantName, modelSlot, jdName, run) {
  return path.join(RESULTS_DIR, `${variantName}__${modelSlot}__${jdName}__run${run}.json`);
}

async function fileExists(p) {
  return fs.access(p).then(() => true, () => false);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Billing/auth failures will never succeed on retry — fail immediately instead of hammering.
function isFatal(err) {
  const m = (err?.message ?? '').toLowerCase();
  return m.includes('credit balance is too low') || m.includes('api_error_status":400')
    || m.includes('401') || m.includes('403') || m.includes('authentication');
}

// Retry transient provider failures — rate limits, overload, truncated/malformed JSON.
async function callWithRetry(model, prompt, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await model.call(prompt);
    } catch (err) {
      lastErr = err;
      if (isFatal(err) || attempt === retries) break;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function runOne(variant, model, jd, run) {
  const target = resultPath(variant.name, model.slot, jd.name, run);
  if (await fileExists(target)) return { skipped: true };

  const prompt = buildPrompt(jd.content, variant.content);
  const startedAt = Date.now();
  const { data, usage } = await callWithRetry(model, prompt);
  const elapsedMs = Date.now() - startedAt;

  const record = {
    variant: variant.name,
    model: model.slot,
    vendor: model.vendor,
    tier: model.tier,
    jd: jd.name,
    run,
    elapsed_ms: elapsedMs,
    timestamp: new Date().toISOString(),
    response: data,
    usage
  };
  await fs.writeFile(target, JSON.stringify(record, null, 2));
  return { skipped: false };
}

// Runs all RUNS_PER_CELL runs for one cell sequentially so a cached prompt
// prefix written by run 1 is still warm for runs 2..N (5-minute TTL).
async function runCell(variant, model, jd) {
  for (let run = 1; run <= RUNS_PER_CELL; run++) {
    const label = `${variant.name} | ${model.slot} | ${jd.name} | run${run}`;
    const outcome = await runOne(variant, model, jd, run).catch((err) => ({ error: err.message ?? String(err) }));
    if (outcome.error) console.log(`FAIL  ${label} :: ${outcome.error}`);
    else if (outcome.skipped) console.log(`skip  ${label}`);
    else console.log(`done  ${label}`);
  }
}

function matchesFilter(name, filterEnv, alwaysInclude = []) {
  const filter = process.env[filterEnv];
  if (!filter) return true;
  if (alwaysInclude.includes(name)) return true;
  const tokens = filter.split(',').map((s) => s.trim()).filter(Boolean);
  return tokens.some((t) => name.includes(t));
}

async function main() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const allVariants = await loadMarkdownFiles(VARIANTS_DIR);
  const allJds = await loadMarkdownFiles(JDS_DIR);
  enforce(allVariants.length > 0, `No variants found in ${VARIANTS_DIR}. Run \`npm run generate\` first.`);
  enforce(allJds.length > 0, `No JDs found in ${JDS_DIR}. Drop anonymized JDs in there.`);

  // baseline is always included — needed to compute deltas against any variant.
  const variants = allVariants.filter((v) => matchesFilter(v.name, 'BIAS_VARIANT_FILTER', ['baseline']));
  const jds = allJds.filter((j) => matchesFilter(j.name, 'BIAS_JD_FILTER'));
  enforce(variants.length > 0, `BIAS_VARIANT_FILTER='${process.env.BIAS_VARIANT_FILTER}' matched no variants.`);
  enforce(jds.length > 0, `BIAS_JD_FILTER='${process.env.BIAS_JD_FILTER}' matched no JDs.`);

  const models = activeModels();
  enforce(models.length > 0, `BIAS_MODEL_FILTER='${process.env.BIAS_MODEL_FILTER}' matched no models.`);
  console.log(`Running ${models.length} model slot(s): ${models.map((m) => m.slot).join(', ')}`);
  console.log(`${variants.length} variant(s) × ${jds.length} JD(s) × ${RUNS_PER_CELL} run(s) = ${variants.length * jds.length * models.length * RUNS_PER_CELL} calls`);

  const limit = pLimit(CONCURRENCY);
  const tasks = [];

  for (const variant of variants) {
    for (const model of models) {
      for (const jd of jds) {
        tasks.push(limit(() => runCell(variant, model, jd)));
      }
    }
  }

  await Promise.all(tasks);
  console.log(`\nfinished. ${tasks.length} cells processed.`);
}

main();
