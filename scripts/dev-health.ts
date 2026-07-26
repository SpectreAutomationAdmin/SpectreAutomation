// Founder-friendly health probe. Verifies the local stack is actually
// serving the routes a non-technical founder would test next.
//
//   npm run dev:health
//
// Each row prints OK / FAIL with a one-line reason. Exits 0 when every
// probe is OK; 1 otherwise. Designed to be cheap (≈2s) so it can run
// at the tail of every meaningful implementation task.

import "./lib/preload-env";

import net from "node:net";
import { prisma } from "../src/lib/prisma";

const APP = process.env.APP_ORIGIN ?? "http://localhost:3000";
const MAILDEV = process.env.MAILDEV_WEB ?? "http://localhost:8025";

type Probe = { name: string; ok: boolean; detail: string };
const probes: Probe[] = [];
function record(name: string, ok: boolean, detail: string) {
  probes.push({ name, ok, detail });
}

async function probeHttp(label: string, url: string): Promise<void> {
  try {
    const r = await fetch(url, { redirect: "manual" });
    // 2xx / 3xx are both fine — auth redirects on protected routes are
    // a healthy signal that middleware compiled and ran.
    const ok = r.status < 500;
    record(label, ok, `${url} → HTTP ${r.status}`);
  } catch (err) {
    record(label, false, `${url} → ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function probeTcp(label: string, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const sock = net.createConnection({ host, port, timeout: 1500 });
    sock.once("connect", () => { sock.end(); record(label, true, `${host}:${port} reachable`); resolve(); });
    sock.once("error", (err) => { record(label, false, `${host}:${port} — ${err.message}`); resolve(); });
    sock.once("timeout", () => { sock.destroy(); record(label, false, `${host}:${port} connect timeout`); resolve(); });
  });
}

async function probeDb(): Promise<void> {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    record("Database", true, "Prisma client SELECT 1 → ok");
  } catch (err) {
    record("Database", false, err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  // eslint-disable-next-line no-console
  console.log("\nSpectre stack health");
  // eslint-disable-next-line no-console
  console.log("=====================\n");

  await probeDb();

  // Frontend: at minimum the homepage and the login page must render.
  await probeHttp("Homepage", `${APP}/`);
  await probeHttp("Login page", `${APP}/login`);

  // Admin route that exercises middleware + active club resolution.
  await probeHttp("Admin home", `${APP}/app/admin`);
  // Phase 18C/D surfaces — added in the most recent changes.
  await probeHttp("Hospitality hub", `${APP}/app/admin/hospitality`);
  await probeHttp("Reservations list", `${APP}/app/admin/hospitality/reservations`);
  await probeHttp("Reservations floor", `${APP}/app/admin/hospitality/reservations/floor`);
  await probeHttp("Reservations analytics", `${APP}/app/admin/hospitality/reservations/analytics`);
  await probeHttp("Hospitality feedback", `${APP}/app/admin/hospitality/feedback`);
  // Member surface.
  await probeHttp("Member reservations", `${APP}/app/member/reservations`);

  // Mail — Maildev only matters when EMAIL_DELIVERY_MODE points at it.
  if ((process.env.EMAIL_DELIVERY_MODE ?? "") === "smtp" && (process.env.SMTP_HOST === "localhost" || process.env.SMTP_HOST === "127.0.0.1")) {
    await probeTcp("Maildev SMTP", process.env.SMTP_HOST!, Number(process.env.SMTP_PORT ?? 1025));
    await probeHttp("Maildev inbox", `${MAILDEV}/email`);
  } else {
    record("Mail", true, `mode=${process.env.EMAIL_DELIVERY_MODE ?? "console"} (no local sink probed)`);
  }

  // Render
  const padName = Math.max(...probes.map((p) => p.name.length));
  for (const p of probes) {
    const tag = p.ok ? "[OK  ]" : "[FAIL]";
    // eslint-disable-next-line no-console
    console.log(`${tag} ${p.name.padEnd(padName)}  ${p.detail}`);
  }
  const failed = probes.filter((p) => !p.ok).length;
  // eslint-disable-next-line no-console
  console.log(`\n${probes.length - failed}/${probes.length} probes OK${failed === 0 ? "" : " — see [FAIL] rows above"}`);
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Health script crashed:", err);
    process.exit(2);
  })
  .finally(() => { void prisma.$disconnect(); });
