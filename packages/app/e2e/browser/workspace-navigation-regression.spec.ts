import {
  buildHostAgentDetailRoute,
  buildHostWorkspaceOpenRoute,
  buildHostWorkspaceRoute,
} from "@/utils/host-routes";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  closeWorkspaceAgentTab,
  createMockIdleAgent,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openWorkspaceWithAgents,
} from "../support/helpers/archive-tab";
import {
  expectAgentAbsentFromWorkspaceLayout,
  seedForeignPinnedAgentTab,
} from "../support/helpers/workspace-layout";
import { clickNewChat } from "../support/helpers/launcher";
import { expectComposerVisible } from "../support/helpers/composer";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  getVisibleWorkspaceAgentTabIds,
  expectOnlyWorkspaceAgentTabsVisible,
  waitForWorkspaceTabsVisible,
  expectWorkspaceTabsAbsent,
} from "../support/helpers/workspace-tabs";
import {
  expectSidebarWorkspaceSelected,
  expectWorkspaceHeader,
  expectWorkspaceHeaderAbsent,
  expectMenuButtonVisible,
  expectHostConnectingOrOffline,
  expectReconnectingToastVisible,
  expectReconnectingToastGone,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
  workspaceDeckEntryLocator,
  expectWorkspaceDeckEntryCount,
} from "../support/helpers/workspace-ui";
import { clickSettingsBackToWorkspace, openSettingsSection } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import { expectAppRoute } from "../support/helpers/route-assertions";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { addConnectedHostAndReload, addOfflineHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";

const LOADING_WORKSPACE_TEXT_PATTERN = /Loading workspace/i;
async function expectNoLoadingWorkspacePane(
  page: Page,
  input: { label: string; durationMs?: number },
): Promise<void> {
  const durationMs = input.durationMs ?? 2000;
  const startedAt = Date.now();
  const samples: string[] = [];

  while (Date.now() - startedAt < durationMs) {
    const url = page.url();
    const text = await page
      .locator("body")
      .innerText({ timeout: 250 })
      .catch((error) => `[body unavailable: ${error instanceof Error ? error.message : error}]`);
    samples.push(`${Date.now() - startedAt}ms ${url}\n${text.slice(0, 1000)}`);

    if (LOADING_WORKSPACE_TEXT_PATTERN.test(text)) {
      throw new Error(
        `${input.label}: loading workspace pane appeared during reconnect window.\n\n${samples.join(
          "\n\n---\n\n",
        )}`,
      );
    }

    await page.waitForTimeout(100);
  }
}

async function expectNoLoadingPane(page: Page): Promise<void> {
  await expect(page.getByText(LOADING_WORKSPACE_TEXT_PATTERN)).toHaveCount(0);
}

async function getVisibleDraftTabCount(page: Page): Promise<number> {
  return page.locator('[data-testid^="workspace-tab-draft"]').filter({ visible: true }).count();
}

async function closeFirstVisibleDraftTab(page: Page): Promise<void> {
  const tab = page
    .locator('[data-testid^="workspace-tab-draft"]')
    .filter({ visible: true })
    .first();
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.hover();
  const closeButton = page.locator('[data-testid^="workspace-draft-close-"]').filter({
    visible: true,
  });
  await expect(closeButton.first()).toBeVisible({ timeout: 30_000 });
  await closeButton.first().click();
}

async function openWorkspaceTabUrl(page: Page, route: string): Promise<void> {
  await page.evaluate((url) => {
    window.history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, route);
  await expectAppRoute(page, route.split("?")[0]);
}

async function useMacKeyboardShortcuts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  });
}

async function expectHistoryWorkspace(page: Page, workspace: SeededWorkspace): Promise<void> {
  const serverId = getServerId();
  await expectAppRoute(page, buildHostWorkspaceRoute(serverId, workspace.workspaceId));
  await expectSidebarWorkspaceSelected({ page, serverId, workspaceId: workspace.workspaceId });
  await expectWorkspaceHeader(page, {
    title: workspace.workspaceName,
    subtitle: workspace.projectDisplayName,
  });
  await expect(workspaceDeckEntryLocator(page, serverId, workspace.workspaceId)).toBeVisible();
}

async function clickMouseHistoryButton(page: Page, button: "back" | "forward"): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button,
      buttons: button === "back" ? 8 : 16,
      x: 8,
      y: 8,
      clickCount: 1,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button,
      buttons: 0,
      x: 8,
      y: 8,
      clickCount: 1,
    });
  } finally {
    await session.detach();
  }
}

async function goBackTwiceWithoutWaitingForRender(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.addEventListener("popstate", () => window.history.back(), { once: true });
    window.history.back();
  });
}

test.describe("Workspace navigation regression", () => {
  test.describe.configure({ timeout: 240_000 });

  test("shares workspace history across browser, keyboard and mouse navigation and truncates forward", async ({
    page,
  }) => {
    const serverId = getServerId();
    const firstWorkspace = await seedWorkspace({ repoPrefix: "history-workspace-a-" });
    const secondWorkspace = await seedWorkspace({ repoPrefix: "history-workspace-b-" });
    const thirdWorkspace = await seedWorkspace({ repoPrefix: "history-workspace-c-" });

    try {
      for (const workspace of [firstWorkspace, secondWorkspace, thirdWorkspace]) {
        await createMockIdleAgent(workspace.client, {
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title: `History agent ${workspace.workspaceName}`,
        });
      }
      await useMacKeyboardShortcuts(page);
      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      for (const workspace of [firstWorkspace, secondWorkspace, thirdWorkspace]) {
        await switchWorkspaceViaSidebar({ page, serverId, workspaceId: workspace.workspaceId });
        await expectHistoryWorkspace(page, workspace);
        await waitForWorkspaceTabsVisible(page);
      }

      await goBackTwiceWithoutWaitingForRender(page);
      await expectHistoryWorkspace(page, firstWorkspace);
      await page.goForward();
      await expectHistoryWorkspace(page, secondWorkspace);
      await page.goForward();
      await expectHistoryWorkspace(page, thirdWorkspace);

      await page.goBack();
      await expectHistoryWorkspace(page, secondWorkspace);
      await page.keyboard.press("Meta+[");
      await expectHistoryWorkspace(page, firstWorkspace);
      await page.keyboard.press("Meta+]");
      await expectHistoryWorkspace(page, secondWorkspace);
      await clickMouseHistoryButton(page, "forward");
      await expectHistoryWorkspace(page, thirdWorkspace);
      await clickMouseHistoryButton(page, "back");
      await expectHistoryWorkspace(page, secondWorkspace);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectHistoryWorkspace(page, firstWorkspace);
      await page.goBack();
      await expectHistoryWorkspace(page, secondWorkspace);
      await page.goForward();
      await expectHistoryWorkspace(page, firstWorkspace);

      const session = await page.context().newCDPSession(page);
      try {
        const history = await session.send("Page.getNavigationHistory");
        expect(history.currentIndex).toBe(history.entries.length - 1);
      } finally {
        await session.detach();
      }
      await expectWorkspaceDeckEntryCount(page, 3);
    } finally {
      await thirdWorkspace.cleanup();
      await secondWorkspace.cleanup();
      await firstWorkspace.cleanup();
    }
  });

  test("traverses settings history and returns without duplicate workspace decks", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "history-settings-" });
    try {
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Settings history agent",
      });
      await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.workspaceId));
      await expectHistoryWorkspace(page, workspace);
      await expectWorkspaceTabVisible(page, agent.id);

      await openSettings(page);
      await openSettingsSection(page, "appearance");
      await openSettingsSection(page, "chat");
      await page.goBack();
      await expectAppRoute(page, "/settings/appearance");
      await page.goBack();
      await expectAppRoute(page, "/settings/general");
      await page.goBack();
      await expectHistoryWorkspace(page, workspace);
      await expectWorkspaceDeckEntryCount(page, 1);

      await page.goForward();
      await expectAppRoute(page, "/settings/general");
      await page.goForward();
      await expectAppRoute(page, "/settings/appearance");
      await page.goForward();
      await expectAppRoute(page, "/settings/chat");
      await clickSettingsBackToWorkspace(page);
      await expectHistoryWorkspace(page, workspace);
      await expectWorkspaceTabVisible(page, agent.id);
      await expectWorkspaceDeckEntryCount(page, 1);

      await page.goBack();
      await expectAppRoute(page, "/settings/chat");
      await page.goForward();
      await expectHistoryWorkspace(page, workspace);
      await expectWorkspaceDeckEntryCount(page, 1);
    } finally {
      await workspace.cleanup();
    }
  });

  test("restores agent tab history within a workspace and preserves forward after reload", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "history-agent-tabs-" });
    try {
      const firstAgent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "First history tab",
      });
      const secondAgent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Second history tab",
      });
      const thirdAgent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Legacy link history tab",
      });
      await useMacKeyboardShortcuts(page);
      await openWorkspaceWithAgents(page, [firstAgent, secondAgent]);
      const firstTab = page.getByTestId(`workspace-tab-agent_${firstAgent.id}`).filter({
        visible: true,
      });
      const secondTab = page.getByTestId(`workspace-tab-agent_${secondAgent.id}`).filter({
        visible: true,
      });
      await firstTab.click({ position: { x: 12, y: 13 } });
      await expect(firstTab).toHaveAttribute("aria-selected", "true");
      await secondTab.click({ position: { x: 12, y: 13 } });
      await expect(secondTab).toHaveAttribute("aria-selected", "true");

      await page.keyboard.press("Meta+[");
      await expect(firstTab).toHaveAttribute("aria-selected", "true");
      await expect(secondTab).toHaveAttribute("aria-selected", "false");
      await expectHistoryWorkspace(page, workspace);
      await page.keyboard.press("Meta+]");
      await expect(secondTab).toHaveAttribute("aria-selected", "true");
      await page.goBack();
      await expect(firstTab).toHaveAttribute("aria-selected", "true");

      await page.reload();
      await waitForSidebarHydration(page);
      await expectHistoryWorkspace(page, workspace);
      await expect(firstTab).toHaveAttribute("aria-selected", "true");
      await page.goForward();
      await expect(secondTab).toHaveAttribute("aria-selected", "true");
      await expect(firstTab).toHaveAttribute("aria-selected", "false");
      await expectHistoryWorkspace(page, workspace);
      await expectWorkspaceDeckEntryCount(page, 1);

      const thirdTab = page.getByTestId(`workspace-tab-agent_${thirdAgent.id}`).filter({
        visible: true,
      });
      await test.step("legacy open links create one canonical history entry", async () => {
        await openWorkspaceTabUrl(
          page,
          buildHostWorkspaceOpenRoute(
            getServerId(),
            workspace.workspaceId,
            `agent:${thirdAgent.id}`,
          ),
        );
        await expect(thirdTab).toHaveAttribute("aria-selected", "true");
        await expectHistoryWorkspace(page, workspace);
        await page.goBack();
        await expect(secondTab).toHaveAttribute("aria-selected", "true");
        await page.goForward();
        await expect(thirdTab).toHaveAttribute("aria-selected", "true");
        await expectHistoryWorkspace(page, workspace);
      });

      await test.step("consecutive pop events restore the final tab without overwriting history", async () => {
        await goBackTwiceWithoutWaitingForRender(page);
        await expect(firstTab).toHaveAttribute("aria-selected", "true");
        await expect(thirdTab).toHaveAttribute("aria-selected", "false");
        await page.goForward();
        await expect(secondTab).toHaveAttribute("aria-selected", "true");
      });

      await test.step("a closed history target keeps the surviving tab and later navigation usable", async () => {
        await firstTab.hover();
        await closeWorkspaceAgentTab(page, firstAgent.id);
        await expect(secondTab).toHaveAttribute("aria-selected", "true");
        await page.goBack();
        await expectWorkspaceTabHidden(page, firstAgent.id);
        await expect(secondTab).toHaveAttribute("aria-selected", "true");
        await expectHistoryWorkspace(page, workspace);

        await openSettings(page);
        await page.goBack();
        await expectHistoryWorkspace(page, workspace);
        await expect(secondTab).toHaveAttribute("aria-selected", "true");
        await page.goForward();
        await expectAppRoute(page, "/settings/general");
        await clickSettingsBackToWorkspace(page);
        await expectHistoryWorkspace(page, workspace);
        await expectWorkspaceTabHidden(page, firstAgent.id);
        await expectWorkspaceDeckEntryCount(page, 1);
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("removes a foreign pinned agent when restoring a saved workspace layout", async ({
    page,
  }, testInfo) => {
    const serverId = getServerId();
    const firstWorkspace = await seedWorkspace({
      repoPrefix: "workspace-owner-",
      title: "Original workspace",
    });
    const secondWorkspace = await seedWorkspace({
      repoPrefix: "workspace-restored-",
      title: "Restored workspace",
    });
    try {
      const firstAgent = await createMockIdleAgent(firstWorkspace.client, {
        cwd: firstWorkspace.repoPath,
        workspaceId: firstWorkspace.workspaceId,
        title: "Original workspace agent",
      });
      const secondAgent = await createMockIdleAgent(secondWorkspace.client, {
        cwd: secondWorkspace.repoPath,
        workspaceId: secondWorkspace.workspaceId,
        title: "Restored workspace agent",
      });
      await gotoAppShell(page);
      await openWorkspaceWithAgents(page, [firstAgent, secondAgent]);
      await seedForeignPinnedAgentTab(page, {
        serverId,
        workspaceId: secondWorkspace.workspaceId,
        agentId: firstAgent.id,
      });

      await page.reload();
      await waitForSidebarHydration(page);
      await waitForWorkspaceTabsVisible(page);
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: secondWorkspace.projectDisplayName,
      });
      await testInfo.attach("hydrated-workspace", {
        body: await page.screenshot({ path: testInfo.outputPath("hydrated-workspace.png") }),
        contentType: "image/png",
      });
      await expectAgentAbsentFromWorkspaceLayout(page, {
        serverId,
        workspaceId: secondWorkspace.workspaceId,
        agentId: firstAgent.id,
      });
      await expectOnlyWorkspaceAgentTabsVisible(page, [secondAgent.id]);
      await testInfo.attach("restored-workspace", {
        body: await page.screenshot({ path: testInfo.outputPath("restored-workspace.png") }),
        contentType: "image/png",
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await waitForWorkspaceTabsVisible(page);
      await expectOnlyWorkspaceAgentTabsVisible(page, [firstAgent.id]);
      const agents = await firstWorkspace.client.fetchAgents();
      expect(
        agents.entries.find(({ agent }) => agent.id === firstAgent.id)?.agent.workspaceId,
      ).toBe(firstWorkspace.workspaceId);
      expect(
        agents.entries.find(({ agent }) => agent.id === secondAgent.id)?.agent.workspaceId,
      ).toBe(secondWorkspace.workspaceId);
      await testInfo.attach("original-workspace", {
        body: await page.screenshot({ path: testInfo.outputPath("original-workspace.png") }),
        contentType: "image/png",
      });
    } finally {
      await secondWorkspace.cleanup();
      await firstWorkspace.cleanup();
    }
  });

  test("keeps an offline notification on the agent route until the host connects", async ({
    page,
  }) => {
    const target = {
      serverId: "notification-offline-host",
      workspaceId: "notification-workspace",
      agentId: "notification-agent",
    };

    await gotoAppShell(page);
    await addOfflineHostAndReload(page, {
      serverId: target.serverId,
      label: "Notification Host",
    });
    await expect(
      page.getByTestId("sidebar-settings").filter({ visible: true }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });

    await page.evaluate((data) => {
      globalThis.dispatchEvent(
        new CustomEvent("paseo:web-notification-click", {
          detail: { data: { ...data, reason: "finished" } },
          cancelable: true,
        }),
      );
    }, target);

    await expectAppRoute(page, buildHostAgentDetailRoute(target.serverId, target.agentId), {
      timeout: 30_000,
    });
    await expect(page.getByTestId("agent-route-waiting-for-host")).toBeVisible();
    await expect(page.getByText(/Notification Host/).first()).toBeVisible();
  });

  test("cold agent targets hydrate their workspace without opening the compact sidebar", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "notification-cold-compact-" });
    try {
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Cold notification agent",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await gotoAppShell(page);
      await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id));
      await expectAppRoute(page, buildHostWorkspaceRoute(getServerId(), workspace.workspaceId), {
        timeout: 30_000,
      });
      await expectComposerVisible(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("shows the New launcher after returning from settings and closing the last agent draft tab", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "workspace-settings-back-tab-" });

    await workspace.navigateTo();
    await clickNewChat(page);
    await expect.poll(() => getVisibleDraftTabCount(page), { timeout: 30_000 }).toBe(1);

    await openSettings(page);
    await clickSettingsBackToWorkspace(page);
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    await expect.poll(() => getVisibleDraftTabCount(page), { timeout: 30_000 }).toBe(1);

    await closeFirstVisibleDraftTab(page);

    await expect.poll(() => getVisibleDraftTabCount(page), { timeout: 30_000 }).toBe(0);
    await expect(
      page
        .getByTestId("workspace-new-tab-panel")
        .getByRole("button", { name: "Agent", exact: true }),
    ).toBeVisible();
  });

  test("keeps the workspace rendered while reconnecting to the host", async ({ page }) => {
    const serverId = getServerId();

    const daemonGate = await installDaemonWebSocketGate(page);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-reconnect-" });

    try {
      const agent = await createMockIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `workspace-reconnect-${Date.now()}`,
      });

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId));
      await page.waitForURL(
        (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
        { timeout: 60_000 },
      );
      await expectWorkspaceHeader(page, {
        title: workspace.workspaceName,
        subtitle: workspace.projectDisplayName,
      });
      await waitForWorkspaceTabsVisible(page);
      await expectWorkspaceTabVisible(page, agent.id);
      // The reconnect toast belongs to the visible agent panel, which mounts
      // after the tab strip. Drop the connection only after that panel is ready.
      await expectComposerVisible(page);

      await daemonGate.drop();
      await daemonGate.waitForBlockedConnection();
      await expectReconnectingToastVisible(page);
      await expectWorkspaceHeader(page, {
        title: workspace.workspaceName,
        subtitle: workspace.projectDisplayName,
      });
      await waitForWorkspaceTabsVisible(page);
      await expectComposerVisible(page);
      await expectNoLoadingPane(page);

      const monitorReconnect = expectNoLoadingWorkspacePane(page, {
        label: "host reconnect",
      });
      daemonGate.restore();
      await expectReconnectingToastGone(page);
      await monitorReconnect;
      await expectWorkspaceHeader(page, {
        title: workspace.workspaceName,
        subtitle: workspace.projectDisplayName,
      });
      await waitForWorkspaceTabsVisible(page);
      await expectComposerVisible(page);
    } finally {
      daemonGate.restore();
      await workspace.cleanup();
    }
  });

  test("does not show reconnecting for an inactive host workspace", async ({ page }) => {
    const secondaryHost = await startIsolatedHostDaemon("inactive-reconnecting-host");
    const primaryWorkspace = await seedWorkspace({ repoPrefix: "active-reconnecting-host-" });
    const secondaryWorkspace = await seedWorkspace({
      repoPrefix: "inactive-reconnecting-host-",
      port: secondaryHost.port,
    });

    try {
      await Promise.all([
        createMockIdleAgent(primaryWorkspace.client, {
          cwd: primaryWorkspace.repoPath,
          workspaceId: primaryWorkspace.workspaceId,
          title: "Active host agent",
        }),
        createMockIdleAgent(secondaryWorkspace.client, {
          cwd: secondaryWorkspace.repoPath,
          workspaceId: secondaryWorkspace.workspaceId,
          title: "Inactive host agent",
        }),
      ]);

      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryHost.serverId,
        label: "Inactive host",
        port: secondaryHost.port,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId: secondaryHost.serverId,
        workspaceId: secondaryWorkspace.workspaceId,
      });
      await switchWorkspaceViaSidebar({
        page,
        serverId: secondaryHost.serverId,
        workspaceId: secondaryWorkspace.workspaceId,
      });
      await waitForWorkspaceTabsVisible(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId: getServerId(),
        workspaceId: primaryWorkspace.workspaceId,
      });
      await waitForWorkspaceTabsVisible(page);

      await secondaryHost.close();
      await page.waitForTimeout(1_500);

      await expectReconnectingToastGone(page, { timeout: 100 });
    } finally {
      await secondaryHost.close();
      await secondaryWorkspace.cleanup();
      await primaryWorkspace.cleanup();
    }
  });

  test("cold offline workspace route gates the screen interior but keeps settings reachable", async ({
    page,
  }) => {
    const serverId = getServerId();

    await page.routeWebSocket(daemonWsRoutePattern(), async (ws) => {
      await ws.close({ code: 1008, reason: "Blocked cold offline workspace route test." });
    });

    await page.goto(buildHostWorkspaceRoute(serverId, "/tmp/paseo-missing-workspace"));

    await expectHostConnectingOrOffline(page);
    await expectMenuButtonVisible(page);
    await expectWorkspaceHeaderAbsent(page);
    await expectWorkspaceTabsAbsent(page);
    await openSettings(page);
    await expect(page).toHaveURL(/\/settings\/general$/);
  });

  test("cold workspace URL keeps sidebar workspace navigation functional", async ({ page }) => {
    const serverId = getServerId();

    const firstWorkspace = await seedWorkspace({ repoPrefix: "workspace-cold-url-a-" });
    const secondWorkspace = await seedWorkspace({ repoPrefix: "workspace-cold-url-b-" });

    try {
      await page.goto(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId));
      await waitForSidebarHydration(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId), {
        timeout: 30_000,
      });

      const secondRow = page.getByTestId(
        `sidebar-workspace-row-${serverId}:${secondWorkspace.workspaceId}`,
      );
      await expect(secondRow).toBeVisible({ timeout: 30_000 });
      await secondRow.click();

      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, secondWorkspace.workspaceId), {
        timeout: 30_000,
      });
    } finally {
      await secondWorkspace.cleanup();
      await firstWorkspace.cleanup();
    }
  });

  test("a stale notification workspace preserves retained workspace selection and tabs", async ({
    page,
  }) => {
    const serverId = getServerId();

    const firstWorkspace = await seedWorkspace({ repoPrefix: "workspace-nav-reg-a-" });
    const secondWorkspace = await seedWorkspace({ repoPrefix: "workspace-nav-reg-b-" });

    try {
      const firstAgent = await createMockIdleAgent(firstWorkspace.client, {
        cwd: firstWorkspace.repoPath,
        workspaceId: firstWorkspace.workspaceId,
        title: `workspace-nav-a-${Date.now()}`,
      });
      const secondAgent = await createMockIdleAgent(secondWorkspace.client, {
        cwd: secondWorkspace.repoPath,
        workspaceId: secondWorkspace.workspaceId,
        title: `workspace-nav-b-${Date.now()}`,
      });

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openWorkspaceWithAgents(page, [firstAgent, secondAgent]);

      const firstDeckEntry = workspaceDeckEntryLocator(page, serverId, firstWorkspace.workspaceId);
      const secondDeckEntry = workspaceDeckEntryLocator(
        page,
        serverId,
        secondWorkspace.workspaceId,
      );

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: secondWorkspace.workspaceId,
        selected: false,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
      await expectWorkspaceTabVisible(page, firstAgent.id);
      await expectWorkspaceTabHidden(page, secondAgent.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [firstAgent.id]);
      await expect(getVisibleWorkspaceAgentTabIds(page)).resolves.toEqual([
        `workspace-tab-agent_${firstAgent.id}`,
      ]);
      await expect(firstDeckEntry).toBeVisible({ timeout: 30_000 });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, secondWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
        selected: false,
      });
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: secondWorkspace.projectDisplayName,
      });
      await expectWorkspaceTabVisible(page, secondAgent.id);
      await expectWorkspaceTabHidden(page, firstAgent.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [secondAgent.id]);
      await expect(getVisibleWorkspaceAgentTabIds(page)).resolves.toEqual([
        `workspace-tab-agent_${secondAgent.id}`,
      ]);
      await expect(firstDeckEntry).toBeAttached();
      await expect(firstDeckEntry).toBeHidden();
      await expect(secondDeckEntry).toBeVisible({ timeout: 30_000 });
      await expectWorkspaceDeckEntryCount(page, 2);

      await page.evaluate(
        ({ agentId, serverId: targetServerId, workspaceId }) => {
          globalThis.dispatchEvent(
            new CustomEvent("paseo:web-notification-click", {
              detail: {
                data: {
                  serverId: targetServerId,
                  workspaceId,
                  agentId,
                  reason: "finished",
                },
              },
              cancelable: true,
            }),
          );
        },
        { agentId: secondAgent.id, serverId, workspaceId: firstWorkspace.workspaceId },
      );
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, secondWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expect(secondDeckEntry).toBeVisible({ timeout: 30_000 });
      await expectWorkspaceTabVisible(page, secondAgent.id);
      await expectWorkspaceTabHidden(page, firstAgent.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [secondAgent.id]);
      await expect(firstDeckEntry).toBeAttached();
      await expect(firstDeckEntry).toBeHidden();
      await expectWorkspaceDeckEntryCount(page, 2);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expect(firstDeckEntry).toBeVisible({ timeout: 30_000 });
      await expect(secondDeckEntry).toBeAttached();
      await expect(secondDeckEntry).toBeHidden();
      await expectWorkspaceDeckEntryCount(page, 2);

      await expectAgentAbsentFromWorkspaceLayout(page, {
        serverId,
        workspaceId: firstWorkspace.workspaceId,
        agentId: secondAgent.id,
      });
      await openWorkspaceTabUrl(
        page,
        buildHostWorkspaceOpenRoute(serverId, firstWorkspace.workspaceId, `agent:${firstAgent.id}`),
      );
      await expectWorkspaceTabVisible(page, firstAgent.id);
      await expectAgentAbsentFromWorkspaceLayout(page, {
        serverId,
        workspaceId: secondWorkspace.workspaceId,
        agentId: firstAgent.id,
      });

      await page.reload();
      await waitForSidebarHydration(page);
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
      await expectWorkspaceTabVisible(page, firstAgent.id);
      await expectWorkspaceTabHidden(page, secondAgent.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [firstAgent.id]);
      await expect(getVisibleWorkspaceAgentTabIds(page)).resolves.toEqual([
        `workspace-tab-agent_${firstAgent.id}`,
      ]);
    } finally {
      await secondWorkspace.cleanup();
      await firstWorkspace.cleanup();
    }
  });
});
