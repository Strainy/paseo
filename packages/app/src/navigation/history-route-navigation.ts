import {
  getActionFromState,
  type LinkingOptions,
  type NavigationContainerRef,
  type NavigationAction,
  type NavigationState,
  type PartialState,
} from "expo-router/react-navigation";

function retainedRoutePops(
  state: NavigationState | PartialState<NavigationState> | undefined,
  routeKey: string,
): NavigationAction[] | null {
  if (!state) return null;

  for (const [index, route] of state.routes.entries()) {
    const childPops = route.key === routeKey ? [] : retainedRoutePops(route.state, routeKey);
    if (!childPops) continue;

    const count = (state.index ?? state.routes.length - 1) - index;
    if (state.type === "stack" && state.key && count > 0) {
      return [{ type: "POP", target: state.key, payload: { count } }, ...childPops];
    }
    return childPops;
  }

  return null;
}

function withNestedPop(params: object | undefined): object | undefined {
  if (!params || !("screen" in params) || typeof params.screen !== "string") return params;

  const nestedParams = "params" in params ? params.params : undefined;
  return {
    ...params,
    pop: true,
    params:
      nestedParams && typeof nestedParams === "object" ? withNestedPop(nestedParams) : nestedParams,
  };
}

/** Replay visits through retained screens so plugin drafts survive global-route hops. */
export function navigateToHistoryRoute(
  href: string,
  navigation: Pick<
    NavigationContainerRef<ReactNavigation.RootParamList>,
    "dispatch" | "getRootState"
  >,
  linking: LinkingOptions<ReactNavigation.RootParamList> | undefined,
  routeKey?: string,
): void {
  if (!linking?.getStateFromPath) {
    throw new Error("Browser history requires Expo Router linking");
  }
  const state = linking.getStateFromPath(href, linking.config);
  const action = state ? getActionFromState(state, linking.config) : undefined;
  if (!action || action.type !== "NAVIGATE") {
    throw new Error(`Cannot navigate to history route: ${href}`);
  }

  // Same-name plugin screens can have distinct drafts. Reveal the visited instance
  // before NAVIGATE updates its params, which may differ since the visit was saved.
  if (routeKey) {
    for (const pop of retainedRoutePops(navigation.getRootState(), routeKey) ?? []) {
      navigation.dispatch(pop);
    }
  }

  navigation.dispatch({
    ...action,
    payload: {
      ...action.payload,
      // Native getActionFromState marks navigators, but leaves the final screen unset.
      pop: true,
      params: withNestedPop(action.payload.params),
    },
  });
}
