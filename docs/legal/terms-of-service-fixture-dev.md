# Spectre Automation -- Subscription Terms of Service

> **DEVELOPMENT FIXTURE -- NOT APPROVED FOR LEGAL USE**
>
> This document is a placeholder shipped alongside SIGNUP-2
> Phase 2B scaffolding so the attestation pipeline can be
> exercised end-to-end under development + staging acceptance
> tests ONLY.
>
> **No real signatory may be presented with this text.**  The
> Phase 2B attestation workflow refuses to activate until the
> environment flag `SPECTRE_SIGNUP_2B_ATTESTATION_LIVE` is set
> to `1`, AND the operator confirms that the ToS content
> served at acceptance time is the founder/legal-approved
> final version (not this fixture).
>
> Replacement procedure:
> 1. Final ToS content is reviewed + approved by the founder and
>    legal counsel.
> 2. A new file `docs/legal/terms-of-service-v1.md` is created
>    with the approved content.
> 3. The feature flag flips.
> 4. The `src/lib/billing/terms-of-service.ts` helper reads from
>    the new file.
> 5. This fixture file is kept in-repo as the development
>    scaffold but is **not** served to any real signatory.
>
> If you are seeing this content outside a development or
> staging-acceptance test context, something is wrong.  Stop
> and escalate to the founder.

---

## Version metadata

- **Label:** `ToS-dev-fixture-2026-10-25`
- **Status:** `DEVELOPMENT_FIXTURE` (not `APPROVED`)
- **Jurisdiction:** Province of Ontario, Canada (placeholder)
- **Governing law:** TO BE DETERMINED BY LEGAL COUNSEL

---

## 1. Parties

This Agreement is between **Spectre Automation Inc.** (operating
under `spectreautomation.com`) and the subscribing private club
("Club") whose authorised signatory accepts this Agreement
through the Spectre registration workflow.

## 2. Subscription

The Club subscribes to Spectre's SaaS platform at an annual
subscription of **CAD $38,000** per Club.  The subscription
automatically renews annually unless cancelled per Section 7.

## 3. Payment

Payment is collected via Pre-Authorized Debit (PAD) through
Payments Canada's ACSS network, authorized by a mandate the
signatory accepts separately in the signup workflow.

## 4. Signatory authority

The signatory confirms, at the moment of acceptance, that they
hold delegated commercial authority to bind the Club to this
subscription on the Club's behalf.  Spectre records the
signatory's full name, title, Microsoft-verified identity, IP
address, user agent, timestamp, and the SHA-256 hash of the
exact text they accepted.

## 5. Access tiers

Spectre provides a staged onboarding period during which the
Club may configure Club identity, department structure, user
invites (queued), and initial accounting data.  Full
operational access -- posting GL journals, running payroll,
member billing, operational email, portal publishing -- is
unlocked only after the first annual payment settles and
reconciles.

## 6. Data retention

Attestation + mandate records are retained for 7 years after
the subscription ends, per Payments Canada Rule H1 Section 23
and Spectre's internal retention policy.

## 7. Cancellation

The Club may cancel at any time by notifying Spectre's
operator team or by cancelling the ACSS mandate with their
bank.

## 8. [TO BE EXPANDED BY LEGAL COUNSEL]

Standard SaaS Terms of Service clauses -- liability, warranty,
dispute resolution, confidentiality, data protection, service
level, etc. -- will be drafted by legal counsel and inserted
here before the live attestation workflow is enabled.
