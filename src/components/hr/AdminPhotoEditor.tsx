// HR-2B.3.1 (2026-08-18) §2 — small client control for admin add /
// replace of an employee profile photo. Renders inside the "Employee
// Picture" card of EmployeeProfileView. Restrained UI — a single
// button that opens a native file picker; on selection the file
// uploads immediately to POST /api/hr/employees/[id]/profile-photo
// then calls router.refresh() so the header + right-column preview
// re-render with the new bytes.
//
// The button label toggles between "Add photo" (no photo on file)
// and "Change photo" (photo exists).

"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  employeeId: string;
  hasPhoto: boolean;
}

const ACCEPT = "image/jpeg,image/png,image/heic,image/heif,image/webp";
const MAX_BYTES = 10 * 1024 * 1024;

export default function AdminPhotoEditor({ employeeId, hasPhoto }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pick() {
    if (pending) return;
    setError(null);
    inputRef.current?.click();
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size === 0) {
      setError("The selected file is empty. Please try another.");
      e.target.value = "";
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("Photo exceeds 10 MB limit. Please choose a smaller image.");
      e.target.value = "";
      return;
    }
    const fd = new FormData();
    fd.set("photo", file);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/hr/employees/${employeeId}/profile-photo`, {
          method: "POST",
          body: fd,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Upload failed.");
          if (inputRef.current) inputRef.current.value = "";
          return;
        }
        // Reset the input so the same file can be picked again in a
        // future edit cycle without a hard reload.
        if (inputRef.current) inputRef.current.value = "";
        router.refresh();
      } catch {
        setError("Network error — please try again.");
        if (inputRef.current) inputRef.current.value = "";
      }
    });
  }

  return (
    <div className="mt-3 flex flex-col items-start gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        data-testid="admin-photo-input"
        onChange={onChange}
      />
      <button
        type="button"
        data-testid="admin-photo-button"
        className="text-xs uppercase tracking-wide text-stone-500 hover:text-stone-900 underline underline-offset-4"
        onClick={pick}
        disabled={pending}
      >
        {pending ? "Uploading…" : hasPhoto ? "Change photo" : "Add photo"}
      </button>
      {error && (
        <p role="alert" data-testid="admin-photo-error" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
