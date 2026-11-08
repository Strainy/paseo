import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDocumentScrollReset } from "./use-standalone-scroll-reset.web";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settle(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

describe("document scroll reset", () => {
  let dispose: () => void;
  let field: HTMLTextAreaElement;
  let spacer: HTMLDivElement;

  beforeEach(() => {
    field = document.createElement("textarea");
    spacer = document.createElement("div");
    spacer.style.height = "4000px";
    document.body.append(field, spacer);
    dispose = installDocumentScrollReset(window);
  });

  afterEach(() => {
    dispose();
    field.remove();
    spacer.remove();
    window.scrollTo(0, 0);
  });

  it("returns a scrolled document to the top", async () => {
    window.scrollTo(0, 40);
    await settle();

    expect(window.scrollY).toBe(0);
  });

  it("keeps a reveal's scroll while a text field has focus and returns once it blurs", async () => {
    field.focus({ preventScroll: true });
    window.scrollTo(0, 40);
    await settle();
    expect(window.scrollY).toBe(40);

    field.blur();
    await settle();

    expect(window.scrollY).toBe(0);
  });

  it("leaves the document alone once disposed", async () => {
    dispose();
    window.scrollTo(0, 40);
    await settle();

    expect(window.scrollY).toBe(40);
  });
});
