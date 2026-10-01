# Commit Summary: 9e46c89 and e01ca41

Review date: 2026-09-23

Commits covered:

- `9e46c893ae578674d134b69f2e984a7577b8333f`
- `e01ca41c9827ae12787deb6d799ee2b60f353e5c`

Backend path: `tradesman-backend`

## Commit 1: `9e46c893ae578674d134b69f2e984a7577b8333f`

Title:

`fix: resolve Bugbot findings - Google OAuth email linking, rate limit IP trust, Stripe webhook race condition`

Files changed:

- `tradesman-backend/app.js`
- `tradesman-backend/config/passport.js`
- `tradesman-backend/controllers/stripeWebhookController.js`
- `tradesman-backend/middlewares/rateLimitMiddleware.js`

### What Was Done

1. Added Express proxy trust configuration.

   File:

   - `tradesman-backend/app.js`

   Change:

   - Added `app.set('trust proxy', 1)`.

   What it solves:

   - Allows Express to correctly determine the client IP address when the app is running behind one reverse proxy, such as nginx, a load balancer, or a hosting platform proxy.
   - Supports safer rate limiting in proxied production environments because `req.ip` can reflect the real client IP instead of only the proxy IP.

2. Changed the rate limiter to use Express `req.ip`.

   File:

   - `tradesman-backend/middlewares/rateLimitMiddleware.js`

   Change:

   - Removed direct parsing of the `X-Forwarded-For` header.
   - Uses `req.ip || req.socket?.remoteAddress || "unknown"` as the rate-limit key source.

   What it solves:

   - Reduces custom, error-prone IP parsing logic.
   - Lets Express handle trusted proxy behavior consistently.
   - Helps avoid blindly trusting raw `X-Forwarded-For` headers inside the rate limiter itself.

3. Updated Google OAuth account linking.

   File:

   - `tradesman-backend/config/passport.js`

   Change:

   - Reads Google email and Google profile ID into local variables.
   - Looks up users by email so existing accounts can be linked to Google login.
   - If an existing user is found, the code can attach `googleId`, set provider to `google`, mark the user verified, and fill missing profile image.
   - If no user exists, creates a new Google-backed user.

   What it solves:

   - Helps users who already registered with an email/password account sign in with Google using the same email address.
   - Prevents duplicate accounts for the same email when a user switches to Google OAuth.
   - Improves account continuity between manual and Google login methods.

4. Added Stripe webhook duplicate/race protection.

   File:

   - `tradesman-backend/controllers/stripeWebhookController.js`

   Change:

   - Stores incoming Stripe webhook event IDs in `StripeWebhookEvent`.
   - Adds `processedAt` when creating or updating the event record.
   - Returns `{ received: true, duplicate: true }` when the same processed event is received again.

   What it solves:

   - Attempts to prevent the same Stripe event from being processed more than once.
   - Reduces duplicate subscription updates from repeated Stripe webhook deliveries.
   - Helps protect billing state from duplicate event handling.

## Commit 2: `e01ca41c9827ae12787deb6d799ee2b60f353e5c`

Title:

`security: harden Google OAuth - verify email ownership and prevent account takeover`

Files changed:

- `tradesman-backend/config/passport.js`

### What Was Done

1. Added a required Google profile email check.

   File:

   - `tradesman-backend/config/passport.js`

   Change:

   - Reads `profile.emails?.[0]` into `emailEntry`.
   - Rejects Google login if no email value exists.

   What it solves:

   - Prevents creating or linking accounts when Google does not provide an email address.
   - Avoids users being created with missing or invalid email data.

2. Added Google email verification handling.

   File:

   - `tradesman-backend/config/passport.js`

   Change:

   - Rejects Google login when `emailEntry.verified === false`.

   What it solves:

   - Prevents login/linking when Google explicitly says the email is not verified.
   - Reduces account takeover risk from unverified Google email data.

3. Normalized Google email addresses to lowercase.

   File:

   - `tradesman-backend/config/passport.js`

   Change:

   - Converts the Google email to lowercase with `String(emailEntry.value).toLowerCase()`.

   What it solves:

   - Avoids duplicate accounts caused by case differences, such as `User@Test.com` and `user@test.com`.
   - Makes email lookup behavior more consistent with unique email rules.

4. Changed lookup order to prefer existing Google ID first.

   File:

   - `tradesman-backend/config/passport.js`

   Change:

   - First searches for an existing user by `googleId`.
   - Only searches by email if no matching Google user is found.

   What it solves:

   - Keeps existing Google-linked accounts stable.
   - Avoids accidentally linking a Google login to a different account just because an email match exists.

5. Restricted automatic linking to safer existing accounts.

   File:

   - `tradesman-backend/config/passport.js`

   Change:

   - If an existing account has the same email, it only auto-links when that account is already verified or already Google-based.
   - Rejects linking to unverified password-only accounts.

   What it solves:

   - Prevents a pre-registration account takeover pattern.
   - Protects unverified manual accounts from being claimed through Google OAuth before email ownership is confirmed in the local app.

6. Updates existing Google users without overwriting all profile data.

   File:

   - `tradesman-backend/config/passport.js`

   Change:

   - Adds missing profile image if the user does not already have one.
   - Marks existing Google users verified if needed.

   What it solves:

   - Keeps Google-linked accounts fresh without overwriting existing user profile data unnecessarily.
   - Ensures older Google users are marked verified after successful Google authentication.

## Problems These Two Commits Are Intended to Solve

1. Duplicate Stripe webhook processing.

   The Stripe changes try to stop repeated delivery of the same webhook event from applying billing/subscription changes more than once.

2. Incorrect client IP detection behind proxies.

   The proxy and rate-limit changes try to make IP-based throttling work correctly when the backend is deployed behind a reverse proxy.

3. Duplicate accounts from Google login.

   The OAuth changes try to link Google login to an existing account with the same email instead of creating a second user account.

4. Google OAuth account takeover risk.

   The second commit specifically tries to prevent unsafe linking to unverified local accounts and reject explicitly unverified Google emails.

5. Email case inconsistency.

   Lowercasing Google email addresses helps avoid duplicate records and failed lookups caused by case differences.

## Test Result After These Commits

Command run from `tradesman-backend`:

```bash
npm test
```

Result:

- Passed.
- 26 tests passed.
- 0 tests failed.

Additional checks:

- `node --check app.js` passed.
- `node --check config/passport.js` passed.
- `node --check controllers/stripeWebhookController.js` passed.
- `node --check middlewares/rateLimitMiddleware.js` passed.

## Related Review Document

Detailed issue review:

- `tradesman-backend/docs/commit-review-9e46c89-e01ca41.md`
