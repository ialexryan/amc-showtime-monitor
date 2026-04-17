# Agent Notes

- This app is a single-machine Fly worker with a single mounted volume at `/data`. Treat deploys as stateful operations.
- If a push already triggered the GitHub Actions deploy, do not also run `fly deploy` manually unless there is a specific reason. Back-to-back deploys can leave the replacement machine in `created` instead of `started`.
- After any Fly deploy or machine/volume operation, verify all three:
  - `fly status -a amc-showtime-monitor`
  - `fly machine list -a amc-showtime-monitor`
  - `fly checks list -a amc-showtime-monitor`
- SQLite state lives on the volume. Do not destroy or replace the volume, or wipe the database, without explicit user approval.
- Telegram responses use HTML parse mode. Escape user-facing angle brackets and other interpolated text accordingly, or Telegram will reject the message.
- If a Telegram command appears to do nothing, check Fly logs before assuming the handler did not run. A send failure can happen after command processing.
- Keep the app shape simple: one active worker, one volume, one machine. Do not add multi-machine assumptions without discussing the architecture change first.
