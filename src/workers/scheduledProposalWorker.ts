import { type Client } from "discord.js";
import { prisma } from "../db.js";
import { runMorningProposalWorkflow } from "../services/morningProposalService.js";

const CHECK_INTERVAL_MS = 60_000;
const STALE_RUNNING_JOB_MS = 30 * 60 * 1000;

type ScheduledProposalWorkerConfig = {
  jobKey: string;
  label: string;
  timeZone: string;
  hour: number;
  minute: number;
  guildId: string;
  channelId: string;
  proposerDiscordId: string;
};

export function startScheduledProposalWorker(
  client: Client<true>,
  config: ScheduledProposalWorkerConfig,
) {
  let isCheckingScheduledProposals = false;

  const run = async () => {
    if (isCheckingScheduledProposals) return;
    isCheckingScheduledProposals = true;

    try {
      const timeParts = getZonedTimeParts(new Date(), config.timeZone);
      const shouldRunNow =
        timeParts.hour > config.hour ||
        (timeParts.hour === config.hour && timeParts.minute >= config.minute);

      if (!shouldRunNow) return;

      const runKey = timeParts.dateKey;

      const existingRun = await prisma.scheduledJobRun.findUnique({
        where: {
          jobKey_runKey: {
            jobKey: config.jobKey,
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
            jobKey: config.jobKey,
            runKey,
          },
        },
        create: {
          jobKey: config.jobKey,
          runKey,
          status: "RUNNING",
        },
        update: {
          status: "RUNNING",
          error: null,
          completedAt: null,
        },
      });

      const result = await runMorningProposalWorkflow({
        client,
        guildId: config.guildId,
        channelId: config.channelId,
        proposerDiscordId: config.proposerDiscordId,
        runKey,
      });

      if (result.ideas.proposals.length === 0) {
        await prisma.scheduledJobRun.update({
          where: {
            jobKey_runKey: {
              jobKey: config.jobKey,
              runKey,
            },
          },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            error: result.ideas.skippedReason ?? null,
          },
        });

        return;
      }

      await prisma.scheduledJobRun.update({
        where: {
          jobKey_runKey: {
            jobKey: config.jobKey,
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
      console.error(`${config.label} proposal worker failed:`, error);

      const timeParts = getZonedTimeParts(new Date(), config.timeZone);

      await prisma.scheduledJobRun.upsert({
        where: {
          jobKey_runKey: {
            jobKey: config.jobKey,
            runKey: timeParts.dateKey,
          },
        },
        create: {
          jobKey: config.jobKey,
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
      isCheckingScheduledProposals = false;
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
