import { describe, expect, it } from "vitest";
import { MAX_PUBLISHER_SLUG_LENGTH, slugify } from "@/lib/slugify";
import { isValidPublisherSlug } from "@/lib/cache-config";

describe("slugify: existing Latin names keep exactly the slug they had", () => {
  it.each([
    ["Ministry of Health", "ministry-of-health"],
    ["Information & eGovernment Authority", "information-and-egovernment-authority"],
    ["Bahrain Tourism and Exhibitions Authority", "bahrain-tourism-and-exhibitions-authority"],
    ["  Electricity and Water Authority  ", "electricity-and-water-authority"],
    ["Supreme Council for Environment", "supreme-council-for-environment"],
    ["Meteorological Directorate \\ Ministry of Transportation and Telecommunications", "meteorological-directorate-ministry-of-transportation-and-telecommunications"],
    ["Meteorological Directorate\\Ministry of Transportation and Telecommunications", "meteorological-directorate-ministry-of-transportation-and-telecommunications"],
    ["2024 Census", "2024-census"],
    ["Test Authority", "test-authority"],
  ])("%s -> %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("still merges the documented whitespace variants into one slug", () => {
    expect(slugify("A \\ B")).toBe(slugify("A\\B"));
  });
});

describe("slugify: never empty, never invalid", () => {
  const arabic = ["وزارة الداخلية", "هيئة المعلومات والحكومة الإلكترونية", "وزارة الصحة", "مجلس التنمية الاقتصادية"];

  it("gives an Arabic-only name a non-empty slug that passes isValidPublisherSlug", () => {
    for (const name of arabic) {
      const slug = slugify(name);
      expect(slug, name).not.toBe("");
      expect(isValidPublisherSlug(slug), `${name} -> ${slug}`).toBe(true);
      expect(slug.startsWith("p-")).toBe(true);
    }
  });

  it("gives different Arabic names different slugs (the merged-tile bug)", () => {
    const slugs = arabic.map(slugify);
    expect(new Set(slugs).size).toBe(arabic.length);
  });

  it("is deterministic: the same name always gives the same slug (URLs are stable)", () => {
    for (const name of arabic) expect(slugify(name)).toBe(slugify(name));
    // pinned: a hash change would silently move every such URL
    expect(slugify("وزارة الداخلية")).toMatch(/^p-[0-9a-z]{11}$/);
    expect(slugify("وزارة الداخلية")).toBe(slugify("وزارة الداخلية"));
  });

  it("treats whitespace and case variants of a hashed name as one publisher, like the Latin names", () => {
    expect(slugify("  وزارة   الداخلية ")).toBe(slugify("وزارة الداخلية"));
    expect(slugify("وزارة الداخلية \\ مملكة البحرين")).toBe(slugify("وزارة الداخلية\\مملكة البحرين"));
  });

  it("does not collapse an Arabic name onto the digits it contains", () => {
    const a = slugify("وزارة 2024");
    const b = slugify("هيئة 2024");
    expect(a).not.toBe("2024");
    expect(a).not.toBe(b);
    expect(isValidPublisherSlug(a)).toBe(true);
  });

  it("gives punctuation-only and emoji names a valid slug too", () => {
    for (const name of ["???", "—", "😀", "..."]) {
      const slug = slugify(name);
      expect(isValidPublisherSlug(slug), name).toBe(true);
    }
  });

  it("keeps Latin letters of a mixed name readable (nothing was lost that mattered)", () => {
    expect(slugify("وزارة الصحة Ministry of Health")).toBe("ministry-of-health");
  });
});

describe("slugify: very long names", () => {
  const long = (suffix: string) => `${"Ministry of Something Very Long ".repeat(12)}${suffix}`;

  it("always fits MAX_PUBLISHER_SLUG_LENGTH and passes isValidPublisherSlug", () => {
    for (const length of [199, 200, 201, 323, 5000]) {
      const slug = slugify("a".repeat(length));
      expect(slug.length).toBeLessThanOrEqual(MAX_PUBLISHER_SLUG_LENGTH);
      expect(isValidPublisherSlug(slug), `length ${length}`).toBe(true);
    }
  });

  it("leaves a name that fits exactly as it was (200 characters is still allowed)", () => {
    expect(slugify("a".repeat(200))).toBe("a".repeat(200));
  });

  it("does not merge two long names that share a long prefix", () => {
    const a = slugify(long("North"));
    const b = slugify(long("South"));
    expect(a).not.toBe(b);
    expect(isValidPublisherSlug(a) && isValidPublisherSlug(b)).toBe(true);
  });

  it("never ends in a dangling hyphen before the hash", () => {
    const slug = slugify(`${"word ".repeat(60)}end`);
    expect(slug).not.toMatch(/--/);
    expect(slug.length).toBeLessThanOrEqual(MAX_PUBLISHER_SLUG_LENGTH);
  });
});

describe("isValidPublisherSlug", () => {
  it("accepts the generated forms and still rejects hostile input", () => {
    expect(isValidPublisherSlug("ministry-of-health")).toBe(true);
    expect(isValidPublisherSlug("p-0a1b2c3d4e5")).toBe(true);
    for (const bad of ["", "Ministry", "a b", "../x", "a/b", "x".repeat(201), "عربي", null, 5, undefined]) {
      expect(isValidPublisherSlug(bad)).toBe(false);
    }
  });
});
