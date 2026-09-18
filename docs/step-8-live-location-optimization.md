# Step 8 - Live Location Query Optimization

This document explains the live-location matching changes completed after the audit.

## Previous Behavior

Each live GPS update loaded all active client alerts for the tradesman's trade type, then checked distance in application code.

That meant each ping scaled with:

```text
all active alerts for that trade
```

even though the live proximity flow only sends notifications when a stored route/alert match already exists.

## New Behavior

Live-location matching now starts from stored matches for the active travel plan:

```text
travel_plan_alert_matches
```

Then it loads only the linked active client alerts.

Candidate alerts are filtered by:

- active travel plan
- tradesman id
- existing match
- match not ignored
- active alert
- matching trade type
- alert start/end date window

Distance checks still run in Node, but against the smaller candidate set.

## Request Validation

`POST /api/location/live-update` now validates:

- caller must be a tradesman
- `latitude` and `longitude` are required
- both must be valid numbers
- latitude must be between `-90` and `90`
- longitude must be between `-180` and `180`

Server errors return a generic failure response instead of raw exception text.

## Test Coverage

Covered in `tests/security-lockdown.test.js`:

- clients cannot submit live-location updates
- invalid coordinates are rejected
- candidate query includes only existing active matches
- unmatched and expired alerts are excluded

## Remaining Follow-Ups

- Add database indexes for live-location candidate query shape if production volume requires it.
- Consider geospatial columns/indexes later for true database-side distance filtering.
- Add shared Socket.IO validation so socket live updates and REST live updates enforce identical coordinate rules.

