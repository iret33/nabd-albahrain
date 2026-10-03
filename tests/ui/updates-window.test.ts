import { describe, expect, it } from "vitest";
import { parseUpdateWindow, parseUpdatesParams, updatesHref, windowDays } from "@/lib/updates-window";

describe("updates window", () => {
  it("accepts only the offered windows, everything else is all-time", () => {
    expect(parseUpdateWindow("7")).toBe("7");
    expect(parseUpdateWindow("30")).toBe("30");
    expect(parseUpdateWindow("90")).toBe("90");
    expect(parseUpdateWindow(" 30 ")).toBe("30");
    for (const bad of ["", "all", "1", "365", "30d", "-7", "7.5", "1e1", "abc", undefined, null, ["bogus"], []]) {
      expect(parseUpdateWindow(bad as never)).toBe("all");
    }
  });

  it("takes the first value of a repeated param (?days=7&days=90)", () => {
    expect(parseUpdateWindow(["7", "90"])).toBe("7");
  });

  it("maps a window to the day count the data layer wants", () => {
    expect(windowDays("all")).toBeNull();
    expect(windowDays("30")).toBe(30);
  });

  it("builds hrefs with only non-default params", () => {
    expect(updatesHref("all")).toBe("/updates");
    expect(updatesHref("all", 1)).toBe("/updates");
    expect(updatesHref("30")).toBe("/updates?days=30");
    expect(updatesHref("all", 3)).toBe("/updates?page=3");
    expect(updatesHref("90", 12)).toBe("/updates?days=90&page=12");
  });

  it("never emits a nonsense page", () => {
    expect(updatesHref("7", 0)).toBe("/updates?days=7");
    expect(updatesHref("7", -4)).toBe("/updates?days=7");
    expect(updatesHref("7", Number.NaN)).toBe("/updates?days=7");
  });

  it("parses both params defensively", () => {
    expect(parseUpdatesParams({ days: "7", page: "2" })).toEqual({ window: "7", page: 2 });
    expect(parseUpdatesParams({ days: ["x"], page: "1e21" })).toEqual({ window: "all", page: 1 });
    expect(parseUpdatesParams(undefined)).toEqual({ window: "all", page: 1 });
  });
});
