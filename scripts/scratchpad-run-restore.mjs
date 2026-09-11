// Restore Taylor's shift to ASSIGNED after cross-employee pickup test.
// Uses flyctl ssh to run raw SQL against staging. Only touches
// synthetic Coulee Ridge fixtures.

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const FLYCTL = process.env.FLYCTL ?? "flyctl";
const APP = "spectre-staging";
const COULEE_ID = "cmrvdeny7000144372ktmmg9c";
const TAYLOR_EMAIL = "taylor.hourly@fixture.spectre.test";
const TAYLOR_ASN_ID = "cmtjc2zxc002vgnjuj8oywd1p"; // Taylor's PRIMARY EVENTS/Server assignment (known-safe from diagnostic)

const restoreScript = `
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const COULEE_ID = "${COULEE_ID}";
const TAYLOR_EMAIL = "${TAYLOR_EMAIL}";

async function main() {
  const taylor = await prisma.employee.findFirst({
    where: { personalEmail: TAYLOR_EMAIL, clubId: COULEE_ID },
    select: { id: true },
  });
  if (!taylor) throw new Error("no Taylor at Coulee");

  // Find the most recent CLAIMED opportunity for Coulee where Taylor
  // was the offering employee.
  const claimed = await prisma.shiftOpportunity.findFirst({
    where: { clubId: COULEE_ID, offeredByEmployeeId: taylor.id, state: "CLAIMED" },
    orderBy: { claimedAt: "desc" },
    select: {
      id: true, shiftId: true, claimedByEmployeeId: true,
      claimedByAssignmentId: true, offeredByAssignmentId: true,
    },
  });
  if (!claimed) {
    console.log("no CLAIMED opportunity from Taylor to restore — nothing to do");
    console.log("RESTORE OK (nothing to restore)");
    return;
  }
  console.log("found CLAIMED", JSON.stringify(claimed, null, 2));

  await prisma.$transaction(async (tx) => {
    // 1) Delete claimant's new ASSIGNED assignment.
    if (claimed.claimedByAssignmentId) {
      await tx.shiftAssignment.delete({ where: { id: claimed.claimedByAssignmentId } });
      console.log("deleted claimant's assignment", claimed.claimedByAssignmentId);
    }
    // 2) Revert original assignment back to ASSIGNED and clear replacedBy.
    if (claimed.offeredByAssignmentId) {
      const updated = await tx.shiftAssignment.updateMany({
        where: { id: claimed.offeredByAssignmentId, state: "REPLACED" },
        data: { state: "ASSIGNED", replacedByAssignmentId: null },
      });
      console.log("reverted original assignment count=" + updated.count);
    }
    // 3) Mark opportunity as WITHDRAWN (terminal history).
    await tx.shiftOpportunity.update({
      where: { id: claimed.id },
      data: { state: "WITHDRAWN", withdrawnAt: new Date() },
    });
    console.log("marked opportunity WITHDRAWN", claimed.id);
  });

  // 4) Re-open a fresh OPEN opportunity so Devon's post-restore FORE!
  //    check has something to render.
  const asn = await prisma.shiftAssignment.findUnique({
    where: { id: claimed.offeredByAssignmentId },
    select: { shiftId: true, clubId: true },
  });
  await prisma.shiftOpportunity.create({
    data: {
      clubId: COULEE_ID,
      shiftId: asn.shiftId,
      offeredByEmployeeId: taylor.id,
      offeredByAssignmentId: claimed.offeredByAssignmentId,
      state: "OPEN",
      reason: "STAGING_RESTORE",
      note: "Re-offered after acceptance test.",
      offeredAt: new Date(),
    },
  });
  console.log("created fresh OPEN opportunity");

  console.log("RESTORE OK");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
`;

// Write to a temp file, upload, run.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "restore-"));
const localPath = path.join(tmpDir, "opp-restore.js");
writeFileSync(localPath, restoreScript);

// SFTP requires CWD-relative upload (Windows-native flyctl + MSYS gotcha).
const cwd = tmpDir;
const rm = spawnSync(FLYCTL, ["ssh", "console", "--app", APP, "--command", "sh -c 'rm -f /app/opp-restore.js'"], { encoding: "utf8" });
console.log(rm.stdout, rm.stderr);
const put = spawnSync(FLYCTL, ["ssh", "sftp", "put", "--app", APP, "opp-restore.js"], { cwd, encoding: "utf8" });
console.log(put.stdout, put.stderr);
if (put.status !== 0) { console.error("upload failed"); process.exit(1); }
const run = spawnSync(FLYCTL, ["ssh", "console", "--app", APP, "--command", "sh -c 'cd /app && node opp-restore.js'"], { encoding: "utf8" });
console.log(run.stdout);
console.error(run.stderr);
// The trailing 'Error: The handle is invalid' is a benign flyctl-Windows
// SSH close artifact; success is proven by the RESTORE OK line.
const cleaned = spawnSync(FLYCTL, ["ssh", "console", "--app", APP, "--command", "sh -c 'rm -f /app/opp-restore.js'"], { encoding: "utf8" });
console.log(cleaned.stdout, cleaned.stderr);
try { unlinkSync(localPath); } catch {}
if (!run.stdout.includes("RESTORE OK")) process.exit(1);
process.exit(0);
