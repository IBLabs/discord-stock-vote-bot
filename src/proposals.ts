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
      ? "ההצבעה פתוחה."
      : `ההצבעה נסגרה. תוצאה: **${proposal.status === "PASSED" ? "עבר" : "נכשל"}**`;

  const statusLabel =
    proposal.status === "OPEN"
      ? "פתוח"
      : proposal.status === "PASSED"
        ? "עבר"
        : "נכשל";

  return new EmbedBuilder()
    .setTitle(`הצעה — ${proposal.action.toUpperCase()} ${proposal.symbol}`)
    .setDescription(
      [
        `הוצע על ידי: <@${proposal.proposerDiscordId}>`,
        "",
        `פעולה: **${proposal.action.toUpperCase()}**`,
        `סימול: **${proposal.symbol}**`,
        `סכום: **$${proposal.amount.toLocaleString()} מדומה**`,
        "",
        `סטטוס: **${statusLabel}**`,
        votingStatus,
        "",
        `קולות:`,
        `✅ בעד: **${proposal.counts.yes}**`,
        `❌ נגד: **${proposal.counts.no}**`,
        `🤷 נמנע: **${proposal.counts.abstain}**`,
        ...(proposal.executionSummary
          ? ["", `ביצוע: ${proposal.executionSummary}`]
          : []),
        "",
        "_תיק השקעות מדומה. אין עסקאות אמיתיות. לא ייעוץ פיננסי._",
      ].join("\n"),
    );
}

export function buildVoteButtons(proposalId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`vote:${proposalId}:yes`)
      .setLabel("בעד")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId(`vote:${proposalId}:no`)
      .setLabel("נגד")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId(`vote:${proposalId}:abstain`)
      .setLabel("נמנע")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}
