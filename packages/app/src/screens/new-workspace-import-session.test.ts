import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
import {
  importedSessionWorkspaceNavigation,
  resolveNewWorkspaceImportSessionTarget,
} from "./new-workspace-import-session";

function project(): HostProjectListItem {
  return {
    viewKey: "remote:github.com/nvidia-lpu/lpu-monorepo",
    projectKey: "remote:github.com/nvidia-lpu/lpu-monorepo",
    projectName: "lpu-monorepo",
    projectKind: "git",
    iconWorkingDir: "/home/me/dev/github/nvidia-lpu/lpu-monorepo",
    hosts: [
      {
        serverId: "devvm",
        projectId: "project-lpu",
        iconWorkingDir: "/home/me/dev/github/nvidia-lpu/lpu-monorepo",
        worktreeSupport: "supported",
      },
    ],
    workspaceKeys: [],
  };
}

describe("resolveNewWorkspaceImportSessionTarget", () => {
  it("uses the currently selected project's host-local identity and provider context", () => {
    expect(
      resolveNewWorkspaceImportSessionTarget({
        project: project(),
        providerContextCwd: "/home/me/dev/github/nvidia-lpu/lpu-monorepo",
        serverId: "devvm",
      }),
    ).toEqual({
      kind: "project",
      projectId: "project-lpu",
      providerContextCwd: "/home/me/dev/github/nvidia-lpu/lpu-monorepo",
    });
  });

  it("does not fall back to host-wide import without a valid host placement and context", () => {
    expect(
      resolveNewWorkspaceImportSessionTarget({
        project: project(),
        providerContextCwd: "/home/me/dev/github/nvidia-lpu/lpu-monorepo",
        serverId: "other-host",
      }),
    ).toBeNull();
    expect(
      resolveNewWorkspaceImportSessionTarget({
        project: project(),
        providerContextCwd: null,
        serverId: "devvm",
      }),
    ).toBeNull();
    expect(
      resolveNewWorkspaceImportSessionTarget({
        project: null,
        providerContextCwd: "/home/me/dev/github/nvidia-lpu/lpu-monorepo",
        serverId: "devvm",
      }),
    ).toBeNull();
  });
});

describe("importedSessionWorkspaceNavigation", () => {
  it("opens the imported agent in the workspace created by the daemon", () => {
    expect(
      importedSessionWorkspaceNavigation("server-1", {
        id: "agent-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-1",
      target: { kind: "agent", agentId: "agent-1" },
    });
  });

  it("does not build a route when an older daemon omits the workspace id", () => {
    expect(importedSessionWorkspaceNavigation("server-1", { id: "agent-1" })).toBeNull();
  });
});
