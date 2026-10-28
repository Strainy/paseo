/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalHistoryHref,
  createBrowserHistory,
  isHistoryDestination,
  isCurrentHistoryRoute,
  type HistoryView,
} from "./browser-history.web";

const workspace = "/h/host/workspace/one";
let history: ReturnType<typeof createBrowserHistory>;

async function traverse(delta: number) {
  const popped = new Promise<void>((resolve) =>
    window.addEventListener("popstate", () => resolve(), { once: true }),
  );
  window.history.go(delta);
  await popped;
}

beforeEach(() => {
  window.history.replaceState({ other: "preserved" }, "", workspace);
});

afterEach(() => history?.dispose());

describe("browser history", () => {
  it("uses the browser stack for routes and tabs, preserving forward entries on replay", async () => {
    const navigate = vi.fn((view: HistoryView) => history.record(view));
    history = createBrowserHistory(navigate);
    const first = { href: workspace, tabId: "agent-a" };
    const second = { href: workspace, tabId: "agent-b" };
    const third = { href: "/settings/general", tabId: null };
    history.record(first);
    expect(window.history.state.other).toBe("preserved");
    const length = window.history.length;
    history.record(first);
    history.record(second);
    history.record(third);
    expect(window.history.length).toBe(length + 2);

    await traverse(-1);
    expect(navigate).toHaveBeenLastCalledWith(second, expect.any(Function));
    await traverse(-1);
    expect(navigate).toHaveBeenLastCalledWith(first, expect.any(Function));
    await traverse(2);
    expect(navigate).toHaveBeenLastCalledWith(third, expect.any(Function));
    expect(window.history.length).toBe(length + 2);
  });

  it("discards forward entries when a new destination is visited", async () => {
    history = createBrowserHistory((view) => history.record(view));
    history.record({ href: workspace, tabId: "a" });
    const length = window.history.length;
    history.record({ href: "/settings/general", tabId: null });
    history.record({ href: "/settings/appearance", tabId: null });
    await traverse(-2);
    history.record({ href: "/sessions", tabId: null });
    expect(window.history.length).toBe(length + 1);
    await traverse(-1);
    expect(window.location.pathname).toBe(workspace);
    await traverse(1);
    expect(window.location.pathname).toBe("/sessions");
  });

  it("restores saved tab selection after remount without adding entries", async () => {
    history = createBrowserHistory((view) => history.record(view));
    history.record({ href: workspace, tabId: "a" });
    history.record({ href: workspace, tabId: "b" });
    await traverse(-1);
    history.dispose();
    const navigate = vi.fn((view: HistoryView) => history.record(view));
    history = createBrowserHistory(navigate);
    const length = window.history.length;
    history.restore(workspace);
    expect(navigate).toHaveBeenLastCalledWith(
      { href: workspace, tabId: "a" },
      expect.any(Function),
    );
    await traverse(1);
    expect(navigate).toHaveBeenLastCalledWith(
      { href: workspace, tabId: "b" },
      expect.any(Function),
    );
    expect(window.history.length).toBe(length);
  });

  it("ignores intermediate route commits while replay is pending", async () => {
    const navigate = vi.fn();
    history = createBrowserHistory(navigate, () => 1);
    history.record({ href: workspace, tabId: "a" });
    history.record({ href: "/settings/general", tabId: null });
    await traverse(-1);
    history.record({ href: "/settings/general", tabId: null }, 1);
    expect(window.location.pathname).toBe(workspace);
    history.record({ href: workspace, tabId: "a" }, 2);
    await traverse(1);
    expect(navigate).toHaveBeenLastCalledWith(
      { href: "/settings/general", tabId: null },
      expect.any(Function),
    );
  });

  it("replaces redirect destinations instead of losing the forward stack", async () => {
    history = createBrowserHistory((view) => {
      if (isHistoryDestination(view.href, false)) history.record(view);
    });
    history.record({ href: workspace, tabId: "a" });
    window.history.pushState(null, "", "/h/host");
    window.dispatchEvent(new PopStateEvent("popstate"));
    history.record({ href: "/open-project", tabId: null });
    await traverse(-1);
    expect(window.location.pathname).toBe(workspace);
  });

  it("settles a replay at a newer navigation revision even when it redirects elsewhere", async () => {
    history = createBrowserHistory(vi.fn(), () => 4);
    history.record({ href: workspace, tabId: "a" });
    history.record({ href: "/settings/general", tabId: null });
    await traverse(-1);
    const length = window.history.length;
    history.record({ href: "/open-project", tabId: null }, 5);
    expect(window.location.pathname).toBe("/open-project");
    expect(window.history.length).toBe(length);
    history.record({ href: "/sessions", tabId: null }, 6);
    await traverse(-1);
    expect(window.location.pathname).toBe("/open-project");
  });

  it("explicitly settles a no-op replay of a closed tab with the surviving selection", async () => {
    history = createBrowserHistory((view, complete) => complete({ ...view, tabId: "survivor" }));
    history.record({ href: workspace, tabId: "closed" });
    history.record({ href: workspace, tabId: "survivor" });
    await traverse(-1);
    expect(window.history.state.paseoView).toEqual({ href: workspace, tabId: "survivor" });
    history.record({ href: "/settings/general", tabId: null });
    await traverse(-1);
    expect(window.location.pathname).toBe(workspace);
  });

  it("ignores completion of a superseded replay", async () => {
    const completions: Array<(view: HistoryView) => void> = [];
    history = createBrowserHistory(
      (_view, complete) => completions.push(complete),
      () => 1,
    );
    history.record({ href: workspace, tabId: "a" });
    history.record({ href: workspace, tabId: "b" });
    history.record({ href: workspace, tabId: "c" });
    const length = window.history.length;
    await traverse(-1);
    await traverse(-1);
    completions[0]({ href: workspace, tabId: "b" });
    completions[1]({ href: workspace, tabId: "a" });
    expect(window.history.state.paseoView.tabId).toBe("a");
    expect(window.history.length).toBe(length);
    await traverse(1);
    expect(window.history.state.paseoView.tabId).toBe("b");
  });

  it("delivers incoming legacy handoffs before canonicalizing the browser entry", () => {
    const incoming = `${workspace}?open=agent%3Anew&filter=active#details`;
    const navigate = vi.fn((_view: HistoryView, complete: (view: HistoryView) => void) => {
      expect(window.location.search).toContain("open=");
      complete({ href: incoming, tabId: "new" });
    });
    history = createBrowserHistory(navigate);
    window.history.pushState(null, "", incoming);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(navigate.mock.calls[0][0].href).toBe(incoming);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      `${workspace}?filter=active#details`,
    );
  });

  it("does not add entries for initial tab hydration or transient loss of focus", () => {
    history = createBrowserHistory(vi.fn());
    history.record({ href: workspace, tabId: null });
    const length = window.history.length;
    history.record({ href: workspace, tabId: "a" });
    history.record({ href: workspace, tabId: null });
    expect(window.history.length).toBe(length);
    expect(window.history.state.paseoView).toEqual({ href: workspace, tabId: "a" });
  });

  it("records an offline agent destination and replaces it when its workspace resolves", async () => {
    history = createBrowserHistory((view) => history.record(view));
    history.record({ href: "/open-project", tabId: null });
    const length = window.history.length;
    history.record({ href: "/h/host/agent/a", tabId: null });
    expect(window.location.pathname).toBe("/h/host/agent/a");
    expect(window.history.length).toBe(length + 1);
    history.record({ href: workspace, tabId: "agent_a" });
    expect(window.location.pathname).toBe(workspace);
    expect(window.history.length).toBe(length + 1);
    await traverse(-1);
    expect(window.location.pathname).toBe("/open-project");
    await traverse(1);
    expect(window.location.pathname).toBe(workspace);
  });

  it("keeps an offline agent destination when visiting settings to manage its host", async () => {
    history = createBrowserHistory((view) => history.record(view));
    history.record({ href: "/h/host/agent/a", tabId: null });
    history.record({ href: "/settings/hosts/host/host", tabId: null });
    await traverse(-1);
    expect(window.location.pathname).toBe("/h/host/agent/a");
  });

  it("keeps an offline agent destination when choosing a different workspace tab", async () => {
    history = createBrowserHistory((view) => history.record(view));
    history.record({ href: "/h/host/agent/a", tabId: null });
    history.record({ href: workspace, tabId: "agent_other" });
    await traverse(-1);
    expect(window.location.pathname).toBe("/h/host/agent/a");
  });

  it("restores the retained navigator route key for visits with the same route name", async () => {
    const navigate = vi.fn((view: HistoryView) => history.record(view));
    history = createBrowserHistory(navigate);
    const first = { href: "/plugin/bot?bot=2", tabId: null, routeKey: "bot-two" };
    const second = { href: "/plugin/bot?bot=1", tabId: null, routeKey: "bot-one" };
    history.record(first);
    history.record(second);
    await traverse(-1);
    expect(navigate).toHaveBeenLastCalledWith(first, expect.any(Function));
  });
});

describe("history destinations", () => {
  it("keeps meaningful query strings and hashes while removing workspace handoff params", () => {
    expect(
      canonicalHistoryHref(
        `${workspace}?serverId=host&workspaceId=one&pop=true&open=agent%3Aa&filter=active#details`,
      ),
    ).toBe(`${workspace}?filter=active#details`);
    expect(canonicalHistoryHref("/sessions?search=one#details")).toBe(
      "/sessions?search=one#details",
    );
  });

  it.each(["/", "/h/host", "/h/host/settings", "/h/host/sessions", "/settings/hosts/host"])(
    "excludes redirect %s",
    (href) => {
      expect(isHistoryDestination(href, false)).toBe(false);
    },
  );

  it("includes agent routes that can wait for an offline host", () => {
    expect(isHistoryDestination("/h/host/agent/a", false)).toBe(true);
    expect(canonicalHistoryHref("/h/host/agent/a?agentId=a")).toBe("/h/host/agent/a");
  });

  it("restores tabs locally when only internal workspace query echoes differ", () => {
    expect(
      isCurrentHistoryRoute(workspace, `${workspace}?serverId=host&workspaceId=one&pop=true`),
    ).toBe(true);
    expect(
      isCurrentHistoryRoute(
        `${workspace}?filter=active#details`,
        `${workspace}?pop=true&filter=active#details`,
      ),
    ).toBe(true);
    expect(isCurrentHistoryRoute(`${workspace}?filter=active`, workspace)).toBe(false);
    expect(isCurrentHistoryRoute(`${workspace}#details`, workspace)).toBe(false);
  });

  it("routes incoming legacy handoffs despite an equal canonical workspace URL", () => {
    expect(isCurrentHistoryRoute(`${workspace}?open=agent%3Anew`, workspace)).toBe(false);
    expect(
      isCurrentHistoryRoute(`${workspace}?open=agent%3Anew`, `${workspace}?open=agent%3Anew`),
    ).toBe(false);
  });

  it("records the compact settings index, which is a page on phones", () => {
    expect(isHistoryDestination("/settings", false)).toBe(false);
    expect(isHistoryDestination("/settings", true)).toBe(true);
    expect(isHistoryDestination("/settings/general", false)).toBe(true);
  });
});
