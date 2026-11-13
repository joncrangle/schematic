import type { AlertSource } from "~/agencies/types";
import type { HostingTarget } from "~/infrastructure/env/hostingTarget";
import { isFeedSecretName } from "~/infrastructure/env/feedSecretName";

/** Determines whether a manifest alert source is active under the current runtime environment. */
export function isAlertSourceActive(
  source: AlertSource,
  target: HostingTarget,
  getSecret?: (name: string) => string | undefined,
): boolean {
  if (source.enabled === false) return false;
  if (source.runtimes && !source.runtimes.includes(target)) return false;
  if (
    source.baseUrlSecretName &&
    (!isFeedSecretName(source.baseUrlSecretName) ||
      !getSecret ||
      !getSecret(source.baseUrlSecretName))
  ) {
    return false;
  }
  return true;
}
