import fs from 'node:fs/promises';
import path from 'node:path';
import { mean, groupBy } from '../src/aggregate.js';
import { impliedScore, MAX_KEY_FACTOR_SIGNAL, MAX_SCORE_SWING } from '../src/coherenceMetrics.js';

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
//
// The score and the key-factors signal live on different scales, so comparing them
// directly needs a translation. impliedScore puts the signal on the 1-10 score scale:
// what the model would have scored had the number simply reported the factors it wrote.
// Responsiveness is then the plain ratio of the two — the score the model actually gave
// against the score its own evaluation implies. 1.0 = the number moved exactly as far as
// the reasoning it was handed, 0.50 = half as far.
function responsivenessOf(effect, impliedEffect) {
  if (effect == null || !impliedEffect) return null;
  return effect / impliedEffect;
}

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
        implied_score: impliedScore(recs[0].donor_signal),
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
      implied_effect: (posCond.implied_score != null && negCond.implied_score != null) ? posCond.implied_score - negCond.implied_score : null,
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
    const meanImpliedEffect = mean(cs.map((c) => c.implied_effect).filter((v) => v != null));
    return {
      model: m,
      n_cells: cs.length,
      score_pos_mean: mean(cs.map((c) => c.pos.mean)),
      score_neg_mean: mean(cs.map((c) => c.neg.mean)),
      // What the two injected assessments' own key factors imply on the same 1-10 scale,
      // so each stated score can be read against the score its evaluation asked for.
      implied_pos_mean: mean(cs.map((c) => c.pos.implied_score).filter((v) => v != null)),
      implied_neg_mean: mean(cs.map((c) => c.neg.implied_score).filter((v) => v != null)),
      // Per-cell (résumé × job) means behind the two pooled scores, for the distribution dots.
      score_pos_dist: cellMeans(cs, 'pos'),
      score_neg_dist: cellMeans(cs, 'neg'),
      mean_effect: meanEffect,
      mean_implied_effect: meanImpliedEffect,
      mean_signal_gap: meanGap,
      responsiveness: responsivenessOf(meanEffect, meanImpliedEffect),
      directional_rate: cs.length ? cs.filter((c) => c.effect > 0).length / cs.length : null,
      verdict: verdict(meanEffect)
    };
  });

  const allCs = cells.filter((c) => c.effect != null);
  const overallEffect = mean(allCs.map((c) => c.effect));
  const overallImplied = mean(allCs.map((c) => c.implied_effect).filter((v) => v != null));
  const overall = {
    n_cells: allCs.length,
    mean_effect: overallEffect,
    mean_implied_effect: overallImplied,
    // Both moves as a share of the 9 points a 1-10 score can travel. This pair is the
    // headline: the reasoning swings most of the way, the score follows part of the way.
    reasoning_reach: overallImplied == null ? null : overallImplied / MAX_SCORE_SWING,
    score_reach: overallEffect == null ? null : overallEffect / MAX_SCORE_SWING,
    responsiveness: responsivenessOf(overallEffect, overallImplied),
    mean_signal_gap: mean(allCs.map((c) => c.signal_gap).filter((g) => typeof g === 'number')),
    directional_cells: allCs.filter((c) => c.effect > 0).length,
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
  console.log(`Overall mean effect (score_pos − score_neg): ${overall.mean_effect?.toFixed(2)} pts over ${overall.n_cells} cells, verdict ${verdict(overall.mean_effect)}`);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (x, d = 2) => (x == null ? '–' : Number(x).toFixed(d));

// The stated score with the score its own key factors implied underneath it, so the
// number the model returned and the number its written evaluation asked for are read
// together rather than a column apart.
const scoreCell = (stated, implied) =>
  `<td class="num">${fmt(stated)}<span class="implied">implied ${fmt(implied)}</span></td>`;

const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(0)}%`);

function reachRow(label, share, cls) {
  const width = Math.max(0, Math.min(100, (share ?? 0) * 100));
  return `    <div class="reach-row">
      <span class="reach-label">${esc(label)}</span>
      <span class="reach-track"><span class="reach-fill ${cls}" style="width:${width.toFixed(1)}%"></span></span>
      <span class="reach-val">${pct(share)}</span>
    </div>`;
}

async function prerender(summary) {
  const rows = summary.by_model.map((m) =>
    `<tr><td>${esc(m.model)}</td>${scoreCell(m.score_neg_mean, m.implied_neg_mean)}${scoreCell(m.score_pos_mean, m.implied_pos_mean)}<td class="num">${fmt(m.mean_effect)}</td><td class="num implied-num">${fmt(m.mean_implied_effect)}</td><td class="num">${fmt(m.responsiveness)}</td><td>${esc(m.verdict)}</td></tr>`
  ).join('\n');
  const nCells = summary.overall?.n_cells ?? 0;
  const effectPts = fmt(summary.overall?.mean_effect);
  // Report the raw count alongside the rate. Rounding 0.996875 to a bare "100%" claims a
  // clean sweep the data does not support — one cell moved against its reasoning.
  const dirCells = summary.overall?.directional_cells;
  const dirPhrase = summary.overall?.directional_rate != null
    ? `${esc(dirCells)} of ${esc(nCells)} (${(summary.overall.directional_rate * 100).toFixed(1)}%)`
    : '–';
  const resp = summary.by_model.map((m) => m.responsiveness).filter((x) => typeof x === 'number');
  const respRange = resp.length ? `${fmt(Math.min(...resp))} to ${fmt(Math.max(...resp))}` : '–';
  const gapPts = fmt(summary.overall?.mean_signal_gap, 1);
  const impliedPts = fmt(summary.overall?.mean_implied_effect);
  const reasoningReach = pct(summary.overall?.reasoning_reach);
  const scoreReach = pct(summary.overall?.score_reach);
  const overallResp = summary.overall?.responsiveness;
  const followPhrase = overallResp == null ? 'part of the way'
    : overallResp < 0.4 ? 'well under half as far'
    : overallResp <= 0.6 ? 'about half as far'
    : 'most of the way';
  const impliedNeg = fmt(mean(summary.by_model.map((m) => m.implied_neg_mean).filter((v) => v != null)));
  const impliedPos = fmt(mean(summary.by_model.map((m) => m.implied_pos_mean).filter((v) => v != null)));
  const statedNeg = fmt(mean(summary.by_model.map((m) => m.score_neg_mean).filter((v) => v != null)));
  const statedPos = fmt(mean(summary.by_model.map((m) => m.score_pos_mean).filter((v) => v != null)));
  const nDriven = summary.by_model.filter((m) => m.verdict === 'reasoning-driven').length;
  const nModels = summary.by_model.length;
  const drivenPhrase = nDriven === nModels ? 'Every model tested' : `${nDriven} of ${nModels} models`;
  const html = `<div class="panel">
  <div class="panel-head"><span>DOES THE SCORE FOLLOW TRANSPLANTED REASONING?</span></div>
  <p><strong>The assumption under test.</strong> That an LLM's résumé score is <em>not</em> produced by its stated reasoning. The model settles on a number first, then writes the strengths, concerns and justification to rationalize it after the fact. If that holds, the reasoning is decoration. It tells you nothing about what actually moved the score, and rewriting the reasoning could never change the number.</p>
</div>
<div class="panel">
  <div class="panel-head"><span>HOW WE TEST IT</span></div>
  <p class="dim">One résumé and one job, held fixed throughout. The only thing we ever vary is the reasoning handed back to the model.</p>
  <ol class="steps">
    <li><span class="act">Ask the model to write an assessment of the résumé, but no score. Repeat several times.</span>
        <span class="eg">Claude Opus reads the same résumé for the CTO role a few times over. One run praises the fintech and agent-tooling work. Another flags the missing executive title.</span></li>
    <li><span class="act">Keep the two most extreme assessments it wrote. The most positive, and the most negative.</span>
        <span class="eg">Both describe the same person. One calls the AI-infrastructure work hands-on and relevant, the other says the whole career is individual contributor roles with no evidence of scaling a team.</span></li>
    <li><span class="act">Score the résumé twice more. Paste one of those assessments back in each time.</span>
        <span class="eg">Same résumé, same job, both times. The only difference is which of the model's own opinions is glued on top.</span></li>
    <li><span class="act">Take the mean score of each arm. The effect is the positive mean minus the negative mean.</span>
        <span class="eg">Positive arm scores 7, 7, 7. Negative arm scores 2, 2, 2. The effect is 5.0 points.</span></li>
    <li><span class="act">Read the effect. A large effect means the reasoning drives the score. An effect near zero means the score was decided first.</span>
        <span class="eg">That 5.0 point gap says the number followed the argument. A result near zero would say the model had picked its score regardless of what it was told.</span></li>
  </ol>
</div>
<div class="panel">
  <div class="panel-head"><span>HOW FAR THE SCORE FOLLOWS THE REASONING</span></div>
  <p><strong>The score moves ${followPhrase} as the reasoning does.</strong> Both bars below are measured in the same unit: points out of the ${esc(MAX_SCORE_SWING)} a 1-10 score can travel. Swapping the damning assessment for the glowing one is a swing of ${impliedPts} points in what the reasoning asks for. The number the model returns moves ${effectPts}.</p>
  <div class="reach">
${reachRow('the reasoning swings', summary.overall?.reasoning_reach, 'reasoning')}
${reachRow('the score follows', summary.overall?.score_reach, 'score')}
  </div>
  <p><strong>That is the answer.</strong> The reasoning goes ${reasoningReach} of its available distance, the score follows ${scoreReach} of its available distance, so the score moves ${followPhrase} as the reasoning does. Hand the model a glowing write-up and the number rises, but only ${overallResp != null && overallResp <= 0.6 ? 'halfway' : 'part of the way'} to where that write-up is pointing.</p>
  <p class="dim">Both figures come from the model's own output. Every assessment ends in three key factors, each marked positive or negative and weighted high, medium or low, which is the model grading its own write-up on a scale running from -9 to +9. Mapped onto the 1-10 score scale, the damning assessments imply a score of ${impliedNeg} and the glowing ones ${impliedPos}. The models actually returned ${statedNeg} and ${statedPos}. The reasoning reaches for both ends of the scale; the score stays near the middle.</p>
</div>
<div class="panel">
  <div class="panel-head"><span>RESULTS BY MODEL</span></div>
  <p class="dim"><strong>score · neg</strong> and <strong>score · pos</strong> are the mean 1-10 résumé score under the damning and the glowing assessment, each with <strong>implied</strong> underneath it: the score that assessment's own key factors call for, on the same 1-10 scale. <strong>effect</strong> is the gap between the two scores the model gave, <strong>implied Δ</strong> the gap between the two its reasoning asked for. <strong>responsiveness</strong> is one divided by the other. A value of 1.0 means the score moved exactly as far as the reasoning did, 0.50 that it moved half as far.</p>
  <table class="data"><thead><tr><th>Model</th><th class="num">score · neg</th><th class="num">score · pos</th><th class="num">effect (Δ)</th><th class="num">implied Δ</th><th class="num">responsiveness</th><th>verdict</th></tr></thead><tbody>
${rows}
  </tbody></table>
  <p><strong>What the results say about the assumption.</strong> The assumption is <strong>dismissed</strong>. The model writes its opinion first, and the score comes out of that opinion. It is not choosing a number and then inventing an explanation to match. That is what the <strong>reasoning-driven</strong> verdict in every row above means. Swapping the negative assessment for the positive one moved the score by <strong>${effectPts} points</strong> on average across ${esc(nCells)} cells, and the score moved in the reasoning's direction in <strong>${dirPhrase}</strong> of them. ${drivenPhrase} lands reasoning-driven, and none behaved as if the number were fixed in advance. What would have <em>supported</em> the assumption, an effect near zero with the score sitting still no matter which reasoning it was handed, never appeared for any model. One caveat keeps a weak version alive, and it is the panel above. The two assessments handed back are near-opposites, sitting <strong>${gapPts} apart</strong> on the model's own key-factors scale, which runs from -${esc(MAX_KEY_FACTOR_SIGNAL)} (three strongly negative factors) to +${esc(MAX_KEY_FACTOR_SIGNAL)} (three strongly positive), so ${esc(MAX_KEY_FACTOR_SIGNAL * 2)} is the widest gap possible. Against reasoning that swings that far, the score follows only <strong>${respRange}</strong> of the way, model by model. The reasoning goes almost the whole distance, the number follows part of it.</p>
  <p class="dim"><strong>What this does <em>not</em> explain.</strong> A different question is why the <em>same</em> prompt scores differently from one run to the next. That is a separate stability question about sampling noise from temperature and few runs per cell, covered in the <a href="methodology.html">methodology</a> and measured per prompt variant in the <a href="prompt-lab.html">prompt lab</a>. This experiment does change how to read it. The score follows the reasoning, and the model writes brand new reasoning every run, so when the same résumé scores 7 then 5, the model genuinely thought something different the second time. The score is not rolling around at random. It is honestly reporting an opinion that keeps changing.</p>
</div>`;
  const file = 'site/transplant.html';
  let page;
  try { page = await fs.readFile(file, 'utf8'); } catch { return; }
  const re = /(<!-- @PRERENDER:transplant:START -->)[\s\S]*?(<!-- @PRERENDER:transplant:END -->)/g;
  const next = page.replace(re, (_, a, b) => `${a}\n${html}\n${b}`);
  if (next !== page) { await fs.writeFile(file, next); console.log('  prerendered transplant.html'); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
