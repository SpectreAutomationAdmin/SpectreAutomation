// Organizational Foundation (2026-09-13) — Coulee Ridge backfill.
// Self-contained — inlines starter catalogue so it runs directly on
// Fly SSH without needing the app's TS module resolution.

import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const COULEE = "cmrvdeny7000144372ktmmg9c";
const CHRIS_USER = "cmrvdenz700034437agp7gqs5";

const STARTER = [
  { code: "GENERAL_MANAGER",         name: "General Manager",                        deptCode: "ADMIN",    sortOrder: 10, parent: null },
  { code: "CONTROLLER",              name: "Controller / CFO",                       deptCode: "ADMIN",    sortOrder: 20, parent: "GENERAL_MANAGER" },
  { code: "ASSISTANT_CONTROLLER",    name: "Assistant Controller",                   deptCode: "ADMIN",    sortOrder: 30, parent: "CONTROLLER" },
  { code: "PAYROLL_ADMINISTRATOR",   name: "Payroll Administrator",                  deptCode: "ADMIN",    sortOrder: 40, parent: "CONTROLLER" },
  { code: "ADMIN_ASSISTANT",         name: "Administrative Assistant",               deptCode: "ADMIN",    sortOrder: 50, parent: "CONTROLLER" },
  { code: "CLUBHOUSE_MANAGER",       name: "Clubhouse Manager",                      deptCode: "ADMIN",    sortOrder: 60, parent: "GENERAL_MANAGER" },
  { code: "HEAD_GOLF_PROFESSIONAL",  name: "Head Golf Professional / Director of Golf", deptCode: "GOLF",  sortOrder: 10, parent: "GENERAL_MANAGER" },
  { code: "ASSOCIATE_GOLF_PRO",      name: "Associate Golf Professional",            deptCode: "GOLF",     sortOrder: 20, parent: "HEAD_GOLF_PROFESSIONAL" },
  { code: "ASSISTANT_GOLF_PRO",      name: "Assistant Golf Professional",            deptCode: "GOLF",     sortOrder: 30, parent: "HEAD_GOLF_PROFESSIONAL" },
  { code: "PRO_SHOP_STAFF",          name: "Pro Shop Staff",                         deptCode: "GOLF",     sortOrder: 40, parent: "HEAD_GOLF_PROFESSIONAL" },
  { code: "FAB_MANAGER",             name: "Food & Beverage Manager",                deptCode: "FAB",      sortOrder: 10, parent: "GENERAL_MANAGER" },
  { code: "EXECUTIVE_CHEF",          name: "Executive Chef / Head Chef",             deptCode: "CULINARY", sortOrder: 10, parent: "FAB_MANAGER" },
  { code: "SOUS_CHEF",               name: "Sous Chef",                              deptCode: "CULINARY", sortOrder: 20, parent: "EXECUTIVE_CHEF" },
  { code: "FOH_MANAGER",             name: "Front of House Manager",                 deptCode: "FAB",      sortOrder: 20, parent: "FAB_MANAGER" },
  { code: "BANQUETS_MANAGER",        name: "Banquets & Events Manager",              deptCode: "FAB",      sortOrder: 30, parent: "FAB_MANAGER" },
  { code: "BARTENDER",               name: "Bartender",                              deptCode: "FAB",      sortOrder: 40, parent: "FOH_MANAGER" },
  { code: "SERVER",                  name: "Server",                                 deptCode: "FAB",      sortOrder: 50, parent: "FOH_MANAGER" },
  { code: "CULINARY_STAFF",          name: "Culinary Staff",                         deptCode: "CULINARY", sortOrder: 30, parent: "EXECUTIVE_CHEF" },
  { code: "SERVICE_STAFF",           name: "Service Staff",                          deptCode: "FAB",      sortOrder: 60, parent: "FOH_MANAGER" },
  { code: "SUPERINTENDENT",          name: "Golf Course Superintendent",             deptCode: "GROUNDS",  sortOrder: 10, parent: "GENERAL_MANAGER" },
  { code: "ASSISTANT_SUPERINTENDENT", name: "Assistant Superintendent",              deptCode: "GROUNDS",  sortOrder: 20, parent: "SUPERINTENDENT" },
  { code: "GREENSKEEPER",            name: "Greenskeeper",                           deptCode: "GROUNDS",  sortOrder: 30, parent: "SUPERINTENDENT" },
  { code: "GROUNDS_STAFF",           name: "Grounds Staff",                          deptCode: "GROUNDS",  sortOrder: 40, parent: "SUPERINTENDENT" },
  { code: "MEMBERSHIP_MANAGER",      name: "Membership Manager",                     deptCode: "MEMBER",   sortOrder: 10, parent: "GENERAL_MANAGER" },
  { code: "COMMS_MANAGER",           name: "Communications / Marketing Manager",     deptCode: "MEMBER",   sortOrder: 20, parent: "GENERAL_MANAGER" },
  { code: "FACILITIES_MANAGER",      name: "Facilities / Maintenance Manager",       deptCode: "FACILITY", sortOrder: 10, parent: "GENERAL_MANAGER" },
  { code: "FACILITIES_STAFF",        name: "Facilities Staff",                       deptCode: "FACILITY", sortOrder: 20, parent: "FACILITIES_MANAGER" },
];

const DEPT_NAME_HINTS = {
  ADMIN: ["administration"],
  GOLF: ["golf operations", "golf ops", "golf"],
  FAB: ["food & beverage", "food and beverage", "f&b"],
  CULINARY: ["culinary"],
  GROUNDS: ["grounds"],
  MEMBER: ["membership"],
  FACILITY: ["facilities", "maintenance"],
};

const ALIASES = {
  "head chef": "EXECUTIVE_CHEF",
  "director of golf": "HEAD_GOLF_PROFESSIONAL",
  "cfo": "CONTROLLER",
  "f&b manager": "FAB_MANAGER",
  "assistant golf pro": "ASSISTANT_GOLF_PRO",
};

async function main() {
  console.log("== Coulee org foundation backfill ==");

  const depts = await p.department.findMany({
    where: { clubId: COULEE },
    select: { id: true, code: true, name: true },
  });
  const deptByCode = new Map(depts.map((d) => [d.code.toUpperCase(), d]));
  const deptByNameLower = new Map(depts.map((d) => [d.name.toLowerCase(), d]));
  const resolveDept = (starterCode) => {
    if (!starterCode) return null;
    const direct = deptByCode.get(starterCode);
    if (direct) return direct.id;
    for (const hint of DEPT_NAME_HINTS[starterCode] ?? []) {
      const byName = deptByNameLower.get(hint);
      if (byName) return byName.id;
    }
    return null;
  };

  const existing = await p.organizationalPosition.findMany({
    where: { clubId: COULEE },
    select: { id: true, name: true, code: true },
  });
  const byCode = new Map(existing.filter((r) => r.code).map((r) => [r.code, r.id]));
  const byName = new Map(existing.map((r) => [r.name.toLowerCase(), r.id]));

  const codeToId = new Map();
  let created = 0, updated = 0, skipped = 0;
  for (const spec of STARTER) {
    let posId = byCode.get(spec.code) ?? byName.get(spec.name.toLowerCase()) ?? null;
    if (!posId) {
      for (const [alias, canon] of Object.entries(ALIASES)) {
        if (canon !== spec.code) continue;
        const hit = byName.get(alias);
        if (hit) { posId = hit; break; }
      }
    }
    if (posId) {
      const before = existing.find((r) => r.id === posId);
      if (before && !before.code) {
        await p.organizationalPosition.update({ where: { id: posId }, data: { code: spec.code } });
        updated++;
      } else {
        skipped++;
      }
      codeToId.set(spec.code, posId);
      continue;
    }
    const row = await p.organizationalPosition.create({
      data: {
        clubId: COULEE, name: spec.name, code: spec.code,
        departmentId: resolveDept(spec.deptCode),
        sortOrder: spec.sortOrder, isActive: true,
      },
      select: { id: true },
    });
    codeToId.set(spec.code, row.id);
    created++;
  }
  console.log(`positions: created=${created} updated=${updated} skipped=${skipped}`);

  let hierarchySet = 0;
  for (const spec of STARTER) {
    if (!spec.parent) continue;
    const childId = codeToId.get(spec.code);
    const parentId = codeToId.get(spec.parent);
    if (!childId || !parentId || childId === parentId) continue;
    const child = await p.organizationalPosition.findUnique({
      where: { id: childId },
      select: { reportsToPositionId: true },
    });
    if (child?.reportsToPositionId) continue;
    await p.organizationalPosition.update({
      where: { id: childId },
      data: { reportsToPositionId: parentId },
    });
    hierarchySet++;
  }
  console.log(`hierarchy links set: ${hierarchySet}`);

  // Coulee-specific: Clubhouse Manager → Controller.
  const controller = await p.organizationalPosition.findFirstOrThrow({
    where: { clubId: COULEE, code: "CONTROLLER" }, select: { id: true },
  });
  const clubhouseMgr = await p.organizationalPosition.findFirstOrThrow({
    where: { clubId: COULEE, code: "CLUBHOUSE_MANAGER" },
    select: { id: true, reportsToPositionId: true },
  });
  if (clubhouseMgr.reportsToPositionId !== controller.id) {
    await p.organizationalPosition.update({
      where: { id: clubhouseMgr.id },
      data: { reportsToPositionId: controller.id },
    });
    console.log("Clubhouse Manager → Controller (Coulee override applied).");
  } else {
    console.log("Clubhouse Manager already reports to Controller.");
  }

  // Assign Chris → Controller.
  const chrisProfile = await p.userClubProfile.findFirstOrThrow({
    where: { clubId: COULEE, userId: CHRIS_USER },
    select: { id: true, positionId: true, displayTitle: true },
  });
  if (chrisProfile.positionId === controller.id) {
    console.log("Chris already occupies Controller.");
  } else {
    await p.userClubProfile.update({
      where: { id: chrisProfile.id },
      data: {
        positionId: controller.id,
        displayTitle: chrisProfile.displayTitle ?? "Controller",
      },
    });
    console.log("Chris now occupies Controller.");
  }

  const empCount = await p.employee.count({ where: { clubId: COULEE } });
  console.log(`Coulee employees after backfill: ${empCount}`);
  if (empCount !== 0) throw new Error("SAFETY: employee count is not 0.");

  console.log("== backfill complete ==");
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); }).finally(() => p.$disconnect());
