import { loadJson, fmtPct, fmtDate, fmtNum, el } from './lib.js';

const PAGES = [
  { href: 'index.html', label: 'story' },
  { href: 'heatmap.html', label: 'heatmap' },
  { href: 'diff.html', label: 'diff' },
  { href: 'resume-diff.html', label: 'resume-diff' },
  { href: 'jds.html', label: 'jobs' },
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

const AUTHOR_LINKS = [
  { href: 'https://re-cinq.com', label: 're:cinq' },
  { href: 'https://szabobogdan.com/', label: 'szabobogdan.com' },
  { href: 'https://github.com/gedaiu', label: 'GitHub' },
  { href: 'https://www.linkedin.com/in/szabobogdan/', label: 'LinkedIn' }
];

function extLink(href, label) {
  return el('a', { href, target: '_blank', rel: 'noopener' }, label);
}

function linkRow(prefix, links) {
  const row = el('div', { class: 'footer-row' }, prefix ? [prefix] : []);
  links.forEach((link, i) => {
    if (i > 0 || prefix) row.append(el('span', { class: 'footer-sep' }, '·'));
    row.append(extLink(link.href, link.label));
  });
  return row;
}

export function renderFooter() {
  const inner = el('div', { class: 'footer-inner' });
  inner.append(el('div', { class: 'footer-row footer-id' }, 'BIAS://research, a counterfactual audit of LLM hiring bias'));
  inner.append(linkRow('Built by Bogdan Szabo', AUTHOR_LINKS));
  inner.append(el('div', { class: 'footer-row footer-meta' }, [
    `© ${new Date().getFullYear()} Bogdan Szabo`,
    el('span', { class: 'footer-sep' }, '·'),
    extLink('https://github.com/gedaiu', 'source on GitHub')
  ]));
  document.body.append(el('footer', { class: 'bottom' }, inner));
}

export async function mountChrome() {
  await renderStatus();
  renderNav();
  renderFooter();
}
