# SIGNUP-2 · Commercial-Authority Verification — Requirements

**Status.** Documentation only.  This document is the SIGNUP-1F
closure artefact for item (3) of the founder's directive — it
captures the verification requirements that MUST be satisfied
before SIGNUP-2 executes the $38,000 CAD subscription agreement.
No code change ships with this document.  Implementation lands in
SIGNUP-2.

**Context.** SIGNUP-1 collects Club identity + verifies the
founding administrator via Microsoft OIDC + runs the automated
ownership classifier.  The classifier is a **preliminary risk
signal** — it answers "do the Microsoft identity, email domain,
and website domain line up with the registered legal name?"  It
does not answer "is this person legally authorised to bind the
Club to a $38,000 CAD annual commitment?"

The second question is **commercial-authority verification** and
is the gate between a verified registration and a billable
subscription.  It applies at the point of subscription
authorisation, not at registration.

**Scope.** Private golf and country clubs in Canada (launch
scope).  Future expansion to US and international jurisdictions
will require locale-specific signatory controls; the structure
below is designed to accept them additively.

---

## Design principles

1. **Preserve the automated classifier as the preliminary risk
   signal.**  Do not replace or diminish it.  Its job is to
   decide, at registration time, whether the applicant looks
   plausible.  Commercial-authority verification is a different
   question, asked at a different moment.
2. **Do not add manual approval to routine registrations.**  A
   club whose automated signals all align, whose signatory
   provides a government ID that matches a corporate-records
   officer entry, and whose Microsoft tenant matches the
   website domain, must flow through without a human in the
   loop.
3. **Human review only on exception.**  Manual-review workload
   belongs on the ambiguous cases — mismatched signatory name,
   signatory not listed as an officer, free-mail Microsoft
   tenant, duplicate-club signal, high-risk province (none
   currently flagged).  The commercial-authority verification
   model MUST surface its decision axis explicitly so manual
   reviewers see what to adjudicate.
4. **Attribution-proof the signatory.**  The person who clicks
   "I authorise $38,000 CAD per year" must be identifiable by
   name, title, government-issued ID, and corporate-records
   match.  "Identified by email" is not sufficient for a
   commercial commitment of this size.
5. **Audit the authorisation moment.**  The subscription
   authorisation record must capture: who signed, what they
   signed, when, from what IP + user agent, against which
   corporate-records evidence, and a notarised signature trail
   that would survive a civil dispute over the contract.

---

## Required artefacts (collected at SIGNUP-2 time)

### A · Signatory identity

The person authorising the subscription must provide:

- **Full legal name.**  Must match a name present in the
  Club's corporate-records officer / director list.
- **Government-issued photo ID.**  Driver's licence, passport,
  provincial ID card.  Collected via a Spectre-side upload
  surface (not via email).  Stored encrypted at rest; retained
  for the duration of the subscription + 7 years for audit
  (CRA-aligned record retention).
- **Current title at the Club.**  Must match the corporate-
  records entry.  Expected roles: General Manager, CFO,
  Treasurer, Board Chair, Director of Finance, Head
  Professional (owner-operator clubs), President.  A title
  not in that list routes to manual review.
- **Microsoft-verified work email** — already captured in
  SIGNUP-1.  Must match the Spectre registration's
  `adminEmail`.

### B · Club commercial-records evidence

- **Jurisdiction + corporate-records lookup.**  For CA
  clubs: provincial registry (e.g. Ontario Business Registry,
  BC Registries, Alberta Corporate Registry, Quebec Registraire
  des entreprises).  Spectre performs the lookup; the
  applicant provides the business number if applicable.  The
  result is cached per registration + attached to the
  authorisation record.
- **Officer / director list from the registry.**  The
  signatory's full legal name must appear in the current
  officer or director list.  If not, routes to manual review.
- **Operating status.**  Must be ACTIVE / IN GOOD STANDING at
  the time of authorisation.  Dissolved, inactive, or
  struck-off entities cannot authorise a subscription.
- **Address match.**  The registered address on the corporate
  record must match (fuzzy) the Club address collected on
  Screen 1 of SIGNUP-1.

### C · Authorisation attestation

At the subscription-authorisation moment the signatory must
affirm, by clicking a specifically-worded consent surface:

> I, [full legal name], serving as [title] of [legal club name],
> am authorised by this organisation to enter into the Spectre
> Automation subscription agreement dated [date].  I confirm
> that the $38,000 CAD annual subscription amount is accepted on
> behalf of the organisation and will be paid under the
> contracted terms.  I acknowledge that this authorisation is
> recorded, auditable, and may be relied upon by Spectre
> Automation in any subsequent dispute.

The attestation record stores: signatory name, title, legal
club name, timestamp, IP, user agent, Microsoft identity oid,
and the SHA-256 digest of the attestation text (so future
textual changes do not retroactively alter prior consents).

---

## Classifier reuse

The existing automated classifier
(`src/lib/signup/org-verification.ts`) continues to run at the
end of Microsoft identity verification.  Its outputs feed the
SIGNUP-2 workflow:

| Classifier decision | SIGNUP-2 default behaviour |
|---|---|
| `AUTOMATED_PASSED` | Proceed to A + B + C.  All auto-pass → authorise.  Any A/B/C exception routes to manual review. |
| `NEEDS_MANUAL_REVIEW` | Hold at a gated state.  Manual reviewer sees classifier signals + awaits A + B + C before releasing. |
| `ESCALATED` | Hold at a gated state.  SpectreAdmin direct-contact required before any A/B/C collection. |
| `OVERRIDDEN` | Treated as `AUTOMATED_PASSED` for SIGNUP-2 purposes; the override reason is attached to the authorisation record. |

**No automatic manual-review ratchet.**  A clean classifier
decision + clean A + clean B + accepted C flows through without
human intervention.  Manual reviewers see only the exception
cases.

---

## Data model (planned — DO NOT implement in SIGNUP-1F)

Three new entities, all created in SIGNUP-2:

### `SubscriptionSignatory`

- Keyed by `SignupRegistration.id`.
- Captures legal name, title, government-ID file reference
  (encrypted), ID type, ID expiry, upload timestamp.
- Mirrored into `Club.subscriptionSignatory` when tenant
  provisioning fires.

### `CorporateRecordsCheck`

- Keyed by `SignupRegistration.id`.
- Captures jurisdiction, business number, registry lookup
  payload (JSONB), officer-match outcome
  (`MATCHED | PARTIAL | NOT_MATCHED`), fetched-at timestamp.
- Cached for the subscription's lifetime; refreshed annually
  on renewal.

### `SubscriptionAuthorisationAttestation`

- Keyed by `SignupRegistration.id`.
- Captures signatory id, attestation-text SHA-256, timestamp,
  IP, user agent, Microsoft oid.
- Immutable; never updated.  Revocation is modelled as a
  separate record linked to the original.

---

## Verification outcomes

- **Pass.**  A green on classifier + A + B + C.  SIGNUP-2
  authorises the subscription, provisions the tenant, and
  issues the first invoice.
- **Hold — awaiting applicant.**  Any of A / B / C incomplete.
  Applicant receives an email (via the SIGNUP-1F recovery-email
  pipeline) with the specific remaining item.
- **Hold — awaiting Spectre review.**  Any classifier exception
  or any A/B/C mismatch beyond the automated-pass path.
  SpectreAdmin reviewer sees a single consolidated screen with
  classifier signals + government-ID preview + corporate-records
  excerpt + the applicant's position + the registered address.
- **Reject.**  Entity not in good standing, signatory name
  absent from officer list AND no alternate justification
  provided, sanctioned-jurisdiction match (reserved; unused
  in CA launch).

---

## Explicit non-requirements (deliberate scope restraints)

The following checks are **NOT** part of SIGNUP-2's
commercial-authority verification:

- Credit scoring the Club or the signatory.  Spectre is not a
  lender; the subscription is a commercial service agreement,
  not credit.
- Beneficial-owner KYC beyond the officer-list match.  Private
  clubs rarely have beneficial owners in the FINTRAC sense;
  the officer-list match is the appropriate control.
- Automated signature capture via DocuSign / Adobe Sign.  The
  attestation surface is Spectre-internal; integration with a
  third-party e-signature vendor is a future enhancement, not
  a SIGNUP-2 requirement.
- Credit-card capture at authorisation.  SIGNUP-2 authorises
  the subscription but does not initiate the first payment —
  payment collection is a separate flow (ACH / wire /
  invoiced) governed by the subscription agreement.  No bank
  debit is initiated by the registration or authorisation
  steps.

---

## Interaction with SIGNUP-1F

SIGNUP-1F ships the registration-recovery infrastructure that
SIGNUP-2 will need to collect A + B + C across devices and
over several days.  Specifically:

- A signatory who starts upload on one device and finishes on
  another relies on the recovery-link path
  (`/signup/resume` → fresh single-use link).
- A signatory whose link expires before upload is complete
  simply requests a fresh one.
- Revocation (operator-triggered) is used when a classifier
  exception is converted to a reject after SIGNUP-2 has
  already issued a link.

No SIGNUP-1F code change is required to enable SIGNUP-2's
commercial-authority flow — the infrastructure is in place.

---

## Open questions deferred to SIGNUP-2 kickoff

1. **Government-ID storage.**  KMS + S3 (reuse the existing
   AWS tenancy backing Spectre's current infrastructure) vs a
   dedicated encrypted bucket per jurisdiction.
2. **Registry API coverage.**  Ontario and BC have modern APIs;
   Quebec and Alberta require workarounds.  First-pass may rely
   on manual review for the gap jurisdictions until API
   coverage is uniform.
3. **Renewal re-verification.**  Annual re-check of
   officer-list match is implicit; the frequency of ID
   re-upload is a founder decision at SIGNUP-2 scoping.

These are implementation details.  They do not change the
requirements captured above.
