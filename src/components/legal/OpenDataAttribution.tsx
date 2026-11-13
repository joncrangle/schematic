import type { JSX } from "@solidjs/web";
import { cn } from "~/lib/utils";
import { getActiveAgency, getAgencyById } from "~/agencies/browserRegistry";
import { resolveLocalizedAttribution } from "~/agencies/types";
import { useI18n } from "~/i18n/I18nContext";

export interface OpenDataAttributionProps {
  readonly agencyId?: string;
  readonly variant?: "card" | "footer";
  readonly class?: string;
}

/**
 * Mandatory open-data attribution, rendered entirely from the selected
 * provider's manifest: licence label and link come from
 * `manifest.attribution`, so each agency speaks for its own data source.
 */
export function OpenDataAttribution(props: OpenDataAttributionProps): JSX.Element {
  const { t, displayLocale } = useI18n();
  const variant = () => props.variant ?? "card";
  const agency = () => {
    const provider =
      props.agencyId === undefined ? getActiveAgency() : getAgencyById(props.agencyId);
    if (!provider) throw new Error(`Unknown agency: ${props.agencyId}`);
    return provider;
  };
  const attribution = () =>
    resolveLocalizedAttribution(agency().manifest.attribution, displayLocale());
  const agencyName = () => agency().manifest.name;

  const LicenceLink = () => (
    <a
      href={attribution().url}
      target="_blank"
      rel="noopener noreferrer"
      class="text-info underline hover:text-info"
    >
      {attribution().license}
    </a>
  );

  if (variant() === "footer") {
    return (
      <div
        class={cn(
          "border-t border-border bg-background px-4 py-2 text-center text-[10px] text-muted-foreground",
          props.class,
        )}
      >
        {!attribution().licenseIsStatement && <>{t("Contains information licensed under the")} </>}
        <LicenceLink />
      </div>
    );
  }

  return (
    <div
      class={cn(
        "rounded-xl border border-border bg-card p-3 text-[11px] text-muted-foreground/70 leading-relaxed",
        props.class,
      )}
    >
      <div class="flex items-center gap-1.5 font-semibold text-muted-foreground">
        <span>⚖️</span>
        <span>{t("Open Data & Attribution")}</span>
      </div>
      <p class="mt-1.5 text-[10.5px]">
        {!attribution().licenseIsStatement && <>{t("Contains information licensed under the")} </>}
        <LicenceLink />
        {!attribution().licenseIsStatement && "."}
      </p>
      <p class="mt-1 text-[10px] text-muted-foreground/70">
        {t(
          "Unofficial community project. Transit data provided via {{source}}. Not endorsed by {{agency}}.",
          {
            source: attribution().name,
            agency: agencyName(),
          },
        )}
      </p>
    </div>
  );
}
