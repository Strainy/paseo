import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import {
  resolveVisibleSurfaceFrame,
  type ComposerSlotFrame,
  type VisibleViewport,
} from "./capacity";

/** The editing region of a composer; see the native file for the keyboard contract. */
export function ComposerFullscreenBody({
  fullscreen,
  children,
}: {
  fullscreen: boolean;
  children: ReactNode;
}) {
  return <View style={fullscreen ? styles.fullscreen : styles.inline}>{children}</View>;
}

export function ComposerFullscreenFooter({ children, ...props }: ViewProps) {
  return <View {...props}>{children}</View>;
}

/**
 * Where a fullscreen composer sits, in layout-viewport coordinates for a fixed box: the
 * part of the dock surface the browser's visible viewport shows. A mobile browser
 * keyboard shrinks or pans that viewport without resizing the page, so the frame
 * follows it instead of the layout.
 */
export function useFullscreenSlotFrame(input: {
  active: boolean;
  surfaceRef: RefObject<View | null>;
  surfaceSize: { width: number; height: number } | undefined;
  safeAreaBottom: number;
}): ComposerSlotFrame | undefined {
  const { active, surfaceRef, surfaceSize, safeAreaBottom } = input;
  const [frame, setFrame] = useState<ComposerSlotFrame>();
  useLayoutEffect(() => {
    if (!active) {
      setFrame(undefined);
      return;
    }
    const update = () => {
      const surface = surfaceRef.current as unknown as HTMLElement | null;
      if (!surface) return;
      setFrame(
        resolveVisibleSurfaceFrame(
          surface.getBoundingClientRect(),
          readVisibleViewport(),
          safeAreaBottom,
        ),
      );
    };
    const visualViewport = window.visualViewport;
    update();
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active, surfaceRef, surfaceSize, safeAreaBottom]);
  return frame;
}

/**
 * An iOS Home Screen web app reports a viewport short by the status bar while
 * public/index.html sizes the app to the screen, so there an unobscured viewport does not
 * bound the surface.
 */
function readVisibleViewport(): VisibleViewport {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const height = viewport?.height ?? window.innerHeight;
  const unobscured = top <= 0 && (viewport?.scale ?? 1) <= 1 && height >= window.innerHeight;
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return {
    top,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: unobscured && standalone ? Number.POSITIVE_INFINITY : height,
    unobscured,
  };
}

const styles = StyleSheet.create({
  inline: { flexShrink: 1 },
  fullscreen: { flex: 1, minHeight: 0 },
});
