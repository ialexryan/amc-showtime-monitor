export interface Config {
  theatre: string;
  pollIntervalMinutes?: number;
  telegram: {
    botToken: string;
    chatId: string;
  };
  amcApiKey: string;
}

export interface AppConfig extends Config {
  pollIntervalMinutes: number;
}

export async function loadConfig(
  configPath: string = './config.json'
): Promise<AppConfig> {
  try {
    const configFile = Bun.file(configPath);
    const configText = await configFile.text();
    const config: Config = JSON.parse(configText);

    // Validate required fields
    if (config.movies) {
      throw new Error(
        'Config must not include movies - use Telegram bot commands to manage watchlist'
      );
    }

    if (!config.theatre) {
      throw new Error('Config must include theatre name');
    }

    if (!config.telegram?.botToken || !config.telegram?.chatId) {
      throw new Error('Config must include Telegram bot token and chat ID');
    }

    if (!config.amcApiKey) {
      throw new Error('Config must include AMC API key');
    }

    return {
      ...config,
      pollIntervalMinutes: config.pollIntervalMinutes ?? 1,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('No such file')) {
      throw new Error(
        `Config file not found at ${configPath}. Please create it with your settings.`
      );
    }
    throw error;
  }
}
