# Executive Narrative Style Guide

**The voice of the Monthly Board Reporting Package.**

This document defines the three narrative tones used across Spectre's
executive reporting surfaces and gives weak-vs-strong examples for
each. It is the **fourth layer** governing reporting work — the
**voice** layer that sits beneath the framework (what to answer),
the design system (how to look), and the skill (how to ship):

| Layer | Document | Governs |
|---|---|---|
| 1 | [docs/spectre-framework.md](spectre-framework.md) | What the report must answer |
| 2 | [docs/spectre-executive-reporting-design-system.md](spectre-executive-reporting-design-system.md) | How the report must look |
| 3 | [.claude/skills/executive-reporting-design/SKILL.md](../.claude/skills/executive-reporting-design/SKILL.md) | How to review and ship it |
| **4** | **this document** | **How the report must sound** |

Reporting work that gets the typography, palette, and structure right
but speaks in operator-vocabulary or chatty editorial voice fails the
boardroom-ready test. This guide is the reference every narrative
paragraph — chapter framing leads, briefing memos, executive
commentary, notes, captions — must be measured against.

---

## When to apply this guide

**Always**, on any reporting surface, including but not limited to:

- The italic-serif L4 framing paragraphs at the top of every chapter
- The signed briefing memos in chapter II
- The Executive Commentary blocks closing each chapter
- The plain-English notes inside each `BoardStatement`
- The Capital Projects notes (if added in a future pass)
- The Stewardship card "What it is" / "Why it matters" definitions
- The KPI card interpretation paragraphs
- The chapter VIII framing of F&B subsidy

**Never** for source-code comments, test descriptions, internal
admin labels, or operator-facing screens — those use plain
engineering or operator vocabulary. The style guide is for the
*document*, not the *application*.

---

## The three tones

A reporting surface speaks in one of three voices. Each voice has its
own posture, its own vocabulary, and its own role.

| Tone | Speaker | Listener | Posture |
|---|---|---|---|
| **CFO** | The Controller / Chief Financial Officer | The Finance Committee | Confident, precise, interpretive |
| **Board** | The Committee Chair or General Manager *to* the Board | The full Board / governors | Strategic, stewardship-framed, action-aware |
| **Governance** | The Governing Body itself (Board package, committee report, minutes) | The historical record + future readers | Formal, declarative, citation-bearing |

A single chapter may shift between tones — the chapter lead may be in
**Board** tone, the controller's notes inside a statement in **CFO**
tone, and the Executive Commentary's *"Board decision required"* row
in **Governance** tone. Knowing which tone you are in is the first
step before drafting any sentence.

---

## CFO tone

> **The Controller's voice. Precise. Interpretive. Forward-looking.**

The CFO tone speaks **as** the controller writing **to** the Finance
Committee chair. Its purpose is to take a number, name what it
measures, name where it sits relative to the benchmark, and offer one
sentence of professional judgement on what it means and where it is
heading.

### Voice rules

1. **Always name the number.** A CFO never writes *"revenue is up"*;
   the CFO writes *"$14.62 M, +3.7 % above plan"*.
2. **Always name the comparator.** Budget / policy band / peer
   median / prior period — the CFO's read is always relative.
3. **Always interpret.** A bare number-vs-comparator pair is data,
   not reporting. The CFO names the *so-what* in one clause.
4. **Forward-looking close.** When the data trajectory is clear,
   the CFO says *"on track to close above plan"* or *"on pace to
   exceed the policy ceiling by Q3"*. Past-tense alone is bookkeeping.
5. **Calibrate uncertainty.** When the read is genuinely uncertain,
   the CFO names the uncertainty explicitly — *"the Q4 contribution
   margin is sensitive to ±5 percentage points of cover variance"* —
   not by hedging ("might be", "could be", "if things go well").
6. **Technical vocabulary, correctly used.** Accrual, deferral,
   contribution margin, variance, policy band, ratio, runway — the
   CFO uses these because the Finance Committee chair understands
   them. A controller who avoids these terms reads as junior.
7. **Active voice, first-person plural where natural.** *"We are
   tracking favorably to plan"* not *"It is being tracked that the
   plan is being met"*.
8. **One sentence per pillar.** What happened → why it matters →
   trend → board action. Four crisp sentences. Not paragraphs.

### Scope

- Statement notes ("Operating revenue closed +1.0 % favorable to
  plan, driven by Golf Operations (+5.1 %)…")
- Stewardship card "Why it matters" definitions
- Briefing memo from the Controller (chapter II)
- Executive Commentary "What it means" row

### Weak vs Strong

**Example 1 — operating performance**

> *Weak:* Revenue is doing well this month.

This is the chatty-Slack version. No number. No comparator. No
interpretation. A Finance Committee chair reads this and learns
nothing.

> *Strong:* YTD revenue of $14.62 M is +3.7 % above plan, driven by
> Golf Operations (+5.1 %) and Membership Dues (+0.6 %). At current
> pace we expect to close FY26 +2 % to +3 % above plan.

Number → benchmark → attribution → forward-looking close. Four
elements, one paragraph.

---

**Example 2 — payroll**

> *Weak:* Payroll is fine.

There is no scenario in which "payroll is fine" is acceptable on a
Finance Committee surface. Payroll is the largest operating line on
the page.

> *Strong:* YTD payroll is +1.8 % over budget at $7.18 M, but the
> payroll ratio holds at 49.2 % — below the 50 % policy band. The
> over-budget driver is wage rates (the mid-year minimum-wage
> step-up added ~$96 K), not headcount. Dues plus entrance fees
> continue to cover the line in full, with a $310 K cushion.

Two numbers, two benchmarks (budget and policy band), attribution
(wage-rate not headcount), and a coverage interpretation. The
controller's read is complete in four sentences.

---

**Example 3 — F&B subsidy (the framework's Pillar 1 ratio)**

> *Weak:* F&B is losing money but we are working on it.

"Losing money" is inflammatory; "working on it" is operator-speak.

> *Strong:* The F&B subsidy of dues is 5.1 % YTD, well below the
> 8 % policy ceiling. The ratio has trended down for twelve
> consecutive months. Average check growth (+4.1 % YoY) is fully
> offsetting the -1.4 % cover softness. We expect FY26 to close
> with subsidy below 5.5 %.

Specific ratio + named policy ceiling + trend + attribution +
forward-looking close. No emotion; the numbers carry the verdict.

---

## Board tone

> **The Committee Chair's voice to the Board. Stewardship-framed.
> Action-aware.**

Where CFO tone interprets the number, Board tone connects the number
to **governance**: the five stewardship pillars, the Long Range Plan,
the policy bands, the board's strategic threshold for action. Board
tone is what a Committee Chair says when standing in front of the
full Board summarising the period.

### Voice rules

1. **Frame in pillar language.** Operating Stewardship, Capital
   Stewardship, Balance Sheet Stewardship, Membership Stewardship,
   Experience Stewardship. These are the five categories the framework
   defines; Board tone names them.
2. **Name trade-offs explicitly.** A Board chair does not say "this
   is good"; they say *"this is favorable on metric X but it imposes
   a constraint on metric Y; the Board's judgement is whether the
   trade is acceptable"*.
3. **Distinguish observation from recommendation.** *"The current
   reading is …"* (observation) vs *"the Membership Committee
   recommends …"* (recommendation). Never confuse the two.
4. **Cite the governance instrument.** When invoking a policy band,
   a reserve study, a Long Range Plan, name it. *"The Long Range
   Plan's waitlist depth target of 60"*, *"the FY24 Reserve Study's
   coverage floor of 1.25x"*, *"the policy band of 38–44 %"*.
5. **Name board action — or its absence — explicitly.** *"The Board's
   typical practice in this band is to review again at the
   September meeting"* or *"No Board action is required this
   period"*. Silence on the action question is a defect.
6. **Third-person institutional voice.** *"The Club"*, *"the
   Board"*, *"the Committee"*. Not *"we"* (that is CFO tone) and
   not *"you"* (that is operator tone).
7. **Strategic horizon.** Board tone speaks in seasons, fiscal years,
   five-year horizons. Not weeks, not days. *"The FY26 trajectory"*,
   *"on the five-year reserve schedule"*, *"the multi-year subsidy
   trend"*.
8. **Calmer than CFO tone.** The Board chair has had a week to
   compose the briefing. The pace is slower.

### Scope

- The chapter II briefing memos (signed by GM, Controller, Capital
  Committee Chair as appropriate)
- The chapter framing L4 paragraphs (the CFO's-voice intros may be
  CFO tone; the broader narrative framings are Board tone)
- The Executive Commentary "What needs attention" and "Board
  decision required" rows
- Notes inside the Stewardship Dashboard chapter

### Weak vs Strong

**Example 1 — membership health**

> *Weak:* Membership is up. Good to see. Hopefully it continues.

This is conversational. No governance framing, no benchmark, no
horizon, no action implication.

> *Strong:* Net member change is +25 YTD against the Long Range
> Plan's +30 target. The gap is concentrated in the upper-tier
> Full-Equity category — the segment most sensitive to the equity-tier
> refresh under Committee review. The waitlist holds at 47, healthy
> in absolute terms but below the Long Range Plan's 60-deep buffer
> threshold. The Membership Committee may wish to consider whether to
> accelerate the equity-tier refresh into Q4 rather than waiting for
> the FY27 cycle.

Number → benchmark (Long Range Plan target) → attribution → pillar
framing (waitlist as Pillar 4) → governance instrument citation
(Long Range Plan) → explicit Board / Committee action implication
(*"may wish to consider"*).

---

**Example 2 — F&B stewardship**

> *Weak:* F&B is a money loser but it's important for the member
> experience.

A Board chair never frames F&B as a "money loser" — it is a
stewardship line. And *"important for the member experience"* is
sentimental, not strategic.

> *Strong:* The F&B subsidy of dues sits at 5.1 % this period, well
> below the 8 % policy ceiling adopted in FY23 and below the 6 %
> sustained-target the Board affirmed at the FY25 strategic review.
> The subsidy is the Board's Pillar 1 Operating Stewardship lever for
> balancing Pillar 5 Experience Stewardship — the trade-off between
> "F&B pays for itself" and "F&B is part of what members joined for".
> The current reading suggests the trade-off is being managed; no
> Board action is required this period.

Specific ratio + two cited governance instruments (FY23 policy
ceiling, FY25 strategic review target) + explicit naming of the
pillar-against-pillar trade-off + explicit no-action statement. The
chair has done the governance translation work the Board needs.

---

**Example 3 — capital project deferral**

> *Weak:* We didn't replace the irrigation pump this year because
> there's some scope question.

Vague. The Board needs to know the funding impact, the timing impact,
and the recommendation.

> *Strong:* The irrigation pump replacement has been deferred to FY27
> pending engineering review of the revised scope. The deferral
> releases $315 K of FY26 capital authority back to the reserve.
> The Capital Committee recommends Board approval of the revised
> scope at the September 2026 meeting; the FY27 capital plan cannot
> incorporate the deferred work in its first six months without that
> approval. The reserve impact is favorable (+$315 K cushion) in the
> short term but the deferral does not change the multi-year
> obligation.

Specific dollar impact + horizon (FY27, September) + clear
recommendation + Committee body named + a sentence distinguishing
short-term reserve impact from multi-year obligation. The Board has
everything it needs to decide.

---

## Governance tone

> **The voice of the governing instrument itself. Most formal.
> Citation-bearing. Defensive.**

Governance tone is not the CFO's interpretation and not the
Committee Chair's recommendation — it is **the document as record**.
The Board package is a governance artifact that will be reviewed by
future committees, by auditors, by counsel. Governance tone is what
those future readers must be able to reconstruct from the page.

### Voice rules

1. **Date-stamp everything.** *"At its May 22, 2026 meeting"*, *"per
   the FY24 Reserve Study adopted June 14, 2024"*, *"as of period
   close May 31, 2026"*. Future readers must know **when**.
2. **Name the body.** *"The Capital Committee"*, *"the Board of
   Governors"*, *"the Membership Committee"*. Future readers must
   know **who** acted.
3. **Past-tense, declarative.** *"The Committee reviewed"*, *"the
   Board approved"*, *"the deferral was made for engineering review
   reasons, not funding reasons"*. Not future-tense ("the Committee
   will review" is acceptable for recommendations, but observations
   stay in past tense).
4. **Cite authority.** Every policy threshold, every band, every
   approved budget should be traceable. *"Per the FY24 Reserve
   Study"*, *"per the board-approved FY26 capital plan"*, *"per the
   by-laws Article IV § 3"*.
5. **No personality.** Governance tone has no individual voice. *"The
   Committee was concerned"* is acceptable; *"the Chair felt"* is
   not.
6. **Name decisions, motions, vote thresholds where applicable.**
   *"A motion to approve the revised scope, made by Director
   Tremblay, carried unanimously"*. The package is also a record of
   how the body acted.
7. **Defensive against future re-reading.** Assume the reader is
   five years in the future, knows nothing about the period, and
   needs to reconstruct it from the page alone. Write so that is
   possible.
8. **Distinguish observed facts from recommendations.** *"The reserve
   coverage measured 1.42 x at period close"* (fact) vs *"the
   Committee recommends maintaining current reserve policy"*
   (recommendation). Different tones, different sections.

### Scope

- The chapter IX Capital Projects status section
- The chapter X AR / Collections notes (when a collections action is
  named)
- The "Board decision required" row of every Executive Commentary
- Any future board-minutes-style surface
- Any future financial-statement footnotes if the package adds them

### Weak vs Strong

**Example 1 — capital plan review**

> *Weak:* The capital committee talked about the projects. Most are
> on track. We pushed the pump thing back.

This is a Slack message, not a governance record.

> *Strong:* The Capital Committee reviewed the FY26 capital plan at
> its May 22, 2026 meeting. Of seven board-approved projects:
> five are on track to close at or under budget, one (Pro Shop
> Refresh) is complete, and one (Irrigation Pump Replacement) has
> been deferred to FY27 pending engineering review of the revised
> scope. The deferral released $315 K of FY26 capital authority back
> to the Reserve. The Committee will recommend approval of the
> revised irrigation scope at the September 2026 Board meeting.

Date + body + specific count of projects in each state + named
project + dollar impact + named future action. A future reader can
reconstruct the entire FY26 capital decision from this paragraph.

---

**Example 2 — reserve health**

> *Weak:* The reserves look healthy.

A Governance record has never been one sentence long, has never used
the word "look", and has never used "healthy" without a number.

> *Strong:* Capital reserve coverage measured 1.42 x the three-year
> average capital spend at period close (May 31, 2026), above the
> 1.25 x policy floor adopted in the FY24 Reserve Study and below
> the 2.00 x upper-bound target. Per the Reserve Study, sustained
> coverage below 1.00 x is the threshold for invoking a special
> assessment under Article IV § 3 of the by-laws; current coverage
> provides 0.42 x of cushion above that threshold. No Reserve Study
> revision is currently scheduled prior to FY28.

Specific ratio + measurement date + named policy floor + cited
authority (FY24 Reserve Study, by-laws Article IV § 3) + named
threshold + cushion calculation + statement of next review cycle. A
future Capital Committee Chair can reconstruct the entire reserve
posture as of May 31, 2026 from this paragraph.

---

**Example 3 — AR collections action**

> *Weak:* Some members owe a lot of money. We're working on it.

There is no scenario in which this is acceptable in a board package.

> *Strong:* Total AR at period close was $235 K, of which $235 K is
> within active member balances and $0 was written off this period.
> Three member accounts representing $9.4 K were aged into the
> 31–60 day bucket; the General Manager initiated formal outreach
> May 30, 2026, with payment plans expected by June 15. No accounts
> were referred to outside collections this period. Per board policy
> adopted May 2022, any account aged beyond 90 days without a
> payment plan triggers Membership Committee review; no accounts
> currently meet that condition.

Specific totals + named action + named individual role (GM) + dated
action + named expected resolution + cited policy + statement of
threshold not being met. Future readers know exactly what was done.

---

## Cross-cutting principles

These apply to all three tones.

### Numbers always pair with comparators

A reporting paragraph that contains a number without a comparator is
incomplete in any tone. *"$14.62 M"* is data; *"$14.62 M vs $14.10 M
budget"* is reporting. This is the framework's *"never print a raw
number alone"* rule applied at the sentence level.

### Verdicts always pair with thresholds

*"Healthy"*, *"strong"*, *"watch"*, *"on plan"*, *"above plan"*
require a cited threshold to be meaningful. *"Reserve coverage is
healthy"* is unverifiable; *"Reserve coverage of 1.42 x is healthy —
above the 1.25 x policy floor"* is verifiable.

### Trends require time horizons

*"The subsidy is trending down"* is incomplete. *"The subsidy has
trended down for twelve consecutive months"* is complete.

### Attributions require named drivers

*"Revenue is up"* — by what? *"Revenue is up driven by Golf
Operations (+5.1 %) and Membership Dues (+0.6 %)"* — now we know.

### Forward-looking statements require calibration

*"We will close above plan"* is overconfident. *"At current pace we
expect to close +2 % to +3 % above plan, subject to Q4 weather
risk"* is calibrated. CFOs name the sensitivity.

### "We", "the Committee", "the Board"

| Tone | First-person | Third-person institutional |
|---|---|---|
| CFO | *"we are tracking favorably"* — acceptable when the controller is the speaker | *"the Committee reviewed"* — acceptable for past observation |
| Board | rarely; the Chair speaks **about** the Club | *"the Board's stewardship target"*, *"the Membership Committee may wish to consider"* |
| Governance | never | always — *"the Committee", "the Board", "the General Manager"* |

---

## The four-questions narrative pattern

Every chapter framing paragraph, briefing memo, and Executive
Commentary block must answer the framework's four questions:

1. **What happened?** → Past-tense observation. Names the number.
2. **Why does it matter?** → Cites the comparator + the stewardship
   pillar served.
3. **Is the trend improving or deteriorating?** → Time horizon +
   direction.
4. **Does the Board need to take action?** → Explicit action or
   non-action statement.

A paragraph that answers all four reads as **complete**. One that
answers fewer reads as **partial** — the reader has to do the rest of
the work in their head, which is the design system's
*never-print-a-raw-number-alone* failure mode applied to prose.

Example, all four answered:

> *"Operating revenue of $12.62 M YTD is +1.0 % favorable to plan,
> driven by Golf Operations (+5.1 %) and Membership Dues (+0.6 %).
> [WHAT + WHY] The Operating Stewardship trend has been favorable
> for nine consecutive months and the trajectory points to a +2 %
> to +3 % FY26 close. [TREND] No Board action is required this
> period. [ACTION]"*

Four sentences. Four answers. Boardroom-ready.

---

## Vocabulary glossary — use vs avoid

### Use

| Term | Context |
|---|---|
| *favorable / unfavorable to plan* | variance direction |
| *policy band, policy floor, policy ceiling* | governance thresholds |
| *stewardship* | the framework's organising concept |
| *contribution margin* | the operating-margin metric |
| *runway* | reserve / cash sustainability horizon |
| *cushion* | quantified buffer over a threshold |
| *posture* | strategic stance |
| *trajectory* | trend with forward-looking implication |
| *the Committee may wish to consider* | soft recommendation |
| *the Board's typical practice in this band* | governance precedent |
| *as of period close* | dating convention |
| *per the FY24 Reserve Study* | citation convention |
| *no Board action is required* | explicit non-action statement |

### Avoid

| Term | Why |
|---|---|
| *crushing it, killing it, smashing* | startup-speak |
| *deep dive, drill down, double-click* | consulting cliché |
| *circle back, take it offline* | meeting-speak |
| *good, bad, fine, healthy, doing well* | unverifiable without a benchmark |
| *hopefully, fingers crossed* | hedging without calibration |
| *I think, I feel, my gut says* | personality in a Governance record |
| *we're working on it* | operator-vocabulary; not a board action |
| *exciting, awesome, terrible* | emotional vocabulary |
| *crushing the plan, blowing past budget* | variance direction without number |
| *should, could, might* (without sensitivity) | uncalibrated forward-looking |
| *touching base, looping in* | conversational tone |
| *at the end of the day* | filler |
| *let's dive in* | AI-cliché opener |
| *empower / leverage / unlock* | enterprise SaaS speak |

---

## How to choose between the three tones

Use the question test:

1. **Whose voice is this?**
   - The Controller writing → CFO tone
   - The Committee Chair briefing → Board tone
   - The Board package as a record → Governance tone

2. **Who is the listener?**
   - The Finance Committee chair reading the controller's note →
     CFO tone
   - The full Board reading the period briefing → Board tone
   - A future Committee Chair, auditor, or counsel reading the
     record → Governance tone

3. **What is the purpose?**
   - Interpret the data → CFO tone
   - Frame the trade-off and name the action → Board tone
   - Record the moment defensively for the future → Governance tone

A single chapter often mixes tones. The L4 italic-serif framing
paragraph is often Board tone (chairman's overview); the Statement
notes inside are CFO tone (controller's read); the Executive
Commentary's *"Board decision required"* row is Governance tone
(the record of action / non-action).

---

## Common anti-patterns

### A1 — Telling the reader the chapter is about something instead of being it

> *Weak:* This chapter is about F&B performance.

The reader knows it is about F&B — the chapter is titled "F&B /
Hospitality". A framing paragraph that announces its own topic is
admin-page chrome.

> *Strong:* F&B revenue closed -3.8 % to plan on -1.4 % covers, but
> average check growth held total contribution near budget. The
> all-in subsidy of dues holds at 5.1 % — well below the 8 % ceiling.

The framing paragraph **does** the chapter; it does not narrate
about it.

### A2 — Operator vocabulary in board prose

> *Weak:* The kitchen needs to tighten up food cost.

That sentence belongs in a manager's morning huddle, not in a board
package. "Tighten up" is operator-speak.

> *Strong:* Food cost % held at 31.8 % YTD, below the 33 % policy
> target. (No action.)

A board reader sees the number, the threshold, and the implicit
verdict.

### A3 — Verdicts without thresholds

> *Weak:* Working capital is in great shape.

What does "great shape" mean? The reader cannot verify.

> *Strong:* Working capital of $4.71 M sits $1.21 M above the $3.50 M
> policy floor — a 34 % cushion.

Now the verdict is verifiable.

### A4 — Forward-looking without calibration

> *Weak:* We're going to crush the FY26 plan.

Overconfident, no number, no sensitivity, wrong tone.

> *Strong:* At current pace we expect to close FY26 +2 % to +3 %
> above plan, subject to Q4 weather risk (the trailing-three-year
> average suggests ±$200 K of revenue sensitivity to weather in
> Q4).

A specific range, a named sensitivity, a quantified risk. CFO-grade.

### A5 — Silence on the board-action question

A chapter that observes a +6 % rounds variance, explains it, names
the trend, and then **stops** — without saying whether the Board
needs to do anything — is incomplete. The framework's fourth
question is *"Does the Board need to take action?"* and it must
always be answered, even if the answer is *"No Board action is
required this period."*

### A6 — Conflating observation with recommendation

> *Weak:* The Capital Committee should approve the revised irrigation
> scope.

This sentence does not say whether the recommendation is the
Committee's or the controller's or someone else's. In a Governance
record, that ambiguity is a defect.

> *Strong:* The Capital Committee recommends Board approval of the
> revised irrigation scope at the September 2026 Board meeting.

The body making the recommendation is named.

---

## When this guide is wrong

This is a living document. When a reporting requirement does not
fit one of the three tones — or requires a fourth tone that the
guide does not name — flag the gap to the user and ask whether
(a) the requirement belongs in a different tone, or (b) the guide
needs amendment.

Three tones are sufficient for the current package surface. If
Spectre adds new reporting surfaces (an audited financial statement,
a Member Annual Report, an SEC-style disclosure document for a
501(c)(7) regulated context, a Long Range Plan refresh), additional
tones may need to be named. The guide expects amendment as the
surface area grows.

---

## Required behaviour

**Before Claude writes any narrative prose on a reporting surface,
it must:**

1. Identify which tone the surface uses (CFO / Board / Governance).
2. Confirm the four-questions pattern will be answered.
3. Cite specific comparators and thresholds — never write a verdict
   without a benchmark.
4. Avoid every term in the "Avoid" vocabulary list.
5. Match the matching example's posture for the chosen tone — if
   the draft does not measure up to the *"Strong"* example for the
   tone, it must be rewritten.

Skipping any step is a violation of the operating rules.

Final summaries for reporting work must, in addition to naming the
pillar served (framework) and typography level + palette tokens
applied (design system), **name the narrative tone(s) used and
confirm the four-questions pattern is satisfied on every modified
paragraph.**
