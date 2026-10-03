import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "./render";

// The client components only need a router/pathname to exist while they render once on the server.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/",
}));

import { SiteHeader } from "@/components/site-header";

const KILL_SWITCH = "PUBLIC_REFRESH_ENABLED";
const original = process.env[KILL_SWITCH];

afterEach(() => {
  if (original === undefined) delete process.env[KILL_SWITCH];
  else process.env[KILL_SWITCH] = original;
});

/** Offsets of the header's landmarks in document order (= Tab order). */
function order(html: string) {
  const at = (needle: string | RegExp) => {
    const i = typeof needle === "string" ? html.indexOf(needle) : html.search(needle);
    expect(i, String(needle)).toBeGreaterThanOrEqual(0);
    return i;
  };
  return {
    brand: at('aria-label="نبض البحرين — الصفحة الرئيسية"'),
    nav: at('aria-label="التنقل الرئيسي"'),
    search: at('role="search"'),
    refreshButtons: [...html.matchAll(/<button[^>]*aria-busy|<button[^>]*title="[^"]*(?:تحديث|التحقق)/g)].map((m) => m.index ?? -1),
  };
}

describe("SiteHeader (R5-09 c: Tab order matches the drawn order)", () => {
  it("lists brand, refresh, nav, search, refresh in the DOM, and shows the first refresh below lg only", () => {
    delete process.env[KILL_SWITCH];
    const html = render(createElement(SiteHeader));
    const o = order(html);

    // Phone and tablet draw brand, refresh, nav, search; the desktop row draws brand, nav, search, refresh.
    // Flex `order`/grid placement cannot change Tab order, so the DOM is that order and the button is
    // rendered twice, each copy shown at one breakpoint (display: none also removes it from Tab).
    expect(html.match(/<div class="justify-self-end lg:hidden">/g)).toHaveLength(1);
    expect(html.match(/<div class="hidden lg:block">/g)).toHaveLength(1);
    const lowRefresh = html.indexOf('<div class="justify-self-end lg:hidden">');
    const highRefresh = html.indexOf('<div class="hidden lg:block">');
    expect(o.brand).toBeLessThan(lowRefresh);
    expect(lowRefresh).toBeLessThan(o.nav);
    expect(o.nav).toBeLessThan(o.search);
    expect(o.search).toBeLessThan(highRefresh);
  });

  it("uses no flex `order-*` classes (they reorder only visually)", () => {
    const html = render(createElement(SiteHeader));
    expect(html).not.toMatch(/class="[^"]*\border-\d/);
    expect(html).not.toMatch(/class="[^"]*\b(?:sm|lg):order-\d/);
  });

  it("hides the whole header on paper", () => {
    expect(render(createElement(SiteHeader))).toMatch(/<header class="[^"]*print:hidden/);
  });
});

describe("SiteHeader (R5-09 d: the kill switch is decided on the server)", () => {
  it("renders no refresh button at all when PUBLIC_REFRESH_ENABLED=0", () => {
    process.env[KILL_SWITCH] = "0";
    const html = render(createElement(SiteHeader));
    expect(html).not.toContain('<button type="button"');
    expect(html).not.toContain("lg:hidden");
    expect(html).not.toContain("hidden lg:block");
    expect(order(html).refreshButtons).toHaveLength(0);
    // the rest of the header is intact
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="التنقل الرئيسي"');
  });

  it("renders the button copies when it is enabled", () => {
    delete process.env[KILL_SWITCH];
    const html = render(createElement(SiteHeader));
    expect(html.match(/<button type="button"/g)?.length).toBe(2);
  });
});
