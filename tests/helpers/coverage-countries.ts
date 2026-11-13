import { readFileSync } from "node:fs";
import type { CoverageGeography } from "~/components/network-coverage/generated/geography";

export const countries: Readonly<Record<string, CoverageGeography>> = JSON.parse(
  readFileSync("src/components/network-coverage/generated/countries.json", "utf8"),
);
