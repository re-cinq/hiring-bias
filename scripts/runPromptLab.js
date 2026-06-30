import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { activeModels } from '../src/providers/index.js';
import { STRATEGIES } from '../src/promptStrategies.js';
import { loadMarkdownFiles, fileExists, callWithRetry } from '../src/runnerCore.js';

// Prompt Lab grid: every strategy × the evaluated models × a small set of résumés
// (baseline + high-signal swaps) × a couple of JDs, sampled many times per cell.
// Separate output tree from the main `results/` so it never collides with v1 data.
const RUNS_PER_CELL = Number(process.env.BIAS_PROMPTLAB_RUNS_PER_CELL ?? 10);
const CONCURRENCY = Number(process.env.BIAS_CONCURRENCY ?? 4);
const VARIANTS_DIR = 'data/variants';
const JDS_DIR = 'data/jds';
const OUT_DIR = 'results-prompt-lab';

// The 10 models that were actually evaluated in v1 (excludes gpt-5 / gpt-4o-mini /
// llama-3.3-70b, which are defined but were not part of the published run set).
const EVALUATED_SLOTS = [
  'claude-opus', 'claude-sonnet', 'claude-haiku',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview',
  'llama-4-maverick', 'qwen-3-next-80b', 'mistral-large', 'mistral-small'
];

const RESUMES = ['baseline', 'firstName_aisha-okonkwo', 'school_mit', 'addressCountry_nigeria'];
const JDS = ['jd_senior_fullstack', 'jd_principal_engineer_specialized'];

function enforce(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Optional comma-substring filters so a smoke run needs no code edit.
function matchesFilter(name, filterEnv) {
  const filter = process.env[filterEnv];
  if (!filter) return true;
  const tokens = filter.split(',').map((s) => s.trim()).filter(Boolean);
  return tokens.some((t) => name.includes(t));
}

function resultPath(strategy, resume, modelSlot, jdName, run) {
  return path.join(OUT_DIR, strategy, `${resume}__${modelSlot}__${jdName}__run${run}.json`);
}

async function runOne(strategy, resume, model, jd, run) {
  const target = resultPath(strategy.id, resume.name, model.slot, jd.name, run);
  if (await fileExists(target)) return { skipped: true };

  const prompt = strategy.template.replace('<JD>', jd.content).replace('<RESUME>', resume.content);
  const startedAt = Date.now();
  const { data, usage } = await callWithRetry(model, prompt);
  const elapsedMs = Date.now() - startedAt;

  const record = {
    strategy: strategy.id,
    variant: resume.name,
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
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(record, null, 2));
  return { skipped: false };
}

// All runs for one cell run sequentially so a cached prompt prefix written by run 1
// is still warm for runs 2..N (Anthropic 5-minute TTL).
async function runCell(strategy, resume, model, jd) {
  for (let run = 1; run <= RUNS_PER_CELL; run++) {
    const label = `${strategy.id} | ${resume.name} | ${model.slot} | ${jd.name} | run${run}`;
    const outcome = await runOne(strategy, resume, model, jd, run).catch((err) => ({ error: err.message ?? String(err) }));
    if (outcome.error) console.log(`FAIL  ${label} :: ${outcome.error}`);
    else if (outcome.skipped) console.log(`skip  ${label}`);
    else console.log(`done  ${label}`);
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const allVariants = await loadMarkdownFiles(VARIANTS_DIR);
  const allJds = await loadMarkdownFiles(JDS_DIR);
  const byName = (list) => new Map(list.map((x) => [x.name, x]));
  const variantMap = byName(allVariants);
  const jdMap = byName(allJds);

  const resumes = RESUMES.filter((n) => matchesFilter(n, 'BIAS_PROMPTLAB_RESUME_FILTER')).map((n) => {
    enforce(variantMap.has(n), `Résumé variant '${n}' not found in ${VARIANTS_DIR}. Run \`npm run generate\` first.`);
    return variantMap.get(n);
  });
  const jds = JDS.filter((n) => matchesFilter(n, 'BIAS_PROMPTLAB_JD_FILTER')).map((n) => {
    enforce(jdMap.has(n), `JD '${n}' not found in ${JDS_DIR}.`);
    return jdMap.get(n);
  });
  const strategies = STRATEGIES.filter((s) => matchesFilter(s.id, 'BIAS_PROMPTLAB_STRATEGY_FILTER'));
  const models = activeModels().filter((m) => EVALUATED_SLOTS.includes(m.slot));

  enforce(strategies.length > 0, `BIAS_PROMPTLAB_STRATEGY_FILTER matched no strategies.`);
  enforce(resumes.length > 0, `BIAS_PROMPTLAB_RESUME_FILTER matched no résumés.`);
  enforce(jds.length > 0, `BIAS_PROMPTLAB_JD_FILTER matched no JDs.`);
  enforce(models.length > 0, `No evaluated models active (BIAS_MODEL_FILTER='${process.env.BIAS_MODEL_FILTER}').`);

  const total = strategies.length * models.length * resumes.length * jds.length * RUNS_PER_CELL;
  console.log(`Prompt Lab: ${strategies.length} strategies × ${models.length} models × ${resumes.length} résumés × ${jds.length} JDs × ${RUNS_PER_CELL} runs = ${total} calls`);
  console.log(`models: ${models.map((m) => m.slot).join(', ')}`);

  const limit = pLimit(CONCURRENCY);
  const tasks = [];
  for (const strategy of strategies) {
    for (const model of models) {
      for (const resume of resumes) {
        for (const jd of jds) {
          tasks.push(limit(() => runCell(strategy, resume, model, jd)));
        }
      }
    }
  }
  await Promise.all(tasks);
  console.log(`\nfinished. ${tasks.length} cells processed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
