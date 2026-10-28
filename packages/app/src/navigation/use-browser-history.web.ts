import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigationContainerRef, useRootNavigationState } from "expo-router";
import { findFocusedRoute, LinkingContext } from "expo-router/react-navigation";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  findPaneById,
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { navigateToHostWorkspaceRoute } from "./workspace-route-navigation";
import { navigateToHistoryRoute } from "./history-route-navigation";
import {
  canonicalHistoryHref,
  createBrowserHistory,
  isHistoryDestination,
  isCurrentHistoryRoute,
  type HistoryView,
} from "./browser-history.web";

function selectedTab(href: string): string | null {
  const workspace = parseHostWorkspaceRouteFromPathname(href);
  const layout = workspace
    ? useWorkspaceLayoutStore.getState().layoutByWorkspace[
        `${workspace.serverId}:${workspace.workspaceId}`
      ]
    : undefined;
  return layout ? (findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null) : null;
}

function restoreView(
  view: HistoryView,
  currentHref: string,
  complete: (view: HistoryView) => void,
  navigate: (view: HistoryView) => void,
) {
  const workspace = parseHostWorkspaceRouteFromPathname(view.href);
  if (workspace && view.tabId) {
    // A closed tab keeps the surviving selection; history never resurrects resources.
    revealWorkspaceTab(`${workspace.serverId}:${workspace.workspaceId}`, view.tabId);
  }
  if (isCurrentHistoryRoute(view.href, currentHref)) {
    // Tab focus is synchronous and may be a no-op, so no route event is needed.
    complete({ ...view, tabId: selectedTab(view.href) });
  } else if (workspace) {
    navigateToHostWorkspaceRoute(view.href);
  } else {
    navigate(view);
  }
}

export function useBrowserHistory(): void {
  const { options: linking } = useContext(LinkingContext);
  const rootState = useRootNavigationState();
  // Global href merges stale ancestor params; the configured serializer uses
  // the focused route's search params, matching Expo's normal browser URLs.
  const routeHref = useMemo(() => {
    if (!linking?.getPathFromState) {
      throw new Error("Browser history requires Expo Router linking");
    }
    return linking.getPathFromState(rootState, linking.config);
  }, [linking, rootState]);
  const href = canonicalHistoryHref(routeHref);
  const compact = useIsCompactFormFactor();
  const hydrated = useWorkspaceLayoutStoreHydrated();
  const navigation = useNavigationContainerRef();
  const [navigationRevision, setNavigationRevision] = useState(0);
  const revisionRef = useRef(0);
  const currentHrefRef = useRef(routeHref);
  currentHrefRef.current = routeHref;
  const workspace = parseHostWorkspaceRouteFromPathname(href);
  const workspaceKey = workspace ? `${workspace.serverId}:${workspace.workspaceId}` : null;
  const tabId = useWorkspaceLayoutStore((state) => {
    const layout = workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined;
    return layout ? (findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null) : null;
  });
  const historyRef = useRef<ReturnType<typeof createBrowserHistory> | null>(null);
  const initialHrefRef = useRef(routeHref);

  useEffect(() => {
    if (!hydrated) return;
    // React Navigation emits this after committing state. Unlike pathname equality,
    // it also acknowledges redirects and navigation that supersedes a replay.
    const unsubscribe = navigation.addListener("state", () => {
      revisionRef.current += 1;
      setNavigationRevision(revisionRef.current);
    });
    const history = createBrowserHistory(
      (view, complete) =>
        restoreView(view, currentHrefRef.current, complete, (destination) =>
          navigateToHistoryRoute(destination.href, navigation, linking, destination.routeKey),
        ),
      () => revisionRef.current,
    );
    historyRef.current = history;
    history.restore(initialHrefRef.current);
    return () => {
      unsubscribe();
      history.dispose();
      historyRef.current = null;
    };
  }, [hydrated, navigation, linking]);

  useEffect(() => {
    if (!isHistoryDestination(href, compact)) return;
    // Restoring a tab can synchronously change the store before this effect runs.
    // Read the committed route key; Expo's render snapshot can still be partial at cold mount.
    historyRef.current?.record(
      {
        href,
        tabId: selectedTab(href),
        routeKey: findFocusedRoute(navigation.getRootState())?.key,
      },
      navigationRevision,
    );
  }, [href, tabId, compact, hydrated, navigationRevision, navigation]);
}
