# Contributing to Schematic

Set up local development here, then follow the implementation standards below.

## Development setup

### Prerequisites

- [Bun](https://bun.sh) (v1.2 or later)
- Git

### Initial setup

```bash
# 1. Clone the repository
git clone https://github.com/joncrangle/schematic.git
cd schematic

# 2. Install dependencies (frozen lockfile)
bun install --frozen-lockfile

# 3. Copy environment configuration
cp .env.example .env
cp wrangler.sample.jsonc wrangler.jsonc

# 4. Build the service worker
bun run build:sw

# 5. Start local development server
bun run dev
```

The app will be accessible at `http://localhost:3000`. The sample Wrangler config provides the local database bindings without a Cloudflare account or production database IDs.

To populate local TTC stops, routes, and schedules for nearby departures:

```bash
bun scripts/seed.ts --agency=ttc --db=both
```

Agency API keys and Web Push keys are optional for basic development. Feeds requiring missing keys and notifications requiring missing push configuration remain unavailable. See [local development and testing](docs/development.md) for seeding other agencies, generating push keys, simulating alerts, and testing on a phone.

Rust and Protoc are only needed to build or modify the [optional alert proxy daemon](services/alert-feed-daemon/README.md). It is useful when the deployment host cannot fetch an upstream alert feed directly, including operators that block Cloudflare egress. A residential self-host can fetch accessible feeds directly, and a prebuilt daemon container needs no Rust toolchain. Shared alert parser changes follow [parser parity](CODING_STANDARDS.md#parser-parity).

To test PWA service worker caching and geolocation over SSL locally, start with HTTPS enabled:

```bash
bun run dev:https
```

### Adding an agency

Follow the [agency guide](docs/add-an-agency.md) for manifest authoring,
registration, initial seeding, validation, and deployment. Agency contributions
must meet the [live-service standards](CODING_STANDARDS.md#agencies-and-live-service)
and [attribution requirements](CODING_STANDARDS.md#data-attribution-and-credentials).

## Implementation and review

Read the [coding standards](CODING_STANDARDS.md) sections matching your change
or review. Use the
[local test commands](docs/development.md#tests) for focused runner commands.
Consult [ADRs](docs/adr/) for architecture decisions and
[GLOSSARY.md](GLOSSARY.md) for domain vocabulary.
