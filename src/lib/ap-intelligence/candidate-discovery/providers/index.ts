// Phase 4R · Phase 7.2 (2026-08-13) — Discovery provider registry.
// Order is diagnostic only; the union orchestrator dedupes by
// accountId. Provenance from every provider that surfaced an
// account is retained on the resulting DiscoveredAccountCandidate.

import type { DiscoveryProvider } from "..";
import { capitalAwareDiscovery } from "./capital-aware";
import { natureScopedDiscovery } from "./nature-scoped";
import { purposeOntologyDiscovery } from "./purpose-ontology";
import { semanticFullCoaDiscovery } from "./semantic-full-coa";
import { vendorHistoryDiscovery } from "./vendor-history";

/** All Phase 7.2A discovery providers, registered in a stable order.
 *  Consumers must NOT weight candidates by provider order or count.
 *
 *  Env-flag toggles for ablation. Default = ALL providers active. Set
 *  AP_DISCOVERY_DISABLE=capital_aware,nature_scoped,... to disable
 *  named providers for one benchmark run without editing code. */
function envDisabledSet(): Set<string> {
  const raw = process.env.AP_DISCOVERY_DISABLE ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}
export const ALL_DISCOVERY_PROVIDERS: readonly DiscoveryProvider[] = ((): readonly DiscoveryProvider[] => {
  const disabled = envDisabledSet();
  const all: DiscoveryProvider[] = [
    capitalAwareDiscovery,
    natureScopedDiscovery,
    purposeOntologyDiscovery,
    semanticFullCoaDiscovery,
    vendorHistoryDiscovery,
  ];
  return all.filter((p) => !disabled.has(p.kind));
})();

export {
  capitalAwareDiscovery, natureScopedDiscovery, purposeOntologyDiscovery,
  semanticFullCoaDiscovery, vendorHistoryDiscovery,
};
