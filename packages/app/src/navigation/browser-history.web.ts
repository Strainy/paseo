import {
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceRouteFromPathname,
  stripHostWorkspaceRouteEchoSearch,
} from "@/utils/host-routes";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";

export interface HistoryView {
  href: string;
  tabId: string | null;
  routeKey?: string;
}

export function canonicalHistoryHref(href: string): string {
  const url = new URL(stripHostWorkspaceRouteEchoSearch(href), window.location.href);
  // COMPAT(workspace-open-url): added in v0.12.0, remove after 2027-01-22.
  // The workspace consumes this handoff; it must not replay on Back or reload.
  if (/^\/h\/[^/]+\/workspace\//.test(url.pathname)) url.searchParams.delete("open");
  const agent = parseHostAgentRouteFromPathname(url.pathname);
  if (agent && url.searchParams.get("agentId") === agent.agentId)
    url.searchParams.delete("agentId");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function isCurrentHistoryRoute(href: string, routeHref: string): boolean {
  const url = new URL(href, window.location.href);
  // An incoming legacy handoff must reach the route even when its canonical URL matches.
  if (/^\/h\/[^/]+\/workspace\//.test(url.pathname) && url.searchParams.has("open")) return false;
  return canonicalHistoryHref(href) === canonicalHistoryHref(routeHref);
}

export function isHistoryDestination(href: string, compact: boolean): boolean {
  const pathname = href.split(/[?#]/)[0];
  if (pathname === "/") return false;
  if (!compact && pathname === "/settings") return false;
  if (/^\/settings\/hosts\/[^/]+\/?$/.test(pathname)) return false;
  if (/^\/h\/[^/]+(?:\/?|\/(?:open-project|sessions|settings)\/?)$/.test(pathname)) {
    return false;
  }
  return true;
}

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function readView(): HistoryView {
  const href = currentHref();
  const saved = window.history.state?.paseoView;
  const matches = saved?.href === canonicalHistoryHref(href);
  return {
    href,
    tabId: matches && typeof saved.tabId === "string" ? saved.tabId : null,
    ...(matches && typeof saved.routeKey === "string" ? { routeKey: saved.routeKey } : {}),
  };
}

/** The browser owns the stack, including forward truncation and reload persistence. */
export function createBrowserHistory(
  navigate: (view: HistoryView, complete: (view: HistoryView) => void) => void,
  getNavigationRevision: () => number = () => 0,
) {
  let current: HistoryView | null = null;
  let pending: { revision: number } | null = null;

  function commit(view: HistoryView) {
    view = { ...view, href: canonicalHistoryHref(view.href) };
    const resolvingAgent = current && parseHostAgentRouteFromPathname(current.href);
    const workspace = parseHostWorkspaceRouteFromPathname(view.href);
    const replacing =
      !current ||
      pending !== null ||
      (current.href === view.href && !current.tabId) ||
      (current.href === view.href &&
        current.tabId === view.tabId &&
        current.routeKey !== view.routeKey) ||
      (resolvingAgent &&
        workspace?.serverId === resolvingAgent.serverId &&
        view.tabId ===
          buildDeterministicWorkspaceTabId({ kind: "agent", agentId: resolvingAgent.agentId }));
    pending = null;
    if (current?.href === view.href && (current.tabId === view.tabId || !view.tabId) && !replacing)
      return;
    if (replacing) {
      window.history.replaceState({ ...window.history.state, paseoView: view }, "", view.href);
    } else {
      window.history.pushState({ paseoView: view }, "", view.href);
    }
    current = view;
  }

  function replay(view = readView()) {
    const intent = { revision: getNavigationRevision() };
    pending = intent;
    // Keep the incoming URL intact until the router has consumed legacy handoffs.
    navigate(view, (restored) => {
      if (pending === intent) commit(restored);
    });
  }

  const onPopState = () => replay();
  window.addEventListener("popstate", onPopState);

  return {
    restore(href: string) {
      const saved = readView();
      if (canonicalHistoryHref(saved.href) === canonicalHistoryHref(href) && saved.tabId)
        replay(saved);
    },
    record(view: HistoryView, navigationRevision?: number) {
      // React can still flush an effect for the previous route after popstate.
      // A real navigator commit, including a redirect, settles the replay. Its
      // destination need not equal the requested route.
      if (pending && navigationRevision !== undefined && navigationRevision <= pending.revision)
        return;
      commit(view);
    },
    dispose() {
      pending = null;
      window.removeEventListener("popstate", onPopState);
    },
  };
}
