# SIGNUP-2 · Commercial-Authority Verification — Requirements (v2)

**Status.** Documentation only.  Supersedes the first revision of
this document to adopt the founder's delegated-authority model:
Spectre serves Clubs through many internal purchasing paths —
Controllers, General Managers, Head Professionals, Directors of
Finance, Board officers — and the subscription-authorisation
check must verify **delegated commercial authority**, not
corporate-officer status.  Implementation lands in SIGNUP-2;
this doc is the acceptance artefact for item (2) of the SIGNUP-1F
adjustment directive.

**Context.** SIGNUP-1 collects Club identity, verifies the
founding administrator via Microsoft OIDC, and runs the automated
ownership classifier.  The classifier remains the preliminary
risk signal.  Commercial-authority verification is a separate,
later gate that must be satisfied before Spectre issues a signed
subscription agreement for the $38,000 CAD annual commitment.

---

## Core premises

1. **Delegated purchasing authority is the norm.**  In most CA
   private clubs the person who authorises an operating-tool
   subscription is the Controller or General Manager, not a
   named director on the corporate registry.  Spectre must
   accept them without demanding they re-engineer their internal
   signing authority to match the registry.
2. **Preserve the automated classifier as the preliminary
   signal.**  It still answers "do the Microsoft identity,
   email domain, and website domain line up with the registered
   legal name?"  Its decision continues to feed SIGNUP-2.  It
   does NOT answer the authority question.
3. **Domain ownership ≠ authority to bind.**  Owning
   `club.golf` or having a `club.golf` Microsoft tenant is a
   signal, not a mandate.  A Controller with a `club.golf`
   mailbox is not automatically authorised; a GM at a
   boutique-partnership club with a shared-domain mailbox is
   not automatically disqualified.
4. **Risk-based verification.**  Routine signatories pass with
   the baseline evidence set.  Elevated-risk signals bring
   supporting-evidence requirements.  No step is universally
   mandatory — in particular, **government-issued photo ID is
   NOT a universal requirement.**  It is reserved for
   exception paths where the baseline evidence is insufficient
   or where law requires it.
5. **Human review only on exception.**  Manual review is for
   cases the automation cannot resolve, not a universal
   checkpoint.

---

## Who may authorise the subscription

Accepted principal roles (indicative, not exhaustive):

- Controller
- Director of Finance / VP Finance
- General Manager / COO / Chief Operating Officer
- Head Professional (owner-operator Clubs)
- Treasurer / Board Treasurer
- Board Chair / President (where SIGNUP-1 ownership classifier
  signals a Board-direct relationship)
- Corporate officer / director (traditional registry match —
  still accepted, now one path among several)

**All require** a verified Microsoft work-or-school identity in
a tenant whose domain aligns with the Club's registered
business.  Personal Microsoft accounts are rejected
(same gate as SIGNUP-1).

**Rejection paths — zero authority, no appeal:**

- Microsoft tenant unaffiliated with the Club.
- Signatory has an explicit "no authority to procure" record
  in Spectre internal flags (abuse signal from prior Club).
- Entity dissolved / inactive / struck-off at authorisation
  time.

---

## Baseline evidence set — required for every signatory

The baseline is designed so a Controller at a well-formed Club
passes without producing a government ID.

### B1 · Microsoft-verified organisational identity

Already captured in SIGNUP-1 (identity-only OIDC with
`/organizations` authority).  Signals:

- Microsoft tenant id (`tid`).
- Microsoft object id (`oid`).
- Verified email + display name.
- Rejection of personal (`MSA`) accounts enforced upstream.

### B2 · Club affiliation signal

The signatory's Microsoft tenant AND email domain must align
with the Club's registered business via at least ONE of:

- Website-domain alignment (classifier output).
- Microsoft-tenant-primary-domain alignment with the Club's
  registered trading name.
- A pre-existing Spectre record of the signatory at this Club
  (future: once a Club has one authorised Controller, that
  signal strengthens subsequent delegations).

### B3 · Role self-declaration

The signatory enters their current title at the Club.  Not
corroborated by the corporate registry; corroborated by B4
instead.

### B4 · Explicit contractual authority attestation

The signatory affirms, by clicking a specifically-worded
consent surface, that they hold the delegated authority to
bind the Club to the subscription.  The attestation text:

> I, [full name as it appeared in Microsoft], serving as
> [self-declared title] of [Club legal name], confirm that I
> hold the authority — whether as a corporate officer, as a
> designated signing officer, or by written delegation from
> such an officer — to enter into the Spectre Automation
> subscription agreement dated [date] on behalf of the Club.
> I accept, on behalf of the Club, the $38,000 CAD annual
> subscription amount under the contracted terms.  I
> acknowledge that this attestation is recorded, auditable,
> and may be relied upon by Spectre Automation in any
> subsequent dispute, and that making this attestation
> without actual authority is a misrepresentation.

The attestation record persists: signatory name, title, Club
legal name, timestamp, IP, user agent, Microsoft `oid`,
Microsoft `tid`, and a SHA-256 digest of the exact
attestation text at that moment (so textual revisions do not
retroactively alter prior consents).

### B5 · Entity standing

Spectre fetches the Club's corporate-records status at
authorisation time (jurisdiction-appropriate registry: ON,
BC, AB, QC in CA launch — Phase 2 covers the SK/MB/NS/NB/NL/PE
gap jurisdictions).  **Signatory is NOT required to appear
on the officer list.**  The entity must simply be ACTIVE / IN
GOOD STANDING at the authorisation moment.

Dissolved or struck-off entities cannot authorise a
subscription regardless of signatory evidence.

---

## Elevated-risk supporting evidence (exception path)

The baseline above is sufficient for the routine case.  Any
of the signals below promotes the signatory to an elevated
path with additional evidence requirements:

| Signal | Evidence added |
|---|---|
| Automated classifier returned `NEEDS_MANUAL_REVIEW` or `ESCALATED` | Human reviewer sees full evidence packet; signatory may be asked for ONE additional corroborating artefact (e.g. a Club-branded org-chart extract, an officer-written delegation letter) — Spectre defines the artefact; signatory does not pick. |
| Microsoft tenant domain mismatched Club trading-name signal, but SIGNUP-1 passed via other alignment | Signatory provides a short written delegation attestation signed by a corporate officer (name + title + attestation that the signatory holds purchasing authority for operating tools up to a specified annual amount). |
| Signatory self-declares a title not in the standard accepted-role list AND no prior Spectre record exists for this Club | Human reviewer evaluates; may release with no additional artefact or may ask for a delegation letter. |
| First signatory for a Club with no prior Spectre relationship + classifier flag not green | Government-issued photo ID of the signatory, matched against the Microsoft display-name.  **This is the ONLY path on which gov-ID is mandatory.** |
| Suspected impersonation or abuse signal (prior Club disputes signatory status; prior strike against the Microsoft `oid`) | Immediate hold.  Human-review-only release. |

The lowest-common-denominator evidence request is the
elevated-risk path's job — not the baseline's.  **Routine
registrations never land on the gov-ID path.**

---

## Classifier integration

The ownership classifier output continues to drive the SIGNUP-2
workflow:

| Classifier decision | SIGNUP-2 default behaviour |
|---|---|
| `AUTOMATED_PASSED` | Baseline evidence set only.  Attestation accepted; authorisation proceeds. |
| `NEEDS_MANUAL_REVIEW` | Hold at a gated state.  Baseline collected; reviewer sees evidence packet; elevated-risk artefact may be requested. |
| `ESCALATED` | Hold.  SpectreAdmin direct contact required before any artefact collection. |
| `OVERRIDDEN` | Treated as `AUTOMATED_PASSED` for authority purposes; the override reason is attached to the authorisation record. |

**No automatic manual-review ratchet.**  Clean classifier +
clean baseline + accepted attestation flows through.

---

## Data model (planned — DO NOT implement in SIGNUP-1F)

Three new entities, all created in SIGNUP-2:

### `SubscriptionSignatory`

- Keyed by `SignupRegistration.id`.
- Fields: self-declared full name, self-declared title,
  Microsoft `oid`, Microsoft `tid`, verified email, affiliation
  signal source(s).
- Government-ID file reference + encryption metadata are
  **optional columns**, populated only on the elevated-risk
  gov-ID path.  Mirrored into `Club.subscriptionSignatory` when
  tenant provisioning fires.

### `EntityStandingCheck`

- Keyed by `SignupRegistration.id`.
- Replaces the previous revision's `CorporateRecordsCheck`.
- Captures jurisdiction, business number, registry fetch
  payload, standing (`ACTIVE | NOT_ACTIVE | NOT_FOUND`),
  fetched-at timestamp.
- Signatory-vs-officer match is a **soft signal, not a gate**
  — recorded if the registry returns it, but a `NOT_MATCHED`
  outcome does not block authorisation under the baseline
  path.

### `SubscriptionAuthorisationAttestation`

- Keyed by `SignupRegistration.id`.
- Immutable record: signatory id, attestation text SHA-256,
  timestamp, IP, user agent, Microsoft `oid`, Microsoft `tid`.
- Revocation of an attestation is modelled as a separate
  record linked to the original.

---

## Verification outcomes

- **Pass (routine).**  Baseline B1–B5 complete; classifier
  green; attestation accepted.  Authorise, provision tenant,
  issue invoice.
- **Pass (reviewer-released).**  Baseline + one elevated-risk
  artefact + reviewer release.
- **Hold — awaiting applicant.**  Any baseline step pending.
  Applicant receives a fresh single-use recovery email (30 min
  TTL) with the specific remaining item.
- **Hold — awaiting Spectre review.**  Classifier
  `NEEDS_MANUAL_REVIEW` / `ESCALATED` and/or elevated-risk
  signal requiring reviewer judgement.
- **Reject.**  Entity not in good standing; Microsoft tenant
  unaffiliated with the Club; impersonation or abuse signal.

---

## Explicit non-requirements (deliberate scope restraints)

The following are **NOT** required by SIGNUP-2's
commercial-authority verification:

- Universal government-ID collection.  Reserved for one
  specific elevated-risk path (see table above).
- Signatory listed on corporate-records officer / director
  roster.  Recorded as a soft signal when the registry
  provides it, never required for the baseline path.
- Credit scoring of Club or signatory.  Spectre's subscription
  is a service agreement, not credit.
- Beneficial-owner KYC.  Private clubs rarely have beneficial
  owners in the FINTRAC sense; the officer-list match is a
  soft signal only.
- Third-party e-signature (DocuSign / Adobe Sign).  Attestation
  surface is Spectre-internal.
- Credit-card capture at authorisation.  Payment collection
  is a separate flow (see
  [docs/signup-2-payment-architecture.md](signup-2-payment-architecture.md)
  for the SIGNUP-2 payment-provider assessment).  No bank
  debit is initiated by the registration or authorisation
  steps.

---

## Interaction with SIGNUP-1F

SIGNUP-1F ships the registration-recovery infrastructure that
SIGNUP-2's evidence collection relies on:

- The elevated-risk gov-ID upload surface uses the recovery-link
  flow to resume on a different device.
- A signatory whose 30-minute link expires requests a fresh one
  from `/signup/resume`.
- Revocation is used when a classifier exception is converted
  to a reject after SIGNUP-2 has already issued a link.

No SIGNUP-1F code change is required to enable SIGNUP-2's
commercial-authority flow.

---

## Open questions deferred to SIGNUP-2 kickoff

1. **Reviewer surface design.**  SIGNUP-2 ships a SpectreAdmin
   evidence-review screen; its exact layout is a scoping item.
2. **Delegation-letter format.**  For the mismatched-domain
   elevated path, the acceptable format for the written
   delegation attestation (free-form PDF vs structured form)
   is a SIGNUP-2 scoping item.
3. **Elevated-path gov-ID storage.**  KMS + S3 (reuse Spectre's
   existing AWS tenancy) with per-file envelope keys; stored
   only on the specific elevated path, deleted after
   verification + 90 days.
4. **Registry API coverage gap.**  Ontario and BC have modern
   APIs; Quebec and Alberta need workarounds; smaller provinces
   may require manual registry fetch at launch.
5. **Renewal re-verification cadence.**  Fresh attestation at
   each annual renewal is proposed; founder decision at SIGNUP-2
   scoping.

These are implementation details, not changes to the baseline
authority model.
