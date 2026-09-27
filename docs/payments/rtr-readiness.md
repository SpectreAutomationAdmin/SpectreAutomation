# Spectre — RTR (Real-Time Rail) Readiness

**Version:** 2026-09-26 (PAY-1C/5)
**Status:** Architecture & readiness analysis only. Spectre is NOT
connected to Payments Canada. Spectre is NOT an RTR participant.
This document identifies architectural readiness, likely gaps, and
external unknowns. It is not a Payments Canada specification and
does not claim conformance.

**Strategic target:**

```
Spectre  →  RTR participation / connectivity
         →  settlement agent
         →  RTR
         →  recipient financial institution
```

Spectre does NOT intend to be a direct settlement participant at
initial launch. Settlement-agent routing is intentional.

---

## 1. Distinction between "known" and "assumed"

Payments Canada RTR technical requirements are subject to
Payments Canada's authoritative specifications. Spectre does not
have direct access to those specifications; the notes below
distinguish:

- **[Architectural — Known from Spectre design]** — statements
  about Spectre's own architecture (verifiable from the codebase).
- **[Industry-typical assumption]** — statements based on generally
  known RTR-class rail properties (ISO 20022, 24/7, immediate
  response, end-to-end ID). Spectre treats these as architectural
  hypotheses to be replaced with the actual specification once
  Payments Canada or a settlement-agent partner provides it.
- **[Requires Payments Canada / settlement-agent specification]**
  — flagged unknowns; MUST be resolved before real RTR work.

## 2. Architectural readiness — where Spectre stands today

| Concern | Spectre position |
|---|---|
| End-to-end identifier stable across retries | **[Architectural — Known]** Deterministic `E2E-v1-…` per PaymentInstruction. See `src/lib/payments/rail/canonical.ts`. |
| Amount + currency precision preserved | **[Architectural — Known]** Decimal-safe strings; float refused in fingerprint canonicalisation. |
| Immutable authorized instruction | **[Architectural — Known]** PaymentInstruction + PaymentAuthorization frozen at authorization. |
| Rail-neutral canonical representation | **[Architectural — Known]** `CanonicalRailInstruction` decouples economic identity from transport encoding. |
| ISO 20022 conceptual mapping | **[Architectural — Known]** See `canonical-rail-mapping.md`. |
| Provider adapter certification separate from connection health | **[Architectural — Known]** `PaymentProviderCertification` readiness ladder. |
| Central production-execution gate | **[Architectural — Known]** `assertProductionExecutionAllowed` refuses when any prerequisite is missing. |
| Payment incident model with reconstruction timeline | **[Architectural — Known]** PaymentIncident + PaymentIncidentLink. |
| Fail-closed default under uncertainty | **[Architectural — Known]** Every unknown provider/environment/connection/authorization case refuses. |

## 3. Likely gap areas — 24/7 & immediate-response operation

RTR-class rails typically require 24/7 availability and short
message-round-trip times. Spectre today runs on Fly.io with a
web + worker split; the worker polls at 1000 ms. Gaps:

- **[Industry-typical assumption]** RTR responses are expected
  within a small number of seconds (single-digit).
- **[Architectural — Known]** Spectre's `scheduleAndSubmit` runs
  synchronously in the web request. For RTR-class payments this
  either needs to remain synchronous with a tight timeout, or move
  to a dedicated real-time queue. This decision is deferred to
  PAY-1D+ post specification.
- **[Requires Payments Canada / settlement-agent specification]**
  Actual SLA + retry semantics for late responses.

## 4. Likely gap areas — availability & disaster recovery

- **[Architectural — Known]** Fly.io region `iad`, single primary.
  Adequate for staging; will require multi-region + documented DR
  runbook before RTR participation.
- **[Requires Payments Canada / settlement-agent specification]**
  Formal availability + BCP + evidence requirements.

## 5. Likely gap areas — message integrity + security

- **[Architectural — Known]** ExternalPaymentEvent verification
  pipeline exists (`external-events.ts:154`) and refuses unverified
  events.
- **[Industry-typical assumption]** RTR message integrity likely
  requires mTLS + payload signing beyond the current HMAC used for
  the simulator webhook. Adapter-level, not Spectre-core.
- **[Requires Payments Canada / settlement-agent specification]**
  Exact cryptographic requirements.

## 6. Likely gap areas — ISO 20022 conformance

Spectre's canonical mapping (`canonical-rail-mapping.md`) covers
the fields likely required for pain.001 / pain.002 / camt.053 /
camt.054-class messages. Gaps identified:

- **[Requires Payments Canada / settlement-agent specification]**
  Charge bearer, purpose code catalog, remittance-info structured
  vs. unstructured limits, initiating-party identification codes.
- **[Requires Payments Canada / settlement-agent specification]**
  Exact XML schema version required.

## 7. Likely gap areas — fraud + risk

- **[Architectural — Known]** Rail-neutral duplicate-business
  -payment guard + rail-neutral limits at
  `src/lib/payments/duplicate-guard.ts` +
  `src/lib/payments/limits.ts`.
- **[Industry-typical assumption]** RTR-class rails likely require
  additional real-time fraud scoring. Spectre does not build an ML
  fraud engine at this stage.
- **[Requires Payments Canada / settlement-agent specification]**
  Whether responsibility for fraud scoring sits with Spectre,
  the settlement agent, or the sponsor bank.

## 8. Likely gap areas — settlement + reconciliation

- **[Architectural — Known]** Spectre records settlement JEs on
  VERIFIED settlement events. Return accounting is per-instruction.
- **[Requires Payments Canada / settlement-agent specification]**
  Reconciliation-message cadence, format, and rules for the
  settlement-agent relationship.

## 9. Likely gap areas — operational incident escalation

- **[Architectural — Known]** PaymentIncident + severity + timeline
  reconstruction.
- **[Requires Payments Canada / settlement-agent specification]**
  Actual RTR incident escalation contract with Payments Canada +
  settlement agent + participating financial institutions.

## 10. Explicit non-goals

- Spectre will NOT initially operate as a direct RTR settlement
  participant.
- Spectre will NOT hold pooled client funds.
- Spectre will NOT initially operate independent liquidity for
  RTR settlement.

## 11. Sequence

RTR readiness follows sponsor-bank AFT readiness. The likely path
is:

1. Sponsor bank AFT sandbox → sponsor bank AFT production
   (indirect settlement via sponsor).
2. Settlement-agent relationship established with an RTR-connected
   institution.
3. Adapter for the settlement agent developed against their
   sandbox.
4. Payments Canada participation formalized to whatever extent
   required for the chosen structure.

## 12. Referenced external unknowns

See `external-unknown-register.md` for the definitive list of items
Spectre must obtain from Payments Canada / settlement agent /
counsel before implementing any RTR-facing adapter.
