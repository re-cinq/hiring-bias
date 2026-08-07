import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { score } from '../src/scorer.js';
import { probeGroundTruth, normalizeExtractionSafe } from './scorerFixtures.js';

const AS_OF = '2026-08';
const jobSpec = JSON.parse(await fs.readFile('data/jobspecs/jd_senior_fullstack.json', 'utf8'));
const resume = await fs.readFile('data/variants/baseline.md', 'utf8');
const probes = probeGroundTruth(resume);

// A real extraction of the real résumé, so the fixtures exercise the shape models produce
// rather than a shape invented to pass.
const extraction = await normalizeExtractionSafe('results-extraction/temp0/baseline__gemini-2.5-flash__run1.json');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('scoring the real baseline résumé is deterministic and traceable', () => {
  const a = score({ extraction, probes }, jobSpec, AS_OF);
  const b = score({ extraction, probes }, jobSpec, AS_OF);
  assert.deepEqual(a, b, 'identical inputs must give an identical result');
  assert.ok(a.score >= 1 && a.score <= 10);
  assert.equal(a.earned + a.missing.reduce((s, m) => s + m.weight, 0), a.available,
    'every available point is either earned or itemised as missing');
});

check('technology credit comes from the document, not from the model', () => {
  const stripped = { ...extraction, employment: (extraction.employment ?? []).map((e) => ({ ...e, technologies: [] })), skills_declared: [] };
  const withTech = score({ extraction, probes }, jobSpec, AS_OF);
  const withoutTech = score({ extraction: stripped, probes }, jobSpec, AS_OF);
  const techIds = (r) => r.matched.filter((m) => m.id.match(/typescript|nodejs|docker|git/)).map((m) => m.id).sort();
  assert.deepEqual(techIds(withoutTech), techIds(withTech),
    'deleting the model\'s technology claims must not change technology credit');
});

check('a probe absent from the résumé earns nothing', () => {
  const result = score({ extraction, probes }, jobSpec, AS_OF);
  const ids = result.missing.map((m) => m.id);
  assert.ok(ids.includes('vitest'), 'vitest is not in the résumé');
  assert.ok(ids.includes('python'), 'python is not in the résumé');
  assert.ok(result.matched.map((m) => m.id).includes('kubernetes'), 'kubernetes is in the GISCollective prose');
});

check('experience is a union of intervals, not a sum of durations', () => {
  const result = score({ extraction, probes }, jobSpec, AS_OF);
  const career = [...result.matched, ...result.missing].find((r) => r.id === 'career_length');
  const months = Number(career.detail.match(/^(\d+) months/)[1]);
  assert.ok(months > 200 && months < 260, `career length ${months} should be ~242, not the ~457 a naive sum gives`);
});

check('a failed disqualifier floors the score regardless of everything else', () => {
  const noDegree = { ...extraction, education: [] };
  const result = score({ extraction: noDegree, probes }, jobSpec, AS_OF);
  assert.equal(result.score, 1);
  assert.equal(result.disqualified.length, 1);
  assert.equal(result.disqualified[0].id, 'degree_or_equivalent');
});

check('judgement-tier fields are surfaced for review, never scored', () => {
  const flattering = {
    ...extraction,
    notable_signals: ['founder', 'award', 'patent'],
    domains: ['fintech', 'ml_ai'],
    overall_seniority: 'c_level',
    employment: (extraction.employment ?? []).map((e) => ({ ...e, employer_type: 'bigtech' }))
  };
  const plain = score({ extraction, probes }, jobSpec, AS_OF);
  const boosted = score({ extraction: flattering, probes }, jobSpec, AS_OF);
  assert.equal(boosted.score, plain.score, 'tier-2 flattery must not move the number');
  assert.ok(boosted.review_notes.some((n) => n.value === 'patent'), 'but it must reach the human');
});

check('an unknown requirement type fails loudly rather than scoring zero', () => {
  const bad = { ...jobSpec, requirements: [{ id: 'x', type: 'vibes', weight: 1 }] };
  assert.throws(() => score({ extraction, probes }, bad, AS_OF), /unknown requirement type 'vibes'/);
});

const failures = [];
for (const { name, fn } of checks) {
  await Promise.resolve(fn()).then(
    () => console.log(`ok    ${name}`),
    (err) => { failures.push(name); console.log(`FAIL  ${name}\n      ${err.message}`); }
  );
}
console.log(`\n${checks.length - failures.length}/${checks.length} passed`);
if (failures.length) process.exit(1);
