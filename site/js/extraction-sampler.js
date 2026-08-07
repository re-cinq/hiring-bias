import { loadJson, el, params, setParam, fmtNum, copyLinkButton, modelLabel, modelVersion, variantLabel } from './lib.js';
import { renderLineDiff, diffSequence } from './linediff.js';
import { fieldLabel, fieldLine } from './extraction-fields.js';

// Drill-down under the aggregate tables: pick one model × arm × résumé variant and look
// at the parse the numbers came from. Cells are lazy-loaded, one file per combination.
//
// Two lenses, deliberately different. The mosaic is the canonical view: entries paired
// across runs, dates and technology names normalised, so a field that "moved" really
// moved. The diff below it is the raw response, array order and all, because that is
// what the model actually returned and reordering is itself a finding.

const TIER_LABEL = {
  0: { text: 'who the candidate is', title: 'Identity field. Not scored, shown because a swap moving it is worth seeing.' },
  1: { text: 'copied from the résumé', title: 'Tier 1. A fact the résumé states; the model only has to transcribe or classify it.' },
  2: { text: 'the model’s own judgement', title: 'Tier 2. A label the model chose; the résumé does not state it outright.' }
};

// Letters, not hues. Encoding which of several values a run picked as a colour would
// need a categorical palette, and this site's accent/warn pair fails CVD separation.
// So colour carries one bit — matches the majority, or deviates — and the letter says
// which value it was. Nothing here depends on colour alone.
const LETTERS = 'ABCDEFGH';

const cellCache = new Map();
async function loadCell(variant, model, arm) {
  const key = `${variant}__${model}__${arm}`;
  if (!cellCache.has(key)) {
    cellCache.set(key, await loadJson(`data/extraction/cells/${key}.json`).catch(() => null));
  }
  return cellCache.get(key);
}

// A path can be missing from a run entirely or come back as null; the parse is equally
// unusable either way, so both read as one thing.
const show = (value) => (value == null || value === '' ? '(no value)' : String(value));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function panel(title, ...children) {
  const box = el('div', { class: 'panel' });
  if (title) box.append(el('div', { class: 'panel-head' }, el('span', {}, title)));
  for (const child of children) if (child) box.append(child);
  return box;
}

// ---- The headline: how much of this parse held still ----------------------

function stabilityBar(moved, total) {
  const held = Math.max(total - moved, 0);
  const bar = el('div', { class: 'stability' });
  bar.append(el('div', { class: 'seg held', style: { flexGrow: String(held) }, title: `${held} fields identical in every run` }));
  if (moved) bar.append(el('div', { class: 'seg moved', style: { flexGrow: String(moved) }, title: `${moved} fields changed between runs` }));
  return bar;
}

function headline(cell, metrics, leak) {
  const moved = cell.unstable.total;
  const total = Math.max(cell.path_count, moved);
  const box = el('div', { class: 'wobble-head' });

  box.append(el('div', { class: 'wobble-figure' }, [
    el('span', { class: moved ? 'alert big' : 'accent big' }, String(moved)),
    el('span', { class: 'dim' }, ` of ${total} extracted fields moved across ${plural(cell.runs.length, 'run')} of the identical document`)
  ]));
  box.append(stabilityBar(moved, total));
  box.append(el('div', { class: 'legend' }, [
    el('span', {}, [el('span', { class: 'swatch held' }), ' held still']),
    el('span', {}, [el('span', { class: 'swatch moved' }), ' moved for no reason']),
    metrics ? el('span', { class: 'dim' }, `agreement ${fmtNum(metrics.agreement?.overall, 3)} · ordinal drift ${fmtNum(metrics.ordinal_drift, 2)} · grounded ${fmtNum(metrics.groundedness, 3)} · net leakage ${fmtNum(leak?.net, 2)}`) : null,
    leak && !leak.control_ok ? el('span', { class: 'alert' }, 'positive control failed, excluded from the pooled numbers') : null
  ]));
  return box;
}

// ---- The mosaic: one row per moving field, one mark per run ---------------

// Letters run in order of how often the value came back, so A is the majority reading
// and every deviation is a mark that breaks the pattern.
function letterValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return new Map(ranked.map(([value], index) => [value, LETTERS[index] ?? '·']));
}

const isQuotePath = (path) => /(\.source_span|\.span)$/.test(path);

// Set-valued fields arrive from the metrics as "{backend,fullstack}". Reading four of
// those stacked is a spot-the-difference puzzle, so they get pulled apart below.
const SET_VALUE = /^\{.*\}$/;
const setMembers = (value) => (value == null ? [] : String(value).slice(1, -1).split(',').filter(Boolean));
const isSetLike = (value) => value == null || value === '' || SET_VALUE.test(String(value));

// One column per member of the union, in the order the majority reading listed them, so
// every reading puts the same member in the same column and a gap is visible as a gap.
function setGrid(readings) {
  const order = [];
  for (const [value] of readings) {
    for (const member of setMembers(value)) if (!order.includes(member)) order.push(member);
  }
  const majority = new Set(setMembers(readings[0][0]));

  const grid = el('div', { class: 'setgrid', style: { gridTemplateColumns: `min-content repeat(${order.length}, max-content)` } });
  for (const [value, letter] of readings) {
    const members = new Set(setMembers(value));
    grid.append(el('span', { class: 'key' }, letter));
    for (const member of order) {
      if (!members.has(member)) {
        grid.append(el('span', { class: 'miss', title: `${member}: not in reading ${letter}` }, '·'.repeat(member.length)));
      } else {
        grid.append(el('span', { class: majority.has(member) ? '' : 'ins' }, member));
      }
    }
  }
  return grid;
}

// Prose values — quotes, titles — diffed against the majority reading word by word, so
// the one word that changed is the one thing coloured.
// Two strings that share almost nothing produce a diff of incidental word matches —
// "D ~~Simple Web Server~~ runtime" — which reads as noise. Below this much overlap the
// reading is simply a different answer, and is shown whole.
const MIN_OVERLAP = 0.3;

// A model that returns 2019 where the others returned "2019" moved the field, but both
// readings print the same characters, so the row has to say what the eye cannot see.
function typeWord(value) {
  if (value == null || value === '') return 'nothing';
  if (Array.isArray(value)) return 'a list';
  return { string: 'text', number: 'a number', boolean: 'true/false' }[typeof value] ?? 'an object';
}

function readingLine(letter, value, majority) {
  const line = el('span', { class: 'reading' }, el('span', { class: 'key' }, letter));
  const words = (text) => show(text).split(/\s+/).filter(Boolean);
  const mine = words(value);
  const theirs = words(majority);
  const whole = (cls) => line.append(' ', el('span', { class: cls }, show(value)));
  const note = (text) => line.append(' ', el('span', { class: 'dim note' }, text));

  if (value === majority) { whole(''); return line; }
  if (show(value) === show(majority)) {
    whole('ins');
    note(`— returned as ${typeWord(value)}, where the agreed reading is ${typeWord(majority)}`);
    return line;
  }
  if (mine.length < 2 || theirs.length < 2) { whole('ins'); return line; }

  const tokens = diffSequence(theirs, mine);
  const shared = tokens.filter((t) => t.kind === 'ctx').length;
  if (shared / Math.max(mine.length, theirs.length) < MIN_OVERLAP) { whole('ins'); return line; }

  for (const token of tokens) {
    line.append(' ', el('span', { class: token.kind === 'add' ? 'ins' : token.kind === 'del' ? 'del' : '' }, token.text));
  }
  // Two readings whose words all match differ only in spacing or line breaks. Nothing above
  // would have drawn a single mark, leaving the reader comparing two identical-looking lines.
  if (!tokens.some((token) => token.kind !== 'ctx')) note('— same words, different spacing or line breaks');
  return line;
}

function readingsBlock(letters) {
  const readings = [...letters.entries()];
  if (readings.every(([value]) => isSetLike(value)) && readings.some(([value]) => setMembers(value).length)) {
    return setGrid(readings);
  }
  const majority = readings[0][0];
  return el('div', { class: 'readings' }, readings.map(([value, letter]) => readingLine(letter, value, majority)));
}

// How loudly a field failed: four different readings across the runs is a worse failure
// than one run slipping once, and the reader should meet the loudest first.
const spread = (entry) => new Set(entry.values).size;

function mosaicRow(entry, runNumbers, repeatsEntry) {
  const letters = letterValues(entry.values);
  const marks = el('div', { class: 'marks' });
  entry.values.forEach((value, index) => {
    const letter = letters.get(value);
    marks.append(el('span', {
      class: `mark ${letter === 'A' ? 'held' : 'moved'}`,
      title: `run ${runNumbers[index]}: ${show(value)}`
    }, letter));
  });

  const tier = TIER_LABEL[entry.tier];
  return el('div', { class: 'mrow' }, [
    el('div', { class: 'path' }, [
      // The entry a field belongs to is printed once per run of rows, so a job with four
      // moving fields reads as one block rather than four repetitions of its name.
      entry.label.entry && !repeatsEntry ? el('span', { class: 'dim item' }, entry.label.entry) : null,
      el('span', { class: 'fld' }, entry.label.field),
      el('span', { class: 'dim tier', title: tier?.title }, tier?.text ?? entry.tier),
      entry.distance ? el('span', { class: 'alert tier' }, `${plural(entry.distance, 'rank')} apart`) : null,
      el('span', { class: 'dim raw' }, entry.label.raw)
    ]),
    marks,
    readingsBlock(letters)
  ]);
}

// Section (Jobs, Education, …) → the entries inside it → the fields that moved on each,
// every level ordered worst-first.
function groupSections(entries, response) {
  const sections = new Map();
  for (const entry of entries) {
    const label = fieldLabel(entry.path, response);
    if (!sections.has(label.section)) sections.set(label.section, { name: label.section, entries: new Map(), count: 0 });
    const section = sections.get(label.section);
    if (!section.entries.has(label.entryKey)) section.entries.set(label.entryKey, []);
    section.entries.get(label.entryKey).push({ ...entry, label });
    section.count += 1;
  }

  return [...sections.values()]
    .map((section) => ({
      name: section.name,
      count: section.count,
      itemNoun: [...section.entries.values()][0][0].label.itemNoun ?? 'item',
      items: [...section.entries.values()].filter((rows) => rows[0].label.entry).length,
      rows: [...section.entries.values()]
        .map((rows) => rows.sort((a, b) => spread(b) - spread(a) || a.label.field.localeCompare(b.label.field)))
        .sort((a, b) => spread(b[0]) - spread(a[0]) || a[0].label.entryKey.localeCompare(b[0].label.entryKey))
        .flat()
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function wobblePanel(cell) {
  if (cell.runs.length < 2) {
    return panel('WHERE THE PARSE WOBBLED', el('p', { class: 'dim' }, 'Only one run in this cell, so there is nothing to compare it against.'));
  }
  if (!cell.unstable.total) {
    return panel('WHERE THE PARSE WOBBLED',
      el('p', { class: 'accent' }, `Nothing wobbled. All ${cell.runs.length} runs returned the identical parse.`));
  }

  const runNumbers = cell.runs.map((r) => r.run);
  const response = cell.runs[0].response;
  const quotes = cell.unstable.shown.filter((entry) => isQuotePath(entry.path)).length;
  const hide = el('input', { type: 'checkbox' });
  const raw = el('input', { type: 'checkbox' });
  const rowHost = el('div', { class: 'mosaic' });
  // The worst models move hundreds of fields. Open on a few rows per section rather than
  // a wall, and say plainly how many are folded away and where.
  const FIRST_PAGE = 6;
  const opened = new Set();

  function draw() {
    rowHost.innerHTML = '';
    const shown = hide.checked ? cell.unstable.shown.filter((entry) => !isQuotePath(entry.path)) : cell.unstable.shown;
    rowHost.append(el('div', { class: 'mrow head' }, [
      el('div', { class: 'path dim' }, 'what moved'),
      el('div', { class: 'marks' }, runNumbers.map((n) => el('span', { class: 'runlabel' }, String(n)))),
      el('div', { class: 'readings dim' }, 'what came back')
    ]));

    for (const section of groupSections(shown, response)) {
      const limit = opened.has(section.name) ? Infinity : FIRST_PAGE;
      const across = section.items ? ` across ${plural(section.items, section.itemNoun)}` : '';
      rowHost.append(el('div', { class: 'msection' }, [
        el('span', { class: 'msection-name' }, section.name),
        el('span', { class: 'dim' }, ` ${plural(section.count, 'field')} moved${across}`)
      ]));

      const rows = el('div', { class: 'mrows' });
      let previousEntry = null;
      for (const entry of section.rows.slice(0, limit)) {
        rows.append(mosaicRow(entry, runNumbers, entry.label.entryKey === previousEntry));
        previousEntry = entry.label.entryKey;
      }
      rowHost.append(rows);
      if (section.rows.length > limit) {
        rowHost.append(el('button', { onclick: () => { opened.add(section.name); draw(); } },
          `[show the other ${section.rows.length - limit} in ${section.name.toLowerCase()}]`));
      }
    }
  }
  hide.addEventListener('change', () => { opened.clear(); draw(); });
  raw.addEventListener('change', () => rowHost.classList.toggle('show-raw', raw.checked));
  draw();

  return panel('WHERE THE PARSE WOBBLED',
    el('p', { class: 'dim' }, 'One row per field the repeat runs disagreed on, grouped by the part of the résumé it came from, worst first. One mark per run, numbered along the top: A is the reading the runs agreed on most often, and every other letter is a run that read the same résumé differently. (no value) means that run left the field out entirely.'),
    el('div', { class: 'legend' }, [
      el('span', {}, [el('span', { class: 'swatch majority' }), ' agreed with the majority reading']),
      el('span', {}, [el('span', { class: 'swatch moved' }), ' read it differently'])
    ]),
    el('div', { class: 'controls-row' }, [
      quotes ? el('label', { class: 'toggle' }, [hide, el('span', { class: 'dim' }, ` hide ${plural(quotes, 'quote field')}, where the model re-quoted the same line with different whitespace`)]) : null,
      el('label', { class: 'toggle' }, [raw, el('span', { class: 'dim' }, ' show the schema field names')])
    ]),
    rowHost,
    cell.unstable.total > cell.unstable.shown.length
      ? el('p', { class: 'dim' }, `${cell.unstable.total - cell.unstable.shown.length} further moving fields are not carried in this cell's data file.`)
      : null);
}

// ---- The diffs: raw response against raw response -------------------------

const pretty = (response) => JSON.stringify(response, null, 2);

function runPicker(runs, selected, onPick) {
  const row = el('span', { class: 'runpick' });
  for (const { run } of runs) {
    row.append(el('button', {
      class: run === selected ? 'sel' : '',
      onclick: () => onPick(run)
    }, String(run)));
  }
  return row;
}

function runDiffPanel(cell) {
  if (cell.runs.length < 2) return null;
  const runs = cell.runs;
  let a = runs[0].run;
  let b = runs[1].run;

  const controls = el('div', { class: 'diff-controls' });
  const diffHost = el('div');
  const responseOf = (run) => runs.find((r) => r.run === run)?.response;

  function draw() {
    controls.innerHTML = '';
    controls.append(
      el('span', { class: 'dim' }, 'run '), runPicker(runs, a, (run) => { a = run; draw(); }),
      el('span', { class: 'dim' }, '  against run '), runPicker(runs, b, (run) => { b = run; draw(); }));
    diffHost.innerHTML = '';
    diffHost.append(renderLineDiff(pretty(responseOf(a)), pretty(responseOf(b)), { context: 2 }));
  }
  draw();

  return panel('RUN AGAINST RUN · the raw responses',
    el('p', { class: 'dim' }, 'The two responses as they arrived, red for the left run and green for the right. Unlike the mosaic above this does not pair entries up first, so a model that returned the same roles in a different order shows that here as a block of moved lines.'),
    controls, diffHost);
}

// ---- What one demographic line did ----------------------------------------

// Set-valued fields arrive as "{backend,data}"; on a card there is room to read them as
// the list they are.
const showValue = (value) => (isSetLike(value) && setMembers(value).length ? setMembers(value).join(', ') : show(value));

function changeChips(diffs, response) {
  const list = el('div', { class: 'chips' });
  for (const diff of diffs) {
    list.append(el('div', { class: 'chip' }, [
      el('div', { class: 'chip-path', title: diff.path }, fieldLine(diff.path, response)),
      el('div', {}, [
        el('span', { class: 'was' }, showValue(diff.from)),
        el('span', { class: 'dim arrow' }, ' → '),
        el('span', { class: 'now' }, showValue(diff.to))
      ])
    ]));
  }
  return list;
}

function leakagePanel(cell, baselineCell) {
  if (!cell.vs_baseline) return null;
  const { leaked, allowed, honeypot } = cell.vs_baseline;
  const response = cell.runs[0].response;

  const box = panel('WHAT THE SWAP MOVED · baseline run 1 against this variant run 1',
    el('div', { class: 'wobble-figure' }, [
      el('span', { class: leaked.total ? 'alert big' : 'accent big' }, String(leaked.total)),
      el('span', { class: 'dim' }, ` field${leaked.total === 1 ? '' : 's'} moved that the edit had no business touching, alongside ${plural(allowed.total, 'field')} it was entitled to change`)
    ]));

  box.append(leaked.total
    ? changeChips(leaked.shown, response)
    : el('p', { class: 'accent' }, 'Nothing outside the edit moved on this pair.'));
  if (leaked.total > leaked.shown.length) box.append(el('p', { class: 'dim' }, `Showing the first ${leaked.shown.length} of ${leaked.total}.`));

  if (honeypot.length) {
    box.append(el('h4', {}, 'Honeypots · the prestige labels the edit should never reach'));
    box.append(changeChips(honeypot, response));
  }

  const details = el('details', { class: 'jd-collapse' });
  details.append(el('summary', {}, [el('span', { class: 'jd-caret' }, '▸'), el('span', {}, ` Allowed to move · ${plural(allowed.total, 'field')}`)]));
  if (allowed.total) details.append(changeChips(allowed.shown, response));
  box.append(details);

  if (baselineCell) {
    const diff = el('details', { class: 'jd-collapse' });
    diff.append(el('summary', {}, [el('span', { class: 'jd-caret' }, '▸'), el('span', {}, ' The two raw responses, line by line')]));
    diff.append(renderLineDiff(pretty(baselineCell.runs[0].response), pretty(cell.runs[0].response), { context: 2 }));
    box.append(diff);
  }
  return box;
}

function groundingPanel(cell) {
  const worst = [...cell.ungrounded_spans].sort((a, b) => b.spans.length - a.spans.length)[0];
  if (!worst?.spans.length) {
    return panel('QUOTES THAT ARE NOT IN THE DOCUMENT',
      el('p', { class: 'accent' }, 'Every quote in every run was found verbatim in the résumé.'));
  }
  return panel('QUOTES THAT ARE NOT IN THE DOCUMENT',
    el('p', { class: 'dim' }, `${plural(worst.spans.length, 'span')} in run ${worst.run}, its worst run, could not be matched back to the source text with whitespace ignored. The model is quoting something the document does not say.`),
    ...worst.spans.map((span) => el('pre', { class: 'alert' }, span)));
}

// ---- Assembly -------------------------------------------------------------

function selector(options, value, label) {
  const sel = el('select');
  for (const option of options) sel.append(el('option', { value: option.value, title: option.title }, option.label));
  sel.value = value;
  return { sel, node: el('label', {}, [el('span', { class: 'dim' }, `${label}:  `), sel]) };
}

export function sampler(summary, matrix, armLabel) {
  const host = el('div', { class: 'sampler' });
  const rowsByKey = new Map(summary.by_model_arm.map((row) => [`${row.model}__${row.arm}`, row]));
  const armsFor = (model) => summary.by_model_arm.filter((row) => row.model === model).map((row) => row.arm);
  const variantsFor = (model, arm) => (rowsByKey.get(`${model}__${arm}`)?.by_variant ?? [])
    .map((cell) => cell.variant)
    .sort((a, b) => (a === 'baseline' ? -1 : b === 'baseline' ? 1 : a.localeCompare(b)));

  const initial = params();
  const state = {
    model: initial.get('model') ?? summary.by_model_arm[0].model,
    arm: initial.get('arm') ?? summary.by_model_arm[0].arm,
    variant: initial.get('variant') ?? 'baseline'
  };
  // A stale or hand-typed URL must not leave the page empty.
  if (!armsFor(state.model).length) state.model = summary.by_model_arm[0].model;
  if (!armsFor(state.model).includes(state.arm)) state.arm = armsFor(state.model)[0];
  if (!variantsFor(state.model, state.arm).includes(state.variant)) state.variant = variantsFor(state.model, state.arm)[0];

  const controls = el('div', { class: 'panel' });
  controls.append(el('div', { class: 'panel-head' }, [el('span', {}, 'SAMPLE THE DATA'), copyLinkButton()]));
  controls.append(el('p', { class: 'dim' },
    'The tables above pool thousands of parses into one number per model. This reads one cell at a time: which fields moved between repeat runs of the same document, what each run actually said, and what a single demographic line changed.'));

  const selectors = el('div', { class: 'controls-row' });
  controls.append(el('div', { class: 'controls-row' },
    [selectors, el('button', { onclick: () => pickRandom() }, '[random cell]')]));

  const body = el('div');
  host.append(controls, body);

  function buildSelectors() {
    selectors.innerHTML = '';
    const models = [...new Set(summary.by_model_arm.map((r) => r.model))];
    const model = selector(models.map((m) => ({ value: m, label: modelLabel(m), title: modelVersion(m) })), state.model, 'Model');
    const arm = selector(armsFor(state.model).map((a) => ({ value: a, label: armLabel[a] ?? a })), state.arm, 'Arm');
    const variant = selector(variantsFor(state.model, state.arm).map((v) => ({ value: v, label: variantLabel(matrix, v) })), state.variant, 'Résumé');

    model.sel.addEventListener('change', () => change({ model: model.sel.value }));
    arm.sel.addEventListener('change', () => change({ arm: arm.sel.value }));
    variant.sel.addEventListener('change', () => change({ variant: variant.sel.value }));
    selectors.append(model.node, arm.node, variant.node);
  }

  function change(patch) {
    Object.assign(state, patch);
    if (!armsFor(state.model).includes(state.arm)) state.arm = armsFor(state.model)[0];
    if (!variantsFor(state.model, state.arm).includes(state.variant)) state.variant = variantsFor(state.model, state.arm)[0];
    for (const key of ['model', 'arm', 'variant']) setParam(key, state[key], { replace: true });
    buildSelectors();
    render();
  }

  function pickRandom() {
    const pick = (items) => items[Math.floor(Math.random() * items.length)];
    const target = pick(summary.by_model_arm);
    change({ model: target.model, arm: target.arm, variant: pick(variantsFor(target.model, target.arm)) });
  }

  async function render() {
    const { model, arm, variant } = state;
    body.innerHTML = '';
    body.append(el('p', { class: 'dim' }, 'Loading cell…'));

    const [cell, baselineCell] = await Promise.all([
      loadCell(variant, model, arm),
      variant === 'baseline' ? null : loadCell('baseline', model, arm)
    ]);
    // The reader may have moved on while the cell was in flight.
    if (state.model !== model || state.arm !== arm || state.variant !== variant) return;

    body.innerHTML = '';
    if (!cell) {
      body.append(panel('NO SUCH CELL', el('p', { class: 'dim' }, 'This model never ran this résumé variant in this arm.')));
      return;
    }

    const summaryRow = rowsByKey.get(`${model}__${arm}`);
    body.append(el('div', {}, [
      panel(`${modelLabel(model)} · ${armLabel[arm] ?? arm} · ${variantLabel(matrix, variant)}`,
        headline(cell,
          summaryRow?.by_variant.find((c) => c.variant === variant),
          summaryRow?.leakage.by_variant.find((l) => l.variant === variant))),
      wobblePanel(cell),
      leakagePanel(cell, baselineCell),
      runDiffPanel(cell),
      groundingPanel(cell)
    ]));
  }

  buildSelectors();
  render();
  return host;
}
