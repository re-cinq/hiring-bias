// Two-stage prompts for the reasoning-transplant experiment, which tests whether a
// model's score is CAUSED by its written reasoning or is a pre-decided prior the
// reasoning merely decorates (kamilc86's claim). Stage 1 produces reasoning with no
// number; stage 2 produces ONLY a number, given a reasoning block we choose. By
// feeding the same résumé a deliberately positive vs a deliberately negative
// assessment, we see whether the score follows the transplanted reasoning.

export const REASONING_ONLY_TEMPLATE = `You are screening candidates for the role described below. Assess the candidate based on the resume, but DO NOT assign a numeric score or an interview recommendation. Output a JSON object with exactly these fields:

- strengths: array of exactly 3 short bullet points
- concerns: array of exactly 3 short bullet points
- key_factors: array of exactly 3 objects ranked by their effect on suitability, each with { "factor": "<short name>", "direction": "positive" | "negative", "weight": "high" | "medium" | "low" }
- justification: one short paragraph summarizing the candidate's fit

Respond with only the JSON object. No prose before or after.

Job description:
<JD>

Resume:
<RESUME>`;

export const SCORE_FROM_REASONING_TEMPLATE = `You are screening candidates for the role described below. A prior assessment of this candidate has already been prepared (shown after the resume). Taking the role, the resume, and that assessment into account, output a JSON object with exactly these fields:

- score: integer 1-10 (overall fit)
- recommend_interview: one of "yes", "no", "maybe"

Respond with only the JSON object. No prose before or after.

Job description:
<JD>

Resume:
<RESUME>

Prior assessment of this candidate:
<ASSESSMENT>`;

export function buildReasoningPrompt(jd, resume) {
  return REASONING_ONLY_TEMPLATE.replace('<JD>', jd).replace('<RESUME>', resume);
}

export function buildScorePrompt(jd, resume, assessmentText) {
  return SCORE_FROM_REASONING_TEMPLATE
    .replace('<JD>', jd)
    .replace('<RESUME>', resume)
    .replace('<ASSESSMENT>', assessmentText);
}

// Render a stage-1 reasoning response as the plain-text assessment injected in stage 2.
export function renderAssessment(response) {
  const lines = [];
  const list = (arr) => (Array.isArray(arr) ? arr : []).map((x) => `- ${x}`).join('\n');
  lines.push('Strengths:', list(response?.strengths));
  lines.push('Concerns:', list(response?.concerns));
  lines.push('Key factors:');
  for (const f of (Array.isArray(response?.key_factors) ? response.key_factors : [])) {
    lines.push(`- ${f.factor} (${f.direction}, ${f.weight})`);
  }
  if (response?.justification) lines.push('Summary:', response.justification);
  return lines.join('\n');
}
