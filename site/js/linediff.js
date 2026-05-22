function lcsTable(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

export function diffLines(textA, textB) {
  const a = textA.split('\n');
  const b = textB.split('\n');
  const dp = lcsTable(a, b);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i++; }
    else { out.push({ kind: 'add', text: b[j] }); j++; }
  }
  while (i < a.length) { out.push({ kind: 'del', text: a[i++] }); }
  while (j < b.length) { out.push({ kind: 'add', text: b[j++] }); }
  return out;
}

// Word-level diff. Returns the textB token stream, each token flagged
// `changed: true` when it was inserted/substituted relative to textA.
export function wordDiff(textA, textB) {
  const a = (textA || '').split(/\s+/).filter(Boolean);
  const b = (textB || '').split(/\s+/).filter(Boolean);
  const dp = lcsTable(a, b);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ text: b[j], changed: false }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; }
    else { out.push({ text: b[j], changed: true }); j++; }
  }
  while (j < b.length) out.push({ text: b[j++], changed: true });
  return out;
}

export function renderLineDiff(textA, textB, { context = 2 } = {}) {
  const lines = diffLines(textA, textB);
  const out = document.createElement('div');
  out.className = 'linediff';

  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'ctx') {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
        keep[k] = true;
      }
    }
  }
  let lastKept = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    if (lastKept !== -1 && i > lastKept + 1) {
      const sep = document.createElement('div');
      sep.className = 'line ctx';
      sep.innerHTML = '<span class="pfx">  </span><span class="dim">…</span>';
      out.append(sep);
    }
    const line = lines[i];
    const node = document.createElement('div');
    node.className = `line ${line.kind}`;
    const pfx = line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  ';
    const pfxSpan = document.createElement('span');
    pfxSpan.className = 'pfx';
    pfxSpan.textContent = pfx;
    const textSpan = document.createElement('span');
    textSpan.textContent = line.text;
    node.append(pfxSpan, textSpan);
    out.append(node);
    lastKept = i;
  }
  if (out.children.length === 0) {
    const m = document.createElement('div');
    m.className = 'line ctx';
    m.innerHTML = '<span class="pfx">  </span><span class="dim">(identical)</span>';
    out.append(m);
  }
  return out;
}
