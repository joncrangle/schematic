/**
 * Dev-only alert simulator: fabricates a fully-specified transit alert
 * and runs it through the production dispatch pipeline — severe filter,
 * commute-window gate, line/station/route matching, delivery dedup, VAPID
 * push. Only the realtime feed fetch is skipped.
 *
 * Storage is wired to the same local miniflare D1 database `vite dev` elects
 * via wrangler's getPlatformProxy() (no Cloudflare auth), so subscriptions
 * registered in the running dev server are visible here. VAPID keys come
 * from .env like every other server entrypoint.
 */
import type { SpoofAlertOverrides } from "~/services/notifications/DevAlertSpoof";
import {
  buildSpoofSnapshot,
  runSpoofedAlertEvaluation,
} from "~/services/notifications/DevAlertSpoof";

const USAGE = `Usage: bun run alerts:spoof [flags]

Simulates a transit alert through the real evaluation pipeline and delivers
push notifications to matching subscribed devices.

Flags:
  --agency <id>          Agency id (default: ttc)
  --line <id>            Affected line id, e.g. 2 or 1 (default: 2)
  --stations <names>     Comma-separated station names (default: Castle Frank)
  --routes <ids>         Comma-separated surface route ids (optional)
  --severity <level>     normal | degraded | severe (default: severe)
  --kind <kind>          delay | slow-service | suspension | accessibility |
                         upcoming | information (default: suspension)
  --title <text>         Override alert title entirely
  --description <text>   Override alert description entirely
  -h, --help             Show this help

Examples:
  bun run alerts:spoof
  bun run alerts:spoof -- --agency go --line Lakeshore-East --stations "Union Station"
  bun run alerts:spoof -- --severity degraded --kind slow-service --line 1`;

interface ParsedArgs {
  agency: string;
  overrides: SpoofAlertOverrides;
}

function parseArgs(argv: readonly string[]): ParsedArgs | null {
  let agency = "ttc";
  const overrides: { -readonly [K in keyof SpoofAlertOverrides]: SpoofAlertOverrides[K] } = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return null;

    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = () => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (flag) {
      case "--agency":
        agency = next();
        break;
      case "--line":
        overrides.lineId = next();
        break;
      case "--stations":
        overrides.stations = next()
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      case "--routes":
        overrides.routeIds = next()
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      case "--severity":
        overrides.severity = next() as SpoofAlertOverrides["severity"];
        break;
      case "--kind":
        overrides.kind = next() as SpoofAlertOverrides["kind"];
        break;
      case "--title":
        overrides.title = next();
        break;
      case "--description":
        overrides.description = next();
        break;
      default:
        throw new Error(`Unknown flag "${flag}". Use --help for usage.`);
    }
  }

  return { agency, overrides };
}

async function main(): Promise<number> {
  if (process.env.NODE_ENV === "production") {
    console.error("[alerts:spoof] Refusing to run outside development environments.");
    return 1;
  }

  let parsed: ParsedArgs;
  try {
    const parsedOrNull = parseArgs(process.argv.slice(2));
    if (!parsedOrNull) {
      console.log(USAGE);
      return 0;
    }
    parsed = parsedOrNull;
  } catch (err) {
    console.error(`[alerts:spoof] ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(USAGE);
    return 1;
  }

  // Elect the same miniflare D1 binding vite dev uses so locally-registered
  // subscriptions are dispatch targets (RuntimeBindings arm 1: globalThis.env).
  console.log(`[alerts:spoof] Opening local miniflare D1 proxy (${parsed.agency})...`);
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy();
  (globalThis as { env?: Record<string, unknown> }).env = {
    ...proxy.env,
    ...(globalThis as { env?: Record<string, unknown> }).env,
  };

  const preview = buildSpoofSnapshot(parsed.agency, Date.now(), parsed.overrides);
  const alert = preview.alerts[0];
  console.log("[alerts:spoof] Fabricated alert:");
  console.log(`  agency:     ${preview.agencyId}`);
  console.log(`  id:         ${alert.id}`);
  console.log(`  severity:   ${alert.severity}`);
  console.log(`  kind:       ${alert.kind}`);
  console.log(`  lines:      ${alert.affectedLineIds?.join(", ") || "(none)"}`);
  console.log(`  stations:   ${alert.affectedStations?.join(", ") || "(none)"}`);
  if (alert.affectedRouteIds?.length) {
    console.log(`  routes:     ${alert.affectedRouteIds.join(", ")}`);
  }
  console.log(`  title:      ${alert.title}`);

  console.log("[alerts:spoof] Dispatching through the production pipeline...");
  try {
    const summary = await runSpoofedAlertEvaluation(parsed.agency, parsed.overrides);
    console.log(
      `[alerts:spoof] done — alerts evaluated: ${summary.activeAlertsEvaluated}, ` +
        `subscriptions checked: ${summary.subscriptionsChecked}, ` +
        `pushes sent: ${summary.activePushesSent}, ` +
        `recovery pushes: ${summary.clearedPushesSent}, ` +
        `stale subs pruned: ${summary.expiredSubscriptionsPruned}`,
    );

    if (summary.activePushesSent > 0) {
      console.log("[alerts:spoof] ✅ Delivered. Check your device.");
    } else if (summary.activeAlertsEvaluated === 0) {
      console.log(
        "[alerts:spoof] ⚠️ No alerts survived the severe filter — pass --severity severe.",
      );
    } else if (summary.subscriptionsChecked === 0) {
      console.log(
        "[alerts:spoof] ⚠️ Zero subscriptions stored — enable push notifications in dev settings first.",
      );
    } else {
      console.log(
        "[alerts:spoof] ⚠️ Subscriptions exist but none matched — check favourite lines/stations and that a commute window is open now.",
      );
    }
    return 0;
  } catch (err) {
    console.error(`[alerts:spoof] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await proxy.dispose?.();
  }
}

process.exitCode = await main();
