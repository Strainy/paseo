import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationContainerRefWithCurrent } from "expo-router/react-navigation";
import {
  StackRouter,
  type LinkingOptions,
  type NavigationAction,
  type NavigationState,
  type ParamListBase,
  type PartialState,
  type StackNavigationState,
} from "expo-router/react-navigation";
import { navigateToHistoryRoute } from "./history-route-navigation";
import {
  navigateToHostWorkspaceRoute,
  registerWorkspaceRouteNavigationRef,
} from "./workspace-route-navigation";

// Load the real reducers without the public barrel's native screen components.
vi.mock("expo-router/react-navigation", async () => {
  const [actions, routers] = await Promise.all([
    import("expo-router/build/react-navigation/core/getActionFromState"),
    import("expo-router/build/react-navigation/routers/StackRouter"),
  ]);
  return { getActionFromState: actions.getActionFromState, StackRouter: routers.StackRouter };
});

function createNavigationRef(rootState: unknown, options: { ready?: boolean } = {}) {
  const dispatch = vi.fn();
  let ready = options.ready ?? true;
  const readyListeners = new Set<() => void>();
  const navigation = {
    isReady: () => ready,
    getRootState: () => rootState,
    dispatch,
    addListener: (event: string, listener: () => void) => {
      if (event === "ready") readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
  };
  const navigationRef = {
    ...navigation,
    current: navigation,
  } as unknown as NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>;

  return {
    navigationRef,
    dispatch,
    becomeReady() {
      ready = true;
      for (const listener of readyListeners) listener();
    },
  };
}

describe("navigateToHistoryRoute", () => {
  const pluginScreen = "plugin/[pluginId]/[contributionKind]/[contributionId]";
  const hostScreen = "h/[serverId]";
  const router = StackRouter({});

  function stack(routes: StackNavigationState<ParamListBase>["routes"], key: string) {
    const options = {
      routeNames: [...new Set(routes.map((route) => route.name))],
      routeParamList: {},
      routeGetIdList: {},
    };
    const state: StackNavigationState<ParamListBase> = {
      key,
      stale: false,
      type: "stack",
      index: routes.length - 1,
      routeNames: options.routeNames,
      routes,
      preloadedRoutes: [],
    };
    return { state, options };
  }

  function linkingTo(
    routes: PartialState<NavigationState>["routes"],
  ): LinkingOptions<ReactNavigation.RootParamList> {
    return { prefixes: [], getStateFromPath: () => ({ routes }) };
  }

  type ReplayAction = Extract<
    Parameters<typeof router.getStateForAction>[1],
    { type: "POP" | "NAVIGATE" }
  >;

  function isReplayAction(action: NavigationAction): action is ReplayAction {
    if (!action.payload) return false;
    return (
      (action.type === "POP" &&
        "count" in action.payload &&
        typeof action.payload.count === "number") ||
      (action.type === "NAVIGATE" &&
        "name" in action.payload &&
        typeof action.payload.name === "string")
    );
  }

  function reduce(current: ReturnType<typeof stack>, action: ReplayAction) {
    const next = router.getStateForAction(current.state, action, current.options);
    if (!next) throw new Error(`Stack did not handle ${action.type}`);
    current.state = router.getRehydratedState(next, current.options);
  }

  it("reveals the exact retained host and same-name plugin instance before applying params", () => {
    const host = stack(
      [
        { key: "bot-2-draft", name: pluginScreen, params: { "param.botId": "bot-2" } },
        { key: "bot-1-draft", name: pluginScreen, params: { "param.botId": "bot-1" } },
      ],
      "host-stack",
    );
    const root = stack(
      [
        { key: "retained-host", name: hostScreen, state: host.state },
        { key: "other-host", name: hostScreen },
        { key: "settings", name: "settings/[section]" },
      ],
      "root-stack",
    );
    const dispatch = vi.fn((action: NavigationAction) => {
      if (!isReplayAction(action)) throw new Error(`Unexpected action: ${action.type}`);
      if (action.type !== "POP") return;
      if (action.target === root.state.key) {
        reduce(root, action);
      } else if (action.target === host.state.key) {
        reduce(host, action);
      }
    });

    navigateToHistoryRoute(
      "/h/server/plugin/bots/surface/bot?param.botId=bot-2",
      { dispatch, getRootState: () => root.state },
      linkingTo([
        {
          name: hostScreen,
          params: { serverId: "server" },
          state: { routes: [{ name: pluginScreen, params: { "param.botId": "bot-2" } }] },
        },
      ]),
      "bot-2-draft",
    );

    expect(root.state.routes.map((route) => route.key)).toEqual(["retained-host"]);
    expect(host.state.routes.map((route) => route.key)).toEqual(["bot-2-draft"]);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["POP", "POP", "NAVIGATE"]);
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "NAVIGATE",
      payload: {
        name: hostScreen,
        path: undefined,
        pop: true,
        params: expect.objectContaining({ screen: pluginScreen, pop: true }),
      },
    });
  });

  it.each(["current-draft", "missing-after-reload"])(
    "applies historical query params when the saved key is %s",
    (routeKey) => {
      const current = stack(
        [{ key: "current-draft", name: pluginScreen, params: { "param.botId": "bot-1" } }],
        "host-stack",
      );
      const dispatch = vi.fn((action: NavigationAction) => {
        if (!isReplayAction(action)) throw new Error(`Unexpected action: ${action.type}`);
        reduce(current, action);
      });

      navigateToHistoryRoute(
        "/h/server/plugin/bots/surface/bot?param.botId=bot-2",
        { dispatch, getRootState: () => current.state },
        linkingTo([{ name: pluginScreen, params: { "param.botId": "bot-2" } }]),
        routeKey,
      );

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(current.state.routes).toHaveLength(1);
      expect(current.state.routes[0]).toMatchObject({
        key: "current-draft",
        params: { "param.botId": "bot-2" },
      });
    },
  );
});

describe("navigateToHostWorkspaceRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerWorkspaceRouteNavigationRef(createNavigationRef({}).navigationRef)();
  });

  it("falls back to route navigation when no host route is mounted yet", () => {
    const { navigationRef, dispatch } = createNavigationRef({
      key: "root-stack",
      routeNames: ["index", "settings/[section]", "h/[serverId]"],
      routes: [{ key: "settings-general", name: "settings/[section]" }],
    });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });

    expect(dispatch).not.toHaveBeenCalled();
    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
  });

  it("pops to the mounted host route and targets the requested workspace", () => {
    const { navigationRef, dispatch } = createNavigationRef({
      key: "root-stack",
      index: 1,
      routeNames: ["index", "settings/[section]", "h/[serverId]"],
      routes: [
        {
          key: "host-server-1",
          name: "h/[serverId]",
          params: { serverId: "server-1" },
        },
        { key: "settings-general", name: "settings/[section]" },
      ],
    });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });

    expect(dismissTo).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "POP_TO",
      target: "root-stack",
      payload: {
        name: "h/[serverId]",
        params: {
          serverId: "server-1",
          screen: "workspace/[workspaceId]/index",
          params: {
            serverId: "server-1",
            workspaceId: "workspace-a",
          },
          pop: true,
        },
      },
    });
  });

  it("uses route navigation when the mounted host route is already focused", () => {
    const { navigationRef, dispatch } = createNavigationRef({
      key: "root-stack",
      index: 0,
      routes: [
        {
          key: "host-server-1",
          name: "h/[serverId]",
          params: { serverId: "server-1" },
        },
      ],
    });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-b", { dismissTo });

    expect(dispatch).not.toHaveBeenCalled();
    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-b");
  });

  it("preserves a workspace open intent in the POP_TO target", () => {
    const { navigationRef, dispatch } = createNavigationRef({
      key: "root-stack",
      index: 1,
      routes: [
        { key: "host-server-1", name: "h/[serverId]" },
        { key: "new", name: "new" },
      ],
    });
    registerWorkspaceRouteNavigationRef(navigationRef);

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a?open=agent%3Aagent-1");

    expect(dispatch).toHaveBeenCalledWith({
      type: "POP_TO",
      target: "root-stack",
      payload: {
        name: "h/[serverId]",
        params: {
          serverId: "server-1",
          screen: "workspace/[workspaceId]/index",
          params: {
            serverId: "server-1",
            workspaceId: "workspace-a",
            open: "agent:agent-1",
          },
          pop: true,
        },
      },
    });
  });

  it("waits for the root navigator before applying a route intent", () => {
    const { navigationRef, becomeReady } = createNavigationRef(
      {
        key: "root-stack",
        routes: [{ key: "launcher", name: "index" }],
      },
      { ready: false },
    );
    registerWorkspaceRouteNavigationRef(navigationRef);
    const dismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });
    expect(dismissTo).not.toHaveBeenCalled();

    becomeReady();
    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
    becomeReady();
    expect(dismissTo).toHaveBeenCalledTimes(1);
  });

  it("retains an intent submitted before the root ref registers", () => {
    const dismissTo = vi.fn();
    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });
    expect(dismissTo).not.toHaveBeenCalled();

    const root = createNavigationRef({}, { ready: false });
    const unregister = registerWorkspaceRouteNavigationRef(root.navigationRef);
    expect(dismissTo).not.toHaveBeenCalled();
    root.becomeReady();
    expect(dismissTo).toHaveBeenCalledExactlyOnceWith("/h/server-1/workspace/workspace-a");
    unregister();
  });

  it("keeps only the latest route intent while the root navigator is unavailable", () => {
    const { navigationRef, becomeReady } = createNavigationRef({}, { ready: false });
    registerWorkspaceRouteNavigationRef(navigationRef);
    const firstDismissTo = vi.fn();
    const latestDismissTo = vi.fn();

    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", {
      dismissTo: firstDismissTo,
    });
    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-b", {
      dismissTo: latestDismissTo,
    });
    becomeReady();

    expect(firstDismissTo).not.toHaveBeenCalled();
    expect(latestDismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-b");
  });

  it("preserves a pending route intent across root navigator re-registration", () => {
    const first = createNavigationRef({}, { ready: false });
    const unregisterFirst = registerWorkspaceRouteNavigationRef(first.navigationRef);
    const dismissTo = vi.fn();
    navigateToHostWorkspaceRoute("/h/server-1/workspace/workspace-a", { dismissTo });

    unregisterFirst();
    first.becomeReady();
    expect(dismissTo).not.toHaveBeenCalled();

    const replacement = createNavigationRef({
      key: "root-stack",
      routes: [{ key: "launcher", name: "index" }],
    });
    registerWorkspaceRouteNavigationRef(replacement.navigationRef);

    expect(dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
  });
});
