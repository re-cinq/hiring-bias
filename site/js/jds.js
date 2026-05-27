import { mountChrome } from './nav.js';
import { header } from './lib.js';
import { drawWaves } from './waves.js';

await mountChrome();

document.getElementById('header').append(header('JOB DESCRIPTIONS'));

await drawWaves();
