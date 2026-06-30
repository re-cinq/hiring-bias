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
