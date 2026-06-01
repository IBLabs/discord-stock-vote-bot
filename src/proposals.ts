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
  reasoning?: string | null | undefined;
  closesAt: Date;
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

export function normalizeProposalReasoning(
  reasoning: string | null | undefined,
) {
  if (!reasoning) return undefined;

  const cleaned = reasoning
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("\n")
    .trim();

  return cleaned.length > 0 ? cleaned : undefined;
}

export function formatProposalReasoningLines(
  reasoning: string | null | undefined,
) {
  const normalized = normalizeProposalReasoning(reasoning);

  if (!normalized) return [];

  const compact = normalized.replace(/\s+/g, " ");

  return ["סיבה", compact];
}

export function buildProposalEmbed(proposal: ProposalView) {
  const votingStatus =
    proposal.status === "OPEN"
      ? undefined
      : `תוצאה: **${proposal.status === "PASSED" ? "עבר" : "נכשל"}**`;

  const summary = `${proposal.symbol} | ${proposal.action.toUpperCase()} | $${proposal.amount.toLocaleString()}`;
  const closesAtUnixSeconds = Math.floor(proposal.closesAt.getTime() / 1000);
  const timer = `🕒 נסגר <t:${closesAtUnixSeconds}:R>`;
  const votes = `✅ ${proposal.counts.yes}   ❌ ${proposal.counts.no}   🤷 ${proposal.counts.abstain}`;
  const proposalId = `ID: \`${proposal.id}\``;

  return new EmbedBuilder()
    .setTitle(`<@${proposal.proposerDiscordId}>`)
    .setDescription(
      [
        summary,
        "",
        ...formatProposalReasoningLines(proposal.reasoning),
        ...(proposal.reasoning ? [""] : []),
        ...(votingStatus ? [votingStatus, ""] : []),
        votes,
        ...(proposal.executionSummary
          ? ["", `ביצוע: ${proposal.executionSummary}`]
          : []),
        "",
        "_תיק השקעות מדומה. אין עסקאות אמיתיות. לא ייעוץ פיננסי._",
        "",
        timer,
        proposalId,
      ].join("\n"),
    );
}

export function buildProposalHistoryEmbed(proposal: ProposalView) {
  const closesAtUnixSeconds = Math.floor(proposal.closesAt.getTime() / 1000);
  const statusText =
    proposal.status === "PASSED" ? "בוצע" : proposal.status === "FAILED" ? "נכשל" : "פתוח";
  const executionLines = proposal.executionSummary
    ? ["", `ביצוע: ${proposal.executionSummary}`]
    : [];

  return new EmbedBuilder()
    .setTitle("תיעוד ביצוע הצעה")
    .setDescription(
      [
        `מציע: <@${proposal.proposerDiscordId}>`,
        `פעולה: **${proposal.action.toUpperCase()}**`,
        `נכס: **${proposal.symbol}**`,
        `סכום: **$${proposal.amount.toLocaleString()}**`,
        `סטטוס: **${statusText}**`,
        ...(proposal.reasoning ? ["", `סיבה: ${proposal.reasoning.replace(/\s+/g, " ")}`] : []),
        ...executionLines,
        "",
        `נסגר <t:${closesAtUnixSeconds}:R>`,
        `ID: \`${proposal.id}\``,
      ].join("\n"),
    );
}

export function buildVoteButtons(proposalId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`vote:${proposalId}:yes`)
      .setLabel("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId(`vote:${proposalId}:no`)
      .setLabel("❌")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId(`vote:${proposalId}:abstain`)
      .setLabel("🤷")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}
