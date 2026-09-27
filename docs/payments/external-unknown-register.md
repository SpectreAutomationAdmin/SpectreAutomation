# Spectre Payments — External Unknown Register

**Version:** 2026-09-26 (PAY-1C)
**Purpose:** Enumerate what Spectre still needs from external
parties before real-money payment infrastructure can be built. Every
row is an EXTERNAL blocker — not something Spectre can solve
internally by writing more code.

**Rule:** entries here are named honestly. If Spectre does not know
the answer, this document says so — it does NOT fabricate an
answer. PAY-1D cannot begin until the necessary rows have been
resolved.

---

## 1. Legal / regulatory (Canadian payments counsel)

| # | Question | Why it matters | Blocking phase |
|---|---|---|---|
| L-1 | RPAA registration requirement — is Spectre a Payment Service Provider requiring registration under the Retail Payment Activities Act? | Determines whether Spectre must register with Bank of Canada, what supervisory obligations apply, capital / operational requirements. | PAY-1D |
| L-2 | FINTRAC / MSB determination — do Spectre's payment activities qualify as Money Services Business? | Reporting obligations, KYC, AML. | PAY-1D |
| L-3 | AML / KYC obligation allocation — Spectre vs. sponsor institution vs. member clubs. | Onboarding flow design. | PAY-1D |
| L-4 | Agency / mandatary characterization — the legal relationship between Spectre and each customer club when Spectre transmits their payment. | Contractual + regulatory implications. | PAY-1D |
| L-5 | Sponsor-bank contractual structure — who holds what liability. | Commercial terms + risk allocation. | PAY-1D |
| L-6 | Provincial money-services considerations (e.g. Quebec money-services licence). | Multi-jurisdiction obligations. | PAY-1D |
| L-7 | Data-residency + cross-border-transfer requirements for Spectre's payment data. | Infrastructure choices. | Advisory. |

## 2. Sponsor bank / clearing institution

| # | Question | Why it matters | Blocking phase |
|---|---|---|---|
| S-1 | Supported connectivity — API, host-to-host, SFTP, ISO 20022 pain.001, etc. | Adapter design. | PAY-1D adapter. |
| S-2 | Authorization model — is Spectre's authorization sufficient, or must each customer re-approve via bank portal? | Product viability. | PAY-1D. |
| S-3 | AFT specification — exact record layouts, batch semantics, cutoffs, acknowledgement format, return format. | Adapter implementation. | PAY-1D. |
| S-4 | Sandbox availability + credentials. | Adapter development. | PAY-1D. |
| S-5 | Certificates / mTLS / IP allowlisting requirements. | Deployment infrastructure. | PAY-1D. |
| S-6 | Acknowledgement + rejection semantics (file / record). | External-event handling. | PAY-1D. |
| S-7 | Return codes catalog. | Operational runbook accuracy. | PAY-1D. |
| S-8 | Reconciliation reporting cadence + format. | Three-way reconciliation implementation. | PAY-1D+. |
| S-9 | Per-transaction / daily / exposure limits. | Limit configuration. | PAY-1D. |
| S-10 | Liability allocation for fraud / unauthorized payment / returns. | Contractual + risk design. | PAY-1D. |
| S-11 | Settlement structure — indirect via sponsor vs. some prefunding arrangement. | Custody model + capital planning. | PAY-1D. |
| S-12 | Multi-customer / multi-originator support — how does Spectre onboard many club customers through one sponsor relationship? | Product architecture. | PAY-1D. |

## 3. Payments Canada / RTR

| # | Question | Why it matters | Blocking phase |
|---|---|---|---|
| P-1 | Membership / participation requirements for the Real-Time Rail. | RTR path planning. | Post-AFT. |
| P-2 | Settlement-agent options — which existing RTR-connected institutions are willing to act as settlement agent for a PSP like Spectre? | Structural decision. | Post-AFT. |
| P-3 | RTR ISO 20022 message schema version + Canadian extensions. | Adapter design. | Post-AFT. |
| P-4 | RTR fraud / risk requirements — who is responsible for what. | Architecture decisions on Spectre's fraud scoring vs. settlement-agent vs. sponsor. | Post-AFT. |
| P-5 | RTR availability + response-time SLA. | Infrastructure requirements. | Post-AFT. |
| P-6 | Certification / testing process for RTR participation. | Timeline planning. | Post-AFT. |

## 4. Insurance + assurance

| # | Question | Why it matters | Blocking phase |
|---|---|---|---|
| I-1 | Cyber insurance requirements for a payment operator. | Business insurance procurement. | PAY-1D. |
| I-2 | SOC 2 Type II readiness — required by sponsor institutions? | Certification effort. | PAY-1D. |
| I-3 | Penetration-test requirements + cadence. | Security programme. | PAY-1D. |
| I-4 | Business-continuity + disaster-recovery documentation and testing requirements. | Ops programme. | PAY-1D. |
| I-5 | Bond / financial-guarantee requirements from any of the above. | Capital planning. | PAY-1D. |

## 5. Operational

| # | Question | Why it matters | Blocking phase |
|---|---|---|---|
| O-1 | 24/7 operational coverage requirements from RTR / sponsor. | Staffing model. | Post-AFT. |
| O-2 | Incident escalation contract with sponsor bank. | Incident response runbook completion. | PAY-1D. |
| O-3 | Sponsor's own incident reporting obligations to Spectre. | Data model completeness. | PAY-1D. |

---

## What Spectre WILL NOT do

- Spectre will not begin PAY-1D until the S-1..S-12 rows (or the
  minimum subset required for a single adapter) are answered by a
  named sponsor institution in writing.
- Spectre will not enable `PAYMENTS_REAL_MONEY_ENABLED` on any
  environment until the corresponding legal (L-1..L-5) + insurance
  (I-1..I-5) rows are answered and a founder-level approval is
  recorded.
- Spectre will not attempt RTR participation until the AFT path
  is operational + P-1..P-6 rows are resolved.

## What Spectre CAN do without external answers

- Continue exercising the simulator on staging (PAY-1C is
  synthetic).
- Refine documentation as counsel + institution conversations
  advance.
- Harden internal controls further (limits, incidents,
  reconciliation).
- Prepare pilot clubs contractually.

## Change control

Rows must be updated as answers arrive. An "unknown" that has been
answered externally must move to a resolved section (or into
`sponsor-bank-requirements.md` for the answered version).
