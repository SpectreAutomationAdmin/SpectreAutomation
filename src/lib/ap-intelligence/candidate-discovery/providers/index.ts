// Phase 4R · Phase 7.2B (2026-08-13) — Discovery provider registry.
//
// Phase 7.2B: replaced the synthetic taxonomy-table providers with
// direct invocations of v206's actual discovery functions. Synthetic
// providers (capitalAwareDiscovery / natureScopedDiscovery /
// purposeOntologyDiscovery / semanticFullCoaDiscovery) preserved on
// disk for ablation testing but NOT active by default. This is
// consistent with the founder's §26 directive: "Do not delete the
// old AP intelligence code — preserve it as a reference implementation."

import type { DiscoveryProvider } from "..";
import { purposeDrivenDirectDiscovery } from "./purpose-driven-direct";
import { natureScopedDirectDiscovery } from "./nature-scoped-direct";
import { capitalAwareDirectDiscovery } from "./capital-aware-direct";
import { vendorHistoryDiscovery } from "./vendor-history";
// Phase 4R · Phase 7.2K (2026-08-13) — treatment-aware retrieval.
// Consumes composed CanonicalAccountingTreatment from discoveryContext;
// emits candidates with PRIMARY / PLAUSIBLE alignment metadata for
// Model B (Phase 7.2L) tier assignment. No score contribution.
import { treatmentAwareDiscovery } from "./treatment-aware";
// Synthetic providers — kept for ablation testing; not active by default.
import { capitalAwareDiscovery } from "./capital-aware";
import { natureScopedDiscovery } from "./nature-scoped";
import { purposeOntologyDiscovery } from "./purpose-ontology";
import { semanticFullCoaDiscovery } from "./semantic-full-coa";

/** Env-flag toggles for ablation. Default set is the Phase 7.2B
 *  legacy-direct providers + vendor-history. Set
 *  AP_DISCOVERY_ENABLE_SYNTHETIC=1 to re-enable Phase 7.2A synthetic
 *  providers alongside the direct ones (useful for A/B testing).
 *  Set AP_DISCOVERY_DISABLE=<kinds> to disable named providers. */
function envDisabledSet(): Set<string> {
  const raw = process.env.AP_DISCOVERY_DISABLE ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}
function envSyntheticEnabled(): boolean {
  return process.env.AP_DISCOVERY_ENABLE_SYNTHETIC === "1"
      || process.env.AP_DISCOVERY_ENABLE_SYNTHETIC === "true";
}
export const ALL_DISCOVERY_PROVIDERS: readonly DiscoveryProvider[] = ((): readonly DiscoveryProvider[] => {
  const disabled = envDisabledSet();
  const active: DiscoveryProvider[] = [
    purposeDrivenDirectDiscovery,
    natureScopedDirectDiscovery,
    capitalAwareDirectDiscovery,
    vendorHistoryDiscovery,
    // Phase 4R · Phase 7.2K (2026-08-13).
    treatmentAwareDiscovery,
  ];
  if (envSyntheticEnabled()) {
    active.push(semanticFullCoaDiscovery);
    // NOTE: synthetic capitalAwareDiscovery / natureScopedDiscovery
    // / purposeOntologyDiscovery are OMITTED — they would double-fire
    // with the direct providers under the same source-kind labels.
  }
  return active.filter((p) => !disabled.has(p.kind));
})();

export {
  purposeDrivenDirectDiscovery, natureScopedDirectDiscovery,
  capitalAwareDirectDiscovery, vendorHistoryDiscovery,
  treatmentAwareDiscovery,
  capitalAwareDiscovery, natureScopedDiscovery, purposeOntologyDiscovery,
  semanticFullCoaDiscovery,
};
