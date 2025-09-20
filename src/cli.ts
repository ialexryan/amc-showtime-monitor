#!/usr/bin/env bun

import { existsSync, unlinkSync } from 'node:fs';
import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config.js';
import { ShowtimeMonitor } from './monitor.js';
import { Logger } from './logger.js';
import { ShowtimeDatabase } from './database.js';

const program = new Command();

program
  .name(packageJson.name)
  .description(packageJson.description)
  .version(packageJson.version);

program
  .command('monitor')
  .description(
    'Run the main monitoring loop (check showtimes and process Telegram commands)'
  )
  .option('-c, --config <path>', 'Path to config file', './config.json')
  .option('-d, --database <path>', 'Path to database file', './amc-monitor.db')
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
      }

      // Create database and logger
      const database = new ShowtimeDatabase(options.database);
      const logger = new Logger(database);

      const monitor = new ShowtimeMonitor(config, logger, options.database);

      // Initialize the monitor
      await monitor.initialize();

      // Process any pending Telegram commands
      await monitor.processTelegramCommands();

      // Run the showtime check
      await monitor.checkForNewShowtimes();

      // Save logs to database
      logger.flush();

      // Clean up
      monitor.close();
      database.close();
      logger.info('🎉 Monitor run completed successfully');
    } catch (error) {
      console.error('❌ Error during check:', error.message);
      if (options.verbose) {
        console.error('Stack trace:', error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('test-telegram')
  .description('Test Telegram bot connection and send test message')
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
  .command('show-status')
  .description('Show current monitoring status and watchlist')
  .option('-c, --config <path>', 'Path to config file', './config.json')
  .option('-d, --database <path>', 'Path to database file', './amc-monitor.db')
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
      console.log(`Watchlist: ${status.trackedMovies.length} movies`);
      for (const movie of status.trackedMovies) {
        console.log(`  • ${movie}`);
      }
      console.log(`Unnotified Showtimes: ${status.unnotifiedShowtimes}`);

      monitor.close();
    } catch (error) {
      console.error('❌ Error getting status:', error.message);
      process.exit(1);
    }
  });

program
  .command('telegram-setup')
  .description('Show step-by-step instructions for setting up Telegram bot')
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
    console.log('See config.example.json for the template structure.');
  });

program
  .command('create-config')
  .description('Create a new config.json file from template')
  .action(async () => {
    const configPath = './config.json';
    const exampleConfigPath = './config.example.json';

    if (existsSync(configPath)) {
      console.error('❌ config.json already exists');
      process.exit(1);
    }

    if (!existsSync(exampleConfigPath)) {
      console.error('❌ config.example.json not found');
      process.exit(1);
    }

    const exampleConfigFile = Bun.file(exampleConfigPath);
    const exampleConfigContent = await exampleConfigFile.text();
    await Bun.write(configPath, exampleConfigContent);

    console.log('✅ Created config.json from config.example.json');
    console.log('🔧 Edit the config.json file with your settings');
    console.log(
      '🤖 Run "bun src/cli.ts telegram-setup" for Telegram bot setup instructions'
    );
  });

program
  .command('reset-db')
  .description(
    'Reset the database (removes all tracked showtimes and watchlist)'
  )
  .option('-d, --database <path>', 'Path to database file', './amc-monitor.db')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (options) => {
    try {
      if (!existsSync(options.database)) {
        console.log(
          `📄 Database file ${options.database} doesn't exist - nothing to reset`
        );
        process.exit(0);
      }

      if (!options.yes) {
        console.log(
          '⚠️  This will delete all tracked showtimes and reset notification history.'
        );
        console.log(
          '   You will receive notifications for all existing showtimes again.'
        );
        console.log();

        // Simple confirmation without external dependencies
        const answer = prompt(
          'Are you sure you want to reset the database? (y/N): '
        );
        if (answer?.toLowerCase() !== 'y' && answer?.toLowerCase() !== 'yes') {
          console.log('❌ Database reset cancelled');
          process.exit(0);
        }
      }

      // Delete the database file
      unlinkSync(options.database);

      console.log('✅ Database reset successfully');
      console.log(
        '💡 The database will be recreated automatically on the next run'
      );
    } catch (error) {
      console.error('❌ Error resetting database:', error.message);
      process.exit(1);
    }
  });

program
  .command('logs')
  .description('Show logs from the most recent run')
  .option('-a, --all', 'Show all runs instead of just the most recent')
  .option(
    '-n, --lines <number>',
    'Number of recent runs to show (with --all)',
    '5'
  )
  .action(async (options) => {
    try {
      const database = new ShowtimeDatabase();

      if (options.all) {
        // Show recent runs
        const logs = database.getRecentLogs(Number(options.lines) * 20); // Estimate logs per run

        if (logs.length === 0) {
          console.log('No logs found');
          return;
        }

        let currentRunId = '';
        for (const log of logs.reverse()) {
          if (log.run_id !== currentRunId) {
            currentRunId = log.run_id;
            console.log(`\n=== Run at ${log.timestamp} ===`);
          }
          const movieInfo = log.movie ? ` [${log.movie}]` : '';
          console.log(`${log.level}: ${log.message}${movieInfo}`);
        }
      } else {
        // Show just the most recent run
        const recentLogs = database.getRecentLogs(100);
        if (recentLogs.length === 0) {
          console.log('No logs found');
          return;
        }

        const mostRecentRunId = recentLogs[0].run_id;
        const runLogs = recentLogs
          .filter((log) => log.run_id === mostRecentRunId)
          .reverse();

        console.log(`=== Most Recent Run (${runLogs[0].timestamp}) ===`);
        for (const log of runLogs) {
          const movieInfo = log.movie ? ` [${log.movie}]` : '';
          console.log(`${log.level}: ${log.message}${movieInfo}`);
        }
      }

      database.close();
    } catch (error) {
      console.error('❌ Error reading logs:', error.message);
      process.exit(1);
    }
  });

// Handle the case where no command is provided
if (process.argv.length === 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse();
