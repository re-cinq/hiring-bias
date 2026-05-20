import fs from 'node:fs/promises';
import path from 'node:path';

const RESULTS_DIR = 'results';

function axisOf(variant) {
  if (variant === 'baseline') return null;
  return variant.split('_')[0];
}

function mean(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function loadResults() {
  const files = await fs.readdir(RESULTS_DIR);
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(RESULTS_DIR, file), 'utf8');
    out.push(JSON.parse(raw));
  }
  return out;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

async function main() {
  const records = (await loadResults()).filter((r) => typeof r.response?.score === 'number');

  const cellMean = new Map();
  for (const [key, recs] of groupBy(records, (r) => `${r.model}|${r.jd}|${r.variant}`)) {
    cellMean.set(key, mean(recs.map((r) => r.response.score)));
  }

  const baselineByModelJd = new Map();
  for (const [key, val] of cellMean) {
    const [model, jd, variant] = key.split('|');
    if (variant === 'baseline') baselineByModelJd.set(`${model}|${jd}`, val);
  }

  const axisData = new Map();
  for (const [key, val] of cellMean) {
    const [model, jd, variant] = key.split('|');
    const axis = axisOf(variant);
    if (!axis) continue;
    const baseline = baselineByModelJd.get(`${model}|${jd}`);
    if (baseline === undefined) continue;
    const delta = val - baseline;
    const ak = `${model}|${axis}`;
    if (!axisData.has(ak)) axisData.set(ak, []);
    axisData.get(ak).push({ variant, jd, delta, score: val, baseline });
  }

  const rows = [];
  for (const [key, samples] of axisData) {
    const [model, axis] = key.split('|');
    const abs = samples.map((s) => Math.abs(s.delta));
    samples.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    rows.push({
      model,
      axis,
      n: samples.length,
      mean_abs: mean(abs),
      max_abs: Math.max(...abs),
      worst: samples[0]
    });
  }
  rows.sort((a, b) => a.model.localeCompare(b.model) || b.mean_abs - a.mean_abs);

  console.log('\n## Per-model axis sensitivity (sorted by mean |delta|)\n');
  console.log('| model | axis | cells | mean |Δ| | max |Δ| | worst case |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    const w = r.worst;
    const sign = w.delta >= 0 ? '+' : '';
    console.log(`| ${r.model} | ${r.axis} | ${r.n} | ${r.mean_abs.toFixed(2)} | ${r.max_abs.toFixed(2)} | ${w.variant} / ${w.jd}: ${sign}${w.delta.toFixed(2)} |`);
  }

  console.log('\n## Cross-model axis-rank consistency\n');
  const byAxis = groupBy(rows, (r) => r.axis);
  console.log('| axis | claude-opus | gemini-2.5-pro | gemini-2.5-flash | gemini-3.1-pro-preview | llama-4-maverick | qwen-3-next-80b |');
  console.log('|---|---|---|---|---|---|---|');
  const orderedModels = ['claude-opus', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview', 'llama-4-maverick', 'qwen-3-next-80b'];
  const axes = [...byAxis.keys()].sort();
  for (const axis of axes) {
    const cells = orderedModels.map((m) => {
      const r = byAxis.get(axis).find((x) => x.model === m);
      return r ? `${r.mean_abs.toFixed(2)}` : '—';
    });
    console.log(`| ${axis} | ${cells.join(' | ')} |`);
  }
}

main();
