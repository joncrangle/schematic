/** Bump with any STATEMENTS or lazy migration change; older databases re-run the idempotent bootstrap once. */
export const SUBSCRIPTION_SCHEMA_VERSION = 2;

/**
 * Schema for push-notification persistence tables, shared by every
 * SQLite/D1-backed repository so any entry point can bootstrap storage
 * independently (e.g. a push RPC that never builds the transit layer).
 *
 * IMPORTANT: each statement must live on a SINGLE physical line joined by
 * ";\n". Local miniflare D1's exec() splits input on newlines, so embedded
 * newlines inside a statement are parsed as statement terminators
 * ("incomplete input" errors). Remote D1 and bun/node sqlite accept this
 * form identically.
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS subscription_meta (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL DEFAULT 0, pruned_at INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO subscription_meta (id, schema_version, pruned_at) VALUES (1, 0, 0)`,
  `CREATE TABLE IF NOT EXISTS push_subscription_tombstones (endpoint_hash TEXT PRIMARY KEY, policy_revision INTEGER NOT NULL, deleted_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, favourite_lines_json TEXT, favourite_stations_json TEXT, favourite_routes_json TEXT, commute_schedules_json TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'America/Toronto', locale TEXT NOT NULL DEFAULT 'en-CA', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, policy_revision INTEGER NOT NULL DEFAULT 0, last_delivered_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS push_subscription_retry_state (subscription_id TEXT PRIMARY KEY REFERENCES push_subscriptions(id) ON DELETE CASCADE, retry_count INTEGER NOT NULL DEFAULT 0, hard_failure_count INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS alert_deliveries (id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, alert_id TEXT NOT NULL, incident_key TEXT NOT NULL, subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE, line_id TEXT, route_id TEXT, status TEXT NOT NULL, delivered_at INTEGER NOT NULL, locale TEXT NOT NULL DEFAULT 'en-CA', terminal_at INTEGER NOT NULL DEFAULT 0, UNIQUE(agency_id, alert_id, subscription_id))`,
  `CREATE TABLE IF NOT EXISTS alert_delivery_claims (agency_id TEXT NOT NULL, subscription_id TEXT NOT NULL, incident_key TEXT NOT NULL, locale_scope TEXT NOT NULL, alert_id TEXT NOT NULL, phase TEXT NOT NULL, owner_token TEXT NOT NULL, claimed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(agency_id, subscription_id, incident_key, locale_scope))`,
  `CREATE TABLE IF NOT EXISTS worker_recipient_cursors (cursor_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO worker_recipient_cursors (cursor_id, cursor) VALUES ('evaluate-alerts', 0)`,
  `INSERT OR IGNORE INTO worker_recipient_cursors (cursor_id, cursor) VALUES ('evaluate-slow-alerts', 0)`,
  `CREATE TABLE IF NOT EXISTS push_registration_windows (window_start INTEGER PRIMARY KEY, salt TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS push_registration_counts (client_key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_push_registration_counts_window ON push_registration_counts(window_start)`,
  `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_updated ON push_subscriptions(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert_sub ON alert_deliveries(alert_id, subscription_id)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_deliveries_outstanding ON alert_deliveries(agency_id, subscription_id) WHERE status = 'active_sent'`,
  `CREATE INDEX IF NOT EXISTS idx_alert_delivery_claims_expires ON alert_delivery_claims(expires_at)`,
];

export const ENSURE_SUBSCRIPTION_SCHEMA_SQL = `${STATEMENTS.join(";\n")};`;
