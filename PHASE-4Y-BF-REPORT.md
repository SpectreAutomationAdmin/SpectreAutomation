# EP-TRAIN-4Y-BF — Stage 1 report: simulated acceptance complete

Date: 2026-11-15. Staging only. **No paid AI request was made in this work.**
The Stage 2 (real provider) plan is in `PHASE-4Y-BG-STAGE2-PLAN.md`.

**This report proves the workflow and its safeguards with simulated AI. It does
not prove that real AI produces good questions.** That is what Stage 2 is for.

---

## 1. Bottom line

| Requirement | Result |
|---|---|
| Automated tests cannot cause AI charges, even with every test marker missing | Done. Proven by unit tests, by a check inside the live worker, and by a browser test that sends no marker |
| Two requests cannot create two generation runs | Done. Enforced in the database; proven with concurrent requests locally and on staging |
| Formatting-only AI defects are repaired instead of discarded | Done. The 13 real proposals from 15 Nov: **5 of 5 checkpoint and 8 of 8 final questions survive** (was 0 and 4) |
| Upload → automatic preparation → review, no manager action | Unchanged and re-proven in a browser, 9 scenarios, all passing |
| New paid AI usage during this work | **None.** Confirmed from the provider's own billing |

## 2. Root causes corrected

| # | What went wrong | What now prevents it |
|---|---|---|
| 1 | A test upload lost its "mock" header and was treated as a real upload | Whether an upload is a test is decided by **who is logged in**, on the server. A dedicated robot account is always simulated. A header can only tune a simulation; it can never select real processing |
| 2 | Nothing stopped staging from reaching the paid provider | A lock in front of every provider call. Staging ships **locked**; real processing is refused before any connection is opened |
| 3 | A second upload started a second run beside the first | One workflow per course version, enforced under a database lock. The outcome of a run that was already in flight is kept, so a re-upload tops up what is missing instead of starting over |
| 4 | Sound questions were thrown away for wording | A deterministic clean-up step before the existing checks. It only deletes, never rewrites, never touches the answer key or the source references, and refuses whenever the model's own key disagrees with the structured key |

Further fixes found by an independent review of this change, all applied before deploy:

- A job waiting behind another job is no longer mistaken for a lost job (it used to be retired and re-created, wasting an attempt).
- A retryable transcription failure is now actually retried.
- An unexpected worker error hands the work back to the queue instead of leaving it stuck for 16 minutes.
- The clean-up step was narrowed after review found sentence shapes it could have damaged (for example "which technique **was shown in** the video?"). It now touches only unambiguous asides.
- Test accounts and real accounts are kept apart in both directions, so a test can never leave a real course marked "simulated".
- Five older browser specs that log in as the founder and start real AI work are now inert unless explicitly switched on for one command.

## 3. Evidence: tests cannot incur AI charges

**Inside the live staging worker** (the process that holds the real provider
credentials), each of the three provider call types was invoked with those
credentials and a stand-in network:

| Call type | Result | Reached the network layer |
|---|---|---|
| Transcription | Refused: locked | No |
| Question generation | Refused: locked | No |
| Course title/description | Refused: locked | No |

Run twice — after deploy and again after all testing. Network calls: 0 both times.

**In the browser, with no test marker at all** (scenario 4): the upload request
carried none of the test headers, and the course was still simulated end to
end. The database shows a simulated authorization, a non-billable marker
written before the video was stored, a simulated transcript, zero provider
time, and both queue entries flagged non-billable.

**Unit tests** (provider replaced by a tripwire that fails the test if called):
a test-created course whose authorization says "real", with billing switched
on and credentials present, still never reaches the provider — for question
generation, for transcription, on a retry after a simulated worker crash, and
when simulation is not allowed (it is refused, not sent).

**Before any upload**, every browser test asks the server to confirm isolation.
Recorded answer: test account recognised (two independent ways), simulation
allowed, paid provider LOCKED. On a build without isolation this check fails
and nothing is uploaded.

**A real account is unaffected:** the same check answers "not found" for the
founder's login, and a real manager's plain upload is still authorized and
started automatically (unit-tested). While staging is locked such an upload is
not processed; see §8.

## 4. Evidence: no duplicate runs

| Test | Result |
|---|---|
| Two simultaneous requests with different plans | One run, one queue entry; both callers get the same run |
| Five simultaneous requests | One run |
| The 15 Nov incident replayed: second upload while the first run is live | No second run |
| Second upload, first run then finishes with one question missing | A repair for that **one** question; final total 13, not 22 |
| Upload, watchdog and duplicate upload at the same instant | One run |
| Two upload completions with no transcript yet | One transcription job |
| Same queue entry delivered twice | Work done once; the 13 stored questions byte-for-byte unchanged |
| Run superseded while the provider is still answering | The old worker stores nothing |
| **Staging, browser:** two uploads at the same moment plus a third mid-flight | 1 transcription job, 1 run, 13 questions (scenario 6) |

## 5. The 13 real proposals, replayed through the full pipeline

Captured verbatim from the 15 November run and fed back through the complete
pipeline locally (no AI call): grounding → clean-up → wording check →
structure check → duplicate check → storage → answer validation.

| Group | Returned by the model | Kept on 15 Nov | Kept now |
|---|---|---|---|
| Checkpoint 1 | 1 | 0 | 1 |
| Checkpoint 2 | 1 | 0 | 1 |
| Checkpoint 3 | 1 | 0 | 1 |
| Checkpoint 4 | 1 | 0 | 1 |
| Checkpoint 5 | 1 | 0 | 1 |
| Final batch 1 | 3 | 1 | 3 |
| Final batch 2 | 3 | 2 | 3 |
| Final batch 3 | 2 | 1 | 2 |
| **Total** | **13** | **4** | **13** |

- 10 proposals were changed (the 9 rejected ones, plus one accepted question that carried a stray citation list). None was refused.
- Every stored question passes the unchanged wording check; answer keys and source references are identical to the model's.
- All 13 are marked "needs human review". The clean-up step does not judge facts; one of the recovered final questions is only loosely supported by its transcript lines and is exactly the kind of thing manager review — and Stage 2 — must catch.
- Original and cleaned text are both kept in restricted diagnostics; an audit row records which rules were applied.

## 6. Browser acceptance on staging (simulated AI)

Run as the robot account on build `db7a5e64`. Screenshots are in
`test-results/4ybf/` on this machine (not committed).

| # | Scenario | Result | Key evidence |
|---|---|---|---|
| 1 | One upload, hands off, all seven stages | Pass | Transcribing: running → done. Checkpoints and final: waiting → queued → running → done. Review screen appeared by itself after 34 s; 5 checkpoints, 8 final, 5 timeline markers |
| 2 | Refresh during generation, then leave and return | Pass | Progress never went backwards; course ready on return |
| 3 | A missing question is repaired automatically | Pass | Run 1 stored 12; a second run asked for exactly 1; total 13 |
| 4 | No test marker of any kind | Pass | Still simulated (see §3) |
| 5 | Badly formatted AI output | Pass | 13 of 13 repaired and kept; nothing internal visible to the manager |
| 6 | Two uploads at once, third mid-flight | Pass | 1 job, 1 run, 13 questions |
| 7 | The previously blocked real course, looked at only | Pass | Read-only screen, no controls, no internal wording |
| 8 | Worker restarted mid-generation | Pass | Dead run retired after its lease expired, replacement completed; 13 questions, none from the dead run. Recovery took 17.5 minutes |
| 9 | Another club's course | Pass | Status, video, upload and generate all "not found"; the app returns to its own club's list |

Requirement-by-requirement (your list of twelve): 1–3 → scenario 1; 4–5 →
scenario 2; 6 → scenario 6 and §4; 7 → scenario 8; 8 → scenario 5 and §5;
9 → every scenario (5 checkpoint + 8 final stored each time); 10 → five
markers, five checkpoint events at 105, 216, 322, 427 and 538 seconds, each
bound to a checkpoint question; 11 → scenarios 1, 2 and 7; 12 → §3.

## 7. Deployment record

| | |
|---|---|
| Commit | `db7a5e64` |
| Web | v1167, image `sha-db7a5e64af93` |
| Worker | v400, image `sha-db7a5e64af93` (matches) |
| Health | HTTP 200 |
| Rollback anchors | web v1166, worker v399 (both `sha-6147e6badee6`) |
| Worker deploy | Yes — worker code changed |
| Migration | None |
| Log scan after release | No application errors. Worker warnings are the existing mailbox-refresh warnings, unrelated |
| Deployed through | DRH-1 |
| Unrelated work in progress and the existing stash | Untouched |

Later commits on the branch add this report, the Stage 2 plan, the browser
specs and two operator scripts. They change no running code, so staging was
not redeployed for them.

## 8. No new paid AI usage

| Source | Finding |
|---|---|
| Provider billing, 15–16 Nov (read at 21:34 UTC) | One billed hour: 05:00 UTC on 15 Nov, **$0.1628** — the unintended run already reported. Nothing else |
| Database, since that run ended | 9 generation runs and 7 transcription jobs created by this testing; **all with zero provider time**; no real authorization recorded |
| Live work right now | None |

Correction: I previously reported the unintended run as about $0.11. The
provider's bill is **$0.16**; the difference is warm-up and idle time the
application does not see.

**Staging is locked.** A video you upload on staging now will be accepted and
then show "Spectre couldn't finish preparing this course automatically" until
the lock is opened for an authorized run. That is deliberate.

## 9. The robot account

| | |
|---|---|
| Created | With your approval, for this run: "E2E Test Account (automated - do not use)", `e2e-training-test@example.test`, club-manager role on the Coulee Ridge staging club only |
| Deactivated | Yes, after the last scenario. Status disabled, role removed, password replaced with an unusable value |
| Sessions | Ended. Every request re-checks the account; a disabled account is refused. Confirmed: sign-in now answers "This account is not active" |
| Local password | Removed from this machine |
| To run the suite again | The provisioning script re-enables it with a new password |

## 10. Outstanding issues

1. **Real AI quality is unproven.** Stage 2.
2. **Multiple-answer questions are not generated by AI**, and true/false is allowed but was not produced in the one real run. Both are prerequisites for Stage 2 (see the plan).
3. **Recovery after a worker crash takes about 17 minutes**, because a run's lease is 15 minutes. Safe, but slow; it can be shortened.
4. **A one-second flicker** on the preparation screen between transcription finishing and questions starting ("taking longer than usual"). Cosmetic.
5. **Transcript lines 16–17, 68–82 and 160–161 are excluded as evidence for every course.** Those numbers were tuned for the Silver Springs transcript. For any other video they hide about 90 seconds of content from question writing. Needs to become per-transcript.
6. **Nine pre-existing test failures** in five older test files, unrelated to this change (they predate it). The training suite was 43 failures before this work; the 34 in the area I touched are fixed.
7. **Test courses remain** in the staging course list as "Untitled training course" drafts (about ten, including earlier ones). I can remove them if you want.
8. **The blocked real course is untouched**, as instructed.

## 11. Validation record

- **Files changed:** 57 in commit `db7a5e64` (training pipeline, upload route, queue handlers, deploy config, tests); plus this report, the Stage 2 plan, three operator scripts and two browser specs afterwards.
- **Validation performed:** typecheck (85 errors, identical to baseline, none in touched files); placeholder scan (no new hits); full training unit suite 1,359 passed / 9 failed (the 9 are pre-existing, see §10.6); 158 new tests for this change, all passing; lock check inside the staging worker twice; 9 browser scenarios on staging; provider billing read.
- **Validation intentionally skipped:** the non-training test suites (no shared code changed outside training and its queue handlers); real-provider run (not authorized — Stage 2).
- **Remaining risk:** behaviour with the lock open has only been unit-tested, by design. The first real run should be the controlled Stage 2 run, not an ordinary upload.
