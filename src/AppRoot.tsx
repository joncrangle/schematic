import { onSettled } from "solid-js";
import { QueryClientProvider } from "@tanstack/solid-query";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { I18nProvider } from "~/i18n/I18nContext";
import { logger } from "~/infrastructure/logging/logger";
import { queryClient } from "~/lib/queryClient";
import { getLocationLadder } from "~/hooks/useGeolocation";
import { getServiceWorkerScriptUrl } from "~/lib/serviceWorkerRegistration";
import { Router } from "./router";

export default function App() {
  onSettled(() => {
    // Restore any persisted dev spoof after the static shell settles. The
    // build-time prerender has no localStorage, so a module-init restore
    // leaves prerendered attributes stale with no reactive write to repaint
    // them. Same post-settled pattern as the coarse seed below.
    const ladder = getLocationLadder();
    ladder.restorePersistedSpoof();

    // Seed the coarse-ip tier once per session: the server derives a
    // city-level fix from request.cf (Workers) or GeoLite2 (self-host).
    // Fire and forget. The tier only matters when GPS is absent or expired.
    // Coarse location is secondary to the map, so keep its server-function
    // middleware and GeoIP dependencies out of the hydration-critical chunk.
    void import("~/services/CoarseLocationService").then(({ getCoarseLocation }) =>
      ladder.seedCoarse(() => getCoarseLocation()),
    );

    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker
        .register(getServiceWorkerScriptUrl())
        .then((reg) => {
          logger.debug("ServiceWorker registration successful with scope", { scope: reg.scope });
        })
        .catch((err) => {
          logger.warn("ServiceWorker registration failed", { error: err });
        });
    }
  });

  return (
    <QueryClientProvider client={queryClient}>
      <UserPreferencesProvider>
        <I18nProvider>
          <Router>{(props) => props.children}</Router>
        </I18nProvider>
      </UserPreferencesProvider>
    </QueryClientProvider>
  );
}
