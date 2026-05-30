import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { prisma } from "./db.js";

export type VoteValue = "yes" | "no" | "abstain";

export type ProposalStatus = "OPEN" | "PASSED" | "FAILED";

export type VoteCounts = Record<VoteValue, number>;

export type ProposalView = {
  id: string;
  action: string;
  symbol: string;
  amount: number;
  proposerDiscordId: string;
  status: ProposalStatus;
  counts: VoteCounts;
  executionSummary?: string | undefined;
};

export function isVoteValue(value: string | undefined): value is VoteValue {
  return value === "yes" || value === "no" || value === "abstain";
}

export function emptyVoteCounts(): VoteCounts {
  return {
    yes: 0,
    no: 0,
    abstain: 0,
  };
}

export async function getVoteCounts(proposalId: string): Promise<VoteCounts> {
  const votes = await prisma.vote.groupBy({
    by: ["vote"],
    where: { proposalId },
    _count: { vote: true },
  });

  const counts = emptyVoteCounts();

  for (const vote of votes) {
    if (isVoteValue(vote.vote)) {
      counts[vote.vote] = vote._count.vote;
    }
  }

  return counts;
}

export function decideProposalStatus(
  counts: VoteCounts,
): Exclude<ProposalStatus, "OPEN"> {
  const participation = counts.yes + counts.no + counts.abstain;

  return participation >= 1 && counts.yes > counts.no ? "PASSED" : "FAILED";
}

export function buildProposalEmbed(proposal: ProposalView) {
  const votingStatus =
    proposal.status === "OPEN"
      ? "Voting is open."
      : `Voting closed. Result: **${proposal.status}**`;

  return new EmbedBuilder()
    .setTitle(`Proposal — ${proposal.action.toUpperCase()} ${proposal.symbol}`)
    .setDescription(
      [
        `Proposed by: <@${proposal.proposerDiscordId}>`,
        "",
        `Action: **${proposal.action.toUpperCase()}**`,
        `Symbol: **${proposal.symbol}**`,
        `Amount: **$${proposal.amount.toLocaleString()} fake**`,
        "",
        votingStatus,
        "",
        `Votes:`,
        `✅ Yes: **${proposal.counts.yes}**`,
        `❌ No: **${proposal.counts.no}**`,
        `🤷 Abstain: **${proposal.counts.abstain}**`,
        ...(proposal.executionSummary
          ? ["", `Execution: ${proposal.executionSummary}`]
          : []),
        "",
        "_Simulated portfolio. No real trades. Not financial advice._",
      ].join("\n"),
    );
}

export function buildVoteButtons(proposalId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`vote:${proposalId}:yes`)
      .setLabel("Yes")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId(`vote:${proposalId}:no`)
      .setLabel("No")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId(`vote:${proposalId}:abstain`)
      .setLabel("Abstain")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}
