# Run automatic topology refresh on your own deployment

Forgejo and a NAS are not requirements. Self-hosted Bun or Node applications refresh local SQLite through the application's scheduler. Cloudflare deployments can refresh remote D1 from any host that runs Bun, including cron, systemd, a scheduled container, Forgejo Actions, or an opt-in GitHub Actions workflow.

| Application hosting     | Refresh runs on                    | What you configure                                                            |
| ----------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| Self-hosted Bun or Node | The long-lived application process | Initial SQLite seed, persistent `DATA_DIR`, and `initSchedulers()` at startup |
| Cloudflare Workers Free | An external Bun host               | Existing D1 database, private Wrangler JSON, API credentials, and a daily job |
| Cloudflare paid         | The same external Bun host         | The same portable job; this code does not add a Worker GTFS cron              |

## Start self-hosted refresh without another job

From your deployment checkout, replace `AGENCY_ID` with one registered seed agency and use the same persistent directory for seeding and serving:

```sh
bun install --frozen-lockfile
export DATA_DIR=/var/lib/schematic
bun scripts/seed.ts --agency=AGENCY_ID --db=sqlite
bun run build
bun run start
```

Repeat the targeted seed for each agency you intend to populate. Give the application user write access to `DATA_DIR`. In a container, mount that directory as a persistent volume. The runtime maps `DB_TRANSIT` to `DATA_DIR/transit.db`, alongside `DATA_DIR/push-notifications.db` for notifications. The seed script defaults to `./data` when `DATA_DIR` is absent, but the self-hosted runtime requires `DATA_DIR`; set it explicitly.

`bun run start` calls the compiled server's `initSchedulers()` before serving requests. A custom Node launcher must use Node 22.13+ with `node:sqlite` available and call `initSchedulers()` once before serving requests. The repository's start command is Bun-specific, not a Node HTTP launcher. The optional Forgejo workflow's Node 24 container is not an application requirement.

The topology timer is independent of alert scheduling. It arms the next 04:00 UTC opportunity and allows one cycle in flight. Keep the application running. Importing the server alone starts no timers, startup does not refresh every agency, and restarts do not catch up missed runs. No separate CI or cron job is needed for this local SQLite path. The remote CLI below targets Cloudflare D1, not local SQLite.

## Prepare an external runner for remote D1

Workers Free has a 10 ms CPU budget, insufficient for full GTFS projection. The Worker cron remains alerts-only. Run topology refresh outside the Worker, even if you use a paid plan and want to keep this portable setup.

Use a trusted checkout with the current agency registry and Bun 1.4.2 as in the supplied workflow. Install locked dependencies before supplying credentials to the refresh process:

```sh
bun install --frozen-lockfile
bun scripts/refresh-topology.ts --config=/etc/schematic/topology-wrangler.json
```

The noninteractive CLI refreshes existing remote `DB_TRANSIT` topology directly. It does not use a SQLite source, populate an empty agency partition, generate repository artifacts, or deploy the Worker. Give the runner memory headroom for compressed archives, projection indexes, and destination comparisons. Streaming CSV avoids a whole-file `stop_times.txt` string, but it does not impose a fixed ceiling on total process memory.

Supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through your scheduler's secret store or a private environment file. Scope the token to the intended account's D1 read/write access; deployment permissions are not needed for this job. Set `WRANGLER_SEND_METRICS=false` and `CI=true` for unattended runs. Do not put credentials in command arguments, commit them, enable shell tracing, or print the config.

The config must be plain JSON, not JSONC. This template deliberately fails validation until you substitute your existing D1 database's name and real UUID:

```json
{
  "d1_databases": [
    {
      "binding": "DB_TRANSIT",
      "database_name": "YOUR_EXISTING_DATABASE_NAME",
      "database_id": "YOUR_EXISTING_DATABASE_UUID"
    }
  ]
}
```

Store the config outside the checkout with directory mode `700` and file mode `600`, owned by the job user. It needs exactly one `DB_TRANSIT` entry, a database name containing only letters, digits, `_`, or `-`, and a non-placeholder UUID. No Worker entrypoint, notification binding, or deployment configuration is required. The runner must reach the operator feeds and Cloudflare's API.

Initial population is manual. In your deployment checkout, first configure its normal Wrangler `DB_TRANSIT` binding to your actual database, then run a targeted seed:

```sh
bun scripts/seed.ts --agency=AGENCY_ID --db=remote
```

Unlike the refresh CLI, `seed.ts` uses normal Wrangler config discovery, not `--config`. It builds a local SQLite projection and can regenerate repository artifacts. Run it in your operator checkout and review those changes. Do not run an all-agency backfill as part of the daily refresh.

## Schedule the CLI with cron, systemd, or a container host

Run daily at 04:00 UTC and serialize executions. Choose one scheduler for each destination. Multiple independent hosts do not share a lock.

For a Linux cron implementation that supports `CRON_TZ`, this example assumes `/usr/local/bin/schematic-topology-refresh` is your private wrapper. The wrapper changes to the trusted checkout, loads credentials without tracing or printing them, and runs the CLI command above. Replace all paths with your host's paths.

```cron
CRON_TZ=UTC
0 4 * * * /usr/bin/flock -n /var/lib/schematic/topology-refresh.lock /usr/local/bin/schematic-topology-refresh
```

If your cron does not support `CRON_TZ`, configure the scheduler's timezone explicitly or use systemd's UTC calendar instead. Ensure Bun is on the job's `PATH`; interactive shell settings do not necessarily apply to cron.

For systemd, create these units on your own host. `/etc/schematic/topology-refresh.env` must be a mode-`600` file containing the credential environment variables and the non-secret `WRANGLER_SEND_METRICS=false` and `CI=true` settings. Adjust Bun's installation path in both `ExecStart` and `PATH`; the CLI also launches `bunx`.

```ini
# schematic-topology-refresh.service
[Service]
Type=oneshot
User=schematic
WorkingDirectory=/opt/schematic
EnvironmentFile=/etc/schematic/topology-refresh.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/bun scripts/refresh-topology.ts --config=/etc/schematic/topology-wrangler.json
UMask=0077
```

```ini
# schematic-topology-refresh.timer
[Timer]
OnCalendar=*-*-* 04:00:00 UTC
Unit=schematic-topology-refresh.service

[Install]
WantedBy=timers.target
```

Install and enable the timer using your host's service administration tools. These units intentionally omit catch-up execution. systemd does not start another instance of the same service while it is active.

A scheduled container can run the same CLI from a trusted checkout or image with Bun and locked dependencies. Inject credentials at runtime, mount the private config read-only, set the daily UTC schedule, and disable overlapping jobs in the container scheduler. No NAS-specific image, host label, or container platform is required.

## Enable the supplied Forgejo workflow only if you use Forgejo

The repository includes `.forgejo/workflows/topology-refresh.yml`. It runs daily with `0 4 * * *` and supports manual dispatch, with one concurrency group and no push, pull-request, or deployment trigger.

In your own Forgejo repository:

1. Register a runner whose label supports the workflow's `node:24-bookworm` job container and Node 24-based actions. Set repository variable `TOPOLOGY_RUNNER_LABEL` to that exact label. For example, `ubuntu-latest` works only if your runner registers that label with a suitable container-capable mapping.
2. Enable repository Actions. If you use a mirror, ensure the workflow and current registry reach its default branch and that Actions is enabled for that repository. Synchronize it through your own operator workflow; application code does not configure or push Git remotes. Merely editing a local file does not schedule it.
3. Set repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `TOPOLOGY_WRANGLER_CONFIG`. The last secret is the substituted JSON above.
4. Ensure the runner provides `RUNNER_TEMP` and can fetch the pinned checkout and setup-bun actions. Test with manual dispatch, then inspect the per-agency results.

Repository variables and secrets live under **Settings → Actions → Variables**
and **Settings → Actions → Secrets**. They belong to the Forgejo repository,
so recreating a repository requires configuring them again. A Git push copies
workflow files, not these settings.

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `TOPOLOGY_RUNNER_LABEL` | An online container-capable runner's label, such as `ubuntu-latest` |
| Secret | `CLOUDFLARE_API_TOKEN` | An API token with D1 read/write access to the target Cloudflare account |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | The account ID that owns the transit database |
| Secret | `TOPOLOGY_WRANGLER_CONFIG` | The plain JSON configuration above, with the existing transit database's name and UUID substituted |

With `fj` authenticated to your Forgejo host, you can set the non-secret runner
label using:

```sh
fj --host forgejo.example.com actions variables --repo OWNER/REPO create TOPOLOGY_RUNNER_LABEL ubuntu-latest
```

Replace the host, repository, and runner label with your own. The `fj` token
needs `write:repository` to change Actions variables or secrets; read access
can list settings but cannot configure them. Enter secret values in Forgejo's
settings so they do not appear in shell history or command arguments.

The separate `.forgejo/workflows/ci.yml` workflow runs on `main`, pull requests,
and manual dispatch. It uses the same runner variable, falling back to
`ubuntu-latest` when unset, and needs no application or Cloudflare secrets.
`RUNNER_TEMP` comes from the runner; the refresh workflow already sets `CI`
and `WRANGLER_SEND_METRICS`. Do not copy a deployment's `.env` into Actions.

The workflow installs Bun 1.4.2 and uses `bun install --frozen-lockfile`. Credentials are available only to the refresh step. That step creates a private temporary config and removes it on exit. It neither seeds SQLite nor uploads artifacts.

Fetching `oven-sh/setup-bun` from GitHub downloads an action for the Forgejo runner to execute. It does not execute GitHub Actions or consume GitHub-hosted CI minutes.

Use read-only inspection of repository Actions settings, registered runners, and task history to check configuration. A runner label or empty task history does not prove that a runner is online or can execute this job. Verify with manual dispatch before relying on the schedule.

## Opt into GitHub Actions in your own repository

This is an example you can create as `.github/workflows/topology-refresh.yml` in your own deployment repository. It is not an enabled GitHub workflow in this repository. Configure the same three secrets described above and keep the code and workflow on your repository's default branch.

The checkout commit is the official `actions/checkout` v6.1.0 commit used by the Forgejo checkout mirror. The setup-bun commit is the same official pinned ref as the Forgejo workflow.

```yaml
name: Refresh remote transit topology

on:
  schedule:
    - cron: "0 4 * * *"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: remote-transit-topology
  cancel-in-progress: false

jobs:
  refresh:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    defaults:
      run:
        shell: bash
    steps:
      - name: Check out repository
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          persist-credentials: false
      - name: Set up Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: "1.4.2"
      - name: Install locked dependencies
        run: bun install --frozen-lockfile
      - name: Refresh assigned seed agencies
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          TOPOLOGY_WRANGLER_CONFIG: ${{ secrets.TOPOLOGY_WRANGLER_CONFIG }}
          WRANGLER_SEND_METRICS: "false"
          CI: "true"
        run: |
          set +x
          set -euo pipefail
          : "${CLOUDFLARE_API_TOKEN:?Missing CLOUDFLARE_API_TOKEN secret}"
          : "${CLOUDFLARE_ACCOUNT_ID:?Missing CLOUDFLARE_ACCOUNT_ID secret}"
          : "${TOPOLOGY_WRANGLER_CONFIG:?Missing TOPOLOGY_WRANGLER_CONFIG secret}"
          : "${RUNNER_TEMP:?Runner must provide RUNNER_TEMP}"
          umask 077
          config_dir="$(mktemp -d "$RUNNER_TEMP/topology-refresh.XXXXXX")"
          trap 'rm -rf "$config_dir"' EXIT
          config="$config_dir/wrangler.json"
          printf '%s' "$TOPOLOGY_WRANGLER_CONFIG" > "$config"
          chmod 600 "$config"
          unset TOPOLOGY_WRANGLER_CONFIG
          bun scripts/refresh-topology.ts --config="$config"
```

`ubuntu-latest` consumes GitHub-hosted CI minutes, subject to your account's allowances and billing. To avoid GitHub-hosted compute, replace it with `runs-on: [self-hosted, linux, x64, topology-refresh]` and register a suitable runner with those labels. That runner must support Node 24-based actions and Bun. Self-hosting is not a promise of zero costs; check current GitHub billing and your host's costs. Alternatively, use cron, systemd, a container scheduler, or Forgejo.

There are no PR or push triggers, credential-bearing install steps, artifact uploads, or deployment steps in this example. GitHub schedules can run late; this is a daily opportunity, not a guaranteed exact start time.

## Interpret results and handle repairs

All runners use the same weekday assignment and seven-day TTL. Only registered agencies with seed topology participate. Assignment is deterministic for the registered set and spreads agencies across weekdays; changing that set can rebalance assignments. Each daily cycle checks only that day's agencies and skips fresh topology.

The CLI uses the current time by default. Its only optional flag supplies an exact UTC ISO timestamp, for example:

```sh
bun scripts/refresh-topology.ts --config=/etc/schematic/topology-wrangler.json --scheduled-time=2026-09-30T04:00:00Z
```

Accepted timestamps have seconds and either no fractional part or exactly three fractional digits, ending in `Z`. Offsets, date-only strings, and normalized invalid dates are rejected. This flag selects the weekday and supplies the freshness clock. It does not force all agencies to refresh, bypass the TTL, replay missing days, or fetch a historical feed. Use manual seeding for an urgent update or repair rather than overriding the clock. The CLI has no initial-seed or force flag.

| Result         | Meaning                                                                 | Operator action                                                                                |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `skipped`      | Topology is still fresh                                                 | None                                                                                           |
| `needs-seed`   | The agency has no stored topology                                       | Run a targeted manual seed; automatic refresh does not fetch feeds or provision that partition |
| `unchanged`    | Matching archive/configuration hash or effectively identical projection | None; remote D1 receives zero writes, including no schema or metadata writes                   |
| `updated`      | The remote projection changed                                           | Review any moved-stop warnings; only changed rows and required metadata are written            |
| `refreshed`    | The self-hosted source completed its sync                               | Completion alone does not mean rows changed                                                    |
| Agency failure | That agency could not refresh                                           | Check credentials, network, and feed health; other assigned agencies still run                 |

The remote CLI exits nonzero for invalid input, a cycle-level failure, or any failed agency. `needs-seed` is a warning, not a failure exit. Monitor both the exit status and the per-agency outcomes. Automatic retry is at the agency's next weekly opportunity, not the next daily cycle.

No-op checks do not advance `topology_meta.last_sync`. It records a topology change, not the last successful check, so unchanged topology can remain TTL-due and be checked again the following week. Request reads remain write-free. Existing warm topology caches can serve older data for up to ten minutes after a write.

Manual seeding is the authority for initial population, emergency changes, and destination repair. Verification ignores stored destination hash metadata and compares actual rows, even when that metadata contains invalid JSON. It still writes only differences. Use `bun scripts/seed.ts --agency=AGENCY_ID --db=sqlite` for self-hosting or `--db=remote` for configured remote D1.

Automatic refresh changes database topology only. It does not regenerate compiled `stationIndex` or regional interchanges. After moved-stop warnings, regenerate in your operator checkout, review and commit the generated changes, then deploy them through your normal process:

```sh
bun scripts/seed.ts --agency=AGENCY_ID --db=sqlite
bun scripts/seed.ts --interchange-only
```

The interchange command requires the relevant local agency databases to be populated. See [ADR-0005](../adr/0005-surface-topology-reads-and-refresh.md) and [ADR-0009](../adr/0009-two-database-storage-topology.md#incremental-seeding) for the refresh and storage rules.
