/* @vitest-environment jsdom */
// AUTH-3C — SignOutEmployeeEverywhereButton UI behaviour.
//
// Proves the human-facing contract of the Employee Profile "Sign out
// on all devices" control:
//   • Trigger renders as a restrained secondary button.
//   • Clicking it opens a confirmation with founder-specified copy.
//   • Cancel restores initial state and calls no action.
//   • Confirm fires the passed server action and shows success copy on
//     an { ok: true } response.
//   • Server error surfaces as an inline error message, no false
//     success.
//   • Zero-active-session target still renders success (idempotent).
//   • No session count / bearer / token / database terminology appears
//     in the rendered UI (§1 + §7 language rules).

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import SignOutEmployeeEverywhereButton from "@/components/hr/SignOutEmployeeEverywhereButton";

afterEach(() => cleanup());

const FORBIDDEN_TERMS = [
  /\brevoke\b/i,
  /\bsession id\b/i,
  /\btoken\b/i,
  /\bbearer\b/i,
  /\bcookie\b/i,
  /\bJWT\b/,
  /\bcount:\s*\d+\b/i,
  /\bactive sessions?\b/i,
];

function assertNoTechnicalLeak(root: HTMLElement) {
  const text = root.textContent ?? "";
  for (const re of FORBIDDEN_TERMS) {
    expect(text, `rendered UI contained forbidden term matching ${re}: ${text}`).not.toMatch(re);
  }
}

describe("AUTH-3C · SignOutEmployeeEverywhereButton", () => {
  it("renders the trigger with the exact founder-specified label", () => {
    render(
      <SignOutEmployeeEverywhereButton
        employeeId="e1"
        employeeDisplayName="Marc Maldiney"
        action={vi.fn()}
      />,
    );
    const trigger = screen.getByTestId("portal-signout-everywhere-open");
    expect(trigger.textContent?.trim()).toBe("Sign out on all devices");
    assertNoTechnicalLeak(document.body);
  });

  it("clicking trigger opens confirmation with founder-specified copy", () => {
    render(
      <SignOutEmployeeEverywhereButton
        employeeId="e1"
        employeeDisplayName="Marc Maldiney"
        action={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("portal-signout-everywhere-open"));
    expect(document.body.textContent).toContain(
      "Sign out on all devices? This will sign Marc Maldiney out of Spectre on every device. They will need to sign in again.",
    );
    // Both Cancel and Confirm rendered.
    expect(screen.getByTestId("portal-signout-everywhere-confirm")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    assertNoTechnicalLeak(document.body);
  });

  it("Cancel closes the confirmation and calls no action", () => {
    const action = vi.fn();
    render(
      <SignOutEmployeeEverywhereButton
        employeeId="e1"
        employeeDisplayName="Marc"
        action={action}
      />,
    );
    fireEvent.click(screen.getByTestId("portal-signout-everywhere-open"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(action).not.toHaveBeenCalled();
    // Trigger returns.
    expect(screen.getByTestId("portal-signout-everywhere-open")).toBeTruthy();
  });

  it("Confirm fires the action and shows success copy on { ok: true }", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    render(
      <SignOutEmployeeEverywhereButton
        employeeId="e1"
        employeeDisplayName="Marc"
        action={action}
      />,
    );
    fireEvent.click(screen.getByTestId("portal-signout-everywhere-open"));
    fireEvent.click(screen.getByTestId("portal-signout-everywhere-confirm"));
    await waitFor(() => {
      expect(action).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      const success = screen.getByTestId("portal-signout-everywhere-success");
      expect(success.textContent).toBe("Marc has been signed out on all devices.");
    });
    assertNoTechnicalLeak(document.body);
  });

  it("server error surfaces as inline error, does NOT show success", async () => {
    const action = vi.fn().mockResolvedValue({ ok: false, error: "Something went wrong." });
    render(
      <SignOutEmployeeEverywhereButton
        employeeId="e1"
        employeeDisplayName="Marc"
        action={action}
      />,
    );
    fireEvent.click(screen.getByTestId("portal-signout-everywhere-open"));
    fireEvent.click(screen.getByTestId("portal-signout-everywhere-confirm"));
    await waitFor(() => {
      const err = screen.getByTestId("portal-signout-everywhere-error");
      expect(err.textContent).toBe("Something went wrong.");
    });
    expect(screen.queryByTestId("portal-signout-everywhere-success")).toBeNull();
  });

  it("zero-active-session target: { ok: true } still shows success (idempotent per §35)", async () => {
    // Server-side, revokeAllForEmployee returns count=0 when nothing is
    // active but the wrapper returns { ok: true } either way. The UI
    // does not distinguish and shows the same success copy.
    const action = vi.fn().mockResolvedValue({ ok: true });
    render(
      <SignOutEmployeeEverywhereButton
        employeeId="e1"
        employeeDisplayName="Sam"
        action={action}
      />,
    );
    fireEvent.click(screen.getByTestId("portal-signout-everywhere-open"));
    fireEvent.click(screen.getByTestId("portal-signout-everywhere-confirm"));
    await waitFor(() => {
      const s = screen.getByTestId("portal-signout-everywhere-success");
      expect(s.textContent).toBe("Sam has been signed out on all devices.");
    });
  });
});
