# Spectre Payments — Provider Adapter Certification

**Version:** 2026-09-26 (PAY-1C/4)
**Purpose:** A future adapter (TD_AFT, ATB_AFT, RBC_AFT, or any
other real Canadian rail) is not eligible for production execution
merely because a connection is ACTIVE and `PAYMENTS_REAL_MONEY_ENABLED
= true`. Certification is a distinct, code-enforced readiness
concern separate from a per-tenant connection's health.

## Distinction

| Concept | What it describes | Where it lives |
|---|---|---|
| **Connection health** | Whether *this specific tenant's link to a specific rail* is currently usable. Values: ACTIVE / DEGRADED / SUSPENDED / REVOKED. | `PaymentProviderConnection.status`. |
| **Adapter readiness** | Whether the *adapter code itself* is trusted to move real money. Values: DEVELOPMENT / CONFORMANCE_PASSED / SANDBOX_ACCEPTED / PRODUCTION_APPROVED. | `PaymentProviderCertification.readiness`. |

A connection can be ACTIVE while its adapter is not
PRODUCTION_APPROVED. Both must clear before real money moves.

## Readiness ladder

```
DEVELOPMENT
    │
    ▼   (conformance suite passes on adapter)
CONFORMANCE_PASSED
    │
    ▼   (institution's sandbox acceptance recorded)
SANDBOX_ACCEPTED
    │
    ▼   (founder-level approval; simulator refused structurally)
PRODUCTION_APPROVED
```

Downgrade paths (e.g. suspend a previously approved adapter) are
intentionally NOT auto-managed. If evidence emerges that an
approved adapter should not run, the founder invokes an explicit
downgrade (documented; not scripted).

## Certification checklist

An adapter is eligible for `PRODUCTION_APPROVED` only after
demonstrating:

- [ ] Conformance suite passes (`runProviderConformance` — PAY-1B).
- [ ] Sandbox connectivity established against the institution's
      sandbox environment.
- [ ] Idempotency: retry with the same idempotency key returns the
      same `providerInstructionId`.
- [ ] Timeout handling: submission timeout leaves the instruction
      in an ambiguous state, does not create a second economic
      payment on retry.
- [ ] Unknown-outcome handling: any provider status outside the
      normalized set fails closed.
- [ ] Event verification: adapter signs / verifies external events
      per the institution's protocol.
- [ ] Replay protection: duplicate `providerEventId` refused.
- [ ] Out-of-order handling: later "earlier status" events are
      ignored.
- [ ] Settlement accounting: settlement JE produced exactly once
      per instruction.
- [ ] Return accounting: return JE produced exactly once per
      returned instruction.
- [ ] Amount mismatch fail-closed: verified event with amount
      differing from authorized instruction refuses financial
      mutation.
- [ ] Currency mismatch fail-closed: same rule for currency.
- [ ] Provider-reference collision refused (DB unique constraint +
      service check).
- [ ] Provider outage handled without creating second economic
      payments; connection recovers cleanly.
- [ ] Credential rotation exercised via
      `PaymentProviderConnectionVersion` — historical evidence
      preserved.
- [ ] Environment separation enforced: SIMULATOR / SANDBOX /
      PRODUCTION distinct connections with distinct credentials.
- [ ] Tenant isolation preserved: cross-tenant event refused.
- [ ] Accounting integrity across the checklist above.
- [ ] Reconciliation report generated deterministically from
      provider evidence.

## Enforcement

The runtime enforcement lives in `production-gate.ts`:

```ts
await assertProductionExecutionAllowed({
  clubId, providerType, connectionId, runId,
  requiredCapability: "supportsBatchEft",
});
```

The gate refuses if any prerequisite is missing. See §46 of the
PAY-1C brief and `pay1c4-production-gate.test.ts` for enumerated
failure reasons.

## Simulator is structurally excluded

`markProductionApproved("SIMULATOR", ...)` throws. The simulator
adapter declares `movesRealMoney = false` at
`src/lib/payments/provider/simulator.ts:109`; even if a caller
attempts to certify it, the certification service refuses.

## Evidence

Certification evidence is stored on
`PaymentProviderCertification.evidenceJson`:

```json
{
  "conformanceSuite": { "at": "2026-11-01T...", "passedCount": 55 },
  "sandboxCheckpoints": [
    { "name": "sandbox-cert-A", "at": "2026-11-02T...", "note": "TD DEV1" }
  ],
  "productionApproval": { "at": "2026-11-15T...", "by": "founder@spectre.test", "note": "post external review" }
}
```

## Certification is not commercial

Certification proves the adapter can move money safely. It is NOT:

- a commercial agreement with the sponsor institution;
- Payments Canada participation;
- RPAA registration;
- FINTRAC status;
- board-level authorization to onboard clubs to the rail.

Those are separate external workstreams.
