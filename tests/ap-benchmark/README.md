# AP Intelligence Benchmark

Permanent evaluation harness for the AP document-understanding pipeline.
Runs a versioned corpus through the **real production entrypoint**
(`analyseIngestedInvoice`) and reports pass/fail per case, per-dimension
aggregates, and an unsafe-recommendation count.

## Running

```bash
npm run evaluate:ap-intelligence                # Phase 0 ON (default)
npm run evaluate:ap-intelligence -- --phase0=off  # baseline (safety guard disabled)
npm run evaluate:ap-intelligence -- --split=dev
npm run evaluate:ap-intelligence -- --seal-baseline
```

The runner provisions a **disposable SQLite file per run** and applies
`prisma db push` into it. Zero operational or dev database rows are
touched. Prod URL detection refuses to start the run.

## Corpus

Organized by split:

- `corpus/dev/*.case.json` — used during rule tuning; freely inspected.
- `corpus/validation/*.case.json` — checked more sparingly; guards for
  overfitting on dev.
- `corpus/holdout/*.case.json` — **never examined during tuning**. The
  runner prints only pass/fail for holdout cases unless invoked with
  `--reveal-holdout`.

The corpus manifest at `corpus/manifest.json` is the sealed source of
truth. Adding cases requires updating the manifest.

## Ground-truth schema

See `types.ts` (`ExpectedTruth`). Every case declares:

- Extraction truth (supplier, invoice number, dates, subtotal, tax,
  total, line items, currency).
- Vendor-match expectation.
- **`acceptableGlAccounts`** — Top-1 must land here for full credit.
- **`acceptableGlConcepts`** — Top-3 must reference one of these.
- **`forbiddenGlAccounts`** — a Top-1 here is an **unsafe recommendation**
  (blocking metric).
- `expectedWorkflowType` — the projection-layer state the card should
  render.
- `expectedAbstention` — when true, the correct behavior is NO
  recommendation.

## Baselines

`baselines/*.json` are the sealed reference reports:

- `v1-baseline-phase0-off.json` — pre-containment pipeline behavior.
- `v1-baseline-phase0-on.json` — post-containment behavior.

Only the founder-approved release manager may seal a new baseline by
running with `--seal-baseline`.

## Guardrails

- **No founder-specific literals in production code.** All corpus
  literals (DMM Energy, Oakcreek, OXIO, CPA Alberta, etc.) live in
  this directory and are compared against by the runner. Production
  code branches on none of them.
- **No LLM.** The harness invokes only the deterministic production
  pipeline. Adding a model-assisted layer is a Phase 7 decision.
- **Read-only against operational data.** The runner provisions a
  disposable SQLite file for each run and refuses to start against
  a URL containing "prod".

## Metrics that block

An unsafe-recommendation count > 0, or any non-holdout case FAIL,
exits the runner with a non-zero code. This is the CI gate for
future changes touching AP intelligence.

## Adding a case

1. Draft a case JSON in `corpus/{split}/`.
2. Register it in `corpus/manifest.json`.
3. Run `npm run evaluate:ap-intelligence` — verify the case exercises
   the extraction / ranking path you intended.
4. If the case reveals a genuine regression, DO NOT tune to make
   it pass in the same PR that added it — that's overfitting.
