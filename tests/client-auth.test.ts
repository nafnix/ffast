import { describe, expect, it, vi } from "vitest";
import { redirectOnUnauthorized } from "@/lib/client-auth";

describe("client session expiry handling", () => {
  it("redirects to login for unauthorized responses", () => {
    const navigate = vi.fn();

    expect(redirectOnUnauthorized(401, navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("leaves other response statuses to their normal error handling", () => {
    const navigate = vi.fn();

    expect(redirectOnUnauthorized(413, navigate)).toBe(false);
    expect(redirectOnUnauthorized(500, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
