# Step 9 - Stripe And Subscription Safety

This document explains the Stripe/subscription safety work completed after the audit.

## Changes Implemented

### Webhook Signature Configuration

`POST /api/subscriptions/webhook` now checks that:

- `STRIPE_WEBHOOK_SECRET` is configured.
- the Stripe signature is valid before processing.

The webhook route is still mounted before `express.json()` so Stripe receives the raw body for signature verification.

### Webhook Idempotency

Added migration:

```text
migrations/20260918-0008-stripe-webhook-events.js
```

Added model:

```text
models/StripeWebhookEvent.js
```

The table stores:

- `eventId`
- `eventType`
- `processedAt`

If Stripe retries an already-processed event, the backend returns:

```json
{
  "received": true,
  "duplicate": true
}
```

and skips duplicate processing.

### Webhook Sync Behavior Preserved

The existing sync paths remain in place:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

## Deployment Note

Run migrations on EC2:

```bash
npm run db:migrate
```

Make sure live `.env` has:

```env
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

## Test Coverage

Covered in `tests/security-lockdown.test.js`:

- signed Stripe webhook is accepted
- webhook event is recorded as processed
- duplicate Stripe event is acknowledged without reprocessing

## Remaining Follow-Ups

- Add a receipt/invoice table if admin revenue must reflect paid Stripe invoices exactly.
- Add tests for subscription lifecycle sync with representative Stripe event payloads.
- Add alerting for repeated webhook processing failures.

