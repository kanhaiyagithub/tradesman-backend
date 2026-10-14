# Project Configuration and Integration Notes

This document summarizes the database tables/models, deployment paths, domain and SSL configuration, Firebase setup, and Stripe subscription webhook flow used by this backend.

## Database

The project uses MySQL through Sequelize.

- Database driver: `mysql2`
- ORM: `sequelize`
- Migration runner: `umzug`
- Migration metadata table: `SequelizeMeta`
- Runtime config: `config/db.js`
- Migration config: `config/config.js`
- Environment variables: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS`, `DB_POOL_MAX`, `DB_POOL_MIN`, `DB_POOL_ACQUIRE_MS`, `DB_POOL_IDLE_MS`

Runtime schema mutation with `sequelize.sync()` is not used. Schema changes should be added as migration files under `migrations/` and applied with:

```bash
npm run db:migrate
```

Useful commands:

```bash
npm run db:check
npm run db:migrate
npm run db:migrate:status
npm run db:migrate:down
```

## Database Tables and Models

### `admins`

Model: `models/AdminModel/adminModel.js`

Purpose: Stores admin login accounts.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `name` | string | Required |
| `email` | string | Required |
| `password` | string | Required, hashed by controller logic |
| `role` | enum | `admin`, defaults to `admin` |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

### `Users`

Model: `models/User.js`

Purpose: Stores client, tradesman, and admin-facing user records.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `name` | string | Required |
| `email` | string | Required |
| `mobile` | string | Optional |
| `password` | string | Optional for OAuth users |
| `role` | enum | `tradesman`, `client`, `admin`; defaults to `client` |
| `provider` | string | Defaults to `manual`; Google OAuth uses `google` |
| `googleId` | string | Google OAuth profile id |
| `profileImage` | string | Stored file key/path |
| `resetPasswordToken` | string | Password reset token |
| `resetPasswordExpires` | date | Password reset expiry |
| `isVerified` | boolean | Defaults to `false` |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Important relationships:

- `Users.hasOne(TradesmanDetails)` as `TradesmanDetail`
- `Users.hasMany(TravelPlan)` as `travelPlans`
- `Users.hasMany(ClientTradeAlert)` as `clientTradeAlerts`
- `Users.hasMany(Hire)` as `clientJobs` and `tradesmanJobs`
- `Users.hasMany(UserSubscription)` as `subscriptions`

### `TradesmanDetails`

Model: `models/TradesmanDetails.js`

Purpose: Stores tradesman profile, availability, license, portfolio, and approval data.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `userId` | integer | Required, references `Users.id`, cascade delete |
| `tradeType` | string | Display name |
| `tradeTypeId` | integer | Required |
| `businessName` | string | Optional |
| `shortBio` | text | Optional |
| `startDate` | date | Optional availability start |
| `endDate` | date | Optional availability end |
| `currentLocation` | string | GPS string, usually `lat,lng` |
| `licenseNumber` | string | Optional |
| `licenseExpiry` | date | Optional |
| `licenseDocument` | string | Stored file key/path |
| `portfolioPhotos` | json | Stored image key list |
| `portfolioDescription` | text | Optional |
| `isApproved` | boolean | Defaults to `false` |
| `approvedBy` | integer | Admin user id |
| `approvedAt` | date | Approval timestamp |
| `rejectionReason` | text | Optional |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- `userId`
- `tradeTypeId`
- `isApproved`

### `trades_type`

Model: `models/tradesTypeModel.js`

Purpose: Master list of supported trade types.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `name` | string | Required |
| `category` | string | Required |
| `isActive` | boolean | Defaults to `true` |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

### `travelplans`

Model: `models/locationModel.js`

Purpose: Stores tradesman travel plans, route coordinates, stops, timing, and status.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `tradesmanId` | integer | Required, references `Users.id` in migration |
| `currentLocation` | string | Optional |
| `latitude` | double | Optional current latitude |
| `longitude` | double | Optional current longitude |
| `startLocation` | string | Required |
| `startDateTime` | date | Required |
| `destination` | string | Required |
| `destinationLatitude` | double | Required |
| `destinationLongitude` | double | Required |
| `destinationDateTime` | date | Required |
| `priceRange` | string | Optional |
| `allowStops` | boolean | Defaults to `false` |
| `stops` | json | Stop list: `name`, `latitude`, `longitude`, `expectedDateTime` |
| `status` | enum | `open`, `running`, `closed`; defaults to `open` |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

### `client_trade_alerts`

Model: `models/clientTradeAlertModel.js`

Purpose: Stores client alerts for nearby matching tradesmen.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `clientId` | integer | Required, references `Users.id`, cascade delete |
| `tradeType` | string | Optional display name |
| `tradeTypeId` | integer | Required |
| `locationName` | string | Required |
| `latitude` | double | Required |
| `longitude` | double | Required |
| `radiusKm` | double | Defaults to `15` |
| `isActive` | boolean | Defaults to `true` |
| `startDate` | date | Optional |
| `endDate` | date | Optional |
| `lastMatchedAt` | date | Optional |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- `clientId`
- `tradeTypeId`
- `isActive`

### `travel_plan_alert_matches`

Model: `models/travelPlanAlertMatchModel.js`

Purpose: Stores matches between tradesman travel plans and client trade alerts.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `travelPlanId` | integer | Required |
| `tradesmanId` | integer | Required |
| `clientId` | integer | Required |
| `clientTradeAlertId` | integer | Required |
| `matchedStopName` | string | Optional |
| `matchedLatitude` | double | Optional |
| `matchedLongitude` | double | Optional |
| `matchedDistanceKm` | double | Optional |
| `estimatedArrivalDate` | date | Optional |
| `notificationSent` | boolean | Defaults to `false` |
| `notificationSentAt` | date | Optional |
| `status` | enum | `pending`, `notified`, `contacted`, `ignored`; defaults to `pending` |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- `travelPlanId`
- `clientId`
- `clientTradeAlertId`
- Unique: `travelPlanId`, `clientTradeAlertId`

### `tradesman_live_locations`

Model: `models/TradesmanLiveLocation.js`

Purpose: Stores one latest live location per tradesman.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `tradesmanId` | integer | Required, unique |
| `travelPlanId` | integer | Required |
| `latitude` | decimal(10,7) | Required |
| `longitude` | decimal(10,7) | Required |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

### `live_proximity_notifications`

Model: `models/LiveProximityNotification.js`

Purpose: Prevents duplicate live-proximity notifications for the same travel plan/client pair.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `tradesmanId` | integer | Required |
| `travelPlanId` | integer | Required |
| `clientId` | integer | Required |
| `clientTradeAlertId` | integer | Required |
| `lastNotifiedAt` | date | Required |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- Unique: `travelPlanId`, `clientId`

### `hires`

Model: `models/hireModel.js`

Purpose: Stores hire requests and job status between clients and tradesmen.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `clientId` | integer | Required, references `Users.id` |
| `tradesmanId` | integer | Required, references `Users.id` |
| `status` | enum | `pending`, `accepted`, `rejected`, `completed`, `cancelled`; defaults to `pending` |
| `jobDescription` | text | Optional |
| `requestCompletion` | boolean | Defaults to `false` |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

### `reviews`

Model: `models/reviewModel.js`

Purpose: Stores post-hire reviews.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `hireId` | integer | Required |
| `fromUserId` | integer | Required reviewer user id |
| `toUserId` | integer | Required reviewed user id |
| `rating` | integer | Required |
| `comment` | text | Optional |
| `role` | enum | `client` or `tradesman` |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- Unique: `hireId`, `fromUserId`

### `PortfolioPhotos`

Model: `models/PortfolioPhoto.js`

Purpose: Stores portfolio photo records for users.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `userId` | integer | Required |
| `image` | string | Stored image key/path |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

### `conversations`

Model: `models/conversationModel.js`

Purpose: Stores direct-chat conversation summaries.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint | Primary key, auto increment |
| `directKey` | string | Required unique user-pair key |
| `userOneId` | integer | Required |
| `userTwoId` | integer | Required |
| `lastMessageId` | bigint | Optional |
| `lastMessageSenderId` | integer | Optional |
| `lastMessagePreview` | text | Optional |
| `lastMessageAt` | date | Optional |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- Unique: `directKey`
- `lastMessageAt`
- `userOneId`
- `userTwoId`

### `conversation_participants`

Model: `models/conversationParticipantModel.js`

Purpose: Stores per-user chat state for each conversation.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint | Primary key, auto increment |
| `conversationId` | bigint | Required, references `conversations.id` |
| `userId` | integer | Required |
| `otherUserId` | integer | Required |
| `unreadCount` | integer | Defaults to `0` |
| `lastReadMessageId` | bigint | Optional |
| `lastReadAt` | date | Optional |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- Unique: `conversationId`, `userId`
- Unique: `userId`, `otherUserId`
- `userId`
- `userId`, `unreadCount`

### `messages`

Model: `models/messageModel.js`

Purpose: Stores direct-chat messages.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint | Primary key, auto increment |
| `conversationId` | bigint | Optional during migration window |
| `senderId` | integer | Required |
| `receiverId` | integer | Required |
| `conversationKey` | string | Required, generated as `smallerUserId_biggerUserId` |
| `message` | text | Required |
| `isRead` | boolean | Defaults to `false` |
| `deletedAt` | date | Soft-delete timestamp |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- `conversationId`, `createdAt`
- `conversationKey`, `createdAt`
- `receiverId`, `isRead`
- `senderId`, `receiverId`

### `notifications`

Model: `models/notificationModel.js`

Purpose: Persistent in-app notification inbox. Firebase push delivery is best effort; this table is the notification history source of truth.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint | Primary key, auto increment |
| `userId` | integer | Required, references `Users.id` |
| `title` | string(160) | Required |
| `body` | text | Required |
| `type` | string(60) | Defaults to `general` |
| `data` | json | Optional metadata |
| `isRead` | boolean | Defaults to `false` |
| `readAt` | date | Optional |
| `deliveryStatus` | enum | `pending`, `sent`, `failed`, `skipped`; defaults to `pending` |
| `deliveryError` | string(255) | Optional |
| `sentAt` | date | Optional |
| `expiresAt` | date | Required |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- `userId`, `createdAt`
- `userId`, `isRead`, `createdAt`
- `expiresAt`

### `device_tokens`

Model: `models/deviceTokenModel.js`

Purpose: Stores Firebase Cloud Messaging device tokens per user.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `user_id` | integer | Required, references `Users.id` in migration |
| `token` | string | Required, globally unique |

Notes:

- The helper reassigns an existing token to a new user if the same physical device logs into another account.
- Invalid FCM tokens are removed when Firebase returns a permanent token error.

### `subscription_plans`

Model: `models/SubscriptionPlan.js`

Purpose: Stores Stripe-backed subscription plan records.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `name` | string | Required |
| `priceMonthly` | decimal(10,2) | Required |
| `stripeProductId` | string | Optional |
| `stripePriceId` | string | Required, unique |
| `maxSharedLocations` | integer | Optional plan limit |
| `isDefault` | boolean | Defaults to `false` |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Configured plan names in `config/subscriptionPlans.js`:

| Key | Name | Monthly Price | Currency | Max Stops |
| --- | --- | --- | --- | --- |
| `basic` | Basic | 19 | AUD | 2 |
| `make_money` | Make Money | 44 | AUD | 5 |
| `pro` | Pro | 99 | AUD | 10 |

### `user_subscriptions`

Model: `models/UserSubscription.js`

Purpose: Stores each user's local Stripe subscription state.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `userId` | integer | Required, references `Users.id` |
| `planId` | integer | Required, references `subscription_plans.id` |
| `stripeCustomerId` | string | Stripe customer id |
| `stripeSubscriptionId` | string | Stripe subscription id, unique |
| `isEarlyAccess` | boolean | Defaults to `false` |
| `hasLifetimeDiscount` | boolean | Defaults to `false` |
| `trialEndsAt` | date | Optional |
| `status` | enum | `trialing`, `active`, `incomplete`, `past_due`, `canceled`, `unpaid`; defaults to `incomplete` |
| `currentPeriodStart` | date | Stripe period start |
| `currentPeriodEnd` | date | Stripe period end |
| `cancelAtPeriodEnd` | boolean | Defaults to `false` |
| `startDate` | date | Required |
| `endDate` | date | Optional |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

### `email_notification_logs`

Model: `models/EmailNotificationLog.js`

Purpose: Tracks match/reminder emails and prevents duplicate sends.

Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer | Primary key, auto increment |
| `type` | string(80) | Required |
| `travelPlanId` | integer | Optional |
| `clientTradeAlertId` | integer | Optional |
| `matchId` | integer | Optional |
| `clientId` | integer | Optional |
| `tradesmanId` | integer | Optional |
| `recipientUserId` | integer | Optional |
| `recipientEmail` | string | Required |
| `status` | enum | `sent`, `failed`, `skipped`; defaults to `sent` |
| `errorMessage` | text | Optional |
| `sentAt` | date | Optional |
| `createdAt` | date | Sequelize timestamp |
| `updatedAt` | date | Sequelize timestamp |

Indexes:

- `type`
- `travelPlanId`
- `clientTradeAlertId`
- `matchId`
- `recipientUserId`
- Unique: `type`, `travelPlanId`, `clientTradeAlertId`, `recipientUserId`

## AWS Deployment Paths

No AWS-specific infrastructure files, Elastic Beanstalk config, ECS task definitions, CloudFormation, Terraform, or S3 provider implementation are present in this repository.

The backend itself is a standard Node.js/Express app and can be deployed on AWS EC2, Elastic Beanstalk, ECS, or Lightsail. The repository currently expects these runtime paths:

| Path / Setting | Used For | Source |
| --- | --- | --- |
| Project root | Node app working directory | `npm start` runs `node index.js` |
| `.env` in project root | Runtime secrets and configuration | `dotenv.config()` |
| `uploads/` | Default local upload storage | `LOCAL_UPLOAD_ROOT=uploads` |
| `/uploads` | Public URL base for local uploaded files | `LOCAL_UPLOAD_PUBLIC_BASE=/uploads` |
| `config/firebase-service-account.json` | Firebase Admin service account file | `utils/firebase.js` |
| `migrations/` | Database migrations | `database/migrator.js` |

Suggested EC2-style paths if deploying manually:

| Purpose | Suggested Path |
| --- | --- |
| App directory | `/var/www/tradesman-backend` |
| Environment file | `/var/www/tradesman-backend/.env` |
| Local upload persistence | `/var/www/tradesman-backend/uploads` or a mounted persistent volume |
| Process manager app name | `tradesman-backend` |
| Health check | `GET /` |
| API port | `PORT=5000` unless changed |

Important storage note:

- The current active storage driver is local: `STORAGE_DRIVER=local`.
- The code has a provider abstraction intended to allow S3 later, but there is no S3 provider in this repo.
- If AWS deployment uses multiple instances, local `uploads/` will not be shared between instances. Use a shared volume or implement an S3 storage provider before horizontal scaling.

## Domain and SSL Configuration

The Express app does not terminate SSL itself. HTTPS should be handled by the hosting layer, for example AWS Application Load Balancer, Nginx, Apache, CloudFront, or Elastic Beanstalk.

Required application environment values:

| Variable | Purpose | Example |
| --- | --- | --- |
| `APP_BASE_URL` | Public backend URL used for Stripe success/cancel URLs | `https://api.example.com` |
| `FRONTEND_URL` | Public frontend URL used for password reset links | `https://app.example.com` |
| `PORT` | Local Node server port | `5000` |
| `SESSION_SECRET` | Express session secret. **Required**: the server refuses to start without it | Secret value |
| `JWT_SECRET` | JWT signing secret | Secret value |

Domain routes that must stay reachable:

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Health check |
| `POST /api/subscriptions/webhook` | Stripe webhook endpoint |
| `GET /api/auth/google/callback` | Google OAuth callback |
| `/uploads/...` | Public local upload files if using local storage |

SSL checklist:

- Point the API domain DNS record to the deployed AWS load balancer, instance, or distribution.
- Install or attach an SSL certificate for the API domain.
- Forward HTTPS traffic to the Node app port.
- Set `APP_BASE_URL` to the final HTTPS API origin.
- Set `FRONTEND_URL` to the final HTTPS frontend origin.
- Configure CORS for the frontend origin if stricter CORS settings are added later. The current code uses open `cors()` defaults.

Google OAuth note:

- `config/passport.js` currently hardcodes the callback URL as `http://localhost:5000/api/auth/google/callback`.
- For production, change this to use an environment variable or update it to the deployed HTTPS callback URL.
- The same URL must be registered in the Google Cloud OAuth client.

## Firebase Project Details

Firebase is used through `firebase-admin` for Firebase Cloud Messaging push notifications.

Runtime files and code:

| Item | Value |
| --- | --- |
| Firebase utility | `utils/firebase.js` |
| Service account path | `config/firebase-service-account.json` |
| Push service | `services/pushNotificationService.js` |
| Device token table | `device_tokens` |
| Save-token endpoint | `POST /api/notifications/save-token` |

Expected service account JSON fields:

- `project_id`
- `client_email`
- `private_key`

Security notes:

- Do not commit a real Firebase service account JSON file to source control.
- Store the service account securely in production. If the file is deployed, restrict file permissions to the app user.
- The application only checks for `project_id` before initializing Firebase Admin.

Push notification flow:

1. Authenticated mobile/client app calls `POST /api/notifications/save-token` with a Firebase registration token.
2. The token is normalized and saved in `device_tokens`.
3. Domain services create a persistent row in `notifications`.
4. `services/pushNotificationService.js` sends the notification through Firebase Admin Messaging.
5. Permanent invalid-token errors remove the bad token from `device_tokens`.

FCM payload details:

- Uses `notification.title` and `notification.body`.
- Adds `data.click_action = FLUTTER_NOTIFICATION_CLICK`.
- Android priority is `high`.
- Android notification channel id is `high_importance_channel`.
- APNS priority header is `10`.

## Stripe Webhook Flow

Stripe is used for tradesman subscriptions.

Runtime files and code:

| Item | Value |
| --- | --- |
| Stripe package | `stripe` |
| Subscription controller | `controllers/subscriptionController.js` |
| Webhook controller | `controllers/stripeWebhookController.js` |
| Webhook route | `POST /api/subscriptions/webhook` |
| Cancellation route | `POST /api/subscriptions/cancel-subscription` |
| Plans table | `subscription_plans` |
| User subscription table | `user_subscriptions` |
| Plan config | `config/subscriptionPlans.js` |

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Server-side Stripe API key |
| `STRIPE_PUBLISHABLE_KEY` | Returned to mobile clients |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhook signatures |
| `STRIPE_EPHEMERAL_KEY_API_VERSION` | Required for mobile ephemeral keys |
| `APP_BASE_URL` | Used for checkout success/cancel URLs |

Webhook registration:

```text
POST https://your-api-domain.com/api/subscriptions/webhook
```

Important implementation detail:

- The webhook route is registered before `express.json()`.
- It uses `express.raw({ type: 'application/json' })`.
- Do not move the webhook below the JSON parser unless raw body signature verification is preserved.

Handled Stripe events:

| Event | Local action |
| --- | --- |
| `checkout.session.completed` | Links local `user_subscriptions` row to Stripe customer/subscription ids and plan id |
| `customer.subscription.created` | Syncs plan, customer id, subscription id, status, trial, period, cancellation flags |
| `customer.subscription.updated` | Syncs plan, customer id, subscription id, status, trial, period, cancellation flags |
| `customer.subscription.deleted` | Syncs subscription as `canceled` and sets `endDate` |
| `invoice.paid` | Marks matching local subscription `active` |
| `invoice.payment_failed` | Marks matching local subscription `past_due` |

Checkout web flow:

1. Authenticated tradesman calls `POST /api/subscriptions/checkout-session` with `planId`.
2. Backend validates the plan against configured plan names.
3. Backend creates or updates a local `user_subscriptions` row as `incomplete`.
4. Backend creates or reuses a Stripe customer.
5. Backend creates a Stripe Checkout subscription session with a 14-day trial.
6. Client opens the returned Stripe Checkout URL.
7. Stripe calls `POST /api/subscriptions/webhook`.
8. Webhook updates local subscription fields.

Mobile subscription flow:

1. Authenticated tradesman calls `POST /api/subscriptions/mobile/setup-intent`.
2. Backend creates or reuses a Stripe customer.
3. Backend returns publishable key, customer id, ephemeral key secret, setup intent client secret, and setup intent id.
4. Mobile app confirms the SetupIntent with Stripe SDK.
5. App calls `POST /api/subscriptions/mobile/create-subscription` with `planId` and `setupIntentId`.
6. Backend validates the succeeded SetupIntent belongs to the user.
7. Backend creates a Stripe subscription with a 14-day trial and saves local subscription state.
8. Future Stripe webhooks continue syncing the subscription lifecycle.

Upgrade/downgrade flow:

1. Authenticated tradesman calls `POST /api/subscriptions/upgrade-plan` or `POST /api/subscriptions/downgrade-plan`.
2. Backend requires an active or trialing subscription.
3. Backend validates target plan and current plan price direction.
4. Downgrades also check the current open travel plan stop count against the target plan limit.
5. Backend updates the Stripe subscription item price.
6. Webhook syncs final subscription state into `user_subscriptions`.

Cancellation flow:

1. Authenticated tradesman calls `POST /api/subscriptions/cancel-subscription`.
2. Backend requires an active or trialing subscription with a Stripe subscription id.
3. By default, backend sets Stripe `cancel_at_period_end` so access lasts until the current period ends.
4. If the body includes `{ "cancelImmediately": true }`, backend cancels the Stripe subscription immediately.
5. Backend updates local cancellation, period, status, and end-date fields. Webhooks continue syncing the final Stripe state.

## Required Production Environment Variables

```env
PORT=5000
APP_BASE_URL=https://api.example.com
FRONTEND_URL=https://app.example.com
SESSION_SECRET=replace-with-secret

DB_HOST=your-mysql-host
DB_PORT=3306
DB_NAME=tradesman_backend
DB_USER=your-db-user
DB_PASS=your-db-password
DB_POOL_MAX=10
DB_POOL_MIN=0
DB_POOL_ACQUIRE_MS=30000
DB_POOL_IDLE_MS=10000

JWT_SECRET=replace-with-long-random-secret
JWT_EXPIRE=7d

GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

STRIPE_SECRET_KEY=sk_live_or_test_xxx
STRIPE_PUBLISHABLE_KEY=pk_live_or_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_EPHEMERAL_KEY_API_VERSION=2024-06-20

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@example.com
SMTP_PASS=your-smtp-password
SMTP_FROM="Tradesman App <your-email@example.com>"
EMAIL_TIMEZONE=Australia/Sydney

STORAGE_DRIVER=local
LOCAL_UPLOAD_ROOT=uploads
LOCAL_UPLOAD_PUBLIC_BASE=/uploads
```

## Pre-Deployment Checklist

- Create the MySQL database.
- Set all production `.env` values.
- Install dependencies with `npm install --omit=dev` for production.
- Run `npm run db:migrate`.
- Seed Stripe plans if needed with `npm run subscriptions:seed`.
- Confirm `GET /` returns the health response.
- Configure Stripe webhook to `https://your-api-domain.com/api/subscriptions/webhook`.
- Register the Google OAuth production callback URL.
- Deploy Firebase service account securely.
- Persist the `uploads/` directory or replace local storage before scaling horizontally.
- Attach SSL certificate at the AWS/web-server layer.
