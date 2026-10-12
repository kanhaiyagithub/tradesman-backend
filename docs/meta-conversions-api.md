# Meta Conversions API (server-side app events)

Sends `CompleteRegistration` and `Subscribe` events to Meta so Android (and later iOS) ads can be optimised for sign-ups and subscriptions.

Meta failures never break signup, login or the Stripe webhook: every public track function catches its own errors.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `META_CAPI_ENABLED` | `false` | Master switch. Anything other than `true` makes all tracking (including attribution saving) a silent no-op. |
| `META_APP_ID` | – | Meta app ID (`870921269307552`). Informational. |
| `META_DATASET_ID` | `1813699159758304` | Dataset the events are posted to. |
| `META_CAPI_ACCESS_TOKEN` | – | **Secret.** Only ever set in `.env`. Sent in the JSON body, never in the URL, never logged. |
| `META_TEST_EVENT_CODE` | – | When set, `test_event_code` is added to requests so events show under Events Manager > Test Events. Leave empty in production. |
| `META_GRAPH_API_VERSION` | `v23.0` | Graph API version. |
| `META_DEFAULT_PHONE_COUNTRY_CODE` | `61` | A leading `0` in a phone number is replaced by this. |
| `META_DEFAULT_TRACKING_ENABLED` | `true` | Consent assumed when the app has not reported a value yet. |
| `META_CAPI_TIMEOUT_MS` | `8000` | HTTP timeout per request. |

If `META_CAPI_ENABLED=true` but the token is missing, a warning is logged once and tracking stays off.

## Database

Run `npm run db:migrate` to create:

- `meta_conversion_events` – one row per event. Unique `eventId` means retries and double taps are ignored. Holds status (`pending`/`sent`/`failed`/`skipped`), attempts, last error, `fbtraceId`, and the payload (hashed email/phone/user id; the advertising ID, anon ID, IP and User-Agent are stored raw because Meta needs them unhashed and retries re-send the stored payload).
- `meta_user_attributions` – one row per user with the latest device/attribution info. The `Subscribe` event fires from the Stripe webhook where there is no app request, so it reads identifiers from here.

## Event flow

**CompleteRegistration** (`event_id = registration_{userId}`)
- Email signup: `POST /api/users/register`, after the user (and tradesman details) are created.
- Google: `POST /api/auth/google/mobile`, only when the login creates a new user. Existing Google users only get their attribution refreshed.
- Skipped for `admin` users. `custom_data`: `registration_method` (`email`/`google`), `user_role`, `status: true`.

**Subscribe** (`event_id = subscribe_{stripeSubscriptionId}`)
- Stripe webhook `invoice.paid`. Ignored when `amount_paid <= 0` (trial invoices). Because the event id is per subscription, renewals are duplicates and ignored.
- Subscription id comes from `invoice.subscription` or `invoice.parent.subscription_details.subscription`.
- User is resolved through `UserSubscription` (subscription id, then customer id), then subscription metadata `userId`. If no user is found, nothing is recorded.
- `custom_data`: `value` (major units; zero-decimal currencies handled), `currency` (uppercase), `content_name` (plan name), `user_role`. `event_time` is the invoice paid time.

**Sending**: the row is written first, then the HTTP call runs in the background. Transient failures (network error, timeout, 429, 5xx) are retried twice (1s, then 3s). Other 4xx are not retried. Success means HTTP ok **and** `events_received >= 1`.

**Privacy**: if the app reports `advertiserTrackingEnabled: false`, only `anon_id` is sent (no hashed email/phone, no `madid`, no IP, no User-Agent). With no identifiers left the event is stored as `skipped` and not sent.

## App integration

Authenticated endpoint, call it after login/launch to keep attribution fresh:

```
POST /api/meta/attribution        Authorization: Bearer <jwt>
{
  "platform": "android",
  "advertisingId": "<GAID, omit or all-zero if unavailable>",
  "anonId": "<Facebook anonymous install id>",
  "advertiserTrackingEnabled": true,
  "applicationTrackingEnabled": true,
  "appPackage": "...", "appVersionCode": "12", "appVersionName": "1.2.0",
  "osVersion": "14", "deviceModel": "Pixel 7", "locale": "en_AU",
  "timezoneAbbr": "AEST", "timezoneName": "Australia/Sydney", "carrier": "Telstra",
  "screenWidth": 1080, "screenHeight": 2400, "screenDensity": 2.75,
  "cpuCores": 8, "totalStorageGb": 128, "freeStorageGb": 64
}
```

Unknown fields are ignored, strings are length-limited, the all-zero advertising ID is dropped, and empty values never overwrite known ones. The server records the request IP and User-Agent itself.

`register` (multipart, send the object as a JSON string) and the Google mobile login also accept the same object in an optional `metaAttribution` field, saved before the registration event is built. Send it on signup so the first event carries the identifiers.

## Testing

1. In `.env`: `META_CAPI_ENABLED=true`, `META_CAPI_ACCESS_TOKEN=<token>`, `META_TEST_EVENT_CODE=TEST51647`.
2. `npm run meta:test` (CompleteRegistration) and `npm run meta:test -- subscribe`.
3. Open Events Manager > Test Events for the dataset and confirm the events appear.

The script sends one fake event, does not touch the database, and refuses to run without `META_CAPI_ENABLED=true` and `META_TEST_EVENT_CODE`.

Unit tests: `node --test tests/metaCapi.util.test.js tests/metaConversionService.test.js` (no network, no database).

## Going live

1. Run `npm run db:migrate`.
2. Make sure the app sends `metaAttribution` / calls `/api/meta/attribution`.
3. Test as above, then **empty `META_TEST_EVENT_CODE`** (otherwise events only appear under Test Events and are not used for optimisation).
4. Keep `META_CAPI_ENABLED=true` and restart the server.
5. Schedule `npm run meta:retry` (e.g. every 15 minutes). It re-sends `failed` events and `pending` events older than 5 minutes, younger than 6 days, up to 8 total attempts. Meta rejects events older than 7 days.
6. Monitor `meta_conversion_events` for `failed` rows (`lastError`, `fbtraceId`).
