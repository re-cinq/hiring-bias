// Metrics that judge whether a model's numeric score is actually grounded in the
// feedback it produced, derived purely from the model's own output. Shared by the
// Prompt Lab analysis (and reusable for any score-vs-feedback coherence work).

const WEIGHT_MAGNITUDE = { high: 3, medium: 2, low: 1 };

// Map the model's own key_factors (its stated drivers) to a single signed number:
// positive factors push up, negative factors push down, scaled by weight. A score
// that tracks this signal is one the model can actually justify; a score that does
// not is a number decoupled from the stated reasoning.
export function keyFactorSignal(response) {
  const factors = Array.isArray(response?.key_factors) ? response.key_factors : [];
  let signal = 0;
  for (const f of factors) {
    const dir = f?.direction === 'positive' ? 1 : f?.direction === 'negative' ? -1 : 0;
    const mag = WEIGHT_MAGNITUDE[f?.weight] ?? 0;
    signal += dir * mag;
  }
  return signal;
}

// Three key factors, each ±(high 3 | medium 2 | low 1), so the signal runs -9 to +9.
export const MAX_KEY_FACTOR_SIGNAL = 9;

const SCORE_MIN = 1;
const SCORE_MAX = 10;

// The widest a 1-10 score can travel, and so the common ruler for both an observed score
// move and an implied one.
export const MAX_SCORE_SWING = SCORE_MAX - SCORE_MIN;

// The 1-10 score and the -9..+9 key-factor signal are two outputs of the same evaluation
// on two different scales. Mapping the signal linearly onto the score scale asks what the
// model would have scored if the number simply reported the factors it wrote down, which
// is the figure the score it actually gave can be read against. The endpoints line up: a
// signal of -9 implies 1/10, +9 implies 10/10, so an implied move and a real one are both
// measured in score points out of MAX_SCORE_SWING.
export function impliedScore(signal) {
  if (typeof signal !== 'number') return null;
  const mid = (SCORE_MIN + SCORE_MAX) / 2;
  return mid + (signal / MAX_KEY_FACTOR_SIGNAL) * (MAX_SCORE_SWING / 2);
}

const POSITIVE_LEXICON = new Set([
  'strong', 'strongly', 'excellent', 'proven', 'expert', 'extensive', 'solid', 'impressive',
  'relevant', 'deep', 'significant', 'outstanding', 'exceptional', 'clear', 'directly',
  'demonstrated', 'leadership', 'scalable', 'robust', 'aligned', 'fit', 'qualified', 'ideal'
]);
const NEGATIVE_LEXICON = new Set([
  'lacks', 'lacking', 'missing', 'insufficient', 'concern', 'concerns', 'concerning', 'gap',
  'gaps', 'limited', 'weak', 'unclear', 'mismatch', 'inadequate', 'short', 'thin', 'no',
  'none', 'without', 'unproven', 'risk', 'risky', 'overqualified', 'underqualified', 'irrelevant'
]);

// Secondary, cruder coherence signal: net sentiment of the justification prose,
// normalised to roughly [-1, 1]. Pairs with keyFactorSignal as a sanity cross-check.
export function justificationSentiment(text) {
  const words = String(text ?? '').toLowerCase().match(/[a-z']+/g) ?? [];
  let pos = 0, neg = 0;
  for (const w of words) {
    if (POSITIVE_LEXICON.has(w)) pos++;
    else if (NEGATIVE_LEXICON.has(w)) neg++;
  }
  if (pos + neg === 0) return 0;
  return (pos - neg) / (pos + neg);
}

export function recommendOf(record) {
  return record?.response?.recommend_interview ?? null;
}

// Most common recommend_interview across a set of records (null if empty).
export function modalRecommend(records) {
  const counts = new Map();
  for (const r of records) {
    const v = recommendOf(r);
    if (v == null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = null, bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

// True when every run in the cell returned the same interview recommendation.
export function recommendUnanimous(records) {
  const seen = new Set();
  for (const r of records) {
    const v = recommendOf(r);
    if (v != null) seen.add(v);
  }
  return seen.size <= 1;
}
