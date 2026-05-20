# bias-research

LLM resume-screening bias study.

- [`PLAN.md`](PLAN.md) — operational build plan
- [`RESEARCH_NOTES.md`](RESEARCH_NOTES.md) — rationale and flows

## Quick start

```
cp .env.example .env       # fill in API keys
npm install
npm run smoke              # verify every provider is wired
npm run generate           # build variants from data/resume_base.md
npm run run                # execute the experiment
npm run report             # produce report/
```
