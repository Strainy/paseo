import { useEffect } from "react";

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * public/index.html sizes an iOS Home Screen app's document to the screen, past the layout
 * viewport WebKit reports, so the document can scroll by the status-bar height. Focus and
 * keyboard reveals scroll into that range and `overflow: hidden` leaves no way back.
 */
export function useStandaloneScrollReset(): void {
  useEffect(() => {
    if (!window.matchMedia("(display-mode: standalone)").matches) return undefined;
    return installDocumentScrollReset(window);
  }, []);
}

/**
 * Returns the document to the top whenever it scrolls while no text field holds the
 * keyboard, so a keyboard reveal keeps its scroll until the field loses focus.
 */
export function installDocumentScrollReset(target: Window): () => void {
  let frame: number | null = null;
  const reset = () => {
    if (holdsKeyboard(target.document.activeElement)) return;
    if (target.scrollX !== 0 || target.scrollY !== 0) target.scrollTo(0, 0);
  };
  // Focus moving between two text fields passes through the body; check where it lands.
  const resetOnceFocusLands = () => {
    if (frame !== null) target.cancelAnimationFrame(frame);
    frame = target.requestAnimationFrame(() => {
      frame = null;
      reset();
    });
  };
  target.addEventListener("scroll", reset, { passive: true });
  target.addEventListener("focusout", resetOnceFocusLands);
  return () => {
    if (frame !== null) target.cancelAnimationFrame(frame);
    target.removeEventListener("scroll", reset);
    target.removeEventListener("focusout", resetOnceFocusLands);
  };
}

function holdsKeyboard(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}
