import { createSignal, onSettled, Show } from "solid-js";
import { Portal } from "@solidjs/web";
import { DirectionArrivalsRow } from "~/components/nearby/DirectionArrivalsRow";
import { LineBadgeCircle } from "~/components/nearby/LineBadgeCircle";
import { StarIcon } from "~/components/icons/StarIcon";
import { CogIcon } from "~/components/icons/CogIcon";
import { useI18n } from "~/i18n/I18nContext";
import { formatDistanceValue } from "~/components/nearby/nearbyHelpers";
import { MAX_PROXIMITY_RADIUS_METERS } from "~/domain/proximity";
import { cn } from "~/lib/utils";

export const HELP_DISMISSED_STORAGE_KEY = "schematic:help-dismissed:v1";

/** Without browser storage, dismissal lasts for the page session. */
let dismissedWithoutStorage = false;

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(HELP_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return dismissedWithoutStorage;
  }
}

function saveDismissed(): void {
  try {
    window.localStorage.setItem(HELP_DISMISSED_STORAGE_KEY, "1");
  } catch {
    dismissedWithoutStorage = true;
  }
}

/** Callout and station surfaces; the scrolling fallback stacks them in one column. */
const CALLOUT_SURFACE =
  "pointer-events-auto rounded-[15px] border border-[#626b79] bg-[#20252d] shadow-[0_16px_44px_rgba(0,0,0,0.5)] group-data-scroll/help:relative group-data-scroll/help:inset-auto! group-data-scroll/help:translate-none group-data-scroll/help:shrink group-data-scroll/help:grow-0 group-data-scroll/help:basis-[220px]";
const CALLOUT =
  "fixed z-2 w-[232px] px-3.5 py-3 max-[899px]:w-[min(232px,calc((100vw-36px)/2))] max-[899px]:px-2.5 max-[899px]:py-[9px]";
/** A rotated square forms the pointer; two hidden edges let it join the callout border. */
const CALLOUT_POINTER =
  "after:absolute after:left-[var(--arrow-x,50%)] after:size-3 after:rotate-45 after:border after:border-[#626b79] after:bg-[#20252d] after:content-[''] group-data-scroll/help:after:hidden";
const CALLOUT_HEADING = "mb-1 text-[10px] font-extrabold tracking-[0.08em] text-info uppercase";
const CALLOUT_TEXT = "text-xs leading-[1.4] text-[#d5dae2]";

export function HelpMode(props: { ready: boolean; onOpen?: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  onSettled(() => {
    setOpen(!readDismissed());
  });
  const close = () => {
    saveDismissed();
    setOpen(false);
    onSettled(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };
  return (
    <>
      <button
        ref={(el) => {
          trigger = el;
        }}
        type="button"
        aria-label={t("Help")}
        title={t("Help")}
        disabled={!props.ready}
        onClick={() => {
          props.onOpen?.();
          setOpen(true);
        }}
        class="pointer-events-auto fixed top-[3.625rem] right-4 flex h-8.5 w-8.5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-card/90 text-sm font-bold text-foreground shadow-lg backdrop-blur-md hover:bg-accent disabled:opacity-50"
      >
        ?
      </button>
      <Show when={props.ready && open()}>
        <HelpDialog onClose={close} />
      </Show>
    </>
  );
}

function HelpDialog(props: { onClose: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  let dialog: HTMLDivElement | undefined;
  let done: HTMLButtonElement | undefined;
  let station: HTMLElement | undefined;
  let content: HTMLDivElement | undefined;
  let footer: HTMLDivElement | undefined;
  let star: HTMLButtonElement | undefined;
  let networkArrow: SVGPathElement | undefined;
  const [saved, setSaved] = createSignal(false);
  const exampleTime = Date.now();
  const cards: Record<string, HTMLElement> = {};
  const rings: Record<string, HTMLElement> = {};
  const names = ["network", "settings", "nearby", "service"] as const;

  onSettled(() => {
    const main = document.querySelector("main");
    const wasInert = main?.inert ?? false;
    if (main) main.inert = true;
    done?.focus();
    const layout = () => {
      if (!dialog || !station) return;
      // Measure the annotated layout again so resizing can leave the scrolling fallback.
      dialog.removeAttribute("data-scroll");
      dialog.style.setProperty("--help-footer-height", `${footer?.offsetHeight ?? 73}px`);
      for (const name of names) {
        const target = dialog.querySelector<HTMLElement>(`[data-demo-target="${name}"]`);
        const ring = rings[name];
        if (!target || !ring) continue;
        const r = target.getBoundingClientRect();
        Object.assign(ring.style, {
          left: `${r.left - 4}px`,
          top: `${r.top - 4}px`,
          width: `${r.width + 8}px`,
          height: `${r.height + 8}px`,
        });
        const card = cards[name];
        if (card) {
          const box = card.getBoundingClientRect();
          if (name === "network" && networkArrow) {
            const tip =
              Math.max(r.left + 8, Math.min(r.left + r.width / 2, box.right - 12)) - box.left;
            const base = Math.max(12, Math.min(tip, box.width - 16));
            networkArrow.setAttribute("d", `M ${base - 7} 14 L ${tip} 0 L ${base + 7} 14`);
          }
          const arrow = Math.max(12, Math.min(r.left + r.width / 2 - box.left - 6, box.width - 18));
          card.style.setProperty("--arrow-x", `${arrow}px`);
          const arrowY = Math.max(
            12,
            Math.min(r.top + r.height / 2 - box.top - 6, box.height - 24),
          );
          card.style.setProperty("--arrow-y", `${arrowY}px`);
        }
      }
      if (
        window.innerWidth < 900 &&
        window.innerHeight > 580 &&
        cards.network &&
        cards.settings &&
        cards.nearby &&
        cards.service
      ) {
        station.removeAttribute("data-compact");
        const upper =
          Math.max(
            cards.network.getBoundingClientRect().bottom,
            cards.settings.getBoundingClientRect().bottom,
          ) + 8;
        const lower =
          Math.min(
            cards.nearby.getBoundingClientRect().top,
            cards.service.getBoundingClientRect().top,
          ) - 8;
        station.toggleAttribute("data-compact", lower - upper < station.offsetHeight);
        station.style.top = `${Math.max(upper, (upper + lower - station.offsetHeight) / 2)}px`;
      } else {
        station.removeAttribute("data-compact");
        station.style.top = "";
      }
      const boxes = [...Object.values(cards), station].map((el) => el.getBoundingClientRect());
      const bottom = footer?.getBoundingClientRect().top ?? window.innerHeight - 85;
      const clipped = boxes.some(
        (box) =>
          box.left < 8 ||
          box.right > window.innerWidth - 8 ||
          box.top < 60 ||
          box.bottom > bottom - 8,
      );
      const overlaps = boxes.some((box, index) =>
        boxes
          .slice(index + 1)
          .some(
            (other) =>
              box.left < other.right + 8 &&
              box.right + 8 > other.left &&
              box.top < other.bottom + 8 &&
              box.bottom + 8 > other.top,
          ),
      );
      const scroll = window.innerHeight <= 580 || clipped || overlaps;
      dialog.toggleAttribute("data-scroll", scroll);
      if (scroll) station.removeAttribute("data-compact");
    };
    layout();
    window.addEventListener("resize", layout);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(layout);
    if (observer) {
      for (const card of Object.values(cards)) observer.observe(card);
      if (station) observer.observe(station);
      if (footer) observer.observe(footer);
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
      if (event.key === "Tab") {
        const candidates: (HTMLElement | undefined)[] = [content, star, done];
        const controls = candidates.filter((el): el is HTMLElement => el !== undefined);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      if (main) main.inert = wasInert;
      observer?.disconnect();
      window.removeEventListener("resize", layout);
      document.removeEventListener("keydown", keydown);
    };
  });

  return (
    <Portal>
      <div
        data-help-backdrop
        class="fixed inset-0 z-100 cursor-pointer bg-drafting-grid"
        onClick={props.onClose}
        aria-hidden="true"
      >
        <svg
          class="absolute inset-0 h-full w-full opacity-[0.28]"
          viewBox="0 0 400 700"
          preserveAspectRatio="xMidYMid slice"
          fill="none"
          stroke-width="6"
          stroke-linecap="round"
        >
          <path d="M-20 500 L140 500 L320 240 L430 240" stroke="#1169b0" />
          <path d="M80 -10 L80 280 L230 430 L230 720" stroke="#f58220" />
          <path d="M-10 310 L410 310" stroke="#399c65" />
          <circle cx="80" cy="310" r="5" class="fill-background stroke-[#ccc] stroke-3" />
          <circle cx="175" cy="310" r="5" class="fill-background stroke-[#ccc] stroke-3" />
          <circle cx="230" cy="430" r="5" class="fill-background stroke-[#ccc] stroke-3" />
        </svg>
      </div>
      <div
        ref={(el) => {
          dialog = el;
        }}
        class="group/help pointer-events-none fixed inset-0 z-101 text-foreground"
        role="dialog"
        aria-modal="true"
        aria-label={t("How to use Schematic")}
      >
        <div class="absolute inset-0 z-1 opacity-95" aria-hidden="true">
          <div class="fixed top-4 left-1/2 flex h-[34px] -translate-x-1/2 items-center gap-2.5 rounded-full border border-border bg-card px-3">
            <span class="font-[monospace] text-[11px] leading-[normal] font-bold tracking-[0.14em] text-info">
              [SCHEMATIC]
            </span>
            <span
              class="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-bold whitespace-nowrap"
              data-demo-target="network"
            >
              Sablewood ▾
            </span>
          </div>
          <span
            class="fixed top-4 right-3.5 grid size-[34px] place-items-center rounded-full border border-border bg-card"
            data-demo-target="settings"
          >
            <CogIcon size={16} />
          </span>
          <div class="fixed right-3.5 bottom-[max(0.875rem,env(safe-area-inset-bottom,0.875rem))] flex flex-col items-center gap-2 text-[#b4bac4]">
            <span
              class="grid size-[42px] place-items-center rounded-full border border-border bg-card text-[22px]"
              data-demo-target="nearby"
            >
              ◎
            </span>
            <div class="w-11 overflow-hidden rounded-xl border border-border bg-card opacity-70">
              <span
                class="grid h-[42px] place-items-center border-b border-border text-[20px]"
                data-demo-control="zoom-in"
              >
                +
              </span>
              <span
                class="grid h-[42px] place-items-center text-[20px]"
                data-demo-control="zoom-out"
              >
                −
              </span>
            </div>
            <span
              class="grid size-[42px] place-items-center rounded-full border border-border bg-card text-[20px] opacity-70"
              data-demo-control="recentre"
            >
              ⊙
            </span>
          </div>
          <div
            class="fixed bottom-[calc(max(16px,env(safe-area-inset-bottom))+80px)] left-1/2 flex -translate-x-1/2 gap-[25px] rounded-full border border-border bg-card px-5 py-[13px] text-[12px] font-semibold whitespace-nowrap"
            data-demo-target="service"
          >
            <span class="text-warning-400">● &nbsp;{t("Alerts")}</span>
            <span>● &nbsp;{t("Upcoming")}</span>
          </div>
        </div>
        {names.map((name) => (
          <div
            ref={(el) => {
              rings[name] = el;
            }}
            class="fixed z-2 rounded-full border-2 border-info shadow-[0_0_0_4px_rgba(56,189,248,0.14),0_0_26px_rgba(56,189,248,0.35)] group-data-scroll/help:hidden"
            aria-hidden="true"
          />
        ))}
        <div
          ref={(el) => {
            content = el;
          }}
          class="group-data-scroll/help:pointer-events-auto group-data-scroll/help:absolute group-data-scroll/help:inset-x-2.5 group-data-scroll/help:top-[60px] group-data-scroll/help:bottom-[calc(var(--help-footer-height,73px)+12px)] group-data-scroll/help:flex group-data-scroll/help:flex-wrap group-data-scroll/help:content-start group-data-scroll/help:justify-center group-data-scroll/help:gap-2 group-data-scroll/help:overflow-y-auto"
          tabindex="0"
        >
          <section
            ref={(el) => {
              cards.network = el;
            }}
            data-help-card="network"
            class={cn(
              CALLOUT_SURFACE,
              CALLOUT,
              "top-[76px] left-[calc(50%-116px)] max-[899px]:left-3 min-[500px]:max-[899px]:left-[max(12px,min(calc(50%-116px),calc(100vw-484px)))]",
            )}
          >
            <svg
              class="absolute -top-3.5 left-0 h-[15px] w-full overflow-visible group-data-scroll/help:hidden"
              aria-hidden="true"
            >
              <path
                ref={(el) => {
                  networkArrow = el;
                }}
                class="fill-[#20252d] stroke-[#626b79] stroke-1 [stroke-linejoin:round]"
              />
            </svg>
            <h2 class={CALLOUT_HEADING}>{t("Network")}</h2>
            <p class={CALLOUT_TEXT}>
              {t("Automatic uses your location. A manual choice stays selected when you travel.")}
            </p>
          </section>
          <section
            ref={(el) => {
              cards.settings = el;
            }}
            data-help-card="settings"
            class={cn(
              CALLOUT_SURFACE,
              CALLOUT,
              CALLOUT_POINTER,
              "top-[76px] right-3.5 after:-top-[7px] after:border-r-0 after:border-b-0 max-[899px]:right-3",
            )}
          >
            <h2 class={CALLOUT_HEADING}>{t("Settings")}</h2>
            <p class={CALLOUT_TEXT}>
              {t(
                "Add routes to your favourites, schedule commute alerts, and choose your language and units.",
              )}
            </p>
          </section>
          <section
            ref={(el) => {
              cards.nearby = el;
            }}
            data-help-card="nearby"
            class={cn(
              CALLOUT_SURFACE,
              CALLOUT,
              CALLOUT_POINTER,
              "right-20 bottom-[calc(max(0.875rem,env(safe-area-inset-bottom,0.875rem))+125px)] after:-bottom-[7px] after:border-t-0 after:border-l-0 max-[899px]:right-3 max-[899px]:bottom-[calc(max(0.875rem,env(safe-area-inset-bottom,0.875rem))+206px)] min-[900px]:after:-right-[7px] min-[900px]:after:top-[var(--arrow-y,50%)] min-[900px]:after:bottom-auto min-[900px]:after:left-auto",
            )}
          >
            <h2 class={CALLOUT_HEADING}>{t("Nearby")}</h2>
            <p class={CALLOUT_TEXT}>
              {t(
                "Your favourites appear alongside live departures within {{distance}}. Star a route to save it, or expand its card to see its map.",
                { distance: formatDistanceValue(MAX_PROXIMITY_RADIUS_METERS, i18n) },
              )}
            </p>
          </section>
          <section
            ref={(el) => {
              cards.service = el;
            }}
            data-help-card="service"
            class={cn(
              CALLOUT_SURFACE,
              CALLOUT,
              CALLOUT_POINTER,
              "bottom-[calc(max(16px,env(safe-area-inset-bottom))+146px)] left-[calc(50%-116px)] after:-bottom-[7px] after:border-t-0 after:border-l-0 max-[899px]:left-3",
            )}
          >
            <h2 class={CALLOUT_HEADING}>{t("Alerts and Upcoming")}</h2>
            <p class={CALLOUT_TEXT}>
              {t(
                "In the Alerts list, turn on Slow Zones or Accessibility to include those notices.",
              )}
            </p>
          </section>
          <section
            ref={(el) => {
              station = el;
            }}
            data-help-station
            class={cn(
              CALLOUT_SURFACE,
              "group/station fixed [&_.text-muted-foreground]:text-[#d5dae2] top-1/2 left-1/2 z-2 w-72 -translate-x-1/2 -translate-y-1/2 p-3 max-[899px]:w-[min(260px,calc(100vw-24px))] max-[899px]:translate-y-0 max-[899px]:p-[9px]",
            )}
          >
            <div class="flex items-center justify-between gap-3 border-b border-border pb-2">
              <div>
                <h2 class="text-sm font-bold">{t("Sablewood station")}</h2>
                <div class="max-[899px]:group-data-compact/station:hidden">
                  <LineBadgeCircle lineIds={["2", "7"]} agencyId="example" />
                  <p class="text-[11px] font-semibold text-live-400">{t("Normal Service")}</p>
                </div>
              </div>
              <button
                ref={(el) => {
                  star = el;
                }}
                type="button"
                class="pointer-events-auto grid size-9 cursor-pointer place-items-center rounded-lg text-warning-400 hover:bg-[rgba(245,158,11,0.12)] aria-pressed:bg-[rgba(245,158,11,0.12)]"
                aria-label={t("Practice saving this example station")}
                aria-pressed={saved() ? "true" : "false"}
                onClick={() => setSaved(!saved())}
              >
                <StarIcon size={20} filled={saved()} />
              </button>
            </div>
            <div
              class="flex flex-col gap-2 pt-2 max-[899px]:group-data-compact/station:hidden max-[899px]:[&>:last-child]:hidden"
              aria-label={t("Example departures")}
            >
              <DirectionArrivalsRow
                label={t("Eastbound")}
                lineId="2"
                agencyId="example"
                times={[exampleTime + 30000, exampleTime + 360000]}
              />
              <DirectionArrivalsRow
                label={t("Westbound")}
                lineId="7"
                agencyId="example"
                times={[exampleTime + 240000, exampleTime + 720000]}
              />
            </div>
            <p class="pt-3 text-xs leading-relaxed text-[#d5dae2]">
              {t("Select a station on the map, then select the star to add it to your favourites.")}
            </p>
          </section>
        </div>
        <div
          ref={(el) => {
            footer = el;
          }}
          class="fixed inset-x-0 bottom-0 flex justify-center border-t border-border bg-background px-4 pt-2.5 pb-[max(16px,env(safe-area-inset-bottom))]"
        >
          <button
            ref={(el) => {
              done = el;
            }}
            type="button"
            class="pointer-events-auto min-w-40 cursor-pointer rounded-full bg-foreground px-7 py-3 text-[15px] font-extrabold text-[#101014]"
            onClick={props.onClose}
          >
            {t("Got it")}
          </button>
        </div>
      </div>
    </Portal>
  );
}
