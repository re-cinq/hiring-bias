import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const VOXEL = 6;
const GAP = 2;
const STRIDE = VOXEL + GAP;
const PIXEL_SCALE = 1.0;

function cssColor(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return new THREE.Color(v);
}

function paletteRamp() {
  const accent = cssColor('--accent');
  const dim = cssColor('--dim');
  const alert = cssColor('--alert');
  const ramp = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    let c;
    if (t < 0.5) { c = alert.clone().lerp(dim, t * 2); }
    else { c = dim.clone().lerp(accent, (t - 0.5) * 2); }
    ramp.push(c);
  }
  return ramp;
}

function rampLookup(ramp, t) {
  const clamped = Math.max(-1, Math.min(1, t));
  const idx = Math.round((clamped + 1) * (ramp.length - 1) / 2);
  return ramp[idx];
}

function intensity(ramp, value, max) {
  if (max === 0) return ramp[4];
  return rampLookup(ramp, value / max);
}

function makeTooltip() {
  const t = document.createElement('div');
  t.className = 'tooltip';
  t.style.display = 'none';
  document.body.append(t);
  return t;
}

function fmtTooltipRow(label, value) {
  return `<span class="key">${label}</span> ${value}`;
}

function colorToCss(c) {
  return `#${c.getHexString()}`;
}

const LABEL_FONT_PX = 96;

function floorLabelMesh({ text, width = 8, height = 1.5, rotateText = 0, color = '--text', bg = '--panel', border = '--border', font = null, align = 'center' }) {
  const dpi = 32;
  const c = document.createElement('canvas');
  c.width = Math.max(8, Math.round(width * dpi));
  c.height = Math.max(8, Math.round(height * dpi));
  const ctx = c.getContext('2d');

  const transparent = !bg;
  if (!transparent) {
    ctx.fillStyle = colorToCss(cssColor(bg));
    ctx.fillRect(0, 0, c.width, c.height);
  }
  if (border) {
    ctx.strokeStyle = colorToCss(cssColor(border));
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, c.width - 2, c.height - 2);
  }

  ctx.save();
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rotateText);
  ctx.fillStyle = colorToCss(cssColor(color));
  const fontSize = font ?? LABEL_FONT_PX;
  ctx.font = `bold ${fontSize}px ui-monospace, "JetBrains Mono", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const isRotated = Math.abs(rotateText) > 0.1;
  const longSide = isRotated ? c.height : c.width;
  const x = align === 'left' ? -longSide / 2 + 12 : align === 'right' ? longSide / 2 - 12 : 0;
  ctx.fillText(text, x, 0);
  ctx.restore();

  applyEdgeFade(ctx, c);

  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 16;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const geom = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 10;
  return mesh;
}

function applyEdgeFade(ctx, c) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const fadePx = Math.min(c.width, c.height) * 0.08;
  const sides = [
    ctx.createLinearGradient(0, 0, fadePx, 0),
    ctx.createLinearGradient(c.width, 0, c.width - fadePx, 0),
    ctx.createLinearGradient(0, 0, 0, fadePx),
    ctx.createLinearGradient(0, c.height, 0, c.height - fadePx)
  ];
  for (const g of sides) {
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
  }
  ctx.fillStyle = sides[0]; ctx.fillRect(0, 0, fadePx, c.height);
  ctx.fillStyle = sides[1]; ctx.fillRect(c.width - fadePx, 0, fadePx, c.height);
  ctx.fillStyle = sides[2]; ctx.fillRect(0, 0, c.width, fadePx);
  ctx.fillStyle = sides[3]; ctx.fillRect(0, c.height - fadePx, c.width, fadePx);
  ctx.restore();
}

// Tiny 5x7 bitmap font, just the glyphs we need for model initials.
const BITMAP_FONT = {
  'C': ['01110','10001','10000','10000','10000','10001','01110'],
  'G': ['01110','10001','10000','10111','10001','10001','01110'],
  'L': ['10000','10000','10000','10000','10000','10000','11111'],
  'Q': ['01110','10001','10001','10001','10101','10010','01101']
};

const MODEL_BRANDS = {
  'claude-opus':            { initial: 'C', brand: 'CLAUDE', version: 'opus',           color: '--warn' },
  'gemini-2.5-flash':       { initial: 'G', brand: 'GEMINI', version: '2.5 flash',      color: '--accent' },
  'gemini-2.5-pro':         { initial: 'G', brand: 'GEMINI', version: '2.5 pro',        color: '--accent' },
  'gemini-3.1-pro-preview': { initial: 'G', brand: 'GEMINI', version: '3.1 pro · prev', color: '--accent' },
  'llama-4-maverick':       { initial: 'L', brand: 'LLAMA',  version: '4 maverick',     color: '--alert' },
  'qwen-3-next-80b':        { initial: 'Q', brand: 'QWEN',   version: '3 next 80b',     color: '--warn' }
};

function drawBitmapGlyph(ctx, glyph, x, y, blockSize, color) {
  ctx.fillStyle = color;
  for (let row = 0; row < glyph.length; row++) {
    for (let col = 0; col < glyph[row].length; col++) {
      if (glyph[row][col] === '1') {
        ctx.fillRect(x + col * blockSize, y + row * blockSize, blockSize, blockSize);
      }
    }
  }
}

function modelLogoMesh({ model, width = 8, height = 6 }) {
  const brand = MODEL_BRANDS[model] ?? { initial: model[0].toUpperCase(), brand: model.toUpperCase(), version: '', color: '--text' };
  const dpi = 32;
  const c = document.createElement('canvas');
  c.width = Math.round(width * dpi);
  c.height = Math.round(height * dpi);
  const ctx = c.getContext('2d');

  ctx.fillStyle = colorToCss(cssColor('--panel'));
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = colorToCss(cssColor('--border'));
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);

  const glyph = BITMAP_FONT[brand.initial];
  if (glyph) {
    const block = Math.floor((c.height * 0.55) / glyph.length);
    const glyphW = block * glyph[0].length;
    const glyphH = block * glyph.length;
    const gx = (c.width - glyphW) / 2;
    const gy = (c.height * 0.45 - glyphH) / 2 + c.height * 0.05;
    drawBitmapGlyph(ctx, glyph, gx, gy, block, colorToCss(cssColor(brand.color)));
  } else {
    ctx.fillStyle = colorToCss(cssColor(brand.color));
    ctx.font = `bold ${Math.round(c.height * 0.4)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(brand.initial, c.width / 2, c.height * 0.3);
  }

  ctx.fillStyle = colorToCss(cssColor('--dim'));
  ctx.font = `bold ${Math.round(c.height * 0.16)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(brand.brand, c.width / 2, c.height * 0.72);

  ctx.fillStyle = colorToCss(cssColor('--text'));
  ctx.font = `bold ${Math.round(c.height * 0.18)}px ui-monospace, monospace`;
  ctx.fillText(brand.version, c.width / 2, c.height * 0.9);

  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const geom = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function floorGridMesh({ cols, rows, spacing = 8, color = '--border' }) {
  const dpi = 16;
  const c = document.createElement('canvas');
  c.width = cols * spacing * dpi;
  c.height = rows * spacing * dpi;
  const ctx = c.getContext('2d');

  ctx.fillStyle = colorToCss(cssColor('--bg'));
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.strokeStyle = colorToCss(cssColor(color));
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  for (let i = 0; i <= cols; i++) {
    const x = Math.round(i * spacing * dpi) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, c.height);
    ctx.stroke();
  }
  for (let i = 0; i <= rows; i++) {
    const y = Math.round(i * spacing * dpi) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(c.width, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const geom = new THREE.PlaneGeometry(cols * spacing, rows * spacing);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function floorRampMesh({ ramp, width = 20, height = 1.5, loText = '', hiText = '' }) {
  const dpi = 32;
  const c = document.createElement('canvas');
  c.width = Math.round(width * dpi);
  c.height = Math.round(height * dpi);
  const ctx = c.getContext('2d');

  ctx.fillStyle = colorToCss(cssColor('--panel'));
  ctx.fillRect(0, 0, c.width, c.height);

  const padX = Math.max(loText.length, hiText.length) * LABEL_FONT_PX * 0.65 + 24;
  const swatchW = (c.width - padX * 2) / ramp.length;
  const swatchY = 6, swatchH = c.height - 12;
  for (let i = 0; i < ramp.length; i++) {
    ctx.fillStyle = colorToCss(ramp[i]);
    ctx.fillRect(Math.round(padX + i * swatchW), swatchY, Math.ceil(swatchW), swatchH);
  }

  ctx.fillStyle = colorToCss(cssColor('--text'));
  ctx.font = `bold ${LABEL_FONT_PX}px ui-monospace, monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText(loText, padX - 12, c.height / 2);
  ctx.textAlign = 'left';
  ctx.fillText(hiText, c.width - padX + 12, c.height / 2);

  ctx.strokeStyle = colorToCss(cssColor('--border'));
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);

  applyEdgeFade(ctx, c);

  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 16;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const geom = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 10;
  return mesh;
}

function disposeScene(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m.dispose();
    }
  });
}

function buttonRow(controls) {
  const row = document.createElement('div');
  row.className = 'controls';
  for (const [label, fn] of controls) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    row.append(b);
  }
  return row;
}

function panel(container, title, controlsRow) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'panel';
  const head = document.createElement('div');
  head.className = 'panel-head';
  const t = document.createElement('span');
  t.textContent = title;
  head.append(t);
  if (controlsRow) head.append(controlsRow);
  wrap.append(head);
  const chart = document.createElement('div');
  chart.className = 'chart';
  chart.tabIndex = 0;
  wrap.append(chart);
  container.append(wrap);
  return { chart, wrap };
}

function makeLegend({ ramp, signedDomain, magnitudeDomain, magnitudeLabel = 'mean |Δ|', signedLabel = 'signed Δ', hasSignificantCap = false }) {
  const legend = document.createElement('div');
  legend.className = 'legend';

  if (signedDomain) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const lo = document.createElement('span');
    lo.className = 'alert label';
    lo.textContent = signedDomain.loLabel || `${signedDomain.lo.toFixed(1)}`;
    item.append(lo);
    const r = document.createElement('span');
    r.className = 'legend-ramp';
    for (let i = 0; i < ramp.length; i++) {
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = `#${ramp[i].getHexString()}`;
      r.append(sw);
    }
    item.append(r);
    const hi = document.createElement('span');
    hi.className = 'accent label';
    hi.textContent = signedDomain.hiLabel || `+${signedDomain.hi.toFixed(1)}`;
    item.append(hi);
    const cap = document.createElement('span');
    cap.className = 'dim';
    cap.textContent = signedLabel;
    item.append(cap);
    legend.append(item);
  }

  if (magnitudeDomain) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const cap = document.createElement('span');
    cap.className = 'dim';
    cap.textContent = `${magnitudeLabel}: 0 → `;
    item.append(cap);
    const val = document.createElement('span');
    val.className = 'label';
    val.textContent = magnitudeDomain.max.toFixed(2);
    item.append(val);
    const sub = document.createElement('span');
    sub.className = 'dim';
    sub.textContent = '(stack height)';
    item.append(sub);
    legend.append(item);
  }

  if (hasSignificantCap) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const cap = document.createElement('span');
    cap.className = 'endcap';
    item.append(cap);
    const lbl = document.createElement('span');
    lbl.className = 'dim';
    lbl.textContent = '≥50% significant (CI excludes baseline)';
    item.append(lbl);
    legend.append(item);
  }

  return legend;
}

function createVoxelScene({
  container,
  title,
  voxels,
  metadata,
  formatTooltip,
  onClick,
  onHover,
  defaultOrtho = false,
  cameraOffset = [1.2, 1.2, 1.6],
  labels = [],
  legend = null,
  floorMeshes = []
}) {
  let useOrtho = defaultOrtho;
  let scene, camera, renderer, controls, instanced, raycaster, pointer, tooltip, hovered;
  let needsRender = true;

  const reset = () => { fitCamera(); needsRender = true; };
  const toggle = () => {
    useOrtho = !useOrtho;
    rebuildCamera();
    needsRender = true;
  };
  const controlsRow = buttonRow([
    ['[2D]', toggle],
    ['[reset]', reset]
  ]);
  const { chart: chartEl, wrap: panelEl } = panel(container, title, controlsRow);

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  tooltip = makeTooltip();

  scene = new THREE.Scene();
  scene.background = cssColor('--panel');
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const directional = new THREE.DirectionalLight(0xffffff, 0.75);
  directional.position.set(40, 80, 60);
  scene.add(ambient, directional);

  const geom = new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL);
  const material = new THREE.MeshLambertMaterial({ vertexColors: false, flatShading: true });

  instanced = new THREE.InstancedMesh(geom, material, voxels.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < voxels.length; i++) {
    const v = voxels[i];
    dummy.position.set(v.x * STRIDE, v.y * STRIDE, v.z * STRIDE);
    dummy.updateMatrix();
    instanced.setMatrixAt(i, dummy.matrix);
    instanced.setColorAt(i, v.color);
  }
  instanced.instanceMatrix.needsUpdate = true;
  if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  scene.add(instanced);

  for (const mesh of floorMeshes) scene.add(mesh);

  const voxelBox = new THREE.Box3();
  for (const v of voxels) {
    voxelBox.expandByPoint(new THREE.Vector3(v.x * STRIDE, v.y * STRIDE, v.z * STRIDE));
    voxelBox.expandByPoint(new THREE.Vector3(v.x * STRIDE + VOXEL, v.y * STRIDE + VOXEL, v.z * STRIDE + VOXEL));
  }
  const center = new THREE.Vector3();
  voxelBox.getCenter(center);
  const voxelSize = new THREE.Vector3();
  voxelBox.getSize(voxelSize);
  const maxDim = Math.max(voxelSize.x, voxelSize.z) || 1;

  renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(1);
  chartEl.append(renderer.domElement);

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  chartEl.append(overlay);
  const labelNodes = [];
  for (const l of labels) {
    const node = document.createElement('span');
    node.className = `lbl ${l.kind || ''}`;
    node.textContent = l.text;
    overlay.append(node);
    labelNodes.push({ node, worldPos: new THREE.Vector3(l.worldPos[0] * STRIDE, l.worldPos[1] * STRIDE, l.worldPos[2] * STRIDE) });
  }

  if (legend) {
    panelEl.append(makeLegend(legend));
  }

  function rebuildCamera() {
    if (useOrtho) {
      const aspect = chartEl.clientWidth / chartEl.clientHeight;
      const half = maxDim * 0.7;
      camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, 4000);
      camera.position.set(center.x, center.y + maxDim * 3, center.z + 0.001);
      camera.up.set(0, 0, -1);
    } else {
      camera = new THREE.PerspectiveCamera(50, chartEl.clientWidth / chartEl.clientHeight, 0.1, 4000);
      const d = maxDim * 1.0;
      camera.position.set(center.x + d * cameraOffset[0], center.y + d * cameraOffset[1], center.z + d * cameraOffset[2]);
      camera.up.set(0, 1, 0);
    }
    if (controls) controls.dispose();
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = maxDim * 0.3;
    controls.maxDistance = maxDim * 6;
    controls.addEventListener('change', () => { needsRender = true; });
    camera.lookAt(center);
  }

  function fitCamera() { rebuildCamera(); }

  function resize() {
    const w = chartEl.clientWidth;
    const h = chartEl.clientHeight;
    renderer.setSize(Math.max(1, Math.floor(w * PIXEL_SCALE)), Math.max(1, Math.floor(h * PIXEL_SCALE)), false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    if (camera) {
      if (camera.isPerspectiveCamera) {
        camera.aspect = w / h;
      } else {
        const aspect = w / h;
        const half = maxDim * 0.9;
        camera.left = -half * aspect;
        camera.right = half * aspect;
        camera.top = half;
        camera.bottom = -half;
      }
      camera.updateProjectionMatrix();
    }
    needsRender = true;
  }

  rebuildCamera();
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(chartEl);

  function setHovered(idx) {
    if (hovered === idx) return;
    if (hovered != null) {
      instanced.setColorAt(hovered, voxels[hovered].color);
    }
    hovered = idx;
    if (idx != null) {
      const c = cssColor('--accent');
      instanced.setColorAt(idx, c);
    }
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    needsRender = true;
  }

  function onMove(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(instanced);
    if (hits.length > 0) {
      const idx = hits[0].instanceId;
      const v = voxels[idx];
      const meta = metadata?.[v.cellId] ?? null;
      setHovered(idx);
      if (formatTooltip && meta) {
        tooltip.innerHTML = formatTooltip(meta);
        tooltip.style.display = 'block';
        tooltip.style.left = `${ev.clientX + 14}px`;
        tooltip.style.top = `${ev.clientY + 12}px`;
      } else {
        tooltip.style.display = 'none';
      }
      chartEl.style.cursor = 'pointer';
      if (onHover) onHover(meta, v.cellId);
    } else {
      setHovered(null);
      tooltip.style.display = 'none';
      chartEl.style.cursor = 'default';
      if (onHover) onHover(null, null);
    }
  }
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerleave', () => {
    setHovered(null);
    tooltip.style.display = 'none';
    if (onHover) onHover(null, null);
  });

  function onClickHandler(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(instanced);
    if (hits.length > 0 && onClick) {
      const v = voxels[hits[0].instanceId];
      onClick(metadata?.[v.cellId], v);
    }
  }
  renderer.domElement.addEventListener('click', onClickHandler);

  chartEl.addEventListener('keydown', (ev) => {
    const step = Math.PI / 12;
    if (ev.key === 'ArrowLeft') controls.azimuthAngle = (controls.getAzimuthalAngle?.() ?? 0) - step;
    else if (ev.key === 'ArrowRight') controls.azimuthAngle = (controls.getAzimuthalAngle?.() ?? 0) + step;
    else if (ev.key === '0') reset();
    else if (ev.key === '2') toggle();
    else return;
    needsRender = true;
  });

  document.addEventListener('themechange', () => {
    scene.background = cssColor('--panel');
    needsRender = true;
  });

  function updateLabels() {
    const rect = chartEl.getBoundingClientRect();
    const tmp = new THREE.Vector3();
    for (const { node, worldPos } of labelNodes) {
      tmp.copy(worldPos).project(camera);
      const x = (tmp.x * 0.5 + 0.5) * rect.width;
      const y = (-tmp.y * 0.5 + 0.5) * rect.height;
      const visible = tmp.z >= -1 && tmp.z <= 1;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.display = visible ? 'block' : 'none';
    }
  }

  function loop() {
    if (controls) controls.update();
    if (needsRender) {
      renderer.render(scene, camera);
      updateLabels();
      needsRender = false;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return {
    dispose() {
      ro.disconnect();
      tooltip.remove();
      disposeScene(scene);
      renderer.dispose();
    },
    reset, toggle
  };
}

// Wall view: 2D grid of voxels (no orbit controls), with per-voxel scale animation on update.
export function wallView({ container, title, levels, jds, getCell, modelLabel, axisLabel, axisDescription = '', onSelect = null }) {
  const ramp = paletteRamp();
  const STEP = STRIDE * 1.4;

  const panelEl = document.createElement('div');
  panelEl.className = 'panel';
  const head = document.createElement('div');
  head.className = 'panel-head';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = title;
  head.append(titleSpan);
  panelEl.append(head);

  const chartEl = document.createElement('div');
  chartEl.className = 'chart';
  panelEl.append(chartEl);
  container.innerHTML = '';
  container.append(panelEl);

  const scene = new THREE.Scene();
  scene.background = cssColor('--panel');
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.75);
  dirLight.position.set(40, 80, 80);
  scene.add(dirLight);

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 4000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  chartEl.append(renderer.domElement);

  const tooltip = makeTooltip();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const accentColor = cssColor('--accent');

  let hoveredCellId = null;
  let selectedCellId = null;
  let mouseTargetX = 0, mouseTargetY = 0;
  let mouseWorldX = 0, mouseWorldY = 0;
  const MOUSE_DEPTH = 140;
  let cameraLookY = 0;
  let cameraDist = 100;
  const mousePlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), MOUSE_DEPTH);
  const mouseHit = new THREE.Vector3();

  const geom = new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL);
  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  let instanced = null;
  let instances = [];

  const labelGroup = new THREE.Group();
  scene.add(labelGroup);
  const voxelGroup = new THREE.Group();
  scene.add(voxelGroup);
  let xOff = 0;
  let yOff = 0;
  function updateOffsets() {
    xOff = -((jds.length - 1) * STEP) / 2;
    yOff = -((levels.length - 1) * STEP) / 2;
  }
  updateOffsets();

  function rebuildLabels() {
    while (labelGroup.children.length) {
      const c = labelGroup.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material?.map) c.material.map.dispose();
      if (c.material) c.material.dispose();
    }
    updateOffsets();
    const wallW = (jds.length - 1) * STEP;
    const wallH = (levels.length - 1) * STEP;
    const jdLabelHeight = 72;
    const variantLabelWidth = 40;
    const truncate = (s, n) => {
      if (s.length <= n) return s;
      const cut = s.slice(0, n - 1);
      const lastSpace = cut.lastIndexOf(' ');
      return (lastSpace > n * 0.5 ? cut.slice(0, lastSpace) : cut.replace(/[\s\-–_/]+$/, '')) + '…';
    };
    const LABEL_Z = 8;
    for (let i = 0; i < jds.length; i++) {
      const txt = truncate(jds[i].label ?? jds[i].id, 30);
      const lbl = floorLabelMesh({
        text: txt, width: STEP - 0.5, height: jdLabelHeight,
        color: '--dim', bg: null, border: null, align: 'left', rotateText: -Math.PI / 2
      });
      lbl.rotation.x = 0;
      lbl.position.set(i * STEP + xOff, yOff - STEP * 0.6 - jdLabelHeight / 2, LABEL_Z);
      labelGroup.add(lbl);
    }
    for (let i = 0; i < levels.length; i++) {
      const txt = truncate(levels[i].label ?? levels[i], 26);
      const lbl = floorLabelMesh({
        text: txt, width: variantLabelWidth, height: STEP - 0.5,
        color: '--text', bg: null, border: null, align: 'right'
      });
      lbl.rotation.x = 0;
      lbl.position.set(xOff - STEP * 0.3 - variantLabelWidth / 2, i * STEP + yOff, LABEL_Z);
      labelGroup.add(lbl);
    }

    const gapAboveWall = STEP * 1.8;
    const titleH = 14;
    const subH = 9;
    const subLineGap = 5;
    const subLines = axisDescription ? wrapText(axisDescription, 70) : [];
    const descTopY = yOff + wallH + gapAboveWall + Math.max(0, subLines.length - 1) * subLineGap;
    for (let i = 0; i < subLines.length; i++) {
      const sub = floorLabelMesh({
        text: subLines[i], width: 140, height: subH, color: '--dim', bg: null, border: null, align: 'center'
      });
      sub.rotation.x = 0;
      sub.position.set(0, descTopY - i * subLineGap, LABEL_Z);
      labelGroup.add(sub);
    }

    const cap = floorLabelMesh({
      text: `${modelLabel}  ·  ${axisLabel}`,
      width: 120, height: titleH, color: '--accent', bg: null, border: null, align: 'center'
    });
    cap.rotation.x = 0;
    const titleY = subLines.length ? descTopY + subLineGap : descTopY + titleH / 2 + 2;
    cap.position.set(0, titleY, LABEL_Z);
    labelGroup.add(cap);
  }

  function wrapText(text, maxChars) {
    const words = text.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxChars) {
        if (cur) lines.push(cur);
        cur = w;
      } else {
        cur = (cur + ' ' + w).trim();
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function fitCamera() {
    updateOffsets();
    const wallW = (jds.length - 1) * STEP;
    const wallH = (levels.length - 1) * STEP;
    const leftPad = 40 + STEP;
    const bottomPad = 72 + STEP * 1.5;
    const topPad = STEP * 2.5 + 30;
    const xSpan = wallW + leftPad * 2;
    const ySpan = wallH + bottomPad + topPad;
    cameraLookY = (topPad - bottomPad) / 2;
    const aspect = (chartEl.clientWidth || 1) / (chartEl.clientHeight || 1);
    const requiredV = Math.max(ySpan, xSpan / aspect) * 1.08;
    const fovRad = camera.fov * Math.PI / 180;
    cameraDist = requiredV / (2 * Math.tan(fovRad / 2));
    camera.position.set(0, cameraLookY, cameraDist);
    camera.lookAt(0, cameraLookY, 0);
  }

  function resize() {
    const w = chartEl.clientWidth;
    const h = chartEl.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  fitCamera();
  rebuildLabels();
  resize();
  new ResizeObserver(resize).observe(chartEl);

  const ENTRY_DUR = 380;
  const EXIT_DUR = 220;
  let lastT = performance.now();

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInCubic(t) { return t * t * t; }

  function rebuildInstanced(targetCount) {
    if (instanced && instanced.count === targetCount) return;
    if (instanced) {
      voxelGroup.remove(instanced);
      instanced.dispose?.();
    }
    instanced = new THREE.InstancedMesh(geom, mat, Math.max(1, targetCount));
    voxelGroup.add(instanced);
  }

  function setVoxels(newVoxels) {
    const desired = new Map();
    for (const v of newVoxels) {
      const color = v.color ?? rampLookup(ramp, v.value ?? 0);
      desired.set(v.cellId, { ...v, color });
    }

    const survivors = [];
    for (const inst of instances) {
      const next = desired.get(inst.cellId);
      if (next) {
        inst.color = next.color;
        inst.meta = next.meta;
        inst.targetScale = 1;
        inst.startScale = inst.currentScale;
        inst.startTime = performance.now();
        inst.dur = ENTRY_DUR;
        inst.ease = 'out';
        desired.delete(inst.cellId);
        survivors.push(inst);
      } else {
        inst.targetScale = 0;
        inst.startScale = inst.currentScale;
        inst.startTime = performance.now();
        inst.dur = EXIT_DUR;
        inst.ease = 'in';
        inst.dying = true;
        survivors.push(inst);
      }
    }
    const sortedNew = [...desired.values()].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    for (let i = 0; i < sortedNew.length; i++) {
      const v = sortedNew[i];
      survivors.push({
        cellId: v.cellId,
        x: v.x, y: v.y,
        color: v.color,
        meta: v.meta,
        currentScale: 0,
        startScale: 0,
        targetScale: 1,
        startTime: performance.now() + i * 18,
        dur: ENTRY_DUR,
        ease: 'out',
        dying: false
      });
    }
    instances = survivors;
    rebuildInstanced(instances.length);
  }

  const tmpColor = new THREE.Color();
  function render() {
    const t = performance.now();
    const dummy = new THREE.Object3D();
    const aliveInstances = [];
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const dt = t - inst.startTime;
      if (dt < 0) {
        inst.currentScale = inst.startScale;
      } else {
        const k = Math.min(1, dt / inst.dur);
        const eased = inst.ease === 'in' ? easeInCubic(k) : easeOutCubic(k);
        inst.currentScale = inst.startScale + (inst.targetScale - inst.startScale) * eased;
      }
      if (inst.dying && inst.currentScale <= 0.001) continue;
      aliveInstances.push(inst);
    }
    if (aliveInstances.length !== instances.length) {
      instances = aliveInstances;
      rebuildInstanced(instances.length);
    }
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const isHovered = inst.cellId === hoveredCellId;
      const isSelected = inst.cellId === selectedCellId;
      const targetBoost = isSelected ? 1.4 : isHovered ? 1.18 : 1.0;
      inst.boost = inst.boost ?? 1.0;
      inst.boost += (targetBoost - inst.boost) * 0.18;

      const vx = inst.x + xOff;
      const vy = inst.y + yOff;
      const tx = mouseWorldX - vx;
      const ty = mouseWorldY - vy;
      const tz = MOUSE_DEPTH;
      const yaw = Math.atan2(tx, tz);
      const pitch = -Math.atan2(ty, Math.sqrt(tx * tx + tz * tz));

      dummy.position.set(vx, vy, isSelected ? 1.0 : isHovered ? 0.5 : 0);
      dummy.rotation.set(pitch, yaw, 0);
      dummy.scale.setScalar(Math.max(0.0001, inst.currentScale * inst.boost));
      dummy.updateMatrix();
      instanced.setMatrixAt(i, dummy.matrix);

      const highlight = Math.max(0, inst.boost - 1.0);
      if (highlight > 0.005) {
        tmpColor.copy(inst.color).lerp(accentColor, Math.min(1, highlight * 1.2));
        instanced.setColorAt(i, tmpColor);
      } else {
        instanced.setColorAt(i, inst.color);
      }
    }
    if (instanced) {
      instanced.instanceMatrix.needsUpdate = true;
      if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    }

    mouseWorldX += (mouseTargetX - mouseWorldX) * 0.12;
    mouseWorldY += (mouseTargetY - mouseWorldY) * 0.12;

    renderer.render(scene, camera);
    lastT = t;
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  function onMove(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    pointer.x = nx;
    pointer.y = ny;
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.ray.intersectPlane(mousePlane, mouseHit)) {
      mouseTargetX = mouseHit.x;
      mouseTargetY = mouseHit.y;
    }

    if (!instanced) return;
    const hits = raycaster.intersectObject(instanced);
    if (hits.length > 0) {
      const inst = instances[hits[0].instanceId];
      if (inst?.meta) {
        hoveredCellId = inst.cellId;
        tooltip.innerHTML = [
          fmtTooltipRow('Variant:', inst.meta.levelLabel ?? inst.meta.level ?? ''),
          fmtTooltipRow('Job:', inst.meta.jdLabel ?? inst.meta.jd ?? ''),
          fmtTooltipRow('Δ:', (inst.meta.delta != null ? ((inst.meta.delta >= 0 ? '+' : '') + inst.meta.delta.toFixed(2)) : '–')),
          fmtTooltipRow('Mean:', inst.meta.mean != null ? inst.meta.mean.toFixed(2) : '–'),
          fmtTooltipRow('Baseline:', inst.meta.baseline_mean != null ? inst.meta.baseline_mean.toFixed(2) : '–'),
          fmtTooltipRow('Runs:', inst.meta.n ?? '–'),
          fmtTooltipRow('Significant:', inst.meta.significant ? 'yes (CI excludes baseline)' : 'no')
        ].join('<br>');
        tooltip.style.display = 'block';
        tooltip.style.left = `${ev.clientX + 14}px`;
        tooltip.style.top = `${ev.clientY + 12}px`;
        chartEl.style.cursor = 'pointer';
        return;
      }
    }
    hoveredCellId = null;
    tooltip.style.display = 'none';
    chartEl.style.cursor = 'default';
  }
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerleave', () => {
    hoveredCellId = null;
    tooltip.style.display = 'none';
    mouseTargetX = 0;
    mouseTargetY = cameraLookY;
  });

  function onClick(ev) {
    if (!instanced) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(instanced);
    if (hits.length > 0) {
      const inst = instances[hits[0].instanceId];
      if (inst?.meta) {
        selectedCellId = selectedCellId === inst.cellId ? null : inst.cellId;
        if (onSelect) onSelect(selectedCellId ? inst.meta : null, selectedCellId);
      }
    } else {
      selectedCellId = null;
      if (onSelect) onSelect(null, null);
    }
  }
  renderer.domElement.addEventListener('click', onClick);

  document.addEventListener('themechange', () => {
    scene.background = cssColor('--panel');
    rebuildLabels();
  });

  return {
    setVoxels,
    setLevels(newLevels) {
      levels = newLevels;
      rebuildLabels();
      fitCamera();
    },
    setLabels(m, a) {
      modelLabel = m;
      axisLabel = a;
      rebuildLabels();
    },
    setSelected({ levels: newLevels, jds: newJds, modelLabel: m, axisLabel: a, axisDescription: d }) {
      if (newLevels) levels = newLevels;
      if (newJds) jds = newJds;
      if (m) modelLabel = m;
      if (a) axisLabel = a;
      if (d !== undefined) axisDescription = d;
      fitCamera();
      rebuildLabels();
    }
  };
}

// 3D bias matrix: X = model, Z = axis, Y = level within axis. One voxel per (axis, level, model) cell.
export function biasMatrix({ container, title, axes, models, levelsByAxis, matrix, onHover, onClick }) {
  const ramp = paletteRamp();
  let maxAbs = 0;
  for (const axis of axes) {
    for (const level of levelsByAxis[axis] || []) {
      for (const model of models) {
        const cell = matrix[axis]?.[level]?.[model];
        if (cell && cell.mean_delta != null) maxAbs = Math.max(maxAbs, Math.abs(cell.mean_delta));
      }
    }
  }
  maxAbs = maxAbs || 0.0001;

  const voxels = [];
  const metadata = {};
  const groundColor = cssColor('--border');
  const SPACING = 6;
  const VSPACING = 2;
  const maxLevels = Math.max(...axes.map((a) => (levelsByAxis[a] || []).length));

  for (let zi = 0; zi < axes.length; zi++) {
    const axis = axes[zi];
    const levels = levelsByAxis[axis] || [];
    for (let xi = 0; xi < models.length; xi++) {
      voxels.push({ x: xi * SPACING, y: -1 * VSPACING, z: zi * (maxLevels * VSPACING + SPACING) - VSPACING, color: groundColor, cellId: `__floor__${axis}|${models[xi]}` });
    }
    for (let yi = 0; yi < levels.length; yi++) {
      const level = levels[yi];
      for (let xi = 0; xi < models.length; xi++) {
        const cell = matrix[axis]?.[level]?.[models[xi]];
        if (!cell || cell.mean_delta == null) continue;
        const color = rampLookup(ramp, cell.mean_delta / maxAbs);
        const cellId = `${axis}|${level}|${models[xi]}`;
        voxels.push({
          x: xi * SPACING,
          y: yi * VSPACING,
          z: zi * (maxLevels * VSPACING + SPACING),
          color, cellId
        });
        metadata[cellId] = { axis, level, model: models[xi], ...cell };
      }
    }
  }

  const cellW = SPACING * STRIDE;
  const totalX = models.length * cellW;
  const totalZ = axes.length * (maxLevels * VSPACING * STRIDE + SPACING * STRIDE);
  const FLOOR_Y = -1.6 * STRIDE;
  const xCenter = totalX / 2 - cellW / 2;
  const zCenter = totalZ / 2;

  const floorMeshes = [];
  for (let j = 0; j < models.length; j++) {
    const logo = modelLogoMesh({ model: models[j], width: cellW - 2, height: 14 });
    logo.position.set(j * cellW, FLOOR_Y, -cellW * 0.7);
    floorMeshes.push(logo);
  }
  for (let i = 0; i < axes.length; i++) {
    const cellH = maxLevels * VSPACING * STRIDE + SPACING * STRIDE - VSPACING * STRIDE;
    const tick = floorLabelMesh({ text: axes[i], width: 14, height: cellH, color: '--text', bg: '--panel', border: '--border', rotateText: -Math.PI / 2 });
    tick.position.set(-cellW * 0.65, FLOOR_Y, i * (maxLevels * VSPACING * STRIDE + SPACING * STRIDE) + cellH / 2 - VSPACING * STRIDE / 2);
    floorMeshes.push(tick);

    const levels = levelsByAxis[axes[i]] || [];
    for (let yi = 0; yi < levels.length; yi++) {
      const llbl = floorLabelMesh({ text: levels[yi], width: 16, height: VSPACING * STRIDE - 1, color: '--dim', bg: '--bg', border: null, align: 'right' });
      llbl.rotation.x = 0;
      llbl.rotation.y = Math.PI / 2;
      llbl.position.set(-2, yi * VSPACING * STRIDE, i * (maxLevels * VSPACING * STRIDE + SPACING * STRIDE));
      floorMeshes.push(llbl);
    }
  }

  const ramp3D = floorRampMesh({
    ramp,
    width: totalX * 0.95,
    height: 9,
    loText: `−${maxAbs.toFixed(2)} (penalised)`,
    hiText: `+${maxAbs.toFixed(2)} (rewarded)`
  });
  ramp3D.position.set(xCenter, FLOOR_Y + 0.1, totalZ + cellW * 0.2);
  floorMeshes.push(ramp3D);

  const rampCaption = floorLabelMesh({
    text: '1 VOXEL = 1 RESUME VARIANT · COLOUR = MEAN SIGNED Δ ACROSS ALL JDs',
    width: totalX * 0.85, height: 6, color: '--dim', bg: '--bg', border: null, align: 'center'
  });
  rampCaption.position.set(xCenter, FLOOR_Y, totalZ + cellW * 0.7);
  floorMeshes.push(rampCaption);

  const legend = {
    ramp,
    signedDomain: {
      lo: -maxAbs, hi: maxAbs,
      loLabel: `−${maxAbs.toFixed(2)} (penalised)`,
      hiLabel: `+${maxAbs.toFixed(2)} (rewarded)`
    },
    signedLabel: '1 voxel = 1 resume variant · colour = mean signed Δ across all JDs · empty = no data yet'
  };

  return createVoxelScene({
    container, title, voxels, metadata,
    formatTooltip: (meta) => meta ? [
      fmtTooltipRow('axis:', meta.axis),
      fmtTooltipRow('variant:', meta.level),
      fmtTooltipRow('model:', meta.model),
      fmtTooltipRow('Δ:', (meta.mean_delta >= 0 ? '+' : '') + meta.mean_delta.toFixed(2)),
      fmtTooltipRow('|Δ|:', meta.mean_abs_delta.toFixed(2)),
      fmtTooltipRow('jds:', meta.n_jds),
      fmtTooltipRow('sig:', (meta.sig_rate * 100).toFixed(0) + '%')
    ].join('<br>') : '',
    onClick,
    onHover,
    cameraOffset: [0.9, 0.5, 1.3],
    legend,
    floorMeshes
  });
}

// (legacy) City heatmap: axes × models grid, stack height = mean |Δ|, colour = signed Δ
export function cityHeatmap({ container, title, axes, models, heights, signs, significant, metadata, onClick }) {
  const ramp = paletteRamp();
  const maxH = Math.max(...heights.flat().map((h) => Math.abs(h ?? 0)), 0.0001);
  const maxSigned = Math.max(...signs.flat().map((s) => Math.abs(s ?? 0)), 0.0001);
  const maxStack = 24;
  const voxels = [];
  const groundColor = cssColor('--border');
  const SPACING = 8;

  for (let i = 0; i < axes.length; i++) {
    for (let j = 0; j < models.length; j++) {
      const cellId = `${axes[i]}|${models[j]}`;
      voxels.push({ x: j * SPACING, y: -1, z: i * SPACING, color: groundColor, cellId });

      const h = heights[i][j];
      const sign = signs[i][j];
      if (h == null) continue;
      const stack = Math.max(2, Math.round(Math.sqrt(h / maxH) * maxStack));
      const color = rampLookup(ramp, (sign ?? 0) / maxSigned);
      for (let y = 0; y < stack; y++) {
        voxels.push({ x: j * SPACING, y, z: i * SPACING, color, cellId });
      }
      if (significant?.[i]?.[j] >= 0.5) {
        const cap = cssColor('--accent');
        voxels.push({ x: j * SPACING, y: stack + 1, z: i * SPACING, color: cap, cellId });
      }
    }
  }

  const floorMeshes = [];
  const cellW = SPACING * STRIDE;
  const totalX = models.length * cellW;
  const totalZ = axes.length * cellW;
  const FLOOR_Y = -2.5 * STRIDE;
  const xCenter = totalX / 2 - cellW / 2;
  const zCenter = totalZ / 2 - cellW / 2;

  const grid = floorGridMesh({ cols: models.length, rows: axes.length, spacing: cellW, color: '--border' });
  grid.position.set(xCenter, FLOOR_Y - 0.2, zCenter);
  floorMeshes.push(grid);

  for (let j = 0; j < models.length; j++) {
    const logo = modelLogoMesh({ model: models[j], width: cellW - 4, height: 18 });
    logo.position.set(j * cellW, FLOOR_Y, -cellW * 0.55);
    floorMeshes.push(logo);
  }
  for (let i = 0; i < axes.length; i++) {
    const tick = floorLabelMesh({ text: axes[i], width: 18, height: cellW - 4, color: '--text', bg: '--panel', border: '--border', rotateText: -Math.PI / 2 });
    tick.position.set(-cellW * 0.55, FLOOR_Y, i * cellW);
    floorMeshes.push(tick);
  }

  const ramp3D = floorRampMesh({
    ramp,
    width: totalX * 0.95,
    height: 11,
    loText: `−${maxSigned.toFixed(1)} (penalised)`,
    hiText: `+${maxSigned.toFixed(1)} (rewarded)`
  });
  ramp3D.position.set(xCenter, FLOOR_Y + 0.1, totalZ + cellW * 0.05);
  floorMeshes.push(ramp3D);

  const rampCaption = floorLabelMesh({
    text: 'COLOUR = SIGNED Δ FROM BASELINE',
    width: totalX * 0.7, height: 7, color: '--dim', bg: '--bg', border: null, align: 'center'
  });
  rampCaption.position.set(xCenter, FLOOR_Y, totalZ + cellW * 0.65);
  floorMeshes.push(rampCaption);

  const legend = {
    ramp,
    signedDomain: {
      lo: -maxSigned, hi: maxSigned,
      loLabel: `−${maxSigned.toFixed(1)} (penalised)`,
      hiLabel: `+${maxSigned.toFixed(1)} (rewarded)`
    },
    magnitudeDomain: { max: maxH },
    signedLabel: 'colour = mean signed Δ from baseline',
    magnitudeLabel: 'stack height = mean |Δ|',
    hasSignificantCap: true
  };

  return createVoxelScene({
    container, title, voxels, metadata,
    formatTooltip: (meta) => meta ? [
      fmtTooltipRow('axis:', meta.axis),
      fmtTooltipRow('model:', meta.model),
      fmtTooltipRow('mean |Δ|:', meta.mean_abs?.toFixed(2) ?? '–'),
      fmtTooltipRow('signed Δ:', meta.signed != null ? ((meta.signed >= 0 ? '+' : '') + meta.signed.toFixed(2)) : '–'),
      fmtTooltipRow('worst:', `${meta.worst_level} @ ${meta.worst_jd}`),
      fmtTooltipRow('sig%:', meta.sig_rate != null ? ((meta.sig_rate * 100).toFixed(0) + '%') : '–')
    ].join('<br>') : '',
    onClick,
    cameraOffset: [0.9, 0.5, 1.3],
    legend,
    floorMeshes
  });
}

// Skyline: models × axes grid (transposed of city)
export function skyline({ container, title, axes, models, sensitivity, metadata, onClick }) {
  const ramp = paletteRamp();
  const flat = [];
  for (const m of models) for (const a of axes) {
    const v = sensitivity[m]?.[a];
    if (v != null) flat.push(v);
  }
  const maxH = Math.max(...flat, 0);
  const maxStack = 22;
  const voxels = [];

  for (let i = 0; i < models.length; i++) {
    for (let j = 0; j < axes.length; j++) {
      const v = sensitivity[models[i]]?.[axes[j]];
      if (v == null) continue;
      const stack = Math.max(1, Math.round((v / (maxH || 1)) * maxStack));
      const color = intensity(ramp, v, maxH);
      const cellId = `${models[i]}|${axes[j]}`;
      for (let y = 0; y < stack; y++) voxels.push({ x: j * 8, y, z: i * 8, color, cellId });
    }
  }
  return createVoxelScene({
    container, title, voxels, metadata,
    formatTooltip: (meta) => meta ? [
      fmtTooltipRow('model:', meta.model),
      fmtTooltipRow('axis:', meta.axis),
      fmtTooltipRow('mean |Δ|:', meta.value.toFixed(2))
    ].join('<br>') : '',
    onClick
  });
}

// Landscape: JD seniority × axes terrain
export function landscape({ container, title, jds, axes, heights, metadata, onClick }) {
  const ramp = paletteRamp();
  const maxH = Math.max(...heights.flat().filter((x) => x != null), 0.0001);
  const maxStack = 18;
  const voxels = [];

  for (let i = 0; i < jds.length; i++) {
    for (let j = 0; j < axes.length; j++) {
      const v = heights[i][j];
      if (v == null) continue;
      const stack = Math.max(1, Math.round((v / maxH) * maxStack));
      const color = intensity(ramp, v, maxH);
      const cellId = `${jds[i].id}|${axes[j]}`;
      for (let y = 0; y < stack; y++) voxels.push({ x: i * 6, y, z: j * 8, color, cellId });
    }
  }
  return createVoxelScene({
    container, title, voxels, metadata,
    formatTooltip: (meta) => meta ? [
      fmtTooltipRow('jd:', meta.jd),
      fmtTooltipRow('seniority:', meta.seniority),
      fmtTooltipRow('axis:', meta.axis),
      fmtTooltipRow('mean |Δ|:', meta.value?.toFixed(2) ?? '–')
    ].join('<br>') : '',
    onClick,
    cameraOffset: [0.8, 0.9, 1.3]
  });
}

// 3D histogram: ridges per model
export function histogram3D({ container, title, models, bins, counts, metadata, onClick }) {
  const ramp = paletteRamp();
  const maxC = Math.max(...counts.flat(), 1);
  const maxStack = 20;
  const voxels = [];

  for (let i = 0; i < models.length; i++) {
    for (let j = 0; j < bins.length; j++) {
      const c = counts[i][j];
      if (!c) continue;
      const stack = Math.max(1, Math.round((c / maxC) * maxStack));
      const t = (j / (bins.length - 1)) * 2 - 1;
      const color = rampLookup(ramp, t);
      const cellId = `${models[i]}|${bins[j]}`;
      for (let y = 0; y < stack; y++) voxels.push({ x: j * 6, y, z: i * 8, color, cellId });
    }
  }
  return createVoxelScene({
    container, title, voxels, metadata,
    formatTooltip: (meta) => meta ? [
      fmtTooltipRow('model:', meta.model),
      fmtTooltipRow('score:', meta.score),
      fmtTooltipRow('count:', meta.count)
    ].join('<br>') : '',
    onClick
  });
}

// Agreement cube: 6×6 model × model
export function agreementCube({ container, title, models, matrix, metadata, onClick }) {
  const ramp = paletteRamp();
  const maxStack = 20;
  const voxels = [];

  for (let i = 0; i < models.length; i++) {
    for (let j = 0; j < models.length; j++) {
      if (i === j) continue;
      const v = matrix[models[i]]?.[models[j]];
      if (v == null) continue;
      const stack = Math.max(1, Math.round(v * maxStack));
      const color = rampLookup(ramp, v * 2 - 1);
      const cellId = `${models[i]}|${models[j]}`;
      for (let y = 0; y < stack; y++) voxels.push({ x: j * 8, y, z: i * 8, color, cellId });
    }
  }
  return createVoxelScene({
    container, title, voxels, metadata,
    formatTooltip: (meta) => meta ? [
      fmtTooltipRow('a:', meta.a),
      fmtTooltipRow('b:', meta.b),
      fmtTooltipRow('agreement:', (meta.value * 100).toFixed(0) + '%')
    ].join('<br>') : '',
    onClick
  });
}

// n-gram bars: single row of voxel stacks
export function ngramBars({ container, title, ngrams, metadata, onClick }) {
  const ramp = paletteRamp();
  const maxC = Math.max(...ngrams.map((g) => g.count), 1);
  const maxStack = 22;
  const voxels = [];

  for (let i = 0; i < ngrams.length; i++) {
    const g = ngrams[i];
    const stack = Math.max(1, Math.round((g.count / maxC) * maxStack));
    const color = intensity(ramp, g.ratio, Math.max(...ngrams.map((x) => x.ratio), 1));
    const cellId = `${g.phrase}|${i}`;
    for (let y = 0; y < stack; y++) voxels.push({ x: i * 6, y, z: 0, color, cellId });
  }
  return createVoxelScene({
    container, title, voxels, metadata,
    formatTooltip: (meta) => meta ? [
      fmtTooltipRow('phrase:', meta.phrase),
      fmtTooltipRow('count:', meta.count),
      fmtTooltipRow('baseline:', meta.baseline_count),
      fmtTooltipRow('ratio:', meta.ratio.toFixed(2))
    ].join('<br>') : '',
    onClick,
    cameraOffset: [0.4, 0.7, 1.2]
  });
}
