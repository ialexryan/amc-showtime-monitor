# AMC Showtime Monitor

Telegram-first monitoring for new AMC showtimes, with the ability to start tracking movies long before tickets are on sale.

The app polls AMC, stores state in SQLite, and sends Telegram alerts when new showtimes appear for movies you care about. It runs as one long-lived worker.

## What It Does

- Sends Telegram alerts when new AMC showtimes appear.
- Lets you manage the watchlist from Telegram with `/add`, `/remove`, `/list`, `/status`, and `/help`.
- Supports a hybrid watchlist model:
  - pending entries for movies AMC does not know about yet
  - resolved entries that are pinned to a canonical AMC movie id
  - ambiguous entries that require you to choose among multiple possible AMC matches
- Uses Telegram inline buttons to resolve ambiguous titles.
- Groups alerts by movie and includes direct AMC ticket links.
- Runs well on Fly.io as a single `shared-cpu-1x` worker with a SQLite volume.

## How Watchlist Resolution Works

The watchlist is intentionally not AMC-id-only.

When you add a movie:

- If AMC has one clear match, the entry is resolved immediately.
- If AMC has no good match yet, the entry stays pending and the worker keeps checking every poll cycle.
- If AMC has multiple strong matches, the bot sends an inline keyboard prompt so you can pick the right one.

Once an entry is resolved, the worker stops fuzzy-matching it and monitors that exact AMC movie id instead.

That gives you both:

- early tracking for movies that are not in AMC yet
- exact matching once AMC publishes the title

## Requirements

- [Bun](https://bun.sh/)
- AMC API key: [AMC developer portal](https://developers.amctheatres.com/GettingStarted/NewVendorRequest)
- Telegram bot token and chat id

## Local Setup

1. Clone and install dependencies:

```bash
git clone <repository-url>
cd amc-showtime-monitor
bun install
```

2. Create a local config file:

```bash
bun src/cli.ts create-config
```

3. Set up the Telegram bot:

```bash
bun src/cli.ts telegram-setup
```

4. Edit `data/config.json`:

```json
{
  "theatre": "AMC Metreon 16",
  "telegram": {
    "botToken": "your-telegram-bot-token-here",
    "chatId": "your-telegram-chat-id-here"
  },
  "amcApiKey": "your-amc-api-key-here",
  "runtime": {
    "pollIntervalSeconds": 60,
    "telegramLongPollSeconds": 30
  }
}
```

5. Start the worker:

```bash
bun monitor
```

6. Add movies from Telegram:

```text
/add Tron: Ares
/add The Odyssey
/list
```

## Production Configuration

Production does not need `config.json`.

The app supports environment-only startup, which is the recommended Fly.io setup. Use env vars or Fly secrets for:

- `THEATRE`
- `AMC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- optionally `POLL_INTERVAL_SECONDS`
- optionally `TELEGRAM_LONG_POLL_SECONDS`

The Fly deployment in this repo also sets:

- `PORT=8080`
- `DATABASE_PATH=/data/amc-monitor.db`
- `CONFIG_PATH=/data/config.json`

If `/data/config.json` is missing, the app will still start correctly as long as the required env vars are present.

## Usage

### Main commands

```bash
bun monitor
bun check-once
bun test-telegram
bun show-status
bun src/cli.ts logs
```

### What they do

- `monitor`: run the long-lived production worker
- `check-once`: run one poll cycle and exit
- `test-telegram`: verify bot connectivity and send a test message
- `show-status`: print watchlist and worker status
- `logs`: print recent run logs from SQLite

### Useful options

```bash
bun src/cli.ts monitor -v
bun src/cli.ts check-once -v
```

## Telegram UX

### Commands

- `/add <movie>`: add a watchlist entry
- `/remove <movie-or-number>`: remove by exact title or by the number shown in `/list`
- `/list`: show watchlist entries and their state
- `/status`: show worker stats and watchlist state counts
- `/help`: show help

### Entry states

- `resolved`: exact AMC movie chosen and monitored by AMC movie id
- `pending`: no AMC match yet
- `ambiguous`: multiple possible AMC matches; choose one from the inline keyboard prompt

### Ambiguity prompts

When AMC has multiple plausible matches for a pending entry, the bot sends an inline keyboard with up to 3 candidates plus `Keep pending`.

The worker only sends that prompt again if the candidate set changes.

## Deployment

### Fly.io

This repo is set up for Fly.io.

Included files:

- [`fly.toml`](/Users/alexryan_1/amc-showtime-monitor/fly.toml)
- [`.github/workflows/fly.yml`](/Users/alexryan_1/amc-showtime-monitor/.github/workflows/fly.yml)
- [`Dockerfile`](/Users/alexryan_1/amc-showtime-monitor/Dockerfile)

Current Fly assumptions:

- app name: `amc-showtime-monitor`
- region: `iad`
- one `shared-cpu-1x` machine
- `256 MB` RAM
- one mounted volume at `/data`
- health checks against `/healthz`

Typical setup:

```bash
fly auth login
fly apps create amc-showtime-monitor
fly volumes create amc_monitor_data --region iad --size 1 -a amc-showtime-monitor
fly secrets set -a amc-showtime-monitor \
  AMC_API_KEY=... \
  TELEGRAM_BOT_TOKEN=... \
  TELEGRAM_CHAT_ID=... \
  THEATRE="AMC Metreon 16"
fly deploy -a amc-showtime-monitor
```

### GitHub Actions auto deploy

Pushing to `master` runs the `Fly Deploy` GitHub Actions workflow. The workflow expects a GitHub secret named:

- `FLY_API_TOKEN`

## macOS LaunchAgent

If you want to run it locally as a background worker on macOS:

```bash
./setup-launchd.sh
```

Management commands:

```bash
launchctl list | grep amc-showtime-monitor
tail -f logs/stdout.log
tail -f logs/stderr.log
launchctl unload ~/Library/LaunchAgents/com.user.amc-showtime-monitor.plist
launchctl load ~/Library/LaunchAgents/com.user.amc-showtime-monitor.plist
```

## Notification Behavior

Alerts are delivered at-least-once.

That means:

- a showtime is only marked notified after Telegram accepts the message
- if Telegram fails, the alert is retried next loop
- in rare crash windows, duplicates are possible

Duplicates are considered acceptable; silently missing an alert is not.

## Time Handling

User-facing showtime formatting is based on:

- `showDateTimeUtc` as the actual instant
- AMC `utcOffset` for theater-local display

This avoids server-timezone bugs on Fly and across DST boundaries, as long as AMC provides correct UTC and offset data for the showtime.

## Development

```bash
bun run lint
bun run lint:fix
bun run format
bun run test
bun run typecheck
bun run build
```

`bun run build` bundles the CLI into `dist/cli.js`.

Lefthook installs pre-commit hooks that run lint and typecheck.

## Database Notes

- SQLite lives at `data/amc-monitor.db` locally and `/data/amc-monitor.db` on Fly.
- Watchlist state, bot offset, logs, and notification history are stored in SQLite.
- `reset-db` clears tracking state, including the watchlist.
- The current watchlist schema is not designed for compatibility with the old string-only watchlist table. If the old schema is present, the app rebuilds the watchlist table in the new format.

Useful maintenance commands:

```bash
bun src/cli.ts reset-db
bun src/cli.ts db-maintenance --stats
bun src/cli.ts db-maintenance --check-only
bun src/cli.ts db-maintenance --backup-only
```

## Troubleshooting

### Telegram `409 Conflict`

This means more than one process is polling `getUpdates` for the same bot token.

Make sure only one copy of the worker is running.

### Movie stays pending for a long time

AMC probably does not have that title in the API yet. Leave it in the watchlist and the worker will keep trying to resolve it.

### Movie becomes ambiguous

Pick the correct title from the inline prompt, or leave it pending if none of the options are right.

### No alerts but watchlist is resolved

Run:

```bash
bun show-status
fly logs -a amc-showtime-monitor --no-tail
```

Check that:

- the worker is healthy
- the watchlist entry is resolved
- AMC actually has showtimes for that movie at your configured theater

## License

Personal-use project. Respect AMC’s terms of service and API rules.
