import { mountChrome } from './nav.js';
import { loadJson, el, header } from './lib.js';

await mountChrome();
document.getElementById('header').append(header('DOWNLOADS', 'raw and aggregated data'));

const status = await loadJson('data/status.json');
const summary = await loadJson('data/summary.json');
const variantCount = 1 + Object.values(summary.variants_by_axis ?? {}).reduce((s, levels) => s + levels.length, 0);

const page = document.getElementById('page');

const files = [
  { href: 'data/data.csv', name: 'data.csv', desc: 'Aggregated by (variant, model, jd). One row per cell with n, mean score, and recommend rate.' },
  { href: 'data/summary.md', name: 'summary.md', desc: 'Same table as data.csv plus per-model cost & token breakdown.' },
  { href: 'data/matrix.json', name: 'matrix.json', desc: 'Per-(axis, variant, model) mean Δ aggregated across JDs. Drives the heatmap.' },
  { href: 'data/status.json', name: 'status.json', desc: 'Cell completeness, total cost, last-updated timestamp.' },
  { href: 'data/summary.json', name: 'summary.json', desc: 'Axes, models, JDs, labels: the schema map for everything else.' },
  { href: 'data/raw/results.ndjson.gz', name: 'results.ndjson.gz', desc: 'Full run-level corpus. One JSON object per inference run. Gzipped.' },
  { href: 'data/resumes.json', name: 'resumes.json', desc: `Full text of all ${variantCount} résumé variants.` },
  { href: 'data/resume_base.md', name: 'resume_base.md', desc: 'The unmodified baseline résumé.' }
];

const panel = el('div', { class: 'panel' });
panel.append(el('div', { class: 'panel-head' }, el('span', {}, `${status.n_records.toLocaleString()} INFERENCES · $${status.total_cost_usd.toFixed(2)} SPENT`)));
const table = el('table', { class: 'data' });
table.append(el('thead', {}, el('tr', {}, [el('th', {}, 'File'), el('th', {}, 'Contents'), el('th', {}, '')])));
const tbody = el('tbody');
for (const f of files) {
  tbody.append(el('tr', {}, [
    el('td', {}, el('code', {}, f.name)),
    el('td', { class: 'dim' }, f.desc),
    el('td', {}, el('a', { href: f.href }, 'download ↓'))
  ]));
}
table.append(tbody);
panel.append(table);
page.append(panel);

const schema = el('div', { class: 'panel' });
schema.append(el('div', { class: 'panel-head' }, el('span', {}, 'RUN-LEVEL JSON SCHEMA')));
schema.append(el('pre', {}, `{
  "variant": "firstName_aisha-okonkwo",   // baseline + axis_level combinations
  "model": "claude-opus",
  "vendor": "anthropic",
  "tier": "flagship",
  "jd": "jd_senior_fullstack",
  "run": 1,                                // 1..~5 per cell
  "elapsed_ms": 12345,
  "timestamp": "2026-05-21T12:34:56.000Z",
  "response": {
    "score": 7,                            // 1..10
    "recommend_interview": "yes",          // yes | no | maybe
    "justification": "...",
    "strengths": [ "...", "...", "..." ],
    "concerns":  [ "...", "...", "..." ],
    "key_factors": [
      { "factor": "...", "direction": "positive"|"negative", "weight": "high"|"medium"|"low" }
    ]
  },
  "usage": { "input_tokens": 1234, "output_tokens": 234 }
}`));
page.append(schema);
