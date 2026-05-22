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
const AUDITOR_SLOT = process.env.BIAS_AUDITOR_MODEL ?? 'claude-opus';

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

async function auditOne(auditor, diff, baselineMd, variantMd) {
  const target = path.join(AUDITS_DIR, `${diff.id}.json`);

  const prompt = buildAuditPrompt({
    change: resumeChange(baselineMd, variantMd),
    baseline: diff.baseline?.sample,
    variant: diff.variant_data?.sample,
    mode: diff.axis === 'anonymize' ? 'redact' : 'inject'
  });
  // Skip only when an existing verdict came from identical inputs; re-judge otherwise.
  const inputHash = createHash('sha256').update(prompt).digest('hex');
  if (await fileExists(target)) {
    const prev = JSON.parse(await fs.readFile(target, 'utf8'));
    if (prev.input_hash === inputHash) return { skipped: true };
  }

  const { data, usage } = await auditor.call(prompt);

  const record = {
    id: diff.id,
    variant: diff.variant, axis: diff.axis, level: diff.level, model: diff.model, jd: diff.jd,
    delta: diff.delta,
    auditor: auditor.slot,
    timestamp: new Date().toISOString(),
    input_hash: inputHash,
    verdict: data.verdict,
    confidence: data.confidence,
    rationale: data.rationale,
    bias_signals: data.bias_signals ?? [],
    usage
  };
  await fs.writeFile(target, JSON.stringify(record, null, 2));
  return { skipped: false, verdict: data.verdict };
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

  console.log(`Auditing ${diffFiles.length} diff pair(s) with '${auditor.slot}' (concurrency ${CONCURRENCY})`);

  const limit = pLimit(CONCURRENCY);
  const tasks = diffFiles.map((file) => limit(async () => {
    const diff = JSON.parse(await fs.readFile(path.join(DIFFS_DIR, file), 'utf8'));
    const variantMd = await resumeFor(diff.variant);
    const outcome = await auditOne(auditor, diff, baselineMd, variantMd)
      .catch((err) => ({ error: err.message ?? String(err) }));
    if (outcome.error) console.log(`FAIL  ${diff.id} :: ${outcome.error}`);
    else if (outcome.skipped) console.log(`skip  ${diff.id}`);
    else console.log(`${outcome.verdict.padEnd(9)} ${diff.id}`);
  }));

  await Promise.all(tasks);
  console.log(`\nfinished. ${tasks.length} pair(s) processed. Re-run \`npm run build:site\` to embed verdicts.`);
}

main();
