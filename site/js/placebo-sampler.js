import { loadJson, el, panel, table, params, setParam, fmtNum, fmtSignedDelta, copyLinkButton, modelLabel, modelVersion } from './lib.js';
import { diffLines, renderLineDiff } from './linediff.js';
import { verdictCard } from './verdict-card.js';

// Drill-down under the control's aggregate tables: pick one model × job × comparison and
// read the two verdicts the pooled number came from.
//
// The tables above are means over 833 cells. The claim they make — that an irrelevant value
// moves the score as far as a demographic one — is only checkable if a reader can open the
// cells and see two evaluations of the same candidate, one of whom owns a red car.

const BASELINE_TITLE = 'Baseline · the untouched résumé';

const cellCache = new Map();
async function loadCell(variant, model, jd) {
  const key = `${variant}__${model}__${jd}`;
  if (!cellCache.has(key)) {
    cellCache.set(key, await loadJson(`data/placebo/cells/${key}.json`).catch(() => null));
  }
  return cellCache.get(key);
}

const placeboVariant = (level) => `placebo_${level}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Every comparison the page offers, as one flat list: the three paired contrasts first,
// because that is the shape the headline ratio is built from, then each level against the
// untouched résumé.
function comparisons(index) {
  const label = (id) => index.levels.find((l) => l.id === id)?.label ?? id;
  return [
    ...index.pairs.map((pair) => ({
      value: `pair:${pair.id}`,
      label: `${pair.label} · ${label(pair.a)} vs ${label(pair.b)}`,
      left: placeboVariant(pair.a),
      right: placeboVariant(pair.b)
    })),
    ...index.levels.map((level) => ({
      value: `level:${level.id}`,
      label: `${level.label} vs the untouched résumé`,
      left: 'baseline',
      right: placeboVariant(level.id)
    }))
  ];
}

const variantTitle = (index, variant) => (variant === 'baseline'
  ? BASELINE_TITLE
  : index.levels.find((l) => placeboVariant(l.id) === variant)?.label ?? variant);

// ---- What differs between the two documents -------------------------------

// The same one-line caption the counterfactual diff page carries, with one case it does not
// have: the no-op edit changes only whitespace, so every changed line is blank and a caption
// that prints only non-empty lines would claim the documents are identical.
function changePanel(resumes, left, right) {
  const changed = diffLines(resumes[left] ?? '', resumes[right] ?? '').filter((line) => line.kind !== 'ctx');
  const withText = changed.filter((line) => line.text.trim());

  const box = el('div', { class: 'change-caption' });
  box.append(el('div', { class: 'change-head' }, [
    el('span', { class: 'dim' }, 'WHAT DIFFERS BETWEEN THE TWO DOCUMENTS'),
    el('a', { href: `resume-diff.html?from=${left}&to=${right}`, class: 'change-full' }, 'full résumé diff →')
  ]));

  if (!withText.length) {
    box.append(el('p', { class: 'dim' }, changed.length
      ? `${plural(changed.length, 'line')} differ and not one of them has any text on it. The two documents are the same résumé with the whitespace rearranged, so whatever the scores do below, they do for nothing.`
      : 'The two documents are byte-identical.'));
    return box;
  }

  const lines = el('div', { class: 'linediff' });
  for (const line of withText) {
    lines.append(el('div', { class: `line ${line.kind}` }, [
      el('span', { class: 'pfx' }, line.kind === 'add' ? '+ ' : '- '),
      el('span', {}, line.text.trim())
    ]));
  }
  box.append(lines);
  return box;
}

// ---- The two verdicts -----------------------------------------------------

// One rule for both lenses: do the two 95% intervals overlap. A paired comparison has no
// privileged side, so the site's usual "does the variant's interval exclude the baseline
// mean" test would have nothing to anchor on.
function intervalsDisjoint(a, b) {
  if ([a.ci_lo, a.ci_hi, b.ci_lo, b.ci_hi].some((v) => v == null)) return null;
  return a.ci_hi < b.ci_lo || b.ci_hi < a.ci_lo;
}

function interval(cell) {
  if (cell.ci_lo == null || cell.ci_hi == null) return 'interval undefined';
  return `95% CI ${fmtNum(cell.ci_lo, 2)} – ${fmtNum(cell.ci_hi, 2)}`;
}

function summaryPanel(left, right, leftTitle, rightTitle) {
  const gap = right.mean != null && left.mean != null ? right.mean - left.mean : null;
  const disjoint = intervalsDisjoint(left, right);

  return panel('THE GAP',
    el('div', { class: 'wobble-figure' }, [
      el('span', { class: Math.abs(gap ?? 0) >= 0.5 ? 'alert big' : 'accent big' }, fmtSignedDelta(gap, 2)),
      el('span', { class: 'dim' }, ` points out of 10, moving from ${leftTitle.toLowerCase()} to ${rightTitle.toLowerCase()}`)
    ]),
    el('div', { class: 'dim' }, [
      `${fmtNum(left.mean, 2)} (${interval(left)}) against ${fmtNum(right.mean, 2)} (${interval(right)}) · `,
      disjoint == null
        ? el('span', {}, 'not enough runs to place an interval')
        : el('span', { class: disjoint ? 'alert' : '' }, disjoint
          ? 'the two intervals are disjoint, so the runs separate cleanly'
          : 'the two intervals overlap, so this gap is inside the run-to-run wobble')
    ]));
}

function cardsPanel(left, right, leftTitle, rightTitle) {
  const host = el('div', { class: 'verdict-cards-host' });
  let leftRun = 0;
  let rightRun = 0;

  function draw() {
    host.innerHTML = '';
    const grid = el('div', { class: 'grid grid-2' });
    grid.append(verdictCard(leftTitle, left, leftRun, null, (i) => { leftRun = i; draw(); }));
    grid.append(verdictCard(rightTitle, right, rightRun, left.runs?.[leftRun]?.response ?? null, (i) => { rightRun = i; draw(); }));
    host.append(grid);
  }
  draw();

  return panel('THE TWO VERDICTS',
    el('p', { class: 'dim' }, 'The same candidate, evaluated twice. Words underlined in red on the right are what that side said differently from the run selected on the left. Click a dot to read another run.'),
    host);
}

// ---- Did the model notice? ------------------------------------------------

function mentionChips(cell, title) {
  return cell.mentions.flatMap((entry) => entry.hits.map((hit) => el('div', { class: 'chip' }, [
    el('div', { class: 'chip-path' }, `${title} · run ${entry.run} · "${hit.token}"`),
    el('div', {}, hit.snippet)
  ])));
}

function mentionsPanel(sides) {
  const scored = sides.filter((side) => side.cell.variant !== 'baseline' && side.cell.level !== 'noop-whitespace');
  if (!scored.length) {
    return panel('DID THE MODEL NOTICE?',
      el('p', { class: 'dim' }, 'Neither side of this comparison carries an added line, so there is nothing here a model could refer to.'));
  }

  const chips = scored.flatMap((side) => mentionChips(side.cell, side.title));
  const runs = scored.reduce((n, side) => n + side.cell.runs.length, 0);

  if (!chips.length) {
    return panel('DID THE MODEL NOTICE?',
      el('p', { class: 'accent' }, `No. Across all ${plural(runs, 'run')} that carried the added line, no evaluation refers to the vehicle, the day or the weather in any way, not in the justification, the strengths, the concerns or the key factors.`),
      el('p', { class: 'dim' }, 'Whatever moved the score above, the model never gave it as a reason. It could not. It never brought it up.'));
  }

  return panel('DID THE MODEL NOTICE?',
    el('p', { class: 'alert' }, `${plural(chips.length, 'passage')} across ${plural(runs, 'run')} refer to the added line.`),
    el('div', { class: 'chips' }, chips));
}

// ---- Run against run ------------------------------------------------------

const pretty = (response) => JSON.stringify(response, null, 2);

function runPicker(runs, selected, onPick) {
  return el('span', { class: 'runpick' }, runs.map(({ run }) => el('button', {
    class: run === selected ? 'sel' : '',
    onclick: () => onPick(run)
  }, String(run))));
}

// The same document, scored five times. On the no-op cell this is the entire finding: the
// only thing that changed between these two responses is that the model was asked twice.
function runDiffPanel(sides) {
  const usable = sides.filter((side) => side.cell.runs.length > 1);
  if (!usable.length) return null;

  let side = usable[0];
  let a = side.cell.runs[0].run;
  let b = side.cell.runs[1].run;

  const controls = el('div', { class: 'diff-controls' });
  const host = el('div');
  const responseOf = (run) => side.cell.runs.find((r) => r.run === run)?.response;

  function pickSide(next) {
    side = next;
    a = side.cell.runs[0].run;
    b = side.cell.runs[Math.min(1, side.cell.runs.length - 1)].run;
    draw();
  }

  function draw() {
    controls.innerHTML = '';
    if (usable.length > 1) {
      const sel = el('select', {
        onchange: (e) => pickSide(usable[Number(e.target.value)])
      }, usable.map((option, i) => el('option', { value: String(i) }, option.title)));
      sel.value = String(usable.indexOf(side));
      controls.append(el('label', {}, [el('span', { class: 'dim' }, 'Side:  '), sel]), el('span', {}, '  '));
    }
    controls.append(
      el('span', { class: 'dim' }, 'run '), runPicker(side.cell.runs, a, (run) => { a = run; draw(); }),
      el('span', { class: 'dim' }, '  against run '), runPicker(side.cell.runs, b, (run) => { b = run; draw(); }));
    host.innerHTML = '';
    host.append(renderLineDiff(pretty(responseOf(a)), pretty(responseOf(b)), { context: 2 }));
  }
  draw();

  return panel('RUN AGAINST RUN · one side, two repeats',
    el('p', { class: 'dim' }, 'Two responses to the identical document and the identical prompt, as they arrived. Nothing separates them but the request being sent twice, so everything red or green here is the instrument\'s own noise. That noise is the floor every number on this site is read against.'),
    controls, host);
}

// ---- Where to look --------------------------------------------------------

function gapsPanel(index, onPick) {
  const jdLabel = (id) => index.jds.find((j) => j.id === id)?.label ?? id;
  const open = (text, patch) => el('button', { onclick: () => onPick(patch) }, text);

  const noop = table(
    [{ label: 'model' }, { label: 'job' }, { label: 'Δ vs baseline', num: true }, { label: 'run spread', num: true }, { label: '' }],
    index.top_noop.slice(0, 8).map((row) => [
      { text: modelLabel(row.model), title: modelVersion(row.model) },
      { text: jdLabel(row.jd) },
      { num: true, text: fmtSignedDelta(row.delta, 2), cls: 'alert' },
      { num: true, text: String(row.spread) },
      { text: open('[open]', { model: row.model, jd: row.jd, compare: `level:${index.noop_level}` }) }
    ]));

  return panel('WHERE IT MOVED MOST',
    el('p', { class: 'dim' }, [
      'The figures above are means over every control cell. These are the individual no-op cells behind them, largest first: the widest moves produced by an edit that changed nothing but whitespace. The paired-field experiment has ',
      el('a', { href: 'paired-gaps.html' }, 'its own page'),
      ', listing the widest gaps one meaningless value opened.'
    ]),
    el('h4', {}, 'The widest no-op moves'),
    noop);
}

// ---- Assembly -------------------------------------------------------------

function selector(options, value, label, onChange) {
  const sel = el('select', { onchange: () => onChange(sel.value) });
  for (const option of options) sel.append(el('option', { value: option.value, title: option.title }, option.label));
  sel.value = value;
  return el('label', {}, [el('span', { class: 'dim' }, `${label}:  `), sel]);
}

export function sampler(index, resumes) {
  const host = el('div', { class: 'sampler' });
  const options = comparisons(index);
  const optionOf = (value) => options.find((o) => o.value === value);

  const initial = params();
  const state = {
    model: initial.get('model') ?? index.models[0],
    jd: initial.get('jd') ?? index.jds[0].id,
    compare: initial.get('compare') ?? options[0].value
  };
  // A stale or hand-typed URL must not leave the page empty.
  if (!index.models.includes(state.model)) state.model = index.models[0];
  if (!index.jds.some((j) => j.id === state.jd)) state.jd = index.jds[0].id;
  if (!optionOf(state.compare)) state.compare = options[0].value;

  const controls = panel(null);
  controls.append(el('div', { class: 'panel-head' }, [el('span', {}, 'OPEN ONE CELL'), copyLinkButton()]));
  controls.append(el('p', { class: 'dim' },
    'The tables above pool every control cell into one number per model. This opens one at a time. You get the two documents, the two verdicts, whether the model ever mentioned the thing that changed, and what two repeats of the same request look like side by side.'));

  const selectors = el('div', { class: 'controls-row' });
  controls.append(el('div', { class: 'controls-row' }, [selectors, el('button', { onclick: pickRandom }, '[random cell]')]));

  const body = el('div');
  host.append(controls, body, gapsPanel(index, change));

  function buildSelectors() {
    selectors.innerHTML = '';
    selectors.append(
      selector(index.models.map((m) => ({ value: m, label: modelLabel(m), title: modelVersion(m) })),
        state.model, 'Model', (value) => change({ model: value })),
      selector(index.jds.map((j) => ({ value: j.id, label: j.label })),
        state.jd, 'Job', (value) => change({ jd: value })),
      selector(options.map((o) => ({ value: o.value, label: o.label })),
        state.compare, 'Compare', (value) => change({ compare: value })));
  }

  function change(patch) {
    Object.assign(state, patch);
    for (const key of ['model', 'jd', 'compare']) setParam(key, state[key], { replace: true });
    buildSelectors();
    render();
    body.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function pickRandom() {
    const pick = (items) => items[Math.floor(Math.random() * items.length)];
    change({ model: pick(index.models), jd: pick(index.jds).id, compare: pick(options).value });
  }

  async function render() {
    const { model, jd, compare } = state;
    const option = optionOf(compare);
    body.innerHTML = '';
    body.append(el('p', { class: 'dim' }, 'Loading cell…'));

    const [left, right] = await Promise.all([loadCell(option.left, model, jd), loadCell(option.right, model, jd)]);
    // The reader may have moved on while the cells were in flight.
    if (state.model !== model || state.jd !== jd || state.compare !== compare) return;

    body.innerHTML = '';
    if (!left || !right) {
      body.append(panel('NO SUCH CELL', el('p', { class: 'dim' }, 'This model never ran this comparison on this job description.')));
      return;
    }

    const leftTitle = variantTitle(index, option.left);
    const rightTitle = variantTitle(index, option.right);
    const sides = [{ cell: left, title: leftTitle }, { cell: right, title: rightTitle }];

    body.append(el('div', {}, [
      panel(`${modelLabel(model)} · ${index.jds.find((j) => j.id === jd)?.label ?? jd}`,
        changePanel(resumes, option.left, option.right)),
      summaryPanel(left, right, leftTitle, rightTitle),
      cardsPanel(left, right, leftTitle, rightTitle),
      mentionsPanel(sides),
      runDiffPanel(sides)
    ]));
  }

  buildSelectors();
  render();
  return host;
}
