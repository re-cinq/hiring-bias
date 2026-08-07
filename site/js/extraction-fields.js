// Field paths as they come out of the metrics are schema addresses: employment[2].seniority_level.
// A reader who did not write the schema cannot tell whether that is a fact the model copied or a
// label it invented, or which job on the résumé it belongs to. This turns a path into three things
// the page can show instead: which section of the résumé it lives in, which entry inside that
// section, and what the field actually is in words.

const SECTION = {
  employment: { label: 'Jobs', noun: 'job', order: 1 },
  education: { label: 'Education', noun: 'degree', order: 2 },
  talks_and_workshops: { label: 'Talks and workshops', noun: 'talk', order: 3 },
  projects: { label: 'Projects', noun: 'project', order: 4 },
  languages: { label: 'Languages', noun: 'language', order: 5 },
  identity: { label: 'Name and contact details', order: 6 },
  concept_probes: { label: 'Yes/no skill judgements', order: 8 }
};
const WHOLE = { label: 'The résumé as a whole', order: 7 };

// Which key on an entry names it well enough for a reader to recognise the row.
const ENTRY_NAME = {
  employment: ['employer', 'title'],
  education: ['institution', 'degree_title'],
  talks_and_workshops: ['title', 'venue'],
  projects: ['name', 'url'],
  languages: ['language']
};

const FIELD_WORDS = {
  source_span: 'quote backing this entry',
  span: 'quote backing this claim',
  seniority_level: 'seniority',
  overall_seniority: 'seniority overall',
  employer: 'employer',
  employer_type: 'kind of employer',
  employment_type: 'kind of contract',
  functions: 'what the job involved',
  technologies: 'technologies named',
  impact_claims: 'impact claims',
  magnitude: 'how big the claim was',
  unit: 'what the claim was measured in',
  start: 'start date',
  end: 'end date',
  location: 'location',
  title: 'title',
  venue: 'venue',
  venue_type: 'kind of venue',
  presenter_role: 'role at the event',
  duration_days: 'length in days',
  year: 'year',
  urls: 'links',
  url: 'link',
  links: 'links',
  name: 'name',
  email: 'email',
  institution: 'institution',
  institution_type: 'kind of institution',
  degree_title: 'degree',
  level: 'level',
  field_category: 'field of study',
  completion_status: 'finished or not',
  role: 'role',
  proficiency: 'proficiency',
  language: 'language',
  domains: 'domains worked in',
  interests: 'interests',
  notable_signals: 'notable signals',
  community_engagement: 'community engagement',
  skills_declared: 'skills declared',
  certifications: 'certifications',
  publications: 'publications'
};

// Words for the same key when it carries an index, so impact_claims[1] reads "impact claim 2"
// rather than "impact claims 2".
const NUMBERED_WORDS = {
  impact_claims: 'impact claim',
  technologies: 'technology',
  domains: 'domain',
  links: 'link',
  urls: 'link'
};

// The identity keys are single words that say nothing on their own once the section header
// is out of view, as it is on the leakage cards.
const IDENTITY_WORDS = {
  name: 'the candidate’s name',
  email: 'email address',
  location: 'where the candidate lives',
  links: 'profile link'
};

const ACRONYMS = { ai: 'AI', ml: 'ML', llm: 'LLM', ci: 'CI', cd: 'CD', api: 'API' };

function humanize(key) {
  const words = key.split('_').map((word) => ACRONYMS[word] ?? word);
  return words.join(' ').replace(/^./, (c) => c.toUpperCase());
}

// "employment[2].impact_claims[1].span" → [{key:'employment',index:2}, …]
function parsePath(path) {
  const segments = [];
  for (const match of String(path).matchAll(/([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?/g)) {
    if (match[1]) segments.push({ key: match[1], index: match[2] == null ? null : Number(match[2]) });
  }
  return segments;
}

function segmentWords({ key, index }, words = FIELD_WORDS) {
  if (index == null) return words[key] ?? FIELD_WORDS[key] ?? humanize(key).toLowerCase();
  const word = NUMBERED_WORDS[key] ?? words[key] ?? FIELD_WORDS[key] ?? humanize(key).toLowerCase();
  return `${word} ${index + 1}`;
}

// The name the résumé itself gives the entry, e.g. the employer of employment[2].
function entryName(root, index, response) {
  const entry = response?.[root]?.[index];
  if (!entry) return null;
  for (const key of ENTRY_NAME[root] ?? []) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// Returns { section, order, entryKey, entry, field, raw }. `entry` is null for fields that
// belong to the whole document rather than to one listed item.
export function fieldLabel(path, response) {
  const segments = parsePath(path);
  const [root, ...rest] = segments;
  const raw = String(path);

  if (!root) return { section: WHOLE.label, order: WHOLE.order, entryKey: raw, entry: null, field: raw, raw };

  if (root.key === 'concept_probes') {
    return {
      section: SECTION.concept_probes.label,
      order: SECTION.concept_probes.order,
      entryKey: raw,
      entry: null,
      field: rest.length ? `does the résumé show ${humanize(rest[0].key).toLowerCase().replace(/^ai /, 'AI ')}?` : 'concept probes',
      raw
    };
  }

  const known = SECTION[root.key];
  if (!known || root.index == null) {
    // A top-level scalar or list: overall_seniority, domains, identity.name.
    const section = known ?? WHOLE;
    const words = root.key === 'identity' ? IDENTITY_WORDS : FIELD_WORDS;
    return {
      section: section.label,
      order: section.order,
      entryKey: root.key,
      entry: null,
      field: rest.length ? rest.map((part) => segmentWords(part, words)).join(' · ') : segmentWords(root),
      raw
    };
  }

  const name = entryName(root.key, root.index, response);
  const noun = known.noun ?? 'entry';
  const position = `${humanize(noun)} ${root.index + 1}`;
  return {
    section: known.label,
    order: known.order,
    itemNoun: noun,
    entryKey: `${root.key}[${root.index}]`,
    entry: name ? `${position} · ${name}` : position,
    field: rest.length ? rest.map(segmentWords).join(' · ') : 'the whole entry',
    raw
  };
}

// One line for the field, entry context dropped in behind it — for places with no room
// for two lines, such as the leakage cards.
export function fieldLine(path, response) {
  const { entry, field } = fieldLabel(path, response);
  return entry ? `${entry} — ${field}` : field;
}
