"use client";

// HR-2B.5 §7-9 — Employee Portal login form.

import { useState } from "react";

export default function EmployeeLoginForm({
  action,
}: {
  action: (formData: FormData) => Promise<void> | void;
}) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={action} className="space-y-4" noValidate>
      <div>
        <label className="label" htmlFor="employeeNumber">Employee number</label>
        <input
          id="employeeNumber"
          name="employeeNumber"
          type="text"
          className="input font-mono"
          autoComplete="username"
          required
          maxLength={40}
          placeholder="E-00142"
          data-testid="employee-login-number"
        />
      </div>
      <div>
        <div className="flex items-baseline justify-between">
          <label className="label" htmlFor="password">Password</label>
          <button
            type="button"
            className="text-xs text-stone-500 hover:text-stone-800 underline"
            onClick={() => setShowPassword((s) => !s)}
            data-testid="employee-login-toggle"
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
        <input
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          className="input"
          autoComplete="current-password"
          required
          data-testid="employee-login-password"
        />
      </div>
      <button
        type="submit"
        className="w-full rounded-md bg-emerald-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-900 focus:outline-none focus:ring-2 focus:ring-emerald-700 focus:ring-offset-2"
        data-testid="employee-login-submit"
      >
        Sign in
      </button>
    </form>
  );
}
