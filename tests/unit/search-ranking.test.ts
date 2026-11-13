import { describe, expect, it } from "vitest";
import { compareSearchRank } from "~/lib/searchRanking";

/**
 * Two-tier comparator shared by agency and route search: exact beats prefix,
 * everything else ties at 0. Substring matches are indistinguishable here, so
 * each call site owns the final ordering for its own records.
 */

function keys(value: string) {
  return { exact: [value], prefix: [value] };
}

/** -1 / 0 / +1, with a real zero so ties are not read as negative zero. */
function signOf(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

describe("compareSearchRank", () => {
  it.each([
    {
      tier: "an exact match ahead of a prefix match",
      query: "go",
      a: "GO",
      b: "GO Bus",
      sign: -1,
    },
    {
      tier: "a prefix match ahead of a substring-only match",
      query: "go",
      a: "GO Bus",
      b: "Algoma GO Service",
      sign: -1,
    },
    {
      tier: "two substring-only matches tied for the caller's tie-break",
      query: "go",
      a: "Algoma GO Service",
      b: "Niagara Falls GO Line",
      sign: 0,
    },
    {
      tier: "records equal on both tiers",
      query: "go",
      a: "GO",
      b: "Go",
      sign: 0,
    },
  ])("ranks $tier", ({ query, a, b, sign }) => {
    expect(signOf(compareSearchRank(query, keys(a), keys(b)))).toBe(sign);
    expect(signOf(compareSearchRank(query, keys(b), keys(a)))).toBe(-sign || 0);
  });

  it("ranks nothing on an empty query so an unranked list keeps its own order", () => {
    expect(compareSearchRank("   ", keys("GO Bus"), keys("Algoma GO Service"))).toBe(0);
  });

  it("treats a record that declares no exact or prefix keys as tied", () => {
    expect(compareSearchRank("go", {}, keys("Algoma GO Service"))).toBe(0);
    expect(compareSearchRank("go", keys("GO"), {})).toBe(-1);
  });
});
