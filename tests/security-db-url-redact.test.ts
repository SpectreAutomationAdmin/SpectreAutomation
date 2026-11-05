// EP-TRAIN-6D-4G (2026-11-04) — regression tests for the shared
// database-URL redactor at `src/lib/security/db-url-redact.ts`.
//
// Purpose
// -------
// Lock in the invariant that no part of a password, username,
// query-string value, or URL fragment survives redaction. The
// bug these tests anchor was a hand-rolled regex
//   `/\/([^?]+)(\?|$)/`
// that greedy-matched `/user:pass@host:port/db` instead of the
// path-only portion, leaking the password into terminal
// scrollback whenever a preflight ran.
//
// All credentials in this file are SYNTHETIC — the strings
// `sekret-synthetic-*` and `admin-synthetic-*` are never used
// anywhere else in Spectre. Grepping the repo for them should
// yield only this file.

import { describe, it, expect } from "vitest";
import {
  redactDbUrl,
  redactUrlsInText,
} from "../src/lib/security/db-url-redact";

const SYNTHETIC_PASSWORDS = [
  "sekret-synthetic-alpha",
  "sekret-synthetic-beta-123",
  "sekret-synthetic-with-special-%40$chars",
  "npg_SyntheticFakePasswordXYZ",
  // Real password shape (Neon's `npg_` + 14 chars) using only
  // synthetic entropy. Still must not leak.
  "npg_AbCdEfGh123XyZ",
];

const SYNTHETIC_USERNAMES = [
  "admin-synthetic-user",
  "neondb_owner_synthetic",
  "root-synthetic",
];

const SYNTHETIC_QUERY_SECRETS = [
  "sslpassword=sekret-synthetic-query",
  "password=sekret-synthetic-query",
  "options=project%3Dsekret-synthetic-proj",
];

describe("redactDbUrl — password redaction (regression anchor)", () => {
  it.each(SYNTHETIC_PASSWORDS)(
    "never emits the synthetic password '%s' anywhere in the result",
    (password) => {
      const url = `postgresql://admin-synthetic-user:${password}@ep-fake-xyz.c-3.us-east-2.aws.neon.tech:5432/spectre?sslmode=require`;
      const fp = redactDbUrl(url);
      expect(fp.compact).not.toContain(password);
      expect(fp.protocol).not.toContain(password);
      expect(fp.host).not.toContain(password);
      expect(fp.database).not.toContain(password);
    },
  );

  it.each(SYNTHETIC_USERNAMES)(
    "never emits the synthetic username '%s' anywhere in the result",
    (username) => {
      const url = `postgresql://${username}:sekret-synthetic-pw@ep-fake-xyz.c-3.us-east-2.aws.neon.tech:5432/spectre?sslmode=require`;
      const fp = redactDbUrl(url);
      expect(fp.compact).not.toContain(username);
      expect(fp.protocol).not.toContain(username);
      expect(fp.host).not.toContain(username);
      expect(fp.database).not.toContain(username);
    },
  );

  it.each(SYNTHETIC_QUERY_SECRETS)(
    "never emits a secret-shaped query parameter '%s' anywhere in the result",
    (querySecret) => {
      const url = `postgresql://admin-synthetic-user:sekret-synthetic-pw@ep-fake-xyz.c-3.us-east-2.aws.neon.tech:5432/spectre?${querySecret}&sslmode=require`;
      const fp = redactDbUrl(url);
      // The shared redactor drops the entire query string; that's
      // the contract. Verify the secret value is not in any field.
      const secretValue = querySecret.split("=").slice(1).join("=");
      expect(fp.compact).not.toContain(secretValue);
      expect(fp.host).not.toContain(secretValue);
      expect(fp.database).not.toContain(secretValue);
    },
  );

  it("drops the URL fragment (the hash cannot carry secrets back into the compact fingerprint)", () => {
    const url =
      "postgresql://admin-synthetic-user:sekret-synthetic-pw@ep-fake-xyz.c-3.us-east-2.aws.neon.tech:5432/spectre?sslmode=require#sekret-synthetic-fragment";
    const fp = redactDbUrl(url);
    expect(fp.compact).not.toContain("sekret-synthetic-fragment");
  });

  it("emits the expected safe shape for a standard Neon-style URL", () => {
    const url =
      "postgresql://admin-synthetic-user:sekret-synthetic-pw@ep-fake-xyz.c-3.us-east-2.aws.neon.tech:5432/spectre?sslmode=require";
    const fp = redactDbUrl(url);
    expect(fp.protocol).toBe("postgresql:");
    expect(fp.host).toBe("ep-fake-xyz.c-3.us-east-2.aws.neon.tech:5432");
    expect(fp.database).toBe("spectre");
    expect(fp.compact).toBe(
      "postgresql://<user>:<hidden>@ep-fake-xyz.c-3.us-east-2.aws.neon.tech:5432/spectre?<params>",
    );
  });

  it("handles a pooled Neon endpoint (-pooler) the same way", () => {
    const url =
      "postgresql://admin-synthetic-user:sekret-synthetic-pw@ep-fake-xyz-pooler.c-3.us-east-2.aws.neon.tech/spectre?sslmode=require&channel_binding=require";
    const fp = redactDbUrl(url);
    expect(fp.host).toBe("ep-fake-xyz-pooler.c-3.us-east-2.aws.neon.tech");
    expect(fp.database).toBe("spectre");
    expect(fp.compact).not.toContain("sekret-synthetic-pw");
    expect(fp.compact).not.toContain("admin-synthetic-user");
  });

  it("emits a stable <invalid-url> marker for every non-string input", () => {
    const bads: unknown[] = [null, undefined, 0, false, {}, [], Symbol("x")];
    for (const bad of bads) {
      const fp = redactDbUrl(bad);
      expect(fp.compact).toBe("<invalid-url>");
      expect(fp.protocol).toBe("<invalid-url>");
      expect(fp.host).toBe("<invalid-url>");
      expect(fp.database).toBe("<invalid-url>");
    }
  });

  it("emits a stable <invalid-url> marker for malformed strings", () => {
    for (const bad of ["", "not-a-url", "postgres-no-slashes", "://no-scheme"]) {
      const fp = redactDbUrl(bad);
      expect(fp.compact).toBe("<invalid-url>");
    }
  });

  it("never throws for any input", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      "",
      "garbage",
      0,
      NaN,
      {},
      [],
      Symbol("x"),
      "postgresql://good:pw@host/db",
    ];
    for (const input of inputs) {
      expect(() => redactDbUrl(input)).not.toThrow();
    }
  });
});

describe("redactUrlsInText — error-message / log-line scrubbing", () => {
  it("redacts a URL embedded inside a larger error message", () => {
    const text =
      "Connection failed: tried postgresql://admin-synthetic-user:sekret-synthetic-pw@ep-fake-xyz.c-3.us-east-2.aws.neon.tech/spectre?sslmode=require with timeout=5s";
    const scrubbed = redactUrlsInText(text);
    expect(scrubbed).not.toContain("sekret-synthetic-pw");
    expect(scrubbed).not.toContain("admin-synthetic-user");
    expect(scrubbed).toContain("<hidden>");
    expect(scrubbed).toContain("ep-fake-xyz.c-3.us-east-2.aws.neon.tech");
  });

  it("redacts multiple URLs on the same line", () => {
    const text =
      "Pool=postgresql://u1:sekret-synthetic-a@h1/db1 Direct=postgresql://u2:sekret-synthetic-b@h2/db2";
    const scrubbed = redactUrlsInText(text);
    expect(scrubbed).not.toContain("sekret-synthetic-a");
    expect(scrubbed).not.toContain("sekret-synthetic-b");
    expect(scrubbed).not.toContain("u1");
    expect(scrubbed).not.toContain("u2");
  });

  it("passes through text that contains no URL", () => {
    const text = "Everything is fine, nothing to see here.";
    expect(redactUrlsInText(text)).toBe(text);
  });

  it("returns empty / non-string inputs unchanged", () => {
    expect(redactUrlsInText("")).toBe("");
    // @ts-expect-error — intentionally exercising wide inputs
    expect(redactUrlsInText(null)).toBe(null);
    // @ts-expect-error — intentionally exercising wide inputs
    expect(redactUrlsInText(undefined)).toBe(undefined);
  });
});
