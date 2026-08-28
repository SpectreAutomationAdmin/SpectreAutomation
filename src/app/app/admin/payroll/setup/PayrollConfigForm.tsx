"use client";

import { useCallback, useMemo, useState } from "react";
import type { PayrollClubConfigView, PayFrequency, PaymentMethod } from "@/lib/payroll/club-config";

interface Precondition {
  ok: boolean;
  missing: Array<{ path: string; message: string }>;
}

interface Props {
  clubId: string;
  canWrite: boolean;
  config: PayrollClubConfigView | null;
  preconditions: Precondition;
  allowedPayFrequencies: readonly string[];
  allowedPaymentMethods: readonly string[];
  candidateAdmins: Array<{ id: string; name: string | null; email: string }>;
  candidateControllers: Array<{ id: string; name: string | null; email: string }>;
}

const FREQ_LABELS: Record<string, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Biweekly",
  SEMI_MONTHLY: "Semi-monthly",
  MONTHLY: "Monthly",
};

const METHOD_LABELS: Record<string, string> = {
  DIRECT_DEPOSIT: "Direct Deposit",
  CHEQUE: "Cheque",
  OTHER: "Other",
};

export default function PayrollConfigForm({
  clubId,
  canWrite,
  config,
  preconditions,
  allowedPayFrequencies,
  allowedPaymentMethods,
  candidateAdmins,
  candidateControllers,
}: Props) {
  const [country] = useState(config?.country ?? "CA");
  const [province, setProvince] = useState(config?.provinceOfEmployment ?? "");
  const [defaultPayFrequency, setDefaultPayFrequency] = useState<PayFrequency>(
    (config?.defaultPayFrequency as PayFrequency) ?? "BIWEEKLY",
  );
  const [defaultPaymentMethod, setDefaultPaymentMethod] = useState<PaymentMethod>(
    (config?.defaultPaymentMethod as PaymentMethod) ?? "DIRECT_DEPOSIT",
  );
  const [payrollAdminUserId, setPayrollAdminUserId] = useState(config?.payrollAdminUserId ?? "");
  const [controllerUserId, setControllerUserId] = useState(config?.controllerUserId ?? "");
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [status, setStatus] = useState<{ tone: "idle" | "busy" | "ok" | "err"; text: string }>({
    tone: "idle",
    text: "",
  });
  const [live, setLive] = useState<Precondition>(preconditions);

  const missingByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of live.missing) map.set(m.path, m.message);
    return map;
  }, [live]);

  const api = useCallback(
    (path: string) => `/api/clubs/${clubId}/payroll/config${path}`,
    [clubId],
  );

  const save = async () => {
    if (!canWrite) return;
    setStatus({ tone: "busy", text: "" });
    try {
      const res = await fetch(api(""), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country,
          provinceOfEmployment: province.trim() || null,
          defaultPayFrequency,
          defaultPaymentMethod,
          payrollAdminUserId: payrollAdminUserId || null,
          controllerUserId: controllerUserId || null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const check = await fetch(api("")).then((r) => r.json());
      setLive(check.preconditions);
      setStatus({ tone: "ok", text: "Configuration saved." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    }
  };

  const flip = async (action: "activate" | "deactivate") => {
    if (!canWrite) return;
    setStatus({ tone: "busy", text: "" });
    try {
      const res = await fetch(api(""), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as { config: PayrollClubConfigView };
      setEnabled(body.config.enabled);
      const check = await fetch(api("")).then((r) => r.json());
      setLive(check.preconditions);
      setStatus({
        tone: "ok",
        text: action === "activate" ? "Payroll activated." : "Payroll deactivated.",
      });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    }
  };

  const disabled = !canWrite || status.tone === "busy";

  return (
    <div className="space-y-5" data-testid="payroll-config-form">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-spectre-4">
        <Field label="Country" help="Only Canada is supported in the current Payroll release." error={missingByPath.get("country")}>
          <input value={country} readOnly className="spectre-input" data-testid="payroll-config-country" />
        </Field>
        <Field label="Province of employment" help="Only Alberta is supported in the current Payroll release." error={missingByPath.get("provinceOfEmployment")}>
          <input
            value={province}
            onChange={(e) => setProvince(e.target.value.toUpperCase())}
            className="spectre-input"
            maxLength={2}
            placeholder="AB"
            data-testid="payroll-config-province"
            disabled={disabled}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-spectre-4">
        <Field label="Default pay frequency" error={missingByPath.get("defaultPayFrequency")}>
          <select
            value={defaultPayFrequency}
            onChange={(e) => setDefaultPayFrequency(e.target.value as PayFrequency)}
            className="spectre-input"
            data-testid="payroll-config-freq"
            disabled={disabled}
          >
            {allowedPayFrequencies.map((v) => (
              <option key={v} value={v}>{FREQ_LABELS[v] ?? v}</option>
            ))}
          </select>
        </Field>
        <Field label="Default payment method" error={missingByPath.get("defaultPaymentMethod")}>
          <select
            value={defaultPaymentMethod}
            onChange={(e) => setDefaultPaymentMethod(e.target.value as PaymentMethod)}
            className="spectre-input"
            data-testid="payroll-config-method"
            disabled={disabled}
          >
            {allowedPaymentMethods.map((v) => (
              <option key={v} value={v}>{METHOD_LABELS[v] ?? v}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-spectre-4">
        <Field label="Payroll Administrator" help="The person responsible for preparing payroll. Must hold the Payroll Administrator role at this Club." error={missingByPath.get("payrollAdminUserId")}>
          <select
            value={payrollAdminUserId}
            onChange={(e) => setPayrollAdminUserId(e.target.value)}
            className="spectre-input"
            data-testid="payroll-config-admin"
            disabled={disabled}
          >
            <option value="">— Not assigned —</option>
            {candidateAdmins.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Controller" help="The person who approves each payroll run before it's posted. Must hold the Controller role at this Club." error={missingByPath.get("controllerUserId")}>
          <select
            value={controllerUserId}
            onChange={(e) => setControllerUserId(e.target.value)}
            className="spectre-input"
            data-testid="payroll-config-controller"
            disabled={disabled}
          >
            <option value="">— Not assigned —</option>
            {candidateControllers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex items-center gap-3 flex-wrap pt-2">
        <button
          type="button"
          disabled={disabled}
          onClick={save}
          className="spectre-btn spectre-btn-primary"
          data-testid="payroll-config-save"
        >
          Save configuration
        </button>
        {enabled ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => flip("deactivate")}
            className="spectre-btn spectre-btn--secondary"
            data-testid="payroll-config-deactivate"
          >
            Deactivate Payroll
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || !live.ok}
            onClick={() => flip("activate")}
            className="spectre-btn spectre-btn-primary"
            data-testid="payroll-config-activate"
          >
            Activate Payroll
          </button>
        )}
        <ActivationStatus enabled={enabled} preconditions={live} />
        {status.text && (
          <p
            role={status.tone === "err" ? "alert" : "status"}
            className={
              "text-sm " +
              (status.tone === "ok" ? "text-emerald-700" : status.tone === "err" ? "text-red-700" : "text-stone-600")
            }
            data-testid="payroll-config-status"
          >
            {status.text}
          </p>
        )}
      </div>

      {!live.ok && !enabled && (
        <div
          className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
          data-testid="payroll-config-preconditions"
        >
          <p className="text-sm font-semibold text-amber-900">
            Payroll cannot be activated yet because:
          </p>
          <ul className="mt-1 space-y-0.5 text-sm text-amber-900 list-disc list-inside">
            {live.missing.map((m) => (
              <li key={m.path}>{m.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ActivationStatus({ enabled, preconditions }: { enabled: boolean; preconditions: Precondition }) {
  if (enabled) {
    return (
      <span
        className="text-[11px] uppercase tracking-widest rounded px-1.5 py-0.5 border border-emerald-300 bg-emerald-50 text-emerald-800"
        data-testid="payroll-config-status-badge"
      >
        Active
      </span>
    );
  }
  if (preconditions.ok) {
    return (
      <span
        className="text-[11px] uppercase tracking-widest rounded px-1.5 py-0.5 border border-emerald-300 bg-emerald-50 text-emerald-800"
        data-testid="payroll-config-status-badge"
      >
        Ready to activate
      </span>
    );
  }
  return (
    <span
      className="text-[11px] uppercase tracking-widest rounded px-1.5 py-0.5 border border-amber-300 bg-amber-50 text-amber-900"
      data-testid="payroll-config-status-badge"
    >
      Setup incomplete
    </span>
  );
}

function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="spectre-label">{label}</label>
      <div className="mt-1">{children}</div>
      {error && <p className="text-[11px] text-red-700 mt-1">{error}</p>}
      {help && !error && <p className="spectre-help mt-1">{help}</p>}
    </div>
  );
}
