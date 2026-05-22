import { mountChrome } from './nav.js';
import { loadJson, el, header, fmtDate, fmtNum } from './lib.js';

await mountChrome();
document.getElementById('header').append(header('ABOUT', 'about this study'));

const status = await loadJson('data/status.json');
const page = document.getElementById('page');

const intro = el('div', { class: 'panel' });
intro.append(el('div', { class: 'panel-head' }, el('span', {}, 'WHY')));
intro.append(el('p', {}, 'LLMs are increasingly used to screen résumés. They are trained on data that contains real-world hiring bias. A counterfactual audit — change one thing and watch the verdict change — is the most direct test of whether that bias survived training.'));
intro.append(el('p', {}, 'This site is a live readout of that audit while data collection runs.'));
page.append(intro);

const ethics = el('div', { class: 'panel' });
ethics.append(el('div', { class: 'panel-head' }, el('span', {}, 'ETHICS')));
const ul = el('ul');
ul.append(el('li', {}, 'The baseline résumé is the author\'s. No third-party personal data is used.'));
ul.append(el('li', {}, 'Names are generic combinations from public sources, chosen to span ethnic and cultural backgrounds. None correspond to specific individuals.'));
ul.append(el('li', {}, 'Job descriptions are anonymised — company names removed, role titles abstracted.'));
ul.append(el('li', {}, 'The study does not claim any specific model is "biased" or "unbiased" overall. It reports per-cell deltas with confidence intervals.'));
ethics.append(ul);
page.append(ethics);

const cite = el('div', { class: 'panel' });
cite.append(el('div', { class: 'panel-head' }, el('span', {}, 'STATUS')));
cite.append(el('p', {}, [
  'Last update: ', el('strong', {}, fmtDate(status.generated_at)),
  ' · ',
  'Inferences collected: ', el('strong', {}, status.n_records.toLocaleString()),
  ' / ', status.expected_total_records.toLocaleString(),
  ' · ',
  'API spend: ', el('strong', {}, `$${fmtNum(status.total_cost_usd, 2)}`)
]));
page.append(cite);

const author = el('div', { class: 'panel' });
author.append(el('div', { class: 'panel-head' }, el('span', {}, 'AUTHOR')));
author.append(el('p', {}, 'Bogdan Szabo is a software engineer at re:cinq in Berlin, working full-stack and on AI-agent infrastructure — including MCP tooling for agentic workflows. Over 15+ years he has built across web, mobile, desktop and embedded systems, and founded GISCollective, an open-source geo-data platform. The baseline résumé audited in this study is his own.'));

const ext = (href, label) => el('a', { href, target: '_blank', rel: 'noopener' }, label);
const links = el('p', {}, [
  ext('https://szabobogdan.com/', 'szabobogdan.com'), ' · ',
  ext('https://re-cinq.com', 're:cinq'), ' · ',
  ext('https://github.com/gedaiu', 'GitHub'), ' · ',
  ext('https://www.linkedin.com/in/szabobogdan/', 'LinkedIn')
]);
author.append(links);
author.append(el('p', {}, ['Source, raw data and issues live on ', ext('https://github.com/gedaiu', 'GitHub'), '.']));
page.append(author);
