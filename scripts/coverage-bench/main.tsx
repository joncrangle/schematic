/** Mounts the production coverage overlay with the full agency catalog for benchmarking. */
import "./bench.css";
import { render } from "@solidjs/web";
import { allProviders } from "~/agencies/browserRegistry";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { I18nProvider } from "~/i18n/I18nContext";
import { loadCoverageCountries } from "~/components/network-coverage/coverageCountries";
import { NetworkCoverage } from "~/components/network-coverage/NetworkCoverage";

declare global {
  interface Window {
    coverageBenchReady?: boolean;
  }
}

const countries = await loadCoverageCountries();
const providers = allProviders();
render(
  () => (
    <UserPreferencesProvider>
      <I18nProvider>
        <NetworkCoverage
          countries={countries}
          providers={providers}
          currentAgencyId={providers[0]?.manifest.id}
          prefersReducedMotion={() => true}
          onClose={() => {}}
        />
      </I18nProvider>
    </UserPreferencesProvider>
  ),
  document.getElementById("root")!,
);
window.coverageBenchReady = true;
