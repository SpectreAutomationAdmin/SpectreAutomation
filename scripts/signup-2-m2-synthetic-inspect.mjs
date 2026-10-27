// SIGNUP-2 M2-SyntheticSandbox (2026-10-27) -- Read-only DB inspector.
// Reports the current state of a synthetic registration + its chain.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const regId = process.argv[2];
  if (!regId) {
    console.error("Usage: node signup-2-m2-synthetic-inspect.mjs <registrationId>");
    process.exit(2);
  }
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: regId },
    select: {
      id: true,
      legalName: true,
      status: true,
      verificationVerdict: true,
      signingAuthoritySignal: true,
      syntheticTestOnly: true,
    },
  });
  const attestation = await prisma.subscriptionAuthorisationAttestation.findUnique({
    where: { signupRegistrationId: regId },
    select: { id: true, acceptedAt: true, syntheticTestOnly: true },
  });
  const release = await prisma.operatorVerificationRecord.findFirst({
    where: { signupRegistrationId: regId, concept: "RELEASE" },
    select: { id: true, verifiedAt: true, syntheticTestOnly: true },
  });
  const mandate = await prisma.subscriptionPaymentMandate.findFirst({
    where: { signupRegistrationId: regId },
    select: { id: true, stripeMandateId: true, stripePaymentMethodId: true, acceptedAt: true, syntheticTestOnly: true },
  });
  const cycles = await prisma.billingCycle.findMany({
    where: { clubId: regId },
    select: { id: true, subscriptionStatus: true, stripePaymentIntentId: true, syntheticTestOnly: true },
  });
  const provJob = await prisma.tenantProvisioningJob.findFirst({
    where: { signupRegistrationId: regId },
    select: { id: true, state: true },
  });
  console.log(JSON.stringify({
    registration: reg,
    attestation,
    releaseRecord: release,
    mandate,
    billingCycles: cycles,
    tenantProvisioningJob: provJob,
    nonceState: reg?.signingAuthoritySignal?.startsWith("signup-2m2-syn-nonce:")
      ? (reg.signingAuthoritySignal.includes("CONSUMED") ? "CONSUMED" : "ISSUED-NOT-CONSUMED")
      : "NO-NONCE",
  }, null, 2));
}

main()
  .catch((err) => { console.error(err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
