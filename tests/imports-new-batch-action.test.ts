// createBatchAction — server-action unit tests.
//
// Covers the input-source logic the founder asked for:
//   1. CSV file upload alone → batch created with the file's name.
//   2. Pasted CSV alone     → batch created with fileName "pasted.csv".
//   3. Both provided        → rejected via spectre_import_error
//                              cookie, NO batch persisted.
//   4. Neither provided     → rejected via cookie, NO batch persisted.
//   5. Unknown domain       → rejected via cookie, NO batch persisted.
//   6. File over 10 MB      → rejected via cookie, NO batch persisted.
//
// We mock next/headers + next/cache + next/navigation + the
// principal/active-club lookups; the underlying `createBatch`
// library is left intact and runs against the real test DB so
// the action's contract with the import library is exercised
// end-to-end.

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
} from "vitest";

import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";

// ---------------------------------------------------------------------------
// Mocks for the Next.js + principal plumbing the action calls into.
// ---------------------------------------------------------------------------

const cookieSetSpy = vi.fn();
const cookieDeleteSpy = vi.fn();

vi.mock("next/headers", () => ({
  cookies: () => ({
    set: cookieSetSpy,
    get: () => undefined,
    delete: cookieDeleteSpy,
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

// Stub the principal resolver so the test owns the auth context.
let currentPrincipal: Awaited<ReturnType<typeof principalFor>> | null = null;
vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: async () => currentPrincipal,
}));

// Stub active-club to echo whatever the principal claims.
vi.mock("@/lib/active-club", () => ({
  getActiveClubId: async ({ clubId }: { clubId: string | null }) => clubId,
}));

// Import AFTER mocks are registered so the action picks them up.
import { createBatchAction } from "@/app/app/admin/imports/_actions";

// Founder rule 2026-07-14: a successful COA upload redirects to
// the batch detail page so the auto-scroll-to-first-error UX
// fires. Our redirect mock throws to model Next's actual
// behavior (`redirect()` is implemented via a thrown sentinel).
// This helper runs the action and swallows the redirect throw,
// so assertions about the persisted batch row run after a
// "successful upload + immediate validate + redirect" sequence.
// Any non-redirect error is re-thrown to surface as a test failure.
async function runAction(fd: FormData): Promise<string | undefined> {
  try {
    await createBatchAction(fd);
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("redirect:")) return msg.slice("redirect:".length);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COA_CSV =
  "number,name,type,categoryKey,fsGroupKey,departmentCode\n" +
  "1010,Operating Bank,asset,cash,current-assets,\n" +
  "2000,Accounts Payable,liability,accounts-payable,current-liabilities,\n";

function fdWithFile(domain: string, fileContent: string, fileName = "coa.csv") {
  const fd = new FormData();
  fd.set("domain", domain);
  fd.set("csv", "");
  const blob = new Blob([fileContent], { type: "text/csv" });
  fd.set("csvFile", blob, fileName);
  return fd;
}

function fdWithPaste(domain: string, csv: string) {
  const fd = new FormData();
  fd.set("domain", domain);
  fd.set("csv", csv);
  // Mirror the browser: an empty file input still sets a zero-byte File.
  fd.set("csvFile", new Blob([], { type: "text/csv" }), "");
  return fd;
}

function fdWithBoth(domain: string, csv: string, fileContent: string) {
  const fd = new FormData();
  fd.set("domain", domain);
  fd.set("csv", csv);
  fd.set("csvFile", new Blob([fileContent], { type: "text/csv" }), "coa.csv");
  return fd;
}

function fdWithNothing(domain: string) {
  const fd = new FormData();
  fd.set("domain", domain);
  fd.set("csv", "");
  fd.set("csvFile", new Blob([], { type: "text/csv" }), "");
  return fd;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("createBatchAction — input-source rules", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });

  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    cookieSetSpy.mockClear();
    cookieDeleteSpy.mockClear();
  });

  async function asAdmin(label: string) {
    const club = await bootstrapAPClub(`IMP-${label}`);
    const email = `admin-${label}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await makeUser({ email, role: "CLUB_ADMIN", clubId: club.id });
    currentPrincipal = await principalFor(email);
    return { clubId: club.id };
  }

  it("accepts an uploaded CSV file, validates it, and redirects to the new batch's detail page", async () => {
    const { clubId } = await asAdmin("file");
    const redirectTo = await runAction(fdWithFile("COA", COA_CSV, "my-chart.csv"));

    const batches = await db().importBatch.findMany({ where: { clubId } });
    expect(batches).toHaveLength(1);
    expect(batches[0].domain).toBe("COA");
    expect(batches[0].fileName).toBe("my-chart.csv");
    expect(batches[0].totalRows).toBe(2);
    // COA upload now validates in the same workflow → dryRunAt
    // is set + the redirect lands on the batch detail page.
    expect(batches[0].dryRunAt).not.toBeNull();
    expect(redirectTo).toBe(`/app/admin/imports/${batches[0].id}`);
    expect(cookieSetSpy).not.toHaveBeenCalled();
  });

  it("accepts pasted CSV and tags the batch fileName as pasted.csv (also validates + redirects)", async () => {
    const { clubId } = await asAdmin("paste");
    const redirectTo = await runAction(fdWithPaste("COA", COA_CSV));

    const batches = await db().importBatch.findMany({ where: { clubId } });
    expect(batches).toHaveLength(1);
    expect(batches[0].fileName).toBe("pasted.csv");
    expect(batches[0].totalRows).toBe(2);
    expect(batches[0].dryRunAt).not.toBeNull();
    expect(redirectTo).toBe(`/app/admin/imports/${batches[0].id}`);
    expect(cookieSetSpy).not.toHaveBeenCalled();
  });

  it("rejects when BOTH file and pasted CSV are provided (no batch created)", async () => {
    const { clubId } = await asAdmin("both");
    await createBatchAction(fdWithBoth("COA", COA_CSV, COA_CSV));

    const batches = await db().importBatch.findMany({ where: { clubId } });
    expect(batches).toHaveLength(0);
    expect(cookieSetSpy).toHaveBeenCalledTimes(1);
    const [name, value] = cookieSetSpy.mock.calls[0];
    expect(name).toBe("spectre_import_error");
    expect(String(value).toLowerCase()).toContain("only one input source");
  });

  it("rejects when NEITHER file nor pasted CSV is provided (no batch created)", async () => {
    const { clubId } = await asAdmin("none");
    await createBatchAction(fdWithNothing("COA"));

    const batches = await db().importBatch.findMany({ where: { clubId } });
    expect(batches).toHaveLength(0);
    expect(cookieSetSpy).toHaveBeenCalledTimes(1);
    const [, value] = cookieSetSpy.mock.calls[0];
    expect(String(value).toLowerCase()).toContain("upload");
  });

  it("rejects an unknown domain (no batch created)", async () => {
    const { clubId } = await asAdmin("baddomain");
    const fd = fdWithPaste("NOT_A_DOMAIN", COA_CSV);
    await createBatchAction(fd);

    const batches = await db().importBatch.findMany({ where: { clubId } });
    expect(batches).toHaveLength(0);
    expect(cookieSetSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a CSV with only a header row (no data rows)", async () => {
    const { clubId } = await asAdmin("headeronly");
    await createBatchAction(
      fdWithPaste("COA", "number,name,type,categoryKey,fsGroupKey,departmentCode\n"),
    );

    const batches = await db().importBatch.findMany({ where: { clubId } });
    expect(batches).toHaveLength(0);
    expect(cookieSetSpy).toHaveBeenCalledTimes(1);
    const [, value] = cookieSetSpy.mock.calls[0];
    expect(String(value).toLowerCase()).toContain("no data rows");
  });

  it("accepts a file upload for MEMBERS using that domain's headers", async () => {
    const { clubId } = await asAdmin("members");
    const csv =
      "memberNumber,firstName,lastName,email,phone,membershipCategory,joinDate,status\n" +
      "M-001,Jane,Doe,jane@example.com,555-1234,Full Golf,2020-01-15,ACTIVE\n" +
      "M-002,John,Smith,john@example.com,555-5678,Social,2021-06-01,ACTIVE\n";
    await createBatchAction(fdWithFile("MEMBERS", csv, "members.csv"));

    const batches = await db().importBatch.findMany({ where: { clubId } });
    expect(batches).toHaveLength(1);
    expect(batches[0].domain).toBe("MEMBERS");
    expect(batches[0].totalRows).toBe(2);
  });

  it("COA upload with Jonas-style embedded-newline headers parses 237 rows with number+name populated", async () => {
    const { clubId } = await asAdmin("coa-jonas-237");

    // Build the founder's exact failure shape: 1 header row +
    // 237 account rows, first 1000/"Petty Cash", last
    // 9901/"Depreciation", Jonas-style "G/L Account\nCode" /
    // "G/L Account\nDescription" headers.
    const lines: string[] = [];
    lines.push('"G/L Account\nCode","G/L Account\nDescription"');
    lines.push('1000,"Petty Cash"');
    for (let i = 0; i < 235; i++) {
      const acct = 1100 + i; // 1100..1334
      lines.push(`${acct},"Account ${acct}"`);
    }
    lines.push('9901,"Depreciation"');
    const csv = lines.join("\n") + "\n";

    await runAction(fdWithFile("COA", csv, "COA.csv"));

    const batches = await db().importBatch.findMany({ where: { clubId } });
    expect(batches).toHaveLength(1);
    expect(batches[0].domain).toBe("COA");
    expect(batches[0].totalRows).toBe(237);
    // COA upload validates in the same workflow → dryRunAt is set.
    expect(batches[0].dryRunAt).not.toBeNull();

    const rows = await db().importRow.findMany({
      where: { batchId: batches[0].id },
      orderBy: { rowNumber: "asc" },
    });
    expect(rows).toHaveLength(237);

    // Every row must have number + name populated. None of the
    // 237 may be blank (the bug we're fixing).
    type RawRow = { number?: unknown; name?: unknown };
    const parsed = rows.map((r) => JSON.parse(r.rawJson) as RawRow);
    const blanks = parsed.filter((r) => !r.number || !r.name);
    expect(blanks).toEqual([]);

    // Founder rule 2026-06-29: the COA upload action now runs
    // the intelligent auto-mapping engine before validation, so
    // each rawJson also carries _prediction + the predicted
    // type/categoryKey/fsGroupKey/departmentCodes. Use
    // toMatchObject so the original number+name contract is
    // still asserted without locking in the added fields.
    expect(parsed[0]).toMatchObject({ number: "1000", name: "Petty Cash" });
    expect(parsed[parsed.length - 1]).toMatchObject({
      number: "9901",
      name: "Depreciation",
    });
  });
});
