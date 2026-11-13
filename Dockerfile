# syntax=docker/dockerfile:1

ARG ASSETS=source

# Build and seed natively on the host CPU for both target architectures.
FROM --platform=$BUILDPLATFORM oven/bun:1-slim AS build-base

WORKDIR /app

# Install build dependencies
COPY package.json bun.lock tsconfig.json ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Copy application source code
COPY . .

ENV NODE_ENV=production

FROM build-base AS assets-source
RUN bun run build

FROM build-base AS assets-ci
COPY --from=ci-assets /dist ./dist
COPY --from=ci-assets /public/sw.js ./public/sw.js

FROM assets-${ASSETS} AS builder

# Cloudflare tooling may copy local development vars beside the generated
# worker. Never allow credentials to cross into the production image.
RUN rm -f dist/worker/.dev.vars*

# Pre-generate SQLite datasets from GTFS
RUN bun run seed --agency=all --db=sqlite

# Stage 2: Production runner environment
FROM oven/bun:1-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

# Create persistent storage directory for SQLite and set permissions
RUN mkdir -p /app/data /app/templates /app/scripts/lib && chown -R bun:bun /app

# Copy application artifacts
COPY --from=builder --chown=bun:bun /app/package.json /app/bun.lock ./
COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --from=builder --chown=bun:bun /app/scripts/start-server.ts ./scripts/start-server.ts
COPY --from=builder --chown=bun:bun /app/scripts/lib/server-bootstrap.ts ./scripts/lib/server-bootstrap.ts
COPY --from=builder --chown=bun:bun /app/public ./public
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules

# Copy pre-generated database templates from builder (ADR-0009: transit.db + push-notifications.db)
COPY --from=builder --chown=bun:bun /app/data/*.db /app/templates/

# Copy entrypoint script
COPY --chown=bun:bun docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

USER bun

EXPOSE 3000

VOLUME ["/app/data"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
