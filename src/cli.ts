#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { ShowtimeMonitor } from './monitor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

program
  .name('amc-showtime-monitor')
  .description('Monitor AMC showtimes and send Telegram notifications')
  .version('1.0.0');

program
  .command('check')
  .description('Check for new showtimes and send notifications')
  .option('-c, --config <path>', 'Path to config file', './config.json')
  .option('-d, --database <path>', 'Path to database file', './showtimes.db')
  .option('-v, --verbose', 'Verbose logging', false)
  .action(async (options) => {
    try {
      if (options.verbose) {
        console.log('🔧 Verbose mode enabled');
      }

      // Check if config file exists
      if (!existsSync(options.config)) {
        console.error(`❌ Config file not found: ${options.config}`);
        console.log(
          '💡 Create a config.json file based on config.example.json'
        );
        process.exit(1);
      }

      console.log(`📖 Loading config from: ${options.config}`);
      const config = await loadConfig(options.config);

      if (options.verbose) {
        console.log('📋 Config loaded:');
        console.log(`   Theatre: ${config.theatre}`);
        console.log(`   Movies: ${config.movies.join(', ')}`);
        console.log(`   Poll interval: ${config.pollIntervalMinutes} minutes`);
      }

      const monitor = new ShowtimeMonitor(config, options.database);

      // Initialize the monitor
      await monitor.initialize();

      // Run the check
      await monitor.checkForNewShowtimes();

      // Clean up
      monitor.close();
      console.log('🎉 Check completed successfully');
    } catch (error) {
      console.error('❌ Error during check:', error.message);
      if (options.verbose) {
        console.error('Stack trace:', error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('test')
  .description('Test Telegram bot connection')
  .option('-c, --config <path>', 'Path to config file', './config.json')
  .action(async (options) => {
    try {
      if (!existsSync(options.config)) {
        console.error(`❌ Config file not found: ${options.config}`);
        process.exit(1);
      }

      console.log('🧪 Testing Telegram bot connection...');
      const config = await loadConfig(options.config);
      const monitor = new ShowtimeMonitor(config);

      await monitor.initialize();
      await monitor.sendTestNotification();

      monitor.close();
      console.log('✅ Test completed successfully');
    } catch (error) {
      console.error('❌ Test failed:', error.message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current monitoring status')
  .option('-c, --config <path>', 'Path to config file', './config.json')
  .option('-d, --database <path>', 'Path to database file', './showtimes.db')
  .action(async (options) => {
    try {
      if (!existsSync(options.config)) {
        console.error(`❌ Config file not found: ${options.config}`);
        process.exit(1);
      }

      const config = await loadConfig(options.config);
      const monitor = new ShowtimeMonitor(config, options.database);

      await monitor.initialize();
      const status = await monitor.getStatus();

      console.log('📊 AMC Showtime Monitor Status');
      console.log('================================');
      console.log(`Theatre: ${status.theatre?.name || 'Not configured'}`);
      console.log(`Location: ${status.theatre?.location || 'N/A'}`);
      console.log(`Tracked Movies: ${status.trackedMovies.length}`);
      for (const movie of status.trackedMovies) {
        console.log(`  • ${movie}`);
      }
      console.log(`Unnotified Showtimes: ${status.unnotifiedShowtimes}`);
      console.log(`Poll Interval: ${config.pollIntervalMinutes} minutes`);

      monitor.close();
    } catch (error) {
      console.error('❌ Error getting status:', error.message);
      process.exit(1);
    }
  });

program
  .command('setup')
  .description('Interactive setup for Telegram bot')
  .action(async () => {
    console.log('🤖 Telegram Bot Setup Guide');
    console.log('============================');
    console.log();
    console.log('Follow these steps to set up your Telegram bot:');
    console.log();
    console.log('1. Open Telegram and message @BotFather');
    console.log('2. Send /newbot to create a new bot');
    console.log('3. Follow the prompts to name your bot');
    console.log(
      '4. Copy the bot token (looks like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)'
    );
    console.log('5. Start a chat with your new bot');
    console.log('6. Send any message to your bot');
    console.log(
      '7. Visit: https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates'
    );
    console.log(
      '8. Look for "chat":{"id": in the response - that\'s your chat ID'
    );
    console.log('9. Add both values to your config.json file');
    console.log();
    console.log('Example config.json:');
    console.log(
      JSON.stringify(
        {
          movies: ['Tron: Ares', 'Odyssey'],
          theatre: 'AMC Metreon 16',
          pollIntervalMinutes: 15,
          telegram: {
            botToken: 'YOUR_BOT_TOKEN_HERE',
            chatId: 'YOUR_CHAT_ID_HERE',
          },
          amcApiKey: 'your-amc-api-key-here',
        },
        null,
        2
      )
    );
  });

program
  .command('init')
  .description('Initialize a new config file')
  .action(async () => {
    const configPath = './config.json';

    if (existsSync(configPath)) {
      console.error('❌ config.json already exists');
      process.exit(1);
    }

    const exampleConfig = {
      movies: ['Tron: Ares', 'Odyssey'],
      theatre: 'AMC Metreon 16',
      pollIntervalMinutes: 15,
      telegram: {
        botToken: 'your-telegram-bot-token-here',
        chatId: 'your-telegram-chat-id-here',
      },
      amcApiKey: 'your-amc-api-key-here',
    };

    await Bun.write(configPath, JSON.stringify(exampleConfig, null, 2));

    console.log('✅ Created config.json');
    console.log('🔧 Edit the config.json file with your settings');
    console.log(
      '🤖 Run "bun src/cli.ts setup" for Telegram bot setup instructions'
    );
  });

// Handle the case where no command is provided
if (process.argv.length === 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse();
