import { mountChrome } from './nav.js';
import { loadJson, header, el } from './lib.js';

await mountChrome();

const summary = await loadJson('data/summary.json').catch(() => null);
const subtitle = summary ? `${summary.jds.length} anonymised roles · click any row to read the full description` : 'anonymised roles · click any row to read the full description';
document.getElementById('header').append(header('JOB DESCRIPTIONS', subtitle));
