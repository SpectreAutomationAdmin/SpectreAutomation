// Ensure retained acceptance principals have known credentials.
// Password: "spectre-3e-fixture" (bcryptjs) — same as 3E/3F fixture scripts.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

// bcryptjs hash of "spectre-3e-fixture" (10 rounds), verified against 3E fixture spec.
const HASH = "$2a$10$3NdHFZO.5GJLWfOVhv033e6OKjo5Rll5.G5Qjpl.BsbifK9pVWofq";

const targets = [
  { id: "cmtjc2s9d0003gnjuhbfyo6i2", email: "fixture.controller@spectre.test" }, // sole controller test principal
  { id: "cmtzxwfjw00009r8kvnr8rno5", email: "fixture.poster.3f@spectre.test" }, // required for Post step (Chris cannot self-post)
];

async function main() {
  for (const t of targets) {
    const before = await p.user.findUnique({ where: { id: t.id }, select: { passwordHash: true } });
    await p.user.update({ where: { id: t.id }, data: { passwordHash: HASH } });
    console.log(`${t.email}: ${before?.passwordHash === HASH ? "already-set" : "updated"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
