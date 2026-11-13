declare module "virtual:agency-schematics" {
  import type { AgencyLightIndex } from "~/agencies/lightIndex";

  /** Light slice per map-bearing agency id; mapless agencies are absent. */
  export const agencyLightIndex: Readonly<Record<string, AgencyLightIndex>>;
  /** Lazy raw schematic loaders per map-bearing agency id. */
  export const agencySchematicLoaders: Readonly<Record<string, () => Promise<unknown>>>;
}
