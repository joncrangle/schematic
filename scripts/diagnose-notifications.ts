import { readFileSync, statSync } from "node:fs";
import * as Effect from "effect/Effect";
import { agencyCatalog } from "../src/agencies/agencyCatalog";
import { isAlertSourceActive } from "../src/infrastructure/realtime/alertSourceActivity";
import { fetchAgencyAlerts } from "../src/infrastructure/realtime/fetchAgencyAlerts";
import { replayNotificationEvaluation } from "../src/services/notifications/NotificationDiagnostics";

const USAGE = `Usage: bun run notifications:diagnose --subscription preferences.json --now <ISO time with offset>
  --snapshot snapshot.json
  OR --agency <id> --source <zero-based index> --feed captured-file
  [--deliveries deliveries.json] [--hosting cloudflare|self-hosted]

Replays captured input through production notification policy with an in-memory
repository and mock push transport. No network requests or database writes.
preferences.json contains timezone, commuteSchedules, favouriteLines,
favouriteStations, and favouriteSurfaceRoutes; omit endpoint, auth, and p256dh.
deliveries.json is an optional array of that subscription's delivery facts.
Raw feed mode supports single-response json, rss, and gtfs-rt manifest sources.
Delivery-history replay requires a complete snapshot, not a single raw source.
Snapshot mode uses captured lifecycle values unchanged. Mock acceptance cannot
establish production delivery. Maximum input file size is 5 MiB.
See docs/agents/notifications.md for capture and production correlation.`;

function readCapture(path: string): Buffer {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
    throw new Error("Capture must be a regular file no larger than 5 MiB.");
  return readFileSync(path);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const values = new Map<string, string>();
  const allowed = [
    "--snapshot",
    "--subscription",
    "--now",
    "--deliveries",
    "--agency",
    "--source",
    "--feed",
    "--hosting",
  ];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!allowed.includes(key) || !value || value.startsWith("--") || values.has(key))
      throw new Error("Invalid flags.");
    values.set(key, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error("Missing required flag.");
    return value;
  };
  const time = required("--now");
  const now = Date.parse(time);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(time) || !Number.isFinite(now))
    throw new Error("Time must include an offset.");
  const subscription: unknown = JSON.parse(readCapture(required("--subscription")).toString());
  const deliveries: unknown = values.has("--deliveries")
    ? JSON.parse(readCapture(required("--deliveries")).toString())
    : [];

  let snapshot: unknown;
  if (values.has("--snapshot")) {
    if (["--feed", "--agency", "--source", "--hosting"].some((flag) => values.has(flag)))
      throw new Error("Choose one capture mode.");
    snapshot = JSON.parse(readCapture(required("--snapshot")).toString());
  } else {
    if (values.has("--deliveries"))
      throw new Error("Delivery history requires a complete snapshot.");
    const agency = agencyCatalog.find((entry) => entry.manifest.id === required("--agency"));
    const index = Number(required("--source"));
    const source = agency?.manifest.alerts?.[index];
    const hosting = values.get("--hosting") ?? "cloudflare";
    if (
      !agency ||
      !Number.isInteger(index) ||
      index < 0 ||
      !source ||
      source.type === "web" ||
      (hosting !== "cloudflare" && hosting !== "self-hosted") ||
      !isAlertSourceActive(source, hosting)
    )
      throw new Error("Unsupported or inactive captured source.");
    const body = readCapture(required("--feed"));
    const response = new Response(new Uint8Array(body), { status: 200 });
    // Only the selected captured response is available. Pagination or another URL
    // fails instead of silently reaching a live feed or replaying the wrong body.
    const offlineFetch: typeof fetch = async (request) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url !== source.url) throw new Error("Capture does not cover this request.");
      return response.clone();
    };
    snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: agency.manifest.id,
        sources: [source],
        fetch: offlineFetch,
        now: () => now,
        timeZone: agency.manifest.timezone,
        manifest: agency.manifest,
        schematic: agency.schematic,
        stationIndex: agency.schematic?.stationIndex,
        hostingTarget: hosting,
      }),
    );
  }
  const report = await replayNotificationEvaluation({ now, snapshot, subscription, deliveries });
  console.log(
    JSON.stringify(
      { ...report, captureMode: values.has("--snapshot") ? "agency-snapshot" : "single-source" },
      null,
      2,
    ),
  );
}

main().catch(() => {
  // Parser/feed failures may embed captured preferences or source credentials.
  console.error(
    "Notification replay failed. Check --help, capture schema, file bounds, and selected source; no network request or production push was made.",
  );
  process.exitCode = 1;
});
