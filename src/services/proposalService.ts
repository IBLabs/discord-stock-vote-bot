import { ChannelType, type Client } from "discord.js";
import { prisma } from "../db.js";
import {
  buildProposalEmbed,
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

    const executionSummary =
      nextStatus === "PASSED"
        ? (
            await executePassedProposal({
              id: proposal.id,
              guildId: proposal.guildId,
              action: proposal.action,
              symbol: proposal.symbol,
              amount: proposal.amount,
            })
          ).message
        : undefined;

    await updateProposalMessage(client, {
      id: proposal.id,
      action: proposal.action,
      symbol: proposal.symbol,
      amount: proposal.amount,
      proposerDiscordId: proposal.proposerDiscordId,
      reasoning: proposal.reasoning,
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
        closesAt: proposal.closesAt,
        status: proposal.status,
        counts: proposal.counts,
        executionSummary: proposal.executionSummary,
      }),
    ],
    components: [buildVoteButtons(proposal.id, true)],
  });
}
