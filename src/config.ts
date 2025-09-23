import { existsSync } from 'node:fs';
import { ZodError, z } from 'zod';

export const ConfigSchema = z.object({
  theatre: z.string().min(1, 'Theatre name cannot be empty'),
  telegram: z.object({
    botToken: z.string().min(1, 'Telegram bot token cannot be empty'),
    chatId: z.string().min(1, 'Telegram chat ID cannot be empty'),
  }),
  amcApiKey: z.string().min(1, 'AMC API key cannot be empty'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(
  configPath: string = './data/config.json'
): Promise<AppConfig> {
  // Try to load from config file first
  let rawConfig: Partial<AppConfig> = {};
  if (existsSync(configPath)) {
    try {
      const configFile = Bun.file(configPath);
      const configText = await configFile.text();
      rawConfig = JSON.parse(configText);
    } catch (error) {
      throw new Error(`Failed to parse config file at ${configPath}: ${error}`);
    }
  }

  // Override with environment variables if they exist
  const envConfig = {
    theatre: process.env.THEATRE || rawConfig.theatre,
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || rawConfig.telegram?.botToken,
      chatId: process.env.TELEGRAM_CHAT_ID || rawConfig.telegram?.chatId,
    },
    amcApiKey: process.env.AMC_API_KEY || rawConfig.amcApiKey,
  };

  try {
    return ConfigSchema.parse(envConfig);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');

      const configSource = existsSync(configPath)
        ? `config file (${configPath}) and environment variables`
        : 'environment variables only';

      throw new Error(
        `Config validation failed using ${configSource}:\n${errorMessages}\n\nRequired environment variables:\n- THEATRE\n- TELEGRAM_BOT_TOKEN\n- TELEGRAM_CHAT_ID\n- AMC_API_KEY`
      );
    }
    throw error;
  }
}
