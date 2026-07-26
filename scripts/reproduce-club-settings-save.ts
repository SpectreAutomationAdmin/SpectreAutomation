// Reproduction script — does saveClubProfileAction actually persist
// fiscalYearEndMonth + fiscalYearEndDay?
//
// Builds a FormData payload identical to what the rendered form
// submits, calls the server action via the SAME entry point the form
// uses (via the underlying upsertClubProfile service to avoid the
// `"use server"` boundary), and immediately reads back from Prisma
// to confirm persistence.

import { prisma } from "../src/lib/prisma";
import { upsertClubProfile } from "../src/lib/clubs/profile";
import { clubProfileInputSchema } from "../src/lib/clubs/profile-validation";

async function main() {
  const club = await prisma.club.findFirst({
    where: { slug: "silver-springs" },
    select: { id: true, name: true },
  });
  if (!club) {
    console.error("Silver Springs not seeded");
    process.exit(1);
  }

  // -------------------------------------------------------------
  // BEFORE
  // -------------------------------------------------------------
  const before = await prisma.clubProfile.findUnique({
    where: { clubId: club.id },
    select: { fiscalYearEndMonth: true, fiscalYearEndDay: true, legalName: true, operatingName: true },
  });
  console.log("BEFORE:", JSON.stringify(before, null, 2));

  // -------------------------------------------------------------
  // Build the FormData payload the form would submit. The form
  // sends EVERY field — string fields blank, the numeric fields
  // populated. To mimic that, we send "12" / "31" for fiscalYearEnd
  // PLUS every other field as the current value or "".
  // -------------------------------------------------------------
  const fd = new FormData();
  fd.set("fiscalYearEndMonth", "12");
  fd.set("fiscalYearEndDay", "31");
  // Send the other persisted fields unchanged so we don't blank
  // them out. (The form sends defaults via defaultValue.)
  if (before?.legalName) fd.set("legalName", before.legalName);
  if (before?.operatingName) fd.set("operatingName", before.operatingName);

  // Simulate the _actions.ts conversion step.
  const stringFields = [
    "legalName", "operatingName", "businessNumber", "gstNumber",
    "mailingAddress", "physicalAddress", "city", "provinceState",
    "mainPhone", "generalEmail",
    "websiteUrl", "primaryContactName", "primaryContactTitle",
    "primaryContactEmail", "primaryContactPhone",
    "gstStatus", "gstFilingFrequency", "defaultGstRatePct",
    "defaultCurrency",
    "defaultArAccountId", "defaultApAccountId",
    "defaultRetainedEarningsAccountId", "defaultCurrentYearEarningsAccountId",
    "defaultOperatingBankAccountId", "defaultReserveBankAccountId",
    "defaultMemberReceivablesAccountId", "defaultSalesTaxPayableAccountId",
  ] as const;
  const numericFields = ["yearFounded", "fiscalYearEndMonth", "fiscalYearEndDay"] as const;

  const out: Record<string, unknown> = {};
  for (const k of stringFields) {
    const v = fd.get(k);
    if (typeof v === "string") out[k] = v;
  }
  for (const k of numericFields) {
    const v = fd.get(k);
    if (typeof v === "string") out[k] = v;
  }

  console.log("\nINPUT to upsertClubProfile (after formDataToInput):");
  console.log(JSON.stringify(out, null, 2));

  // -------------------------------------------------------------
  // First: try the schema in isolation to see what it produces.
  // -------------------------------------------------------------
  const parsed = clubProfileInputSchema.safeParse(out);
  console.log("\nZod parse success:", parsed.success);
  if (!parsed.success) {
    console.log("Zod issues:");
    for (const issue of parsed.error.issues) {
      console.log(`  [${issue.path.join(".")}] ${issue.message}`);
    }
    process.exit(1);
  }
  console.log("Parsed output keys:", Object.keys(parsed.data));
  console.log("Parsed fiscalYearEndMonth:", parsed.data.fiscalYearEndMonth, typeof parsed.data.fiscalYearEndMonth);
  console.log("Parsed fiscalYearEndDay:", parsed.data.fiscalYearEndDay, typeof parsed.data.fiscalYearEndDay);

  // -------------------------------------------------------------
  // Now invoke the service. Mock principal with required fields.
  // -------------------------------------------------------------
  // Find an admin user for the club so requirePermission passes.
  const user = await prisma.user.findFirst({
    where: { clubId: club.id, role: "CLUB_ADMIN" },
    select: { id: true, email: true, role: true, clubId: true },
  });
  if (!user) {
    console.error("No CLUB_ADMIN user for Silver Springs");
    process.exit(1);
  }
  console.log("\nActing as user:", user.email);

  try {
    const saved = await upsertClubProfile(
      {
        id: user.id,
        email: user.email,
        memberships: [{ clubId: user.clubId, roleKey: user.role }],
        activeClubId: user.clubId,
        memberId: null,
      } as never,
      club.id,
      out,
    );
    console.log("\nupsertClubProfile returned. fiscalYearEnd on row:");
    console.log("  fiscalYearEndMonth =", saved.fiscalYearEndMonth);
    console.log("  fiscalYearEndDay   =", saved.fiscalYearEndDay);
  } catch (err) {
    console.error("\nupsertClubProfile THREW:", err);
    process.exit(1);
  }

  // -------------------------------------------------------------
  // Read back fresh from DB to confirm persistence.
  // -------------------------------------------------------------
  const after = await prisma.clubProfile.findUnique({
    where: { clubId: club.id },
    select: { fiscalYearEndMonth: true, fiscalYearEndDay: true },
  });
  console.log("\nAFTER (read back from DB):");
  console.log("  fiscalYearEndMonth =", after?.fiscalYearEndMonth);
  console.log("  fiscalYearEndDay   =", after?.fiscalYearEndDay);

  const match = after?.fiscalYearEndMonth === 12 && after?.fiscalYearEndDay === 31;
  console.log("\nPERSISTED CORRECTLY:", match ? "✓ YES" : "✗ NO");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
