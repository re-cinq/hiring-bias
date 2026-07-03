import { el } from './lib.js';

// Shared distribution strip: a thin track over a fixed [min, max] domain with round
// markers on it. Filled markers are headline values (a mean, a delta); hollow markers
// are the underlying data points (runs, models, cells). Used by the verdict cards, the
// prompt-lab metric tables, the transplant leaderboard and both delta-bar pages, so
// every table on the site draws its dots the same way.
//
// markers: [{ value, filled, cls, title, selected, onClick }] — rendered in order, so
// append the marker that should paint on top last.
export function dotStrip({ min, max, markers = [], ticks = [], scaleLabels = null, ci = null }) {
  const span = max - min;
  const pos = (v) => Math.max(0, Math.min(100, ((v - min) / span) * 100));

  const bar = el('div', { class: 'delta-bar' });
  for (const t of ticks) {
    bar.append(el('div', {
      class: `tick${t.center ? ' center' : ''}`,
      style: { left: `${pos(t.at).toFixed(1)}%` },
      title: t.label ?? null
    }));
  }
  if (ci && ci.lo != null && ci.hi != null) {
    const left = pos(ci.lo);
    const width = Math.max(0.5, pos(ci.hi) - left);
    bar.append(el('div', {
      class: `ci ${ci.cls ?? ''}`,
      style: { left: `${left.toFixed(1)}%`, width: `${width.toFixed(1)}%` },
      title: ci.title ?? null
    }));
  }
  for (const m of markers) {
    if (m.value == null) continue;
    const classes = ['marker', m.filled ? 'filled' : 'hollow'];
    if (m.cls) classes.push(m.cls);
    if (m.selected) classes.push('selected');
    if (m.onClick) classes.push('clickable');
    const attrs = { class: classes.join(' '), style: { left: `${pos(m.value).toFixed(1)}%` } };
    if (m.title) attrs.title = m.title;
    if (m.onClick) attrs.onclick = m.onClick;
    bar.append(el('div', attrs));
  }

  if (!scaleLabels) return bar;
  const wrap = el('div');
  wrap.append(bar, el('div', { class: 'delta-bar-scale' }, scaleLabels.map((s) => el('span', {}, s))));
  return wrap;
}

// Collapse a value list into one entry per distinct value, keeping the original
// indexes — integer run scores are guaranteed to collide, and stacking identical
// hollow dots would hide how many there are.
export function collapseValues(values) {
  const groups = new Map();
  values.forEach((v, i) => {
    if (typeof v !== 'number') return;
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(i);
  });
  return [...groups.entries()].map(([value, indexes]) => ({ value, indexes }));
}

// 0–10 score domain used everywhere a raw résumé score is plotted.
export const SCORE_SCALE = {
  min: 0,
  max: 10,
  ticks: [2, 4, 6, 8].map((at) => ({ at, label: String(at) })),
  scaleLabels: ['0', '2', '4', '6', '8', '10']
};

// Fixed −3..+3 Δ-vs-baseline domain shared by the heatmap detail and resume-diff bars.
export const DELTA_SCALE = {
  min: -3,
  max: 3,
  ticks: [
    { at: -2, label: '−2' },
    { at: -1, label: '−1' },
    { at: 1, label: '+1' },
    { at: 2, label: '+2' },
    { at: 0, label: '0 (baseline)', center: true }
  ],
  scaleLabels: ['-3', '-2', '-1', '0', '+1', '+2', '+3']
};
