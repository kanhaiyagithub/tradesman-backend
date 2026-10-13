# Subscription expiry and stuck match notifications

## Migration (run first)

`npm run db:migrate` applies `20261013-0011`:
- `user_subscriptions.lastSyncedAt`
- `travel_plan_alert_matches`: `notificationAttempts`, `lastNotificationAttemptAt`, `notificationId`, `notificationError`, a `failed` status and a `(status, createdAt)` index.

The updated models use these columns, so **run the migration before deploying this code**, or match creation and subscription syncs will fail on unknown columns.

## Subscription expiry

Stripe webhooks remain the source of truth. Request-time checks read the local database only (no Stripe call per request).

**Access rule** (`services/subscriptionAccessService.js`, used by travel-plan create/update):
- Status `active`, `trialing` or `past_due` grants access. `past_due` means Stripe is still retrying the card, so access is kept. `unpaid`, `canceled`, `incomplete` do not.
- `currentPeriodEnd` must be in the future, with a grace window (`SUBSCRIPTION_ACCESS_GRACE_DAYS`, default 2) in case a renewal webhook is late. A null period end does not block access.
- `invoice.payment_failed` only moves `active`/`trialing` subscriptions to `past_due`, so a failed *first* payment never grants access.

**Daily re-sync** (`services/subscriptionResyncService.js`, started by the background worker):
- Runs daily at `SUBSCRIPTION_RESYNC_RUN_HOUR` (default 3, server local time); `npm run subscriptions:resync` runs it once.
- Picks non-canceled subscriptions whose `currentPeriodEnd` has passed, or that were never synced / not synced for `SUBSCRIPTION_RESYNC_STALE_HOURS` (default 72), up to `SUBSCRIPTION_RESYNC_BATCH_SIZE` (default 200) per run.
- Fetches the real subscription from Stripe and applies it with the existing `syncSubscriptionFromStripe`. A failure on one row is logged and does not stop the rest.
- `syncSubscriptionFromStripe` now also reads the billing period from the subscription items (newer Stripe API versions), maps `incomplete_expired`/`paused` to ENUM-safe values, and sets `lastSyncedAt`.

**Telling the user**
- `invoice.payment_failed` stores an in-app notification and sends a push (`type: payment_failed`, `action: open_billing_portal`, plus `attemptCount` and `nextPaymentAttempt`). Failed first payments are skipped because checkout shows that error itself.
- `POST /api/subscriptions/billing-portal` (auth) returns `{ url }`, a short-lived Stripe customer portal link. The app should call it when the user taps the notification (do not store the link). Return URL: `BILLING_PORTAL_RETURN_URL` (default `APP_BASE_URL`).
- Stripe dashboard (not code): turn on *Settings > Billing > Subscriptions and emails > Send emails when card payments fail*, set the retry schedule under *Smart Retries*, and activate the customer portal under *Settings > Billing > Customer portal*.

## Stuck match notifications

A match row is saved before its push is sent, and the in-app notification is stored first, so the inbox entry is always the fallback.

- `createMatchAndNotify` now marks a match `notified` only when a push actually reached a device. If the push failed (no token, FCM error) the match stays `pending` with `notificationAttempts = 1`. Before this change it was marked `notified` as soon as the inbox row was stored.
- `services/matchNotificationRetryService.js` runs every `MATCH_NOTIFICATION_RETRY_INTERVAL_MS` (default 5 min) in the background worker; `npm run matches:retry-notifications` runs one pass.
- It picks `pending` matches younger than 24 hours with fewer than `MATCH_NOTIFICATION_MAX_ATTEMPTS` (default 5) attempts, retries when `base * 2^(attempts-1)` has elapsed (`MATCH_NOTIFICATION_RETRY_BASE_MS`, default 5 min: 5, 10, 20, 40 minutes) and marks the match `failed` at the limit.
- Retries re-send only the push and update the existing inbox row's delivery status; a second inbox row is never created unless the first was never stored.
- Jobs are guarded by the MySQL named lock, so several instances are safe. Cron or the existing worker is enough at this volume.

## Environment variables (all optional)

| Variable | Default |
| --- | --- |
| `SUBSCRIPTION_ACCESS_GRACE_DAYS` | `2` |
| `SUBSCRIPTION_RESYNC_RUN_HOUR` / `_RUN_MINUTE` | `3` / `0` |
| `SUBSCRIPTION_RESYNC_RUN_ON_START` | `false` |
| `SUBSCRIPTION_RESYNC_STALE_HOURS` | `72` |
| `SUBSCRIPTION_RESYNC_BATCH_SIZE` | `200` |
| `BILLING_PORTAL_RETURN_URL` | `APP_BASE_URL` |
| `MATCH_NOTIFICATION_MAX_ATTEMPTS` | `5` |
| `MATCH_NOTIFICATION_RETRY_BASE_MS` | `300000` |
| `MATCH_NOTIFICATION_RETRY_INTERVAL_MS` | `300000` |

## Not changed

Checkout, upgrade/downgrade/cancel and the duplicate-subscription guards still treat only `active`/`trialing` as "current". A `past_due` user is not blocked from access, but cannot start a second subscription or use those manage endpoints until the card is fixed or Stripe moves the status.
