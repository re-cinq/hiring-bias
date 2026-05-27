import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { MODELS } from '../src/providers/index.js';
import { buildAuditPrompt } from '../src/auditPrompt.js';
import { diffLines } from '../site/js/linediff.js';

const DIFFS_DIR = 'site/data/diffs';
const VARIANTS_DIR = 'data/variants';
const AUDITS_DIR = 'data/audits';
const CONCURRENCY = Number(process.env.BIAS_CONCURRENCY ?? 4);
const AUDITOR_SLOT = process.env.BIAS_AUDITOR_MODEL ?? 'gemini-2.5-pro';
const REQUIRED_RUNS = Number(process.env.BIAS_AUDIT_MIN_RUNS ?? 5);

function enforce(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function fileExists(p) {
  return fs.access(p).then(() => true, () => false);
}

function resumeChange(baselineMd, variantMd) {
  const lines = diffLines(baselineMd, variantMd);
  const removed = lines.filter((l) => l.kind === 'del' && l.text.trim()).map((l) => l.text.trim());
  const added = lines.filter((l) => l.kind === 'add' && l.text.trim()).map((l) => l.text.trim());
  return [
    removed.length ? `Removed: ${removed.join(' / ')}` : '',
    added.length ? `Added: ${added.join(' / ')}` : ''
  ].filter(Boolean).join('\n') || '(no textual change detected)';
}

function samplesIdentical(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function verdictFrom(data) {
  return {
    verdict: data.verdict,
    confidence: data.confidence,
    rationale: data.rationale,
    bias_signals: data.bias_signals ?? []
  };
}

function sumUsage(...usages) {
  return usages.filter(Boolean).reduce((acc, u) => ({
    input_tokens: (acc.input_tokens ?? 0) + (u.input_tokens ?? 0),
    output_tokens: (acc.output_tokens ?? 0) + (u.output_tokens ?? 0)
  }), { input_tokens: 0, output_tokens: 0 });
}

async function auditOne(auditor, diff, baselineMd, variantMd) {
  const target = path.join(AUDITS_DIR, `${diff.id}.json`);

  const change = resumeChange(baselineMd, variantMd);
  const mode = diff.axis === 'anonymize' ? 'redact' : 'inject';
  const nRuns = Math.min(diff.n_runs_variant ?? 0, diff.n_runs_baseline ?? 0);

  const promptFirst = buildAuditPrompt({
    change, mode, delta: diff.delta, nRuns,
    baseline: diff.baseline?.sample,
    variant: diff.variant_data?.sample
  });
  const promptMedian = buildAuditPrompt({
    change, mode, delta: diff.delta, nRuns,
    baseline: diff.baseline?.sample_median ?? diff.baseline?.sample,
    variant: diff.variant_data?.sample_median ?? diff.variant_data?.sample
  });

  const inputHash = createHash('sha256').update(`${promptFirst}\n---\n${promptMedian}`).digest('hex');
  if (await fileExists(target)) {
    const prev = JSON.parse(await fs.readFile(target, 'utf8'));
    if (prev.input_hash === inputHash) return { skipped: true };
  }

  const sameInputs = samplesIdentical(diff.baseline?.sample, diff.baseline?.sample_median)
    && samplesIdentical(diff.variant_data?.sample, diff.variant_data?.sample_median);

  let firstVerdict, medianVerdict, usage, samplesCoincide;
  if (sameInputs) {
    const { data, usage: u } = await auditor.call(promptFirst);
    firstVerdict = verdictFrom(data);
    medianVerdict = firstVerdict;
    usage = u;
    samplesCoincide = true;
  } else {
    const [first, median] = await Promise.all([auditor.call(promptFirst), auditor.call(promptMedian)]);
    firstVerdict = verdictFrom(first.data);
    medianVerdict = verdictFrom(median.data);
    usage = sumUsage(first.usage, median.usage);
    samplesCoincide = false;
  }

  const record = {
    id: diff.id,
    variant: diff.variant, axis: diff.axis, level: diff.level, model: diff.model, jd: diff.jd,
    delta: diff.delta,
    n_runs_variant: diff.n_runs_variant,
    n_runs_baseline: diff.n_runs_baseline,
    auditor: auditor.slot,
    timestamp: new Date().toISOString(),
    input_hash: inputHash,
    samples_coincide: samplesCoincide,
    verdicts_agree: firstVerdict.verdict === medianVerdict.verdict,
    first_run: firstVerdict,
    median_run: medianVerdict,
    usage
  };
  await fs.writeFile(target, JSON.stringify(record, null, 2));
  return {
    skipped: false,
    verdict: medianVerdict.verdict,
    secondVerdict: firstVerdict.verdict,
    agree: record.verdicts_agree
  };
}

async function loadResume(variant) {
  return fs.readFile(path.join(VARIANTS_DIR, `${variant}.md`), 'utf8');
}

async function main() {
  await fs.mkdir(AUDITS_DIR, { recursive: true });

  const auditor = MODELS.find((m) => m.slot === AUDITOR_SLOT);
  enforce(auditor, `BIAS_AUDITOR_MODEL='${AUDITOR_SLOT}' is not a known model slot.`);

  const diffFiles = (await fs.readdir(DIFFS_DIR)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  enforce(diffFiles.length > 0, `No diff pairs in ${DIFFS_DIR}. Run \`npm run build:site\` first.`);

  const baselineMd = await loadResume('baseline');
  const resumeCache = new Map();
  const resumeFor = async (variant) => {
    if (!resumeCache.has(variant)) resumeCache.set(variant, await loadResume(variant));
    return resumeCache.get(variant);
  };

  console.log(`Auditing ${diffFiles.length} diff pair(s) with '${auditor.slot}' (concurrency ${CONCURRENCY}, min runs ${REQUIRED_RUNS})`);

  const counters = { skipped: 0, waited: 0, audited: 0, disagreed: 0, failed: 0 };

  const limit = pLimit(CONCURRENCY);
  const tasks = diffFiles.map((file) => limit(async () => {
    const diff = JSON.parse(await fs.readFile(path.join(DIFFS_DIR, file), 'utf8'));
    const nV = diff.n_runs_variant ?? 0;
    const nB = diff.n_runs_baseline ?? 0;
    if (nV < REQUIRED_RUNS || nB < REQUIRED_RUNS) {
      counters.waited++;
      console.log(`wait  ${diff.id} :: ${nV}v/${nB}b runs (need ${REQUIRED_RUNS})`);
      return;
    }
    const variantMd = await resumeFor(diff.variant);
    const outcome = await auditOne(auditor, diff, baselineMd, variantMd)
      .catch((err) => ({ error: err.message ?? String(err) }));
    if (outcome.error) {
      counters.failed++;
      console.log(`FAIL  ${diff.id} :: ${outcome.error}`);
    } else if (outcome.skipped) {
      counters.skipped++;
      console.log(`skip  ${diff.id}`);
    } else {
      counters.audited++;
      if (!outcome.agree) counters.disagreed++;
      const tag = outcome.agree ? '' : ` (≠ ${outcome.secondVerdict})`;
      console.log(`${outcome.verdict.padEnd(9)} ${diff.id}${tag}`);
    }
  }));

  await Promise.all(tasks);
  console.log(`\nfinished. ${tasks.length} pair(s) processed.`);
  console.log(`  audited: ${counters.audited}  (disagreement: ${counters.disagreed})`);
  console.log(`  skipped (hash match): ${counters.skipped}`);
  console.log(`  waiting on runs (<${REQUIRED_RUNS}): ${counters.waited}`);
  console.log(`  failed: ${counters.failed}`);
  console.log(`Re-run \`npm run build:site\` to embed verdicts.`);
}

main();
