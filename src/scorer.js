// Deterministic résumé scorer. No model call, no randomness, no clock: the same
// extraction and the same jobSpec always produce the same score, and every point is
// traceable to a named requirement.
//
// It reads only tier-1 fields — the transcribed and classified facts. Technology presence
// comes from grepping the source document, not from the model's own claim, and experience
// totals are recomputed with unionMonths. The judgement tier (domains, notable_signals,
// employer_type, overall_seniority) never touches the score; it is surfaced for a human.

import { rank } from './extractionSchema.js';
import { unionMonths, enforce } from './extractionMetrics.js';

const norm = (value) => String(value ?? '').trim().toLowerCase();

const employmentIntervals = (extraction, predicate) =>
  (extraction?.employment ?? []).filter(predicate).map((e) => ({ start: e.start, end: e.end }));

// One handler per requirement type. Each returns { met, detail } and reads nothing but
// tier-1 fields, the grepped probe vector, and the jobSpec.
const CHECKS = {
  technology: (req, { probes }) => ({
    met: probes.get(req.probe) === true,
    detail: `${req.probe} ${probes.get(req.probe) ? 'named in the document' : 'not named in the document'}`
  }),

  function_months: (req, { extraction, asOf }) => {
    const months = unionMonths(
      employmentIntervals(extraction, (e) => (e.functions ?? []).map(norm).includes(norm(req.function))),
      asOf
    );
    return { met: months >= req.min_months, detail: `${months} months of ${req.function} (needs ${req.min_months})` };
  },

  total_months: (req, { extraction, asOf }) => {
    const months = unionMonths(employmentIntervals(extraction, () => true), asOf);
    return { met: months >= req.min_months, detail: `${months} months total (needs ${req.min_months})` };
  },

  seniority: (req, { extraction }) => {
    const ranks = (extraction?.employment ?? [])
      .map((e) => rank('seniority_level', e.seniority_level))
      .filter((r) => r != null);
    const best = ranks.length ? Math.max(...ranks) : null;
    const needed = rank('seniority_level', req.min_level);
    enforce(needed != null, `jobSpec seniority '${req.min_level}' is not in the vocabulary`);
    return {
      met: best != null && best >= needed,
      detail: best == null ? 'no seniority label extracted' : `reached rank ${best} (needs ${needed} for ${req.min_level})`
    };
  },

  education: (req, { extraction }) => {
    const needed = rank('education_level', req.min_level);
    enforce(needed != null, `jobSpec education level '${req.min_level}' is not in the vocabulary`);
    const fields = (req.fields ?? []).map(norm);
    const match = (extraction?.education ?? []).find((e) => {
      const level = rank('education_level', e.level);
      const fieldOk = fields.length === 0 || fields.includes(norm(e.field_category));
      return level != null && level >= needed && fieldOk;
    });
    return {
      met: match != null,
      detail: match ? `${match.degree_title} in ${match.field_category}` : `no ${req.min_level}+ in ${fields.join('/') || 'any field'}`
    };
  },

  language: (req, { extraction }) => {
    const needed = rank('language_proficiency', req.min_proficiency);
    enforce(needed != null, `jobSpec proficiency '${req.min_proficiency}' is not in the vocabulary`);
    const match = (extraction?.languages ?? []).find((l) =>
      norm(l.language) === norm(req.language) && rank('language_proficiency', l.proficiency) >= needed);
    return { met: match != null, detail: match ? `${req.language} at ${match.proficiency}` : `${req.language} below ${req.min_proficiency}` };
  }
};

function evaluate(requirement, context) {
  const check = CHECKS[requirement.type];
  enforce(check != null, `unknown requirement type '${requirement.type}'`);
  return { ...requirement, ...check(requirement, context) };
}

// Judgement-tier signals a human should see but no algorithm should price.
function reviewNotes(extraction) {
  const notes = [];
  for (const signal of extraction?.notable_signals ?? []) notes.push({ kind: 'signal', value: signal });
  for (const domain of extraction?.domains ?? []) notes.push({ kind: 'domain', value: domain });
  for (const talk of extraction?.talks_and_workshops ?? []) {
    notes.push({ kind: 'talk', value: `${talk.title}${talk.venue ? ` · ${talk.venue}` : ''}` });
  }
  for (const project of extraction?.projects ?? []) notes.push({ kind: 'project', value: project.name });
  return notes;
}

/**
 * @param candidate  { extraction, probes } — probes is the code-computed technology
 *                   presence map from probeGroundTruth(resumeText), never the model's.
 * @param jobSpec    versioned requirement config
 * @param asOf       'YYYY-MM' — explicit so the score never depends on today's date
 */
export function score(candidate, jobSpec, asOf) {
  enforce(candidate?.extraction != null, 'score() needs an extraction');
  enforce(candidate?.probes instanceof Map, 'score() needs a probes Map from probeGroundTruth()');
  enforce(Array.isArray(jobSpec?.requirements), 'jobSpec needs a requirements array');

  const context = { extraction: candidate.extraction, probes: candidate.probes, asOf };
  const results = jobSpec.requirements.map((req) => evaluate(req, context));
  const disqualifiers = (jobSpec.disqualifiers ?? []).map((req) => evaluate(req, context));

  const earned = results.filter((r) => r.met).reduce((sum, r) => sum + r.weight, 0);
  const available = results.reduce((sum, r) => sum + r.weight, 0);
  const blocked = disqualifiers.filter((d) => !d.met);
  const ratio = available ? earned / available : 0;

  return {
    job: jobSpec.id,
    job_version: jobSpec.version,
    // 1-10 to match the scale the rest of the study reports, but computed, not chosen.
    score: blocked.length ? 1 : Math.round((1 + ratio * 9) * 10) / 10,
    ratio,
    earned,
    available,
    disqualified: blocked.map((d) => ({ id: d.id, detail: d.detail })),
    matched: results.filter((r) => r.met).map((r) => ({ id: r.id, weight: r.weight, detail: r.detail })),
    missing: results.filter((r) => !r.met).map((r) => ({ id: r.id, weight: r.weight, detail: r.detail })),
    review_notes: reviewNotes(candidate.extraction)
  };
}
