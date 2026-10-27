import { useEffect, useRef, useState } from "react";
import { router, useNavigationContainerRef, useUnstableGlobalHref, type Href } from "expo-router";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  findPaneById,
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { navigateToHostWorkspaceRoute } from "./workspace-route-navigation";
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
) {
  const workspace = parseHostWorkspaceRouteFromPathname(view.href);
  if (workspace && view.tabId) {
    // A closed tab keeps the surviving selection; history never resurrects resources.
    revealWorkspaceTab(`${workspace.serverId}:${workspace.workspaceId}`, view.tabId);
  }
  if (isCurrentHistoryRoute(view.href, currentHref)) {
    // Tab focus is synchronous and may be a no-op, so no route event is needed.
    complete({ href: view.href, tabId: selectedTab(view.href) });
  } else if (workspace) {
    navigateToHostWorkspaceRoute(view.href);
  } else {
    router.replace(view.href as Href);
  }
}

export function useBrowserHistory(): void {
  const routeHref = useUnstableGlobalHref();
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
      (view, complete) => restoreView(view, currentHrefRef.current, complete),
      () => revisionRef.current,
    );
    historyRef.current = history;
    history.restore(initialHrefRef.current);
    return () => {
      unsubscribe();
      history.dispose();
      historyRef.current = null;
    };
  }, [hydrated, navigation]);

  useEffect(() => {
    if (!isHistoryDestination(href, compact)) return;
    // Restoring a tab can synchronously change the store before this effect runs.
    historyRef.current?.record({ href, tabId: selectedTab(href) }, navigationRevision);
  }, [href, tabId, compact, hydrated, navigationRevision]);
}
