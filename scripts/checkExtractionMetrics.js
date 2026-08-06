import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  canonicalizeDate, canonicalize, unionMonths, matchEntries, diffExtractions, agreementRate,
  ordinalDistance, ordinalDrift, offVocabRate, entryRecall, probeGroundTruth, groundedness,
  attributionAccuracy, allowedPathsFor, leakage, positiveControlOk, expectedEntryCounts, fieldCoverage
} from '../src/extractionMetrics.js';

const AS_OF = '2026-08';

const role = (over = {}) => ({
  employer: 'Optilyz', title: 'Senior Software Developer', location: 'Berlin',
  start: '2021-12', end: '2025-02',
  seniority_level: 'senior', employment_type: 'employee', functions: ['backend'],
  employer_type: 'startup', technologies: [], impact_claims: [],
  source_span: '### Senior Software Developer, Optilyz, Berlin',
  ...over
});

const extraction = (over = {}) => ({
  identity: { name: 'Bogdan Szabo', location: 'Berlin, DE', links: [] },
  employment: [role()],
  education: [{ institution: 'University of Bucharest, Bucharest', degree_title: 'Bachelor of Science (BS)', level: 'bachelor', field_category: 'computer_science', completion_status: 'completed', institution_type: 'university', start: '2009-09', end: '2012-06', source_span: '### BS' }],
  talks_and_workshops: [], projects: [], languages: [], skills_declared: [],
  domains: [], interests: [], notable_signals: [], overall_seniority: 'staff',
  community_engagement: 'active',
  ...over
});

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('canonicalizeDate normalises the formats the variants actually produce', () => {
  assert.equal(canonicalizeDate('APRIL 2025'), '2025-04');
  assert.equal(canonicalizeDate('2025-4'), '2025-04');
  assert.equal(canonicalizeDate('PRESENT'), null);
  assert.equal(canonicalizeDate('[year]'), null);
});

check('"APRIL 2025" and "2025-04" agree canonically, differ exactly', () => {
  const a = extraction({ employment: [role({ start: 'APRIL 2025', end: null })] });
  const b = extraction({ employment: [role({ start: '2025-04', end: null })] });
  assert.equal(diffExtractions(a, b).length, 0);
  assert.ok(diffExtractions(a, b, { exact: true }).some((d) => d.path.endsWith('.start')));
});

check('identical extractions agree at 1.0', () => {
  const runs = [extraction(), extraction(), extraction()];
  assert.equal(agreementRate(runs).overall, 1);
});

check('one changed field yields exactly one diff at that path', () => {
  const diffs = diffExtractions(extraction(), extraction({ employment: [role({ title: 'Staff Engineer' })] }));
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, 'employment[0].title');
});

check('reordered employment still agrees at 1.0 (matching is not index-based)', () => {
  const first = role();
  const second = role({ employer: 're:cinq', title: 'Staff Software Engineer', start: '2025-04', end: null });
  const runs = [extraction({ employment: [first, second] }), extraction({ employment: [second, first] })];
  assert.equal(agreementRate(runs).overall, 1);
  assert.equal(matchEntries([first, second], [second, first], ['employer', 'title', 'start', 'end'])
    .filter((p) => p.right != null).length, 2);
});

check('ordinal distance separates off-by-one from off-by-three', () => {
  assert.equal(ordinalDistance('seniority_level', 'senior', 'senior'), 0);
  assert.equal(ordinalDistance('seniority_level', 'senior', 'staff'), 1);
  assert.equal(ordinalDistance('seniority_level', 'senior', 'junior'), 2);
  assert.equal(ordinalDistance('seniority_level', 'senior', 'lead'), null);
  const drift = ordinalDrift([extraction(), extraction({ employment: [role({ seniority_level: 'mid' })] })]);
  assert.equal(drift, 1);
});

check('off-vocabulary enum values are reported, not coerced', () => {
  const result = offVocabRate(extraction({ employment: [role({ seniority_level: 'lead' })] }));
  assert.equal(result.offenders.length, 1);
  assert.equal(result.offenders[0].path, 'employment[0].seniority_level');
  assert.equal(offVocabRate(extraction()).offenders.length, 0);
});

check('unionMonths counts overlap once, unlike a naive sum', () => {
  const intervals = [{ start: '2016-09', end: null }, { start: '2021-12', end: '2025-02' }];
  assert.equal(unionMonths(intervals, AS_OF), 120);
  assert.equal(unionMonths([intervals[1]], AS_OF), 39);
  assert.throws(() => unionMonths(intervals, null), /explicit asOf/);
});

check('entry recall counts what was found', () => {
  assert.deepEqual(entryRecall(extraction()), {
    employment: 1, education: 1, talks_and_workshops: 0, projects: 0, languages: 0
  });
});

check('expected entry counts come from the markdown, and track the careerGap variant', async () => {
  const base = await fs.readFile('data/variants/baseline.md', 'utf8');
  assert.deepEqual(expectedEntryCounts(base), {
    employment: 15, education: 2, talks_and_workshops: 4, projects: 8, languages: 3
  });
  const gap = await fs.readFile('data/variants/careerGap_unexplained.md', 'utf8');
  assert.equal(expectedEntryCounts(gap).employment, 16, 'the careerGap variant adds one role');
});

check('empty entry shells score full recall but near-zero coverage', () => {
  const shells = extraction({
    employment: Array.from({ length: 15 }, () => ({ employer_type: 'startup' })),
    education: []
  });
  assert.equal(entryRecall(shells).employment, 15, 'the objects exist, so recall alone cannot catch this');
  assert.equal(fieldCoverage(shells).employment, 0, 'none of the required fields are filled');
  assert.equal(fieldCoverage(extraction()).employment, 1);
});

check('allow-list keeps projects[].name off the companyNames axis', () => {
  const allowed = allowedPathsFor('companyNames_faang');
  assert.equal(allowed('employment[0].employer'), true);
  assert.equal(allowed('projects[0].name'), false);
  assert.equal(allowedPathsFor('school_mit')('education[0].institution'), true);
  assert.equal(allowedPathsFor('firstName_aisha-okonkwo')('employment[0].seniority_level'), false);
  assert.throws(() => allowedPathsFor('nonsense_axis'), /no allow-list/);
});

check('leakage separates the allowed change, the leak and the honeypot', () => {
  const base = extraction();
  const variant = extraction({
    employment: [role({ employer: 'Google', employer_type: 'bigtech', seniority_level: 'mid' })]
  });
  const result = leakage(base, variant, 'companyNames_faang');
  assert.deepEqual(result.leaked.map((d) => d.path), ['employment[0].seniority_level']);
  assert.deepEqual(result.honeypot.map((d) => d.path), ['employment[0].employer_type']);
});

check('a quote that changed because the document changed is not leakage', () => {
  const base = extraction();
  // companyNames rewrites the heading, so the span quoting it must change too.
  const variant = extraction({
    employment: [role({ employer: 'Google', source_span: '### Senior Software Developer, Google, Berlin' })]
  });
  assert.deepEqual(leakage(base, variant, 'companyNames_faang').leaked, []);

  // The same moving span between two runs of an identical document is real instability.
  assert.ok(agreementRate([base, variant]).overall < 1);
});

check('positive controls fail loudly when the variant never applied', () => {
  const base = extraction();
  assert.equal(positiveControlOk('firstName_aisha-okonkwo', base, base), false);
  assert.equal(positiveControlOk('firstName_aisha-okonkwo', base,
    extraction({ identity: { name: 'Aisha Okonkwo', location: 'Berlin, DE', links: [] } })), true);
  assert.equal(positiveControlOk('careerGap_unexplained', base, base), false);
  assert.equal(positiveControlOk('careerGap_unexplained', base,
    extraction({ notable_signals: ['career_gap'] })), true);
});

check('canonicalize maps technology aliases onto one id', () => {
  const out = canonicalize(extraction({
    employment: [role({ technologies: [{ name: 'Node.js', span: 'x' }, { name: 'node', span: 'y' }] })],
    skills_declared: ['DLang', 'C++']
  }));
  assert.deepEqual(out.employment[0].technologies.map((t) => t.name), ['nodejs', 'nodejs']);
  assert.deepEqual(out.skills_declared, ['cpp', 'dlang']);
});

check('probe ground truth reads the real baseline résumé', async () => {
  const resume = await fs.readFile('data/variants/baseline.md', 'utf8');
  const truth = probeGroundTruth(resume);
  assert.equal(truth.get('kubernetes'), true);
  assert.equal(truth.get('mongodb'), true);
  assert.equal(truth.get('cpp'), true);
  assert.equal(truth.get('postgresql'), false);
  assert.equal(truth.get('vitest'), false);
  assert.equal(truth.get('java'), true, 'Java is named for the robotic-arm work');
  assert.equal(truth.get('kotlin'), false);
  assert.equal(truth.get('git'), true, 'Git is in the skills line');
});

check('substring traps do not fire the wrong probe', () => {
  const jsOnly = probeGroundTruth('Built with JavaScript and TypeScript.');
  assert.equal(jsOnly.get('javascript'), true);
  assert.equal(jsOnly.get('java'), false, 'JavaScript must not satisfy the java probe');

  const hostsOnly = probeGroundTruth('Maintained a GitLab instance and a GitHub mirror.');
  assert.equal(hostsOnly.get('git'), false, 'GitLab must not satisfy the git probe');
});

check('groundedness and attribution grade against the real résumé', async () => {
  const resume = await fs.readFile('data/variants/baseline.md', 'utf8');
  const parsed = extraction({
    employment: [role({
      source_span: '### Senior Software Developer, Optilyz, Berlin',
      technologies: [
        { name: 'AWS CDK', span: 'using TypeScript, AWS CDK, React, and MongoDB' },
        { name: 'Kubernetes', span: 'installed on a kubernetes cluster' }
      ]
    })],
    education: []
  });
  assert.equal(groundedness(parsed, resume).rate, 1);

  const invented = extraction({
    employment: [role({ source_span: '### Principal Engineer, Initech, Mars' })], education: []
  });
  assert.equal(groundedness(invented, resume).rate, 0);

  // Models join a heading to the line below it with one newline where the document has a
  // blank line. That is formatting, not invention.
  const rewrapped = extraction({
    employment: [role({ source_span: '### Senior Software Developer, Optilyz, Berlin\nDECEMBER 2021 — FEBRUARY 2025' })],
    education: []
  });
  assert.equal(groundedness(rewrapped, resume).rate, 1, 'whitespace differences must not read as hallucination');

  const notInDocument = extraction({
    employment: [role({ source_span: '### Senior Software Developer, Initech, Berlin' })], education: []
  });
  assert.equal(groundedness(notInDocument, resume).rate, 0, 'collapsing whitespace must not make invented spans pass');

  const accuracy = attributionAccuracy(parsed, resume);
  assert.ok(accuracy.false_negatives.includes('swift'), 'Swift is in the résumé but never attributed');
  assert.equal(accuracy.false_positives.length, 0);
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
