import { ChannelType, type Client } from "discord.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import {
  buildProposalEmbed,
  buildProposalHistoryEmbed,
  buildVoteButtons,
  decideProposalStatus,
  getVoteCounts,
  type ProposalView,
  type ProposalStatus,
} from "../proposals.js";
import { executePassedProposal } from "./portfolioService.js";

export async function postProposalToChannel(
  client: Client<true>,
  proposal: ProposalView,
  channelId: string,
) {
  const channel = await client.channels.fetch(channelId);

  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("Could not find the proposals channel.");
  }

  const message = await channel.send({
    embeds: [buildProposalEmbed(proposal)],
    components: [buildVoteButtons(proposal.id)],
  });

  return {
    channelId: message.channelId,
    messageId: message.id,
  };
}

export async function closeExpiredProposals(client: Client<true>) {
  const expiredProposals = await prisma.proposal.findMany({
    where: {
      status: "OPEN",
      closesAt: {
        lte: new Date(),
      },
    },
  });

  for (const proposal of expiredProposals) {
    const counts = await getVoteCounts(proposal.id);
    const nextStatus = decideProposalStatus(counts);
    const resolvedAt = new Date();

    const updateResult = await prisma.proposal.updateMany({
      where: {
        id: proposal.id,
        status: "OPEN",
      },
      data: {
        status: nextStatus,
        resolvedAt,
      },
    });

    if (updateResult.count === 0) continue;

    const executionResult =
      nextStatus === "PASSED"
        ? await executePassedProposal({
            id: proposal.id,
            guildId: proposal.guildId,
            action: proposal.action,
            symbol: proposal.symbol,
            amount: proposal.amount,
          })
        : null;

    const executionSummary = executionResult?.message;

    if (nextStatus === "PASSED") {
      await postProposalHistory(
        client,
        {
          id: proposal.id,
          action: proposal.action,
          symbol: proposal.symbol,
          amount: proposal.amount,
          proposerDiscordId: proposal.proposerDiscordId,
          reasoning: proposal.reasoning,
          analysis: proposal.analysis,
          closesAt: proposal.closesAt,
          status: nextStatus,
          counts,
          executionSummary,
        },
      );
    }

    await updateProposalMessage(client, {
      id: proposal.id,
      action: proposal.action,
      symbol: proposal.symbol,
      amount: proposal.amount,
      proposerDiscordId: proposal.proposerDiscordId,
      reasoning: proposal.reasoning,
      analysis: proposal.analysis,
      closesAt: proposal.closesAt,
      status: nextStatus,
      counts,
      executionSummary,
      discordChannelId: proposal.discordChannelId,
      discordMessageId: proposal.discordMessageId,
    });
  }
}

async function updateProposalMessage(
  client: Client<true>,
  proposal: {
    id: string;
    action: string;
    symbol: string;
    amount: number;
    proposerDiscordId: string;
    reasoning: string | null;
    analysis: string | null;
    closesAt: Date;
    status: Exclude<ProposalStatus, "OPEN">;
    counts: Awaited<ReturnType<typeof getVoteCounts>>;
    executionSummary: string | undefined;
    discordChannelId: string | null;
    discordMessageId: string | null;
  },
) {
  if (!proposal.discordChannelId || !proposal.discordMessageId) return;

  const channel = await client.channels.fetch(proposal.discordChannelId);

  if (!channel || channel.type !== ChannelType.GuildText) return;

  const message = await channel.messages.fetch(proposal.discordMessageId);

  await message.edit({
    embeds: [
      buildProposalEmbed({
        id: proposal.id,
        action: proposal.action,
        symbol: proposal.symbol,
        amount: proposal.amount,
        proposerDiscordId: proposal.proposerDiscordId,
        reasoning: proposal.reasoning,
        analysis: proposal.analysis,
        closesAt: proposal.closesAt,
        status: proposal.status,
        counts: proposal.counts,
        executionSummary: proposal.executionSummary,
      }),
    ],
    components: [buildVoteButtons(proposal.id, true)],
  });
}

async function postProposalHistory(
  client: Client<true>,
  proposal: ProposalView,
) {
  if (!env.HISTORY_CHANNEL_ID) return;

  const channel = await client.channels.fetch(env.HISTORY_CHANNEL_ID);

  if (!channel || channel.type !== ChannelType.GuildText) return;

  await channel.send({
    embeds: [buildProposalHistoryEmbed(proposal)],
  });
}
