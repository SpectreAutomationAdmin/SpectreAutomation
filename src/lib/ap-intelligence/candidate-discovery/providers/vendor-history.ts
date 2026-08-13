// Phase 4R · Phase 7.2 (2026-08-13) — Vendor-history discovery.
//
// If the tenant has previously coded invoices from this supplier to
// account X, X deserves consideration for the current invoice. This
// is a pure discovery signal — the fact that the vendor was
// previously coded to an account does NOT by itself mean the current
// invoice should code there. That is canonical ranking's job.

import type { CandidateDiscoveryInput, DiscoveryHit, DiscoveryProvider } from "..";

export const vendorHistoryDiscovery: DiscoveryProvider = {
  kind: "vendor_history",
  discover(input: CandidateDiscoveryInput): Iterable<DiscoveryHit> {
    const hits: DiscoveryHit[] = [];
    const seen = new Set<string>();
    for (const accountNumber of input.globalSignals.priorCodingAccountNumbers) {
      if (seen.has(accountNumber)) continue;
      seen.add(accountNumber);
      const acct = input.eligibleAccounts.find((a) => a.accountNumber === accountNumber);
      if (acct) {
        hits.push({
          accountId: acct.id,
          accountNumber: acct.accountNumber,
          source: { kind: "vendor_history", accountNumber },
        });
      }
    }
    return hits;
  },
};
