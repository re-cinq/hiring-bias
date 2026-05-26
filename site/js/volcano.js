import { el, fmtSignedDelta } from './lib.js';

// Volcano plot: every (variant × model × job) cell as a point — x = score Δ vs baseline,
// y = significance (−log10 p). Real effects rise to the top corners; run-to-run noise
// sinks to the bottom middle. Points are coloured by model with the same spectrum as the
// jobs-page waves, blended additively: where many models pile on the same spot the colours
// sum toward white. Click a model in the legend to isolate it.
const SVGNS = 'http://www.w3.org/2000/svg';
const H = 380, PADL = 52, PADR = 16, PADT = 16, PADB = 38;

// Same pure-spectrum hues as waves.js — additive sum is white, so dense overlap → white.
const modelColor = (i, n) => `hsl(${Math.round((i * 360) / n)} 100% 50%)`;

let tip;
const tooltip = () => (tip ??= document.body.appendChild(Object.assign(el('div', { class: 'tooltip' }), { style: 'display:none' })));

const svg = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  for (const c of kids) n.append(c);
  return n;
};

export function renderVolcano(host, data, matrix, modelLabel) {
  if (!host || !data?.points?.length) return;
  const axisLabel = (a) => matrix.axis_labels?.[a] ?? a;
  const levelLabel = (a, l) => matrix.level_labels?.[a]?.[l] ?? l;
  const jdLabel = (j) => matrix.jd_labels?.[j] ?? j;

  const pts = data.points;
  const models = matrix.models ?? [...new Set(pts.map((p) => p.model))];
  const colorOf = Object.fromEntries(models.map((m, i) => [m, modelColor(i, models.length)]));
  const maxAbsX = Math.max(0.5, ...pts.map((p) => Math.abs(p.delta)));
  const maxY = Math.max(data.threshold * 1.2, ...pts.map((p) => p.sig));

  const active = new Set(); // empty = show every model

  const panel = el('div', { class: 'panel' });
  panel.append(el('div', { class: 'panel-head' }, el('span', {}, 'WHICH SHIFTS ARE REAL, NOT NOISE?')));
  panel.append(el('p', { class: 'dim' }, 'Every dot is one experiment. We drop a demographic signal into the résumé, run the same prompt five times, and compare the average score against the unmodified version. Left means the candidate was penalised, right means boosted. The higher a dot sits, the more reliably that shift showed up across all five reruns. The dashed line is the conventional p < 0.05 threshold for "not random." Dots are coloured by model (same palette as the waves); where many models pile on the same spot, the colours blend toward white. Click a model in the legend to isolate it. Hover any dot for the case, click to open the diff.'));

  const howto = el('details', { class: 'vol-howto' }, [
    el('summary', {}, 'How to spot bias on this chart'),
    el('ul', {}, [
      el('li', {}, [el('strong', {}, 'Isolate one model and look for a tilt.'), ' Click a colour in the legend to hide the others. If that model\'s dots cluster on one side of zero (especially above the dashed line), it is rewarding or penalising the signal in those experiments. Hover a dot to see which demographic.']),
      el('li', {}, [el('strong', {}, 'Many colours stacking on the same spot.'), ' Blending toward white is broad agreement across models. That is the strongest sign the effect is a real-world bias, not one model\'s quirk.']),
      el('li', {}, [el('strong', {}, 'A single dot, high up and far from zero.'), ' Large effect, repeatable across reruns. Click it to open the side by side and read the model\'s own rationale for the gap.']),
      el('li', {}, [el('strong', {}, 'Dots spread evenly around zero.'), ' The model is not favouring either side on average, it is just being inconsistent. Noise, not bias.']),
      el('li', {}, [el('strong', {}, 'Cross-check elsewhere.'), ' This view mixes all eight demographic axes together. The heatmap shows which axis × model cells are off; the waves on the jobs page show the direction and shape per axis.'])
    ])
  ]);
  panel.append(howto);

  const legend = el('div', { class: 'vol-legend' });
  panel.append(legend);
  const node = svg('svg', { class: 'volcano', height: H });
  panel.append(node);
  host.innerHTML = '';
  host.append(panel);

  const renderLegend = () => {
    legend.innerHTML = '';
    for (const m of models) {
      const on = active.size === 0 || active.has(m);
      const item = el('button', { class: `vol-legend-item${on ? '' : ' off'}` }, [
        el('span', { class: 'swatch', style: { background: colorOf[m] } }),
        el('span', {}, modelLabel(m))
      ]);
      item.addEventListener('click', () => {
        if (active.has(m)) active.delete(m); else active.add(m);
        if (active.size === models.length) active.clear();
        renderLegend();
        draw();
      });
      legend.append(item);
    }
  };

  const draw = () => {
    const w = host.clientWidth || 720;
    node.setAttribute('width', w);
    node.setAttribute('viewBox', `0 0 ${w} ${H}`);
    while (node.firstChild) node.removeChild(node.firstChild);
    const plotW = w - PADL - PADR, plotH = H - PADT - PADB;
    const xAt = (d) => PADL + ((d + maxAbsX) / (2 * maxAbsX)) * plotW;
    const yAt = (s) => PADT + (1 - s / maxY) * plotH;

    const yStep = maxY <= 4 ? 1 : 2;
    for (let s = 0; s <= maxY + 1e-9; s += yStep) {
      const y = yAt(s);
      node.append(svg('line', { x1: PADL, y1: y, x2: PADL + plotW, y2: y, class: 'vol-grid' }));
      node.append(svg('text', { x: PADL - 7, y: y + 3, class: 'vol-label', 'text-anchor': 'end' }, document.createTextNode(String(s))));
    }
    node.append(svg('text', { x: 14, y: PADT + plotH / 2, class: 'vol-label', 'text-anchor': 'middle', transform: `rotate(-90 14 ${PADT + plotH / 2})` }, document.createTextNode('Consistency across reruns →')));

    node.append(svg('line', { x1: PADL, y1: PADT, x2: PADL, y2: PADT + plotH, class: 'vol-axis' }));
    node.append(svg('line', { x1: PADL, y1: PADT + plotH, x2: PADL + plotW, y2: PADT + plotH, class: 'vol-axis' }));
    node.append(svg('line', { x1: xAt(0), y1: PADT, x2: xAt(0), y2: PADT + plotH, class: 'vol-zero' }));

    const ty = yAt(data.threshold);
    node.append(svg('line', { x1: PADL, y1: ty, x2: PADL + plotW, y2: ty, class: 'vol-threshold' }));
    node.append(svg('text', { x: PADL + plotW, y: ty - 4, class: 'vol-label', 'text-anchor': 'end' }, document.createTextNode('noise floor (p = 0.05). Dots above are real effects.')));

    // Quadrant hints, behind the points so data sits on top.
    node.append(svg('text', { x: xAt(-maxAbsX * 0.55), y: PADT + 14, class: 'vol-hint', 'text-anchor': 'middle' }, document.createTextNode('REAL PENALTIES')));
    node.append(svg('text', { x: xAt(maxAbsX * 0.55), y: PADT + 14, class: 'vol-hint', 'text-anchor': 'middle' }, document.createTextNode('REAL BOOSTS')));
    node.append(svg('text', { x: PADL + plotW / 2, y: PADT + plotH - 8, class: 'vol-hint', 'text-anchor': 'middle' }, document.createTextNode('looks like noise')));

    for (const d of [-maxAbsX, -maxAbsX / 2, 0, maxAbsX / 2, maxAbsX]) {
      node.append(svg('text', { x: xAt(d), y: PADT + plotH + 16, class: 'vol-label', 'text-anchor': 'middle' }, document.createTextNode(fmtSignedDelta(d, 1))));
    }
    node.append(svg('text', { x: PADL + plotW / 2, y: H - 4, class: 'vol-label', 'text-anchor': 'middle' }, document.createTextNode('← penalty   ·   score change vs neutral résumé   ·   boost →')));

    // Additive layer (mix-blend-mode in CSS) holds only the visible points so isolated
    // models don't blend against faded ones.
    const layer = svg('g', { class: 'vol-points' });
    const faded = svg('g', {});
    for (const p of pts) {
      const on = active.size === 0 || active.has(p.model);
      const dot = svg('circle', {
        cx: xAt(p.delta), cy: yAt(p.sig), r: p.significant ? 3.6 : 2.6, class: 'vol-pt',
        fill: colorOf[p.model] ?? 'var(--dim)',
        'fill-opacity': on ? (p.significant ? 0.85 : 0.5) : 0.05
      });
      if (on) {
        dot.addEventListener('mousemove', (ev) => showTip(ev, p));
        dot.addEventListener('mouseleave', () => { tooltip().style.display = 'none'; });
        dot.addEventListener('click', () => { window.location.href = `diff.html?variant=${p.axis}_${p.level}&model=${p.model}&jd=${p.jd}`; });
        layer.append(dot);
      } else {
        faded.append(dot);
      }
    }
    node.append(faded, layer);
  };

  function showTip(ev, p) {
    const t = tooltip();
    t.innerHTML = '';
    t.append(el('div', { style: { marginBottom: '3px' } }, `${axisLabel(p.axis)} · ${levelLabel(p.axis, p.level)}`));
    t.append(el('div', { class: 'dim' }, [
      el('span', { class: 'swatch', style: { background: colorOf[p.model], marginRight: '6px' } }),
      `${modelLabel(p.model)} · ${jdLabel(p.jd)}`
    ]));
    t.append(el('div', {}, ['Δ ', el('span', { class: p.delta < 0 ? 'alert' : 'accent' }, fmtSignedDelta(p.delta, 2)), ` · ${p.significant ? 'significant' : 'not significant'}`]));
    t.style.display = 'block';
    let left = ev.clientX + 14;
    if (left + t.offsetWidth > window.innerWidth - 8) left = ev.clientX - 14 - t.offsetWidth;
    t.style.left = `${left}px`;
    t.style.top = `${ev.clientY + 12}px`;
  }

  renderLegend();
  draw();
  let raf;
  const redraw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
  window.addEventListener('resize', redraw);
  document.addEventListener('themechange', redraw);
}
