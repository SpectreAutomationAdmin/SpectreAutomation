# EP-TRAIN-4Y-BG — Stage 2 plan: real-provider question-generation acceptance

**Status: PLAN ONLY. No paid AI request has been made and none will be made
without a separate, explicit founder authorization immediately before the run.**
Prepared 2026-11-15 for founder review, alongside the Stage 1 evidence in
`PHASE-4Y-BF-REPORT.md`.

---

## 1. What Stage 2 is for

Stage 1 proved the workflow with simulated AI. It cannot say whether the
questions a real model writes are *correct*. Stage 2 runs the real model once,
on one course, under a hard $1.00 ceiling, and checks every generated question
against the transcript.

## 2. Material and tenant

| Item | Value |
|---|---|
| Tenant | Coulee Ridge Golf & Country Club — **staging only** |
| Video | The staff orientation recording whose transcript carries the Silver Springs references (642 seconds, 139 MB) |
| Transcript | Already stored: 163 lines, 9 of them mention "Silver Springs". **No new transcription is needed, so the transcription provider is not called at all.** |
| Course used for the run | A **new** acceptance course created for this purpose, pointing at the same video. The existing draft that holds this video (51 earlier pilot questions) is left untouched. |

**One thing to confirm (§9, decision A):** the staging course literally titled
"Workplace Safety Orientation" is a 42-second demo clip with no transcript. I
have assumed you mean the 642-second orientation recording above, because it is
the one with the Silver Springs transcript.

## 3. What will be generated

One generation run, the same shape a real upload produces for a video of this
length:

| | Count | Type mix requested |
|---|---|---|
| Checkpoint questions (at 5 moments in the video) | 5 | 3 single-choice, 1 true/false, 1 multiple-answer |
| Final-assessment questions | 8 | 4 single-choice, 2 true/false, 2 multiple-answer |
| **Total** | **13** | 7 single-choice, 3 true/false, 3 multiple-answer |

## 4. How each question is judged

Every generated question is checked two ways.

**Automatic checks (no judgement involved)**

| Check | Pass condition |
|---|---|
| Grounding | Every cited transcript line exists and is eligible evidence |
| Timestamp relevance | A checkpoint question cites only lines spoken *before* its checkpoint moment |
| Structure | Right number of options; exactly one correct answer (single-choice, true/false) or two or more (multiple-answer) |
| Clean wording | No internal references left after the clean-up step; nothing rejected for formatting |
| Duplicates | No two questions ask the same thing |
| Type coverage | The mix in §3 was actually produced |

**Review sheet (your judgement, with mine alongside)**

For each question the sheet shows the question, every option, the keyed answer,
the explanation, and the exact transcript lines with their timestamps. Each
question gets a pass or fail on:

1. **Answer correctness** — the keyed answer is what the transcript says.
2. **Distractor quality** — wrong options are plausible, distinct, and clearly wrong.
3. **No fabricated policy** — nothing is asserted that the recording does not say.
4. **Relevance** — it tests something an employee should retain, not trivia.

**Proposed acceptance thresholds (decision B)**

| Measure | Threshold |
|---|---|
| Questions stored after all checks | at least 5 checkpoint and 8 final |
| Answer keys correct | 13 of 13 |
| Fabricated-policy questions | 0 |
| Distractor quality judged acceptable | at least 12 of 13 |
| Checkpoint evidence before its checkpoint moment | 5 of 5 |
| Each of the three types present | at least 2 of each |

## 5. Requests, tokens and cost

| | Value | Basis |
|---|---|---|
| Model | Qwen 2.5 7B Instruct (AWQ) on one A10G GPU | Provider app definition |
| Model requests | **9 at most** (5 checkpoint, 3 final-assessment batches, 1 course title/description) | Plan shape |
| Output cap per request | 2,048 tokens | Enforced inside the provider app |
| Tokens in the comparable real run (15 Nov) | 10,801 in, 3,387 out, across 8 requests | Run record |
| GPU price | $1.10 per hour (plus about 4% for CPU and memory) | Provider's published rates, read today |
| **Expected cost** | **about $0.15 to $0.25** | See below |
| **Hard ceiling** | **$0.78** — under the $1.00 limit | See §6 |

**Why the estimate is credible.** The provider's own billing shows the one real
run on 15 November cost **$0.16**: $0.157 of GPU time (about 513 seconds,
including warm-up and the three minutes the machine idles before shutting
down) plus half a cent of CPU and memory. Stage 2 has the same number of
question requests on a recording of the same length.

A correction to my earlier report: I told you that run cost about $0.11. That
was the application's estimate from the model's reported working time. The
provider's bill, which also counts warm-up and idle time, is $0.16.

## 6. How the $1.00 ceiling is guaranteed

The ceiling does not depend on the model behaving. It follows from limits the
provider itself enforces, multiplied by a request count the application
enforces.

| Layer | Control | Effect |
|---|---|---|
| Provider | Per-request time limit lowered from 15 minutes to **4 minutes** for this run | A stuck request is killed by the provider |
| Provider | **One machine at most** (already set) | Requests cannot run in parallel |
| Provider | Idle shutdown after 3 minutes (already set) | Billing stops shortly after the last request |
| Provider | Output capped at 2,048 tokens per request (already set) | Bounds the work per request |
| Application | Paid-provider lock opened **only for the one acceptance course** | Nothing else on staging can reach the provider during the window |
| Application | **Exactly one run, 9 requests, no automatic retry or repair** | The request count cannot grow |
| Application | Per-course ceiling set to **$1.00** for this course | A request is refused if the projected total could exceed it |

**Worst case, if every one of the 9 requests ran to its 4-minute limit:**
9 × 240 s + 120 s warm-up + 180 s idle = 2,460 seconds of GPU time
= **$0.78** including CPU and memory. That is the most this run can cost.

**What I could not find:** an account-wide spending limit I can set from the
provider's command-line tool (it exposes only two unrelated settings). If the
provider's web dashboard offers a workspace budget, setting it to this month's
spend plus $1.00 just before the run would be a second, independent backstop
(decision C). The guarantee above does not rely on it.

**If any of the provider-side limits cannot be put in place, the run does not
happen.**

## 7. Run procedure (only after your authorization)

1. Confirm the lock is closed and nothing is running (same check as Stage 1).
2. You give explicit authorization for this run.
3. Open the lock for the one acceptance course only.
4. Start the single run. I watch it live.
5. Close the lock the moment the run ends, and re-verify from inside the worker.
6. Read the actual charge from the provider's billing report.
7. Produce the acceptance record: model, tokens per request, provider charge,
   every question with its expected answer and evidence, automatic check
   results, and the review sheet for your pass/fail decisions.

**Stop conditions during the run:** any request refused by the ceiling, any
sign of a second run, or a request exceeding its time limit. In each case I
close the lock immediately and report.

**Emergency stop:** removing one setting restarts the worker and ends the run;
the provider app can also be stopped directly.

## 8. What has to be built first (no paid calls involved)

Stage 2 as you specified it cannot run on today's build. These pieces are
missing:

| # | Gap | Why it matters |
|---|---|---|
| 1 | **Multiple-answer questions are not produced by the AI path.** Managers can write them by hand and employees can answer them, but AI generation only asks for single-choice and true/false, and the checker, approval and publishing steps each refuse a question with more than one correct answer. | Your requirement 4 needs all three types |
| 2 | **True/false is allowed but not ensured.** The 15 November run returned 13 single-choice questions and no true/false. A type mix has to be requested explicitly. | Same requirement |
| 3 | **Lock scoped to one course.** Today the lock is on or off for the whole environment. | Requirement 8: tight control |
| 4 | **$1.00 ceiling and 4-minute request limit** for the acceptance course, on both the application and the provider app. | Requirement 7 and 8 |
| 5 | **Single-run mode** that bypasses automatic retry and repair for the acceptance course. | Keeps the request count fixed at 9 |
| 6 | **Acceptance record and review sheet** generator. | Requirement 6 |

All six are code and configuration changes that I would build, test with
simulated AI, and deploy to staging before asking for your run authorization.
Changing the provider app's time limit means redeploying that app; it makes no
AI request.

## 9. Decisions for you

| | Decision | My recommendation |
|---|---|---|
| A | Is the 642-second orientation recording with the Silver Springs transcript the material you mean? | Yes — it is the only one with that transcript |
| B | Are the thresholds in §4 right? | Yes as a starting point; tighten after the first run |
| C | Will you check whether the provider dashboard offers an account budget, and set it for the run? | Worth doing as a second backstop; not required for the guarantee |
| D | Approve building the six items in §8? | Yes — Stage 2 cannot meet your requirements without them |

## 10. What Stage 2 will not do

- No production deployment and no production data.
- No paid request before your authorization, and none after the run ends.
- No change to the $5 per-course ceiling that applies to normal courses.
- No use of the earlier pilot drafts on this video; they stay as they are.
