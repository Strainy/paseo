import { describe, expect, it } from "vitest";
import { resolveWorkspaceReadAction } from "./use-workspace-read-controller";

describe("resolveWorkspaceReadAction", () => {
  it("offers mark as read whenever a manual unread marker is present", () => {
    for (const status of ["needs_input", "failed", "running", "attention", "done"] as const) {
      expect(
        resolveWorkspaceReadAction({
          status,
          markedUnreadAt: "2026-08-19T12:34:56.000Z",
          supportsMarkUnread: true,
        }),
      ).toBe("mark_as_read");
    }
  });

  it("retains mark as read for aggregate attention and failure", () => {
    for (const status of ["attention", "failed"] as const) {
      expect(
        resolveWorkspaceReadAction({
          status,
          markedUnreadAt: null,
          supportsMarkUnread: false,
        }),
      ).toBe("mark_as_read");
    }
  });

  it("offers mark unread for every hydrated, unmarked workspace on a supporting host", () => {
    for (const status of ["needs_input", "running", "done"] as const) {
      expect(
        resolveWorkspaceReadAction({
          status,
          markedUnreadAt: null,
          supportsMarkUnread: true,
        }),
      ).toBe("mark_unread");
    }
  });

  it("does not offer mark unread for an older host", () => {
    expect(
      resolveWorkspaceReadAction({
        status: "done",
        markedUnreadAt: null,
        supportsMarkUnread: false,
      }),
    ).toBeNull();
  });

  it("does not offer an action before the workspace descriptor arrives", () => {
    expect(
      resolveWorkspaceReadAction({
        status: undefined,
        markedUnreadAt: undefined,
        supportsMarkUnread: true,
      }),
    ).toBeNull();
  });
});
