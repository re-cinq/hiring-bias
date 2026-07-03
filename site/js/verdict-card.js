import { el, pill, fmtNum } from './lib.js';
import { wordDiff } from './linediff.js';
import { dotStrip, collapseValues, SCORE_SCALE } from './dot-strip.js';

// Shared verdict-card rendering used by the counterfactual diff page and the prompt
// lab comparator. A "card" shows one evaluation: score, recommend pill, the per-run
// score strip, and the justification / strengths / concerns / key_factors, optionally
// word-diffed against a comparison sample.

export function verdictCard(title, data, runIdx = 0, compare = null, onSelectRun = null, belowScores = null) {
  const card = el('div', { class: 'card' });
  // Selected per-run response (from data.runs[runIdx]); fall back to legacy data.sample.
  const sample = data.runs?.[runIdx]?.response ?? data.sample;

  card.append(el('div', { class: 'head' }, [
    el('span', { class: 'label' }, title),
    sample ? pill(sample.recommend_interview) : el('span', {})
  ]));

  card.append(el('div', {}, [
    'Score: ', el('strong', {}, sample?.score ?? fmtNum(data.mean, 2) ?? '–'),
    ' · Mean: ', el('strong', {}, fmtNum(data.mean, 2)),
    ' · Recommend rate: ', el('strong', {}, data.recommend_rate != null ? `${(data.recommend_rate * 100).toFixed(0)}%` : '–')
  ]));
  card.append(renderRunScores(data, runIdx, onSelectRun));
  // Optional slot rendered directly under the score strip (used by the Prompt Lab to
  // show the exact prompt that produced this card). Plain content, no diffing.
  if (belowScores) card.append(belowScores);

  if (sample?.justification) {
    card.append(el('h4', {}, 'Justification'));
    card.append(el('p', { class: 'dim' }, diffText(compare?.justification, sample.justification)));
  }
  if (sample?.strengths?.length) {
    card.append(el('h4', {}, 'Strengths'));
    const ul = el('ul');
    for (const s of sample.strengths) ul.append(el('li', {}, diffText(bestMatch(s, compare?.strengths), s)));
    card.append(ul);
  }
  if (sample?.concerns?.length) {
    card.append(el('h4', {}, 'Concerns'));
    const ul = el('ul');
    for (const c of sample.concerns) ul.append(el('li', {}, diffText(bestMatch(c, compare?.concerns), c)));
    card.append(ul);
  }
  if (sample?.key_factors?.length) {
    card.append(el('h4', {}, 'Key factors'));
    const ul = el('ul');
    for (const f of sample.key_factors) {
      ul.append(el('li', {}, [
        `${f.factor} `,
        el('span', { class: f.direction === 'positive' ? 'accent' : 'alert' }, f.direction),
        ` · `,
        el('span', { class: 'dim' }, f.weight)
      ]));
    }
    card.append(ul);
  }
  return card;
}

// Render `text`, underlining in red the words inserted/changed vs `baselineText`.
// A null baselineText means "no comparison" → plain text.
export function diffText(baselineText, text) {
  if (baselineText == null) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  wordDiff(baselineText, text).forEach((t, i) => {
    if (i) frag.append(' ');
    frag.append(t.changed ? el('span', { class: 'eval-diff' }, t.text) : document.createTextNode(t.text));
  });
  return frag;
}

// Pick the baseline list item sharing the most words with `item`, so each
// variant bullet is diffed against its closest baseline counterpart.
// '' (no overlap) highlights the whole item as new; null means no comparison.
export function bestMatch(item, candidates) {
  if (candidates == null) return null;
  const words = new Set(item.toLowerCase().split(/\s+/).filter(Boolean));
  let best = '', bestScore = 0;
  for (const candidate of candidates) {
    const score = candidate.toLowerCase().split(/\s+/).filter((w) => words.has(w)).length;
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}

// The 0–10 distribution strip for one evaluation: one hollow dot per run (colored by
// that run's recommendation) and a filled green dot at the mean. Runs sharing a score
// stack vertically on the same x, so each stays visible and individually clickable.
// The mean dot paints first (underneath) so it never intercepts a run dot's click.
// When onSelectRun is given the dots are click targets and the active run is highlighted.
export function renderRunScores(data, runIdx = 0, onSelectRun = null) {
  const wrap = el('div', { class: 'runscores' });
  const scores = Array.isArray(data?.scores) ? data.scores : [];

  const markers = [];
  if (data?.mean != null) {
    markers.push({ value: data.mean, filled: true, cls: 'mean', title: `mean ${fmtNum(data.mean, 2)}` });
  }
  let stacked = false;
  for (const { value, indexes } of collapseValues(scores)) {
    if (indexes.length > 1) stacked = true;
    indexes.forEach((runI, k) => {
      const rec = data.runs?.[runI]?.response?.recommend_interview;
      const marker = {
        value,
        dy: (k - (indexes.length - 1) / 2) * 7,
        cls: ['yes', 'no', 'maybe'].includes(rec) ? `iter ${rec}` : 'iter',
        selected: runI === runIdx,
        title: `run ${runI + 1} (${rec ?? '–'}) · score ${value}`
      };
      if (onSelectRun) marker.onClick = () => onSelectRun(runI);
      markers.push(marker);
    });
  }
  if (!markers.length) return wrap;

  wrap.append(dotStrip({ ...SCORE_SCALE, cls: stacked ? 'runs' : '', markers }));
  if (onSelectRun && scores.length) {
    wrap.append(el('div', { class: 'strip-caption' }, '○ runs (stacked = same score) · ● mean · click a dot to view that run'));
  }
  return wrap;
}
