// SIGNUP-2 M4-INT (2026-10-29) -- Integration-readiness contract tests.
//
// Covers:
//   §5 fail-closed stat-holiday coverage,
//   §5 safe email adapter probe shape,
//   §5 renewal preflight probe shape,
//   §2 cancellation operator API shape,
//   §2 billing operator hub page shape,
//   §1/§3/§4 companion-document presence + the §6 OPEN-gate register.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CANADIAN_STAT_HOLIDAYS_UTC,
  earliestRetryAt,
  getStatHolidayCalendarCoverage,
} from "@/lib/billing/signup-2m4-retries-service";

const EMAIL_PROBE = readFileSync(
  join(process.cwd(), "src/app/api/admin/billing/email-adapter-probe/route.ts"),
  "utf8",
);
const RENEWAL_PROBE = readFileSync(
  join(process.cwd(), "src/app/api/admin/billing/renewal-preflight-probe/route.ts"),
  "utf8",
);
const CANCEL_API = readFileSync(
  join(process.cwd(), "src/app/api/admin/billing/cancellation/route.ts"),
  "utf8",
);
const BILLING_HUB = readFileSync(
  join(process.cwd(), "src/app/app/admin/signup-ops/billing/page.tsx"),
  "utf8",
);
const RETRIES_SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-retries-service.ts"),
  "utf8",
);

/* ============================================================
 * §5 Fail-closed stat-holiday coverage
 * ============================================================ */

describe("signup-2 m4-int :: §5 stat-holiday coverage is fail-closed", () => {
  it("earliestRetryAt refuses to produce a date beyond the covered calendar", () => {
    // Starting 2028-12-27 + 3 bd would land in 2029 which is NOT
    // in the pinned calendar.  The function must throw instead of
    // silently returning a date.
    expect(() => earliestRetryAt(new Date("2028-12-27T00:00:00Z"), 3))
      .toThrow(/STAT_HOLIDAY_CALENDAR_COVERAGE_EXCEEDED|coverage window/i);
  });

  it("earliestRetryAt still works for dates well inside the covered window", () => {
    const r = earliestRetryAt(new Date("2026-06-05T00:00:00Z"), 3);
    expect(r.toISOString().slice(0, 10)).toBe("2026-06-10");
  });

  it("source replaces logger.warn with a hard-refusal AppError", () => {
    // The old behaviour (logger.warn + continue) is gone; the new
    // behaviour (throw AppError inside the loop) is present.
    expect(RETRIES_SVC).not.toMatch(/signup\.m4\.retries\.stat_holiday_calendar\.coverage_exceeded/);
    expect(RETRIES_SVC).toMatch(/throw new AppError\([\s\S]{0,80}STAT_HOLIDAY_CALENDAR_COVERAGE_EXCEEDED/);
  });

  it("coverage helper remains exposed for ops observability", () => {
    const cov = getStatHolidayCalendarCoverage();
    expect(cov.latestCoveredYear).toBeGreaterThanOrEqual(2028);
    expect(cov.totalEntries).toBe(CANADIAN_STAT_HOLIDAYS_UTC.size);
  });
});

/* ============================================================
 * §5 Safe email adapter probe
 * ============================================================ */

describe("signup-2 m4-int :: §5 email adapter probe shape", () => {
  it("gated by platform:signups:release", () => {
    expect(EMAIL_PROBE).toMatch(/hasPermission\(principal, null, "platform:signups:release"\)/);
  });
  it("uses selectPlatformEmailAdapter -- same path as M4-retries", () => {
    expect(EMAIL_PROBE).toMatch(/selectPlatformEmailAdapter/);
    expect(EMAIL_PROBE).toMatch(/adapter\.send\(/);
  });
  it("probe body contains no sensitive data markers (no club / bank / mandate)", () => {
    expect(EMAIL_PROBE).toMatch(/No billing data, no club data, and no mandate data/);
  });
  it("writes an audit entry on every invocation", () => {
    expect(EMAIL_PROBE).toMatch(/action: "signup\.m4\.int\.email_adapter_probe"/);
  });
  it("does not touch Stripe / billing cycle / mandate state", () => {
    const codeOnly = EMAIL_PROBE.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(codeOnly).not.toMatch(/stripe\./);
    expect(codeOnly).not.toMatch(/billingCycle/);
    expect(codeOnly).not.toMatch(/subscriptionPaymentMandate/);
  });
});

/* ============================================================
 * §5 Renewal preflight probe
 * ============================================================ */

describe("signup-2 m4-int :: §5 renewal preflight probe shape", () => {
  it("gated by platform:signups:release on both GET and POST", () => {
    const occurrences = (RENEWAL_PROBE.match(/hasPermission\(principal, null, "platform:signups:release"\)/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
  it("GET returns pipeline + calendar coverage shape", () => {
    expect(RENEWAL_PROBE).toMatch(/totalPreflights/);
    expect(RENEWAL_PROBE).toMatch(/scheduledPreflights/);
    expect(RENEWAL_PROBE).toMatch(/dueButUnexecuted/);
    expect(RENEWAL_PROBE).toMatch(/statHolidayCoverage/);
  });
  it("POST dry-run path when flag is OFF (no live sweep without flag)", () => {
    expect(RENEWAL_PROBE).toMatch(/dry_run_flag_off/);
    expect(RENEWAL_PROBE).toMatch(/SPECTRE_SIGNUP_2M4_RENEWAL_LIVE/);
  });
  it("POST live sweep invokes recoverMissedPreflightsForCycle", () => {
    expect(RENEWAL_PROBE).toMatch(/recoverMissedPreflightsForCycle/);
  });
});

/* ============================================================
 * §2 Cancellation operator API
 * ============================================================ */

describe("signup-2 m4-int :: §2 cancellation operator API", () => {
  it("gated by platform:signups:release", () => {
    expect(CANCEL_API).toMatch(/hasPermission\(principal, null, "platform:signups:release"\)/);
  });
  it("supports all five write actions", () => {
    expect(CANCEL_API).toMatch(/case "request":/);
    expect(CANCEL_API).toMatch(/case "authorize":/);
    expect(CANCEL_API).toMatch(/case "reject":/);
    expect(CANCEL_API).toMatch(/case "schedule":/);
    expect(CANCEL_API).toMatch(/case "reverse":/);
  });
  it("GET supports listing by state + reading by requestId", () => {
    expect(CANCEL_API).toMatch(/url\.searchParams\.get\("requestId"\)/);
    expect(CANCEL_API).toMatch(/url\.searchParams\.get\("state"\)/);
  });
  it("surfaces app errors with their safeMessage + status", () => {
    expect(CANCEL_API).toMatch(/isAppError/);
    expect(CANCEL_API).toMatch(/err\.safeMessage/);
    expect(CANCEL_API).toMatch(/err\.status/);
  });
  it("delegates every write to the service layer (no inline Prisma mutations)", () => {
    expect(CANCEL_API).toMatch(/requestCancellation/);
    expect(CANCEL_API).toMatch(/authorizeCancellation/);
    expect(CANCEL_API).toMatch(/rejectCancellation/);
    expect(CANCEL_API).toMatch(/scheduleCancellation/);
    expect(CANCEL_API).toMatch(/reverseCancellation/);
    // Inline Prisma reads are allowed; mutations must go through the service.
    expect(CANCEL_API).not.toMatch(/prisma\.billingCancellationRequest\.(create|update|delete|upsert)/);
  });
  it("binds requestedByUserId etc. to the authenticated principal (never trusts client)", () => {
    expect(CANCEL_API).toMatch(/requestedByUserId:\s*auth\.principalId/);
    expect(CANCEL_API).toMatch(/authorizedByUserId:\s*auth\.principalId/);
    expect(CANCEL_API).toMatch(/rejectedByUserId:\s*auth\.principalId/);
    expect(CANCEL_API).toMatch(/reversedByUserId:\s*auth\.principalId/);
  });
});

/* ============================================================
 * §2 Billing operator hub page shape
 * ============================================================ */

describe("signup-2 m4-int :: §2 billing operator hub page", () => {
  it("gated by platform:signups:release with forbidden fallback markup", () => {
    expect(BILLING_HUB).toMatch(/hasPermission\(principal, null, "platform:signups:release"\)/);
    expect(BILLING_HUB).toMatch(/data-testid="billing-ops-forbidden"/);
  });
  it("shows DORMANT banner when every M4 live flag is OFF", () => {
    expect(BILLING_HUB).toMatch(/data-testid="billing-ops-dormant-banner"/);
    expect(BILLING_HUB).toMatch(/Dormant\./);
  });
  it("lists the six M4 live flags", () => {
    expect(BILLING_HUB).toMatch(/SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION/);
    expect(BILLING_HUB).toMatch(/SPECTRE_SIGNUP_2M4_TRIGGER_LIVE/);
    expect(BILLING_HUB).toMatch(/SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE/);
    expect(BILLING_HUB).toMatch(/SPECTRE_SIGNUP_2M4_RETRIES_LIVE/);
    expect(BILLING_HUB).toMatch(/SPECTRE_SIGNUP_2M4_RENEWAL_LIVE/);
    expect(BILLING_HUB).toMatch(/SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE/);
  });
  it("includes stat-holiday coverage summary + fail-closed reminder", () => {
    expect(BILLING_HUB).toMatch(/stat-holiday calendar coverage/);
    expect(BILLING_HUB).toMatch(/refused/);
  });
  it("surfaces the four observability counts", () => {
    expect(BILLING_HUB).toMatch(/Open cancellation requests/);
    expect(BILLING_HUB).toMatch(/Pending billing commands/);
    expect(BILLING_HUB).toMatch(/Exceptions needing action/);
    expect(BILLING_HUB).toMatch(/Due renewal preflights/);
  });
  it("page reads via service / Prisma reads only (no inline mutations)", () => {
    expect(BILLING_HUB).not.toMatch(/\.create\(/);
    expect(BILLING_HUB).not.toMatch(/\.update\(/);
    expect(BILLING_HUB).not.toMatch(/\.delete\(/);
  });
});

/* ============================================================
 * §1 / §3 / §4 companion documents present
 * ============================================================ */

describe("signup-2 m4-int :: companion documents", () => {
  it("integration audit document exists", () => {
    expect(existsSync(join(process.cwd(), "docs/signup-2-m4-int-integration-audit.md"))).toBe(true);
    const doc = readFileSync(join(process.cwd(), "docs/signup-2-m4-int-integration-audit.md"), "utf8");
    expect(doc).toMatch(/Gap register/);
    expect(doc).toMatch(/P0-1/);
    expect(doc).toMatch(/P1-1/);
    expect(doc).toMatch(/SHIPPED/);
    expect(doc).toMatch(/DORMANT/);
    expect(doc).toMatch(/EXERCISED-FIXTURE/);
    expect(doc).toMatch(/EXERCISED-LIVE/);
    expect(doc).toMatch(/GAP/);
  });
  it("Stripe readiness document exists + addresses CAD $38k limit explicitly", () => {
    expect(existsSync(join(process.cwd(), "docs/signup-2-m4-int-stripe-readiness.md"))).toBe(true);
    const doc = readFileSync(join(process.cwd(), "docs/signup-2-m4-int-stripe-readiness.md"), "utf8");
    expect(doc).toMatch(/CAD \$38,000 annual Price/);
    expect(doc).toMatch(/ACSS Debit transaction-limit escalation/);
    expect(doc).toMatch(/Not confirmed in Spectre/);
    expect(doc).toMatch(/Safe integration-test matrix/);
  });
  it("financial safeguards document exists + enumerates all 6 safeguards", () => {
    expect(existsSync(join(process.cwd(), "docs/signup-2-m4-int-financial-safeguards.md"))).toBe(true);
    const doc = readFileSync(join(process.cwd(), "docs/signup-2-m4-int-financial-safeguards.md"), "utf8");
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(doc).toMatch(new RegExp(`Safeguard ${n}`));
    }
    expect(doc).toMatch(/What this document does NOT prove/);
  });
});

/* ============================================================
 * Flag-off safety -- no production billing enabled by this slice
 * ============================================================ */

describe("signup-2 m4-int :: §7 flag discipline preserved", () => {
  beforeEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_RENEWAL_LIVE; });
  afterEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_RENEWAL_LIVE; });

  it("retries service still refuses writes when flag OFF (no regression from §5 corrections)", async () => {
    const svc = await import("@/lib/billing/signup-2m4-retries-service");
    expect(() => svc.assertM4RetriesLiveFlag()).toThrow(/disabled/);
  });

  it("cancellation service still refuses writes when flag OFF", async () => {
    const svc = await import("@/lib/billing/signup-2m4-cancellation-service");
    expect(() => svc.assertM4CancellationLiveFlag()).toThrow(/disabled/);
  });
});
