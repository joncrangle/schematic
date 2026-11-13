import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeTripSparkAdvisories } from "~/infrastructure/realtime/tripspark/tripsparkAdvisories";
const contract: {
  cases: {
    name: string;
    base: unknown;
    news: unknown;
    details: Record<string, string>;
    expected?: unknown;
    error?: boolean;
  }[];
} = JSON.parse(
  readFileSync(new URL("../fixtures/tripspark-advisories/contract.json", import.meta.url), "utf8"),
);
it.each(contract.cases.filter((c) => !c.error))("$name", (c) => {
  expect(decodeTripSparkAdvisories(c.base, c.news, c.details)).toEqual(c.expected);
});
it.each(contract.cases.filter((c) => c.error))("$name", (c) => {
  expect(() => decodeTripSparkAdvisories(c.base, c.news, c.details)).toThrow();
});
