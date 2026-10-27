# Spectre Automation — SYNTHETIC TEST ONLY Mandate Agreement

> **⚠ SYNTHETIC TEST FIXTURE — NOT A LEGAL AGREEMENT ⚠**
>
> This document exists so that Stripe sandbox technical acceptance
> tests (M2 PATH A) can exercise the attestation + mandate signing
> pipeline end-to-end without presenting the DEVELOPMENT_FIXTURE
> content as legally approved AND without requiring the yet-to-be-
> finalised production Terms of Service.
>
> **This content is NOT a legal agreement, NOT approved by legal
> counsel, and is NEVER shown to a real signatory.** It is served
> ONLY by `signup-2m2-synthetic-sandbox-service.ts` when ALL of the
> following guards pass:
>
> 1. `process.env.FLY_APP_NAME === "spectre-staging"` (production
>    is `spectre-production`; the staging/production app names
>    differ by design).
> 2. `process.env.SPECTRE_SIGNUP_2M2_SYNTHETIC_SANDBOX === "1"`
>    (an explicit test-only flag that defaults OFF).
> 3. `stripeSdkMode() === "test"` (Stripe TEST mode engaged).
> 4. The `SignupRegistration.syntheticTestOnly === true`
>    marker is set on the registration being processed.
>
> Any `SignupRegistration`, `SubscriptionAuthorisationAttestation`,
> `SubscriptionPaymentMandate`, `OperatorVerificationRecord`, or
> `BillingCycle` row produced via this synthetic pathway carries an
> immutable `syntheticTestOnly = true` column. Every Phase 2F
> activation gate, Phase 2G provisioning worker, Phase 2H
> suspension handler, and operational reporting query refuses /
> excludes rows carrying this marker. Synthetic data CANNOT be
> promoted to a real tenant.
>
> **Status of this document is `SYNTHETIC_TEST_ONLY`.** The
> `assertTermsOfServiceApproved()` function in
> `src/lib/billing/terms-of-service.ts` refuses this status
> unconditionally — the production attestation pipeline cannot
> accept this content.
>
> If a human signatory is reading this content on a Stripe
> hosted-Checkout page or in a Spectre signup flow, the sandbox
> guard chain has failed. STOP IMMEDIATELY and escalate.

---

## Version metadata

- **Label:** `ToS-synthetic-sandbox-2026-10-27`
- **Status:** `SYNTHETIC_TEST_ONLY` (not `APPROVED`, not `DEVELOPMENT_FIXTURE`)
- **Jurisdiction:** `N/A — SYNTHETIC TEST FIXTURE`
- **Governing law:** `N/A — SYNTHETIC TEST FIXTURE`
- **Scope:** Stripe sandbox technical acceptance only; no legal
  effect whatsoever.

---

## 1. Nature of this document

This document is a SYNTHETIC TEST FIXTURE for Spectre Automation's
internal engineering validation of the Stripe ACSS Debit sandbox
integration. It is not an offer, not an agreement, not a contract,
and not a representation. The term "Subscriber" below refers to the
synthetic test registration created by Spectre's engineering team
specifically for this test. No real party is a Subscriber under
this document.

## 2. Subscription

This document contemplates no actual subscription. The "CAD $38,000
annual Spectre Automation subscription" referenced in the Stripe
sandbox Price `price_1UVAVnRJ1xiT30028TU0m7A6` and in the Stripe
test-mode Checkout session created from the synthetic registration
is a Stripe test-mode-only Price. No funds will transfer. No club
will be provisioned. No tenant will activate.

## 3. ACSS Pre-Authorized Debit (PAD)

The mandate authorized through Stripe's hosted Checkout page during
this synthetic test is a Stripe test-mode mandate. Stripe test mode
does NOT debit real bank accounts. The mandate text that Stripe
displays to the test operator is Stripe's own standard ACSS mandate
template; it is governed by Stripe's test-mode behaviour, not by
Payments Canada rules.

## 4. Test operator identity

The sole party interacting with this document is Spectre
Automation's founder, acting as a test operator, using Stripe's
published test banking details. No real customer is involved.

## 5. Data lifecycle

All synthetic rows produced by this test:

- Carry `syntheticTestOnly = true` as a database column.
- Are excluded from Spectre's operational reporting queries.
- Are refused by Phase 2F activation, Phase 2G provisioning, Phase
  2H suspension, and the normal mandate-collection and
  mandate-return handlers.
- Are torn down by `teardownSyntheticTestFixtures()` at the end
  of each test window.

## 6. No legal effect

NOTHING in this document creates, modifies, or implies any legal
right or obligation of any party. This document exists solely so
that the technical attestation pipeline can be exercised against a
non-fixture, non-production SHA-256 reference. The production
Terms of Service, once drafted and legally approved by the
founder and counsel, will supersede this fixture entirely for all
real signup paths — this synthetic doc remains in-repo as a test
scaffold only.

---

End of synthetic test fixture.
