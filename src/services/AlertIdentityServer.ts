import { readStaticAsset, staticAssetCache } from "./StaticAssetServer";
import "server-only";
import catalog from "~/generated/alert-identities.json";
import {
  createStaticAlertIdentityResolver,
  type AlertIdentityLookups,
} from "~/infrastructure/alerts/staticAlertIdentities";

let resolve: ReturnType<typeof createStaticAlertIdentityResolver> | undefined;

export function getAlertIdentityLookups(agencyId: string): AlertIdentityLookups {
  resolve ??= createStaticAlertIdentityResolver({
    catalog,
    readAsset: readStaticAsset,
    cache: staticAssetCache,
  });
  return resolve(agencyId);
}
