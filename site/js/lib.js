export async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
}

export function params() {
  return new URLSearchParams(location.search);
}

export function setParam(key, value, { replace = false } = {}) {
  const url = new URL(location.href);
  if (value == null || value === '') url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({}, '', url.toString());
}

export function fmtNum(x, digits = 2) {
  if (x == null || Number.isNaN(x)) return '—';
  return Number(x).toFixed(digits);
}

export function fmtPct(x, digits = 0) {
  if (x == null || Number.isNaN(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtSignedDelta(x, digits = 2) {
  if (x == null || Number.isNaN(x)) return '—';
  const s = Number(x).toFixed(digits);
  return x > 0 ? `+${s}` : s;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return iso.replace(/T.*$/, '');
}

export function deltaClass(x) {
  if (x == null) return 'delta-zero';
  if (x > 0.05) return 'delta-pos';
  if (x < -0.05) return 'delta-neg';
  return 'delta-zero';
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function badges(filled, total = 10, klass = 'on') {
  const node = el('span', { class: 'badges' });
  for (let i = 0; i < total; i++) {
    node.append(el('span', { class: `cell ${i < filled ? klass : ''}` }));
  }
  return node;
}

export function pill(recommend) {
  const r = (recommend ?? '').toLowerCase();
  const cls = ['yes', 'no', 'maybe'].includes(r) ? r : '';
  return el('span', { class: `pill ${cls}` }, r || '—');
}

export function copyLinkButton() {
  const btn = el('button', {
    onclick: async () => {
      await navigator.clipboard.writeText(location.href);
      const orig = btn.textContent;
      btn.textContent = '[copied]';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    }
  }, '[copy link]');
  return btn;
}

export function header(title, subtitle) {
  const w = (title || '').length;
  const inner = Math.max(w + 4, 32);
  const horiz = '═'.repeat(inner);
  const rightPad = ' '.repeat(inner - 2 - w);
  const node = document.createElement('div');
  node.className = 'header-box';
  const t = document.createElement('span');
  t.className = 'title';
  t.textContent = title;
  node.append('╔' + horiz + '╗\n║  ');
  node.append(t);
  node.append(rightPad + '║\n╚' + horiz + '╝');
  if (subtitle) {
    const s = document.createElement('div');
    s.className = 'dim';
    s.style.marginTop = '4px';
    s.textContent = subtitle;
    node.append(s);
  }
  return node;
}
