// Audit the current FS Group + Department + Account taxonomy in the
// dev DB. Used to verify the founder's COA mapping cleanup.

import { PrismaClient } from "@prisma/client";

const DEPT_LABELS = new Set([
  "Food & Beverage",
  "Pro Shop",
  "Clubhouse",
  "Golf Operations",
  "Course & Grounds",
  "Administration",
]);

async function main() {
  const prisma = new PrismaClient();
  const club = await prisma.club.findFirst({ orderBy: { createdAt: "asc" } });
  if (!club) { console.log("No club."); await prisma.$disconnect(); return; }
  console.log(`Club: ${club.name} (${club.id})\n`);

  const fsGroups = await prisma.financialStatementGroup.findMany({
    where: { clubId: club.id },
    orderBy: [{ statement: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: { key: true, name: true, statement: true, parentGroupId: true },
  });
  console.log(`FS Groups (${fsGroups.length}):`);
  const leaks: string[] = [];
  for (const g of fsGroups) {
    const flag = DEPT_LABELS.has(g.name) ? "  ⚠ DEPARTMENT LEAK" : "";
    console.log(`  ${g.statement.padEnd(18)} ${g.key.padEnd(32)} ${g.name}${flag}`);
    if (DEPT_LABELS.has(g.name)) leaks.push(`${g.key} (${g.name})`);
  }
  if (leaks.length > 0) {
    console.log(`\n${leaks.length} FS Group(s) currently shadow a department label:`);
    for (const l of leaks) console.log(`  - ${l}`);
  } else {
    console.log("\nNo department-named FS groups present.");
  }

  const departments = await prisma.department.findMany({
    where: { clubId: club.id, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { code: true, name: true },
  });
  console.log(`\nDepartments (${departments.length}):`);
  for (const d of departments) console.log(`  ${d.code.padEnd(10)} ${d.name}`);

  // How many accounts are currently mapped to each FS group? Used
  // to gauge migration impact.
  const accountCount = await prisma.account.groupBy({
    by: ["fsGroupId"],
    where: { clubId: club.id },
    _count: { _all: true },
  });
  const groupById = new Map(fsGroups.map((g) => [g.key, g.name] as const));
  void groupById;
  const fsById = await prisma.financialStatementGroup.findMany({
    where: { clubId: club.id },
    select: { id: true, key: true, name: true },
  });
  const byId = new Map(fsById.map((g) => [g.id, g] as const));
  console.log(`\nAccount → FS Group counts:`);
  for (const a of accountCount) {
    const g = a.fsGroupId ? byId.get(a.fsGroupId) : null;
    console.log(
      `  ${(g?.key ?? "(none)").padEnd(32)} ${(g?.name ?? "—").padEnd(38)} ${a._count._all} accounts`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
