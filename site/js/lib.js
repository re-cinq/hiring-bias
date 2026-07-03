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
  if (x == null || Number.isNaN(x)) return '–';
  return Number(x).toFixed(digits);
}

export function fmtPct(x, digits = 0) {
  if (x == null || Number.isNaN(x)) return '–';
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtSignedDelta(x, digits = 2) {
  if (x == null || Number.isNaN(x)) return '–';
  const s = Number(x).toFixed(digits);
  return x > 0 ? `+${s}` : s;
}

export function fmtDate(iso) {
  if (!iso) return '–';
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

export const MODEL_DISPLAY = {
  'claude-opus': 'Claude Opus',
  'claude-sonnet': 'Claude Sonnet',
  'claude-haiku': 'Claude Haiku',
  'claude-fable-5': 'Claude Fable 5',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro · Preview',
  'llama-4-maverick': 'Llama 4 Maverick',
  'mistral-large': 'Mistral Large',
  'mistral-small': 'Mistral Small',
  'qwen-3-next-80b': 'Qwen 3 Next 80B'
};

// The Gemini/Llama/Qwen slots already name their version. Claude (CLI tier aliases) and Mistral
// (-latest API tag) are floating aliases that carry no version, so these are the concrete
// snapshots they resolved to, probed live on 2026-05-29 against the collection window (~2026-05-20).
export const MODEL_VERSION = {
  'claude-opus': 'claude-opus-4-7',
  'claude-sonnet': 'claude-sonnet-4-6',
  'claude-haiku': 'claude-haiku-4-5-20251001',
  'claude-fable-5': 'claude-fable-5',
  'mistral-large': 'mistral-large-2512',
  'mistral-small': 'mistral-small-2603'
};

export const modelLabel = (m) => MODEL_DISPLAY[m] ?? m;
export const modelVersion = (m) => MODEL_VERSION[m] ?? null;

export function pill(recommend) {
  const r = (recommend ?? '').toLowerCase();
  const cls = ['yes', 'no', 'maybe'].includes(r) ? r : '';
  return el('span', { class: `pill ${cls}` }, r || '–');
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

export function header(title) {
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
  return node;
}
