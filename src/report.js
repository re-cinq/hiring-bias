import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { costFor } from './pricing.js';
import { enforce, loadResults, groupBy, mean, recommendRate } from './aggregate.js';

const RESULTS_DIR = 'results';
const REPORT_DIR = 'report';

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

  const costRows = [];
  let totalIn = 0, totalOut = 0, totalCost = 0;
  for (const [model, group] of groupBy(records, (r) => r.model)) {
    const inT = group.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0);
    const outT = group.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0);
    const cost = group.reduce((s, r) => s + costFor(r.model, r.usage), 0);
    costRows.push({ model, calls: group.length, inT, outT, cost });
    totalIn += inT;
    totalOut += outT;
    totalCost += cost;
  }
  costRows.sort((a, b) => b.cost - a.cost);

  mdLines.push('', '## Cost Breakdown (tokens × published rates)', '');
  mdLines.push('| model | calls | input tokens | output tokens | cost (USD) |');
  mdLines.push('|---|---|---|---|---|');
  for (const r of costRows) {
    mdLines.push(`| ${r.model} | ${r.calls} | ${r.inT.toLocaleString()} | ${r.outT.toLocaleString()} | $${r.cost.toFixed(4)} |`);
  }
  mdLines.push(`| **TOTAL** | ${records.length} | ${totalIn.toLocaleString()} | ${totalOut.toLocaleString()} | **$${totalCost.toFixed(4)}** |`);

  await fs.writeFile(path.join(REPORT_DIR, 'summary.md'), mdLines.join('\n'));
}

async function main() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const records = await loadResults(RESULTS_DIR);
  enforce(records.length > 0, `No results found in ${RESULTS_DIR}. Run \`npm run run\` first.`);
  await writeSummary(records);
  console.log(`wrote ${REPORT_DIR}/summary.md and ${REPORT_DIR}/data.csv (${records.length} records)`);
}

main();
