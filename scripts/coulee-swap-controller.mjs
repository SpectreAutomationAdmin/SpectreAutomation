// Swap PayrollClubConfig.controllerUserId to Chris + delete fixture.controller.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const COULEE = "cmrvdeny7000144372ktmmg9c";
const CHRIS_USER = "cmrvdenz700034437agp7gqs5";
const FIXTURE_CONTROLLER = "cmtjc2s9d0003gnjuhbfyo6i2";

async function main() {
  const chris = await p.user.findUnique({
    where: { id: CHRIS_USER },
    select: { id: true, email: true, clubRoles: { where: { clubId: COULEE }, select: { roleKey: true } } },
  });
  if (!chris || chris.email !== "cturcato@spectreautomation.com") {
    throw new Error("SAFETY: Chris User not found or email mismatch");
  }
  const roleKeys = chris.clubRoles.map((r) => r.roleKey);
  console.log("Chris roles on Coulee:", roleKeys);
  if (!roleKeys.includes("CONTROLLER")) {
    throw new Error(`SAFETY: Chris User does not hold CONTROLLER UserClubRole for Coulee. Has: ${roleKeys.join(",")}`);
  }

  // Belt-and-braces: no batches, no audits, no other refs
  const submits = await p.payrollBatch.count({ where: { submittedByUserId: FIXTURE_CONTROLLER } });
  const approves = await p.payrollBatch.count({ where: { approvedByUserId: FIXTURE_CONTROLLER } });
  const posts = await p.payrollBatch.count({ where: { postedByUserId: FIXTURE_CONTROLLER } });
  const audits = await p.auditLog.count({ where: { userId: FIXTURE_CONTROLLER } });
  if (submits + approves + posts + audits > 0) {
    throw new Error(`SAFETY: fixture.controller has residual FKs (batches=${submits + approves + posts}, audits=${audits}). Refusing to delete.`);
  }
  console.log("fixture.controller has 0 batch and 0 audit refs — safe to delete.");

  // Step 1: point PayrollClubConfig.controllerUserId at Chris
  const cfg = await p.payrollClubConfig.update({
    where: { clubId: COULEE },
    data: { controllerUserId: CHRIS_USER },
    select: { controllerUserId: true, payrollAdminUserId: true, enabled: true },
  });
  console.log("PayrollClubConfig updated:", JSON.stringify(cfg));

  // Step 2: delete fixture.controller UserClubRole for Coulee
  const rolesDeleted = await p.userClubRole.deleteMany({
    where: { userId: FIXTURE_CONTROLLER },
  });
  console.log("UserClubRole deleted:", rolesDeleted.count);

  // Step 3: delete the User row itself
  const usersDeleted = await p.user.deleteMany({ where: { id: FIXTURE_CONTROLLER } });
  console.log("User deleted:", usersDeleted.count);

  const finalCfg = await p.payrollClubConfig.findUnique({
    where: { clubId: COULEE },
    select: { enabled: true, payrollAdminUserId: true, controllerUserId: true, glAccountingProfileId: true },
  });
  console.log("Final PayrollClubConfig:", JSON.stringify(finalCfg, null, 2));
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); }).finally(() => p.$disconnect());
