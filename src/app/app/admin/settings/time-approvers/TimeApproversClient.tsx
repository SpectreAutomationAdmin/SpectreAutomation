"use client";

// Payroll-3D-3A (2026-09-05) — Timesheet Approver configuration UI.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignTimeApproverAction } from "./_actions";

interface DepartmentRow {
  departmentId:   string;
  departmentCode: string;
  departmentName: string;
  approver: {
    userId:    string;
    userName:  string | null;
    userEmail: string;
    assignedAtIso: string;
  } | null;
  hasReviewableTime: boolean;
  needsApprover: boolean;
}

interface EligibleUser {
  id:    string;
  name:  string | null;
  email: string;
  primaryRoleKey: string | null;
}

export default function TimeApproversClient(props: {
  departments: DepartmentRow[];
  eligibleUsers: EligibleUser[];
  focusDepartmentId?: string | null;
}) {
  const router = useRouter();
  const [editingDeptId, setEditingDeptId] = useState<string | null>(props.focusDepartmentId ?? null);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  return (
    <section data-testid="time-approvers-workspace" className="space-y-6">
      {err ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
           data-testid="time-approvers-error">{err}</p>
      ) : null}
      {okMsg ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
           data-testid="time-approvers-success">{okMsg}</p>
      ) : null}

      <div className="rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-100 px-4 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            Timesheet approvers by department
          </h3>
        </div>
        <ul className="divide-y divide-stone-100">
          {props.departments.map((d) => {
            const isEditing = editingDeptId === d.departmentId;
            const missing = d.needsApprover;
            return (
              <li key={d.departmentId} className="px-4 py-3"
                  data-testid={`time-approver-row:${d.departmentCode}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-club-ink">
                      {d.departmentName}
                      {missing ? (
                        <span className="ml-2 inline-block rounded-sm bg-amber-100 px-1 text-[10px] font-semibold uppercase text-amber-900"
                              data-testid={`time-approver-missing:${d.departmentCode}`}>
                          Missing approver
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-[11px] text-stone-500">
                      {d.approver ? (
                        <>Current: {d.approver.userName ?? d.approver.userEmail}</>
                      ) : (
                        <>No Timesheet Approver assigned.</>
                      )}
                      {d.hasReviewableTime ? " · has recorded time this period" : ""}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {isEditing ? (
                      <>
                        <select
                          className="input min-w-[220px]"
                          value={selectedUserId}
                          onChange={(e) => setSelectedUserId(e.target.value)}
                          disabled={pending}
                          data-testid={`time-approver-user-picker:${d.departmentCode}`}
                        >
                          <option value="">— Choose a user —</option>
                          {props.eligibleUsers.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name ?? u.email}
                              {u.primaryRoleKey ? ` · ${u.primaryRoleKey.replace(/_/g, " ").toLowerCase()}` : ""}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={pending || !selectedUserId}
                          data-testid={`time-approver-save:${d.departmentCode}`}
                          onClick={() => {
                            setErr(null); setOkMsg(null);
                            startTransition(async () => {
                              const r = await assignTimeApproverAction({
                                departmentId: d.departmentId, userId: selectedUserId,
                              });
                              if (r.ok) {
                                setOkMsg(`Timesheet Approver updated for ${d.departmentName}.`);
                                setEditingDeptId(null);
                                setSelectedUserId("");
                                router.refresh();
                              } else setErr(r.error);
                            });
                          }}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={pending}
                          onClick={() => { setEditingDeptId(null); setSelectedUserId(""); setErr(null); }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={missing ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
                          data-testid={`time-approver-edit:${d.departmentCode}`}
                          onClick={() => {
                            setEditingDeptId(d.departmentId);
                            setSelectedUserId(d.approver?.userId ?? "");
                          }}
                        >
                          {d.approver ? "Change" : "Assign"}
                        </button>
                        {d.approver ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={pending}
                            data-testid={`time-approver-unassign:${d.departmentCode}`}
                            onClick={() => {
                              if (!confirm(`Unassign ${d.approver!.userName ?? d.approver!.userEmail} as Timesheet Approver for ${d.departmentName}?`)) return;
                              setErr(null); setOkMsg(null);
                              startTransition(async () => {
                                const r = await assignTimeApproverAction({
                                  departmentId: d.departmentId, userId: null,
                                });
                                if (r.ok) {
                                  setOkMsg(`Timesheet Approver removed from ${d.departmentName}.`);
                                  router.refresh();
                                } else setErr(r.error);
                              });
                            }}
                          >
                            Unassign
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="text-[10px] uppercase tracking-wider text-stone-500">
        Eligible users: currently ACTIVE members of this club who hold the timesheet-approval capability.
      </p>
    </section>
  );
}
