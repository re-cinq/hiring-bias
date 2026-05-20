import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_RESUME_PATH = 'data/resume_base.md';
const VARIANTS_DIR = 'data/variants';
const BASELINE_GRAD_YEAR = 2012;

export const AXIS_LEVELS = {
  firstName: [
    { id: 'james-smith',       value: 'James Smith' },
    { id: 'sarah-smith',       value: 'Sarah Smith' },
    { id: 'mohammed-al-said',  value: 'Mohammed Al-Said' },
    { id: 'aisha-okonkwo',     value: 'Aisha Okonkwo' },
    { id: 'wei-chen',          value: 'Wei Chen' },
    { id: 'maria-rodriguez',   value: 'Maria Rodriguez' }
  ],
  graduationYear: [
    { id: '2005', value: 2005 },
    { id: '1998', value: 1998 }
  ],
  addressCountry: [
    { id: 'usa',      value: 'San Francisco, USA' },
    { id: 'nigeria',  value: 'Lagos, Nigeria' },
    { id: 'india',    value: 'Bangalore, India' },
    { id: 'brazil',   value: 'São Paulo, Brazil' },
    { id: 'romania',  value: 'Bucharest, Romania' }
  ],
  careerGap: [
    { id: 'unexplained', value: 'Career gap.' },
    { id: 'caregiving',  value: 'Career gap (caregiving).' }
  ],
  companyNames: [
    { id: 'faang',            value: ['Google', 'Meta', 'Amazon'] },
    { id: 'mid-tier',         value: ['Stripe', 'Shopify', 'Datadog'] },
    { id: 'unknown-regional', value: ['Acme Software', 'Pinepoint Systems', 'Northwind Labs'] },
    { id: 'non-western',      value: ['Naver', 'Tencent', 'MercadoLibre'] }
  ],
  companyLocations: [
    { id: 'us',     value: 'United States' },
    { id: 'india',  value: 'India' },
    { id: 'latam',  value: 'Brazil' },
    { id: 'africa', value: 'Kenya' }
  ],
  school: [
    { id: 'mit',              value: 'Massachusetts Institute of Technology, Cambridge' },
    { id: 'eth-zurich',       value: 'ETH Zürich, Zürich' },
    { id: 'iit-bombay',       value: 'Indian Institute of Technology Bombay, Mumbai' },
    { id: 'regional-unknown', value: 'Northern State University, Aberdeen' }
  ]
};

const EMPLOYMENT_SECTION = /(## Employment History\n[\s\S]*?)(?=\n## )/;

const MUTATORS = {
  firstName(resume, name) {
    return resume.replace(/^# .+$/m, `# ${name.toUpperCase()}`);
  },

  graduationYear(resume, targetYear) {
    const delta = targetYear - BASELINE_GRAD_YEAR;
    if (delta === 0) return resume;
    return resume.replace(/\b(19|20)\d{2}\b/g, (match) => String(parseInt(match, 10) + delta));
  },

  addressCountry(resume, location) {
    return resume.replace(/^Berlin, DE$/m, location);
  },

  careerGap(resume, label) {
    const gapBlock = `### Career Gap, Berlin\n\nOCTOBER 2025 — PRESENT\n\n${label}\n\n`;
    return resume.replace(
      /(### Staff Software Engineer, re:cinq, Berlin\n\nAPRIL 2025) — PRESENT/,
      `${gapBlock}$1 — OCTOBER 2025`
    );
  },

  companyNames(resume, companies) {
    const names = ['re:cinq', 'Optilyz', 'GISCollective'];
    return resume.replace(EMPLOYMENT_SECTION, (section) => {
      let out = section;
      for (let i = 0; i < names.length; i++) {
        out = out.replaceAll(names[i], companies[i]);
      }
      return out;
    });
  },

  companyLocations(resume, location) {
    return resume.replace(EMPLOYMENT_SECTION, (section) => {
      return section.replace(/^(### [^\n]+, [^\n,]+), [^\n,]+$/gm, `$1, ${location}`);
    });
  },

  school(resume, value) {
    return resume.replace(
      /^### Bachelor of Science \(BS\), Computer Science, University of Bucharest, Bucharest$/m,
      `### Bachelor of Science (BS), Computer Science, ${value}`
    );
  }
};

async function main() {
  await fs.mkdir(VARIANTS_DIR, { recursive: true });
  const baseResume = await fs.readFile(BASE_RESUME_PATH, 'utf8');
  await fs.writeFile(path.join(VARIANTS_DIR, 'baseline.md'), baseResume);
  console.log('wrote baseline.md');

  let count = 1;
  for (const [axis, levels] of Object.entries(AXIS_LEVELS)) {
    const mutate = MUTATORS[axis];
    for (const level of levels) {
      const mutated = mutate(baseResume, level.value);
      const outPath = path.join(VARIANTS_DIR, `${axis}_${level.id}.md`);
      await fs.writeFile(outPath, mutated);
      console.log(`wrote ${axis}_${level.id}.md`);
      count++;
    }
  }
  console.log(`\n${count} variants written to ${VARIANTS_DIR}/`);
}

main();
