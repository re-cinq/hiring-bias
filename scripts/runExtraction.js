import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { activeModels } from '../src/providers/index.js';
import { EXTRACTION_PROMPT } from '../src/extractionSchema.js';
import { loadMarkdownFiles, fileExists, callWithRetry } from '../src/runnerCore.js';

// Extraction Lab grid: every résumé variant × every evaluated model × two temperature
// arms, sampled several times per cell. JD-blind by design — the parser never sees a job
// description, so there is no 17× JD multiplier here.
const RUNS_PER_CELL = Number(process.env.BIAS_EXTRACTION_RUNS_PER_CELL ?? 5);
const CONCURRENCY = Number(process.env.BIAS_CONCURRENCY ?? 4);
const VARIANTS_DIR = 'data/variants';
const OUT_DIR = 'results-extraction';

const EVALUATED_SLOTS = [
  'claude-opus', 'claude-sonnet', 'claude-haiku', 'claude-fable-5',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview',
  'llama-4-maverick', 'qwen-3-next-80b', 'mistral-large', 'mistral-small'
];

// Models without sampling controls run one arm; asking for two would buy identical work.
const ARMS = [
  { id: 'temp0', temperature: 0 },
  { id: 'temp07', temperature: 0.7 }
];

function enforce(cond, msg) {
  if (!cond) throw new Error(msg);
}

function matchesFilter(name, filterEnv) {
  const filter = process.env[filterEnv];
  if (!filter) return true;
  const tokens = filter.split(',').map((s) => s.trim()).filter(Boolean);
  return tokens.some((t) => name.includes(t));
}

function resultPath(arm, variant, modelSlot, run) {
  return path.join(OUT_DIR, arm, `${variant}__${modelSlot}__run${run}.json`);
}

function armsFor(model) {
  return model.supportsTemperature === false ? [{ id: 'default', temperature: null }] : ARMS;
}

async function runOne(arm, variant, model, run) {
  const target = resultPath(arm.id, variant.name, model.slot, run);
  if (await fileExists(target)) return { skipped: true };

  const prompt = EXTRACTION_PROMPT.replace('<RESUME>', variant.content);
  const options = arm.temperature == null ? undefined : { temperature: arm.temperature };
  const startedAt = Date.now();
  const { data, usage } = await callWithRetry(model, prompt, 2, options);
  const elapsedMs = Date.now() - startedAt;

  const record = {
    arm: arm.id,
    temperature: arm.temperature,
    variant: variant.name,
    model: model.slot,
    vendor: model.vendor,
    tier: model.tier,
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

// Runs of one cell go sequentially so a cached prompt prefix written by run 1 is still
// warm for runs 2..N.
async function runCell(arm, variant, model) {
  for (let run = 1; run <= RUNS_PER_CELL; run++) {
    const label = `${arm.id} | ${variant.name} | ${model.slot} | run${run}`;
    const outcome = await runOne(arm, variant, model, run).catch((err) => ({ error: err.message ?? String(err) }));
    if (outcome.error) console.log(`FAIL  ${label} :: ${outcome.error}`);
    else if (outcome.skipped) console.log(`skip  ${label}`);
    else console.log(`done  ${label}`);
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const allVariants = await loadMarkdownFiles(VARIANTS_DIR);
  const variants = allVariants.filter((v) => matchesFilter(v.name, 'BIAS_EXTRACTION_VARIANT_FILTER'));
  const models = activeModels()
    .filter((m) => EVALUATED_SLOTS.includes(m.slot))
    .filter((m) => matchesFilter(m.slot, 'BIAS_EXTRACTION_MODEL_FILTER'));

  enforce(variants.length > 0, `BIAS_EXTRACTION_VARIANT_FILTER matched no variants in ${VARIANTS_DIR}. Run \`npm run generate\` first.`);
  enforce(models.length > 0, `No evaluated models active (BIAS_MODEL_FILTER='${process.env.BIAS_MODEL_FILTER}', BIAS_EXTRACTION_MODEL_FILTER='${process.env.BIAS_EXTRACTION_MODEL_FILTER}').`);

  const cells = models.flatMap((model) => armsFor(model).map((arm) => ({ model, arm })));
  const total = cells.length * variants.length * RUNS_PER_CELL;
  console.log(`Extraction Lab: ${models.length} models × ${variants.length} variants × ${RUNS_PER_CELL} runs = ${total} calls`);
  console.log(`models: ${models.map((m) => `${m.slot}(${armsFor(m).length} arm${armsFor(m).length > 1 ? 's' : ''})`).join(', ')}`);

  const limit = pLimit(CONCURRENCY);
  const tasks = [];
  for (const { model, arm } of cells) {
    for (const variant of variants) {
      tasks.push(limit(() => runCell(arm, variant, model)));
    }
  }
  await Promise.all(tasks);
  console.log(`\nfinished. ${tasks.length} cells processed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
