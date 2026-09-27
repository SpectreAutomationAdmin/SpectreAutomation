// PAY-1C — staging acceptance scenarios A / C / E / F / G.
//
// Scenarios B (duplicate guard) + D (recovery) are covered by:
//   - B: unit tests `pay1c3-duplicate-guard.test.ts` + wired into
//        the authorization service (regressed here by re-running
//        PAY-1B.1 outage spec which exercises authorization).
//   - D: unit tests `pay1c4-production-gate.test.ts` +
//        `pay1b1-outage-scenario.staging.spec.ts` (recovery is the
//        same code path — provider health flip back to ACTIVE).

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { loginAs } from "./_lib/staging-auth";
import fs from "node:fs";

const BASE_URL = "https://staging.spectreautomation.com";
const COULEE = "cmrvdeny7000144372ktmmg9c";
const PA_EMAIL = "fixture.payroll-admin.3e@spectre.test";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";

test.use({ trace: "off", video: "off", viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

test.describe("PAY-1C · staging acceptance", () => {
  test.setTimeout(240_000);
  let paCtx: BrowserContext, ctrlCtx: BrowserContext, pa: Page, ctrl: Page;

  test.beforeAll(async ({ browser }) => {
    paCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    pa = await loginAs(paCtx, PA_EMAIL, FIXTURE_PW);
    ctrlCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    ctrl = await loginAs(ctrlCtx, CTRL_EMAIL, FIXTURE_PW);
  });
  test.afterAll(async () => { await paCtx.close(); await ctrlCtx.close(); });

  test("HEALTH · /api/health responds", async () => {
    const r = await pa.request.get(`${BASE_URL}/api/health`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    console.log("HEALTH:", JSON.stringify(body));
  });

  test("A · limit-check probe against Coulee reports no breach when no limits are configured (baseline)", async () => {
    // Use the existing authorized run from PAY-1B.1 lifecycle if present.
    // Otherwise this scenario asserts only the endpoint contract.
    const runIdFile = "test-results/pay1b1-G-runId.txt";
    if (!fs.existsSync(runIdFile)) {
      test.skip(true, "no prior PAY-1B run — skipping baseline limit probe");
      return;
    }
    const runId = fs.readFileSync(runIdFile, "utf8").trim();
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "limit-check",
        clubId: COULEE, runId, providerType: "SIMULATOR",
      },
    });
    const body = await r.json();
    console.log("LIMIT_BASELINE:", JSON.stringify(body));
    expect(r.ok()).toBeTruthy();
    expect(body.result.ok).toBe(true);
  });

  test("C · incident record can be opened with linked run + connection (Coulee)", async () => {
    const runIdFile = "test-results/pay1b1-G-runId.txt";
    const connIdFile = "test-results/pay1b1-connection-id.txt";
    const runId = fs.existsSync(runIdFile) ? fs.readFileSync(runIdFile, "utf8").trim() : undefined;
    const connectionId = fs.existsSync(connIdFile) ? fs.readFileSync(connIdFile, "utf8").trim() : undefined;
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "open-incident",
        clubId: COULEE,
        category: "PROVIDER_OUTAGE",
        severity: "SEV_3",
        summary: "PAY-1C staging acceptance — synthetic outage record",
        linkRunId: runId,
        linkConnectionId: connectionId,
      },
    });
    const body = await r.json();
    console.log("INCIDENT_OPEN:", JSON.stringify(body));
    expect(r.ok()).toBeTruthy();
    expect(body.incidentNumber).toMatch(/^INC-\d{4}-\d{6}$/);
    fs.writeFileSync("test-results/pay1c-C-incidentId.txt", body.incidentId);
  });

  test("E · canonical rail derivation produces one CanonicalRailInstruction per PaymentInstruction, with no bank secrets", async () => {
    const runIdFile = "test-results/pay1b1-G-runId.txt";
    if (!fs.existsSync(runIdFile)) {
      test.skip(true, "no prior authorized run available for canonical derivation");
      return;
    }
    const runId = fs.readFileSync(runIdFile, "utf8").trim();
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "canonical", clubId: COULEE, runId },
    });
    const body = await r.json();
    console.log("CANONICAL:", JSON.stringify(body));
    expect(r.ok()).toBeTruthy();
    expect(body.count).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect(row.endToEndId).toMatch(/^E2E-v1-[0-9a-f]{32}$/);
      const s = JSON.stringify(row);
      expect(s).not.toMatch(/institutionSecretRef|transitSecretRef|accountSecretRef/);
    }
    fs.writeFileSync("test-results/pay1c-E-endToEndId.txt", body.rows[0].endToEndId);
  });

  test("F · deterministic correlation resolves E2E ID back to instruction / run / club", async () => {
    const idFile = "test-results/pay1c-E-endToEndId.txt";
    if (!fs.existsSync(idFile)) {
      test.skip(true, "no E2E ID captured");
      return;
    }
    const endToEndId = fs.readFileSync(idFile, "utf8").trim();
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "correlate", clubId: COULEE, endToEndId },
    });
    const body = await r.json();
    console.log("CORRELATE:", JSON.stringify(body));
    expect(r.ok()).toBeTruthy();
    expect(body.correlation).not.toBeNull();
    expect(body.correlation.clubId).toBe(COULEE);
  });

  test("F.neg · deterministic correlation returns null for an unknown reference (no fuzzy matching)", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "correlate", clubId: COULEE, endToEndId: "E2E-v1-deadbeefdeadbeefdeadbeefdeadbeef" },
    });
    const body = await r.json();
    console.log("CORRELATE_NEG:", JSON.stringify(body));
    expect(r.ok()).toBeTruthy();
    expect(body.correlation).toBeNull();
  });

  test("G · production gate REFUSES with real-money disabled + sandbox connection + un-approved adapter", async () => {
    const runIdFile = "test-results/pay1b1-G-runId.txt";
    const connIdFile = "test-results/pay1b1-connection-id.txt";
    if (!fs.existsSync(runIdFile) || !fs.existsSync(connIdFile)) {
      test.skip(true, "no prior run/connection available for gate probe");
      return;
    }
    const runId = fs.readFileSync(runIdFile, "utf8").trim();
    const connectionId = fs.readFileSync(connIdFile, "utf8").trim();
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "production-gate",
        clubId: COULEE, runId, connectionId, providerType: "SIMULATOR",
      },
    });
    const body = await r.json();
    console.log("PRODUCTION_GATE:", JSON.stringify(body));
    expect(r.ok()).toBeTruthy();
    expect(body.report.overall).toBe("REFUSED");
    expect(body.report.reasons).toContain("REAL_MONEY_DISABLED");
    expect(body.report.reasons).toContain("SIMULATOR_NOT_PRODUCTION_ELIGIBLE");
    expect(body.report.reasons).toContain("ADAPTER_NOT_APPROVED");
  });
});
