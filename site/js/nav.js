import { loadJson, fmtPct, fmtDate, fmtNum, el } from './lib.js';

const PAGES = [
  { href: 'index.html', label: 'story' },
  { href: 'heatmap.html', label: 'heatmap' },
  { href: 'axis.html', label: 'axes' },
  { href: 'models.html', label: 'models' },
  { href: 'jd.html', label: 'jds' },
  { href: 'diff.html', label: 'diff' },
  { href: 'resume-diff.html', label: 'resume-diff' },
  { href: 'methodology.html', label: 'methodology' },
  { href: 'downloads.html', label: 'downloads' },
  { href: 'about.html', label: 'about' }
];

function currentPage() {
  const here = location.pathname.split('/').pop() || 'index.html';
  return here;
}

export function renderNav() {
  const here = currentPage();
  const nav = el('nav', { class: 'top' });
  nav.append(el('a', { href: 'index.html', class: 'brand' }, 'BIAS://research'));
  for (const p of PAGES) {
    const a = el('a', { href: p.href, class: here === p.href ? 'active' : '' }, p.label);
    nav.append(a);
  }
  nav.append(el('span', { class: 'spacer' }));
  const themeBtn = el('button', {
    onclick: () => toggleTheme(themeBtn)
  }, themeLabel());
  nav.append(themeBtn);
  document.body.insertBefore(nav, document.body.firstChild);
}

function themeLabel() {
  const t = document.documentElement.dataset.theme || 'dark';
  return t === 'dark' ? '[light]' : '[dark]';
}

function toggleTheme(btn) {
  const cur = document.documentElement.dataset.theme || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  btn.textContent = themeLabel();
  document.dispatchEvent(new CustomEvent('themechange', { detail: next }));
}

function initTheme() {
  const stored = localStorage.getItem('theme');
  if (stored) document.documentElement.dataset.theme = stored;
}

export async function renderStatus() {
  initTheme();
  let status;
  try { status = await loadJson('data/status.json'); }
  catch { return; }
  const pct = status.n_records / status.expected_total_records;
  const bar = el('div', { class: 'status' });
  bar.append(el('span', { class: 'caret' }));
  bar.append(el('span', {}, 'data: '));
  bar.append(el('strong', {}, `${status.n_records}/${status.expected_total_records}`));
  bar.append(el('span', {}, ` (${fmtPct(pct, 1)})`));
  bar.append(el('span', { class: 'sep' }, '·'));
  bar.append(el('span', {}, 'cells: '));
  bar.append(el('strong', {}, `${status.n_cells_complete}/${status.n_cells_total}`));
  bar.append(el('span', { class: 'sep' }, '·'));
  bar.append(el('span', {}, 'spend: '));
  bar.append(el('strong', {}, `$${fmtNum(status.total_cost_usd, 2)}`));
  bar.append(el('span', { class: 'sep' }, '·'));
  bar.append(el('span', {}, 'updated: '));
  bar.append(el('strong', {}, fmtDate(status.generated_at)));
  document.body.insertBefore(bar, document.body.firstChild);
}

export async function mountChrome() {
  await renderStatus();
  renderNav();
}
