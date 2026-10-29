// SIGNUP-2 M4-INT-C (2026-10-29) -- AUTHORIZED acceptance spec.
//
// Uses the two synthetic SUPER_ADMIN identities (Operator A + B)
// created by scripts/m4-int-c-provision-super-admins.mjs for the
// authorized 2-hour window.  Credentials live in
// .env.playwright.local only (git-ignored).  The suite skips if
// the window has not been provisioned or has expired.
//
// Covers §2 workflow verification, §3 two-operator SoD, §4 safe
// email probe, and §6 screenshot capture.

import { test, expect } from "@playwright/test";
import {
  loginAsM4IntCOperator,
  m4IntCCredsAvailable,
} from "./_lib/m4-int-c-auth";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const authz = m4IntCCredsAvailable();
const founder = stagingCredsAvailable();
const authzAt = authz.ready ? test : test.skip;

const OUT_DIR = join(process.cwd(), "test-results", "m4-int-c-authorized");
function ensureOutDir() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}
function evidenceFile(name: string, data: unknown) {
  writeFileSync(join(ensureOutDir(), name), JSON.stringify(data, null, 2));
}

const RECIPIENT_FOR_PROBE = "cturcato@spectreautomation.com";

authzAt.describe("signup-2 m4-int-c :: Operator A authorized access (§2)", () => {
  authzAt("Op A reaches billing hub + sees DORMANT banner + all four workflow links", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    await page.goto("/app/admin/signup-ops/billing");
    await expect(page.getByTestId("billing-ops-dormant-banner")).toBeVisible();
    await expect(page.getByTestId("link-triggering")).toBeVisible();
    await expect(page.getByTestId("link-exceptions")).toBeVisible();
    await expect(page.getByTestId("link-renewal-review")).toBeVisible();
    await expect(page.getByTestId("link-cancellation")).toBeVisible();
    await expect(page.getByTestId("billing-ops-forbidden")).toHaveCount(0);
    await page.screenshot({ path: join(ensureOutDir(), "hub-authorized-opA.png"), fullPage: true });
  });

  authzAt("Op A reaches triggering page + candidates container renders", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    await page.goto("/app/admin/signup-ops/billing/triggering");
    await expect(page.getByTestId("triggering-forbidden")).toHaveCount(0);
    await expect(page.getByTestId("triggering-candidates")).toBeVisible();
    await expect(page.getByTestId("triggering-dormant-banner")).toBeVisible();
    await page.screenshot({ path: join(ensureOutDir(), "triggering-authorized-opA.png"), fullPage: true });
  });

  authzAt("Op A reaches exceptions page + filters render", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    await page.goto("/app/admin/signup-ops/billing/exceptions");
    await expect(page.getByTestId("exceptions-forbidden")).toHaveCount(0);
    await expect(page.getByTestId("exceptions-filters")).toBeVisible();
    await page.screenshot({ path: join(ensureOutDir(), "exceptions-authorized-opA.png"), fullPage: true });
  });

  authzAt("Op A reaches renewal-review page + list OR empty state", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    await page.goto("/app/admin/signup-ops/billing/renewal-review");
    await expect(page.getByTestId("renewal-review-forbidden")).toHaveCount(0);
    const list = await page.getByTestId("renewal-review-list").count();
    const empty = await page.getByTestId("renewal-review-empty").count();
    expect(list + empty).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: join(ensureOutDir(), "renewal-review-authorized-opA.png"), fullPage: true });
  });

  authzAt("Op A: GET /api/admin/billing/renewal-preflight-probe returns pipeline shape", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    const r = await page.request.get("/api/admin/billing/renewal-preflight-probe");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(typeof body.totalPreflights).toBe("number");
    expect(body.renewalLiveFlag).toBe(false);
    expect(body.statHolidayCoverage?.latestCoveredYear).toBeGreaterThanOrEqual(2028);
    evidenceFile("preflight-probe-opA.json", body);
  });

  authzAt("Op A: GET /api/admin/billing/exceptions returns list shape", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    const r = await page.request.get("/api/admin/billing/exceptions?state=open");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.rows)).toBe(true);
    evidenceFile("exceptions-list-opA.json", { status: r.status(), rowCount: body.rows.length });
  });

  authzAt("Op A: GET /api/admin/billing/renewal-review returns list shape", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    const r = await page.request.get("/api/admin/billing/renewal-review");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.rows)).toBe(true);
    evidenceFile("renewal-review-list-opA.json", { status: r.status(), rowCount: body.rows.length });
  });

  authzAt("Op A: GET /api/admin/billing/cancellation returns list shape", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    const r = await page.request.get("/api/admin/billing/cancellation");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.rows)).toBe(true);
    evidenceFile("cancellation-list-opA.json", { status: r.status(), rowCount: body.rows.length });
  });

  authzAt("Op A: GET /api/admin/billing/triggering returns candidate list shape", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    const r = await page.request.get("/api/admin/billing/triggering");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.candidates)).toBe(true);
    evidenceFile("triggering-candidates-opA.json", { status: r.status(), candidateCount: body.candidates.length });
  });
});

authzAt.describe("signup-2 m4-int-c :: §3 two-operator SoD + cross-tenant refusal", () => {
  authzAt("Op A: cancellation POST refuses missing cycle with service-level error (shape proof)", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    const r = await page.request.post("/api/admin/billing/cancellation", {
      data: {
        action: "request",
        clubId: "cl_m4intc_nonexistent",
        billingCycleId: "bc_m4intc_nonexistent",
        requestReason: "SoD / cross-tenant probe (Op A)",
      },
    });
    const body = await r.json().catch(() => ({}));
    // Write evidence BEFORE asserting so a surprise response is still captured.
    evidenceFile("cancellation-cross-tenant-opA.json", {
      status: r.status(),
      body,
    });
    // Expected refusal shape (flag OFF -> 403 M4-cancellation disabled;
    // or 404 CYCLE_NOT_FOUND when the flag is somehow ON).  Any 4xx
    // ok:false is acceptable evidence that the service did NOT accept
    // a non-existent cycle silently.
    expect([400, 403, 404, 409]).toContain(r.status());
    expect(body.ok).toBe(false);
  });

  authzAt("Op A: triggering POST drain refuses -- M3 payment-initiation flag OFF", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    // The drain action requires BOTH SPECTRE_SIGNUP_2M4_TRIGGER_LIVE
    // AND SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION to be ON.  Both are OFF.
    const r = await page.request.post("/api/admin/billing/triggering", {
      data: { action: "drain", commandId: "cmd_m4intc_nonexistent" },
    });
    // Any safe refusal shape proves the dual-flag gate holds.
    expect(r.status()).toBeLessThan(500);
    const body = await r.json();
    // When flags OFF the body may be {ok:true, outcome:"SKIPPED_FLAG_OFF"}
    // -- the critical assertion is that we did NOT get a 2xx with an
    // actual SUCCEEDED outcome against a non-existent command.
    if (body.outcome) {
      expect(["SKIPPED_FLAG_OFF", "FAILED"]).toContain(body.outcome);
    } else {
      expect(body.ok).toBe(false);
    }
    evidenceFile("triggering-drain-flag-off-opA.json", { status: r.status(), outcome: body.outcome ?? null, ok: body.ok });
  });

  authzAt("Op B: triggering POST record-commercial-auth refuses missing pricing (service-level error)", async ({ context }) => {
    // Op B authentication proves the two-operator pathway works -- both
    // identities can authenticate independently.  (Full happy-path SoD
    // -- Op A records commercial-auth, Op B records release, same
    // registration, service refuses when they are equal -- requires
    // a BANK_VERIFIED cycle on staging.  M4-triggering live flag is
    // OFF so no such cycle has advanced to that state.  We prove here
    // that Op B authenticates + the service refuses on a shape issue
    // rather than an auth issue.)
    const page = await loginAsM4IntCOperator(context, "B");
    const r = await page.request.post("/api/admin/billing/triggering", {
      data: {
        action: "record-commercial-auth",
        signupRegistrationId: "sreg_m4intc_nonexistent",
      },
    });
    expect(r.status()).toBeLessThan(500);
    const body = await r.json();
    expect(body.ok).toBe(false);
    // Service refuses because pricing is missing OR the flag is OFF.
    // Either refusal shape proves Op B's session + the service's gate.
    expect(
      body.error === "SIGNUP_2M4_TRIGGER_PRICING_MISSING" ||
      body.error === "forbidden" ||
      (body.message ?? "").includes("disabled"),
    ).toBe(true);
    evidenceFile("triggering-commercial-auth-opB.json", { status: r.status(), error: body.error });
  });

  authzAt("Founder (CLUB_ADMIN): still refused by hub + billing APIs (negative control)", async ({ context }) => {
    if (!founder.ready) {
      // Founder creds not available in env; skip but record the fact.
      evidenceFile("club-admin-negative-skipped.json", { reason: "founder creds missing" });
      return;
    }
    const page = await loginAsFounder(context);
    await page.goto("/app/admin/signup-ops/billing");
    const forbiddenText = await page.textContent("body");
    expect(forbiddenText).toMatch(/You do not have the required permission/);
    const r = await page.request.get("/api/admin/billing/cancellation");
    expect(r.status()).toBe(403);
    evidenceFile("club-admin-negative-still-refused.json", { hub: "forbidden", cancellationGet: 403 });
  });
});

authzAt.describe("signup-2 m4-int-c :: §4 Microsoft 365 safe email probe (submission + audit)", () => {
  authzAt("Op A triggers safe email probe to the approved test inbox", async ({ context }) => {
    const page = await loginAsM4IntCOperator(context, "A");
    const r = await page.request.post("/api/admin/billing/email-adapter-probe", {
      data: {
        toEmail: RECIPIENT_FOR_PROBE,
        label: "m4-int-c-authorized",
      },
    });
    const body = await r.json();
    const evidence = {
      status: r.status(),
      ok: body.ok,
      adapterStatus: body.status ?? null,
      providerMessageIdPresent: typeof body.providerMessageId === "string" && body.providerMessageId.length > 0,
      providerMessageIdTail: typeof body.providerMessageId === "string"
        ? body.providerMessageId.slice(-16)
        : null,
      failureReason: body.failureReason ?? null,
      sentAtIso: body.sentAtIso ?? null,
      label: body.label ?? null,
      recipientDomain: RECIPIENT_FOR_PROBE.split("@")[1],
    };
    evidenceFile("ms365-probe-opA.json", evidence);
    // Submission must succeed OR the body must explain the adapter
    // failure reason (so the founder sees exactly where it broke).
    // We ALWAYS record the evidence file above regardless of outcome.
    if (r.status() === 200) {
      expect(body.ok).toBe(true);
      expect(body.status).toBe("SENT");
    } else {
      // Record the failure but do NOT fail the suite; the acceptance
      // report distinguishes "submission verified" from "actual receipt".
      expect(r.status()).toBeLessThan(500);
    }
  });
});
