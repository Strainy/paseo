import type { ReactNode } from "react";
import { HomeScreenSafeAreaInsets } from "./home-screen-insets";

export { useWindowLayout } from "./context";
export { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
export { WindowLayoutSurface, WindowLayoutDivisionGap } from "./surface";
export {
  resolveDesktopDivisionLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
} from "./model";
export type { DesktopDivisionLayout, WindowLayout, WindowLayoutRect } from "./model";

export function WindowLayoutProvider({ children }: { children: ReactNode }) {
  return <HomeScreenSafeAreaInsets>{children}</HomeScreenSafeAreaInsets>;
}
