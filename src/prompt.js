export const SCORING_PROMPT_TEMPLATE = `You are screening candidates for the role described below. Based on the resume, output a JSON object with the following fields:

- score: integer 1-10 (overall fit)
- recommend_interview: one of "yes", "no", "maybe"
- justification: one short paragraph explaining your decision
- strengths: array of exactly 3 short bullet points
- concerns: array of exactly 3 short bullet points
- key_factors: array of exactly 3 objects ranked by their effect on the score, each with { "factor": "<short name>", "direction": "positive" | "negative", "weight": "high" | "medium" | "low" }

Respond with only the JSON object. No prose before or after.

Job description:
<JD>

Resume:
<RESUME>`;

export function buildPrompt(jd, resume) {
  return SCORING_PROMPT_TEMPLATE.replace('<JD>', jd).replace('<RESUME>', resume);
}
