import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function run() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE column_name = 'syntheticTestOnly'
         AND table_name IN ('SignupRegistration','SubscriptionAuthorisationAttestation','SubscriptionPaymentMandate','OperatorVerificationRecord','BillingCycle')
       ORDER BY table_name`
  );
  console.log(JSON.stringify({ columns: rows }));
}
run().catch(e => { console.error(e.message); process.exit(1); }).finally(() => prisma.$disconnect());
