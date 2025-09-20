import { z, ZodError } from 'zod';

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
  configPath: string = './config.json'
): Promise<AppConfig> {
  try {
    const configFile = Bun.file(configPath);
    const configText = await configFile.text();
    const rawConfig = JSON.parse(configText);

    return ConfigSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof Error && error.message.includes('No such file')) {
      throw new Error(
        `Config file not found at ${configPath}. Please create it with your settings.`
      );
    }

    if (error instanceof ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`Config validation failed:\n${errorMessages}`);
    }

    throw error;
  }
}
