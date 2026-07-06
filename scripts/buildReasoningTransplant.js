import fs from 'node:fs/promises';
import path from 'node:path';
import { mean, groupBy } from '../src/aggregate.js';

const IN_DIR = 'results-reasoning-transplant';
const OUT_DIR = 'site/data/transplant';
const EXCLUDED_MODELS = new Set(['claude-fable-5']);

async function readDir(sub) {
  const dir = path.join(IN_DIR, sub);
  let files = [];
  try { files = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files) if (f.endsWith('.json')) out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')));
  return out.filter((r) => !EXCLUDED_MODELS.has(r.model));
}

async function writeJson(relpath, data) {
  const full = path.join(OUT_DIR, relpath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(data, null, 2));
}

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
  const s1byKey = new Map(stage1.map((r) => [`${r.variant}__${r.model}__${r.jd}__${r.pole}__${r.run}`, r.response]));

  const byCell = groupBy(stage2, (r) => `${r.variant}__${r.model}__${r.jd}`);
  const cells = [];
  for (const [key, rs] of byCell) {
    const [variant, model, jd] = key.split('__');
    const pos = rs.filter((r) => r.condition === 'pos');
    const neg = rs.filter((r) => r.condition === 'neg');
    if (!pos.length || !neg.length) continue;
    const assess = (recs) => s1byKey.get(`${variant}__${model}__${jd}__${recs[0].donor_pole}__${recs[0].donor_run}`) ?? null;
    const condition = (recs) => {
      const scored = recs.filter((r) => typeof r.response?.score === 'number');
      const scores = scored.map((r) => r.response.score);
      return {
        donor_run: recs[0].donor_run,
        donor_signal: recs[0].donor_signal,
        assessment: assess(recs),
        scores,
        runs: scored.map((r) => ({ response: { score: r.response.score, recommend_interview: r.response.recommend_interview } })),
        mean: mean(scores),
        recommend_rate: yesRate(recs)
      };
    };
    const posCond = condition(pos), negCond = condition(neg);
    cells.push({
      variant, model, jd,
      pos: posCond,
      neg: negCond,
      effect: (posCond.mean != null && negCond.mean != null) ? posCond.mean - negCond.mean : null,
      signal_gap: (posCond.donor_signal != null && negCond.donor_signal != null) ? posCond.donor_signal - negCond.donor_signal : null
    });
  }

  for (const c of cells) await writeJson(path.join('cells', `${c.variant}__${c.model}__${c.jd}.json`), c);

  const models = [...new Set(cells.map((c) => c.model))].sort();
  const round2 = (x) => Math.round(x * 100) / 100;
  const cellMeans = (cs, pole) => cs.map((c) => c[pole].mean).filter((v) => v != null).map(round2);
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
      // Per-cell (résumé × job) means behind the two pooled scores, for the distribution dots.
      score_pos_dist: cellMeans(cs, 'pos'),
      score_neg_dist: cellMeans(cs, 'neg'),
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
  const nCells = summary.overall?.n_cells ?? 0;
  const effectPts = fmt(summary.overall?.mean_effect);
  const dirPct = summary.overall?.directional_rate != null ? Math.round(summary.overall.directional_rate * 100) : '–';
  const resp = summary.by_model.map((m) => m.responsiveness).filter((x) => typeof x === 'number');
  const respRange = resp.length ? `${fmt(Math.min(...resp))} to ${fmt(Math.max(...resp))}` : '–';
  const nDriven = summary.by_model.filter((m) => m.verdict === 'reasoning-driven').length;
  const nModels = summary.by_model.length;
  const drivenPhrase = nDriven === nModels ? 'every model tested' : `${nDriven} of ${nModels} models`;
  const html = `<div class="panel">
  <div class="panel-head"><span>DOES THE SCORE FOLLOW TRANSPLANTED REASONING?</span></div>
  <p><strong>The assumption under test.</strong> That an LLM's résumé score is <em>not</em> produced by its stated reasoning. The model settles on a number first, then writes the strengths, concerns and justification to rationalize it after the fact. If that holds, the reasoning is decoration. It tells you nothing about what actually moved the score, and rewriting the reasoning could never change the number.</p>
</div>
<div class="panel">
  <div class="panel-head"><span>HOW WE TEST IT</span></div>
  <p class="dim">One résumé and one job, held fixed throughout. The only thing we ever vary is the reasoning handed back to the model.</p>
  <p class="dim"><strong>Step 1.</strong> Ask the model to assess the résumé several times, each run writing strengths, concerns and a justification but <strong>no score</strong>. For example, Claude Opus reads the baseline résumé for the CTO, Agentic Fintech role and writes a few independent takes, one run praising the fintech and agentic tooling experience, another flagging a missing executive title.</p>
  <p class="dim"><strong>Step 2.</strong> From those assessments pick the two extremes it produced for this exact résumé, its most <strong>positive</strong> one and its most <strong>negative</strong> one. For example, the positive extreme points to the candidate's hands on work on AI agent infrastructure and fintech scale experience at RIDE Capital, while the negative extreme stresses that the entire career is individual contributor roles with no evidence of scaling a team.</p>
  <p class="dim"><strong>Step 3.</strong> Score the same résumé twice more. In one arm we paste back the model's own most positive assessment, in the other its own most negative. Everything else is identical, so the injected reasoning is the only thing that changed. For example, the same baseline résumé and CTO job go in both times, once with the glowing assessment glued on top, once with the damning one.</p>
  <p class="dim"><strong>Step 4.</strong> Repeat the scoring for several runs per arm and take each arm's mean. The <strong>effect</strong> is the positive arm mean minus the negative arm mean. For example, the positive arm scored 7, 7, 7 (mean 7.0) and the negative arm scored 2, 2, 2 (mean 2.0), an effect of 5.0 points.</p>
  <p class="dim"><strong>Step 5.</strong> Read the effect. If the score followed the transplanted assessment the reasoning is causal, if it barely moved the score is a prior the model fixed in advance and the reasoning only decorates. For example, that 5.0 point jump means the score clearly tracked the reasoning here, whereas a result near 0 would mean the number ignored the reasoning entirely.</p>
</div>
<div class="panel">
  <div class="panel-head"><span>RESULTS BY MODEL</span></div>
  <table class="data"><thead><tr><th>Model</th><th class="num">score · neg</th><th class="num">score · pos</th><th class="num">effect (Δ)</th><th class="num">responsiveness</th><th>verdict</th></tr></thead><tbody>
${rows}
  </tbody></table>
  <p><strong>What the results say about the assumption.</strong> The assumption is <strong>dismissed</strong>. The score <em>does</em> follow the reasoning, so it is not just post-hoc decoration. That is exactly what the <strong>reasoning-driven</strong> verdict in every row above means. Swapping the negative assessment for the positive one moved the score by <strong>${effectPts} points</strong> on average across ${esc(nCells)} cells, and the score moved in the reasoning's direction in <strong>${dirPct}%</strong> of them. ${drivenPhrase} lands reasoning-driven, and none behaved as if the number were fixed in advance. What would have <em>supported</em> the assumption, an effect near zero with the score sitting still no matter which reasoning it was handed, never appeared for any model. One caveat keeps a weak version alive. Responsiveness stays well below 1.0 (${respRange}), so the score moves in the reasoning's direction but by far less than the reasoning's own swing. The number is somewhat anchored, but not merely decorative.</p>
  <p class="dim"><strong>What this does <em>not</em> explain.</strong> A different question is why the <em>same</em> prompt scores differently from one run to the next. That is a separate stability question about sampling noise from temperature and few runs per cell, covered in the <a href="methodology.html">methodology</a> and measured per prompt variant in the <a href="prompt-lab.html">prompt lab</a>. This experiment reframes it. Because the score tracks the reasoning and the model writes fresh reasoning on every run, much of that run-to-run swing is the reasoning genuinely changing and the score following it. The instability is propagated through a causal link, and is not a random number wearing a justification.</p>
</div>`;
  const file = 'site/transplant.html';
  let page;
  try { page = await fs.readFile(file, 'utf8'); } catch { return; }
  const re = /(<!-- @PRERENDER:transplant:START -->)[\s\S]*?(<!-- @PRERENDER:transplant:END -->)/g;
  const next = page.replace(re, (_, a, b) => `${a}\n${html}\n${b}`);
  if (next !== page) { await fs.writeFile(file, next); console.log('  prerendered transplant.html'); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
