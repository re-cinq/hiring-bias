// Minimal markdown → HTML for the anonymised job descriptions: headings,
// bullet lists, and paragraphs. Shared by the static build (jds.html prerender)
// and the live diff page so both render JDs identically.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  let inPara = false;
  const closePara = () => { if (inPara) { out.push('</p>'); inPara = false; } };
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closePara(); closeList(); continue; }
    let m;
    if ((m = line.match(/^# (.+)$/))) { closePara(); closeList(); out.push(`<h2>${esc(m[1])}</h2>`); }
    else if ((m = line.match(/^## (.+)$/))) { closePara(); closeList(); out.push(`<h3>${esc(m[1])}</h3>`); }
    else if ((m = line.match(/^### (.+)$/))) { closePara(); closeList(); out.push(`<h4>${esc(m[1])}</h4>`); }
    else if ((m = line.match(/^[-*] (.+)$/))) {
      closePara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${esc(m[1])}</li>`);
    } else {
      closeList();
      if (!inPara) { out.push('<p>'); inPara = true; }
      else out.push(' ');
      out.push(esc(line));
    }
  }
  closePara();
  closeList();
  return out.join('');
}
