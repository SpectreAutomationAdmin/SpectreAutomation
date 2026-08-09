// Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — Provider factory.
//
// Founder §3: provider selection MUST be configuration-driven.
// Staging must be capable of PRODUCT_REFERENCE_PROVIDER=null (default)
// or PRODUCT_REFERENCE_PROVIDER=claude-web-search with immediate
// rollback to null.
//
// Env vars consumed:
//   PRODUCT_REFERENCE_PROVIDER  (null | claude-web-search)  default: null
//   PRODUCT_REFERENCE_API_KEY   (Anthropic API key for the claude
//                                provider — only when provider != null)
//   PRODUCT_REFERENCE_MODEL     (optional Claude model override)
//   PRODUCT_REFERENCE_DAILY_CAP (optional per-club daily cap override,
//                                default 50 per §18)
//
// No provider credentials in source code (§3). If PRODUCT_REFERENCE_
// PROVIDER=claude-web-search but PRODUCT_REFERENCE_API_KEY is unset,
// factory logs a warning and falls back to NullProductReferenceProvider.

import {
  NullProductReferenceProvider,
  type ProductReferenceProvider,
} from "../product-reference-provider";
import { ClaudeWebSearchProductReferenceProvider } from "./claude-web-search-provider";
import { DEFAULT_RATE_LIMIT, type RateLimitConfig } from "./rate-limiter";

let SINGLETON: ProductReferenceProvider | null = null;
let SINGLETON_KIND: string = "null";

/** Resolve the configured provider. Idempotent — the same provider
 *  instance is returned across the process so its rate-limiter /
 *  circuit-breaker state persists between analyse() calls. */
export function getProductReferenceProvider(): ProductReferenceProvider {
  if (SINGLETON) return SINGLETON;
  const kind = (process.env.PRODUCT_REFERENCE_PROVIDER ?? "null").toLowerCase();
  const rateLimit: RateLimitConfig = {
    ...DEFAULT_RATE_LIMIT,
    perClubPerDay: parseIntSafe(process.env.PRODUCT_REFERENCE_DAILY_CAP, DEFAULT_RATE_LIMIT.perClubPerDay),
  };

  if (kind === "claude-web-search") {
    const apiKey = process.env.PRODUCT_REFERENCE_API_KEY;
    if (!apiKey) {
      // eslint-disable-next-line no-console
      console.warn(
        "[product-reference] PRODUCT_REFERENCE_PROVIDER=claude-web-search but PRODUCT_REFERENCE_API_KEY is unset — falling back to NullProductReferenceProvider",
      );
      SINGLETON = new NullProductReferenceProvider();
      SINGLETON_KIND = "null-fallback";
      return SINGLETON;
    }
    SINGLETON = new ClaudeWebSearchProductReferenceProvider({
      apiKey,
      model: process.env.PRODUCT_REFERENCE_MODEL,
      rateLimit,
    });
    SINGLETON_KIND = "claude-web-search";
    return SINGLETON;
  }

  SINGLETON = new NullProductReferenceProvider();
  SINGLETON_KIND = "null";
  return SINGLETON;
}

/** Test-only: reset the singleton so a new provider is constructed
 *  from the current env. */
export function _resetProductReferenceProviderForTest(instance?: ProductReferenceProvider | null): void {
  SINGLETON = instance ?? null;
  SINGLETON_KIND = instance ? "test-injected" : "null";
}

export function activeProviderKind(): string {
  return SINGLETON_KIND;
}

function parseIntSafe(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
