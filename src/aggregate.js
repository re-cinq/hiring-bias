import fs from 'node:fs/promises';
import path from 'node:path';

export function enforce(cond, msg) {
  if (!cond) throw new Error(msg);
}

export async function loadResults(dir = 'results') {
  const files = await fs.readdir(dir);
  const records = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    records.push(JSON.parse(raw));
  }
  return records;
}

export function groupBy(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

export function mean(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function stdev(nums) {
  if (nums.length < 2) return null;
  const m = mean(nums);
  const sq = nums.reduce((s, x) => s + (x - m) ** 2, 0);
  return Math.sqrt(sq / (nums.length - 1));
}

export function recommendRate(records) {
  if (records.length === 0) return null;
  const yes = records.filter((r) => r.response?.recommend_interview === 'yes').length;
  return yes / records.length;
}

const T_CRIT_95 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228 };

export function tInterval95(nums) {
  if (nums.length < 2) return null;
  const m = mean(nums);
  const s = stdev(nums);
  const df = nums.length - 1;
  const t = T_CRIT_95[df] ?? 1.96;
  const margin = t * s / Math.sqrt(nums.length);
  return { lo: m - margin, hi: m + margin, mean: m, stdev: s };
}
