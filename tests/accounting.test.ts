import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, makeUser, resetDb, principalFor } from "./util/db";
import { bootstrapAccountingClub } from "./util/gl";
import {
  createDraft, post, voidDraft, reverse, validateEntry, approve, createPostedFromAdapter,
} from "@/lib/accounting/journal";
import { setPeriodStatus } from "@/lib/accounting/periods";
import { trialBalance, balanceSheet, incomeStatement, incomeStatementByDepartment } from "@/lib/accounting/reports";
import { accountActivity, accountBalances } from "@/lib/accounting/balance";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { toMoney } from "@/lib/accounting/decimal";

const todayISO = () => new Date().toISOString().slice(0, 10);

describe("Accounting — journal validation", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("rejects unbalanced entries", async () => {
    const club = await bootstrapAccountingClub();
    await expect(
      validateEntry(club.id, {
        entryDate: todayISO(),
        description: "Unbalanced test",
        lines: [
          { accountNumber: "1010", debit: "100" },
          { accountNumber: "4900", credit: "90" },
        ],
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects posting to a header account", async () => {
    // 2026-07-25 — the canonical seed no longer ships header accounts
    // (founder rule 2026-07-08: every DEFAULT_ACCOUNTS entry is a
    // posting account). The header-post guard in
    // src/lib/accounting/journal.ts:133 is still a required contract
    // for accounts flipped to header via the COA admin UI, so the
    // test now flips a seeded account to header inline and posts to
    // it — proving the guard still fires on user-created headers.
    const club = await bootstrapAccountingClub();
    await db().account.update({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: "1000" } },
      data: { isHeader: true, allowManualPosting: false },
    });
    await expect(
      validateEntry(club.id, {
        entryDate: todayISO(),
        description: "Header post test",
        lines: [
          { accountNumber: "1000", debit: "100" }, // flipped to header above
          { accountNumber: "4900", credit: "100" },
        ],
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects unknown accounts", async () => {
    const club = await bootstrapAccountingClub();
    await expect(
      validateEntry(club.id, {
        entryDate: todayISO(),
        description: "Unknown account test",
        lines: [
          { accountNumber: "9999", debit: "100" },
          { accountNumber: "4900", credit: "100" },
        ],
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects manual posting to control accounts unless explicitly allowed", async () => {
    const club = await bootstrapAccountingClub();
    await expect(
      validateEntry(club.id, {
        entryDate: todayISO(),
        description: "Member AR control",
        lines: [
          { accountNumber: "1110", debit: "100" }, // control account
          { accountNumber: "4900", credit: "100" },
        ],
      })
    ).rejects.toBeInstanceOf(ValidationError);

    // Allowed via the adapter flag.
    const v = await validateEntry(club.id, {
      entryDate: todayISO(),
      description: "Member AR control via adapter",
      lines: [
        { accountNumber: "1110", debit: "100" },
        { accountNumber: "4900", credit: "100" },
      ],
    }, { allowControlAccounts: true });
    expect(v.totalDebits.equals(v.totalCredits)).toBe(true);
  });

  it("rejects negative or both-sided lines", async () => {
    const club = await bootstrapAccountingClub();
    await expect(
      validateEntry(club.id, {
        entryDate: todayISO(),
        description: "Bad line shape",
        lines: [
          { accountNumber: "1010", debit: "100", credit: "100" },
          { accountNumber: "4900", credit: "100" },
        ],
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("Accounting — post and reverse", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("posts a balanced entry and updates account balances", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const draft = await createDraft(p, club.id, {
      entryDate: todayISO(),
      description: "Cash sale",
      lines: [
        { accountNumber: "1010", debit: "500.00", description: "cash in" },
        { accountNumber: "4900", credit: "500.00", description: "other revenue" },
      ],
    });
    expect(draft.status).toBe("DRAFT");
    const posted = await post(p, draft.id);
    expect(posted.status).toBe("POSTED");

    const balances = await accountBalances(club.id, {});
    const cash = balances.find((b) => b.accountNumber === "1010")!;
    const rev = balances.find((b) => b.accountNumber === "4900")!;
    expect(cash.naturalBalance.toString()).toBe("500");
    expect(rev.naturalBalance.toString()).toBe("500");
  });

  it("reverse produces a contra entry and the originals stay POSTED+REVERSED", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const draft = await createDraft(p, club.id, {
      entryDate: todayISO(),
      description: "JE for reversal",
      lines: [
        { accountNumber: "1010", debit: "100" },
        { accountNumber: "4900", credit: "100" },
      ],
    });
    await post(p, draft.id);
    const contra = await reverse(p, draft.id, { reason: "duplicate" });

    expect(contra.status).toBe("POSTED");
    expect(contra.reversesId).toBe(draft.id);
    // Original stays POSTED — both entries hit the GL and net to zero. The
    // "this was reversed" relationship is the back-relation, not a status.
    const orig = await db().journalEntry.findUnique({
      where: { id: draft.id },
      include: { reversedBy: true },
    });
    expect(orig?.status).toBe("POSTED");
    expect(orig?.reversedBy?.id).toBe(contra.id);

    // Net balance is zero.
    const balances = await accountBalances(club.id, {});
    const cash = balances.find((b) => b.accountNumber === "1010")!;
    expect(cash.naturalBalance.toString()).toBe("0");
  });

  it("post is idempotent", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const draft = await createDraft(p, club.id, {
      entryDate: todayISO(),
      description: "Idempotency test",
      lines: [
        { accountNumber: "1010", debit: "200" },
        { accountNumber: "4900", credit: "200" },
      ],
    });
    const a = await post(p, draft.id);
    const b = await post(p, draft.id);
    expect(a.id).toBe(b.id);
    expect(a.postedAt).toEqual(b.postedAt);
  });

  it("rejects posting to HARD_LOCKED period", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const period = await db().fiscalPeriod.findFirst({ where: { clubId: club.id } });
    await setPeriodStatus(p, period!.id, "HARD_LOCKED");
    const draft = await createDraft(p, club.id, {
      entryDate: period!.startDate.toISOString().slice(0, 10),
      description: "Locked period test",
      lines: [
        { accountNumber: "1010", debit: "10" },
        { accountNumber: "4900", credit: "10" },
      ],
    });
    await expect(post(p, draft.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects manual posting to SOFT_LOCKED period but adapter can still post", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const period = await db().fiscalPeriod.findFirst({ where: { clubId: club.id } });
    await setPeriodStatus(p, period!.id, "SOFT_LOCKED");
    const draft = await createDraft(p, club.id, {
      entryDate: period!.startDate.toISOString().slice(0, 10),
      description: "Soft locked manual",
      lines: [
        { accountNumber: "1010", debit: "10" },
        { accountNumber: "4900", credit: "10" },
      ],
    });
    await expect(post(p, draft.id)).rejects.toBeInstanceOf(ConflictError);

    // Adapter path bypasses soft lock.
    const adapterEntry = await createPostedFromAdapter(
      p, club.id,
      {
        entryDate: period!.startDate.toISOString().slice(0, 10),
        description: "Adapter post during soft lock",
        lines: [
          { accountNumber: "1110", debit: "10" }, // control account
          { accountNumber: "4900", credit: "10" },
        ],
      },
      { source: "AR_CHARGE", sourceEntityType: "Test", sourceEntityId: "abc123" }
    );
    expect(adapterEntry.status).toBe("POSTED");
  });

  it("cannot reverse a non-POSTED entry", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const draft = await createDraft(p, club.id, {
      entryDate: todayISO(),
      description: "Cannot reverse draft",
      lines: [
        { accountNumber: "1010", debit: "10" },
        { accountNumber: "4900", credit: "10" },
      ],
    });
    await expect(reverse(p, draft.id, { reason: "x" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("void on DRAFT works; void on POSTED is rejected", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");
    const draft = await createDraft(p, club.id, {
      entryDate: todayISO(),
      description: "Void test",
      lines: [
        { accountNumber: "1010", debit: "1" },
        { accountNumber: "4900", credit: "1" },
      ],
    });
    await voidDraft(p, draft.id, "typo");
    const after = await db().journalEntry.findUnique({ where: { id: draft.id } });
    expect(after?.status).toBe("VOIDED");

    const draft2 = await createDraft(p, club.id, {
      entryDate: todayISO(),
      description: "Cannot void posted",
      lines: [
        { accountNumber: "1010", debit: "1" },
        { accountNumber: "4900", credit: "1" },
      ],
    });
    await post(p, draft2.id);
    await expect(voidDraft(p, draft2.id, "x")).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("Accounting — RBAC", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("FINANCE_ADMIN cannot post journals (lacks gl:post)", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "fin@example.com", role: "FINANCE_ADMIN", clubId: club.id });
    const fin = await principalFor("fin@example.com");
    await expect(createDraft(fin, club.id, {
      entryDate: todayISO(), description: "x",
      lines: [{ accountNumber: "1010", debit: "1" }, { accountNumber: "4900", credit: "1" }],
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("AUDITOR_READ_ONLY can read GL but cannot post or reverse", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    await makeUser({ email: "aud@example.com", role: "AUDITOR_READ_ONLY", clubId: club.id });
    const ctl = await principalFor("ctl@example.com");
    const aud = await principalFor("aud@example.com");

    const draft = await createDraft(ctl, club.id, {
      entryDate: todayISO(), description: "auditor RBAC",
      lines: [{ accountNumber: "1010", debit: "1" }, { accountNumber: "4900", credit: "1" }],
    });
    await post(ctl, draft.id);

    // Auditor can list+read — not asserted here for brevity; what matters:
    await expect(reverse(aud, draft.id, { reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Accounting — trial balance and statements", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("trial balance equals after a series of entries", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");

    // 3 entries.
    for (const [debit, credit, drA, crA] of [
      ["500", "500", "1010", "4900"],
      ["200", "200", "5000", "1010"],
      ["100", "100", "1010", "4200"],
    ] as Array<[string, string, string, string]>) {
      const d = await createDraft(p, club.id, {
        entryDate: todayISO(), description: "TB",
        lines: [
          { accountNumber: drA, debit },
          { accountNumber: crA, credit },
        ],
      });
      await post(p, d.id);
    }
    const tb = await trialBalance(club.id, new Date());
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebit.toString()).toBe(tb.totalCredit.toString());
  });

  it("balance sheet is balanced after AR adapter posts", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");

    // Adapter-style posting: charge $400 dues, payment $100.
    await createPostedFromAdapter(p, club.id, {
      entryDate: todayISO(), description: "Charge dues",
      lines: [
        { accountNumber: "1110", debit: "400" }, // Member AR
        { accountNumber: "4000", credit: "400" },// Dues revenue
      ],
    }, { source: "AR_CHARGE", sourceEntityType: "Charge", sourceEntityId: "test-c1" });

    await createPostedFromAdapter(p, club.id, {
      entryDate: todayISO(), description: "Receive payment",
      lines: [
        { accountNumber: "1010", debit: "100" }, // Cash
        { accountNumber: "1110", credit: "100" }, // Member AR
      ],
    }, { source: "AR_PAYMENT", sourceEntityType: "Payment", sourceEntityId: "test-p1" });

    const bs = await balanceSheet(club.id, new Date());
    expect(bs.isBalanced).toBe(true);
    // Assets: cash $100 + AR $300 = $400. Equity (current-year earnings) = $400. Liabilities = $0.
    expect(bs.totalAssets.toString()).toBe("400");
    expect(bs.currentYearEarnings.toString()).toBe("400");
  });

  it("income statement and dept P&L attribute revenue to the right department", async () => {
    // 2026-07-25 — this test now proves BOTH the canonical seed codes
    // AND the retired-code alias resolution work. Two postings use the
    // canonical codes ("F&B", "PROSHOP") and one uses a retired code
    // ("COURSE" → "GROUNDS" via DEPARTMENT_CODE_ALIASES). All three
    // must post cleanly and roll up to the correct departments.
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");

    const today = todayISO();
    const post1 = async (drA: string, crA: string, amount: string, deptCode?: string) => {
      const draft = await createDraft(p, club.id, {
        entryDate: today, description: "test",
        lines: [
          { accountNumber: drA, debit: amount, departmentCode: deptCode ?? null },
          { accountNumber: crA, credit: amount, departmentCode: deptCode ?? null },
        ],
      });
      await post(p, draft.id);
    };
    await post1("1010", "4200", "200", "F&B");      // canonical F&B code
    await post1("1010", "4300", "150", "PROSHOP");  // canonical Pro Shop code
    await post1("6010", "1010", "80",  "COURSE");   // RETIRED code — must resolve → "GROUNDS"

    const is = await incomeStatement(club.id, new Date(new Date().getFullYear() - 1, 0, 1), new Date());
    expect(is.totalRevenue.toString()).toBe("350");
    expect(is.totalOpex.toString()).toBe("80");
    expect(is.netIncome.toString()).toBe("270");

    const dept = await incomeStatementByDepartment(club.id, new Date(new Date().getFullYear() - 1, 0, 1), new Date());
    const fb = dept.rows.find((r) => r.departmentName === "Food & Beverage");
    const proShop = dept.rows.find((r) => r.departmentName === "Pro Shop");
    const grounds = dept.rows.find((r) => r.departmentName === "Grounds");
    expect(fb?.revenue.toString()).toBe("200");
    expect(proShop?.revenue.toString()).toBe("150");
    // "COURSE" resolved through the alias map to "GROUNDS", so the
    // $80 expense must appear on the Grounds row.
    expect(grounds?.opex.toString()).toBe("80");
  });

  it("resolves every retired department code through DEPARTMENT_CODE_ALIASES", async () => {
    // 2026-07-25 — historical imports still carry the retired codes
    // "FB", "COURSE", and "GOLF". The journal engine MUST accept all
    // three and route them to the canonical successors. Regression
    // guard: prevents anyone from removing DEPARTMENT_CODE_ALIASES
    // resolution from src/lib/accounting/journal.ts without noticing
    // that imported historical data would stop posting.
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");

    // "FB" → "F&B"
    await expect(
      createDraft(p, club.id, {
        entryDate: todayISO(), description: "alias FB",
        lines: [
          { accountNumber: "1010", debit: "10", departmentCode: "FB" },
          { accountNumber: "4200", credit: "10", departmentCode: "FB" },
        ],
      }),
    ).resolves.toBeTruthy();

    // "COURSE" → "GROUNDS"
    await expect(
      createDraft(p, club.id, {
        entryDate: todayISO(), description: "alias COURSE",
        lines: [
          { accountNumber: "6010", debit: "20", departmentCode: "COURSE" },
          { accountNumber: "1010", credit: "20", departmentCode: "COURSE" },
        ],
      }),
    ).resolves.toBeTruthy();

    // "GOLF" → "PROSHOP"
    await expect(
      createDraft(p, club.id, {
        entryDate: todayISO(), description: "alias GOLF",
        lines: [
          { accountNumber: "1010", debit: "30", departmentCode: "GOLF" },
          { accountNumber: "4300", credit: "30", departmentCode: "GOLF" },
        ],
      }),
    ).resolves.toBeTruthy();
  });

  it("rejects a truly unknown department code (alias map does not swallow real errors)", async () => {
    // Guard: the alias fallback must return the original code when it
    // has no mapping, so genuinely-unknown codes still surface as
    // validation errors.
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");

    await expect(
      createDraft(p, club.id, {
        entryDate: todayISO(), description: "bogus dept",
        lines: [
          { accountNumber: "1010", debit: "10", departmentCode: "NOT_A_DEPT" },
          { accountNumber: "4200", credit: "10" },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("account activity drilldown computes running balance correctly", async () => {
    const club = await bootstrapAccountingClub();
    await makeUser({ email: "ctl@example.com", role: "CONTROLLER", clubId: club.id });
    const p = await principalFor("ctl@example.com");

    // Two postings to cash.
    for (const amt of ["100", "250"]) {
      const draft = await createDraft(p, club.id, {
        entryDate: todayISO(), description: "cash post",
        lines: [
          { accountNumber: "1010", debit: amt },
          { accountNumber: "4900", credit: amt },
        ],
      });
      await post(p, draft.id);
    }
    const cash = await db().account.findFirst({ where: { clubId: club.id, accountNumber: "1010" } });
    const r = await accountActivity(club.id, cash!.id, { from: new Date(new Date().getFullYear() - 1, 0, 1), to: new Date() });
    expect(r.activity.length).toBe(2);
    expect(r.activity[1].runningSigned.toString()).toBe("350");
    expect(r.closingSigned.toString()).toBe("350");
  });
});

describe("Accounting — tenant isolation", () => {
  beforeAll(async () => { await resetDb(); });
  beforeEach(async () => { await resetDb(); });

  it("a controller at club A cannot post a journal in club B", async () => {
    const clubA = await bootstrapAccountingClub("Iso A");
    const clubB = await bootstrapAccountingClub("Iso B");
    await makeUser({ email: "ctl-a@example.com", role: "CONTROLLER", clubId: clubA.id });
    const ctl = await principalFor("ctl-a@example.com");
    await expect(createDraft(ctl, clubB.id, {
      entryDate: todayISO(), description: "cross-tenant",
      lines: [
        { accountNumber: "1010", debit: "1" },
        { accountNumber: "4900", credit: "1" },
      ],
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Accounting — decimal helpers", () => {
  it("rejects NaN / Infinity at the boundary", () => {
    expect(() => toMoney(Number.NaN)).toThrow();
    expect(() => toMoney(Infinity)).toThrow();
  });
  it("preserves precision across multiple aggregations", () => {
    const a = toMoney("0.1").plus(toMoney("0.2"));
    expect(a.equals(new Prisma.Decimal("0.3"))).toBe(true);
  });
});
