// The Extraction Lab schema. The model is asked for structure and classification only:
// which lines form an entry, what belongs together, and which closed-vocabulary label
// applies. Every ordinal rank, every aggregate and every literal-presence check is done
// in code, so the model is never asked for something a function can answer.

// Ordered vocabularies are ranked by array index. Changing the order changes the
// ordinal distances, so treat these arrays as versioned data, not as a list to tidy.
export const VOCAB = {
  seniority_level: ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'director', 'vp', 'c_level'],
  employment_type: ['employee', 'founder', 'freelance', 'contractor', 'volunteer'],
  functions: ['frontend', 'backend', 'fullstack', 'mobile', 'embedded', 'devops', 'data', 'ml_ai', 'qa', 'security', 'design', 'management', 'other'],
  employer_type: ['bigtech', 'enterprise', 'startup', 'agency', 'nonprofit', 'academic', 'government', 'unknown'],
  education_level: ['secondary', 'vocational', 'bachelor', 'master', 'doctorate'],
  field_category: ['computer_science', 'software_engineering', 'electrical_engineering', 'mathematics', 'natural_sciences', 'arts_design', 'business', 'other'],
  completion_status: ['completed', 'in_progress', 'incomplete', 'unknown'],
  institution_type: ['university', 'technical_institute', 'college', 'bootcamp', 'unknown'],
  language_proficiency: ['basic', 'conversational', 'professional', 'fluent', 'native'],
  venue_type: ['conference', 'meetup', 'workshop', 'course', 'internal', 'unknown'],
  presenter_role: ['speaker', 'instructor', 'organizer', 'panelist', 'unknown'],
  project_role: ['author', 'maintainer', 'contributor', 'unknown'],
  magnitude: ['tens', 'hundreds', 'thousands', 'millions', 'billions'],
  impact_unit: ['users', 'requests_per_second', 'items_processed', 'revenue', 'team_size', 'rank', 'percent_improvement', 'other'],
  domains: ['geospatial', 'fintech', 'healthtech', 'ecommerce', 'adtech', 'devtools', 'infrastructure', 'gaming', 'media', 'education', 'government', 'nonprofit', 'industrial_iot', 'security', 'ml_ai', 'other'],
  interests: ['open_source', 'teaching', 'public_speaking', 'mentoring', 'community_organizing', 'research', 'writing', 'other'],
  notable_signals: ['founder', 'oss_maintainer', 'conference_speaker', 'published_author', 'award', 'patent', 'career_gap', 'career_change', 'international_experience', 'other'],
  community_engagement: ['none', 'occasional', 'active', 'leader']
};

export const ORDINAL_VOCABS = new Set([
  'seniority_level', 'education_level', 'language_proficiency', 'magnitude', 'community_engagement'
]);

// Field path (arrays collapsed to `[]`) → vocabulary name. Drives both enum validation
// and ordinal-distance scoring.
export const FIELD_VOCAB = {
  'employment[].seniority_level': 'seniority_level',
  'employment[].employment_type': 'employment_type',
  'employment[].functions[]': 'functions',
  'employment[].employer_type': 'employer_type',
  'employment[].impact_claims[].magnitude': 'magnitude',
  'employment[].impact_claims[].unit': 'impact_unit',
  'education[].level': 'education_level',
  'education[].field_category': 'field_category',
  'education[].completion_status': 'completion_status',
  'education[].institution_type': 'institution_type',
  'languages[].proficiency': 'language_proficiency',
  'talks_and_workshops[].venue_type': 'venue_type',
  'talks_and_workshops[].presenter_role': 'presenter_role',
  'projects[].role': 'project_role',
  'domains[]': 'domains',
  'interests[]': 'interests',
  'notable_signals[]': 'notable_signals',
  'community_engagement': 'community_engagement',
  'overall_seniority': 'seniority_level'
};

// Tier 0 is the identity control, tier 2 is everything the model had to judge rather
// than read. Named FIELD_TIERS because result records already use `tier` for the
// model's flagship/cheap tier.
const TIER_2_PATHS = new Set([
  'concept_probes', 'domains[]', 'interests[]', 'notable_signals[]',
  'overall_seniority', 'community_engagement',
  'employment[].employer_type', 'education[].institution_type'
]);

export function fieldTier(path) {
  const shape = path.replace(/\[\d+\]/g, '[]');
  if (shape.startsWith('identity')) return 0;
  for (const tier2 of TIER_2_PATHS) {
    if (shape === tier2 || shape.startsWith(`${tier2}.`)) return 2;
  }
  return 1;
}

export const FIELD_TIERS = { fieldTier, TIER_2_PATHS };

// Surface form → canonical technology id. The model emits whatever the résumé says;
// this map does the vocabulary enforcement so the mapping stays reviewable in code.
export const TECH_ALIASES = new Map(Object.entries({
  'node': 'nodejs', 'node.js': 'nodejs', 'nodejs': 'nodejs',
  'js': 'javascript', 'javascript': 'javascript',
  'ts': 'typescript', 'typescript': 'typescript',
  'd': 'dlang', 'dlang': 'dlang', 'd programming language': 'dlang',
  'ember': 'ember', 'ember.js': 'ember', 'emberjs': 'ember',
  'react': 'react', 'react.js': 'react',
  'postgres': 'postgresql', 'postgresql': 'postgresql',
  'mongo': 'mongodb', 'mongodb': 'mongodb',
  'k8s': 'kubernetes', 'kubernetes': 'kubernetes',
  'aws': 'aws', 'aws cdk': 'aws', 'amazon web services': 'aws',
  'gcp': 'gcp', 'google cloud': 'gcp',
  'c++': 'cpp', 'cpp': 'cpp',
  'c#': 'csharp', 'csharp': 'csharp',
  'graphql': 'graphql', 'docker': 'docker', 'git': 'git', 'linux': 'linux',
  'mysql': 'mysql', 'sql': 'sql', 'php': 'php', 'java': 'java', 'swift': 'swift',
  'python': 'python', 'kotlin': 'kotlin', 'jest': 'jest', 'vitest': 'vitest',
  'playwright': 'playwright', 'nest.js': 'nestjs', 'nestjs': 'nestjs',
  'wordpress': 'wordpress', 'drupal': 'drupal', 'joomla': 'joomla', 'html': 'html', 'css': 'css'
}));

export function canonicalTech(name) {
  const key = String(name ?? '').trim().toLowerCase();
  return TECH_ALIASES.get(key) ?? null;
}

// Ground-truth probes, drawn from the stack requirements across data/jds/. Frozen on
// purpose: deriving this from the JDs at runtime would let it drift between runs and
// silently invalidate cross-run comparisons. Patterns are explicit because word
// boundaries alone get `java` vs `javascript` and `git` vs `gitlab` wrong.
export const PROBES = [
  { id: 'typescript', pattern: /typescript/i },
  { id: 'javascript', pattern: /javascript/i },
  { id: 'nodejs', pattern: /\bnode(\.js)?\b/i },
  { id: 'react', pattern: /\breact\b/i },
  { id: 'ember', pattern: /\bember(\.js)?\b/i },
  { id: 'nestjs', pattern: /\bnest\.?js\b/i },
  { id: 'graphql', pattern: /graphql/i },
  { id: 'kotlin', pattern: /\bkotlin\b/i },
  { id: 'java', pattern: /\bjava\b/i },
  { id: 'python', pattern: /\bpython\b/i },
  { id: 'php', pattern: /\bphp\b/i },
  { id: 'swift', pattern: /\bswift\b/i },
  { id: 'csharp', pattern: /C#/ },
  { id: 'cpp', pattern: /C\+\+/ },
  { id: 'dlang', pattern: /\bdlang\b/i },
  { id: 'postgresql', pattern: /\bpostgre(s|sql)\b/i },
  { id: 'mongodb', pattern: /\bmongodb\b/i },
  { id: 'mysql', pattern: /\bmysql\b/i },
  { id: 'sql', pattern: /\bsql\b/i },
  { id: 'aws', pattern: /\baws\b/i },
  { id: 'gcp', pattern: /\b(gcp|google cloud)\b/i },
  { id: 'azure', pattern: /\bazure\b/i },
  { id: 'docker', pattern: /\bdocker\b/i },
  { id: 'kubernetes', pattern: /\b(kubernetes|k8s)\b/i },
  { id: 'git', pattern: /\bgit\b/i },
  { id: 'jest', pattern: /\bjest\b/i },
  { id: 'vitest', pattern: /\bvitest\b/i },
  { id: 'playwright', pattern: /\bplaywright\b/i },
  { id: 'linux', pattern: /\blinux\b/i }
];

// Some models read the prompt's section headings as schema and nest the whole answer
// under them. The content is correct, only the shape is wrong, so flatten it rather than
// scoring the model as having extracted nothing.
const WRAPPER_KEYS = ['transcribed_fields', 'classified_fields', 'judgement_fields', 'judgment_fields'];

export function normalizeExtraction(data) {
  if (data == null || typeof data !== 'object') return data;
  const wrappers = WRAPPER_KEYS.filter((key) => data[key] && typeof data[key] === 'object');
  if (!wrappers.length) return data;
  const flat = { ...data };
  for (const key of wrappers) {
    Object.assign(flat, data[key]);
    delete flat[key];
  }
  return flat;
}

const list = (name) => VOCAB[name].join(' | ');

// Built from VOCAB so the prompt and the validator can never disagree about what the
// legal values are.
export const EXTRACTION_PROMPT = `You are parsing a résumé into structured data. You are NOT evaluating the candidate, and you will not be told what role this is for.

Output ONE flat JSON object with exactly these top-level keys, and no others:

identity, employment, education, talks_and_workshops, projects, languages, skills_declared, certifications, publications, concept_probes, domains, interests, notable_signals, overall_seniority, community_engagement

The headings below group the fields by how you should answer them. They are guidance only — do NOT nest the output under them.

TRANSCRIBED FIELDS — copy what the document says. If the document does not state it, use null or an empty array. Never infer, estimate, summarise, or compute totals.

- identity: { name, headline_title, location, email, links: [string] }
- employment: array, one object per role, in the order they appear:
  - employer, title, location: strings exactly as written
  - start, end: "YYYY-MM". Use null for end when the role is ongoing.
  - technologies: array of { name, span } for every technology named in THIS role's text. span must be the full verbatim clause or sentence containing that technology, not the bare term on its own.
  - impact_claims: array of { magnitude, unit, span } for quantified results stated in THIS role's text. span must be the full verbatim clause or sentence stating the quantity.
  - source_span: the verbatim heading line for this role.
- education: array of { institution, degree_title, start, end, source_span }
- talks_and_workshops: array of { title, venue, year, duration_days, urls, source_span }
- projects: array of { name, url, source_span }
- languages: array of { language }
- skills_declared: array of strings, copied from the résumé's skills section only
- certifications: array of strings
- publications: array of strings

CLASSIFIED FIELDS — pick exactly one value from the list given. Use the closest match; never invent a value outside the list.

- employment[].seniority_level: ${list('seniority_level')}
- employment[].employment_type: ${list('employment_type')}
- employment[].functions: array, one or more of: ${list('functions')}
- employment[].impact_claims[].magnitude: ${list('magnitude')}
- employment[].impact_claims[].unit: ${list('impact_unit')}
- education[].level: ${list('education_level')}
- education[].field_category: ${list('field_category')}
- education[].completion_status: ${list('completion_status')}
- languages[].proficiency: ${list('language_proficiency')}
- talks_and_workshops[].venue_type: ${list('venue_type')}
- talks_and_workshops[].presenter_role: ${list('presenter_role')}
- projects[].role: ${list('project_role')}

JUDGEMENT FIELDS — these are your opinion, not transcription. Answer them anyway, from the same closed lists.

- employment[].employer_type: ${list('employer_type')}
- education[].institution_type: ${list('institution_type')}
- concept_probes: object mapping each of microservices, test_driven_development, ai_agent_development, cloud_infrastructure, distributed_systems, technical_leadership to true or false, based on whether the résumé demonstrates it
- domains: array, from: ${list('domains')}
- interests: array, from: ${list('interests')}
- notable_signals: array, from: ${list('notable_signals')}
- overall_seniority: ${list('seniority_level')}
- community_engagement: ${list('community_engagement')}

Respond with only the JSON object. No prose before or after.

Resume:
<RESUME>`;
