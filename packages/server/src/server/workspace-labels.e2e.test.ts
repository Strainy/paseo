import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test("workspace.create persists normalized initial labels", async () => {
  const daemon = await createTestPaseoDaemon();
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-workspace-labels-"));
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.3.0-beta.2",
  });

  try {
    await client.connect();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
      labels: [" frontend ", "urgent", "", "frontend"],
    });

    expect(created.error).toBeNull();
    expect(created.workspace?.labels).toEqual(["frontend", "urgent"]);

    const fetched = await client.fetchWorkspaces();
    expect(
      fetched.entries.find((workspace) => workspace.id === created.workspace?.id)?.labels,
    ).toEqual(["frontend", "urgent"]);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);
