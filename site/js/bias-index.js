import { el, fmtNum, fmtPct, fmtSignedDelta } from './lib.js';

const MODEL_DISPLAY = {
  'claude-opus': 'Claude Opus',
  'claude-sonnet': 'Claude Sonnet',
  'claude-haiku': 'Claude Haiku',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro · Preview',
  'llama-4-maverick': 'Llama 4 Maverick',
  'mistral-large': 'Mistral Large',
  'mistral-small': 'Mistral Small',
  'qwen-3-next-80b': 'Qwen 3 Next 80B'
};

export function computeBiasIndex(matrix) {
  const stats = {};
  for (const m of matrix.models) {
    stats[m] = { absSum: 0, signedSum: 0, n: 0, sigN: 0, mostPenalised: null, mostRewarded: null };
  }
  for (const axis of matrix.axes) {
    const levels = matrix.levels_by_axis?.[axis] ?? [];
    for (const level of levels) {
      for (const m of matrix.models) {
        const cell = matrix.matrix?.[axis]?.[level]?.[m];
        if (!cell || cell.mean_delta == null) continue;
        const s = stats[m];
        s.absSum += Math.abs(cell.mean_delta);
        s.signedSum += cell.mean_delta;
        s.n++;
        if (cell.sig_rate >= 0.5) s.sigN++;
        if (!s.mostPenalised || cell.mean_delta < s.mostPenalised.mean_delta) {
          s.mostPenalised = { axis, level, mean_delta: cell.mean_delta };
        }
        if (!s.mostRewarded || cell.mean_delta > s.mostRewarded.mean_delta) {
          s.mostRewarded = { axis, level, mean_delta: cell.mean_delta };
        }
      }
    }
  }
  const out = [];
  for (const m of matrix.models) {
    const s = stats[m];
    out.push({
      model: m,
      n: s.n,
      mean_abs_delta: s.n ? s.absSum / s.n : null,
      mean_signed_delta: s.n ? s.signedSum / s.n : null,
      sig_fraction: s.n ? s.sigN / s.n : null,
      most_penalised: s.mostPenalised,
      most_rewarded: s.mostRewarded
    });
  }
  return out.sort((a, b) => (b.mean_abs_delta ?? -1) - (a.mean_abs_delta ?? -1));
}

function bar(value, max) {
  const wrap = el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } });
  const track = el('div', { style: {
    flex: '1', height: '9px',
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    overflow: 'hidden', position: 'relative'
  } });
  const fill = el('div', { style: {
    height: '100%',
    width: `${Math.min(100, (value / max) * 100)}%`,
    background: 'var(--accent)',
    transition: 'width 200ms ease'
  } });
  track.append(fill);
  wrap.append(track);
  return wrap;
}

function signedClass(v) {
  if (v == null) return 'dim';
  if (v > 0.02) return 'accent';
  if (v < -0.02) return 'alert';
  return 'dim';
}

function variantWithDelta(matrix, entry, klass) {
  if (!entry) return el('span', { class: 'dim' }, '—');
  const label = `${matrix.axis_labels?.[entry.axis] ?? entry.axis} · ${matrix.level_labels?.[entry.axis]?.[entry.level] ?? entry.level}`;
  return el('span', {}, [
    label, ' ',
    el('span', { class: klass }, `(${entry.mean_delta >= 0 ? '+' : ''}${entry.mean_delta.toFixed(2)})`)
  ]);
}

export function computeDimensionBias(matrix) {
  const stats = {};
  for (const axis of matrix.axes) {
    stats[axis] = { absSum: 0, signedSum: 0, n: 0, sigN: 0, worstByModel: null, worstByVariant: null };
  }
  for (const axis of matrix.axes) {
    const levels = matrix.levels_by_axis?.[axis] ?? [];
    for (const level of levels) {
      for (const m of matrix.models) {
        const cell = matrix.matrix?.[axis]?.[level]?.[m];
        if (!cell || cell.mean_delta == null) continue;
        const s = stats[axis];
        const absD = Math.abs(cell.mean_delta);
        s.absSum += absD;
        s.signedSum += cell.mean_delta;
        s.n++;
        if (cell.sig_rate >= 0.5) s.sigN++;
        if (!s.worstByVariant || absD > Math.abs(s.worstByVariant.mean_delta)) {
          s.worstByVariant = { level, model: m, mean_delta: cell.mean_delta };
        }
      }
    }
  }
  const out = [];
  for (const axis of matrix.axes) {
    const s = stats[axis];
    out.push({
      axis,
      n: s.n,
      mean_abs_delta: s.n ? s.absSum / s.n : null,
      mean_signed_delta: s.n ? s.signedSum / s.n : null,
      sig_fraction: s.n ? s.sigN / s.n : null,
      worst: s.worstByVariant
    });
  }
  return out.sort((a, b) => (b.mean_abs_delta ?? -1) - (a.mean_abs_delta ?? -1));
}

export function renderDimensionBias(host, matrix, { title = 'WHICH DIMENSION TRIGGERS THE MOST BIAS?', description = 'Same data, grouped by what we changed instead of who did the changing. The mean |Δ| pools every model, variant, and job for each demographic axis. The axis at the top is the one models react to most reliably.' } = {}) {
  host.innerHTML = '';
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, title)));
  panel.append(el('p', { class: 'dim' }, description));

  const indexes = computeDimensionBias(matrix);
  const worldMax = Math.max(...indexes.map((s) => s.mean_abs_delta ?? 0), 0.0001);

  const table = el('table', { class: 'data' });
  table.append(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Dimension'),
    el('th', {}, 'Bias index'),
    el('th', { class: 'num' }, 'Mean |Δ|'),
    el('th', { class: 'num' }, 'Mean signed Δ'),
    el('th', { class: 'num' }, '% sig'),
    el('th', { class: 'num' }, 'Cells'),
    el('th', {}, 'Single biggest shift')
  ])));
  const tbody = el('tbody');
  for (const s of indexes) {
    const worstLabel = s.worst ? `${matrix.level_labels?.[s.axis]?.[s.worst.level] ?? s.worst.level} on ${MODEL_DISPLAY[s.worst.model] ?? s.worst.model}` : '—';
    tbody.append(el('tr', {}, [
      el('td', {}, matrix.axis_labels?.[s.axis] ?? s.axis),
      el('td', { style: { width: '20%' } }, bar(s.mean_abs_delta ?? 0, worldMax)),
      el('td', { class: 'num' }, fmtNum(s.mean_abs_delta, 3)),
      el('td', { class: `num ${signedClass(s.mean_signed_delta)}` }, s.mean_signed_delta != null ? (s.mean_signed_delta >= 0 ? '+' : '') + s.mean_signed_delta.toFixed(3) : '—'),
      el('td', { class: 'num' }, s.sig_fraction != null ? fmtPct(s.sig_fraction, 0) : '—'),
      el('td', { class: 'num dim' }, s.n),
      el('td', {}, s.worst ? el('span', {}, [
        worstLabel, ' ',
        el('span', { class: s.worst.mean_delta >= 0 ? 'accent' : 'alert' }, `(${s.worst.mean_delta >= 0 ? '+' : ''}${s.worst.mean_delta.toFixed(2)})`)
      ]) : el('span', { class: 'dim' }, '—'))
    ]));
  }
  table.append(tbody);
  panel.append(table);
  host.append(panel);
}

export function renderBiasIndex(host, matrix, { title = 'GLOBAL BIAS INDEX — MEAN |Δ| ACROSS ALL CELLS', description = 'For each model, the average absolute score change when a demographic signal is altered, taken over every (axis, variant, JD) cell with data. Higher = the model is more sensitive to demographic signals; lower = more even-handed.' } = {}) {
  host.innerHTML = '';
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, title)));
  panel.append(el('p', { class: 'dim' }, description));

  const indexes = computeBiasIndex(matrix);
  const worldMax = Math.max(...indexes.map((s) => s.mean_abs_delta ?? 0), 0.0001);

  const table = el('table', { class: 'data' });
  table.append(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Model'),
    el('th', {}, 'Bias index'),
    el('th', { class: 'num' }, 'Mean |Δ|'),
    el('th', { class: 'num' }, 'Mean signed Δ'),
    el('th', { class: 'num' }, '% sig'),
    el('th', { class: 'num' }, 'Cells'),
    el('th', {}, 'Most penalised'),
    el('th', {}, 'Most rewarded')
  ])));
  const tbody = el('tbody');
  for (const s of indexes) {
    tbody.append(el('tr', {}, [
      el('td', {}, MODEL_DISPLAY[s.model] ?? s.model),
      el('td', { style: { width: '20%' } }, bar(s.mean_abs_delta ?? 0, worldMax)),
      el('td', { class: 'num' }, fmtNum(s.mean_abs_delta, 3)),
      el('td', { class: `num ${signedClass(s.mean_signed_delta)}` }, s.mean_signed_delta != null ? (s.mean_signed_delta >= 0 ? '+' : '') + s.mean_signed_delta.toFixed(3) : '—'),
      el('td', { class: 'num' }, s.sig_fraction != null ? fmtPct(s.sig_fraction, 0) : '—'),
      el('td', { class: 'num dim' }, s.n),
      el('td', {}, variantWithDelta(matrix, s.most_penalised, 'alert')),
      el('td', {}, variantWithDelta(matrix, s.most_rewarded, 'accent'))
    ]));
  }
  table.append(tbody);
  panel.append(table);
  host.append(panel);
}

function variantLabelFromId(matrix, id) {
  if (id === 'baseline') return 'baseline (unmodified)';
  const idx = id.indexOf('_');
  if (idx < 0) return id;
  const axis = id.slice(0, idx);
  const level = id.slice(idx + 1);
  return `${matrix.axis_labels?.[axis] ?? axis} · ${matrix.level_labels?.[axis]?.[level] ?? level}`;
}

function variantDelta(matrix, id, model) {
  if (id === 'baseline') return 0;
  const idx = id.indexOf('_');
  if (idx < 0) return null;
  const axis = id.slice(0, idx);
  const level = id.slice(idx + 1);
  return matrix.matrix?.[axis]?.[level]?.[model]?.mean_delta ?? null;
}

function divergingBar(diff, max) {
  const half = max > 0 ? Math.min(50, (Math.abs(diff) / max) * 50) : 0;
  const track = el('div', { style: {
    position: 'relative', height: '9px',
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden'
  } });
  const fill = el('div', { style: {
    position: 'absolute', top: '0', height: '100%',
    width: `${half}%`,
    left: diff >= 0 ? '50%' : `${50 - half}%`,
    background: diff >= 0 ? 'var(--accent)' : 'var(--alert)',
    transition: 'all 200ms ease'
  } });
  const tick = el('div', { style: {
    position: 'absolute', left: '50%', top: '0', width: '1px', height: '100%', background: 'var(--border)'
  } });
  track.append(fill, tick);
  return track;
}

export function renderResumeComparison(host, matrix, fromId, toId) {
  host.innerHTML = '';
  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'HOW EACH MODEL SCORES THESE TWO RÉSUMÉS')));

  if (fromId === toId) {
    panel.append(el('p', { class: 'dim' }, 'Same variant on both sides — pick two different variants to see which one each model scores higher.'));
    host.append(panel);
    return;
  }

  const leftLabel = variantLabelFromId(matrix, fromId);
  const rightLabel = variantLabelFromId(matrix, toId);
  panel.append(el('p', { class: 'dim' }, [
    'Each model’s mean score change versus the unmodified baseline, for the left and right résumé (averaged over all JDs with data). ',
    el('span', { class: 'accent' }, 'Green'), ' = the right résumé scored higher, ',
    el('span', { class: 'alert' }, 'red'), ' = the left scored higher. Margin is the size of that gap.'
  ]));

  const rows = matrix.models.map((m) => {
    const l = variantDelta(matrix, fromId, m);
    const r = variantDelta(matrix, toId, m);
    const diff = l == null || r == null ? null : r - l;
    return { model: m, l, r, diff };
  });
  const worldMax = Math.max(...rows.map((s) => (s.diff == null ? 0 : Math.abs(s.diff))), 0.0001);

  const table = el('table', { class: 'data' });
  table.append(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Model'),
    el('th', { class: 'num' }, `Left Δ (${leftLabel})`),
    el('th', { class: 'num' }, `Right Δ (${rightLabel})`),
    el('th', {}, 'Stronger résumé'),
    el('th', {}, 'Margin'),
    el('th', { class: 'num' }, '|Δ|')
  ])));
  const tbody = el('tbody');
  for (const s of rows) {
    let stronger;
    if (s.diff == null) {
      stronger = el('span', { class: 'dim' }, 'no data');
    } else if (Math.abs(s.diff) < 0.005) {
      stronger = el('span', { class: 'dim' }, 'tie');
    } else {
      stronger = el('span', { class: s.diff > 0 ? 'accent' : 'alert' }, s.diff > 0 ? `Right · ${rightLabel}` : `Left · ${leftLabel}`);
    }
    tbody.append(el('tr', {}, [
      el('td', {}, MODEL_DISPLAY[s.model] ?? s.model),
      el('td', { class: `num ${signedClass(s.l)}` }, fmtSignedDelta(s.l, 3)),
      el('td', { class: `num ${signedClass(s.r)}` }, fmtSignedDelta(s.r, 3)),
      el('td', {}, stronger),
      el('td', { style: { width: '20%' } }, s.diff == null ? el('span', { class: 'dim' }, '—') : divergingBar(s.diff, worldMax)),
      el('td', { class: 'num dim' }, s.diff == null ? '—' : Math.abs(s.diff).toFixed(3))
    ]));
  }
  table.append(tbody);
  panel.append(table);
  host.append(panel);
}
