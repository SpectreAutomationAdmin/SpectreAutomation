/* @vitest-environment jsdom */
// AUTH-3C — SignOutUserEverywhereButton UI behaviour + self-revocation.
//
// Same contract as the employee-side button, plus:
//   • When `isSelf` is true, confirmation copy uses first-person
//     ("This will sign you out …") and success handling triggers a
//     redirect to /login.
//   • When `isSelf` is false, second-person copy names the target.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import SignOutUserEverywhereButton from "@/components/admin/SignOutUserEverywhereButton";

afterEach(() => cleanup());

const FORBIDDEN_TERMS = [
  /\brevoke\b/i,
  /\bsession id\b/i,
  /\btoken\b/i,
  /\bbearer\b/i,
  /\bactive sessions?\b/i,
];

function assertNoTechnicalLeak() {
  const text = document.body.textContent ?? "";
  for (const re of FORBIDDEN_TERMS) {
    expect(text, `rendered UI contained forbidden term matching ${re}: ${text}`).not.toMatch(re);
  }
}

describe("AUTH-3C · SignOutUserEverywhereButton — cross-user path", () => {
  it("renders trigger + opens second-person confirmation naming the target", () => {
    render(
      <SignOutUserEverywhereButton
        targetUserId="u-target"
        targetDisplayName="Sam Manager"
        isSelf={false}
        action={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("tenant-user-signout-open:u-target"));
    expect(document.body.textContent).toContain(
      "Sign out on all devices? This will sign Sam Manager out of Spectre on every device.",
    );
    assertNoTechnicalLeak();
  });

  it("Cancel restores initial state and calls no action", () => {
    const action = vi.fn();
    render(
      <SignOutUserEverywhereButton
        targetUserId="u-target"
        targetDisplayName="Sam Manager"
        isSelf={false}
        action={action}
      />,
    );
    fireEvent.click(screen.getByTestId("tenant-user-signout-open:u-target"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(action).not.toHaveBeenCalled();
  });

  it("cross-user success shows second-person confirmation", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, selfRevocation: false });
    render(
      <SignOutUserEverywhereButton
        targetUserId="u-target"
        targetDisplayName="Sam Manager"
        isSelf={false}
        action={action}
      />,
    );
    fireEvent.click(screen.getByTestId("tenant-user-signout-open:u-target"));
    fireEvent.click(screen.getByTestId("tenant-user-signout-confirm:u-target"));
    await waitFor(() => {
      const s = screen.getByTestId("tenant-user-signout-success:u-target");
      expect(s.textContent).toBe("Sam Manager has been signed out on all devices.");
    });
  });

  it("server error surfaces as inline error", async () => {
    const action = vi.fn().mockResolvedValue({ ok: false, error: "Something went wrong." });
    render(
      <SignOutUserEverywhereButton
        targetUserId="u-target"
        targetDisplayName="Sam Manager"
        isSelf={false}
        action={action}
      />,
    );
    fireEvent.click(screen.getByTestId("tenant-user-signout-open:u-target"));
    fireEvent.click(screen.getByTestId("tenant-user-signout-confirm:u-target"));
    await waitFor(() => {
      const err = screen.getByTestId("tenant-user-signout-error:u-target");
      expect(err.textContent).toBe("Something went wrong.");
    });
    expect(screen.queryByTestId("tenant-user-signout-success:u-target")).toBeNull();
  });
});

describe("AUTH-3C · SignOutUserEverywhereButton — self-revocation", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // jsdom's window.location is read-only for href assignment via
    // property replacement, so we replace the whole object.
    // @ts-expect-error — test-only override
    delete window.location;
    // @ts-expect-error — test-only override
    window.location = { ...originalLocation, href: "" } as Location;
  });

  afterEach(() => {
    // @ts-expect-error — restore
    window.location = originalLocation;
  });

  it("self confirmation uses first-person copy ('sign you out …')", () => {
    render(
      <SignOutUserEverywhereButton
        targetUserId="u-me"
        targetDisplayName="Chris Turcato"
        isSelf={true}
        action={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("tenant-user-signout-open:u-me"));
    expect(document.body.textContent).toContain(
      "Sign out on all devices? This will sign you out of Spectre on every device. You will need to sign in again.",
    );
    assertNoTechnicalLeak();
  });

  it("self { ok: true, selfRevocation: true } shows redirect copy and navigates to /login", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, selfRevocation: true });
    render(
      <SignOutUserEverywhereButton
        targetUserId="u-me"
        targetDisplayName="Chris Turcato"
        isSelf={true}
        action={action}
      />,
    );
    fireEvent.click(screen.getByTestId("tenant-user-signout-open:u-me"));
    fireEvent.click(screen.getByTestId("tenant-user-signout-confirm:u-me"));
    await waitFor(() => {
      const s = screen.getByTestId("tenant-user-signout-success:u-me");
      expect(s.textContent).toBe("You have been signed out on all devices. Redirecting…");
    });
    // Redirect fires ~200ms after — wait a bit more.
    await waitFor(() => {
      expect(window.location.href).toBe("/login");
    }, { timeout: 1000 });
  });
});
