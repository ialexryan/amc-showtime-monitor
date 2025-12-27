#!/usr/bin/env bun

import { existsSync, unlinkSync } from 'node:fs';
import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config.js';
import { ShowtimeDatabase } from './database.js';
import { getErrorMessage, getErrorStack } from './errors.js';
import { ShowtimeMonitor } from './monitor.js';

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
  .option('-c, --config <path>', 'Path to config file', './data/config.json')
  .option(
    '-d, --database <path>',
    'Path to database file',
    './data/amc-monitor.db'
  )
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

      const monitor = new ShowtimeMonitor(config, options.database);

      // Initialize the monitor
      await monitor.initialize();

      // Process any pending Telegram commands
      await monitor.processTelegramCommands();

      // Run the showtime check
      await monitor.checkForNewShowtimes();

      // Clean up (flushes logs and closes database)
      monitor.close();
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('❌ Error during check:', message);
      if (options.verbose) {
        const stack = getErrorStack(error);
        if (stack) {
          console.error('Stack trace:', stack);
        }
      }
      process.exit(1);
    }
  });

program
  .command('test-telegram')
  .description('Test Telegram bot connection and send test message')
  .option('-c, --config <path>', 'Path to config file', './data/config.json')
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
      const message = getErrorMessage(error);
      console.error('❌ Test failed:', message);
      process.exit(1);
    }
  });

program
  .command('show-status')
  .description('Show current monitoring status and watchlist')
  .option('-c, --config <path>', 'Path to config file', './data/config.json')
  .option(
    '-d, --database <path>',
    'Path to database file',
    './data/amc-monitor.db'
  )
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
      console.log(`Watchlist: ${status.trackedMovies.length} movies`);
      console.log(
        `Checks: ${status.runsLastHour} last hour, ${status.runsLast24Hours} last 24h`
      );
      for (const movie of status.trackedMovies) {
        console.log(`  • ${movie}`);
      }
      console.log(`Unnotified Showtimes: ${status.unnotifiedShowtimes}`);

      monitor.close();
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('❌ Error getting status:', message);
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
    const configPath = './data/config.json';
    const exampleConfigPath = './data/config.example.json';

    // Ensure data directory exists
    if (!existsSync('./data')) {
      await Bun.write('./data/.gitkeep', '');
      console.log('📁 Created data directory');
    }

    if (existsSync(configPath)) {
      console.error('❌ data/config.json already exists');
      process.exit(1);
    }

    if (!existsSync(exampleConfigPath)) {
      console.error('❌ data/config.example.json not found');
      process.exit(1);
    }

    const exampleConfigFile = Bun.file(exampleConfigPath);
    const exampleConfigContent = await exampleConfigFile.text();
    await Bun.write(configPath, exampleConfigContent);

    console.log('✅ Created data/config.json from data/config.example.json');
    console.log('🔧 Edit the data/config.json file with your settings');
    console.log(
      '🤖 Run "bun src/cli.ts telegram-setup" for Telegram bot setup instructions'
    );
  });

program
  .command('reset-db')
  .description(
    'Reset the database (removes all tracked showtimes and watchlist)'
  )
  .option(
    '-d, --database <path>',
    'Path to database file',
    './data/amc-monitor.db'
  )
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
      const message = getErrorMessage(error);
      console.error('❌ Error resetting database:', message);
      process.exit(1);
    }
  });

program
  .command('logs')
  .description('Show logs from recent runs')
  .option('-n, --runs <number>', 'Number of recent runs to show', '1')
  .action(async (options) => {
    // Helper function to convert ISO UTC timestamp to Pacific time
    const formatTimestamp = (isoTimestamp: string): string => {
      return new Date(isoTimestamp).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        hour12: false,
      });
    };

    try {
      const database = new ShowtimeDatabase();
      const numRuns = Number(options.runs);
      const recentRunIds = database.getRecentRunIds(numRuns);

      if (recentRunIds.length === 0) {
        console.log('No logs found');
        return;
      }

      for (const runId of recentRunIds) {
        const runLogs = database.getLogsByRunId(runId);
        if (runLogs.length > 0) {
          const [firstLog] = runLogs;
          if (!firstLog) {
            continue;
          }
          const header =
            numRuns === 1
              ? `=== Most Recent Run (${formatTimestamp(firstLog.timestamp)} PT) ===`
              : `\n=== Run at ${formatTimestamp(firstLog.timestamp)} PT ===`;

          console.log(header);

          for (const log of runLogs) {
            console.log(log.message);
          }
        }
      }

      database.close();
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('❌ Error reading logs:', message);
      process.exit(1);
    }
  });

// Database maintenance command
program
  .command('db-maintenance')
  .description(
    'Run database maintenance tasks (integrity check, backup, optimization)'
  )
  .option(
    '-d, --database <path>',
    'Path to database file',
    './data/amc-monitor.db'
  )
  .option(
    '-b, --backup-only',
    'Only create a backup without running full maintenance'
  )
  .option(
    '-c, --check-only',
    'Only check integrity without running maintenance'
  )
  .option('-s, --stats', 'Show database statistics')
  .action(async (options) => {
    try {
      const database = new ShowtimeDatabase(options.database);

      if (options.checkOnly) {
        console.log('🔍 Checking database integrity...');
        const isHealthy = database.checkIntegrity();
        if (isHealthy) {
          console.log('✅ Database integrity check passed');
        } else {
          console.log('❌ Database integrity check FAILED');
          console.log('Creating emergency backup...');
          database.backup(`./data/backups/integrity-failed-${Date.now()}.db`);
        }
      } else if (options.backupOnly) {
        console.log('💾 Creating database backup...');
        const backupPath = database.backup();
        if (backupPath) {
          console.log(`✅ Backup created: ${backupPath}`);
        } else {
          console.log('❌ Backup failed');
        }
      } else if (options.stats) {
        console.log('📊 Database Statistics:');
        const stats = database.getDbStats();
        if (stats) {
          console.log(`  Size: ${stats.sizeInMB} MB`);
          console.log(`  Pages: ${stats.pageCount.page_count}`);
          console.log(`  Page Size: ${stats.pageSize.page_size} bytes`);
          console.log(`  Cache: ${stats.cacheInMB} MB`);
          console.log(`  Journal Mode: ${stats.walMode.journal_mode}`);
          console.log(`  Free Pages: ${stats.freelist.freelist_count}`);
          console.log(`  Integrity: ${stats.integrityCheck.quick_check}`);
        }
      } else {
        console.log('🔧 Running full database maintenance...');
        database.runMaintenance();
        console.log('✅ Maintenance complete');
      }

      database.close();
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('❌ Error during database maintenance:', message);
      process.exit(1);
    }
  });

// Handle the case where no command is provided
if (process.argv.length === 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse();
