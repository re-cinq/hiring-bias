import fs from 'node:fs/promises';
import path from 'node:path';
import { mean, groupBy } from '../src/aggregate.js';

const IN_DIR = 'results-reasoning-transplant';
const OUT_DIR = 'site/data/transplant';

async function readDir(sub) {
  const dir = path.join(IN_DIR, sub);
  let files = [];
  try { files = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files) if (f.endsWith('.json')) out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
  return out;
}

async function writeJson(relpath, data) {
  const full = path.join(OUT_DIR, relpath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(data, null, 2));
}

const scoresOf = (rs) => rs.map((r) => r.response?.score).filter((s) => typeof s === 'number');
const yesRate = (rs) => rs.length ? rs.filter((r) => r.response?.recommend_interview === 'yes').length / rs.length : null;

// effect >= 1.0 pt = the score clearly follows the transplanted reasoning (causal);
// < 0.3 pt = the score barely moves when you swap in opposite reasoning (decorative).
function verdict(effect) {
  if (effect == null) return 'no data';
  if (effect >= 1.0) return 'reasoning-driven';
  if (effect < 0.3) return 'score is a prior (reasoning decorative)';
  return 'mixed';
}

async function main() {
  const stage1 = await readDir('stage1');
  const stage2 = await readDir('stage2');
  if (!stage2.length) {
    console.error(`No stage-2 records in ${IN_DIR}. Run \`npm run run:transplant\` first.`);
    process.exit(1);
  }
  const s1byKey = new Map(stage1.map((r) => [`${r.variant}__${r.model}__${r.jd}__${r.run}`, r.response]));

  const byCell = groupBy(stage2, (r) => `${r.variant}__${r.model}__${r.jd}`);
  const cells = [];
  for (const [key, rs] of byCell) {
    const [variant, model, jd] = key.split('__');
    const pos = rs.filter((r) => r.condition === 'pos');
    const neg = rs.filter((r) => r.condition === 'neg');
    if (!pos.length || !neg.length) continue;
    const posScores = scoresOf(pos), negScores = scoresOf(neg);
    const posMean = mean(posScores), negMean = mean(negScores);
    const donorSigPos = pos[0].donor_signal, donorSigNeg = neg[0].donor_signal;
    const assess = (recs) => s1byKey.get(`${variant}__${model}__${jd}__${recs[0].donor_run}`) ?? null;
    cells.push({
      variant, model, jd,
      pos: { donor_run: pos[0].donor_run, donor_signal: donorSigPos, assessment: assess(pos), scores: posScores, mean: posMean, recommend_rate: yesRate(pos) },
      neg: { donor_run: neg[0].donor_run, donor_signal: donorSigNeg, assessment: assess(neg), scores: negScores, mean: negMean, recommend_rate: yesRate(neg) },
      effect: (posMean != null && negMean != null) ? posMean - negMean : null,
      signal_gap: (donorSigPos != null && donorSigNeg != null) ? donorSigPos - donorSigNeg : null
    });
  }

  for (const c of cells) await writeJson(path.join('cells', `${c.variant}__${c.model}__${c.jd}.json`), c);

  const models = [...new Set(cells.map((c) => c.model))].sort();
  const byModel = models.map((m) => {
    const cs = cells.filter((c) => c.model === m && c.effect != null);
    const effects = cs.map((c) => c.effect);
    const gaps = cs.map((c) => c.signal_gap).filter((g) => typeof g === 'number');
    const meanEffect = mean(effects);
    const meanGap = mean(gaps);
    return {
      model: m,
      n_cells: cs.length,
      score_pos_mean: mean(cs.map((c) => c.pos.mean)),
      score_neg_mean: mean(cs.map((c) => c.neg.mean)),
      mean_effect: meanEffect,
      mean_signal_gap: meanGap,
      responsiveness: (meanEffect != null && meanGap) ? meanEffect / meanGap : null,
      directional_rate: cs.length ? cs.filter((c) => c.effect > 0).length / cs.length : null,
      verdict: verdict(meanEffect)
    };
  });

  const allCs = cells.filter((c) => c.effect != null);
  const overall = {
    n_cells: allCs.length,
    mean_effect: mean(allCs.map((c) => c.effect)),
    mean_signal_gap: mean(allCs.map((c) => c.signal_gap).filter((g) => typeof g === 'number')),
    directional_rate: allCs.length ? allCs.filter((c) => c.effect > 0).length / allCs.length : null
  };

  const summary = {
    generated_at: new Date().toISOString(),
    models,
    resumes: [...new Set(cells.map((c) => c.variant))].sort(),
    jds: [...new Set(cells.map((c) => c.jd))].sort(),
    overall,
    by_model: byModel
  };
  await writeJson('summary.json', summary);
  await prerender(summary);

  console.log(`Transplant built: ${stage2.length} stage-2 records, ${cells.length} cells, ${models.length} models.`);
  console.log(`Overall mean effect (score_pos − score_neg): ${overall.mean_effect?.toFixed(2)} pts over ${overall.n_cells} cells; verdict: ${verdict(overall.mean_effect)}`);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (x, d = 2) => (x == null ? '–' : Number(x).toFixed(d));

async function prerender(summary) {
  const rows = summary.by_model.map((m) =>
    `<tr><td>${esc(m.model)}</td><td class="num">${fmt(m.score_neg_mean)}</td><td class="num">${fmt(m.score_pos_mean)}</td><td class="num">${fmt(m.mean_effect)}</td><td class="num">${fmt(m.responsiveness)}</td><td>${esc(m.verdict)}</td></tr>`
  ).join('\n');
  const html = `<div class="panel">
  <div class="panel-head"><span>DOES THE SCORE FOLLOW TRANSPLANTED REASONING?</span></div>
  <p class="dim">Same résumé, scored twice: once given the model's most <strong>positive</strong> self-generated assessment, once its most <strong>negative</strong>. If the score follows the assessment, the reasoning is causal; if it barely moves, the score is a pre-decided prior the reasoning only decorates. Overall effect: <strong>${fmt(summary.overall?.mean_effect)} points</strong> across ${esc(summary.overall?.n_cells ?? 0)} cells; the score moved in the reasoning's direction in <strong>${summary.overall?.directional_rate != null ? Math.round(summary.overall.directional_rate * 100) : '–'}%</strong> of them.</p>
  <table class="data"><thead><tr><th>Model</th><th class="num">score · neg</th><th class="num">score · pos</th><th class="num">effect (Δ)</th><th class="num">responsiveness</th><th>verdict</th></tr></thead><tbody>
${rows}
  </tbody></table>
</div>`;
  const file = 'site/transplant.html';
  let page;
  try { page = await fs.readFile(file, 'utf8'); } catch { return; }
  const re = /(<!-- @PRERENDER:transplant:START -->)[\s\S]*?(<!-- @PRERENDER:transplant:END -->)/g;
  const next = page.replace(re, (_, a, b) => `${a}\n${html}\n${b}`);
  if (next !== page) { await fs.writeFile(file, next); console.log('  prerendered transplant.html'); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
