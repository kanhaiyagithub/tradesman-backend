# Commit Review: 9e46c89 and e01ca41

Review date: 2026-09-23

Commits reviewed:

- `9e46c893ae578674d134b69f2e984a7577b8333f` - `fix: resolve Bugbot findings - Google OAuth email linking, rate limit IP trust, Stripe webhook race condition`
- `e01ca41c9827ae12787deb6d799ee2b60f353e5c` - `security: harden Google OAuth - verify email ownership and prevent account takeover`

Backend path reviewed: `tradesman-backend`

## Summary

The backend test suite passes on the current checkout, and the changed files pass syntax checks. However, the Stripe webhook race-condition change introduces a retry-safety issue: events are marked as processed before the business logic succeeds. If processing fails after that point, a Stripe retry can be treated as a duplicate and skipped.

## Files Changed by the Commits

- `app.js`
- `config/passport.js`
- `controllers/stripeWebhookController.js`
- `middlewares/rateLimitMiddleware.js`

## Findings

### High: Stripe webhook events can be skipped after failed processing

Primary location:

- `tradesman-backend/controllers/stripeWebhookController.js:123`
- `tradesman-backend/controllers/stripeWebhookController.js:130`
- `tradesman-backend/controllers/stripeWebhookController.js:134`
- `tradesman-backend/controllers/stripeWebhookController.js:203`

Exact code behavior:

- `tradesman-backend/controllers/stripeWebhookController.js:123` sets `processedAt: new Date()` inside the `findOrCreate` defaults. This means a new Stripe event is marked as processed before the handler actually runs the event-specific business logic.
- `tradesman-backend/controllers/stripeWebhookController.js:130` returns `{ received: true, duplicate: true }` whenever an existing row has `processedAt`.
- `tradesman-backend/controllers/stripeWebhookController.js:134` also sets `processedAt` before event-specific work for an existing row that does not already have it.
- `tradesman-backend/controllers/stripeWebhookController.js:203` confirms the intended behavior with the comment that `processedAt` was already set earlier for race protection.

Detailed explanation:

The commit tries to prevent duplicate Stripe webhooks from being processed concurrently. That goal is good, but the implementation reuses `processedAt` to mean two different states:

- "processing has started"
- "processing completed successfully"

Those states need to be separate. Stripe webhooks are retry-based: if the app returns `500`, Stripe sends the same event again later. With the current logic, a failure can happen after the row is created with `processedAt` already populated. On retry, the same event ID is found, line 130 sees `processedAt`, and the handler returns a duplicate success response without retrying the subscription/payment update.

Concrete failure scenario:

1. Stripe sends `customer.subscription.updated`.
2. `StripeWebhookEvent.findOrCreate` inserts the event row and sets `processedAt` at `tradesman-backend/controllers/stripeWebhookController.js:123`.
3. `syncSubscriptionFromStripe(data)` runs and fails because Stripe API, MySQL, or a validation path errors.
4. The catch block returns `500`, so Stripe retries the same event.
5. The retry finds the existing row, sees `processedAt`, hits `tradesman-backend/controllers/stripeWebhookController.js:130`, and exits as duplicate.
6. The subscription state is never updated locally, even though Stripe retried correctly.

Impact:

This can permanently lose subscription lifecycle updates such as activation, cancellation, renewal payment success, and payment failure. Because webhook processing controls billing state, this can create user access mismatches: paid users may not be activated, cancelled users may remain active, or failed payments may not be reflected.

Recommended fix:

Do not set `processedAt` until after the event-specific switch block completes successfully. For race protection, add a separate state field such as `status` with values like `processing`, `processed`, and `failed`, or add a separate `processingStartedAt` field. Then make duplicate skipping depend only on the successful terminal state, not on the in-progress marker.

Safer implementation shape:

```js
// Pseudocode only
const [webhookEvent, created] = await StripeWebhookEvent.findOrCreate({
  where: { eventId: event.id },
  defaults: {
    eventId: event.id,
    eventType: event.type,
    status: "processing",
    processingStartedAt: new Date(),
  },
});

if (!created && webhookEvent.status === "processed") {
  return res.json({ received: true, duplicate: true });
}

// Run business logic here.

await webhookEvent.update({
  status: "processed",
  processedAt: new Date(),
});
```

Suggested follow-up test:

Add a test that forces a webhook handler path to throw after the event row exists, then sends the same Stripe event again. The expected behavior should be that the retry is not treated as a duplicate until processing succeeds.

Existing test gap:

`tradesman-backend/tests/security-lockdown.test.js` includes the test `stripe webhook records processed events and ignores duplicates`, but it only covers the success path. It verifies that a second delivery is skipped after the first delivery succeeds. It does not test the failure-after-marking path above.

### Medium: `trust proxy` is enabled unconditionally, which can weaken IP rate limiting in direct deployments

Primary location:

- `tradesman-backend/app.js:36`
- `tradesman-backend/middlewares/rateLimitMiddleware.js:5`

Exact code behavior:

- `tradesman-backend/app.js:36` calls `app.set('trust proxy', 1)` for every environment.
- `tradesman-backend/middlewares/rateLimitMiddleware.js:5` uses `req.ip` as the rate-limit key source.

Detailed explanation:

Express changes how `req.ip` is calculated when `trust proxy` is enabled. With `trust proxy` set to `1`, Express trusts the nearest proxy hop and reads client IP information from forwarded headers such as `X-Forwarded-For`.

That is correct when the app is always deployed behind exactly one trusted reverse proxy such as nginx, an AWS load balancer, or a platform proxy. It is risky if the Node process is reachable directly by clients, even accidentally, because a direct client can send its own `X-Forwarded-For` header. In that case, `req.ip` can become attacker-controlled, and the rate limiter in `tradesman-backend/middlewares/rateLimitMiddleware.js:5` can be bypassed by rotating/spoofing header values.

Concrete failure scenario:

1. The backend is deployed without a trusted reverse proxy in front of it, or a firewall accidentally exposes the Node port.
2. A client sends repeated login, password reset, or OTP requests.
3. The client changes `X-Forwarded-For` on every request.
4. Because `app.set('trust proxy', 1)` is enabled globally, Express may treat each spoofed value as a different `req.ip`.
5. The rate limiter stores each request under a different key, reducing or bypassing the intended limit.

Impact:

This can weaken brute-force protection, password reset throttling, OTP throttling, and any other route using the shared rate limiter. The risk depends heavily on production topology. If production is always behind one trusted proxy and direct access is blocked, this is acceptable. If not, it is a security issue.

Recommended fix:

Make proxy trust explicit per environment. For example:

```js
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}
```

For stronger production hardening, trust only known proxy IP ranges or exact hop counts documented in deployment configuration. Also ensure infrastructure blocks direct public access to the Node process.

Suggested follow-up test:

Add a rate-limit test that proves requests with different spoofed `X-Forwarded-For` values do not bypass throttling when `TRUST_PROXY` is disabled, and a separate deployment-config test or smoke check for environments where proxy trust is expected.

### Low: Google OAuth email verification should require a positive verified signal

Primary location:

- `tradesman-backend/config/passport.js:17`
- `tradesman-backend/config/passport.js:25`
- `tradesman-backend/config/passport.js:29`
- `tradesman-backend/config/passport.js:36`
- `tradesman-backend/config/passport.js:40`

Exact code behavior:

- `tradesman-backend/config/passport.js:17` reads the first email object from `profile.emails`.
- `tradesman-backend/config/passport.js:25` rejects the login only when `emailEntry.verified === false`.
- `tradesman-backend/config/passport.js:29` normalizes the email to lowercase.
- `tradesman-backend/config/passport.js:36` searches for an existing user by email.
- `tradesman-backend/config/passport.js:40` allows account linking when the existing user is already verified or has `provider === "google"`.

Detailed explanation:

The commit improves Google OAuth account linking substantially compared with the previous version. It lowercases the email, looks up existing Google users by `googleId`, and blocks linking to unverified password-only accounts. The remaining concern is that the verification check only rejects an explicit `false` value:

```js
if (emailEntry.verified === false) {
  return done(new Error("Google email is not verified"), null);
}
```

If `emailEntry.verified` is missing, undefined, or not mapped by the Passport profile object for any reason, the code treats it as acceptable. For account linking, the safer default is fail-closed: require a positive verified value before creating or linking the account.

Concrete failure scenario:

1. Google profile parsing returns an email address but no `verified` field in `profile.emails[0]`.
2. The user has an existing verified manual account with the same email.
3. The code reaches `tradesman-backend/config/passport.js:40` and links the Google ID because the existing local account is verified.
4. The linking decision happened without a positive verified-email signal from Google.

Impact:

The practical risk may be low with normal Google profile data, but this is security-sensitive account linking. A missing verification flag should not be treated the same as a verified email. Fail-closed behavior is safer and easier to reason about.

Recommended fix:

Require a positive verified signal. For example:

```js
const emailVerified =
  emailEntry.verified === true || profile._json?.email_verified === true;

if (!emailVerified) {
  return done(new Error("Google email is not verified"), null);
}
```

Suggested follow-up test:

Add Passport strategy unit coverage for three cases:

- verified Google email links or creates an account successfully.
- explicitly unverified Google email is rejected.
- missing verification value is rejected.

### Dependency audit: production dependency vulnerabilities remain

Primary location:

- `tradesman-backend/package.json`
- `tradesman-backend/package-lock.json`

Observed command:

- `npm audit --omit=dev --audit-level=high`

Detailed explanation:

The audit command failed because production dependencies include known advisories. This is not necessarily introduced by the two reviewed commits, but it is relevant to the backend health check because the current production dependency graph contains critical and high severity vulnerabilities.

Audit result:

- 33 production dependency vulnerabilities reported.
- 2 critical.
- 11 high.
- 18 moderate.
- 2 low.

Notable affected packages from the audit output:

- `protobufjs`
- `websocket-driver`
- `mysql2`
- `multer`
- `nodemailer`
- `ws`
- `engine.io`
- `sharp`
- `lodash`

Impact:

The impact varies by package and reachable code path. Several advisories are denial-of-service or injection related. Packages such as `multer`, `mysql2`, `nodemailer`, `ws`, and `engine.io` are especially worth triaging because this backend handles uploads, database connections, email, and sockets.

Recommended fix:

Run `npm audit fix` in a separate dependency-maintenance branch and retest. For advisories requiring breaking upgrades, upgrade deliberately package by package and run the full backend test suite after each set of changes.

## Testing Performed

Commands run from `tradesman-backend`:

```bash
npm ci
node --check app.js
node --check config/passport.js
node --check controllers/stripeWebhookController.js
node --check middlewares/rateLimitMiddleware.js
npm test
npm audit --omit=dev --audit-level=high
```

Results:

- `npm ci`: passed.
- Syntax checks: all changed files passed.
- `npm test`: passed, 26 tests passed and 0 failed.
- `npm audit --omit=dev --audit-level=high`: failed due to dependency advisories.

Audit summary:

- 33 production dependency vulnerabilities reported.
- Includes 2 critical, 11 high, 18 moderate, and 2 low severity vulnerabilities.
- Notable packages in the report include `protobufjs`, `websocket-driver`, `mysql2`, `multer`, `nodemailer`, `ws`, `engine.io`, `sharp`, and `lodash`.

## Notes

The existing webhook duplicate test proves that a successfully processed event is skipped on the second delivery. It does not cover the failure-after-marking case described above.
