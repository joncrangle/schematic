# syntax=docker/dockerfile:1
# Multi-stage build for alert-feed-daemon
FROM rust:alpine AS builder

# Install protobuf compiler required by prost-build
RUN apk add --no-cache protobuf musl-dev

WORKDIR /app

# Copy workspace files
COPY Cargo.toml Cargo.lock ./
COPY proto/ proto/
COPY services/alert-feed-daemon/ services/alert-feed-daemon/

# Build release binary with cargo cache mounts
# Baseline x86-64 on amd64 hosts keeps AWS-LC's startup CPU probe free of AVX.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    if rustc -vV | grep -q '^host: x86_64'; then \
      export CFLAGS="-march=x86-64 -mno-avx -mno-avx2"; \
      export AWS_LC_SYS_CFLAGS="$CFLAGS"; \
      export RUSTFLAGS="-C target-cpu=x86-64"; \
    fi; \
    cargo build --release -p alert-feed-daemon && \
    cp /app/target/release/alert-feed-daemon /usr/local/bin/alert-feed-daemon

# Minimal runtime image
FROM alpine:latest AS runner

# ca-certificates needed for upstream HTTPS scraping
RUN apk add --no-cache ca-certificates

WORKDIR /app

RUN mkdir -p /etc/alert-feed-daemon
COPY services/alert-feed-daemon/feeds.json /etc/alert-feed-daemon/feeds.json

COPY --from=builder /usr/local/bin/alert-feed-daemon /usr/local/bin/alert-feed-daemon

ENV PORT=3001 \
    ALERT_FEED_CONFIG=/etc/alert-feed-daemon/feeds.json
EXPOSE 3001

USER 1000:1000

ENTRYPOINT ["alert-feed-daemon"]
