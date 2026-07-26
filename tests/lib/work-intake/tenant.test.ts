// Sprint 2 (2026-07-19) — Tenant-isolation utility tests.
//
// Pins the visibility rules for the Work Intake / mailbox layer per
// §12 of the founder's Phase B directive:
//   • cross-club reads are denied
//   • PERSONAL mailboxes are visible only to the connecting user
//   • Club Admin status alone does NOT expose personal mailbox contents
//   • SHARED mailboxes require a live MailboxAccess row

import { describe, it, expect } from "vitest";
import {
  workIntakeReadableByPrincipal,
  mailboxVisibilityFilter,
  assertMailboxReadable,
  MailboxAccessDenied,
  type WorkIntakeReaderPrincipal,
} from "@/lib/work-intake/tenant";

const chris: WorkIntakeReaderPrincipal = {
  userId: "u_chris",
  clubId: "c_silver_springs",
  isClubAdmin: false,
  isSuperAdmin: false,
};

const chrisAsAdmin: WorkIntakeReaderPrincipal = {
  ...chris,
  isClubAdmin: true,
};

const chrisAsSuperAdmin: WorkIntakeReaderPrincipal = {
  ...chris,
  isSuperAdmin: true,
};

const jane: WorkIntakeReaderPrincipal = {
  userId: "u_jane",
  clubId: "c_silver_springs",
  isClubAdmin: false,
  isSuperAdmin: false,
};

describe("mailboxVisibilityFilter — PERSONAL vs SHARED (§12)", () => {
  it("scopes to the principal's club", () => {
    const f = mailboxVisibilityFilter(chris);
    expect(f.clubId).toBe("c_silver_springs");
  });

  it("PERSONAL branch only matches the principal's own userId", () => {
    const f = mailboxVisibilityFilter(chris);
    const personal = (f.OR as Array<Record<string, unknown>>)[0];
    expect(personal).toEqual({ mailboxType: "PERSONAL", userId: "u_chris" });
  });

  it("SHARED branch requires an unrevoked MailboxAccess row", () => {
    const f = mailboxVisibilityFilter(chris);
    const shared = (f.OR as Array<Record<string, unknown>>)[1];
    expect(shared).toEqual({
      mailboxType: "SHARED",
      accesses: { some: { userId: "u_chris", revokedAt: null } },
    });
  });

  it("Club Admin does NOT get personal-mailbox visibility from the role alone", () => {
    // The critical founder-directed invariant: Club Admin status is
    // NOT a bypass. The filter for a Club Admin is identical to the
    // filter for a regular user — mailboxes are seen only via
    // ownership (PERSONAL) or explicit MailboxAccess (SHARED).
    const a = mailboxVisibilityFilter(chris);
    const b = mailboxVisibilityFilter(chrisAsAdmin);
    expect(a).toEqual(b);
  });

  it("SUPER_ADMIN does NOT bypass personal-mailbox privacy either", () => {
    const a = mailboxVisibilityFilter(chris);
    const b = mailboxVisibilityFilter(chrisAsSuperAdmin);
    expect(a).toEqual(b);
  });
});

describe("workIntakeReadableByPrincipal — combined mailbox + non-mailbox visibility", () => {
  it("scopes intake to the principal's club", () => {
    const w = workIntakeReadableByPrincipal(chris);
    expect(w.clubId).toBe("c_silver_springs");
  });

  it("admits intake with NO email origin (AP invoice, weather alert, …)", () => {
    const w = workIntakeReadableByPrincipal(chris);
    const noEmailBranch = (w.OR as Array<Record<string, unknown>>)[0];
    expect(noEmailBranch).toEqual({ emailOrigins: { none: {} } });
  });

  it("email-origin branch delegates to mailboxVisibilityFilter", () => {
    const w = workIntakeReadableByPrincipal(chris);
    const emailBranch = (w.OR as Array<{ emailOrigins: { some: unknown } }>)[1];
    // emailOrigins.some.emailMessage.mailboxConnection must match
    // the exact filter mailboxVisibilityFilter returns, ensuring
    // the two helpers cannot drift apart.
    expect(emailBranch).toEqual({
      emailOrigins: {
        some: {
          emailMessage: {
            mailboxConnection: mailboxVisibilityFilter(chris),
          },
        },
      },
    });
  });
});

describe("assertMailboxReadable — hard authorisation gate", () => {
  it("rejects cross-club reads", () => {
    expect(() =>
      assertMailboxReadable(chris, {
        clubId: "c_other_club",
        userId: "u_chris",
        mailboxType: "PERSONAL",
      }),
    ).toThrow(MailboxAccessDenied);
  });

  it("rejects a personal mailbox owned by another user", () => {
    expect(() =>
      assertMailboxReadable(chris, {
        clubId: "c_silver_springs",
        userId: "u_jane",
        mailboxType: "PERSONAL",
      }),
    ).toThrow(/personal-mailbox-not-owner/);
  });

  it("admits the personal mailbox owner", () => {
    expect(() =>
      assertMailboxReadable(chris, {
        clubId: "c_silver_springs",
        userId: "u_chris",
        mailboxType: "PERSONAL",
      }),
    ).not.toThrow();
  });

  it("admits a shared mailbox with a live MailboxAccess row", () => {
    expect(() =>
      assertMailboxReadable(jane, {
        clubId: "c_silver_springs",
        userId: "u_chris",
        mailboxType: "SHARED",
        accesses: [{ userId: "u_jane", revokedAt: null }],
      }),
    ).not.toThrow();
  });

  it("rejects a shared mailbox where the access was revoked", () => {
    expect(() =>
      assertMailboxReadable(jane, {
        clubId: "c_silver_springs",
        userId: "u_chris",
        mailboxType: "SHARED",
        accesses: [{ userId: "u_jane", revokedAt: new Date("2026-07-18T00:00:00.000Z") }],
      }),
    ).toThrow(/shared-mailbox-no-access/);
  });

  it("rejects a shared mailbox where the principal has no access row", () => {
    expect(() =>
      assertMailboxReadable(jane, {
        clubId: "c_silver_springs",
        userId: "u_chris",
        mailboxType: "SHARED",
        accesses: [],
      }),
    ).toThrow(/shared-mailbox-no-access/);
  });

  it("rejects an unknown mailboxType", () => {
    expect(() =>
      assertMailboxReadable(chris, {
        clubId: "c_silver_springs",
        userId: "u_chris",
        mailboxType: "SERVICE",
      }),
    ).toThrow(/unknown-mailbox-type/);
  });
});
