import type { ReactNode } from "react";

/** Android publishes the system insets unchanged; see the web file. */
export function HomeScreenSafeAreaInsets({ children }: { children: ReactNode }) {
  return children;
}
