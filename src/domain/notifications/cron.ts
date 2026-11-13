/** The cron expression that evaluates active alerts and sends Web Push. */
export const ALERT_EVALUATION_CRON = "* * * * *";

/**
 * The cron expression that evaluates slow-moving alert sources (`web` boards,
 * `rss` feeds). Content there changes on hours/days timescales, so polling it
 * every minute burns subrequests without new information. Both expressions are
 * code-owned; wrangler.jsonc mirrors them for deployment.
 */
export const SLOW_ALERT_EVALUATION_CRON = "*/15 * * * *";
