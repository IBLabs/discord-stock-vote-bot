import { type Client } from "discord.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import {
  generateMorningProposalIdeas,
  postMorningProposals,
} from "../services/morningProposalService.js";

const MORNING_JOB_KEY = "morning-proposals";
const CHECK_INTERVAL_MS = 60_000;
const STALE_RUNNING_JOB_MS = 30 * 60 * 1000;

let isCheckingMorningProposals = false;

export function startMorningProposalWorker(client: Client<true>) {
  const run = async () => {
    if (isCheckingMorningProposals) return;
    isCheckingMorningProposals = true;

    try {
      const timeParts = getZonedTimeParts(
        new Date(),
        env.MORNING_PROPOSALS_TIMEZONE,
      );
      const shouldRunNow =
        timeParts.hour > env.MORNING_PROPOSALS_HOUR ||
        (timeParts.hour === env.MORNING_PROPOSALS_HOUR &&
          timeParts.minute >= env.MORNING_PROPOSALS_MINUTE);

      if (!shouldRunNow) return;

      const runKey = timeParts.dateKey;

      const existingRun = await prisma.scheduledJobRun.findUnique({
        where: {
          jobKey_runKey: {
            jobKey: MORNING_JOB_KEY,
            runKey,
          },
        },
      });

      if (existingRun?.status === "COMPLETED") return;
      if (
        existingRun?.status === "RUNNING" &&
        Date.now() - existingRun.startedAt.getTime() < STALE_RUNNING_JOB_MS
      ) {
        return;
      }

      await prisma.scheduledJobRun.upsert({
        where: {
          jobKey_runKey: {
            jobKey: MORNING_JOB_KEY,
            runKey,
          },
        },
        create: {
          jobKey: MORNING_JOB_KEY,
          runKey,
          status: "RUNNING",
        },
        update: {
          status: "RUNNING",
          error: null,
          completedAt: null,
        },
      });

      const ideas = await generateMorningProposalIdeas(env.DISCORD_GUILD_ID);

      if (ideas.proposals.length === 0) {
        await prisma.scheduledJobRun.update({
          where: {
            jobKey_runKey: {
              jobKey: MORNING_JOB_KEY,
              runKey,
            },
          },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            error: ideas.skippedReason ?? null,
          },
        });

        return;
      }

      await postMorningProposals({
        client,
        guildId: env.DISCORD_GUILD_ID,
        channelId: env.PROPOSALS_CHANNEL_ID,
        proposerDiscordId: client.user.id,
        runKey,
        ideas: ideas.proposals,
      });

      await prisma.scheduledJobRun.update({
        where: {
          jobKey_runKey: {
            jobKey: MORNING_JOB_KEY,
            runKey,
          },
        },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          error: null,
        },
      });
    } catch (error) {
      console.error("Morning proposal worker failed:", error);

      const timeParts = getZonedTimeParts(
        new Date(),
        env.MORNING_PROPOSALS_TIMEZONE,
      );

      await prisma.scheduledJobRun.upsert({
        where: {
          jobKey_runKey: {
            jobKey: MORNING_JOB_KEY,
            runKey: timeParts.dateKey,
          },
        },
        create: {
          jobKey: MORNING_JOB_KEY,
          runKey: timeParts.dateKey,
          status: "FAILED",
          error: error instanceof Error ? error.message : "Unknown error",
          completedAt: new Date(),
        },
        update: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "Unknown error",
          completedAt: new Date(),
        },
      });
    } finally {
      isCheckingMorningProposals = false;
    }
  };

  void run();

  return setInterval(() => {
    void run();
  }, CHECK_INTERVAL_MS);
}

function getZonedTimeParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return {
    dateKey: `${lookup.year}-${lookup.month}-${lookup.day}`,
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
  };
}
