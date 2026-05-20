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

async function runOne(variant, model, jd, run) {
  const target = resultPath(variant.name, model.slot, jd.name, run);
  if (await fileExists(target)) return { skipped: true };

  const prompt = buildPrompt(jd.content, variant.content);
  const startedAt = Date.now();
  const { data, usage } = await model.call(prompt);
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

async function main() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const variants = await loadMarkdownFiles(VARIANTS_DIR);
  const jds = await loadMarkdownFiles(JDS_DIR);
  enforce(variants.length > 0, `No variants found in ${VARIANTS_DIR}. Run \`npm run generate\` first.`);
  enforce(jds.length > 0, `No JDs found in ${JDS_DIR}. Drop anonymized JDs in there.`);

  const models = activeModels();
  enforce(models.length > 0, `BIAS_MODEL_FILTER='${process.env.BIAS_MODEL_FILTER}' matched no models.`);
  console.log(`Running ${models.length} model slot(s): ${models.map((m) => m.slot).join(', ')}`);

  const limit = pLimit(CONCURRENCY);
  const tasks = [];

  for (const variant of variants) {
    for (const model of models) {
      for (const jd of jds) {
        for (let run = 1; run <= RUNS_PER_CELL; run++) {
          tasks.push(limit(async () => {
            const label = `${variant.name} | ${model.slot} | ${jd.name} | run${run}`;
            const outcome = await runOne(variant, model, jd, run).catch((err) => ({
              error: err.message ?? String(err)
            }));
            if (outcome.error) console.log(`FAIL  ${label} :: ${outcome.error}`);
            else if (outcome.skipped) console.log(`skip  ${label}`);
            else console.log(`done  ${label}`);
          }));
        }
      }
    }
  }

  await Promise.all(tasks);
  console.log(`\nfinished. ${tasks.length} cells processed.`);
}

main();
