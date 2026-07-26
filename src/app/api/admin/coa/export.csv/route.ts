// Sprint 1 acceptance repair (2026-07-19).
//
// CSV export of the Chart of Accounts as it appears in the
// Data Workspace. This is the concrete endpoint the "Export"
// toolbar action links to. The founder rejected a decorative
// button that did nothing — this route implements the real
// download.
//
// Columns follow the founder's list, in order:
//   Account number
//   Name
//   Type
//   Category
//   FS group
//   Department
//   Fund applicability
//   Active status
//   Control status
//   Balance
//
// The balance column comes from the `accountBalances` service and
// preserves the raw accounting sign (positive = normal side;
// negative = contra / opposite side). Reporting downstream can
// re-sign as needed; the export does NOT invert.
//
// Query parameters are honoured so the export matches the current
// filter state of the workspace:
//   ?fund=OPERATING|CAPITAL|BOTH|NONE
//   ?showInactive=1
//
// Access is gated on `coa:read`.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { accountBalances } from "@/lib/accounting/balance";

export async function GET(req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "coa:read")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const showInactive = url.searchParams.get("showInactive") === "1";
  const fund = (url.searchParams.get("fund") ?? "").trim().toUpperCase();
  const fundFilter =
    fund === "OPERATING" || fund === "CAPITAL" || fund === "BOTH" || fund === "NONE"
      ? fund
      : null;

  const [accounts, balances] = await Promise.all([
    prisma.account.findMany({
      where: { clubId, ...(showInactive ? {} : { isActive: true }) },
      orderBy: [{ accountNumber: "asc" }],
      select: {
        id: true,
        accountNumber: true,
        name: true,
        type: true,
        isActive: true,
        isControlAccount: true,
        fundApplicability: true,
        category: { select: { name: true } },
        fsGroup: { select: { key: true, name: true } },
        defaultDepartment: { select: { code: true, name: true } },
        departments: {
          select: { department: { select: { code: true, name: true } } },
        },
      },
    }),
    accountBalances(clubId, { asOf: new Date() }),
  ]);

  const balanceById = new Map(balances.map((b) => [b.accountId, b.naturalBalance]));

  const rows = accounts
    .filter((a) => {
      if (!fundFilter) return true;
      const raw = (a.fundApplicability ?? "").toUpperCase();
      const set = new Set(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      if (fundFilter === "OPERATING") return set.has("OPERATING") && !set.has("CAPITAL");
      if (fundFilter === "CAPITAL") return set.has("CAPITAL") && !set.has("OPERATING");
      if (fundFilter === "BOTH") return set.has("OPERATING") && set.has("CAPITAL");
      // NONE — P&L account with no assignment; only meaningful for
      // REVENUE / EXPENSE rows.
      const isPl = a.type === "REVENUE" || a.type === "EXPENSE";
      return isPl && set.size === 0;
    })
    .map((a) => {
      const deptCodes = a.departments
        .map((ad) => ad.department?.code)
        .filter((v): v is string => !!v)
        .sort();
      const departmentLabel =
        deptCodes.length > 0
          ? deptCodes.join("|")
          : a.defaultDepartment?.code ?? "";
      const balance = balanceById.get(a.id) ?? 0;
      return {
        accountNumber: a.accountNumber,
        name: a.name,
        type: a.type,
        category: a.category?.name ?? "",
        fsGroup: a.fsGroup ? `${a.fsGroup.key} — ${a.fsGroup.name}` : "",
        department: departmentLabel,
        fundApplicability: a.fundApplicability ?? "",
        active: a.isActive ? "Active" : "Inactive",
        control: a.isControlAccount ? "Control" : "",
        balance: balance.toFixed(2),
      };
    });

  const header = [
    "Account number",
    "Name",
    "Type",
    "Category",
    "FS group",
    "Department",
    "Fund applicability",
    "Active status",
    "Control status",
    "Balance",
  ];

  const csv = [
    header.join(","),
    ...rows.map((r) =>
      [
        r.accountNumber,
        r.name,
        r.type,
        r.category,
        r.fsGroup,
        r.department,
        r.fundApplicability,
        r.active,
        r.control,
        r.balance,
      ]
        .map(escapeCsv)
        .join(","),
    ),
  ].join("\n");

  const iso = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="chart-of-accounts-${iso}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

// Standard CSV escape: wrap in quotes if the value contains a comma,
// double quote, or newline; double-up any internal quotes.
function escapeCsv(v: string): string {
  const needs = /[",\n\r]/.test(v);
  const doubled = v.replace(/"/g, '""');
  return needs ? `"${doubled}"` : doubled;
}
