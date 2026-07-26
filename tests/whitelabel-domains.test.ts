// White-label custom-domain tenant resolution tests.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, resetDb, principalFor, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  resolveClubByHost, normalizeHost, isPlatformHost, getRequestHost,
} from "@/lib/tenant-resolver";
import {
  addDomain, verifyDomain, activateDomain, deactivateDomain, listDomains,
  dnsInstructions,
} from "@/lib/club-domains";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { setRateLimiter, inMemoryRateLimit } from "@/lib/security/rate-limit";

async function adminPrincipal(clubId: string) {
  const email = `admin-${clubId}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function superPrincipal() {
  const email = `super-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@spectre.app`;
  await makeUser({ email, role: "SUPER_ADMIN", clubId: null });
  return principalFor(email);
}

async function withActiveDomain(clubId: string, hostname: string, kind: "PRIMARY" | "ADMIN" | "MEMBER" | "PROSHOP" | "APP" = "PRIMARY") {
  return db().clubDomain.create({
    data: {
      clubId, hostname: hostname.toLowerCase(),
      kind, status: "ACTIVE", verificationToken: "test", verifiedAt: new Date(), activatedAt: new Date(),
    },
  });
}

describe("normalizeHost / isPlatformHost", () => {
  it("normalizes hosts: lowercase, strip port + trailing dot", () => {
    expect(normalizeHost("Silver-Springs.LocalTest.me:3000")).toBe("silver-springs.localtest.me");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost(undefined)).toBe("");
  });

  it("local-dev hosts are platform by default", () => {
    expect(isPlatformHost("localhost")).toBe(true);
    expect(isPlatformHost("127.0.0.1")).toBe(true);
    expect(isPlatformHost("foo.localtest.me")).toBe(true);
    expect(isPlatformHost("example.com")).toBe(false);
  });

  it("getRequestHost prefers x-spectre-host over host", () => {
    const h = new Headers({ host: "example.com:3000", "x-spectre-host": "members.silver-springs.localtest.me" });
    expect(getRequestHost(h)).toBe("members.silver-springs.localtest.me");
  });
});

describe("resolveClubByHost — three outcomes", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("platform host resolves to mode='platform'", async () => {
    const r = await resolveClubByHost("localhost");
    expect(r.mode).toBe("platform");
  });

  it("unknown host resolves to mode='unknown'", async () => {
    const r = await resolveClubByHost("totally-fake-host-9999.example");
    expect(r.mode).toBe("unknown");
    if (r.mode === "unknown") expect(r.hostname).toBe("totally-fake-host-9999.example");
  });

  it("ACTIVE ClubDomain matches and returns clubId + kind", async () => {
    const club = await bootstrapAPClub("WL-1");
    await withActiveDomain(club.id, "www.silvers.example", "PRIMARY");
    const r = await resolveClubByHost("WWW.silvers.EXAMPLE:443");
    expect(r.mode).toBe("club");
    if (r.mode === "club") {
      expect(r.clubId).toBe(club.id);
      expect(r.clubSlug).toBe(club.slug);
      expect(r.domainKind).toBe("PRIMARY");
    }
  });

  it("non-ACTIVE ClubDomain (PENDING/VERIFIED/FAILED) is treated as unknown", async () => {
    const club = await bootstrapAPClub("WL-2");
    await db().clubDomain.create({
      data: { clubId: club.id, hostname: "pending.example", kind: "PRIMARY", status: "PENDING", verificationToken: "x" },
    });
    const r = await resolveClubByHost("pending.example");
    expect(r.mode).toBe("unknown");
  });
});

describe("ClubDomain admin service", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("addDomain → verify → activate → deactivate state machine", async () => {
    const club = await bootstrapAPClub("WL-3");
    const p = await adminPrincipal(club.id);
    const d1 = await addDomain(p, { clubId: club.id, hostname: "www.WL3.example" });
    expect(d1.status).toBe("PENDING");
    expect(d1.hostname).toBe("www.wl3.example"); // normalized
    expect(d1.verificationToken).toMatch(/^spectre-verify-/);
    const v = await verifyDomain(p, d1.id);
    expect(v.status).toBe("VERIFIED");
    const a = await activateDomain(p, d1.id);
    expect(a.status).toBe("ACTIVE");
    const d = await deactivateDomain(p, d1.id);
    expect(d.status).toBe("VERIFIED");
  });

  it("activate refuses unless VERIFIED first", async () => {
    const club = await bootstrapAPClub("WL-4");
    const p = await adminPrincipal(club.id);
    const d1 = await addDomain(p, { clubId: club.id, hostname: "skip.example" });
    await expect(activateDomain(p, d1.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects an already-registered hostname", async () => {
    const clubA = await bootstrapAPClub("WL-5A");
    const clubB = await bootstrapAPClub("WL-5B");
    const a = await adminPrincipal(clubA.id);
    const b = await adminPrincipal(clubB.id);
    await addDomain(a, { clubId: clubA.id, hostname: "dup.example" });
    await expect(addDomain(b, { clubId: clubB.id, hostname: "dup.example" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects invalid hostnames", async () => {
    const club = await bootstrapAPClub("WL-6");
    const p = await adminPrincipal(club.id);
    await expect(addDomain(p, { clubId: club.id, hostname: "not a host!" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("non-super-admin cannot manage another club's domains", async () => {
    const clubA = await bootstrapAPClub("WL-7A");
    const clubB = await bootstrapAPClub("WL-7B");
    const a = await adminPrincipal(clubA.id);
    await expect(addDomain(a, { clubId: clubB.id, hostname: "x.example" })).rejects.toThrow();
  });

  it("SUPER_ADMIN can manage any club's domains", async () => {
    const club = await bootstrapAPClub("WL-8");
    const sp = await superPrincipal();
    const d1 = await addDomain(sp, { clubId: club.id, hostname: "su.example" });
    expect(d1.clubId).toBe(club.id);
  });

  it("SUPER_ADMIN can list across clubs; CLUB_ADMIN cannot", async () => {
    const clubA = await bootstrapAPClub("WL-9A");
    const clubB = await bootstrapAPClub("WL-9B");
    const a = await adminPrincipal(clubA.id);
    const sp = await superPrincipal();
    await addDomain(a, { clubId: clubA.id, hostname: "a.example" });
    await addDomain(sp, { clubId: clubB.id, hostname: "b.example" });
    const all = await listDomains(sp, {});
    expect(all.length).toBeGreaterThanOrEqual(2);
    await expect(listDomains(a, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("removeDomain refuses while ACTIVE", async () => {
    const club = await bootstrapAPClub("WL-10");
    const p = await adminPrincipal(club.id);
    const d = await addDomain(p, { clubId: club.id, hostname: "active.example" });
    await verifyDomain(p, d.id);
    await activateDomain(p, d.id);
    const { removeDomain } = await import("@/lib/club-domains");
    await expect(removeDomain(p, d.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("dnsInstructions surfaces a TXT + CNAME pair", () => {
    const i = dnsInstructions({ hostname: "x.example", verificationToken: "tok" });
    expect(i.txtRecord.name).toBe("_spectre-verify.x.example");
    expect(i.txtRecord.value).toBe("tok");
    expect(i.cnameRecord.type).toBe("CNAME");
  });
});

describe("Branding cross-tenant isolation", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("two clubs with two distinct active domains resolve to distinct clubs", async () => {
    const clubA = await bootstrapAPClub("WL-ISO-A");
    const clubB = await bootstrapAPClub("WL-ISO-B");
    await withActiveDomain(clubA.id, "iso-a.example");
    await withActiveDomain(clubB.id, "iso-b.example");
    const a = await resolveClubByHost("iso-a.example");
    const b = await resolveClubByHost("iso-b.example");
    expect(a.mode).toBe("club");
    expect(b.mode).toBe("club");
    if (a.mode === "club" && b.mode === "club") {
      expect(a.clubId).toBe(clubA.id);
      expect(b.clubId).toBe(clubB.id);
      expect(a.clubId).not.toBe(b.clubId);
    }
  });

  it("a club's domain kind is reflected in the resolution", async () => {
    const club = await bootstrapAPClub("WL-K");
    await withActiveDomain(club.id, "members.k.example", "MEMBER");
    const r = await resolveClubByHost("members.k.example");
    if (r.mode !== "club") throw new Error("expected club mode");
    expect(r.domainKind).toBe("MEMBER");
  });

  it("ClubDomain hostname uniqueness is enforced at the DB level", async () => {
    const clubA = await bootstrapAPClub("WL-U-A");
    const clubB = await bootstrapAPClub("WL-U-B");
    await db().clubDomain.create({
      data: { clubId: clubA.id, hostname: "uniq.example", kind: "PRIMARY", status: "ACTIVE", verificationToken: "x", verifiedAt: new Date(), activatedAt: new Date() },
    });
    await expect(db().clubDomain.create({
      data: { clubId: clubB.id, hostname: "uniq.example", kind: "PRIMARY", status: "ACTIVE", verificationToken: "y", verifiedAt: new Date(), activatedAt: new Date() },
    })).rejects.toThrow();
  });
});
