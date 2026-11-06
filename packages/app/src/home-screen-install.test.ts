import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A sign-in proxy refuses the requests a phone makes while adding a Home Screen icon,
// because they carry no session. The page has to install without them.
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function linkTag(rel: string): string {
  const tag = indexHtml.match(new RegExp(`<link\\s+rel="${rel}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`index.html has no <link rel="${rel}">`);
  return tag;
}

describe("Home Screen install behind a sign-in proxy", () => {
  it("inlines the touch icon so iOS needs no request for it", () => {
    const icon = readFileSync(new URL("../public/apple-touch-icon.png", import.meta.url));
    const tag = linkTag("apple-touch-icon");

    expect(tag).toContain('sizes="180x180"');
    expect(tag).toContain(`href="data:image/png;base64,${icon.toString("base64")}"`);
  });

  it("sends the sign-in with the manifest request", () => {
    expect(linkTag("manifest")).toContain('crossorigin="use-credentials"');
  });

  it("names the app and launches it full screen without the manifest", () => {
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="Paseo" />');
  });
});
