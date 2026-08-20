import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

function workspaceRow(page: Page, workspaceKey: string) {
  return page.getByTestId(`sidebar-workspace-row-${workspaceKey}`);
}

async function openSidebarWorkspaceMenu(page: Page, workspaceKey: string): Promise<void> {
  const row = workspaceRow(page, workspaceKey);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${workspaceKey}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();
}

async function expectWorkspaceInStatusGroup(
  page: Page,
  workspaceKey: string,
  bucket: "attention" | "done",
): Promise<void> {
  await expect(
    page
      .getByTestId(`sidebar-status-group-rows-${bucket}`)
      .getByTestId(`sidebar-workspace-row-${workspaceKey}`),
  ).toBeVisible({ timeout: 30_000 });
}

test("a workspace stays unread across reload until it is marked as read", async ({ page }) => {
  test.setTimeout(90_000);
  const workspace = await seedWorkspace({ repoPrefix: "workspace-mark-unread-" });

  try {
    const serverId = getServerId();
    const workspaceKey = `${serverId}:${workspace.workspaceId}`;
    const row = workspaceRow(page, workspaceKey);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openSidebarWorkspaceMenu(page, workspaceKey);

    const markUnread = page.getByTestId(`sidebar-workspace-menu-mark-unread-${workspaceKey}`);
    await expect(markUnread).toBeVisible({ timeout: 10_000 });
    await markUnread.click();

    await expect(row.locator('[data-testid="workspace-status-indicator-attention"]')).toBeVisible({
      timeout: 30_000,
    });

    await selectSidebarStatusGrouping(page);
    await expect(page.getByTestId("sidebar-status-group-attention")).toContainText(
      "Ready to review",
      { timeout: 30_000 },
    );
    await expectWorkspaceInStatusGroup(page, workspaceKey, "attention");

    await switchWorkspaceViaSidebar({ page, serverId, workspaceId: workspace.workspaceId });
    await page.reload();

    await expect(page.getByTestId("workspace-header-menu-trigger")).toBeVisible({
      timeout: 30_000,
    });
    await expectWorkspaceInStatusGroup(page, workspaceKey, "attention");

    await page.getByTestId("workspace-header-menu-trigger").click();
    const markAsRead = page.getByTestId("workspace-header-mark-as-read");
    await expect(markAsRead).toBeVisible({ timeout: 10_000 });
    await markAsRead.click();

    await expectWorkspaceInStatusGroup(page, workspaceKey, "done");
    await expect(
      page
        .getByTestId("sidebar-status-group-rows-attention")
        .getByTestId(`sidebar-workspace-row-${workspaceKey}`),
    ).toHaveCount(0);

    await page.getByTestId("workspace-header-menu-trigger").click();
    await expect(page.getByTestId("workspace-header-mark-unread")).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await workspace.cleanup();
  }
});
