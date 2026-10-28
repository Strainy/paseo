import { router } from "expo-router";
import { isWeb } from "@/constants/platform";

export function goBack(): void {
  if (isWeb) window.history.back();
  else router.back();
}

export function goForward(): void {
  if (isWeb) window.history.forward();
}
