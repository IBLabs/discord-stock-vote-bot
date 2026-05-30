import { type Client } from "discord.js";
import { env } from "../env.js";
import { startScheduledProposalWorker } from "./scheduledProposalWorker.js";

const NIGHT_JOB_KEY = "night-proposals";

export function startNightProposalWorker(client: Client<true>) {
  return startScheduledProposalWorker(client, {
    jobKey: NIGHT_JOB_KEY,
    label: "Night",
    timeZone: env.NIGHT_PROPOSALS_TIMEZONE,
    hour: env.NIGHT_PROPOSALS_HOUR,
    minute: env.NIGHT_PROPOSALS_MINUTE,
    guildId: env.DISCORD_GUILD_ID,
    channelId: env.PROPOSALS_CHANNEL_ID,
    proposerDiscordId: client.user.id,
  });
}
