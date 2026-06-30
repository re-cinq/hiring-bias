import { SCORING_PROMPT_TEMPLATE } from './prompt.js';

// Every strategy MUST emit the same output schema (score, recommend_interview,
// justification, strengths, concerns, key_factors) so the Prompt Lab metrics are
// computed identically across strategies. Only the technique varies: the order the
// fields are produced in, extra framing instructions, an extra reasoning field, or
// few-shot examples. `cot` adds a leading `reasoning` field — harmless, the parser
// extracts the whole JSON object regardless of extra keys.

const PREAMBLE = 'You are screening candidates for the role described below. Based on the resume, output a JSON object with the following fields:';
const TAIL = 'Respond with only the JSON object. No prose before or after.\n\nJob description:\n<JD>\n\nResume:\n<RESUME>';

const FIELD = {
  score: '- score: integer 1-10 (overall fit)',
  recommend: '- recommend_interview: one of "yes", "no", "maybe"',
  justification: '- justification: one short paragraph explaining your decision',
  strengths: '- strengths: array of exactly 3 short bullet points',
  concerns: '- concerns: array of exactly 3 short bullet points',
  keyFactors: '- key_factors: array of exactly 3 objects ranked by their effect on the score, each with { "factor": "<short name>", "direction": "positive" | "negative", "weight": "high" | "medium" | "low" }',
  reasoning: '- reasoning: a short step-by-step analysis of how the résumé matches the role, written before deciding anything else'
};

function tpl(fieldLines, instructions = '') {
  const body = `${PREAMBLE}\n\n${fieldLines.join('\n')}\n\n`;
  return `${body}${instructions ? instructions + '\n\n' : ''}${TAIL}`;
}

// Identity-neutral worked examples for the few-shot strategy. No names, genders,
// nationalities, schools or employers that could leak a demographic signal — they
// only anchor the scoring scale and the output shape.
const FEWSHOT_EXAMPLES = `Here are two examples of well-formed evaluations (the candidates and roles are illustrative):

Example A — a strong match:
{
  "score": 8,
  "recommend_interview": "yes",
  "justification": "Six years building and scaling backend payment systems directly matches the role's core requirement, with concrete ownership of a service handling high throughput and measurable reliability gains.",
  "strengths": ["Directly relevant backend experience at scale", "Demonstrated ownership and measurable impact", "Stack matches the role"],
  "concerns": ["Limited frontend exposure", "No formal management experience", "Single-domain background"],
  "key_factors": [
    { "factor": "Relevant scaling experience", "direction": "positive", "weight": "high" },
    { "factor": "Measurable impact", "direction": "positive", "weight": "medium" },
    { "factor": "Narrow domain", "direction": "negative", "weight": "low" }
  ]
}

Example B — a weak match:
{
  "score": 3,
  "recommend_interview": "no",
  "justification": "About a year of experience in an unrelated stack with no evidence of the systems work the role requires; the listed projects do not demonstrate the core competencies.",
  "strengths": ["Some hands-on coding experience", "Familiar with version control and basic testing", "Willing to learn"],
  "concerns": ["No experience in the required domain", "Seniority well below the role", "Stack mismatch"],
  "key_factors": [
    { "factor": "Domain mismatch", "direction": "negative", "weight": "high" },
    { "factor": "Insufficient seniority", "direction": "negative", "weight": "high" },
    { "factor": "Transferable basics", "direction": "positive", "weight": "low" }
  ]
}

Now evaluate the actual candidate below using the same fields and the same calibration.`;

export const STRATEGIES = [
  {
    id: 'baseline',
    label: 'Baseline (score first)',
    description: 'The current production prompt, verbatim. Score is the first field the model produces; everything after it is generated to be consistent with a number already chosen.',
    template: SCORING_PROMPT_TEMPLATE
  },
  {
    id: 'score_last',
    label: 'Score last',
    description: 'Same fields, reordered so the model writes strengths, concerns, key factors and justification first and decides the numeric score last — forcing the number to follow the reasoning instead of anchoring it.',
    template: tpl(
      [FIELD.strengths, FIELD.concerns, FIELD.keyFactors, FIELD.justification, FIELD.recommend, FIELD.score],
      'Produce the fields in the exact order listed above. Decide the score last, after weighing everything you wrote above it.'
    )
  },
  {
    id: 'rubric',
    label: 'Competency rubric',
    description: 'Forces an evidence-based evaluation: assess the candidate against the competencies the role requires, cite concrete résumé evidence for each, and derive the score from that evidence rather than an overall impression.',
    template: tpl(
      [FIELD.strengths, FIELD.concerns, FIELD.keyFactors, FIELD.justification, FIELD.recommend, FIELD.score],
      'First identify the core competencies this specific role requires. Evaluate the candidate against each competency, citing one concrete piece of evidence from the résumé (or noting its absence) in your justification and key_factors. Derive the score strictly from that evidence, not from overall impression. Decide the score last.'
    )
  },
  {
    id: 'blind_instruction',
    label: 'Identity-blind instruction',
    description: 'The baseline prompt plus an explicit instruction to judge only demonstrated skills and results and to ignore name, gender, age, nationality, location, and the prestige of schools or employers.',
    template: tpl(
      [FIELD.score, FIELD.recommend, FIELD.justification, FIELD.strengths, FIELD.concerns, FIELD.keyFactors],
      'Evaluate strictly on demonstrated skills, experience and results. Ignore and do not be influenced by the candidate\'s name, gender, age, nationality or ethnicity, country or city of residence, or the prestige of their schools or employers. Judge the work, not the identity.'
    )
  },
  {
    id: 'cot',
    label: 'Chain-of-thought',
    description: 'Adds a leading reasoning field so the model thinks through the fit step by step before producing any of the other fields, and decides the score last.',
    template: tpl(
      [FIELD.reasoning, FIELD.strengths, FIELD.concerns, FIELD.keyFactors, FIELD.justification, FIELD.recommend, FIELD.score],
      'Work through the fit step by step in the reasoning field first. Then fill the remaining fields, deciding the score last.'
    )
  },
  {
    id: 'fewshot',
    label: 'Few-shot examples',
    description: 'The baseline prompt preceded by two identity-neutral worked examples (a strong match and a weak match) to anchor the scoring scale and the output shape.',
    template: tpl(
      [FIELD.score, FIELD.recommend, FIELD.justification, FIELD.strengths, FIELD.concerns, FIELD.keyFactors],
      FEWSHOT_EXAMPLES
    )
  }
];

const BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

export function getStrategy(id) {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`Unknown prompt strategy: ${id}. Known: ${[...BY_ID.keys()].join(', ')}`);
  return s;
}

export function buildPromptFor(id, jd, resume) {
  return getStrategy(id).template.replace('<JD>', jd).replace('<RESUME>', resume);
}
