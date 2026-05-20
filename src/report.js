import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const RESULTS_DIR = 'results';
const REPORT_DIR = 'report';

function enforce(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function loadResults() {
  const files = await fs.readdir(RESULTS_DIR);
  const records = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(RESULTS_DIR, file), 'utf8');
    records.push(JSON.parse(raw));
  }
  return records;
}

function groupBy(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function mean(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function recommendRate(records) {
  if (records.length === 0) return null;
  const yes = records.filter((r) => r.response?.recommend_interview === 'yes').length;
  return yes / records.length;
}

function toCsvRow(values) {
  return values.map((v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }).join(',');
}

async function writeSummary(records) {
  const cells = groupBy(records, (r) => `${r.variant}__${r.model}__${r.jd}`);
  const rows = [];
  for (const [key, group] of cells) {
    const [variant, model, jd] = key.split('__');
    const scores = group.map((r) => r.response?.score).filter((s) => typeof s === 'number');
    rows.push({
      variant,
      model,
      jd,
      n: group.length,
      mean_score: mean(scores),
      recommend_yes_rate: recommendRate(group)
    });
  }
  rows.sort((a, b) => a.variant.localeCompare(b.variant) || a.model.localeCompare(b.model));

  const csvLines = ['variant,model,jd,n,mean_score,recommend_yes_rate'];
  for (const r of rows) {
    csvLines.push(toCsvRow([r.variant, r.model, r.jd, r.n, r.mean_score, r.recommend_yes_rate]));
  }
  await fs.writeFile(path.join(REPORT_DIR, 'data.csv'), csvLines.join('\n'));

  const mdLines = ['# Summary', '', '| variant | model | jd | n | mean_score | recommend_yes_rate |', '|---|---|---|---|---|---|'];
  for (const r of rows) {
    mdLines.push(`| ${r.variant} | ${r.model} | ${r.jd} | ${r.n} | ${r.mean_score?.toFixed(2) ?? ''} | ${r.recommend_yes_rate?.toFixed(2) ?? ''} |`);
  }
  await fs.writeFile(path.join(REPORT_DIR, 'summary.md'), mdLines.join('\n'));
}

async function main() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const records = await loadResults();
  enforce(records.length > 0, `No results found in ${RESULTS_DIR}. Run \`npm run run\` first.`);
  await writeSummary(records);
  console.log(`wrote ${REPORT_DIR}/summary.md and ${REPORT_DIR}/data.csv (${records.length} records)`);
}

main();
