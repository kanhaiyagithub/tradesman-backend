# API hardening and app support changes

Changes made for the "stop leaking user data" review and the app's API gaps. Tests: `tests/publicApiHardening.test.js` (mocked models) and the updated `tests/security-lockdown.test.js` (real local database).

## A. Security

| Change | Detail |
| --- | --- |
| `GET /api/users`, `GET /api/users/clients` | Now require a login (`verifyToken`). Search matches the **name only** (no email or phone lookup). |
| Public profile shape | `GET /users`, `/users/clients`, `/users/tradesmen`, `/users/:id` and `/users/tradesmen/filter` return only: clients `id, name, role, profileImage`; tradesmen also `tradeType, tradeTypeId, businessName, shortBio, avgRating, reviewCount, isVerified`. A small `TradesmanDetail` object with the same safe fields is kept for older clients. No email, mobile, Google ID, provider, licence or approval fields. |
| `isVerified` | For tradesmen it means *admin approved* (`TradesmanDetail.isApproved`). |
| `GET /users/tradesmen` | Now lists **approved** tradesmen only. |
| `POST/GET /users/tradesmen/filter` | Previously spread the whole user row (including the password hash). It now returns the public shape. |
| `SESSION_SECRET` | The `'your_secret_key'` fallback is removed. The server throws at startup if `SESSION_SECRET` is not set. **Set it on every environment before deploying.** |

Not changed: the chat list (`/chat/list`, `withUser`) still includes the other user's `email`; `getFullUserProfile`, `PUT /users/profile` and the admin endpoints are untouched.

## B. App support

- **Availability and location** on `/users/tradesmen/filter`: each tradesman has `availability` (`available_now` = a plan is running now, `upcoming`, `unavailable`), `hasActivePlan` and a `location` summary (`current`, coordinates, `destination`, `startDateTime`, `destinationDateTime`, `travelPlanId`). One extra query for the whole list.
- **`radiusKm`** on the filter (query or body): number > 0, capped at 100 km (default 15). The effective radius is returned as `radiusKm`. Invalid values return 400.
- **Client bookings** `GET /hire/client/bookings?type=`: `my` (pending, accepted), `past` (completed, **rejected, cancelled**), `all`. Each booking has `myReview` (`id, rating, comment, createdAt` or null) and `tradesmanRating` (`avgRating, reviewCount`). `canReview` is now `true` only for completed hires the client has not reviewed yet.
- **Real-time hire events** (socket, to both the client and the tradesman, in addition to the existing pushes):
  - `hire-updated` on every change. Payload: `{ hireId, status, requestCompletion, clientId, tradesmanId, reason, at }`, with `reason` one of `requested, accepted, rejected, cancelled, completion_requested, completion_rejected, completed`.
  - `completion-requested` when the tradesman asks for completion.
  - `job-completed` when the client confirms.
  - Delivery is to sockets on the same server process; running several API instances would need a shared adapter (e.g. the socket.io Redis adapter).
- **Chat list**: `/chat/list` items already include `withUser` with `id, name, role, profileImage` (and `email`) plus `unreadCount`, so the app does not need per-conversation calls.
- **Token refresh**: login and Google mobile login also return `refreshToken` (60 days, `JWT_REFRESH_EXPIRES_IN`). `POST /api/users/refresh-token` with `{ refreshToken }` returns new `token`, `refreshToken` and `user`. A refresh token cannot be used as an access token (API or socket), and changing/resetting the password invalidates all refresh tokens. Tokens are stateless, so one token cannot be revoked individually before it expires.

## C. Consistency

- **Auth errors**: every failure is a 401 `{ success: false, message, code }` with `code` = `TOKEN_MISSING`, `TOKEN_EXPIRED` or `TOKEN_INVALID`. A wrong password at login stays a 400, so the app can tell them apart.
- **Create travel plan**: a 400 now names the missing fields (`Required fields missing: destination, ...`) and returns them in `data.missingFields`.
- **Filter logging**: the request query/body is no longer logged.
- **`PUT /users/profile` `phone` alias**: deliberately not added; `mobile` stays the canonical field and the app should send `mobile`.

## D. Follow-up changes (filter hardening, location match, paging, login codes)

- **Filter requires a login.** `GET` and `POST /api/users/tradesmen/filter` now use `verifyToken` (401 `TOKEN_MISSING` without a token). The response includes where tradesmen currently are, so it is no longer public. `GET /users/tradesmen` (no location data) stays public.
- **Location search uses the whole route.** With `latitude`/`longitude` the match now considers each active plan's **current position, destination and intermediate stops** (before, only intermediate stops, so plans without stops never matched). `matchedStop` / `matchedDistanceKm` describe the nearest point. Plans with a missing coordinate are skipped (a missing value is never treated as 0,0). For the date-range filter the current position counts from the plan start, the destination at the destination time, and stops at their own time.
- **Nearest first.** A location search sorts by `matchedDistanceKm` ascending; without a location the order is newest first.
- **Optional paging.** `page` (whole number >= 1) and `limit` (whole number 1-100, capped at 100) on the filter. Without `limit` every match is returned, exactly as before. Responses always include `total`; when paging is used they also include `pagination: { total, page, limit, totalPages, hasMore }`. Invalid `page`/`limit` return 400. Availability and the location summary are looked up for the returned page only.
- **Login error codes.** Failed email login returns `code: "GOOGLE_ACCOUNT"` (account has no password, use Google) or `code: "INVALID_CREDENTIALS"` (unknown email or wrong password; the message is identical for both, so it does not reveal which emails exist).

Tests: `tests/publicApiHardening.test.js` (mocked models) covers each of the above; `tests/security-lockdown.test.js` now sends a token to the filter and asserts the anonymous 401 (it uses the local database and was not run as part of this change).

## E. Hire request without a description

- `POST /api/hire/request` no longer requires `jobDescription`. It is optional: when omitted or blank the hire is stored with `jobDescription: null` (the column was already nullable). A description over 2000 characters is still rejected with 400.
- The tradesman's "New Job Request" notification reads "<client> has sent you a hire request." when there is no description, and keeps "<client> wants to hire you for: <description>" when one is sent, so older clients keep working.
- Tests: four new cases in `tests/publicApiHardening.test.js` (no description, blank description, description kept, over-length rejected).
