export interface WindowLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowLayout {
  bounds: WindowLayoutRect;
  verticalBarEdge: "none" | "leading" | "trailing";
  verticalBar: WindowLayoutRect | null;
  /**
   * Points from the window's bottom edge to where a bottom bar rests, or null where
   * the system has no bottom bar guide. Zero is a measured value.
   */
  bottomClearance?: number | null;
  divisions: WindowLayoutRect[];
}

/** The window's measured bottom clearance replaces the rectangular safe-area bottom. */
export function resolveSafeAreaInsets<Insets extends { bottom: number }>(
  systemInsets: Insets,
  layout: WindowLayout | null,
): Insets {
  const clearance = layout?.bottomClearance;
  return typeof clearance === "number" && clearance !== systemInsets.bottom
    ? { ...systemInsets, bottom: clearance }
    : systemInsets;
}

/** iPhones with a notch or Dynamic Island report a status-bar inset at least this tall. */
const CUTOUT_STATUS_BAR_INSET = 44;
/** How far the status-bar safe area reaches below the notch or Dynamic Island. */
const CUTOUT_CLEARANCE = 10;

/**
 * An installed iPhone web app starts its content at the bottom of the notch or Dynamic
 * Island, not at the bottom of the status-bar safe area. Shorter insets come from status
 * bars without a cutout and stay whole.
 */
export function resolveHomeScreenTopInset(top: number): number {
  return top >= CUTOUT_STATUS_BAR_INSET ? top - CUTOUT_CLEARANCE : top;
}

export interface DesktopDivisionLayout {
  sidebarWidth: number;
  gap: number;
  contentWidth: number;
}

export function resolveWorkspaceActionPlacement(
  layout: WindowLayout | null,
): "header" | "vertical-bar" {
  return layout?.verticalBarEdge === "trailing" && layout.verticalBar !== null
    ? "vertical-bar"
    : "header";
}

export function resolveWorkspaceBarActions(
  headerVariant: "compact" | "full",
): readonly ("tab-count" | "overflow" | "explorer")[] {
  return headerVariant === "compact"
    ? ["tab-count", "overflow", "explorer"]
    : ["overflow", "explorer"];
}

/** One book-like partition owns allocation; horizontal folds retain the normal flow. */
export function resolveDesktopDivisionLayout(input: {
  geometry: WindowLayout | null;
  windowWidth: number;
  windowHeight: number;
  leftInset: number;
  rightInset: number;
}): DesktopDivisionLayout | null {
  const { geometry, windowWidth, windowHeight, leftInset, rightInset } = input;
  if (
    !geometry ||
    Math.abs(geometry.bounds.width - windowWidth) > 0.5 ||
    Math.abs(geometry.bounds.height - windowHeight) > 0.5
  )
    return null;
  const divisions = geometry.divisions.filter(
    (frame) =>
      frame.width > 0 &&
      frame.height > frame.width &&
      frame.y < windowHeight &&
      frame.y + frame.height > 0,
  );
  if (divisions.length !== 1) return null;
  const division = divisions[0];
  const sidebarWidth = division.x - leftInset;
  const contentWidth = windowWidth - rightInset - division.x - division.width;
  if (sidebarWidth <= 0 || contentWidth <= 0) return null;
  return { sidebarWidth, gap: division.width, contentWidth };
}
