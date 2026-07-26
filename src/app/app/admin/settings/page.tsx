import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { ClubProfileForm, type SaveResult } from "./settings-client";
import { IconArrowRight } from "@/components/spectre/icons";

// -----------------------------------------------------------------------------
// Phase 2 — /app/admin/settings on the Spectre Design Language + Product
// Language.
//
// This route was migrated to Spectre chrome per the Phase 2 brief. The
// Product Language configuration-page grammar (§3.C) determines the
// section order:
//
//   1. Purpose             — one sentence stating what this page controls
//   2. Current configuration — the applied values, near the controls
//   3. Editable controls   — inputs, aligned to the Design Language
//   4. Impact / consequences — inline consequence text where non-obvious
//   5. Save state          — chip + primary action beneath the form
//   6. Change history      — omitted; no existing audit stream on this route
//
// Every previously-persisted field is preserved by name + default
// value. The server action `updateClubAction` retains identical
// business logic (same nine fields, same `revalidatePath`). No new
// settings were added; no defaults were changed; no fields were
// renamed. The permission model is unchanged (no gate at this route
// today — the sidebar hides the entry for users without
// `settings:read`).
//
// Sub-routes (`/app/admin/settings/domains`,
// `/app/admin/settings/pos-printers`) are OUT OF SCOPE for Phase 2 and
// render through the legacy chrome. AdminShell's SPECTRE_MODE_EXACT_URLS
// list enforces this — see `src/components/admin/AdminShell.tsx`.
// -----------------------------------------------------------------------------

async function updateClubAction(_prevState: SaveResult, formData: FormData): Promise<SaveResult> {
  "use server";
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Session expired. Sign in again." };
  const clubId = await getActiveClubId(user);
  try {
    await prisma.club.update({
      where: { id: clubId },
      data: {
        name: String(formData.get("name") ?? "").trim(),
        wordmark: String(formData.get("wordmark") ?? "").trim() || null,
        address: String(formData.get("address") ?? "").trim() || null,
        region: String(formData.get("region") ?? "").trim() || null,
        salesTaxRegion: String(formData.get("salesTaxRegion") ?? "").trim() || null,
        foundedYear: parseInt(String(formData.get("foundedYear") ?? "0"), 10) || null,
        primaryColor: String(formData.get("primaryColor") ?? "#2f5832"),
        logoUrl: String(formData.get("logoUrl") ?? "").trim() || null,
        whitelabelEnabled: formData.get("whitelabelEnabled") === "on",
      },
    });
    revalidatePath("/app/admin/settings");
    const savedAt = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return { ok: true, savedAt };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: msg };
  }
}

// -----------------------------------------------------------------------------

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) redirect("/app/admin");

  return (
    <div className="max-w-[880px]">
      {/* --- Page context (Zone 2 · Product Language §7) --- */}
      <header className="mb-spectre-8">
        <h1 className="text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Settings
        </h1>
        <p className="mt-2 text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          Club identity, branding, and platform tunables. Changes take effect immediately after saving.
        </p>
      </header>

      {/* =========================================================
          Section 1 — Club profile
          Configuration-page grammar applied in-section:
            • Purpose — the section subtitle
            • Current configuration — inputs are pre-filled with the persisted value
            • Editable controls — grouped by concern (identity, address, brand)
            • Impact — consequence text beside the fields whose effect is not obvious
            • Save state — chip + primary action at the bottom of the form
         ========================================================= */}
      <SectionHeader
        eyebrow="Section 1"
        title="Club profile"
        subtitle="Identity and branding used everywhere the club appears — sidebar, page titles, application forms, invoices, and the public application page."
      />
      <section
        className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      >
        <ClubProfileForm action={updateClubAction}>
          {/* Identity subgroup */}
          <FieldGrid columns={2}>
            <TextField
              name="name"
              label="Club name"
              defaultValue={club.name}
              help="Legal name of the club. Appears on invoices and legal documents."
              required
            />
            <TextField
              name="wordmark"
              label="Wordmark (display name)"
              defaultValue={club.wordmark ?? ""}
              placeholder="Defaults to the club name"
              help="Shorter form shown in the sidebar and browser tab."
            />
          </FieldGrid>

          <FieldGrid columns={2}>
            <TextField
              name="region"
              label="Region"
              defaultValue={club.region ?? ""}
              help="Province or state used on statements and reports."
            />
            <TextField
              name="salesTaxRegion"
              label="Sales tax region"
              defaultValue={club.salesTaxRegion ?? ""}
              help="Tax jurisdiction code used by POS and receipts."
            />
          </FieldGrid>

          <TextField
            name="address"
            label="Address"
            defaultValue={club.address ?? ""}
            help="One line, as printed on statements."
          />

          <FieldGrid columns={3}>
            <TextField
              name="foundedYear"
              type="number"
              label="Founded year"
              defaultValue={club.foundedYear?.toString() ?? ""}
              help="Four-digit year."
            />
            <ColorField
              name="primaryColor"
              label="Primary colour"
              defaultValue={club.primaryColor ?? "#2f5832"}
              help="Used on active navigation, focus rings, and primary buttons."
            />
            <TextField
              name="logoUrl"
              label="Logo URL"
              defaultValue={club.logoUrl ?? ""}
              placeholder="https://…"
              help="Publicly-reachable URL. Appears in the sidebar identity block."
            />
          </FieldGrid>

          {/* Impact / consequence explicit for the whitelabel toggle. */}
          <CheckboxField
            name="whitelabelEnabled"
            defaultChecked={club.whitelabelEnabled}
            label="White-label on club domains"
            help="When enabled, the Spectre wordmark is hidden on this club's custom hostnames. Administrators still see it on the platform domain."
          />
        </ClubProfileForm>
      </section>

      {/* =========================================================
          Section 2 — Custom domains (link out to the sub-route)
         ========================================================= */}
      <SectionHeader
        eyebrow="Section 2"
        title="Custom domains"
        subtitle="Map external hostnames to this club. PENDING → VERIFIED → ACTIVE."
      />
      <section
        className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      >
        <div className="flex items-center justify-between gap-spectre-4">
          <div className="min-w-0">
            <p className="text-spectre-body" style={{ color: "var(--spectre-text-primary)" }}>
              Manage custom hostnames, DNS records, and activation status on a dedicated page.
            </p>
            <p className="mt-1 text-spectre-body-sm" style={{ color: "var(--spectre-text-muted)" }}>
              Only ACTIVE domains route traffic. PENDING and VERIFIED domains are reserved but invisible to visitors.
            </p>
          </div>
          <Link
            href="/app/admin/settings/domains"
            className="spectre-btn spectre-btn--secondary"
            data-testid="settings-open-domains-link"
          >
            Open custom domains
            <IconArrowRight size={14} />
          </Link>
        </div>
      </section>

      {/* =========================================================
          Section 3 — Operational settings (read-only display)
         ========================================================= */}
      <ClubSettingsSection clubId={clubId} />

      {/* Footer — public application page */}
      <footer className="mt-spectre-8 pt-spectre-4 border-t" style={{ borderColor: "var(--spectre-border-hairline)" }}>
        <div className="text-spectre-body-sm" style={{ color: "var(--spectre-text-muted)" }}>
          Public application page:{" "}
          <Link
            href={`/clubs/${club.slug}/apply`}
            className="underline"
            style={{ color: "var(--spectre-accent)" }}
          >
            /clubs/{club.slug}/apply
          </Link>
        </div>
      </footer>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Section-level primitives — inlined here because Phase 2 is scoped to
// this one route. Extraction into a general library is a Phase-3
// decision once a second surface adopts the same pattern.
// -----------------------------------------------------------------------------

function SectionHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return (
    <div className="mb-spectre-3">
      <div
        className="text-[11px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: "var(--spectre-text-muted)" }}
      >
        {eyebrow}
      </div>
      <h2
        className="mt-1 text-spectre-h2 font-semibold"
        style={{ color: "var(--spectre-text-primary)" }}
      >
        {title}
      </h2>
      <p className="mt-1 text-spectre-body-sm" style={{ color: "var(--spectre-text-secondary)" }}>
        {subtitle}
      </p>
    </div>
  );
}

function FieldGrid({ columns, children }: { columns: 1 | 2 | 3; children: React.ReactNode }) {
  const cls = columns === 3
    ? "grid grid-cols-1 md:grid-cols-3 gap-spectre-4"
    : columns === 2
      ? "grid grid-cols-1 md:grid-cols-2 gap-spectre-4"
      : "grid grid-cols-1 gap-spectre-4";
  return <div className={cls}>{children}</div>;
}

function TextField({
  name,
  label,
  defaultValue,
  placeholder,
  help,
  required,
  type = "text",
}: {
  name: string;
  label: string;
  defaultValue: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  type?: "text" | "number";
}) {
  const id = `settings-field-${name}`;
  return (
    <div>
      <label htmlFor={id} className="spectre-label">{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        className="spectre-input"
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        aria-describedby={help ? `${id}-help` : undefined}
      />
      {help && (
        <p id={`${id}-help`} className="spectre-help">{help}</p>
      )}
    </div>
  );
}

function ColorField({
  name,
  label,
  defaultValue,
  help,
}: {
  name: string;
  label: string;
  defaultValue: string;
  help?: string;
}) {
  const id = `settings-field-${name}`;
  return (
    <div>
      <label htmlFor={id} className="spectre-label">{label}</label>
      <div className="flex items-center gap-spectre-2">
        <input
          id={id}
          name={name}
          type="color"
          defaultValue={defaultValue}
          aria-describedby={help ? `${id}-help` : undefined}
          className="h-9 w-14 rounded-spectre-input border cursor-pointer"
          style={{ borderColor: "var(--spectre-border-default)", background: "var(--spectre-surface)" }}
        />
        <span
          className="text-spectre-body-sm font-mono"
          style={{ color: "var(--spectre-text-secondary)" }}
        >
          {defaultValue}
        </span>
      </div>
      {help && (
        <p id={`${id}-help`} className="spectre-help">{help}</p>
      )}
    </div>
  );
}

function CheckboxField({
  name,
  label,
  defaultChecked,
  help,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
  help?: string;
}) {
  const id = `settings-field-${name}`;
  return (
    <div className="pt-spectre-2">
      <label htmlFor={id} className="flex items-start gap-spectre-3 cursor-pointer">
        <input
          id={id}
          name={name}
          type="checkbox"
          className="spectre-check mt-0.5"
          defaultChecked={defaultChecked}
          aria-describedby={help ? `${id}-help` : undefined}
        />
        <span className="min-w-0">
          <span
            className="block text-spectre-body font-medium"
            style={{ color: "var(--spectre-text-primary)" }}
          >
            {label}
          </span>
          {help && (
            <span
              id={`${id}-help`}
              className="mt-0.5 block text-spectre-body-sm"
              style={{ color: "var(--spectre-text-muted)" }}
            >
              {help}
            </span>
          )}
        </span>
      </label>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Operational settings — read-only display of `ClubSetting` rows,
// grouped by scope. This mirrors the pre-migration behaviour verbatim
// (raw `valueJson` strings, one entry per key) and only changes the
// visual treatment to the design language.
// -----------------------------------------------------------------------------

async function ClubSettingsSection({ clubId }: { clubId: string }) {
  const settings = await prisma.clubSetting.findMany({
    where: { clubId },
    orderBy: [{ scope: "asc" }, { key: "asc" }],
  });
  if (settings.length === 0) return null;

  const byScope = new Map<string, typeof settings>();
  for (const s of settings) {
    const arr = byScope.get(s.scope) ?? [];
    arr.push(s);
    byScope.set(s.scope, arr);
  }

  return (
    <>
      <SectionHeader
        eyebrow="Section 3"
        title="Operational settings"
        subtitle="Tunable platform behaviour — approval thresholds, retention windows, notification defaults. Read-only on this page; each scope has its own management surface."
      />
      <section
        className="rounded-spectre-panel border overflow-hidden mb-spectre-8"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      >
        {Array.from(byScope.entries()).map(([scope, rows], i, all) => (
          <div key={scope} className={i < all.length - 1 ? "border-b" : ""} style={{ borderColor: "var(--spectre-border-hairline)" }}>
            <div
              className="px-spectre-6 py-spectre-3 text-[11px] font-semibold uppercase tracking-[0.06em]"
              style={{
                color: "var(--spectre-text-muted)",
                background: "var(--spectre-canvas-sunken)",
              }}
            >
              {scope}
            </div>
            <ul>
              {rows.map((r, ri) => (
                <li
                  key={r.id}
                  className="px-spectre-6 py-spectre-3 text-spectre-body-sm flex items-baseline justify-between gap-spectre-4"
                  style={{
                    borderTop: ri === 0 ? "none" : "1px solid var(--spectre-border-hairline)",
                  }}
                >
                  <span
                    className="font-mono text-spectre-caption min-w-0 truncate"
                    style={{ color: "var(--spectre-text-muted)" }}
                    title={r.key}
                  >
                    {r.key}
                  </span>
                  <span
                    className="font-mono text-spectre-body-sm"
                    style={{ color: "var(--spectre-text-primary)" }}
                  >
                    {r.valueJson}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}
