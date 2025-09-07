# AMC Showtime Monitor

Monitor AMC Theatres for new movie showtimes and send Telegram notifications when showtimes are posted for your favorite movies.

## Features

- **Real-time monitoring**: Check for new showtimes at configurable intervals
- **Fuzzy movie matching**: Find movies even with slight title variations
- **Premium format detection**: Highlights IMAX, Dolby Cinema, and other premium formats
- **Direct ticket links**: Each showtime links directly to AMC's seat selection page
- **Telegram notifications**: Get instant alerts when new showtimes are posted
- **Duplicate prevention**: Tracks announced showtimes to avoid repeat notifications
- **SQLite persistence**: Maintains state across runs

## Requirements

- [Bun](https://bun.sh/) runtime
- AMC API key (included in example config)
- Telegram bot token and chat ID

## Setup

1. **Clone and install dependencies**:
   ```bash
   git clone <repository-url>
   cd amc-showtime-monitor
   bun install
   ```

2. **Create configuration file**:
   ```bash
   bun src/cli.ts init
   ```

3. **Set up Telegram bot**:
   ```bash
   bun src/cli.ts setup
   ```
   Follow the interactive guide to create your Telegram bot.

4. **Edit config.json** with your settings:
   ```json
   {
     "movies": ["Tron: Ares", "The Odyssey"],
     "theatre": "AMC Metreon 16",
     "pollIntervalMinutes": 15,
     "telegram": {
       "botToken": "your-bot-token",
       "chatId": "your-chat-id"
     },
     "amcApiKey": "your-amc-api-key-here"
   }
   ```

## Usage

### Check for new showtimes
```bash
bun check
```

### Test Telegram connection
```bash
bun test
```

### View monitoring status
```bash
bun status
```

### Run with verbose logging
```bash
bun src/cli.ts check -v
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
    <integer>900</integer>
</dict>
</plist>
```

### Linux (cron)
```bash
# Run every 15 minutes
*/15 * * * * cd /path/to/amc-showtime-monitor && bun check
```

## Configuration

### Movies
- Use exact movie titles or close variations
- Fuzzy matching handles minor differences
- Include "The", "A", "An" articles for better matching

### Theatre
- Use either the full theatre name ("AMC Metreon 16") 
- Or the theatre slug ("amc-metreon-16")
- Theatre lookup supports fuzzy matching

### Polling Interval
- Minimum recommended: 15 minutes
- Be respectful of AMC's API rate limits
- Higher frequency may trigger rate limiting

## API Limitations

### Vendor-Exclusive Movies
Some movies may show "vendor exclusive" errors and not appear in search results. This typically happens when:

- Movies are far from release date
- Distribution agreements restrict API access
- AMC limits certain content to premium API partners

**What this means**: Movies like "The Odyssey" might not be accessible until closer to their release date, even though they appear on AMC's website.

**Workaround**: Keep these movies in your config - they'll automatically start working once AMC makes them publicly available through the API.

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
- SQLite database (`showtimes.db`) stores theatres, movies, and showtime history
- Database is created automatically on first run
- Delete database file to reset all tracking

## Troubleshooting

### Common Issues

1. **Theatre not found**: Try using the exact name from AMC's website or the theatre slug
2. **Movie not found**: Check spelling, try with/without articles ("The", "A")
3. **API rate limiting**: Reduce polling frequency in config
4. **Vendor exclusive movies**: Wait for movie to become publicly available

### Debug Mode
Run with verbose logging to see detailed search results:
```bash
bun src/cli.ts check -v
```

## License

This project is for personal use only. Respect AMC's terms of service and API usage guidelines.