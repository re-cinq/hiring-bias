import fs from 'node:fs/promises';
import { normalizeExtraction } from '../src/extractionSchema.js';

export { probeGroundTruth } from '../src/extractionMetrics.js';

export async function normalizeExtractionSafe(path) {
  const record = JSON.parse(await fs.readFile(path, 'utf8'));
  return normalizeExtraction(record.response);
}
