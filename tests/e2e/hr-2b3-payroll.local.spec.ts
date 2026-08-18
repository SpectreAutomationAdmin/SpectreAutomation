// HR-2B.3 (2026-08-19) — Local Playwright acceptance for the
// employee-facing PAYROLL flow (/hr/onboarding/payroll/**).
//
// Runs against a local `npm run dev` server that Playwright auto-
// starts via the `webServer` block in playwright.config.ts. All
// fixtures are primed via `scripts/hr-2b2-fixture-invitation.mjs`,
// which now wipes the HR-2B.3 sensitive payroll rows in addition to
// the HR-2B.2 About-You rows (see `resetEmployeeOnboardingState`).
//
// Coverage:
//   Case A · desktop happy path — sin → banking → void cheque →
//            TD1 federal → TD1 provincial → review → complete
//   Case B · persistence + browser refresh + back navigation
//   Case C · SIN + banking replacement flow (Change SIN, replace bank)
//   Case D · sensitive-data leak assertions (DOM / URL / cookies /
//            localStorage / sessionStorage)
//   Case E · mobile viewport (390 × 844) happy path with overflow guards
//   Case F · cookie-close resume — the fixture invitation is
//            idempotently re-redeemable, session rehydrates payroll
//            completion from the DB rows already written
//
// SYNTHETIC test values only. NEVER real SIN, bank account, or PII:
//   SIN                : 046 454 286  (Luhn-valid, last-three 286)
//   Replacement SIN    : 130 692 544  (Luhn-valid, last-three 544)
//   Bank holder        : Bethany Nakamura
//   Bank institution   : 003
//   Bank transit       : 12345
//   Bank account       : 1234567890   (last-four 7890)
//   Replacement account: 9876543210   (last-four 3210)
//   Void cheque bytes  : minimal %PDF-1.4 stub, in-memory only
//
// Screenshots land under test-results/hr-2b3-payroll/. The fixture
// JSON is git-ignored (test-results/).

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.resolve("test-results/hr-2b3-payroll");
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_PATH_DEFAULT = path.resolve("test-results/hr-2b2-fixture.json");
const FIXTURE_SCRIPT = path.resolve("scripts/hr-2b2-fixture-invitation.mjs");

// Synthetic values pinned per the founder brief §Synthetic test values.
const SIN_PRIMARY = "046 454 286";
const SIN_PRIMARY_DIGITS = "046454286";
const SIN_PRIMARY_LASTTHREE = "286";
const SIN_REPLACEMENT = "130 692 544";
const SIN_REPLACEMENT_LASTTHREE = "544";

const BANK_HOLDER = "Bethany Nakamura";
const BANK_INSTITUTION = "003";
const BANK_TRANSIT = "12345";
const BANK_ACCOUNT_PRIMARY = "1234567890";
const BANK_ACCOUNT_PRIMARY_LASTFOUR = "7890";
const BANK_ACCOUNT_REPLACEMENT = "9876543210";
const BANK_ACCOUNT_REPLACEMENT_LASTFOUR = "3210";

// Minimal synthetic PDF byte string. NEVER real banking content.
const VOID_CHEQUE_PDF = Buffer.from(
  "%PDF-1.4\n%test synthetic void cheque\n%%EOF\n",
  "utf8",
);

interface Fixture {
  clubId: string;
  clubName: string;
  employeeId: string;
  employeeFirstName: string;
  employeeLastName: string;
  employeePreferredName: string | null;
  departmentId: string;
  departmentName: string;
  positionId: string;
  positionName: string;
  employmentType: string;
  expectedStartDate: string | null;
  sessionId: string;
  invitationId: string;
  rawToken: string;
  expiresAt: string;
  redemptionUrl: string;
}

function readFixture(fixturePath = FIXTURE_PATH_DEFAULT): Fixture {
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`[hr-2b3-spec] fixture file missing: ${fixturePath}`);
  }
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
}

/** Prime a fresh fixture invitation for `email`. See
 *  scripts/hr-2b2-fixture-invitation.mjs — the script wipes every
 *  About-You and Payroll row for the fixture employee, then writes a
 *  fresh INVITED session + invitation. Overwrites
 *  test-results/hr-2b2-fixture.json in place. */
function primeFixture(email: string): Fixture {
  execFileSync("node", [FIXTURE_SCRIPT, "--email", email], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return readFixture();
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(
    scrollWidth,
    `horizontal overflow at ${label} (scrollWidth=${scrollWidth} vs clientWidth=${clientWidth})`,
  ).toBeLessThanOrEqual(clientWidth + 1);
}

/** Walk the About-You section end-to-end so we land at the payroll
 *  hand-off. Deliberately terse — the HR-2B.2 spec is the canonical
 *  About-You coverage; here we just want the employee session with
 *  About-You marked done so the Payroll flow becomes reachable. */
async function walkAboutYou(page: Page, fixture: Fixture, opts: { photoBytes?: Buffer } = {}) {
  const tinyPng = opts.photoBytes ?? Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );

  await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/name/, { timeout: 30_000 }),
    page.locator('[data-testid="hr-onboarding-begin"]').click(),
  ]);
  await page.locator('input[name="firstName"]').fill(fixture.employeeFirstName);
  await page.locator('input[name="lastName"]').fill(fixture.employeeLastName);
  await page.locator('input[name="preferredName"]').fill("PayrollChris");
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/contact/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);

  await page.locator('input[name="personalEmail"]').fill("payroll-chris@spectre.test");
  await page.locator('input[name="mobilePhone"]').fill("(403) 555-0111");
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/employment/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);

  await page.locator('[data-testid="employment-outcome-correct"]').check();
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/photo/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);

  await page.setInputFiles('input[type="file"][name="photo"]', {
    name: "me.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await expect(page.locator('img[alt="Selected photo preview"]')).toBeVisible();
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/about-you\/complete/, { timeout: 30_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
}

/** After the DirectDepositCards render defaults to whichever card is
 *  missing, the manual card is the default when no bank exists. On a
 *  revisit after banking is already saved (hasBank=true) the upload
 *  card is default-selected instead — so we click the manual choice
 *  button explicitly, then wait for the manual form to mount before
 *  asserting on its inputs. Retries the click a few times to survive
 *  Next.js client-component hydration lag. */
async function ensureManualBankingCardOpen(page: Page) {
  const manualForm = page.locator('[data-testid="banking-holder-name"]');
  if ((await manualForm.count()) > 0 && (await manualForm.isVisible())) return;
  const manualBtn = page.locator('[data-testid="banking-choice-manual"]');
  await expect(manualBtn).toBeVisible();
  // Wait for hydration by waiting for network idle; the client
  // component needs its JS bundle before the onClick handler fires.
  await page.waitForLoadState("networkidle").catch(() => {});
  // Retry click up to 3 times — the first click can race hydration.
  for (let attempt = 0; attempt < 3; attempt++) {
    await manualBtn.click();
    try {
      await expect(manualForm).toBeVisible({ timeout: 3_000 });
      return;
    } catch {
      // Fall through, retry.
      await page.waitForTimeout(500);
    }
  }
  // Final assert with the full timeout so we get a useful failure.
  await expect(manualForm).toBeVisible({ timeout: 5_000 });
}

async function fillBankingAndSubmit(
  page: Page,
  values: { holder: string; institution: string; transit: string; account: string },
) {
  await ensureManualBankingCardOpen(page);
  await page.locator('[data-testid="banking-holder-name"]').fill(values.holder);
  await page.locator('[data-testid="banking-institution"]').fill(values.institution);
  await page.locator('[data-testid="banking-transit"]').fill(values.transit);
  await page.locator('[data-testid="banking-account"]').fill(values.account);
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/payroll\/td1-federal/, { timeout: 20_000 }),
    page.locator('[data-testid="banking-save"]').click(),
  ]);
}

async function submitSin(page: Page, sin: string) {
  await page.locator('[data-testid="sin-input"]').fill(sin);
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/payroll\/direct-deposit/, { timeout: 20_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
}

async function submitTd1FederalBasic(page: Page) {
  // "basic" mode is the default radio. Attest and submit.
  await page.locator('[data-testid="td1-federal-attestation"]').check();
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/payroll\/td1-provincial/, { timeout: 20_000 }),
    page.locator('[data-testid="td1-federal-continue"]').click(),
  ]);
}

async function submitTd1ProvincialBasic(page: Page) {
  await page.locator('[data-testid="td1-provincial-attestation"]').check();
  await Promise.all([
    page.waitForURL(/\/hr\/onboarding\/payroll\/review/, { timeout: 20_000 }),
    page.locator('[data-testid="td1-provincial-continue"]').click(),
  ]);
}

test.describe.serial("HR-2B.3 · Payroll flow local acceptance", () => {
  test.setTimeout(300_000);

  // ---------------------------------------------------------------------
  // Case A — desktop happy path (1440×900).
  // ---------------------------------------------------------------------
  test("Case A · desktop happy path (SIN → banking → TD1 → review → complete)", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-desktop-fixture@spectre.test");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    try {
      // ---------- About-you setup (prerequisite) ----------
      await walkAboutYou(page, fixture);

      // ---------- Continue-to-payroll hand-off ----------
      await expect(page).toHaveURL(/\/hr\/onboarding\/about-you\/complete/);
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll/, { timeout: 20_000 }),
        page.locator('[data-testid="continue-to-payroll"]').click(),
      ]);

      // ---------- SIN — empty ----------
      await page.waitForURL(/\/hr\/onboarding\/payroll\/sin$/, { timeout: 20_000 });
      await expect(page.locator('[data-testid="sin-input"]')).toBeVisible();
      await page.screenshot({ path: path.join(OUT, "payroll-01-sin-empty-desktop.png") });

      // ---------- SIN — submit ----------
      await submitSin(page, SIN_PRIMARY);

      // ---------- SIN — masked on revisit ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/sin", { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-testid="sin-masked"]')).toContainText(`XXX XXX ${SIN_PRIMARY_LASTTHREE}`);
      // The raw text input must NOT be rendered when a masked SIN exists.
      await expect(page.locator('[data-testid="sin-input"]')).toHaveCount(0);
      // Change-SIN affordance is visible.
      await expect(page.locator('[data-testid="sin-change"]')).toBeVisible();
      await page.screenshot({ path: path.join(OUT, "payroll-02-sin-masked-desktop.png") });

      // ---------- Direct deposit — empty ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/direct-deposit", { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-testid="banking-holder-name"]')).toBeVisible();
      await page.screenshot({ path: path.join(OUT, "payroll-03-banking-empty-desktop.png") });

      // ---------- Direct deposit — submit ----------
      await fillBankingAndSubmit(page, {
        holder: BANK_HOLDER,
        institution: BANK_INSTITUTION,
        transit: BANK_TRANSIT,
        account: BANK_ACCOUNT_PRIMARY,
      });

      // ---------- Direct deposit — masked on revisit ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/direct-deposit", { waitUntil: "domcontentloaded" });
      const summary = page.locator('[data-testid="banking-summary"]');
      await expect(summary).toBeVisible();
      await expect(summary).toContainText(BANK_HOLDER);
      await expect(summary).toContainText(`Account ending in ${BANK_ACCOUNT_PRIMARY_LASTFOUR}`);
      // Full account/transit MUST NOT appear in the DOM.
      const bankingHtml = await page.content();
      expect(
        bankingHtml.includes(BANK_ACCOUNT_PRIMARY),
        "full account number must not appear in the rendered banking page",
      ).toBeFalsy();
      expect(
        bankingHtml.split(BANK_TRANSIT).length,
        // "12345" is short; the only legit occurrence should be inside
        // the transit input's placeholder attribute. If the manual card
        // is closed on revisit the placeholder isn't rendered either.
        // Assert 0 or 1 occurrences (never 2+, which would suggest a
        // masked-revisit render is echoing the transit back).
      ).toBeLessThanOrEqual(2);
      await page.screenshot({ path: path.join(OUT, "payroll-04-banking-masked-desktop.png") });

      // ---------- Direct deposit — void-cheque upload ----------
      await page.locator('[data-testid="banking-choice-upload"]').click();
      await page.setInputFiles('[data-testid="void-cheque-input"]', {
        name: "void-cheque.pdf",
        mimeType: "application/pdf",
        buffer: VOID_CHEQUE_PDF,
      });
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll\/direct-deposit/, { timeout: 20_000 }),
        page.locator('[data-testid="banking-upload-submit"]').click(),
      ]);
      await expect(page.locator('[data-testid="banking-document-summary"]')).toBeVisible();
      await page.screenshot({ path: path.join(OUT, "payroll-05-void-cheque-desktop.png") });

      // ---------- Federal TD1 ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/td1-federal", { waitUntil: "domcontentloaded" });
      await page.screenshot({ path: path.join(OUT, "payroll-06-td1-federal-desktop.png") });
      // Province selector renders because the fixture Employee has no
      // province on file yet. Pick Alberta.
      await page.locator('[data-testid="td1-federal-province"]').selectOption("AB");
      await submitTd1FederalBasic(page);

      // ---------- Provincial TD1 ----------
      await page.waitForURL(/\/hr\/onboarding\/payroll\/td1-provincial$/, { timeout: 20_000 });
      await page.screenshot({ path: path.join(OUT, "payroll-07-td1-provincial-desktop.png") });
      await submitTd1ProvincialBasic(page);

      // ---------- Review ----------
      await page.waitForURL(/\/hr\/onboarding\/payroll\/review$/, { timeout: 20_000 });
      await page.screenshot({ path: path.join(OUT, "payroll-08-review-desktop.png") });
      const reviewBody = await page.locator("body").textContent();
      expect(reviewBody, "review shows masked SIN").toContain(`XXX XXX ${SIN_PRIMARY_LASTTHREE}`);
      expect(reviewBody, "review shows holder name").toContain(BANK_HOLDER);
      expect(reviewBody, "review shows account ending mask").toContain(
        `Account ending in ${BANK_ACCOUNT_PRIMARY_LASTFOUR}`,
      );
      // Federal TD1 form version is displayed.
      expect(reviewBody, "review shows TD1 form version").toMatch(/TD1-\d{4}/);
      // Province name is shown ("Alberta").
      expect(reviewBody, "review shows province name").toContain("Alberta");

      // ---------- Complete ----------
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll\/complete$/, { timeout: 20_000 }),
        page.locator('[data-testid="payroll-complete"]').click(),
      ]);
      await page.screenshot({ path: path.join(OUT, "payroll-09-complete-desktop.png") });
    } finally {
      await ctx.close();
    }
  });

  // ---------------------------------------------------------------------
  // Case B — persistence + browser refresh + back navigation.
  // ---------------------------------------------------------------------
  test("Case B · persistence + Back navigation", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-persistence-fixture@spectre.test");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    try {
      await walkAboutYou(page, fixture);
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll/, { timeout: 20_000 }),
        page.locator('[data-testid="continue-to-payroll"]').click(),
      ]);

      // SIN → banking (2 canonical steps).
      await page.waitForURL(/\/hr\/onboarding\/payroll\/sin$/, { timeout: 20_000 });
      await submitSin(page, SIN_PRIMARY);
      await fillBankingAndSubmit(page, {
        holder: BANK_HOLDER,
        institution: BANK_INSTITUTION,
        transit: BANK_TRANSIT,
        account: BANK_ACCOUNT_PRIMARY,
      });

      // ---------- Refresh + revisit direct-deposit ----------
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.goto("http://localhost:3000/hr/onboarding/payroll/direct-deposit", { waitUntil: "domcontentloaded" });
      const summary = page.locator('[data-testid="banking-summary"]');
      await expect(summary).toBeVisible();
      await expect(summary).toContainText(BANK_HOLDER);
      await expect(summary).toContainText(`Account ending in ${BANK_ACCOUNT_PRIMARY_LASTFOUR}`);

      // ---------- Back to SIN — masked + change button ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/sin", { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-testid="sin-masked"]')).toContainText(`XXX XXX ${SIN_PRIMARY_LASTTHREE}`);
      await expect(page.locator('[data-testid="sin-change"]')).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  // ---------------------------------------------------------------------
  // Case C — SIN + banking replacement.
  // ---------------------------------------------------------------------
  test("Case C · SIN + banking replacement", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-replace-fixture@spectre.test");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    try {
      await walkAboutYou(page, fixture);
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll/, { timeout: 20_000 }),
        page.locator('[data-testid="continue-to-payroll"]').click(),
      ]);

      // ---------- SIN — submit initial ----------
      await page.waitForURL(/\/hr\/onboarding\/payroll\/sin$/, { timeout: 20_000 });
      await submitSin(page, SIN_PRIMARY);

      // ---------- Change SIN ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/sin", { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-testid="sin-masked"]')).toContainText(`XXX XXX ${SIN_PRIMARY_LASTTHREE}`);
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll\/sin$/, { timeout: 20_000 }),
        page.locator('[data-testid="sin-change"]').click(),
      ]);
      // Input is now blank; masked helper gone.
      await expect(page.locator('[data-testid="sin-input"]')).toBeVisible();
      await expect(page.locator('[data-testid="sin-masked"]')).toHaveCount(0);

      // ---------- Submit replacement SIN ----------
      await submitSin(page, SIN_REPLACEMENT);
      await page.goto("http://localhost:3000/hr/onboarding/payroll/sin", { waitUntil: "domcontentloaded" });
      const maskedText = await page.locator('[data-testid="sin-masked"]').textContent();
      expect(maskedText, "masked SIN reflects replacement").toContain(SIN_REPLACEMENT_LASTTHREE);
      expect(maskedText, "masked SIN does NOT reflect prior value").not.toContain(SIN_PRIMARY_LASTTHREE);

      // ---------- Banking — submit initial ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/direct-deposit", { waitUntil: "domcontentloaded" });
      await fillBankingAndSubmit(page, {
        holder: BANK_HOLDER,
        institution: BANK_INSTITUTION,
        transit: BANK_TRANSIT,
        account: BANK_ACCOUNT_PRIMARY,
      });

      // ---------- Banking — submit replacement account ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/direct-deposit", { waitUntil: "domcontentloaded" });
      // Manual card is closed by default on this revisit because bank+doc
      // completion suppresses it. Open it explicitly.
      await ensureManualBankingCardOpen(page);
      await fillBankingAndSubmit(page, {
        holder: BANK_HOLDER,
        institution: BANK_INSTITUTION,
        transit: BANK_TRANSIT,
        account: BANK_ACCOUNT_REPLACEMENT,
      });

      // ---------- Assert masked reads new value + only one non-terminal row ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll/direct-deposit", { waitUntil: "domcontentloaded" });
      const summary = page.locator('[data-testid="banking-summary"]');
      await expect(summary).toContainText(`Account ending in ${BANK_ACCOUNT_REPLACEMENT_LASTFOUR}`);
      await expect(summary, "prior last-four must not remain on the summary card").not.toContainText(
        `Account ending in ${BANK_ACCOUNT_PRIMARY_LASTFOUR}`,
      );

      // HR-1H invariant: replacing a PENDING_PENNY_TEST row is an
      // in-place update, so there should be exactly ONE non-terminal
      // row after the replacement. Validate via the API sink already
      // exercised: getSelfBankAccountMasked returns the CURRENT row
      // only — if two co-existed, the "orderBy updatedAt desc" would
      // choose the newest, but that doesn't prove the older row was
      // dropped. Assert via the direct-deposit page instead: only one
      // summary card must render.
      await expect(
        page.locator('[data-testid="banking-summary"]'),
        "exactly one active banking summary card renders",
      ).toHaveCount(1);
    } finally {
      await ctx.close();
    }
  });

  // ---------------------------------------------------------------------
  // Case D — sensitive-data leak assertions.
  // ---------------------------------------------------------------------
  test("Case D · sensitive-data leak assertions", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-leak-fixture@spectre.test");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    const visitedUrls: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visitedUrls.push(frame.url());
    });

    try {
      await walkAboutYou(page, fixture);
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll/, { timeout: 20_000 }),
        page.locator('[data-testid="continue-to-payroll"]').click(),
      ]);

      // ---------- Walk the full payroll flow quickly ----------
      await page.waitForURL(/\/hr\/onboarding\/payroll\/sin$/, { timeout: 20_000 });
      await submitSin(page, SIN_PRIMARY);
      await fillBankingAndSubmit(page, {
        holder: BANK_HOLDER,
        institution: BANK_INSTITUTION,
        transit: BANK_TRANSIT,
        account: BANK_ACCOUNT_PRIMARY,
      });
      await page.locator('[data-testid="td1-federal-province"]').selectOption("AB");
      await submitTd1FederalBasic(page);
      await submitTd1ProvincialBasic(page);
      await page.waitForURL(/\/hr\/onboarding\/payroll\/review$/, { timeout: 20_000 });

      // ---------- (1) DOM content — no full SIN / no full account ----------
      const reviewHtml = await page.content();
      expect(
        reviewHtml.includes(SIN_PRIMARY_DIGITS),
        "review DOM must not contain the full 9-digit SIN plaintext",
      ).toBeFalsy();
      expect(
        reviewHtml.includes(BANK_ACCOUNT_PRIMARY),
        "review DOM must not contain the full account number plaintext",
      ).toBeFalsy();
      // Transit "12345" is short; on the review page (no input rendered)
      // it must not appear at all.
      expect(
        reviewHtml.includes(BANK_TRANSIT),
        "review DOM must not contain the full transit plaintext",
      ).toBeFalsy();

      // ---------- (2) URLs seen during the flow — no PII in query strings ----------
      for (const u of visitedUrls) {
        expect(u, "no ?sin= in visited URL").not.toMatch(/[?&]sin=/i);
        expect(u, "no ?account= in visited URL").not.toMatch(/[?&]account=/i);
        expect(u, "no ?ssn= in visited URL").not.toMatch(/[?&]ssn=/i);
        expect(u, "no raw 9-digit SIN in URL").not.toContain(SIN_PRIMARY_DIGITS);
        expect(u, "no full account number in URL").not.toContain(BANK_ACCOUNT_PRIMARY);
      }

      // ---------- (3) Cookies — no plaintext SIN / account ----------
      const cookies = await page.context().cookies();
      for (const c of cookies) {
        expect(
          c.value.includes(SIN_PRIMARY_DIGITS),
          `cookie ${c.name} must not contain the full SIN`,
        ).toBeFalsy();
        expect(
          c.value.includes(BANK_ACCOUNT_PRIMARY),
          `cookie ${c.name} must not contain the full account number`,
        ).toBeFalsy();
      }
      // Note: the `spectre_hr_td1_federal_claim` cookie may carry the
      // employee-declared federal claim total (e.g. "16129.00"). That
      // is the employee's own choice of TD1 basic amount, not a leak
      // of the SIN or account number — the founder brief §Case D
      // explicitly calls this out.

      // ---------- (4) localStorage + sessionStorage — no leaks ----------
      const storageDump = await page.evaluate(() => {
        function dump(store: Storage): Record<string, string> {
          const out: Record<string, string> = {};
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k) out[k] = store.getItem(k) ?? "";
          }
          return out;
        }
        return {
          local: dump(localStorage),
          session: dump(sessionStorage),
        };
      });
      const joined = JSON.stringify(storageDump);
      expect(
        joined.includes(SIN_PRIMARY_DIGITS),
        "browser storage must not contain the full SIN",
      ).toBeFalsy();
      expect(
        joined.includes(BANK_ACCOUNT_PRIMARY),
        "browser storage must not contain the full account number",
      ).toBeFalsy();

      await page.screenshot({ path: path.join(OUT, "payroll-10-leak-check-context-desktop.png") });
    } finally {
      await ctx.close();
    }
  });

  // ---------------------------------------------------------------------
  // Case E — mobile happy path (390 × 844).
  // ---------------------------------------------------------------------
  test("Case E · mobile happy path (390 × 844) with no horizontal overflow", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-mobile-fixture@spectre.test");
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();

    try {
      await walkAboutYou(page, fixture);
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll/, { timeout: 20_000 }),
        page.locator('[data-testid="continue-to-payroll"]').click(),
      ]);

      // ---------- SIN ----------
      await page.waitForURL(/\/hr\/onboarding\/payroll\/sin$/, { timeout: 20_000 });
      await assertNoHorizontalOverflow(page, "mobile-sin");
      await page.screenshot({ path: path.join(OUT, "payroll-M01-sin-mobile.png") });
      await submitSin(page, SIN_PRIMARY);

      // ---------- Banking ----------
      await assertNoHorizontalOverflow(page, "mobile-banking");
      await page.screenshot({ path: path.join(OUT, "payroll-M02-banking-mobile.png") });
      await fillBankingAndSubmit(page, {
        holder: BANK_HOLDER,
        institution: BANK_INSTITUTION,
        transit: BANK_TRANSIT,
        account: BANK_ACCOUNT_PRIMARY,
      });

      // ---------- TD1 federal ----------
      await assertNoHorizontalOverflow(page, "mobile-td1-federal");
      await page.screenshot({ path: path.join(OUT, "payroll-M03-td1-federal-mobile.png") });
      await page.locator('[data-testid="td1-federal-province"]').selectOption("AB");
      await submitTd1FederalBasic(page);

      // ---------- TD1 provincial ----------
      await assertNoHorizontalOverflow(page, "mobile-td1-provincial");
      await page.screenshot({ path: path.join(OUT, "payroll-M04-td1-provincial-mobile.png") });
      await submitTd1ProvincialBasic(page);

      // ---------- Review ----------
      await assertNoHorizontalOverflow(page, "mobile-review");
      await page.screenshot({ path: path.join(OUT, "payroll-M05-review-mobile.png") });
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll\/complete$/, { timeout: 20_000 }),
        page.locator('[data-testid="payroll-complete"]').click(),
      ]);
      await assertNoHorizontalOverflow(page, "mobile-complete");
    } finally {
      await ctx.close();
    }
  });

  // ---------------------------------------------------------------------
  // Case F — cookie-close resume.
  // ---------------------------------------------------------------------
  test("Case F · cookie-close resume rehydrates payroll completion", async ({ browser }) => {
    const fixture = primeFixture("hr-2b3-resume-fixture@spectre.test");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    try {
      await walkAboutYou(page, fixture);
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/payroll/, { timeout: 20_000 }),
        page.locator('[data-testid="continue-to-payroll"]').click(),
      ]);

      // ---------- Walk sin + banking (2 of 4 payroll steps) ----------
      await page.waitForURL(/\/hr\/onboarding\/payroll\/sin$/, { timeout: 20_000 });
      await submitSin(page, SIN_PRIMARY);
      await fillBankingAndSubmit(page, {
        holder: BANK_HOLDER,
        institution: BANK_INSTITUTION,
        transit: BANK_TRANSIT,
        account: BANK_ACCOUNT_PRIMARY,
      });

      // ---------- Clear cookies — session gone ----------
      await ctx.clearCookies();
      await page.goto("http://localhost:3000/hr/onboarding/payroll", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/hr\/onboarding\/expired/);

      // ---------- Redeem the same invitation again ----------
      // acquireInvitationContext is idempotent — the invitation is
      // REDEEMED and the session is IN_PROGRESS, so re-visiting the
      // redemption URL and clicking Begin re-stamps the cookie.
      await page.goto(fixture.redemptionUrl, { waitUntil: "domcontentloaded" });
      await Promise.all([
        page.waitForURL(/\/hr\/onboarding\/about-you(\/|$)/, { timeout: 30_000 }),
        page.locator('[data-testid="hr-onboarding-begin"]').click(),
      ]);

      // ---------- Payroll hub should route past sin + banking to td1-federal ----------
      await page.goto("http://localhost:3000/hr/onboarding/payroll", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/hr\/onboarding\/payroll\/td1-federal$/);
    } finally {
      await ctx.close();
    }
  });
});
