# Step 7 - Background Jobs And Notifications

This document explains the background job changes completed after the audit.

## Changes Implemented

### Dedicated Worker Entry

Added:

```text
npm run jobs:worker
```

This runs:

- travel-plan status refresh
- notification cleanup
- match reminder emails

The worker entry is:

```text
scripts/runBackgroundJobs.js
```

### API Process Gate

API startup no longer blindly starts background jobs in every environment.

Use:

```env
ENABLE_API_BACKGROUND_JOBS=true
```

to run jobs inside the API process.

Production default:

```text
background jobs do not start inside the API process unless explicitly enabled
```

Local/non-production default:

```text
background jobs start unless ENABLE_API_BACKGROUND_JOBS=false
```

Recommended production setup:

```text
one API process group
one jobs:worker process
```

### Job Locks

Added DB-backed job locking through:

```text
services/backgroundJobLockService.js
```

On MySQL it uses advisory locks:

```sql
GET_LOCK(...)
RELEASE_LOCK(...)
```

This protects repeated jobs from duplicate execution when more than one worker/API instance accidentally runs the same loop.

### Jobs Protected By Lock

- notification cleanup
- match reminder emails
- global travel-plan status refresh

Per-tradesman status refreshes still run inline because endpoint-level freshness is scoped to one user and does not create duplicate notifications/emails.

## Test Coverage

Covered in `tests/security-lockdown.test.js`:

- production API process does not start jobs by default
- explicit env flag enables/disables API-started jobs

## Remaining Follow-Ups

- Move scheduled jobs to a managed scheduler or queue if deployment grows.
- Add a persisted job-run audit table if operators need visibility.
- Add metrics around job duration, skipped locks, sent emails, and cleanup counts.

