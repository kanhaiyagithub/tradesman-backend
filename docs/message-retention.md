# Chat message retention (30 days)

Chat messages are permanently deleted 30 days after they were created.

## How it works

- `services/messageCleanupService.js` deletes every message with `createdAt` older than the retention window. It is a **hard delete** (the `Message` model is soft-delete by default, so `force: true` is used; already soft-deleted old rows are removed too).
- It deletes in batches (`MESSAGE_CLEANUP_BATCH_SIZE`, default 1000) so a backlog never locks the table, up to `MESSAGE_CLEANUP_MAX_BATCHES` (default 500) per run. The next run continues.
- Conversations are **kept**. If a conversation's newest message was deleted, its last-message preview is cleared and each participant's `unreadCount` is reset to 0, so the chat list never shows or counts a message that no longer exists. An emptied conversation stays in the list with no last message.
- It runs once at worker start and then every 24 hours, guarded by a MySQL named lock, so several instances are safe.
- Migration `20261014-0012` adds an index on `messages.createdAt` so finding expired rows is fast.

## Where it runs (important in production)

The job is part of the background worker. With `ENABLE_API_BACKGROUND_JOBS=false` on the API (the production recommendation) it only runs if the worker process is running:

```
npm run jobs:worker        # keep running, e.g. under pm2
```

If no worker is running, no cleanup of any kind happens.

## Settings (all optional)

| Variable | Default |
| --- | --- |
| `MESSAGE_RETENTION_DAYS` | `30` |
| `MESSAGE_CLEANUP_INTERVAL_MS` | `86400000` (24 h) |
| `MESSAGE_CLEANUP_BATCH_SIZE` | `1000` |
| `MESSAGE_CLEANUP_MAX_BATCHES` | `500` |

## Commands

```
npm run db:migrate           # adds the createdAt index (once)
npm run chat:cleanup:dry     # count what would be deleted, delete nothing
npm run chat:cleanup         # run the cleanup once now
```

The first real run on production deletes everything already older than 30 days. Run `chat:cleanup:dry` first to see how many rows that is.
