# hiring-bias

> `hiring://bias` — a counterfactual audit of bias in LLM résumé screening.

Large language models are increasingly used to read résumés and recommend who
to interview, usually wrapped behind a thin HR-tech product the candidate never
sees. This project measures whether that layer changes its verdict when **only a
demographic or contextual signal changes** and the skills and experience stay
exactly the same.

The method is counterfactual paired testing: start from one real baseline
résumé, generate variants that change **exactly one signal at a time**, hold
everything else constant, and measure how each model's score and recommendation
move. Any delta between a variant and the baseline is attributable to the single
signal that changed — the same logic as the classic Bertrand–Mullainathan audit
study, run against today's models.

Results are explorable as a static site under [`site/`](site/) — heatmaps,
counterfactual diffs, and per-job-description breakdowns.

## Current run

| | |
|---|---|
| Inferences collected | 9,012 |
| Models | 6, across 4 vendors |
| Job descriptions | 17 (junior → CTO) |
| Bias axes | 7 |
| API spend | ~$115 |

## The seven axes

Each axis changes one field a recruiter would actually see on a résumé:

- **First name** — gender and ethnicity signal (Western, Arabic, East Asian, African, Hispanic).
- **Graduation year** — age proxy.
- **Address country** — candidate location (e.g. USA vs. Nigeria, Romania, Brazil, India).
- **Career gap** — a two-year gap, with and without a "caregiving" label.
- **Company names** — FAANG vs. mid-tier vs. unknown vs. non-Western flagships.
- **Company locations** — where the work was done, independent of employer prestige.
- **School** — education prestige and geography (MIT, ETH, IIT, regional).

## The models

Six model slots across four vendors, mixing flagship and cheap tiers to separate
"vendor" effects from "tier" effects:

- **Anthropic** — Claude Opus
- **Google** — Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 3.1 Pro (preview)
- **Meta** — Llama 4 Maverick
- **Alibaba** — Qwen 3 Next 80B

Every cell uses one fixed scoring prompt at temperature 0.7, asking for a 1–10
score, a recommendation, a justification, strengths/concerns, and a structured
`key_factors` rubric. The fixed prompt is the experimental control. See
[`RESEARCH_NOTES.md`](RESEARCH_NOTES.md) for the full rationale.

## Quick start

Requires Node.js 20+.

```sh
cp .env.example .env       # fill in API keys (see below)
npm install
npm run smoke              # verify every provider is wired
npm run generate           # build variants from data/resume_base.md
npm run run                # execute the experiment (resumable)
npm run report             # produce report/data.csv and report/summary.md
npm run build:site         # regenerate site/data/ for the static site
```

Each call writes its own result file keyed by (variant, model, JD, run), so runs
are fully resumable — interrupt and re-run `npm run run` and it picks up where it
left off. Partial datasets can be reported and explored before a run completes.

Provider keys live in `.env` (`OPENAI_API_KEY`, `GROQ_API_KEY`,
`MISTRAL_API_KEY`, and either `GOOGLE_GENAI_API_KEY` for AI Studio or
`GOOGLE_CLOUD_PROJECT` for Vertex). Only configure the providers you intend to
run.

## Repository layout

```
src/            experiment engine (generate → run → aggregate → report)
src/providers/  one adapter per model vendor
data/           baseline résumé, job descriptions, generated variants
results/        raw per-inference model outputs (JSON)
report/         aggregated data.csv and summary.md
scripts/        buildSiteData.js — turns results into site data
site/           static results explorer (heatmaps, diffs, per-JD pages)
```

See [`PLAN.md`](PLAN.md) for the operational build plan and
[`RESEARCH_NOTES.md`](RESEARCH_NOTES.md) for the design reasoning behind every
choice.

## Limitations

A single base résumé cannot represent all candidates, and the one-variable-at-a-time
design cannot detect interaction effects (an unfamiliar name *and* an unfamiliar
school together). Models change over time, so results are tied to the versions
listed above. The study reports per-cell deltas with confidence intervals — it
does not label any model "biased" or "unbiased" overall.

## License

- **Code** — [MIT](LICENSE)
- **Data** — [Creative Commons Attribution 4.0 (CC BY 4.0)](DATA-LICENSE)

## Author

Built by **Bogdan Szabo**, software engineer at [re:cinq](https://re-cinq.com).
The baseline résumé audited here is the author's own.

- Website: [szabobogdan.com](https://szabobogdan.com/)
- GitHub: [@gedaiu](https://github.com/gedaiu)
- LinkedIn: [in/szabobogdan](https://www.linkedin.com/in/szabobogdan/)

If you use this work, please cite: *Hiring-Bias — Bogdan Szabo (re:cinq), 2026.*
