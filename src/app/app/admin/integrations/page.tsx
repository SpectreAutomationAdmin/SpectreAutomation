import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { integrationStatusSummary, listIntegrations, recordIntegrationCheck, upsertIntegration } from "@/lib/integrations/config";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";
import { getEmailDeliveryDescriptor } from "@/lib/integrations/email";

async function upsertIntegrationAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    const scope = String(formData.get("scope") ?? "") as "EMAIL" | "SMS" | "STORAGE" | "LLM" | "POS" | "EXPORT";
    const provider = String(formData.get("provider") ?? "");
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(String(formData.get("configJson") ?? "{}")); } catch { /* leave empty */ }
    let secrets: Record<string, unknown> | null = null;
    const secretsRaw = String(formData.get("secretsJson") ?? "").trim();
    if (secretsRaw) {
      try { secrets = JSON.parse(secretsRaw); } catch { /* invalid JSON ignored */ }
    }
    await upsertIntegration(p, clubId, { scope, provider, isActive: true, config, secrets });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/integrations?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/integrations");
}

// Sends a real diagnostic email to an operator-supplied recipient
// through whatever email adapter is currently active. Used to confirm
// "yes, this club's configured SMTP/SES setup actually delivers" from
// the admin UI — separate from testConnectionAction below which only
// verifies the adapter responds (the noop@spectre.invalid recipient
// for the SES/SMTP cases simply checks credentials).
async function sendDiagnosticEmailAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:write")) redirect("/app/admin");
  const recipient = String(formData.get("recipient") ?? "").trim();
  if (!recipient || !recipient.includes("@")) {
    redirect(`/app/admin/integrations?error=${encodeURIComponent("Enter a valid recipient email address")}`);
  }
  const { selectEmailAdapter, getEmailDeliveryDescriptor: getDescriptor } = await import("@/lib/integrations/email");
  const descriptor = await getDescriptor(clubId);
  const adapter = await selectEmailAdapter(clubId);
  const targetLabel = descriptor.smtpTarget === "local"
    ? "LOCAL Maildev/Mailhog inbox (NOT real external delivery)"
    : descriptor.mode === "smtp"
      ? `EXTERNAL SMTP relay (${descriptor.smtpHost ?? "?"}:${descriptor.smtpPort ?? "?"})`
      : descriptor.mode === "microsoft365"
        ? `Microsoft 365 — from ${descriptor.microsoftFromMailbox ?? "?"}`
        : descriptor.mode.toUpperCase();
  const result = await adapter.send({
    clubId,
    channel: "EMAIL",
    to: { email: recipient, userId: p.id },
    subject: `Spectre diagnostic email (${new Date().toISOString().slice(0, 16)})`,
    body: [
      `Hi,`,
      ``,
      `This is a diagnostic email sent from the Spectre admin Integrations page.`,
      ``,
      `Delivery target: ${targetLabel}`,
      `Triggered by:    ${p.email}`,
      `At:              ${new Date().toISOString()}`,
      ``,
      `If you received this in your real inbox, your email pipeline is wired up correctly.`,
      `If it landed in a local Maildev inbox, real recipients did NOT receive it — switch to a real SMTP relay (see docs/email-testing.md).`,
    ].join("\n"),
  });
  const params = new URLSearchParams();
  if (result.status === "SENT") {
    params.set("emailTest", "ok");
    params.set("emailRecipient", recipient);
    params.set("emailTarget", descriptor.smtpTarget ?? descriptor.mode);
  } else {
    params.set("error", `Email send failed: ${result.failureReason ?? "unknown"}`);
  }
  redirect(`/app/admin/integrations?${params.toString()}`);
}

async function testConnectionAction(scope: "EMAIL" | "SMS" | "STORAGE" | "LLM", settingId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  const started = Date.now();
  let status: "OK" | "FAIL" = "OK";
  let message: string | undefined;
  try {
    if (scope === "EMAIL") {
      const { selectEmailAdapter } = await import("@/lib/integrations/email");
      const adapter = await selectEmailAdapter(clubId);
      const result = await adapter.send({ clubId, channel: "EMAIL", to: { email: "noop@spectre.invalid" }, subject: "Test", body: "Spectre integration test." });
      if (result.status === "FAILED") { status = "FAIL"; message = result.failureReason; }
    } else if (scope === "SMS") {
      const { selectSmsAdapter } = await import("@/lib/integrations/sms");
      const adapter = await selectSmsAdapter(clubId);
      const result = await adapter.send({ clubId, channel: "SMS", to: { email: "+15555550100" }, subject: "Test", body: "Spectre test" });
      if (result.status === "FAILED") { status = "FAIL"; message = result.failureReason; }
    } else if (scope === "STORAGE") {
      const { resolveStorageAdapter } = await import("@/lib/enterprise/documents");
      const adapter = await resolveStorageAdapter(clubId);
      const key = `health/${Date.now()}.txt`;
      await adapter.put({ clubId, storageKey: key, body: "spectre-health" });
      const round = await adapter.get({ clubId, storageKey: key });
      await adapter.delete({ clubId, storageKey: key });
      if (!round) { status = "FAIL"; message = "storage read returned null"; }
    } else if (scope === "LLM") {
      const { selectLLMProvider } = await import("@/lib/integrations/llm");
      const provider = await selectLLMProvider(clubId);
      const result = await provider.generate({ system: "You are a test harness.", prompt: "Reply with the word: ok" });
      if (!result.text) { status = "FAIL"; message = "no text"; }
    }
  } catch (err) {
    status = "FAIL"; message = err instanceof Error ? err.message : String(err);
  }
  await recordIntegrationCheck({ clubId, settingId, scope, provider: scope, status, message, durationMs: Date.now() - started, checkedByUserId: p.id });
  revalidatePath("/app/admin/integrations");
}

export default async function IntegrationsPage({ searchParams }: { searchParams: { error?: string; scope?: string; emailTest?: string; emailRecipient?: string; emailTarget?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");

  const [summary, settings, emailDelivery] = await Promise.all([
    integrationStatusSummary(clubId),
    listIntegrations(p, clubId),
    getEmailDeliveryDescriptor(clubId),
  ]);

  return (
    <div>
      <Link href="/app/admin/settings" className="text-sm text-stone-500 hover:text-club-ink">← Settings</Link>
      <h1 className="mt-3 page-title">Integrations</h1>
      <p className="mt-1 text-stone-500">Configure external providers for email, SMS, document storage, LLM commentary, and POS. Dev / mock adapters are always available as fallbacks — no production accounts required to run Spectre.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}
      {searchParams.emailTest === "ok" && (
        <div className="mt-4 rounded-md border border-club-green-300 bg-club-green-50 px-3 py-2 text-sm text-club-green-800">
          Diagnostic email accepted by the {searchParams.emailTarget === "local" ? "LOCAL Maildev inbox" : searchParams.emailTarget === "external" ? "external SMTP relay" : (searchParams.emailTarget ?? "configured")} adapter.{" "}
          Recipient: <span className="font-mono">{searchParams.emailRecipient}</span>.{" "}
          {searchParams.emailTarget === "local" && (
            <>Open <a className="underline" href="http://localhost:8025" target="_blank" rel="noopener noreferrer">http://localhost:8025</a> to view it. This was NOT real external delivery.</>
          )}
          {searchParams.emailTarget === "external" && "If it doesn't arrive in the recipient's inbox, check the provider's send log and verify the sender domain."}
        </div>
      )}

      {/* Email-mode diagnostic card. Surfaces the active adapter + the
          target (local Maildev vs external relay) and a form to send a
          one-off test to a real address — so an operator can verify
          their .env.local or per-club setting actually delivers. */}
      <div className={`mt-6 card card-body ${
        emailDelivery.mode === "console" || emailDelivery.smtpTarget === "local"
          ? "border border-amber-300"
          : ""
      }`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="section-title text-lg">Email delivery</h2>
            <div className="mt-1 text-sm">
              <span className="font-medium">Active mode:</span>{" "}
              {emailDelivery.mode === "smtp" && emailDelivery.smtpTarget === "local" && (
                <span className="text-amber-700">SMTP → LOCAL Maildev/Mailhog at <code>{emailDelivery.smtpHost}:{emailDelivery.smtpPort}</code> — members do NOT receive these emails.</span>
              )}
              {emailDelivery.mode === "smtp" && emailDelivery.smtpTarget === "external" && (
                <span className="text-club-green-700">SMTP → EXTERNAL relay at <code>{emailDelivery.smtpHost}:{emailDelivery.smtpPort}</code> — receipts deliver to real inboxes.</span>
              )}
              {emailDelivery.mode === "microsoft365" && (
                <span className="text-club-green-700">
                  Microsoft 365 — receipts send via Microsoft Graph from{" "}
                  <code>{emailDelivery.microsoftFromMailbox ?? "(mailbox not set)"}</code>.
                  Receipts will arrive in members&rsquo; real inboxes addressed from your club&rsquo;s Microsoft 365 mailbox.
                </span>
              )}
              {emailDelivery.mode === "ses" && <span className="text-club-green-700">Amazon SES (per-club credentials) — receipts deliver to real inboxes.</span>}
              {emailDelivery.mode === "console" && <span className="text-amber-700">Console — receipts are logged only. Configure <code>EMAIL_DELIVERY_MODE</code> + <code>SMTP_*</code> to enable real delivery.</span>}
            </div>
            <div className="mt-1 text-xs text-stone-500">
              Source: {emailDelivery.source === "club-override" ? "per-club IntegrationSetting" : emailDelivery.source === "env" ? "env vars (.env.local / .env)" : "default (no override)"}.
              {emailDelivery.mode === "microsoft365" && emailDelivery.microsoftTenantId && (
                <>
                  {" · Tenant "}
                  <code>{emailDelivery.microsoftTenantId.slice(0, 4)}…{emailDelivery.microsoftTenantId.slice(-4)}</code>
                </>
              )}
            </div>
            {emailDelivery.mode === "microsoft365" && (
              <div className="mt-2 text-[11px] text-stone-500 max-w-2xl">
                Setup checklist: an M365 admin must (1) create an App Registration with
                Microsoft Graph <code>Mail.Send</code> <em>application</em> permission,
                (2) grant admin consent, (3) strongly recommended — restrict the app to
                this mailbox via an Application Access Policy, (4) provide tenantId /
                clientId / client secret / from-mailbox to Spectre.
                Do not enter a personal Outlook password.
                See <a className="underline" href="https://github.com/your-org/spectre/blob/main/docs/email-microsoft365.md">docs/email-microsoft365.md</a>.
              </div>
            )}
          </div>
          {canWrite && (
            <form action={sendDiagnosticEmailAction} className="flex flex-wrap items-end gap-2">
              <div>
                <label className="label" htmlFor="diag-recipient">Send a test to</label>
                <input
                  id="diag-recipient"
                  className="input text-sm"
                  type="email"
                  name="recipient"
                  defaultValue={p.email}
                  placeholder="you@example.com"
                  required
                />
              </div>
              <button className="btn btn-primary btn-sm">Send test email</button>
            </form>
          )}
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {summary.map((s) => (
          <div key={s.scope} className="card card-body">
            <div className="text-xs uppercase tracking-widest text-stone-400">{s.scope}</div>
            <div className="mt-1 font-serif text-xl">{s.activeProvider ?? "Not configured"}</div>
            <div className="mt-2 text-sm">
              {s.configured ? <Badge status={s.lastTestStatus ?? "PENDING"} /> : <span className="text-stone-500">Using fallback adapter</span>}
            </div>
            {s.lastTestedAt && <div className="mt-1 text-xs text-stone-500">Last tested {formatDate(s.lastTestedAt)}</div>}
          </div>
        ))}
      </div>

      <div className="mt-10 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Configured providers</div>
        <table className="table-base">
          <thead><tr><th>Scope</th><th>Provider</th><th>Active</th><th>Last test</th><th>Config (masked)</th><th></th></tr></thead>
          <tbody>
            {settings.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No integrations configured. Spectre will use the dev / mock adapters until you set one up below.</td></tr>}
            {settings.map((s) => (
              <tr key={s.id}>
                <td className="text-xs font-mono">{s.scope}</td>
                <td>{s.provider}</td>
                <td className="text-xs">{s.isActive ? "yes" : "no"}</td>
                <td className="text-xs">{s.lastTestedAt ? `${s.lastTestStatus ?? "?"} · ${formatDate(s.lastTestedAt)}` : "—"}</td>
                <td className="text-xs font-mono text-stone-500">{s.configJson.slice(0, 80)}</td>
                <td className="text-right text-xs">
                  {canWrite && ["EMAIL", "SMS", "STORAGE", "LLM"].includes(s.scope) && (
                    <form action={testConnectionAction.bind(null, s.scope as "EMAIL" | "SMS" | "STORAGE" | "LLM", s.id)} className="inline">
                      <button className="text-club-green-700 hover:underline">Test connection</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canWrite && (
        <form action={upsertIntegrationAction} className="mt-8 card card-body space-y-3 max-w-2xl">
          <h2 className="section-title text-lg">Configure a provider</h2>
          <p className="text-xs text-stone-500">Secrets are stored in the database. Use a platform secret store (AWS Secrets Manager, GCP Secret Manager, etc.) for production credentials — the JSON below is convenience for local / staging.</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Scope</label>
              <select className="select" name="scope">
                <option value="EMAIL">EMAIL</option>
                <option value="SMS">SMS</option>
                <option value="STORAGE">STORAGE</option>
                <option value="LLM">LLM</option>
                <option value="POS">POS</option>
                <option value="EXPORT">EXPORT</option>
              </select>
            </div>
            <div>
              <label className="label">Provider</label>
              <input className="input font-mono" name="provider" placeholder="ses | twilio | s3 | anthropic | openai | square" />
            </div>
          </div>
          <div>
            <label className="label">Config JSON (non-secret)</label>
            <textarea className="input font-mono text-xs" name="configJson" rows={4} placeholder='{"region": "us-east-1", "fromAddress": "noreply@club.example"}' />
          </div>
          <div>
            <label className="label">Secrets JSON (encrypted at rest in your platform)</label>
            <textarea className="input font-mono text-xs" name="secretsJson" rows={4} placeholder='{"accessKeyId": "...", "secretAccessKey": "..."}' />
          </div>
          <button className="btn btn-primary">Save</button>
        </form>
      )}

      <div className="mt-8 text-xs text-stone-500 space-y-1 max-w-3xl">
        <p>Common configurations:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><span className="font-mono">EMAIL · ses</span> — config <span className="font-mono">{`{"region":"us-east-1","fromAddress":"noreply@club.example"}`}</span> · secrets <span className="font-mono">{`{"accessKeyId":"...","secretAccessKey":"..."}`}</span></li>
          <li><span className="font-mono">SMS · twilio</span> — config <span className="font-mono">{`{"fromNumber":"+15555550100"}`}</span> · secrets <span className="font-mono">{`{"accountSid":"...","authToken":"..."}`}</span></li>
          <li><span className="font-mono">STORAGE · s3</span> — config <span className="font-mono">{`{"region":"us-east-1","bucket":"spectre-club-docs"}`}</span> · secrets <span className="font-mono">{`{"accessKeyId":"...","secretAccessKey":"..."}`}</span></li>
          <li><span className="font-mono">STORAGE · local</span> — config <span className="font-mono">{`{"rootDir":".data/storage"}`}</span></li>
          <li><span className="font-mono">LLM · anthropic</span> — config <span className="font-mono">{`{"model":"claude-sonnet-4-6"}`}</span> · secrets <span className="font-mono">{`{"apiKey":"sk-ant-..."}`}</span></li>
        </ul>
      </div>
    </div>
  );
}
