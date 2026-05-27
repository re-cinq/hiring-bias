# Research Notes — Bias in LLM-Based Resume Screening

A working document capturing the reasoning behind every design choice in this
study, the experimental flows it executes, and the questions it intends to
answer. Written to be lifted into an article draft.

---

## 1. Motivation — Why Study This Now

Resume screening was the first hiring task that human reviewers wanted to
automate, and it is rapidly becoming the first task that large language models
are deployed against in production. The shift is happening in two layers.

The older layer is the Applicant Tracking System — Workday, Greenhouse,
Lever, iCIMS — which has been doing keyword-based parsing and ranking for
two decades. The newer layer is the LLM-as-screener: a prompt that asks
GPT-4, Claude, Gemini, or an open-weight model to read a resume and a job
description and output a score, a recommendation, or a written assessment.
That layer is being added on top of the ATS layer at speed, often by small
HR-tech vendors who wrap a frontier model with a thin product around it. The
candidate never sees the model. The recruiter usually sees only the score
and a short justification.

The premise of this research is that the LLM layer is where the most
consequential — and least audited — bias enters the modern hiring pipeline.
ATS keyword bias is well-studied and largely solved by tooling. LLM bias is
neither.

This study measures it.

---

## 2. What HR Teams Actually Do With LLMs

A representative LLM-screening prompt, as observed in HR-tech product
documentation and integration tutorials, looks approximately like this:

> *"You are evaluating candidates for the role described below. Given the
> resume, output a 1–10 score for overall fit, a recommendation
> (interview / hold / reject), and a short justification."*

The integration sits between the ATS and the recruiter's dashboard. The model
sees the full resume text and the full job description. There is rarely any
redaction. There is rarely any structured rubric. The recruiter usually sees
the score and the justification — and often acts on them.

This is the surface area this study attacks.

---

## 3. Research Questions

The study sets out to answer three questions:

1. **Does the LLM layer change its hiring recommendation when only demographic
   or contextual signals on the resume change**, with skills and experience
   held constant?
2. **Which signals matter most**, and does the answer differ across model
   vendors and across model tiers (flagship versus cheap)?
3. **Can prompt-level interventions meaningfully reduce the observed bias
   without flattening the model's ability to distinguish strong candidates
   from weak ones**?

Question one establishes that the problem exists. Question two characterizes
it. Question three turns the descriptive finding into a practical
recommendation.

---

## 4. Methodology — Why Counterfactual Paired Testing

The choice of methodology determines what the study can claim. Three designs
were considered.

The first is an **observational sweep**: gather many real resumes and ask the
model to score them. Real resumes carry every demographic signal at once;
the analyst cannot attribute any score difference to any specific signal.
This design measures correlation in the wild but cannot isolate causes.
Rejected.

The second is a **fully randomized factorial**: generate resumes with all
combinations of all signal levels — names crossed with schools crossed with
companies crossed with addresses, and so on. This isolates interaction
effects but the variant count explodes combinatorially, and at the scale this
project can afford on a personal budget the cells become too sparse to draw
conclusions.

The third, and the one this study uses, is **counterfactual paired
testing**: start from one real baseline resume and generate variants that
change exactly one signal at a time, holding everything else constant. Any
score delta between a variant and the baseline is attributable to the
specific signal that changed. The design trades the ability to study
interaction effects (which would require the factorial) for clean
single-axis attribution. For a first pass, attribution is more useful than
interaction.

This is the same logic that drives the classic Bertrand and Mullainathan
audit study from the early 2000s ([NBER w9873](https://www.nber.org/papers/w9873)),
in which fictitious resumes identical except for the candidate's name were
sent to real job postings. The counterfactual is the inference engine.

---

## 5. The Seven Axes — Why Each One

Seven demographic and contextual axes were selected, each chosen because it
carries a signal that hiring research has previously associated with bias,
and each independently realistic — a recruiter looking at a resume would in
fact see each of these.

**First name.** The single most studied resume-bias variable, and the most
straightforward to manipulate. Names carry gender and ethnicity signal
simultaneously, which means the axis tests two biases at once. Levels span
Western male and female names, Arabic, East Asian, African, and Hispanic
names, allowing the analysis to distinguish "name unlike training-data
majority" effects from specific demographic effects.

**Graduation year.** Acts as an age proxy. A graduation year of 2005 implies
a candidate in their early forties; 2023 implies a candidate in their
mid-twenties. The same skills and experience description applied to
different graduation years lets us see whether age signal alone shifts the
recommendation.

**Address country.** The candidate's location, as inferred from the address
block at the top of the resume. Changing only this field tests whether
identical qualifications are evaluated differently when the candidate
appears to live in San Francisco versus Lagos, Bucharest, or São Paulo.

**Career gap.** A two-year gap in employment, with and without a labeled
explanation ("caregiving"). This isolates two effects at once: whether gaps
penalize scores, and whether labeling the gap as caregiving — which in
practice is a gender-correlated signal — changes the penalty.

**Company names.** The employers listed on the resume. The same job
descriptions and tenures can be attached to FAANG companies, mid-tier known
companies, unknown regional companies, or non-Western flagships like Naver
or MercadoLibre. This axis isolates employer-brand bias from the actual work
described.

**Company locations.** Where the work was done, independent of company
prestige. Tests whether the model treats engineering work done in Bangalore
as equivalent to the same work done in Berlin.

**School and university.** Education prestige and geography. The same degree
and dates can be attached to MIT, ETH, IIT, or a regional university the
model has likely never seen. This axis is where elitism bias would show up
most cleanly.

The seven were chosen partly for breadth and partly because each is something
a real candidate can in principle control or omit — meaning a practical
recommendation could come out the other end (for example, "the model
penalizes unfamiliar schools, so candidates from less prestigious schools
benefit disproportionately from blind-redaction interventions").

---

## 6. Model Selection — Why These Nine

Nine model slots are tested, organized as flagship-plus-cheap pairs from
each major vendor where both tiers are available, with one extra
generational comparison on the Google side. The pairing is the
methodological backbone of the cross-vendor comparison.

The pairing matters because without it, any observed cross-vendor
difference is confounded with model-tier difference. If Claude Opus is more
biased than Gemini Flash, the analyst cannot tell whether that is a vendor
fact ("Anthropic's training data") or a tier fact ("flagship models reason
more elaborately and find more opportunities to apply prejudice"). Including
both flagship and cheap models from the same vendor lets the report
distinguish the two.

The chosen vendors are Anthropic, OpenAI, Google, Meta, and Mistral.
Anthropic is included via the user's Max subscription using the
command-line interface, which routes through the same session credentials as
the chat product — so Claude is represented but cannot easily be paired with
a cheaper Anthropic model in the same study without consuming additional
Max quota. OpenAI contributes GPT-5 and GPT-4o-mini. Google contributes
three Gemini variants — 2.5 Pro, 2.5 Flash, and 3.5 Flash — all served
through Vertex AI on a single authentication and a single SDK, trading the
AI Studio free tier for operational simplicity. Including both Flash
generations from the same vendor lets the analysis answer a second
question: does a newer cheap model from the same vendor exhibit the same
biases as its predecessor, or has the training data and tuning meaningfully
shifted the bias profile? Meta is represented by Llama 3.3 70B served
through Groq's free tier. Mistral contributes Mistral Large and Mistral
Small.

The mix is deliberately weighted toward what would actually be deployed at
HR-screening volume. The cheap models in particular reflect production
reality more than the flagships do — a vendor selling resume screening to
small-business HR teams will not pay flagship token rates per candidate.

---

## 7. Prompt Design — What Stays Fixed and Why

A single prompt template is used across every cell of the experiment. The
fixed prompt is the experimental control. Any variation in the prompt
itself would contaminate the signal we are trying to measure.

The template asks the model for a JSON object containing five fields: a
numeric score from 1 to 10, a categorical recommendation, a short written
justification, lists of three strengths and three concerns, and a
structured `key_factors` array of three factors ranked by their effect on
the score with their direction (positive or negative) and weight (high,
medium, or low). Each field serves a purpose.

The numeric score is the primary outcome variable. It enables means,
distributions, and per-axis statistical comparison.

The categorical recommendation is the secondary outcome — what an HR system
would actually act on. A score of 6 and a score of 7 may differ
statistically but produce identical recommendations; the categorical
variable measures whether the bias is large enough to change the decision.

The written justification is the qualitative channel. Numeric bias tells us
*that* the model treats variants differently. The justification tells us
*how* — which adjectives appear differentially across name-variant resumes,
which concerns are raised more often for older candidates, whether the
model invents narratives to rationalize a low score. A second LLM pass over
the justifications performs thematic coding to extract this pattern.

The strengths and concerns lists serve as a structured check on the
justification. If the model writes a glowing justification but lists three
weak strengths, the inconsistency is itself a finding.

The `key_factors` array is the study's debugging channel. A free-form
"explain your reasoning" instruction would have contaminated the experiment,
because chain-of-thought is known to alter both output quality and bias and
would have introduced an uncontrolled prompt variation. Instead the field
asks for structured rubric output — three ranked factors, each with a
direction and a weight — applied uniformly to every variant and every model.
This preserves the experimental control while giving the analyst a
machine-readable reasoning trace per cell. When a score delta appears
across variants, the `key_factors` arrays for those cells reveal which
specific factors the model promoted or suppressed, without anyone having to
parse free text or run a separate diagnostic prompt.

Temperature is set to 0.7 for all calls. A temperature of zero would
produce identical responses on identical inputs and prevent the variance
analysis. A temperature of 1.0 introduces noise that drowns the signal at
the cell sizes this study can afford. 0.7 is the standard middle ground.

---

## 8. The Experimental Flow

The study runs in four phases, each with a clear go/no-go decision point.

**Phase 1 — Baseline measurement.** One job description, twenty-two resume
variants, eight model slots, five runs per cell. Total: roughly nine hundred
calls. The output is a results table with mean score, recommendation rate,
and a representative justification for each (variant, model) cell. The
go/no-go question at the end of Phase 1 is: *are the deltas large enough
across enough cells to warrant going further?* If only one or two axes show
signal, the study can focus there. If none do, the study has its first
finding ("LLMs are less biased than expected on this resume profile") and
can stop early.

**Phase 2 — Multi-JD validation.** Repeat the same experiment against two
or three additional job descriptions. The purpose is to test whether the
biases found in Phase 1 are properties of the model or artifacts of the
specific job description. A bias that disappears when the job description
changes is a JD effect, not a model effect.

**Phase 3 — Axis deepening.** For each axis that showed strong bias in
Phases 1 and 2, expand the number of contrast levels and the number of runs
per cell. The goal is to characterize the shape of the bias function — for
example, does the score decline linearly with graduation year, or is there
a cliff at some threshold? Does the penalty for unknown schools depend on
the rest of the resume's strength?

**Phase 4 — Mitigation testing.** This is the prescriptive half of the
study, described in detail in the next section.

Each phase is fully resumable. Every individual call writes its result to
its own JSON file keyed by (variant, model, JD, run). Interrupted runs pick
up exactly where they left off, and partial datasets can already be
analyzed before the rest completes.

---

## 9. Mitigation Hypotheses — Seven Prompt Patterns to Test

The interesting question is not whether bias exists — most prior work
suggests it will — but whether a recruiter or an HR-tech vendor can do
anything about it at the prompt level, without retraining models or
changing infrastructure. Seven prompt-level interventions are tested,
selected because each represents a different theory of why the bias appears.

**Pattern M1 — Blind redaction.** The hypothesis is that bias enters through
demographic and contextual fields that the model has no legitimate reason
to use. The intervention strips name, address, photo, graduation year,
school name, and company names from the resume before sending it, replacing
each with a neutral token. The expected result is a large bias reduction
with no calibration loss, because the redacted fields are not the ones
that should drive scoring anyway.

**Pattern M2 — Anti-bias system instruction.** The naive intervention. The
prompt simply *tells* the model to ignore demographic signals. The
hypothesis under test is whether this works. The expected result, based on
prior research, is that it does not — instruction-following on
self-restraint is generally weak. The pattern is included specifically to
measure the size of that gap.

**Pattern M3 — Structured rubric, no free reasoning.** Replaces the free-form
justification with five fixed criteria, each scored 1–5 against a short
anchor description. The hypothesis is that bias enters through the open
narrative channel; closing that channel may remove the bias even if the
underlying judgment is unchanged. Score deltas may shrink; calibration may
suffer if the rubric does not capture all the relevant signal.

**Pattern M4 — Criteria-first, resume-second.** A two-turn prompt. The first
turn shows the model only the job description and asks it to list its own
scoring criteria. The second turn shows the resume and asks the model to
score against the criteria it just committed to. The hypothesis is that
committing to criteria before seeing the candidate anchors judgment in
substantive features and reduces the model's freedom to reverse-engineer
a justification from a biased intuition.

**Pattern M5 — Two-pass anonymize-then-score.** The first call asks the
model (or a cheaper sibling) to rewrite the resume with demographic and
contextual signal removed, preserving substance. The second call scores the
anonymized version. The hypothesis is that asking a model to produce a
neutralized artifact is a different task than asking it to ignore signal it
can see — and may be easier for the model to do well.

**Pattern M6 — Counterfactual self-check.** After producing an initial
score, the model is asked: *would your score change if the candidate's name
were [alternate name]? If yes, explain and revise.* The hypothesis is that
the model can detect its own bias when asked to, and the self-correction
turn closes some of the gap.

**Pattern M7 — Feature extraction then score.** Splits scoring into two
calls. The first extracts a structured JSON feature vector from the resume
— years of experience, skills, seniority level — with a schema that has no
fields for demographic information. The second scores from the feature
vector alone, never seeing the original resume. The hypothesis is that the
schema is the filter: bias cannot enter scoring if the scoring input does
not contain the biased channels.

The seven patterns differ in cost, in implementation complexity, and in
which theory of bias they implicitly endorse. The report's conclusion ranks
them empirically and recommends a layered combination — possibly M1 plus M3
plus M7 in production — as the practical takeaway.

---

## 10. Acceptance Criteria — What Makes a Mitigation Recommendable

A mitigation pattern moves from "interesting" to "recommended" only if it
clears three bars simultaneously.

First, it must reduce the largest observed bias delta from Phase 1 by at
least fifty percent on at least two of the tested models. A mitigation that
only works on one vendor is fragile.

Second, it must preserve calibration. A mitigation that flattens all scores
to a narrow band looks impressive on the bias-reduction metric but is
useless in production, because it can no longer distinguish strong
candidates from weak ones. The calibration check compares score variance
across a set of resumes with deliberately varied skill levels before and
after the mitigation.

Third, it must cost no more than twice the baseline prompt in tokens. A
mitigation that triples or quadruples token cost is not a practical
recommendation at HR-screening volume, where token spend per candidate
directly affects the vendor's margins.

These three bars are stated explicitly so the report's recommendations are
defensible. A mitigation that clears all three is recommended. A mitigation
that clears two is documented with the trade-off. A mitigation that clears
fewer than two is reported as a negative result, which is itself useful.

---

## 11. How to Read the Final Report

The article that emerges from this study can be structured around three
movements.

The first movement is descriptive: here are the biases that exist, at what
magnitude, in which models. The headline tables and the per-axis boxplots
carry this movement. The reader should leave it knowing which signals the
LLM layer is most sensitive to.

The second movement is comparative: which vendors are worse, which model
tiers are worse, and where the cross-vendor differences are large enough to
matter. This is where the flagship-plus-cheap pairing pays off — the
analysis can claim, with evidence, that the worst bias on a given axis is a
property of a specific vendor's training and not a property of "LLMs in
general."

The third movement is prescriptive: here are seven prompt-level
interventions, here is how each performed, here is the layered combination
the report recommends. This movement is the reason an HR-tech vendor or a
hiring team would read the article — it gives them something to do on
Monday morning.

---

## 12. Limitations to Acknowledge Up Front

A study at this budget and scope has real limitations that an honest article
should state plainly.

A single base resume cannot represent all candidates. The biases found here
are biases as they manifest against this specific candidate profile; a
fresh-graduate resume, a career-switcher resume, or a non-engineering
resume may surface different biases. A future study should repeat the
experiment across a corpus of base resumes.

The one-variable-at-a-time design cannot detect interaction effects. A
recruiter or model may not penalize an unfamiliar school by much, and may
not penalize an unfamiliar name by much, but may penalize both together by
a great deal. Detecting this requires the full factorial design that this
study deliberately rejected for cost reasons.

Model providers update their models. Results are timestamped, and a result
that is true of GPT-5 in June 2026 may not be true of its successor in the
fall. The article should make this explicit and ideally release the code so
the experiment can be re-run.

The prompt itself is one of many possible HR-screening prompts. Bias
measurements are known to be sensitive to prompt phrasing. A robustness
check that varies the prompt across two or three plausible alternatives is
a stretch goal of this study and an essential extension if the work is to be
cited.

---

## 13. What "Done" Looks Like

The study is done when the article can be written with confidence on each
of the following claims:

- Bias exists in the LLM resume-screening layer at measurable, replicable
  magnitudes across multiple vendors.
- The specific signals most responsible are identified and ranked.
- At least one prompt-level mitigation has cleared the three acceptance
  bars on at least two models.
- The limitations are stated in enough detail that a reader can decide
  whether the findings apply to their own hiring context.

At that point the experiment has produced both a finding and a practical
recommendation, and the article writes itself.
