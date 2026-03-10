import { existsSync } from 'node:fs';
import { ZodError, z } from 'zod';

export const RuntimeConfigSchema = z.object({
  pollIntervalSeconds: z.coerce.number().int().positive().default(60),
  telegramLongPollSeconds: z.coerce.number().int().min(0).max(50).default(30),
  healthchecksPingUrl: z.string().url().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
});

export const ConfigSchema = z.object({
  theatre: z.string().min(1, 'Theatre name cannot be empty'),
  telegram: z.object({
    botToken: z.string().min(1, 'Telegram bot token cannot be empty'),
    chatId: z.string().min(1, 'Telegram chat ID cannot be empty'),
  }),
  amcApiKey: z.string().min(1, 'AMC API key cannot be empty'),
  runtime: RuntimeConfigSchema.default({
    pollIntervalSeconds: 60,
    telegramLongPollSeconds: 30,
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export async function loadConfig(
  configPath: string = process.env.CONFIG_PATH || './data/config.json'
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
    runtime: {
      pollIntervalSeconds:
        process.env.POLL_INTERVAL_SECONDS ??
        rawConfig.runtime?.pollIntervalSeconds,
      telegramLongPollSeconds:
        process.env.TELEGRAM_LONG_POLL_SECONDS ??
        rawConfig.runtime?.telegramLongPollSeconds,
      healthchecksPingUrl:
        process.env.HEALTHCHECKS_PING_URL ??
        rawConfig.runtime?.healthchecksPingUrl,
      port: process.env.PORT ?? rawConfig.runtime?.port,
    },
  };

  try {
    return ConfigSchema.parse(envConfig);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
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
