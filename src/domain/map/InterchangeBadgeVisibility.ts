import type {
  InterchangeBadgeVisibility,
  InterchangeBadgeVisibilityPreference,
} from "~/domain/preferences/UserPreferences";

/** Resolves an unset preference to the mobile or desktop presentation default. */
export function resolveInterchangeBadgeVisibility(
  preference: InterchangeBadgeVisibilityPreference,
  isMobileViewport: boolean,
): InterchangeBadgeVisibility {
  return preference ?? (isMobileViewport ? "compact" : "full");
}
