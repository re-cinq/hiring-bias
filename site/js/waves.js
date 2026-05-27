import { loadJson, el, fmtSignedDelta, deltaClass } from './lib.js';

// Per-role "bias fingerprint": one polyline per model over the résumé variants
// (x, grouped by dimension), score Δ on y. Lines are blended additively so where
// the models agree their colours sum toward white, a shared bias.
const HEIGHT = 40;
const PAD = 4;

// Pure spectrum hues; their additive sum is white, so full model agreement → white.
const modelColor = (i, n) => `hsl(${Math.round((i * 360) / n)} 100% 50%)`;

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let tooltip;
function ensureTooltip() {
  if (!tooltip) {
    tooltip = el('div', { class: 'tooltip' });
    tooltip.style.display = 'none';
    document.body.append(tooltip);
  }
  return tooltip;
}

export async function drawWaves() {
  const data = await loadJson('data/waves.json');
  const colors = data.models.map((_, i) => modelColor(i, data.models.length));
  renderLegend(data, colors);

  const canvases = [...document.querySelectorAll('canvas.jd-wave')];
  const layouts = new Map();
  const drawAll = () => {
    const dark = (document.documentElement.dataset.theme || 'dark') !== 'light';
    for (const canvas of canvases) layouts.set(canvas, drawOne(canvas, data, colors, dark));
  };
  drawAll();

  for (const canvas of canvases) {
    canvas.addEventListener('mousemove', (ev) => showTip(ev, canvas, data, colors, layouts.get(canvas)));
    canvas.addEventListener('mouseleave', () => { ensureTooltip().style.display = 'none'; });
  }

  let raf;
  const redraw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(drawAll); };
  window.addEventListener('resize', redraw);
  document.addEventListener('themechange', redraw);
}

function renderLegend(data, colors) {
  const host = document.getElementById('wave-legend');
  if (!host) return;
  host.innerHTML = '';
  data.models.forEach((m, i) => host.append(el('div', { class: 'legend-item' }, [
    el('span', { class: 'swatch', style: { background: colors[i] } }),
    el('span', {}, data.modelLabels[m])
  ])));
}

function drawOne(canvas, data, colors, dark) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 240;
  const h = HEIGHT;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = dark ? (cssVar('--panel') || '#13171c') : '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const N = data.variants.length;
  const innerW = w - 2 * PAD;
  const midY = h / 2;
  const ampY = h / 2 - PAD;
  const xAt = (i) => PAD + (N <= 1 ? 0 : (i * innerW) / (N - 1));
  const yAt = (d) => midY - (d / data.maxAbsDelta) * ampY;

  ctx.lineWidth = 1;
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  for (const b of data.axisBounds) {
    if (b.start === 0) continue;
    const x = (xAt(b.start) + xAt(b.start - 1)) / 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
  ctx.beginPath(); ctx.moveTo(PAD, midY); ctx.lineTo(w - PAD, midY); ctx.stroke();

  // Dark: additive → overlaps brighten to white. Light: multiply → overlaps darken
  // to black. Either way, convergence reads as "the models share this bias".
  ctx.globalCompositeOperation = dark ? 'lighter' : 'multiply';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  const series = data.series[canvas.dataset.jd];
  data.models.forEach((model, mi) => {
    const arr = series?.[model] ?? [];
    ctx.strokeStyle = colors[mi];
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < N; i++) {
      const d = arr[i];
      if (d == null) { pen = false; continue; }
      const x = xAt(i), y = yAt(d);
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
  });
  ctx.globalCompositeOperation = 'source-over';

  return { N, innerW };
}

function showTip(ev, canvas, data, colors, layout) {
  if (!layout) return;
  const { N, innerW } = layout;
  const x = ev.clientX - canvas.getBoundingClientRect().left;
  const i = Math.max(0, Math.min(N - 1, Math.round(((x - PAD) / innerW) * (N - 1))));
  const series = data.series[canvas.dataset.jd] ?? {};
  const rows = data.models
    .map((m, mi) => ({ mi, label: data.modelLabels[m], d: series[m]?.[i] ?? null }))
    .sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity));

  const tip = ensureTooltip();
  tip.innerHTML = '';
  tip.append(el('div', { style: { marginBottom: '4px' } }, data.variants[i].label));
  for (const r of rows) tip.append(el('div', { class: 'wave-tip-row' }, [
    el('span', { class: 'swatch', style: { background: colors[r.mi] } }),
    el('span', { class: 'key' }, r.label),
    el('span', { class: r.d == null ? 'dim' : deltaClass(r.d) }, fmtSignedDelta(r.d))
  ]));

  tip.style.display = 'block';
  let left = ev.clientX + 14;
  if (left + tip.offsetWidth > window.innerWidth - 8) left = ev.clientX - 14 - tip.offsetWidth;
  tip.style.left = `${left}px`;
  tip.style.top = `${ev.clientY + 12}px`;
}
