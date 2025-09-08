# AMC Showtime Monitor

Send Telegram notifications when AMC posts showtimes for movies you are monitoring.

## Features

- **Telegram notifications**: Get instant alerts when new showtimes are posted
- **Telegram bot commands**: Manage your movie watchlist via Telegram chat
- **Fuzzy movie matching**: Find movies even with slight title variations
- **Premium format detection**: Highlights IMAX, Dolby Cinema, and other premium formats
- **Direct ticket links**: Each showtime links directly to AMC's seat selection page

## Requirements

- [Bun](https://bun.sh/) runtime
- AMC API key (apply for one [here](https://developers.amctheatres.com/GettingStarted/NewVendorRequest))

## Setup

1. **Clone and install dependencies**:
   ```bash
   git clone <repository-url>
   cd amc-showtime-monitor
   bun install
   ```

2. **Create configuration file**:
   ```bash
   bun src/cli.ts create-config
   ```

3. **Set up Telegram bot**:
   ```bash
   bun src/cli.ts telegram-setup
   ```
   Follow the interactive guide to create your Telegram bot.

4. **Edit config.json** with your settings:
   ```json
   {
     "theatre": "AMC Metreon 16",
     "pollIntervalMinutes": 15,
     "telegram": {
       "botToken": "your-bot-token",
       "chatId": "your-chat-id"
     },
     "amcApiKey": "your-amc-api-key-here"
   }
   ```

5. **Add movies to your watchlist** via Telegram:
   - Send `/add Tron: Ares` to your bot
   - Send `/add The Odyssey` to your bot  
   - Use `/list` to view your watchlist
   - Use `/help` for all available commands

## Usage

### Run the monitoring loop
```bash
bun run
```

### Test Telegram connection
```bash
bun test-telegram
```

### View monitoring status
```bash
bun show-status
```

### Manage watchlist via Telegram
- `/add <movie name>` - Add a movie to watchlist
- `/remove <movie name>` - Remove a movie from watchlist  
- `/list` - Show current watchlist
- `/status` - Show monitoring status
- `/help` - Show all commands

### Run with verbose logging
```bash
bun src/cli.ts run -v
```

## Automation

Set up automated monitoring using your system's scheduler:

### macOS (launchd)
Create `~/Library/LaunchAgents/com.user.amc-monitor.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.amc-monitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/bun</string>
        <string>check</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/amc-showtime-monitor</string>
    <key>StartInterval</key>
    <integer>60</integer>
</dict>
</plist>
```

### Linux (cron)
```bash
# Run every minute
* * * * * cd /path/to/amc-showtime-monitor && bun check
```

## Configuration

### Watchlist Management
Movies are managed via Telegram bot commands:
- Use `/add <movie name>` to add movies to your watchlist
- Use exact movie titles or close variations
- Fuzzy matching handles minor differences
- Include "The", "A", "An" articles for better matching

### Theatre
- Use either the full theatre name ("AMC Metreon 16") 
- Or the theatre slug ("amc-metreon-16")
- Theatre lookup supports fuzzy matching

### Polling Interval
- Default: 1 minute for responsive notifications
- Be respectful of AMC's API rate limits
- If you encounter rate limiting, increase the interval

## API Limitations

### Vendor-Exclusive Movies
Some movies may show "vendor exclusive" errors and not appear in search results. This typically happens when:

- Movies are far from release date
- Distribution agreements restrict API access
- AMC limits certain content to premium API partners

**What this means**: Movies like "The Odyssey" might not be accessible until closer to their release date, even though they appear on AMC's website.

**Workaround**: Keep these movies in your watchlist via `/add` - they'll automatically start working once AMC makes them publicly available through the API.

## Notification Format

Notifications show:
- Movie title
- Theatre name  
- Premium formats (IMAX, Dolby Cinema, etc.) instead of auditorium numbers
- Direct links to seat selection for each showtime
- Sold out/almost sold out status

Example:
```
🎬 New Showtime for Tron: Ares!

🏛️ AMC Metreon 16

🎬 Thu, Oct 9 7:00 PM - IMAX with Laser at AMC
🎬 Thu, Oct 9 10:15 PM - Dolby Cinema at AMC
```

## Development

### Linting and Formatting
```bash
bun run lint        # Check code quality
bun run lint:fix    # Fix linting issues
bun run format      # Format code
```

### Database
- SQLite database (`showtimes.db`) stores theatres, movies, watchlist, and showtime history
- Database is created automatically on first run
- Use `bun src/cli.ts reset-db` to reset all tracking (includes watchlist)

## Troubleshooting

### Common Issues

1. **Theatre not found**: Try using the exact name from AMC's website or the theatre slug
2. **Movie not found**: Check spelling with `/add`, try with/without articles ("The", "A")
3. **Empty watchlist**: Use `/add <movie name>` to add movies to your watchlist
4. **API rate limiting**: Increase polling interval in config if you encounter 429 errors
5. **Vendor exclusive movies**: Wait for movie to become publicly available

### Debug Mode
Run with verbose logging to see detailed search results:
```bash
bun src/cli.ts check -v
```

## License

This project is for personal use only. Respect AMC's terms of service and API usage guidelines.