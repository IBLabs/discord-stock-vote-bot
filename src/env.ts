import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  PROPOSALS_CHANNEL_ID: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  FINNHUB_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  MORNING_PROPOSALS_TIMEZONE: z.string().min(1).default("America/New_York"),
  MORNING_PROPOSALS_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  MORNING_PROPOSALS_MINUTE: z.coerce.number().int().min(0).max(59).default(0),
});

export const env = envSchema.parse(process.env);
