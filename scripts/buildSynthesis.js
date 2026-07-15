import fs from 'node:fs/promises';

// Joins the three experiments (counterfactual audit, reasoning transplant, prompt lab)
// on their shared unit — the model — into the homepage synthesis: one thesis, one
// per-model fingerprint table, three experiment cards, and one honest scatter. Reads the
// already-built site/data summaries, so it must run after build:site, build:transplant
// and build:prompt-lab.

const DATA = 'site/data';
const PAGE = 'site/index.html';

const MODEL_DISPLAY = {
  'claude-opus': 'Claude Opus', 'claude-sonnet': 'Claude Sonnet', 'claude-haiku': 'Claude Haiku',
  'claude-fable-5': 'Claude Fable 5', 'gemini-2.5-flash': 'Gemini 2.5 Flash', 'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro · Preview', 'llama-4-maverick': 'Llama 4 Maverick',
  'mistral-large': 'Mistral Large', 'mistral-small': 'Mistral Small', 'qwen-3-next-80b': 'Qwen 3 Next 80B'
};
const MODEL_SHORT = {
  'claude-opus': 'Opus', 'claude-sonnet': 'Sonnet', 'claude-haiku': 'Haiku', 'claude-fable-5': 'Fable 5',
  'gemini-2.5-flash': '2.5 Flash', 'gemini-2.5-pro': '2.5 Pro', 'gemini-3.1-pro-preview': '3.1 Pro',
  'llama-4-maverick': 'Llama 4', 'mistral-large': 'Mistral L', 'mistral-small': 'Mistral S', 'qwen-3-next-80b': 'Qwen 3'
};

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (x, d = 2) => (x == null ? '–' : Number(x).toFixed(d));
const pct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');

async function readJson(rel) {
  return JSON.parse(await fs.readFile(`${DATA}/${rel}`, 'utf8'));
}

function pearson(pairs) {
  const p = pairs.filter(([a, b]) => a != null && b != null);
  const n = p.length;
  if (n < 3) return null;
  const mx = p.reduce((s, [a]) => s + a, 0) / n;
  const my = p.reduce((s, [, b]) => s + b, 0) / n;
  let sx = 0, sy = 0, sxy = 0;
  for (const [a, b] of p) { sx += (a - mx) ** 2; sy += (b - my) ** 2; sxy += (a - mx) * (b - my); }
  return (sx && sy) ? { r: sxy / Math.sqrt(sx * sy), n } : null;
}

// Per-model bias index and significance rate straight from the matrix.
function biasByModel(matrix) {
  const out = {};
  for (const m of matrix.models) {
    let abs = 0, n = 0, sig = 0;
    for (const ax of matrix.axes) {
      for (const lv of matrix.levels_by_axis?.[ax] ?? []) {
        const c = matrix.matrix?.[ax]?.[lv]?.[m];
        if (!c || c.mean_delta == null) continue;
        abs += Math.abs(c.mean_delta); n++;
        if (c.sig_rate >= 0.5) sig++;
      }
    }
    out[m] = { bias: n ? abs / n : null, sig: n ? sig / n : null, n };
  }
  return out;
}

function buildRows(matrix, transplant, promptLab) {
  const bias = biasByModel(matrix);
  const tp = Object.fromEntries(transplant.by_model.map((m) => [m.model, m]));
  const baseline = promptLab.by_strategy.find((s) => s.strategy === 'baseline');
  const pl = baseline?.by_model ?? {};
  return matrix.models.map((m) => ({
    model: m,
    label: MODEL_DISPLAY[m] ?? m,
    short: MODEL_SHORT[m] ?? m,
    bias: bias[m]?.bias ?? null,
    sig: bias[m]?.sig ?? null,
    n: bias[m]?.n ?? 0,
    stability: pl[m]?.stability ?? null,
    coherence: pl[m]?.coherence ?? null,
    responsiveness: tp[m]?.responsiveness ?? null,
    tp_effect: tp[m]?.mean_effect ?? null
  })).sort((a, b) => (b.bias ?? -1) - (a.bias ?? -1));
}

function scatterSvg(rows) {
  const pts = rows.filter((r) => r.bias != null && r.responsiveness != null);
  const W = 680, H = 380, padL = 60, padR = 24, padT = 22, padB = 48;
  const xmin = 0, xmax = 0.45, ymin = 0.15, ymax = 0.37;
  const xpx = (v) => padL + (v - xmin) / (xmax - xmin) * (W - padL - padR);
  const ypx = (v) => (H - padB) - (v - ymin) / (ymax - ymin) * (H - padT - padB);
  const axis = 'var(--border)', dim = 'var(--dim)', accent = 'var(--accent)', text = 'var(--text)';

  const xticks = [0, 0.1, 0.2, 0.3, 0.4].map((t) =>
    `<line x1="${xpx(t).toFixed(1)}" y1="${H - padB}" x2="${xpx(t).toFixed(1)}" y2="${H - padB + 4}" stroke="${axis}"/>`
    + `<text x="${xpx(t).toFixed(1)}" y="${H - padB + 17}" fill="${dim}" font-size="11" text-anchor="middle">${t.toFixed(1)}</text>`).join('');
  const yticks = [0.15, 0.2, 0.25, 0.3, 0.35].map((t) =>
    `<line x1="${padL - 4}" y1="${ypx(t).toFixed(1)}" x2="${padL}" y2="${ypx(t).toFixed(1)}" stroke="${axis}"/>`
    + `<text x="${padL - 8}" y="${(ypx(t) + 4).toFixed(1)}" fill="${dim}" font-size="11" text-anchor="end">${t.toFixed(2)}</text>`).join('');

  const dots = pts.map((r) => {
    const x = xpx(r.bias), y = ypx(r.responsiveness);
    const left = r.bias > 0.30; // labels on the left for the far-right points to avoid clipping
    const lx = left ? x - 8 : x + 8;
    const anchor = left ? 'end' : 'start';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${accent}"><title>${esc(r.label)} · bias ${fmt(r.bias)} · responsiveness ${fmt(r.responsiveness)}</title></circle>`
      + `<text x="${lx.toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="${dim}" font-size="10" text-anchor="${anchor}">${esc(r.short)}</text>`;
  }).join('\n');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;font-family:var(--mono,monospace)" role="img" aria-label="Scatter of model bias versus reasoning responsiveness">
  <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="${axis}"/>
  <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="${axis}"/>
  ${xticks}${yticks}
  <text x="${(padL + (W - padR)) / 2}" y="${H - 8}" fill="${text}" font-size="12" text-anchor="middle">bias (mean |Δ| on a demographic swap)</text>
  <text x="16" y="${(padT + (H - padB)) / 2}" fill="${text}" font-size="12" text-anchor="middle" transform="rotate(-90 16 ${(padT + (H - padB)) / 2})">responsiveness (score follows reasoning)</text>
  ${dots}
</svg>`;
}

function render(rows, matrix, transplant, status, corr) {
  const models = matrix.models.length;
  const records = status?.n_records ?? null;
  const tpEffect = fmt(transplant.overall?.mean_effect);
  const tpDir = pct(transplant.overall?.directional_rate);
  // Overall share of demographic shifts that clear the noise floor (cell-weighted).
  let sigW = 0, nAll = 0;
  for (const r of rows) if (r.sig != null) { sigW += r.sig * (r.n ?? 0); nAll += (r.n ?? 0); }
  const sigPct = nAll ? Math.round(sigW / nAll * 100) : null;
  const qwen = rows.find((r) => r.model === 'qwen-3-next-80b');
  const rBiasResp = corr ? fmt(corr.r, 2) : '–';

  const tableRows = rows.map((r) => {
    const hi = r.model === 'qwen-3-next-80b' ? ' class="row-hi"' : '';
    return `<tr${hi}><td>${esc(r.label)}</td><td class="num">${fmt(r.bias)}</td><td class="num">${pct(r.sig)}</td><td class="num">${fmt(r.stability)}</td><td class="num">${fmt(r.coherence)}</td><td class="num">${fmt(r.responsiveness)}</td></tr>`;
  }).join('\n');

  return `<div class="panel">
    <div class="panel-head"><span>THE BOTTOM LINE</span></div>
    <p>Frontier LLMs are already being handed résumés to score. Across ${esc(models)} models${records ? `, ${records.toLocaleString()} screenings,` : ','} and three experiments, one picture holds up. LLM résumé bias is real and reasoned, but small, unstable, idiosyncratic, and not fixable by prompting. Changing a single demographic line does move scores, and the score follows the model's written reasoning instead of decorating a number picked in advance. Most of that movement stays inside run-to-run noise, the models rarely agree on whom to penalise, and the one model with a stable, statistically clear bias is Qwen. Reordering the prompt or adding worked examples barely moves the needle. The three experiments below each pin down one part of that.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>EVERY MODEL, THREE WAYS</span></div>
    <p class="dim">One row per model, joining all three experiments. <em>Bias</em> is how far the score moves on a demographic swap. <em>% sig</em> is how much of that clears run-to-run noise. <em>Instability</em> is the score's own wobble on identical inputs. <em>Coherence</em> is how tightly the score tracks the model's own stated key factors. <em>Responsiveness</em> is how far the score follows reasoning transplanted into it. Eleven models is a small sample, so read this as a fingerprint and not a law.</p>
    <table class="data"><thead><tr><th>Model</th><th class="num">bias</th><th class="num">% sig</th><th class="num">instability</th><th class="num">coherence</th><th class="num">responsiveness</th></tr></thead><tbody>
${tableRows}
    </tbody></table>
    <p class="dim">Claude Fable 5 appears in the audit only. It is excluded from the transplant and prompt-lab experiments, so its follow-up columns are blank.</p>
  </div>
  <div class="panel">
    <div class="panel-head"><span>THREE EXPERIMENTS, ONE STORY</span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px">
      <a class="card" href="#premise" style="text-align:left;text-decoration:none">
        <strong>1 · The counterfactual audit</strong><br>
        <span class="dim">Change one demographic line, hold the rest. Scores move, but only about ${sigPct != null ? sigPct + '%' : '–'} clear the noise floor and models barely agree. Read it below.</span>
      </a>
      <a class="card" href="transplant.html" style="text-align:left;text-decoration:none">
        <strong>2 · The reasoning transplant</strong><br>
        <span class="dim">Feed the model its own most-positive and most-negative assessment. The score follows the reasoning (+${tpEffect} pts, ${tpDir} directional), so the bias is reasoned rather than made up after the fact.</span>
      </a>
      <a class="card" href="prompt-lab.html" style="text-align:left;text-decoration:none">
        <strong>3 · The prompt lab</strong><br>
        <span class="dim">Six prompt strategies against the naive one. Score-last backfired and few-shot only nudged the numbers. The instability is intrinsic.</span>
      </a>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head"><span>DOES THE BIAS FOLLOW THE REASONING?</span></div>
    <p class="dim">Each dot is a model. Horizontal is how biased it is (from the audit), vertical is how far its score follows transplanted reasoning. The upward tilt is the throughline. The models that let reasoning drive the score most are also the most biased${qwen ? `, with Qwen furthest out on both` : ''}.</p>
    ${scatterSvg(rows)}
    <p class="dim">Pearson r is about ${rBiasResp} across ${corr?.n ?? '–'} models. That fits the chain from identity to reasoning to score, though it is not statistically significant at this sample size.</p>
  </div>`;
}

async function main() {
  const [matrix, transplant, promptLab] = await Promise.all([
    readJson('matrix.json'), readJson('transplant/summary.json'), readJson('prompt-lab/summary.json')
  ]);
  let status = null;
  try { status = await readJson('status.json'); } catch { /* optional */ }

  const rows = buildRows(matrix, transplant, promptLab);
  const corr = pearson(rows.map((r) => [r.bias, r.responsiveness]));
  const html = render(rows, matrix, transplant, status, corr);

  await fs.writeFile(`${DATA}/synthesis.json`, JSON.stringify({ generated_from: 'matrix + transplant + prompt-lab summaries', rows, corr_bias_responsiveness: corr }, null, 2));

  const page = await fs.readFile(PAGE, 'utf8');
  const re = /(<!-- @PRERENDER:synthesis:START -->)[\s\S]*?(<!-- @PRERENDER:synthesis:END -->)/g;
  if (!re.test(page)) { console.error('No synthesis marker found in index.html — add <!-- @PRERENDER:synthesis:START/END --> first.'); process.exit(1); }
  re.lastIndex = 0;
  const next = page.replace(re, (_, a, b) => `${a}\n${html}\n${b}`);
  await fs.writeFile(PAGE, next);
  console.log(`Synthesis built: ${rows.length} models, bias↔responsiveness r=${corr ? corr.r.toFixed(2) : 'n/a'}. Prerendered index.html.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
