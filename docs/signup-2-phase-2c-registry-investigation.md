# SIGNUP-2 Phase 2C — Canadian Corporate Registry Access Investigation

**Status.** Investigation artefact.  Per founder §3 (Phase 2C
authorisation), authoritative registry access was investigated
BEFORE implementing any live adapter.  This document records the
findings and justifies the Phase 2C baseline decision to ship ALL
jurisdictions as manual-review stubs.

**Date.** 2026-10-25.

**Methodology.** Public-source review of each province's registry
service, licensing framework, and terms of use.  No credentials
were procured and no outbound registry calls were made during
investigation.

---

## 1. Alberta (CA-AB) — Verdict: `MANUAL_REVIEW_REQUIRED`

- Alberta Corporate Registry Office (ARO / CORES) has no public
  programmatic API documented by Service Alberta.
- Citizen-facing searches direct through authorised **registry
  agents** who charge a government fee plus a service fee.  The
  authoritative Standing artefact is a **Certificate of Status**.
- Service Alberta's "Registries On-Line Access" exists for eligible
  subscribers, but the subscriber-application form explicitly
  prohibits re-registering, retrieval, resale, or re-distribution
  of registry data on behalf of third parties.  This clause is
  fatal for a SaaS vendor verifying its own customers.
- Third-party aggregators exist (Topograph, Apify "Canada Company
  Data", Cobalt) but are not authoritative and carry no SLA; using
  them as the basis for a Phase 2C `PASS_AUTOMATED` decision would
  violate the founder's §2 "Do not fabricate" directive.
- Scraping is operationally and legally risky even where the
  Alberta.ca ToU does not explicitly name "scraping": the
  subscriber-agreement prohibitions and the SEDAR+ precedent make
  automated scraping untenable.

**Phase 2C decision:** route every CA-AB registration through the
manual-review stub.  Operator triage (Phase 2H) obtains the
Certificate of Status through an authorised agent.

---

## 2. Ontario (CA-ON) — Verdict: `MANUAL_REVIEW_REQUIRED` for Phase 2C baseline

- The Ontario Business Registry (OBR, launched 2021 by the Ministry
  of Public and Business Service Delivery) has no open public API.
- Access is gated through the Ministry's **Authorised Service
  Provider** licence programme.  As of 1 Feb 2025 the licensees are
  Dye & Durham, ESC Corporate Services, Appara AI (Paige Solutions),
  and MinuteBox.
- Direct ministry licensing is not open-door; practical access would
  require either a reseller contract with one of the four licensees
  or an application for a Spectre-owned licence.  Either path is a
  procurement + legal review deliverable, not a Phase 2C
  implementation task.
- The public OBR search is HTML + "company key" controls that break
  under scraping and are explicitly out-of-scope of the
  service-provider framework.

**Phase 2C decision:** route every CA-ON registration through the
manual-review stub.  A later founder-authorised slice can replace
the stub with a reseller-backed live adapter once procurement
completes.

---

## 3. British Columbia (CA-BC) — Verdict: `AUTOMATED_LIVE_FEASIBLE` *after procurement*

- BC Registries exposes a documented developer portal
  (`developer.api.bcregistry.gov.bc.ca`) with a Registry Search API
  and a Business API.
- Authentication is a BC Registries account id plus a gateway API
  key (header-based).  A sandbox is referenced but not fully
  populated in public documentation.
- Cost is deferred to the regulations / fee schedule; no flat
  per-call figure is publicly posted.  Legacy BC OnLine web search
  was approximately CAD $7 per search; API costs will plausibly be
  the same order of magnitude per call.
- Responses include company existence, official name, status, and
  (per BCFSA confirmation) directors + officers.  The exact JSON
  field names require fetching the live OpenAPI spec via the portal
  after onboarding.
- Of the three priority jurisdictions, BC is the only one with a
  first-party, documented, legitimately-callable REST API suitable
  for live production use.

**Phase 2C decision:** route every CA-BC registration through the
manual-review stub BY DEFAULT for the current slice.  A procurement
step must complete BEFORE a BC live adapter is enabled — specifically:

1. Open a BC Registries developer-portal account under Spectre's
   corporate identity.
2. Procure production API credentials (API key + account id) and
   store them as Fly secrets in a staging-first rollout.
3. Verify the fee schedule and set a per-registration cost budget.
4. Legal review the data-reuse clauses in the BC Registries terms
   of use to confirm Spectre's permitted use case (verifying its
   own customers, not re-publishing registry data).
5. Request founder authorisation for a Phase-2C.1 slice that
   replaces the BC stub with the live adapter + its own contract
   tests + its own staging acceptance.

Until all five steps complete, the manual-review stub remains the
authoritative Phase 2C behaviour for CA-BC.

---

## 4. "Authoritative evidence" caveat (all three jurisdictions)

Only a **Certificate of Status / Certificate of Good Standing**
issued by the registry is treated as authoritative evidence of
standing in Canadian commercial contexts.  Programmatic API JSON
(even BC's) is operationally reliable but, for binding
commercial-authority reliance, Spectre's operator triage must
pull the formal certificate artefact separately — the API JSON is
a routing input, not conclusive legal proof.

The Phase 2C corroborator reflects this: the
`standingFromLiveAdapter` input is the key gate.  Even if a live
adapter is wired in later, PASS_AUTOMATED remains unachievable
unless the adapter is BOTH authoritative AND the signatory
independently corroborated.

---

## 5. Data-reuse restrictions (all three jurisdictions)

- Alberta explicitly bars third-party redistribution of registry
  data in its subscriber agreement.
- Ontario constrains access + onward use to licensees.
- British Columbia's API terms of use must be re-read on
  onboarding; redistribution of raw registry data to Spectre's
  Club customers (as opposed to displaying a per-Club result on
  the operator's own screen) is a specific risk vector that must
  be legally cleared before any live-adapter slice.

Spectre's Phase 2C baseline does not surface raw registry payloads
anywhere — not in the applicant-facing surface, not in the admin
diagnostic, not in logs.  The adapter port's documented invariant
"adapters MUST NOT retain or persist the raw registry payload" is
contract-tested so a future live adapter cannot regress this.

---

## 6. SLA considerations

No public SLA figures are documented for any of the three
jurisdictions.  Phase 2C treats every adapter call as potentially
unreliable:

- Adapter errors route to `MANUAL_REVIEW_REQUIRED` (never silent
  ACTIVE).
- Timeouts are the adapter's responsibility to classify.
- The pipeline is single-shot per registration; a retry hook lives
  in Phase 2H.

---

## 7. Phase 2C conclusion

Ship manual-review stubs for all three jurisdictions.  The
EntityRegistryAdapter port + fixture adapter + manual-review stub
are the complete Phase 2C adapter deliverable.  Live adapters are
procurement-blocked and require separate founder authorisation per
jurisdiction.

**No fabricated verdicts.  No scraping.  No restricted-service
bypass.  Operator-reviewed is the Phase 2C default.**

---

## Sources

Investigation sources (public documentation reviewed on 2026-10-25):

- Alberta: `alberta.ca/find-corporation-details`, Service Alberta's
  Registries On-Line access application form, Law Central Alberta's
  Corporate Registry overview.
- Ontario: Ontario Bar Association "What's New — OBR Service
  Providers" (updated); MinuteBox 2025-04-17 OBR licence
  announcement; Mondaq Corporate Update, Ministry of Public and
  Business Service Delivery and Procurement.
- British Columbia: BC Registries Developer Portal — Registry Search
  API and Registry Search API overview; the modernisation guidance
  on `gov.bc.ca`; BCFSA — Corporate Registry Information.

Where documentation is non-public (BC fee schedule, OBR licence
terms, exact Alberta ToU), that non-publicity is called out above.
