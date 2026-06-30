import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { activeModels } from '../src/providers/index.js';
import { loadMarkdownFiles, fileExists, callWithRetry } from '../src/runnerCore.js';
import { buildReasoningPrompt, buildScorePrompt, renderAssessment } from '../src/transplantPrompts.js';
import { keyFactorSignal } from '../src/coherenceMetrics.js';

// Reasoning-transplant experiment.
// Stage 1: generate STAGE1_RUNS reasoning blocks (no score) per cell, so they vary.
// Pick the most-positive (R+) and most-negative (R-) by key_factor signal.
// Stage 2: re-score the SAME résumé STAGE2_RUNS times under each donor assessment.
// If score(R+) > score(R-), the score follows transplanted reasoning (causal);
// if score(R+) ≈ score(R-), the score is a prior and the reasoning is decorative.

const STAGE1_RUNS = Number(process.env.BIAS_TRANSPLANT_STAGE1_RUNS ?? 10);
const STAGE2_RUNS = Number(process.env.BIAS_TRANSPLANT_STAGE2_RUNS ?? 3);
const CONCURRENCY = Number(process.env.BIAS_CONCURRENCY ?? 4);
const VARIANTS_DIR = 'data/variants';
const JDS_DIR = 'data/jds';
const OUT_DIR = 'results-reasoning-transplant';

const EVALUATED_SLOTS = [
  'claude-opus', 'claude-sonnet', 'claude-haiku',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview',
  'llama-4-maverick', 'qwen-3-next-80b', 'mistral-large', 'mistral-small'
];
const RESUMES = [
  'baseline',
  'firstName_aisha-okonkwo', 'firstName_james-smith',
  'school_mit', 'school_regional-unknown',
  'addressCountry_nigeria', 'addressCountry_usa',
  'careerGap_unexplained'
];
const JDS = ['jd_junior_fullstack', 'jd_senior_fullstack', 'jd_principal_engineer_specialized', 'jd_cto_agentic_fintech'];

function enforce(cond, msg) { if (!cond) throw new Error(msg); }
function matchesFilter(name, env) {
  const filter = process.env[env];
  if (!filter) return true;
  return filter.split(',').map((s) => s.trim()).filter(Boolean).some((t) => name.includes(t));
}

const stage1Path = (r, m, j, k) => path.join(OUT_DIR, 'stage1', `${r}__${m}__${j}__run${k}.json`);
const stage2Path = (r, m, j, cond, k) => path.join(OUT_DIR, 'stage2', `${r}__${m}__${j}__${cond}__run${k}.json`);

async function writeRecord(p, record) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(record, null, 2));
}

async function ensureStage1(resume, model, jd) {
  for (let k = 1; k <= STAGE1_RUNS; k++) {
    const p = stage1Path(resume.name, model.slot, jd.name, k);
    if (await fileExists(p)) continue;
    const prompt = buildReasoningPrompt(jd.content, resume.content);
    const { data, usage } = await callWithRetry(model, prompt);
    await writeRecord(p, {
      stage: 1, variant: resume.name, model: model.slot, vendor: model.vendor, jd: jd.name, run: k,
      timestamp: new Date().toISOString(), response: data, usage
    });
    console.log(`done  s1 ${resume.name} | ${model.slot} | ${jd.name} | run${k}`);
  }
}

async function readStage1(resume, model, jd) {
  const out = [];
  for (let k = 1; k <= STAGE1_RUNS; k++) {
    const p = stage1Path(resume.name, model.slot, jd.name, k);
    if (!(await fileExists(p))) continue;
    const rec = JSON.parse(await fs.readFile(p, 'utf8'));
    if (!rec.response) continue;
    out.push({ run: k, response: rec.response, signal: keyFactorSignal(rec.response) });
  }
  return out;
}

async function runStage2(resume, model, jd, cond, donor) {
  const assessment = renderAssessment(donor.response);
  for (let k = 1; k <= STAGE2_RUNS; k++) {
    const p = stage2Path(resume.name, model.slot, jd.name, cond, k);
    if (await fileExists(p)) continue;
    const prompt = buildScorePrompt(jd.content, resume.content, assessment);
    const { data, usage } = await callWithRetry(model, prompt);
    await writeRecord(p, {
      stage: 2, condition: cond, variant: resume.name, model: model.slot, vendor: model.vendor, jd: jd.name, run: k,
      donor_run: donor.run, donor_signal: donor.signal, timestamp: new Date().toISOString(), response: data, usage
    });
    console.log(`done  s2 ${resume.name} | ${model.slot} | ${jd.name} | ${cond} | run${k}`);
  }
}

async function runCell(resume, model, jd) {
  await ensureStage1(resume, model, jd);
  const blocks = await readStage1(resume, model, jd);
  if (blocks.length < 2) {
    console.log(`skip  ${resume.name} | ${model.slot} | ${jd.name} :: <2 valid reasoning blocks`);
    return;
  }
  const sorted = [...blocks].sort((a, b) => a.signal - b.signal);
  const donorNeg = sorted[0];
  const donorPos = sorted[sorted.length - 1];
  await runStage2(resume, model, jd, 'pos', donorPos);
  await runStage2(resume, model, jd, 'neg', donorNeg);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const allVariants = await loadMarkdownFiles(VARIANTS_DIR);
  const allJds = await loadMarkdownFiles(JDS_DIR);
  const vmap = new Map(allVariants.map((x) => [x.name, x]));
  const jmap = new Map(allJds.map((x) => [x.name, x]));

  const resumes = RESUMES.filter((n) => matchesFilter(n, 'BIAS_TRANSPLANT_RESUME_FILTER')).map((n) => {
    enforce(vmap.has(n), `Résumé '${n}' not found. Run \`npm run generate\` first.`); return vmap.get(n);
  });
  const jds = JDS.filter((n) => matchesFilter(n, 'BIAS_TRANSPLANT_JD_FILTER')).map((n) => {
    enforce(jmap.has(n), `JD '${n}' not found.`); return jmap.get(n);
  });
  const models = activeModels().filter((m) => EVALUATED_SLOTS.includes(m.slot));
  enforce(resumes.length && jds.length && models.length, 'Empty grid after filters.');

  const perCell = STAGE1_RUNS + 2 * STAGE2_RUNS;
  console.log(`Transplant: ${models.length} models × ${resumes.length} résumés × ${jds.length} JDs × (${STAGE1_RUNS} reasoning + 2×${STAGE2_RUNS} score) = ${models.length * resumes.length * jds.length * perCell} calls`);
  console.log(`models: ${models.map((m) => m.slot).join(', ')}`);

  const limit = pLimit(CONCURRENCY);
  const tasks = [];
  for (const model of models) for (const resume of resumes) for (const jd of jds) {
    tasks.push(limit(() => runCell(resume, model, jd).catch((e) => console.log(`FAIL ${resume.name}|${model.slot}|${jd.name} :: ${e.message ?? e}`))));
  }
  await Promise.all(tasks);
  console.log(`\nfinished. ${tasks.length} cells processed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
