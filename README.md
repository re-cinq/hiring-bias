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
signal that changed — the same logic as the classic [Bertrand–Mullainathan audit
study](https://www.nber.org/papers/w9873), run against today's models.

The audit is complemented by two follow-up experiments — a **reasoning
transplant** (does the score follow the model's written reasoning?) and a
**prompt lab** (can prompt engineering stabilise the score?) — and a synthesis
that joins all three on their shared unit, the model.

Results are explorable as a static site under [`site/`](site/) — heatmaps,
counterfactual diffs, per-job-description breakdowns, and one page per
follow-up experiment, with the synthesis prerendered onto the homepage.

## Current run

| | |
|---|---|
| Inferences collected | 28,050 |
| Models | 11, across 5 vendors |
| Job descriptions | 17 (junior to CTO) |
| Bias axes | 8 (7 injection, 1 redaction) |
| Audit verdicts | 5,393 (one per variant cell, two samples judged per cell) |
| Follow-up experiments | reasoning transplant (3,197 records) and prompt lab (4,800 records), 10 models each |
| API spend | ~$835 plus the audit pass |

## The eight axes

Seven inject one demographic or contextual signal and ask whether the verdict
moves. The eighth is the inverse: it **removes** identity and prestige signals
(a blind résumé) and asks whether the verdict moves the other way. The two arms
together test "does this signal bias the model" and "does hiding the signal
mitigate it" on the same résumé.

Injection axes:

- **First name** — gender and ethnicity signal (Western, Arabic, East Asian, African, Hispanic).
- **Graduation year** — age proxy.
- **Address country** — candidate location (USA, Nigeria, Romania, Brazil, India).
- **Career gap** — a two-year gap, with and without a "caregiving" label.
- **Company names** — FAANG vs. mid-tier vs. unknown vs. non-Western flagships.
- **Company locations** — where the work was done, independent of employer prestige.
- **School** — education prestige and geography (MIT, ETH, IIT, regional unknown).

Redaction (mitigation) axis:

- **Anonymize** — `anonymize_name` blinds identity (name, contact, personal links); `anonymize_all` additionally blinds employers, schools, locations and dates.

## The models

Eleven model slots across five vendors, mixing flagship and cheap tiers to
separate "vendor" effects from "tier" effects:

- **Anthropic** — Claude Fable 5, Claude Opus, Claude Sonnet, Claude Haiku
- **Google** — Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 3.1 Pro (preview)
- **Meta** — Llama 4 Maverick (via Vertex AI)
- **Alibaba** — Qwen 3 Next 80B (via Vertex AI)
- **Mistral** — Mistral Large, Mistral Small

Every cell uses one fixed scoring prompt at temperature 0.7 (where the provider
exposes temperature), asking for a 1 to 10 score, a recommendation, a
justification, strengths and concerns, and a structured `key_factors` rubric.
The fixed prompt is the experimental control. The Claude models are invoked
through the Claude CLI rather than the Anthropic API, so they run at the CLI's
default sampling, not at temperature 0.7. Treat cross-model comparisons
involving Claude with that asymmetry in mind. See
[`RESEARCH_NOTES.md`](RESEARCH_NOTES.md) for the full rationale.

Claude Fable 5 appears in the counterfactual audit only; the transplant and
prompt-lab experiments cover the other ten models.

## The audit layer

Each (variant, model, JD) cell with 5 collected runs is judged by a second LLM
acting as an LLM-as-judge. The judge reads two matched evaluation pairs per
cell, the first run and the run whose score sits closest to the cell mean, and
returns a verdict for each: `justified`, `bias`, or `mixed`, plus a short
rationale and verbatim quotes from the model's own reasoning that keyed off the
demographic signal. The default judge is `gemini-2.5-pro`. A `verdicts_agree`
flag marks cells where the two samples reached different conclusions, which is
the empirical defence of the two-sample design.

Run the audit with `npm run audit`. Cells with fewer than 5 collected runs are
skipped until backfill completes. See the audit-design section in
[`site/methodology.html`](site/methodology.html) for cost, judge selection, and
the self-judging caveat.

## The follow-up experiments

Two smaller experiments probe *why* the audit deltas look the way they do. The
homepage synthesis joins all three experiments into one per-model fingerprint.

- **Reasoning transplant** ([`site/transplant.html`](site/transplant.html)) —
  feed a model its own most-positive and most-negative written assessment of
  the same résumé and ask it to score again. If the score follows the
  transplanted reasoning, the bias is reasoned rather than a number decorated
  after the fact. Run with `npm run run:transplant`, aggregate with
  `npm run build:transplant`.
- **Prompt lab** ([`site/prompt-lab.html`](site/prompt-lab.html)) — five prompt
  strategies (score-last, rubric, blind instruction, chain-of-thought,
  few-shot) against the naive baseline, asking whether prompt engineering can
  stabilise the score. Run with `npm run run:prompt-lab`, aggregate with
  `npm run build:prompt-lab`.

## Quick start

Requires Node.js 20+.

```sh
cp .env.example .env       # fill in API keys (see below)
npm install
npm run smoke              # verify every provider is wired
npm run generate           # build variants from data/resume_base.md
npm run run                # execute the experiment (resumable)
npm run report             # produce report/data.csv and report/summary.md
npm run build:site         # regenerate site/data/ and prerender index.html (matrix + transplant + prompt lab + synthesis)
npm run audit              # run the LLM-as-judge audit pass on completed cells
npm run run:transplant     # execute the reasoning-transplant experiment
npm run run:prompt-lab     # execute the prompt-lab experiment
```

Each call writes its own result file keyed by (variant, model, JD, run), so runs
are fully resumable, interrupt and re-run `npm run run` and it picks up where it
left off. Partial datasets can be reported and explored before a run completes.

Provider keys live in `.env` (`OPENAI_API_KEY`, `GROQ_API_KEY`,
`MISTRAL_API_KEY`, and either `GOOGLE_GENAI_API_KEY` for AI Studio or
`GOOGLE_CLOUD_PROJECT` for Vertex). The Claude models are invoked through the
Claude CLI (`claude` binary) rather than the Anthropic API, so they use whatever
subscription the CLI is authenticated against rather than a key in `.env`. Only
configure the providers you intend to run.

The audit step uses a Google model by default and reads
`GOOGLE_CLOUD_PROJECT` (Vertex) or `GOOGLE_GENAI_API_KEY` (AI Studio). Override
the judge with `BIAS_AUDITOR_MODEL=gemini-2.5-flash` (or any other slot from
`src/providers/index.js`).

## Repository layout

```
src/             experiment engine (generate → run → aggregate → report)
src/providers/   one adapter per model vendor
data/            baseline résumé, job descriptions, generated variants
data/audits/     per-cell audit verdicts from the LLM-as-judge pass
results/         raw per-inference model outputs (JSON)
report/          aggregated data.csv and summary.md
scripts/         build*.js (site data, transplant, prompt lab, homepage synthesis), run*.js (follow-up experiments), auditDiffs.js (the audit pass)
site/            static results explorer (heatmaps, diffs, per-JD pages, methodology)
article/         working notes and drafts for the writeup (not part of the site build)
```

See [`PLAN.md`](PLAN.md) for the operational build plan and
[`RESEARCH_NOTES.md`](RESEARCH_NOTES.md) for the design reasoning behind every
choice.

## Limitations

A single base résumé cannot represent all candidates, and the
one-variable-at-a-time design cannot detect interaction effects (an unfamiliar
name **and** an unfamiliar school together). Models change over time, so
results are tied to the versions listed above. The study reports per-cell
deltas with confidence intervals; it does not label any model "biased" or
"unbiased" overall.

The Claude models run through the Claude CLI at the CLI's default sampling
rather than at temperature 0.7, so cross-model comparisons involving Claude
carry a sampling-asymmetry caveat.

The audit layer is itself an LLM and inherits whatever the judge model considers
bias. Every Gemini variant, including the default judge, is also in the audited
set, so the audit has a soft self-judging concern that the structured rubric
and the verbatim quote requirement blunt but do not eliminate. The site's
methodology page documents the judge selection, the alternatives considered,
and the cost trade-offs.

## License

- **Code** — [MIT](LICENSE)
- **Data** — [Creative Commons Attribution 4.0 (CC BY 4.0)](DATA-LICENSE)

## Author

Built by **Bogdan Szabo**, software engineer at [re:cinq](https://re-cinq.com).
The baseline résumé audited here is the author's own.

- Repository: [github.com/re-cinq/hiring-bias](https://github.com/re-cinq/hiring-bias)
- Live site: [re-cinq.github.io/hiring-bias](https://re-cinq.github.io/hiring-bias/)
- Website: [szabobogdan.com](https://szabobogdan.com/)
- GitHub: [@gedaiu](https://github.com/gedaiu)
- LinkedIn: [in/szabobogdan](https://www.linkedin.com/in/szabobogdan/)

If you use this work, please cite: *Hiring-Bias, Bogdan Szabo (re:cinq), 2026.
https://github.com/re-cinq/hiring-bias*
