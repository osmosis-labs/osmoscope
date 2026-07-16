# IBC rate-limit monitor

Watches the onchain IBC rate limiter and does two jobs:

1. **Trip alerting.** Every 15 minutes the `/api/cron/rate-limits` route dumps
   the rate limiter contract's state, computes how much of each quota window
   is consumed, and posts to a Telegram channel when a window crosses 80%
   (warn), 95% (urgent), or 100% (actively blocking transfers), plus an
   all-clear when it recovers. Alerts fire on level changes only, never on
   steady state.
2. **Flow history.** Each run stores a snapshot (deduped to one row per UTC
   hour) of every configured path's caps and net flows in
   `rate_limit_snapshots`, plus one queryable row per quota window in
   `rate_limit_readings` (timestamp, channel, denom, quota name, raw
   channelValue/inflow/outflow — net movement, net % and utilization are all
   derivable). The accumulated history is the flow baseline for the quarterly
   rate-limit review, replacing the discontinued range.org dashboard.

## How enumeration works

The deployed rate limiter (`osmo17r7qdw2zk6jyw62cvwm6flmhtj9q7zd26r8zc6sqyf0pnaq46cfss8hgxg`)
has no list-all-quotas query. The monitor dumps raw contract state and decodes
the cw-storage-plus keys under the `flow` namespace as (channel, denom);
entries with an empty quota list carry no limit and are skipped. The contract
enforces NET flow per window against a channel-value snapshot taken at window
start, and clamps quota percentages above 100 to 100.

Two situations are deliberately not alerted on:

- **Expired windows** (period end in the past): the contract lazily resets
  them on the next transfer, so their counters no longer bind.
- **Directions with a 0% cap**: deliberate one-way wind-down closures
  (deposits blocked by design, e.g. dead-bridge assets).

## Setup

1. Apply the schema (adds `rate_limit_snapshots`, `rate_limit_alert_states`,
   and `rate_limit_readings`). Note: while sibling branches with their own
   schema additions are unmerged, apply the three CREATE TABLEs surgically via
   `prisma db execute` rather than `db push` (push would drop the siblings'
   objects).
2. Create the Telegram bot: message @BotFather, `/newbot`, keep the token.
3. Create a private channel, add the bot as an administrator, then get the
   chat id: post a message in the channel and read `chat.id` from
   `https://api.telegram.org/bot<TOKEN>/getUpdates` (channel ids look like
   `-100xxxxxxxxxx`).
4. Set Vercel env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. `CRON_SECRET`
   is shared with the existing crons. With the Telegram vars unset the monitor
   still runs and logs would-be alerts, so it degrades to a log-only checker.
5. The cron is registered in `vercel.json` (`*/15 * * * *`).

Manual trigger:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/cron/rate-limits
```

## Delivery semantics

The snapshot is saved first, alerts are sent second, and alert states are
persisted last. If Telegram delivery fails the states are not advanced, so the
same transitions fire again on the next run (at-least-once) instead of being
swallowed by the de-duplication. Messages are HTML-escaped and chunked under
Telegram's 4096-character limit so one odd symbol or a mass-escalation event
can't wedge the batch. A failing run (DB outage, dump failure) sends a
best-effort "monitor degraded" notice, rate-limited to one per six hours per
warm instance, so a dead monitor is distinguishable from a quiet one.

A Slack transport is a potential follow-up alongside the Telegram bot setup;
`sendTelegramMessage` in `alerts.ts` is the seam to generalise.
