import { mountChrome } from './nav.js';
import { loadJson, el, panel, table, header, fmtNum, fmtSignedDelta, modelLabel, modelVersion } from './lib.js';

await mountChrome();
document.getElementById('header').append(header('THE PAIRED GAPS'));

const index = await loadJson('data/placebo/index.json');
const lab = document.getElementById('lab');

const levelOf = (id) => index.levels.find((l) => l.id === id);
const jdLabel = (id) => index.jds.find((j) => j.id === id)?.label ?? id;
const pairOf = (id) => index.pairs.find((p) => p.id === id);

// The injected lines, verbatim. The whole experiment is these six strings.
function fieldsPanel() {
  const rows = index.pairs.map((pair) => [
    { text: pair.label },
    { text: levelOf(pair.a)?.line ?? '–' },
    { text: levelOf(pair.b)?.line ?? '–' }
  ]);

  return panel('THE THREE FIELDS',
    el('p', { class: 'dim' }, 'One line of job-irrelevant metadata, added to the top of the résumé in the form an applicant tracking system might attach. Each field carries two values; everything below is the score moving between them.'),
    table([{ label: 'field' }, { label: 'first value' }, { label: 'second value' }], rows));
}

function gapsPanel() {
  const rows = index.top_gaps.map((row) => {
    const pair = pairOf(row.pair);
    const open = el('a', {
      href: `placebo.html?model=${row.model}&jd=${row.jd}&compare=pair:${row.pair}`
    }, '[open]');

    return [
      { text: pair?.label ?? row.pair },
      { text: modelLabel(row.model), title: modelVersion(row.model) },
      { text: jdLabel(row.jd) },
      { num: true, text: fmtNum(row.a_mean, 2), title: levelOf(pair?.a)?.label },
      { num: true, text: fmtNum(row.b_mean, 2), title: levelOf(pair?.b)?.label },
      { num: true, text: fmtSignedDelta(row.gap, 2), cls: 'alert' },
      { text: open }
    ];
  });

  return panel('THE WIDEST PAIRED GAPS',
    el('p', { class: 'dim' }, 'Every model × job cell where the two values of one meaningless field pulled the score apart, widest first. The first mean belongs to the first value of the field (Tuesday, red, clear), the second to the other (Saturday, silver, rain); hover either figure for the exact variant.'),
    table([
      { label: 'field' }, { label: 'model' }, { label: 'job' },
      { label: 'first value', num: true }, { label: 'second value', num: true },
      { label: 'gap', num: true }, { label: '' }
    ], rows));
}

lab.append(el('div', {}, [fieldsPanel(), gapsPanel()]));
