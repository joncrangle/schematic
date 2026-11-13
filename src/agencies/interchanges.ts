import { interchangeCatalog } from "./interchangeCatalog";
import { decodeInterchangeDataset } from "~/domain/map/Interchange";
export { decodeInterchangeDataset } from "~/domain/map/Interchange";

/**
 * The browser consumes the generated artifact only. Regional overrides are
 * applied by scripts/seed.ts before this module is bundled, never at runtime.
 */
export const interchanges = decodeInterchangeDataset(
  interchangeCatalog.flatMap(({ hubs }) => decodeInterchangeDataset(hubs)),
);
