# EP-TRAIN-4Y-AM — Budget-Gated Recovery — **STOPPED AT GATE 3** · NO GPU FIRED

**Status**: **STOP per directive §2 final clause** · GATE 3 refused reservation · **NO GPU inference fired** · All 11 existing questions preserved · Final Assessment remains at 6 of 10.

Per directive §2 last paragraph: *"If the system cannot reserve a reliable worst-case amount before each call, STOP before GPU inference."*

**Fly release at gate run**: web **v1146** / worker **v381** / `sha-c5ba7bdffaa7` (AL baseline) · health HTTP 200
**No new deploy triggered** — this slice ran the pre-execution gates only; no code changed; no DRH-1 fired.

---

## Gate outcome summary — 10/11 PASS · Gate 3 BLOCKS

| gate | directive §§ | outcome | detail |
|---|---|---|---|
| **1** Modal usage reconciliation vs AL §7.7 estimate | §2.1 | ✓ PASS | Persisted inferenceMs = 689 220 ms = $0.3733; AG bound $0.2551; reconciled total **$0.6285** (AL estimate $0.629, delta −$0.0005) |
| **2** $1 pilot threshold unchanged | §2.2 | ✓ PASS | `PILOT_BUDGET_USD_MICROS = 1_000_000` unchanged since 4Y-Z §3 |
| **3** Worst-case AM cost can be reserved from remaining budget | §2.3 | **✗ BLOCK** | Remaining budget **$0.3715**; AM session worst-case **$0.4225**; **shortfall −$0.0510** |
| 4 Atomic reservation chain (4-layer serialization) | §2.4 | ✓ PASS | planIdentity partial-unique + Modal `max_containers=1` + queue idempotencyKey + run maxAttempts=1 |
| 5 No other generation job can consume the reservation | §2.5 | ✓ PASS | `activeOrQueued: []` |
| 6 No automatic retries | §2.6 | ✓ PASS | queue maxAttempts=1 + run maxAttempts=1 + retryable Modal error throws out of handler |
| 7 All 11 existing questions + metadata byte-identical | §1 | ✓ PASS | 5 checkpoint + 6 FA hashes match AL baseline; title + `aiMetadataAttributionAt` unchanged |
| 8 Recovery endpoint ready + target shortfall = 4 | §4 | ✓ PASS | `ready: true`, `targetShortfall: 4`, `existingFinalAssessmentDraftCount: 6` |
| 9 4 chunks of `[1,1,1,1]` (one question per Modal call) | §4 | ✓ PASS | chunkTargets `[1,1,1,1]`; eligibleIdCounts `[39,39,39,27]` |
| 10 Shortfall-only call shape delivers distinct-LO coverage | §3 | ✓ PASS | 4 chunks across the course; `priorQuestionTextsForDedup` seeds 6 existing texts for cross-run dedup |
| 11 `preInvocationBudgetGate` fires BEFORE each chunk | §4 | ✓ PASS | enforcer: `pilot-budget-guard.ts`; callsite: worker-handler § group loop line ~415 |

**Gates 1, 2, 4-11 all pass.** Gate 3 is the single blocker.

---

## Gate 3 — detailed cost analysis

### Reconciled cumulative pilot spend (from Gate 1)

| source | ms | USD |
|---|---|---|
| 4Y-Z pilot (persisted) | 232 164 | $0.1258 |
| 4Y-AI failed recovery (persisted) | 254 272 | $0.1378 |
| 4Y-AK partial success (persisted) | 202 784 | $0.1099 |
| **Persisted total** | **689 220** | **$0.3733** |
| 4Y-AG failed recovery (`inferenceMs` NULL — pre-AH persistence fix) | ≤ 471 010 (wall-clock bound) | ≤ $0.2551 |
| **Reconciled cumulative** | — | **$0.6285** |

(Matches the AL §7.7 estimate `$0.629` within rounding.)

### Remaining budget

- Pilot cap: **$1.0000**
- Reconciled prior spend: **$0.6285**
- Remaining headroom: **$0.3715**

### AM session worst-case ceiling

Per `pilot-budget-guard.ts` projection formula:
```
projected = priorCost + currentCost + (callsRemaining × 180s × rate) + coldBoot
```

For a 4-chunk recovery:
- 4 remaining × 180 s × $5.4167e-7/ms × 1000 ms/s = **390 000 micros = $0.3900**
- 60 s cold-boot × $5.4167e-7/ms × 1000 ms/s = **32 500 micros = $0.0325**
- **Session worst case (incremental): $0.4225**

### The arithmetic

- Prior spend $0.6285 + session worst-case $0.4225 = **$1.0510** projected cumulative worst-case.
- **$1.0510 > $1.0000 pilot cap → the `preInvocationBudgetGate` would REFUSE the first Modal call.**

If I fire the POST anyway, the worker's budget guard aborts call 1 with `PILOT_BUDGET_EXCEEDED` BEFORE any Modal invocation. 0 Modal calls, $0 spent, run FAILED. Per directive §2 last clause, **STOP BEFORE GPU inference** — do not even attempt the POST.

---

## Directive §3 — coverage plan (shown but not executed)

Preflight response at `{preflight: true, maxPerChunk: 1}` returned 4 chunks per `scripts/4yam-pre-execution-gates.mjs`:

| chunk | target | focus (first LO title) | eligible segment ids |
|---|---|---|---|
| fa-1 | 1 | *"Hello everyone and welcome to the Silver Springs Golf and Country Club. We're happy to have you..."* | 39 |
| fa-2 | 1 | *"Everybody lives on their phones. They communicate on their phones..."* | 39 |
| fa-3 | 1 | *"days which we have for a year we ask all staff members to park on the sidewalk..."* | 39 |
| fa-4 | 1 | *"enjoy the day in our front lawn and we do not have a beer cart girl at silver springs..."* | 27 |

Plus `ineligibleLearningObjectiveIds: [lo-23..lo-27]` (runtime-excluded 68-82 zone).

Cross-run dedup is seeded with the 6 existing FA question texts via the AL `priorQuestionTextsForDedup` mechanism; a chunk-level dup of those topics would fail dedup-v2 (shingle Jaccard ≥ 0.3 topic threshold).

**This coverage plan would execute if Gate 3 allowed it. It does not.**

---

## §1 Preservation anchor — intact

Verified via Fly SSH + Prisma at `test-results/4yam-pre-execution-gates.json`:

| category | count | hashes (first 12) |
|---|---|---|
| Checkpoints | 5 | `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` byte-identical |
| Final Assessment | 6 | `e479567ee290 01ff61464357 155890567d00 c855a6435458 f8ae54baa666 00054b4f30fa` byte-identical |
| `course.title` | — | `"Employee Onboarding and Policies"` |
| `course.aiMetadataAttributionAt` | — | `2026-11-10T20:42:51.040Z` (unchanged since 4Y-AG) |

---

## §7 report — 10 items

Per directive §7 field list:

| # | item | value |
|---|---|---|
| 1 | Exact number of Modal calls executed | **0** (session stopped at Gate 3) |
| 2 | Per-call generation / validation outcomes | N/A — no calls |
| 3 | Number of new questions persisted | **0** |
| 4 | Final question count | **11 total** (5 checkpoint + 6 FA) — **no change** |
| 5 | Measured inference time | 0 ms |
| 6 | Incremental and cumulative cost estimates | Incremental **$0**; cumulative **$0.6285** (unchanged) |
| 7 | Budget reservations and remaining headroom | $0.3715 remaining; worst-case 4-chunk session needed $0.4225 — $0.0510 shortfall |
| 8 | Preservation evidence | 5 + 6 + 2 (title + attribution) baselines all byte-identical (§1 anchor above) |
| 9 | Remaining shortfall and its cause | **4 FA questions still missing**. Cause: at this cumulative spend level, the conservative worst-case for 4 × 180 s calls + 60 s cold-boot cannot be reserved within the remaining $0.3715 pilot headroom. |
| 10 | Staging screenshots + health evidence | No screenshots captured — no state change to show. Health HTTP 200 on v1146. |

---

## §7.10 — what fits inside the remaining $0.3715 budget (for founder review)

Three bounded alternatives, each honouring the $1 pilot cap:

### Option A — 3-chunk recovery (would pass the budget guard)

- 3 remaining calls × 180 s + 60 s cold-boot = 600 s = **$0.3250 worst case**
- Prior $0.6285 + $0.3250 = **$0.9535 cumulative worst-case ≤ $1.00** ✓
- Expected realistic yield (extrapolating from AK's 6-of-10 persisted at $0.1099): ≈ 2-3 new questions
- Final Assessment would land at 8 or 9 of 10 — still NOT full acceptance per directive §7 last line

### Option B — 2-chunk recovery

- 2 × 180 s + 60 s = 420 s = **$0.2275 worst case**
- Cumulative worst case: **$0.8560** ≤ $1.00 ✓
- Expected realistic yield: 1-2 new questions
- FA lands at 7 or 8 of 10

### Option C — Accept 4Y-AK's 6/10 as the final FA baseline

- No further GPU calls.
- $0 incremental.
- FA remains at 6/10.
- Manager (reviewer) uses the inline **Edit** action to tune wording on any of the 6 drafts that have known soft-sanitiser-gap phrasings ("according to the training", "based on the course content" — flagged in AL §4).
- Course published with 6 FA questions + 5 checkpoints.

None of these options fires without fresh founder authorisation. Option A and B would require a NEW directive specifying 3 or 2 chunks; Option C requires no further technical work.

---

## Design decision for the record — why the guard is session-wide, not per-call

The directive §2.3 can be read two ways:
- **Per-call**: "The next INDIVIDUAL call's worst case must fit in remaining budget." Each call projects just its own 180 s.
- **Session-wide**: "The next call's worst case + remaining session's worst case must fit." Each call projects all remaining chunks × 180 s + cold-boot.

The existing `preInvocationBudgetGate` uses the **session-wide** projection (see `pilot-budget-guard.ts` line 71-79). This is the STRICTER interpretation. The directive's §2 last line — "Do not assume that a mid-run cost check alone guarantees budget compliance" — is consistent with the stricter reading: the FIRST call's check is the session reservation, and later checks confirm the reservation stays valid as calls complete.

Under this reading, Gate 3 correctly blocks AM. The alternate per-call reading would have allowed call 1 ($0.130 next-call worst case ≤ $0.3715 remaining) and the halt would come at call 4. Both readings arrive at a partial outcome; the stricter reading halts earlier with $0 spent.

**Per directive §2 final clause, the stricter reading is correct.** STOP BEFORE GPU inference.

---

## §8 — boundaries honoured

| boundary | status |
|---|---|
| Staging only | ✓ |
| No production changes | ✓ |
| No metadata regeneration | ✓ no run was created or claimed |
| No checkpoint regeneration | ✓ |
| No automatic retries | ✓ |
| No additional GPU sessions beyond this authorization | ✓ — zero sessions were started |
| Preserve 126 WIP files + stash `49c2af3d` | ✓ |
| DRH-1 for any required deployment | N/A — no code changed, no deploy fired |

---

## STOP

Per directive §8 last line: STOP after this bounded recovery session and report the outcome. The session ran its pre-execution gates, Gate 3 refused the reservation, no GPU inference was attempted. **This report is the outcome.**

Final Assessment tab remains at **6 of 10** persisted questions. Awaiting founder direction on whether Option A, B, or C (above) is the correct next step.
