# Step 11 - Production Settings Review

This step is review-only. No code, config, or `.env` changes are part of Step 11 unless they are separately approved.

Step 11 covers only:

- `.env`
- config loading/caching
- logs
- production-safe settings

## `.env` Review

Do not commit `.env`. If live-looking secrets were shared outside the EC2 host or copied into local/dev machines, rotate them before production use.

High-priority secrets to keep private and rotate if exposed:

- SMTP password
- Google client secret
- Stripe secret key
- Stripe webhook secret
- JWT secret
- session secret

For the live EC2 API process, verify:

```env
NODE_ENV=production
ENABLE_API_BACKGROUND_JOBS=false
```

Run background jobs as a separate process:

```bash
npm run jobs:worker
```

## Config Loading And Caching Review

Confirm environment values are loaded once at process startup and are not repeatedly re-read or mutated during requests.

Review targets:

- `.env` is loaded from the project root.
- production startup fails clearly when required settings are missing.
- secrets are read from environment variables, not hardcoded.
- environment defaults are safe for local development but not silently unsafe in production.

## Logs Review

Confirm production logs are useful but do not expose sensitive values.

Review targets:

- no passwords, reset tokens, Stripe secrets, JWTs, or Google secrets in logs
- request logs are enabled intentionally
- PM2 or the EC2 process manager captures both API and background job logs
- webhook/job errors are logged with enough context to debug without dumping secrets

## Production-Safe Settings Review

Confirm production settings are explicit for:

- CORS allowed origins
- API base URL
- frontend URL
- secure session secret
- JWT secret
- Google OAuth callback URL
- Stripe webhook secret
- background jobs disabled inside the API process
- upload storage behavior

## Production Env Checklist

Verify these values in the live EC2 `.env`:

```env
NODE_ENV=production
PORT=5000
APP_BASE_URL=https://api.example.com
FRONTEND_URL=https://app.example.com
CORS_ALLOWED_ORIGINS=https://app.example.com
SESSION_SECRET=replace-with-32-plus-character-random-secret
JWT_SECRET=replace-with-32-plus-character-random-secret

DB_HOST=your-db-host
DB_PORT=3306
DB_NAME=your-db-name
DB_USER=your-db-user
DB_PASS=your-db-password

GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=https://api.example.com/api/auth/google/callback
GOOGLE_MOBILE_CLIENT_ID=your-mobile-google-client-id
GOOGLE_CLIENT_IDS=optional-extra-client-id-1,optional-extra-client-id-2

STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_EPHEMERAL_KEY_API_VERSION=2026-03-25.dahlia

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-email@example.com
SMTP_PASS=your-smtp-password
SMTP_FROM="Touring Trades <your-email@example.com>"

STORAGE_DRIVER=local
LOCAL_UPLOAD_ROOT=uploads
LOCAL_UPLOAD_PUBLIC_BASE=/uploads

ENABLE_API_BACKGROUND_JOBS=false
LOG_HTTP_REQUESTS=true
```
