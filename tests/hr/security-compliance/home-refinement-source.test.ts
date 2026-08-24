// HR-2C Home refinement (2026-08-24) — Source-contract for the Home
// page rewrite. Founder invariants pinned in source:
//   §1  Hero is preserved (EmployeePortalHero rendered as before).
//   §3  Dismissal action never touches training / availability /
//       scheduling / HR state directly.
//   §4  Welcome heading + employee-number/position/etc summary
//       are removed from Home (they still live in Profile).
//   §5  Five widgets present with the exact founder-facing labels.
//   §11 No redundant welcome/profile summary between hero and
//       widgets.
//   §12 Notifications consume the canonical resolver, not their own
//       source of truth.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const HOME = "src/app/employee/(authed)/page.tsx";
const NOTIF_SERVICE = "src/lib/hr/home-notifications.ts";
const NOTIF_ACTIONS = "src/app/employee/(authed)/_home/_actions.ts";
const NOTIF_BAR = "src/app/employee/(authed)/_home/HomeNotificationBar.tsx";
const WIDGETS = "src/app/employee/(authed)/_home/HomeWidgetGrid.tsx";

describe("HR-2C Home refinement · source-contract", () => {
  const home = src(HOME);
  const homeCode = code(HOME);
  const service = src(NOTIF_SERVICE);
  const serviceCode = code(NOTIF_SERVICE);
  const actions = src(NOTIF_ACTIONS);
  const actionsCode = code(NOTIF_ACTIONS);
  const bar = src(NOTIF_BAR);
  const widgets = src(WIDGETS);

  it("§1 — Hero is preserved (EmployeePortalHero + tour + Club media still wired)", () => {
    expect(home).toMatch(/import EmployeePortalHero/);
    expect(home).toMatch(/import EmployeeTourOnFirstLogin/);
    expect(home).toMatch(/getClubMedia\([^)]*"employee_portal_hero"/);
    // Hero receives the same greeting name + position props.
    expect(home).toMatch(/greetingName=/);
    expect(home).toMatch(/positionName=/);
  });

  it("§4 — Welcome heading + profile summary are REMOVED from Home (comment-stripped)", () => {
    expect(homeCode).not.toMatch(/Welcome to your employee portal/);
    expect(homeCode).not.toMatch(/portal-home-summary/);
    expect(homeCode).not.toMatch(/Employee number/);
    expect(homeCode).not.toMatch(/Employment type/);
    expect(homeCode).not.toMatch(/Onboarding status/);
    expect(homeCode).not.toMatch(/Reports to/);
  });

  it("§5/§8 — five widgets present with founder-facing labels", () => {
    const labels = ["Scheduling", "Paystubs", "Time Off Requests", "Forms", "Training"];
    for (const label of labels) {
      expect(home).toContain(`label: "${label}"`);
    }
    // No forbidden abbreviations.
    expect(home).not.toMatch(/\bPTO\b/);
  });

  it("§7 — widget routes match the discovered destinations exactly", () => {
    // Real routes.
    expect(home).toMatch(/href: "\/employee\/schedule"/);
    expect(home).toMatch(/href: "\/employee\/pay"/);
    expect(home).toMatch(/href: "\/employee\/safety-training"/);
    // Unavailable widgets carry href: null (no fake routes).
    // Match: within a widget object whose key is "time-off-requests" or "forms", the href line is null.
    const timeOff = home.match(/key: "time-off-requests"[\s\S]*?href:\s*null/);
    const forms = home.match(/key: "forms"[\s\S]*?href:\s*null/);
    expect(timeOff, "time-off-requests widget must be href:null").not.toBeNull();
    expect(forms, "forms widget must be href:null").not.toBeNull();
  });

  it("§12 — notifications derive from the canonical resolver + never mutate HR state", () => {
    // Service reads the canonical resolver.
    expect(service).toMatch(/resolveEmployeeSchedulingEligibility/);
    // Service is READ-ONLY except for the dismissal upsert (never
    // writes training/availability/employee tables).
    const forbidden =
      /prisma\.(training(Completion|Progress|Attempt|Assignment|Course|CourseVersion|AnswerOption|QuestionResponse|Question)|employeeAvailabilityWeek|employee)\.(create|update|upsert|delete|deleteMany|updateMany)/;
    expect(serviceCode).not.toMatch(forbidden);
    // The only write allowed is on the dismissal table itself.
    expect(service).toMatch(/employeeHomeNotificationDismissal\.upsert/);
  });

  it("§3 — dismissal action delegates to the canonical service; never touches training / availability directly", () => {
    expect(actions).toMatch(/dismissHomeNotification/);
    expect(actions).toMatch(/getEmployeePortalPrincipal/);
    const forbidden =
      /prisma\.(training(Completion|Progress|Attempt|Course|CourseVersion|AnswerOption|Question|QuestionResponse|Assignment)|employeeAvailabilityWeek|employee)\./;
    expect(actionsCode).not.toMatch(forbidden);
  });

  it("§3 — notification bar's × click emits the dismissal action only (no local eligibility overrides)", () => {
    // The bar imports NOTHING from training / availability modules.
    expect(bar).not.toMatch(/@\/lib\/hr\/training/);
    expect(bar).not.toMatch(/@\/lib\/hr\/availability/);
    expect(bar).not.toMatch(/@\/lib\/hr\/scheduling-eligibility/);
    // The dismiss handler calls the passed-in action with the key.
    expect(bar).toMatch(/dismissAction\(notificationKey\)/);
    // × button has an aria-label.
    expect(bar).toMatch(/aria-label="Dismiss notification"/);
  });

  it("§11 — Home hierarchy: Hero → notifications (conditional) → widgets; no welcome/profile block between them", () => {
    // The section elements appear in that structural order in the JSX.
    const heroIdx = home.indexOf("<EmployeePortalHero");
    const notifIdx = home.indexOf('data-testid="portal-home-notifications"');
    const widgetIdx = home.indexOf('<HomeWidgetGrid');
    expect(heroIdx).toBeGreaterThan(-1);
    expect(notifIdx).toBeGreaterThan(-1);
    expect(widgetIdx).toBeGreaterThan(-1);
    expect(heroIdx).toBeLessThan(notifIdx);
    expect(notifIdx).toBeLessThan(widgetIdx);
    // Notifications are conditional (only render when > 0).
    expect(home).toMatch(/activeNotifications\.length > 0/);
  });

  it("§6/§8 — widgets are compact tiles, no oversized cards, no emoji, no neon colours", () => {
    // Grid uses restrained columns + gap.
    expect(widgets).toMatch(/grid-cols-2 md:grid-cols-3 lg:grid-cols-5/);
    // Tile min-height stays compact (< 200 px).
    expect(widgets).toMatch(/min-h-\[112px\]/);
    // No emoji characters in the widget grid or the Home tsx.
    // (Rudimentary check: reject non-ASCII except the standard curly
    // punctuation we already use like en-dash, right-single-quote.)
    const suspect = /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u;
    expect(suspect.test(home)).toBe(false);
    expect(suspect.test(widgets)).toBe(false);
    // No bright neon colours (no #ff00...).
    expect(widgets).not.toMatch(/#(ff[0-9a-f]{4}|00ff[0-9a-f]{2}|[0-9a-f]{2}ff[0-9a-f]{2}|[0-9a-f]{4}ff)\b/i);
  });

  it("§8 — no implementation terminology (Pay label was 'Pay' in sidebar; on Home it is now 'Paystubs')", () => {
    expect(home).toContain(`label: "Paystubs"`);
    // No stray 'Pay' widget label — Home uses Paystubs.
    expect(home).not.toMatch(/label:\s*"Pay"[\s,]/);
  });

  it("Migration is additive-only", () => {
    const migration = src("prisma-postgres/migrations/20260824_hr2c_home_notification_dismissal/migration.sql");
    expect(migration).toMatch(/CREATE TABLE "EmployeeHomeNotificationDismissal"/);
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
    expect(migration).not.toMatch(/ALTER\s+TABLE/i);
  });
});
