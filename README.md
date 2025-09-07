# AMC Showtime Monitor 🎬

A high-performance TypeScript application that monitors AMC Theatres for new movie showtimes and sends instant Telegram notifications. Perfect for getting the best seats to hotly anticipated movies!

## ✨ Features

- **Fuzzy Movie Matching**: Monitors movies like "Tron: Ares" and catches variations like "Tron: Ares Special Opening Night"
- **Real-time Notifications**: Instant Telegram notifications with showtime details and direct ticket purchase links
- **Premium Format Detection**: Highlights IMAX, Dolby Cinema, and other premium formats
- **Smart Deduplication**: Tracks announced showtimes to avoid spam notifications
- **Blazing Fast**: Built with Bun for lightning-fast startup times (perfect for cron jobs)
- **SQLite Storage**: Efficient local database with proper indexing and relationships
- **Rate Limit Protection**: Built-in error handling and respectful API usage

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh/) installed
- Telegram account
- AMC API key (provided in example config)

### Installation

```bash
# Clone and setup
git clone <your-repo>
cd amc-showtime-monitor
bun install

# Initialize configuration
bun src/cli.ts init

# Set up Telegram bot
bun src/cli.ts setup
```

### Configure Your Settings

Edit `config.json`:

```json
{
  "movies": [
    "Tron: Ares",
    "Odyssey"
  ],
  "theatre": "AMC Metreon 16",
  "pollIntervalMinutes": 15,
  "telegram": {
    "botToken": "your-telegram-bot-token",
    "chatId": "your-chat-id"
  },
  "amcApiKey": "your-amc-api-key-here"
}
```

### Test Your Setup

```bash
# Test Telegram connection
bun src/cli.ts test

# Check status
bun src/cli.ts status

# Run a single check
bun src/cli.ts check
```

## 📱 Telegram Bot Setup

1. **Create Bot**: Message [@BotFather](https://t.me/BotFather) on Telegram
2. **Send**: `/newbot`
3. **Follow prompts** to name your bot
4. **Copy the bot token** (looks like: `123456789:ABCdefGHI...`)
5. **Start a chat** with your new bot
6. **Send any message** to your bot
7. **Get your Chat ID**: Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
8. **Find your Chat ID** in the JSON response under `"chat":{"id":`
9. **Add both values** to your `config.json`

## ⏰ Scheduling

### macOS (Recommended)

Create `~/Library/LaunchAgents/com.user.amc-monitor.plist`:

```xml
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
    <key>Label</key>
    <string>com.user.amc-monitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/your-username/.bun/bin/bun</string>
        <string>src/cli.ts</string>
        <string>check</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/amc-showtime-monitor</string>
    <key>StartInterval</key>
    <integer>900</integer> <!-- 15 minutes -->
    <key>StandardOutPath</key>
    <string>/tmp/amc-monitor.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/amc-monitor-error.log</string>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/Library/LaunchAgents/com.user.amc-monitor.plist
```

### Linux/Unix (cron)

```bash
# Edit crontab
crontab -e

# Add line (check every 15 minutes)
*/15 * * * * cd /path/to/amc-showtime-monitor && /path/to/bun src/cli.ts check
```

## 🎯 CLI Commands

```bash
# Check for new showtimes
bun src/cli.ts check [options]

# Test Telegram bot
bun src/cli.ts test

# Show current status
bun src/cli.ts status

# Initialize new config
bun src/cli.ts init

# Setup guide for Telegram
bun src/cli.ts setup

# Help
bun src/cli.ts --help
```

### Options

- `-c, --config <path>`: Custom config file path
- `-d, --database <path>`: Custom database file path  
- `-v, --verbose`: Verbose logging

## 📊 How It Works

1. **Theatre Lookup**: Finds your AMC theatre using fuzzy matching
2. **Movie Search**: Searches AMC's advance ticket movies for your configured titles
3. **Fuzzy Matching**: Matches movie names flexibly (catches special editions, etc.)
4. **Showtime Retrieval**: Gets all future showtimes for matched movies
5. **Deduplication**: Compares against local SQLite database
6. **Notifications**: Sends rich Telegram messages for new showtimes
7. **State Tracking**: Records notifications to prevent duplicates

## 🔧 Configuration

### Movie Names

The monitor uses fuzzy matching, so:
- `\"Tron: Ares\"` matches `\"Tron: Ares Special Opening Night\"`
- `\"Odyssey\"` matches `\"The Odyssey\"` or `\"Odyssey IMAX Experience\"`

### Theatre Names

Theatre matching is also fuzzy:
- `\"AMC Metreon 16\"` matches `\"AMC Metreon 16\"` exactly
- `\"Metreon\"` would also work

### Poll Frequency

- **15 minutes**: Good balance of responsiveness vs. API respect
- **5 minutes**: More aggressive (use cautiously)
- **30+ minutes**: Conservative but might miss rapid sellouts

## 🚨 Notification Format

```
🎬 New Showtime Available!

🎭 Tron: Ares
🏛️ AMC Metreon 16
📅 Fri, Dec 20 at 7:00 PM
🎪 Auditorium 1
🎯 IMAX with Laser at AMC

🎫 Buy Tickets
```

Premium formats are automatically detected and highlighted:
- IMAX with Laser at AMC
- Dolby Cinema at AMC
- RealD 3D
- Laser at AMC
- And more...

## 🗃️ Database Schema

The SQLite database tracks:
- **Theatres**: ID, name, location
- **Movies**: ID, name, release date, ratings  
- **Showtimes**: Movie/theatre relationships, times, attributes, notification status

## ⚠️ Rate Limiting & Ethics

- Built-in exponential backoff on API errors
- Respects AMC's API with reasonable polling intervals
- Designed for personal use, not commercial scraping
- Falls back gracefully on errors

## 🐛 Troubleshooting

### \"Theatre not found\"
- Check spelling in config.json
- Try partial names like \"Metreon\" instead of full name
- Use `bun src/cli.ts status` to verify

### \"No movies found\"
- AMC might not have advance tickets yet
- Try broader search terms
- Check AMC website to confirm movies exist

### Telegram notifications not working
- Verify bot token and chat ID
- Test with `bun src/cli.ts test`
- Ensure you've messaged your bot first

### Rate limiting errors  
- Increase `pollIntervalMinutes` in config
- Check for other applications using the same API key

## 📝 Development

Built with modern TypeScript and cutting-edge tools:

- **Runtime**: Bun (native TypeScript, blazing fast)
- **Database**: SQLite with better-sqlite3
- **HTTP Client**: Axios with interceptors
- **Fuzzy Search**: Fuse.js
- **CLI**: Commander.js

## 📄 License

ISC License - Use responsibly and respect AMC's terms of service.

---

*Happy movie watching! 🍿*