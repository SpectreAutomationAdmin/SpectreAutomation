// PAY-1C.1 — deployed Scenario A (real limit refusal) + Scenario C
// (incident-driven containment through legitimate PAY-1B controls).

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { loginAs } from "./_lib/staging-auth";
import fs from "node:fs";

const BASE_URL = "https://staging.spectreautomation.com";
const COULEE = "cmrvdeny7000144372ktmmg9c";
const PA_EMAIL = "fixture.payroll-admin.3e@spectre.test";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";
const BANK_ID_FILE = "test-results/pay1a1-bank-id.txt";
const BATCH_A_FILE = "test-results/pay1c1-A-batchId.txt"; // seeded externally by pay1c1-A seed

test.use({ trace: "off", video: "off", viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

// The following batch id must be pre-seeded on staging (Coulee Ridge)
// as a POSTED, STANDARD batch with ONE INCLUDED employee whose netPay
// is CAD $150.00. The seed script `scripts/pay1c1-A-seed.mjs` handles
// this. If the file is missing we fail loudly rather than reuse an
// unrelated PAY-1B batch (which would contaminate the invariant proof).
function requireFile(path: string): string {
  if (!fs.existsSync(path)) throw new Error(`PAY-1C.1 acceptance requires ${path}`);
  return fs.readFileSync(path, "utf8").trim();
}

test.describe("PAY-1C.1 · Scenario A · real limit refusal through deployed submit path", () => {
  test.setTimeout(240_000);
  let paCtx: BrowserContext, ctrlCtx: BrowserContext, pa: Page, ctrl: Page;
  let runId = "";
  let limitId = "";

  test.beforeAll(async ({ browser }) => {
    paCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    pa = await loginAs(paCtx, PA_EMAIL, FIXTURE_PW);
    ctrlCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    ctrl = await loginAs(ctrlCtx, CTRL_EMAIL, FIXTURE_PW);
  });
  test.afterAll(async () => { await paCtx.close(); await ctrlCtx.close(); });

  test("A.1 · Prepare + authorize a $150 CAD run from a synthetic Coulee batch", async () => {
    const batchId = requireFile(BATCH_A_FILE);
    const bankId = requireFile(BANK_ID_FILE);
    const prep = await pa.request.post(`${BASE_URL}/api/payments/from-payroll/${batchId}/prepare`, {
      data: { clubId: COULEE, fundingBankAccountId: bankId, requestedExecutionDate: "2026-11-30" },
    });
    const p = await prep.json();
    expect(prep.ok(), JSON.stringify(p)).toBeTruthy();
    runId = p.runId;
    fs.writeFileSync("test-results/pay1c1-A-runId.txt", runId);

    const sfa = await pa.request.post(`${BASE_URL}/api/payments/runs/${runId}`, { data: { action: "submit-for-authorization" } });
    expect(sfa.ok()).toBeTruthy();
    const auth = await ctrl.request.post(`${BASE_URL}/api/payments/runs/${runId}`, { data: { action: "authorize" } });
    expect(auth.ok()).toBeTruthy();
  });

  test("A.2 · Configure a synthetic PER_INSTRUCTION limit of CAD $100 (below the $150 amount)", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "configure-limit",
        clubId: COULEE,
        limitKind: "PER_INSTRUCTION",
        limitCurrency: "CAD",
        limitAmount: "100.00",
        limitReason: "PAY-1C.1 acceptance limit — synthetic",
      },
    });
    const b = await r.json();
    console.log("CONFIGURE_LIMIT:", JSON.stringify(b));
    expect(r.ok()).toBeTruthy();
    expect(b.limit.status).toBe("ACTIVE");
    limitId = b.limit.id;
  });

  test("A.3 · Snapshot AUTHORIZED state BEFORE submit attempt", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "read-run", clubId: COULEE, runId },
    });
    const b = await r.json();
    console.log("BEFORE_SUBMIT:", JSON.stringify(b));
    expect(r.ok()).toBeTruthy();
    expect(b.run.status).toBe("AUTHORIZED");
    expect(b.authorization.status).toBe("ACTIVE");
    expect(b.journalEntryCount).toBe(0);
    fs.writeFileSync("test-results/pay1c1-A-before.json", JSON.stringify(b));
  });

  test("A.4 · Deployed submit-to-provider REFUSES with PER_INSTRUCTION limit breach", async () => {
    const r = await pa.request.post(`${BASE_URL}/api/payments/runs/${runId}`, {
      data: { action: "submit-to-provider" },
    });
    const body = await r.json();
    console.log("SUBMIT_ATTEMPT:", JSON.stringify(body));
    expect(r.ok(), "submit should be refused, not succeed").toBeFalsy();
    expect(body.error).toMatch(/PER_INSTRUCTION|limit/i);
  });

  test("A.5 · AFTER refusal — run/instruction/authorization preserved; no JE; provider identity absent", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "read-run", clubId: COULEE, runId },
    });
    const b = await r.json();
    console.log("AFTER_REFUSAL:", JSON.stringify(b));
    expect(r.ok()).toBeTruthy();
    const before = JSON.parse(fs.readFileSync("test-results/pay1c1-A-before.json", "utf8"));
    // Same authorization, same fingerprint, same amount, same instruction identity.
    expect(b.run.paymentFingerprint).toBe(before.run.paymentFingerprint);
    expect(b.run.totalAmount).toBe(before.run.totalAmount);
    expect(b.authorization.paymentFingerprint).toBe(before.authorization.paymentFingerprint);
    expect(b.authorization.status).toBe("ACTIVE");
    expect(b.journalEntryCount).toBe(0);
    for (const inst of b.instructions) {
      expect(inst.providerInstructionId).toBeNull();
      expect(inst.settledAt).toBeNull();
      expect(inst.returnedAt).toBeNull();
    }
  });

  test("A.6 · Work Intake exception surfaced", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "find-work-intake", clubId: COULEE },
    });
    const b = await r.json();
    console.log("WORK_INTAKE:", JSON.stringify(b));
    expect(r.ok()).toBeTruthy();
    expect(b.item).not.toBeNull();
    expect(b.item.workSubtype).toBe("PAYMENT_EXCEPTION_AMOUNT_MISMATCH");
  });

  test("A.7 · Retire the synthetic limit — same authorized economic payment recovers", async () => {
    const r1 = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "retire-limit", clubId: COULEE, limitId },
    });
    expect(r1.ok()).toBeTruthy();
    const before = JSON.parse(fs.readFileSync("test-results/pay1c1-A-before.json", "utf8"));

    const r2 = await pa.request.post(`${BASE_URL}/api/payments/runs/${runId}`, {
      data: { action: "submit-to-provider" },
    });
    const b2 = await r2.json();
    console.log("SUBMIT_AFTER_RETIRE:", JSON.stringify(b2));
    expect(r2.ok(), JSON.stringify(b2)).toBeTruthy();

    const r3 = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "read-run", clubId: COULEE, runId },
    });
    const b3 = await r3.json();
    console.log("AFTER_RECOVERY:", JSON.stringify(b3));
    // Same PaymentInstruction id (no duplicate created).
    const beforeIds = before.instructions.map((i: { id: string }) => i.id).sort();
    const afterIds = b3.instructions.map((i: { id: string }) => i.id).sort();
    expect(afterIds).toEqual(beforeIds);
    expect(b3.authorization.paymentFingerprint).toBe(before.authorization.paymentFingerprint);
  });
});

test.describe("PAY-1C.1 · Scenario C · incident-driven containment through legitimate PAY-1B controls", () => {
  test.setTimeout(240_000);
  let paCtx: BrowserContext, ctrlCtx: BrowserContext, pa: Page, ctrl: Page;
  let incidentId = "";
  let connectionId = "";

  test.beforeAll(async ({ browser }) => {
    paCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    pa = await loginAs(paCtx, PA_EMAIL, FIXTURE_PW);
    ctrlCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    ctrl = await loginAs(ctrlCtx, CTRL_EMAIL, FIXTURE_PW);
  });
  test.afterAll(async () => { await paCtx.close(); await ctrlCtx.close(); });

  test("C.1 · Reuse the PAY-1B.1 outage SIMULATOR connection (must be ACTIVE at start)", async () => {
    const connIdFile = "test-results/pay1b1-connection-id.txt";
    connectionId = requireFile(connIdFile);
    // If a previous run left it SUSPENDED, restore first.
    const restoreOpen = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "open-incident",
        clubId: COULEE,
        category: "PROVIDER_OUTAGE",
        severity: "SEV_3",
        summary: "PAY-1C.1 C · setup — precondition",
      },
    });
    const rb = await restoreOpen.json();
    expect(restoreOpen.ok()).toBeTruthy();
    const restore = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "contain-connection",
        clubId: COULEE,
        connectionId,
        incidentId: rb.incidentId,
        containNext: "ACTIVE",
      },
    });
    console.log("PRECOND_RESTORE:", await restore.text());
  });

  test("C.2 · Open a PROVIDER_OUTAGE incident linked to the connection", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "open-incident",
        clubId: COULEE,
        category: "PROVIDER_OUTAGE",
        severity: "SEV_2",
        summary: "PAY-1C.1 C · legitimate containment acceptance",
        linkConnectionId: connectionId,
      },
    });
    const b = await r.json();
    console.log("INCIDENT_OPEN:", JSON.stringify(b));
    expect(r.ok()).toBeTruthy();
    incidentId = b.incidentId;
  });

  test("C.3 · Invoke LEGITIMATE containment: setConnectionStatus(SUSPENDED) via probe (which calls the PAY-1B service, not a Prisma mutation)", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "contain-connection",
        clubId: COULEE, connectionId, incidentId, containNext: "SUSPENDED",
      },
    });
    const b = await r.json();
    console.log("CONTAINMENT:", JSON.stringify(b));
    expect(r.ok()).toBeTruthy();
    expect(b.status).toBe("SUSPENDED");
  });

  test("C.4 · Deployed PAY-1B assertConnectionUsable refuses the SUSPENDED connection — new submissions cannot proceed", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "check-connection-usable", clubId: COULEE, connectionId },
    });
    const b = await r.json();
    console.log("CONTAINED_USABLE:", JSON.stringify(b));
    expect(r.ok()).toBeTruthy();
    expect(b.usable).toBe(false);
    expect(b.status).toBe("SUSPENDED");
    expect(b.reason).toMatch(/SUSPENDED/i);
  });

  test("C.5 · Existing PaymentInstructions preserved; no speculative accounting", async () => {
    const runIdA = fs.readFileSync("test-results/pay1c1-A-runId.txt", "utf8").trim();
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: { scenario: "read-run", clubId: COULEE, runId: runIdA },
    });
    const b = await r.json();
    console.log("STATE_UNDER_CONTAINMENT:", JSON.stringify(b));
    const before = JSON.parse(fs.readFileSync("test-results/pay1c1-A-before.json", "utf8"));
    // Payment identity + fingerprint identical to pre-containment.
    expect(b.authorization.paymentFingerprint).toBe(before.authorization.paymentFingerprint);
    for (const inst of b.instructions) {
      const match = before.instructions.find((i: { id: string }) => i.id === inst.id);
      expect(match).toBeTruthy();
      expect(inst.amount).toBe(match.amount);
      expect(inst.destinationSnapshotId).toBe(match.destinationSnapshotId);
    }
  });

  test("C.6 · Recovery: setConnectionStatus(ACTIVE) via probe + timeline records restore", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "contain-connection",
        clubId: COULEE, connectionId, incidentId, containNext: "ACTIVE",
      },
    });
    const b = await r.json();
    console.log("RESTORE:", JSON.stringify(b));
    expect(r.ok()).toBeTruthy();
    expect(b.status).toBe("ACTIVE");
  });

  test("C.7 · Cross-tenant containment refusal — probe refuses when clubId does not match the target connection", async () => {
    const r = await ctrl.request.post(`${BASE_URL}/api/payments/testing/pay1c-probe`, {
      data: {
        scenario: "contain-connection",
        clubId: "cmxxxdifferenttenantxxxxxxx",
        connectionId, incidentId, containNext: "SUSPENDED",
      },
    });
    const body = await r.json();
    console.log("CROSS_TENANT:", JSON.stringify(body));
    expect(r.ok()).toBeFalsy();
  });
});
