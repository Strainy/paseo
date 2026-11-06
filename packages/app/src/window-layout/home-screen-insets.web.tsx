import { useMemo, useState, type ReactNode } from "react";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { resolveHomeScreenTopInset } from "./model";

/** The top inset every surface of an installed web app reads through `useSafeAreaInsets()`. */
export function HomeScreenSafeAreaInsets({ children }: { children: ReactNode }) {
  const systemInsets = useSafeAreaInsets();
  const [isHomeScreenApp] = useState(() => window.matchMedia("(display-mode: standalone)").matches);
  const insets = useMemo(
    () =>
      isHomeScreenApp
        ? { ...systemInsets, top: resolveHomeScreenTopInset(systemInsets.top) }
        : systemInsets,
    [isHomeScreenApp, systemInsets],
  );
  return <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>;
}
