import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { test as base, expect } from "../support/fixtures";
import { expectWorkspaceTabVisible } from "../support/helpers/archive-tab";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { openTabSwitcher, selectTabFromSwitcher, tapSheetBackdrop } from "../support/helpers/sheet";

interface FinishedAgents {
  workspace: MockAgentWorkspace;
  firstAgentId: string;
  secondAgentId: string;
}

const test = base.extend<{ agents: FinishedAgents }>({
  agents: async ({ browserName: _browserName }, provide) => {
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "workspace-agent-tab-mark-unread-",
      title: "First agent",
      initialPrompt: "Finish this turn.",
    });
    try {
      const second = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        title: "Second agent",
        modeId: "load-test",
        model: "e2e-fast-stream",
        initialPrompt: "Finish this turn.",
      });
      await workspace.client.waitForFinish(workspace.agentId, 20_000);
      await workspace.client.waitForFinish(second.id, 20_000);
      await workspace.client.clearWorkspaceAttention(workspace.workspaceId);
      await provide({ workspace, firstAgentId: workspace.agentId, secondAgentId: second.id });
    } finally {
      await workspace.cleanup();
    }
  },
});

interface SessionRequest {
  type?: string;
  requestId?: string;
  agentId?: string | string[];
}

function sessionRequest(message: string | Buffer): SessionRequest | null {
  try {
    const envelope = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
    return envelope?.type === "session" ? (envelope.message as SessionRequest) : null;
  } catch {
    return null;
  }
}

/** Proxies the browser's daemon socket, recording attention clears and rejecting marks on demand. */
async function interceptDaemonSocket(page: Page) {
  const clearedAgentIds: string[] = [];
  let nextMarkRejection: string | null = null;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser: WebSocketRoute) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const request = sessionRequest(message);
      if (request?.type === "clear_agent_attention" && request.agentId) {
        clearedAgentIds.push(...[request.agentId].flat());
      }
      if (nextMarkRejection && request?.type === "agent.mark_unread.request") {
        const error = nextMarkRejection;
        nextMarkRejection = null;
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "agent.mark_unread.response",
              payload: {
                requestId: request.requestId,
                agentId: request.agentId,
                accepted: false,
                error,
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
  return {
    clearedAgentIds: () => [...clearedAgentIds],
    rejectNextMark(error: string) {
      nextMarkRejection = error;
    },
  };
}

function agentTab(page: Page, agentId: string): Locator {
  return page.getByTestId(`workspace-tab-agent_${agentId}`).filter({ visible: true }).first();
}

function attentionIndicator(row: Locator): Locator {
  return row.getByTestId("workspace-tab-status-indicator-attention");
}

async function expectUnread(row: Locator, unread: boolean) {
  if (unread) {
    await expect(attentionIndicator(row)).toBeVisible({ timeout: 15_000 });
  } else {
    await expect(attentionIndicator(row)).toHaveCount(0, { timeout: 15_000 });
  }
}

async function selectTab(page: Page, agentId: string) {
  const tab = agentTab(page, agentId);
  // The close action overlays the chip's trailing edge on hover; click the leading icon instead.
  await tab.click({ position: { x: 12, y: 13 } });
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

async function chooseMarkUnread(page: Page, agentId: string) {
  await agentTab(page, agentId).click({ button: "right" });
  const item = page.getByTestId(`workspace-tab-context-agent_${agentId}-mark-unread`);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
}

async function markTabUnread(page: Page, agentId: string) {
  await chooseMarkUnread(page, agentId);
  await expectUnread(agentTab(page, agentId), true);
}

async function expectNoMarkUnreadAction(page: Page, agentId: string) {
  await agentTab(page, agentId).click({ button: "right" });
  await expect(page.getByTestId(`workspace-tab-context-agent_${agentId}`)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId(`workspace-tab-context-agent_${agentId}-mark-unread`)).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
}

function switcherRow(page: Page, agentId: string): Locator {
  return page.getByTestId(`workspace-tab-option-agent_${agentId}`);
}

async function markSwitcherRowUnread(page: Page, agentId: string) {
  const menuBase = `workspace-tab-menu-agent_${agentId}`;
  await page.getByTestId(`${menuBase}-trigger`).click();
  await page.getByTestId(`${menuBase}-mark-unread`).click();
  // The actions sheet closes and leaves the switcher open.
  await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(1);
  await expectUnread(switcherRow(page, agentId), true);
}

async function closeTabSwitcher(page: Page) {
  await tapSheetBackdrop(page);
  await expect(page.getByRole("button", { name: "Bottom sheet backdrop" })).toHaveCount(0);
}

test("marks a finished agent tab unread until the tab is opened again", async ({
  page,
  agents,
}) => {
  test.setTimeout(120_000);
  const { workspace, firstAgentId, secondAgentId } = agents;
  expect(workspace.client.getLastServerInfoMessage()?.features?.agentMarkUnread).toBe(true);
  const socket = await interceptDaemonSocket(page);

  await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: firstAgentId });
  await expectWorkspaceTabVisible(page, firstAgentId);
  await expectWorkspaceTabVisible(page, secondAgentId);
  await expect(agentTab(page, firstAgentId)).toHaveAttribute("aria-selected", "true");
  await expectUnread(agentTab(page, secondAgentId), false);

  await test.step("a background tab keeps the mark until it is opened", async () => {
    await markTabUnread(page, secondAgentId);
    await expectNoMarkUnreadAction(page, secondAgentId);
    await selectTab(page, secondAgentId);
    await expectUnread(agentTab(page, secondAgentId), false);
  });

  await test.step("the active tab keeps the mark when the user switches away", async () => {
    const clearsBefore = socket.clearedAgentIds().length;
    await markTabUnread(page, secondAgentId);
    await selectTab(page, firstAgentId);
    // This mark leaves on the same socket after any clear the switch sent.
    await markTabUnread(page, firstAgentId);
    expect(socket.clearedAgentIds().slice(clearsBefore)).not.toContain(secondAgentId);
    await expectUnread(agentTab(page, secondAgentId), true);
    await selectTab(page, secondAgentId);
    await expectUnread(agentTab(page, secondAgentId), false);
    await expectUnread(agentTab(page, firstAgentId), true);
  });

  await test.step("a rejected mark shows the error and the user can retry", async () => {
    socket.rejectNextMark("Injected mark unread failure.");
    await chooseMarkUnread(page, secondAgentId);
    await expect(
      page.getByTestId("app-toast-message").filter({ hasText: "Injected mark unread failure." }),
    ).toBeVisible();
    await expectUnread(agentTab(page, secondAgentId), false);
    await markTabUnread(page, secondAgentId);
  });
});

test("marks the active agent unread from the compact tab switcher", async ({ page, agents }) => {
  test.setTimeout(120_000);
  const { workspace, firstAgentId, secondAgentId } = agents;
  const socket = await interceptDaemonSocket(page);
  const firstRow = switcherRow(page, firstAgentId);
  const secondRow = switcherRow(page, secondAgentId);

  await page.setViewportSize({ width: 390, height: 844 });
  await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: firstAgentId });
  await expect(page.getByTestId("workspace-tab-switcher-trigger")).toBeVisible({
    timeout: 30_000,
  });

  await test.step("the mark survives closing the switcher", async () => {
    await openTabSwitcher(page);
    await expectUnread(firstRow, false);
    await markSwitcherRowUnread(page, firstAgentId);
    await closeTabSwitcher(page);
    await openTabSwitcher(page);
    await expectUnread(firstRow, true);
    await closeTabSwitcher(page);
  });

  await test.step("the mark survives switching to another tab", async () => {
    const clearsBefore = socket.clearedAgentIds().length;
    await selectTabFromSwitcher(page, "Second agent");
    await openTabSwitcher(page);
    // This mark leaves on the same socket after any clear the switch sent.
    await markSwitcherRowUnread(page, secondAgentId);
    expect(socket.clearedAgentIds().slice(clearsBefore)).not.toContain(firstAgentId);
    await expectUnread(firstRow, true);
    await closeTabSwitcher(page);
  });

  await test.step("touching the chat reads the active agent again", async () => {
    await page.getByRole("textbox", { name: "Message agent..." }).click();
    await openTabSwitcher(page);
    await expectUnread(secondRow, false);
    await expectUnread(firstRow, true);
  });
});
