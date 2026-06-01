import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { z } from "zod";
import { env } from "../env.js";
import {
  buildProposalEmbed,
  emptyVoteCounts,
  normalizeProposalAnalysis,
  normalizeProposalReasoning,
  type ProposalView,
} from "../proposals.js";
import { getOpenAIClient } from "./openaiService.js";
import { getPriceQuote, getThirtyDayPriceTrend } from "./priceService.js";
import { getProposalClosesAt } from "./proposalTiming.js";

const manualProposalSchema = z.object({
  symbol: z.string().trim().min(1).max(16),
  action: z.literal("buy"),
  amountUsd: z.number().positive().nullable(),
  shareQuantity: z.number().positive().nullable(),
  reasoning: z.string().trim().min(1).max(400).nullable(),
});

export type ManualProposalIdea = {
  action: "buy";
  symbol: string;
  amount: number;
  reasoning?: string | undefined;
  analysis?: string | undefined;
};

export type PendingManualProposal = {
  id: string;
  guildId: string;
  channelId: string;
  requestedByDiscordId: string;
  idea: ManualProposalIdea;
  createdAt: number;
};

const manualProposalResponseFormat = {
  type: "json_schema" as const,
  name: "manual_proposal",
  strict: true,
  description:
    "A single simulated stock proposal extracted from free text. Preserve the user's intent and only use reasoning supplied by the user.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["symbol", "action", "amountUsd", "shareQuantity", "reasoning"],
    properties: {
      symbol: { type: "string" },
      action: { type: "string", const: "buy" },
      amountUsd: { type: ["number", "null"] },
      shareQuantity: { type: ["number", "null"] },
      reasoning: { type: ["string", "null"] },
    },
  },
};

const pendingManualProposals = new Map<string, PendingManualProposal>();
const PENDING_MANUAL_PROPOSAL_TTL_MS = 15 * 60 * 1000;

export async function generateManualProposalIdea(
  freeText: string,
  analyze = false,
): Promise<
  | { status: "created"; idea: ManualProposalIdea }
  | { status: "missing_openai" }
  | { status: "invalid_model_output" }
  | { status: "missing_amount" }
  | { status: "missing_price"; symbol: string }
  | { status: "analysis_failed" }
> {
  const openai = getOpenAIClient();

  if (!openai) {
    return { status: "missing_openai" };
  }

  const response = await openai.responses.create({
    model: env.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: [
          "You extract one simulated stock proposal from an admin's free text.",
          "Return BUY proposals only, matching the existing morning proposal shape.",
          "The input may be Hebrew or English.",
          "Extract the stock symbol, buy action, and either a USD notional amount or a share quantity.",
          "If the user gives units, shares, מניות, or יחידות, put that number in shareQuantity.",
          "If the user gives dollars, USD, $, or a simulated cash amount, put that number in amountUsd.",
          "If the user gives reasoning, write a concise Hebrew reasoning no longer than 3 lines.",
          "If the user does not provide reasoning, return reasoning as null.",
          "Do not invent catalysts, facts, market news, or reasoning not present in the input.",
          "Return only structured output.",
        ].join(" "),
      },
      {
        role: "user",
        content: freeText,
      },
    ],
    text: {
      format: manualProposalResponseFormat,
    },
  });

  if (!response.output_text) {
    return { status: "invalid_model_output" };
  }

  try {
    const parsed = manualProposalSchema.parse(JSON.parse(response.output_text));
    const symbol = parsed.symbol.trim().toUpperCase();
    const amount = await resolveProposalAmount(parsed);

    if (amount.status === "missing_amount") return amount;
    if (amount.status === "missing_price") {
      return { status: "missing_price", symbol };
    }

    let analysis: string | undefined;

    if (analyze) {
      const analysisResult = await generateManualProposalAnalysis(symbol);

      if (analysisResult.status !== "created") {
        return { status: "analysis_failed" };
      }

      analysis = analysisResult.analysis;
    }

    return {
      status: "created",
      idea: {
        action: parsed.action,
        symbol,
        amount: amount.amount,
        reasoning: normalizeProposalReasoning(parsed.reasoning),
        analysis,
      },
    };
  } catch {
    return { status: "invalid_model_output" };
  }
}

export function createPendingManualProposal(params: {
  guildId: string;
  channelId: string;
  requestedByDiscordId: string;
  idea: ManualProposalIdea;
}) {
  cleanupExpiredPendingManualProposals();

  const pending: PendingManualProposal = {
    id: crypto.randomUUID(),
    guildId: params.guildId,
    channelId: params.channelId,
    requestedByDiscordId: params.requestedByDiscordId,
    idea: params.idea,
    createdAt: Date.now(),
  };

  pendingManualProposals.set(pending.id, pending);

  return pending;
}

export function consumePendingManualProposal(params: {
  pendingId: string;
  requestedByDiscordId: string;
}) {
  cleanupExpiredPendingManualProposals();

  const pending = pendingManualProposals.get(params.pendingId);

  if (!pending) return { status: "missing" as const };

  if (pending.requestedByDiscordId !== params.requestedByDiscordId) {
    return { status: "forbidden" as const };
  }

  pendingManualProposals.delete(params.pendingId);

  return {
    status: "created" as const,
    pending,
  };
}

export function discardPendingManualProposal(params: {
  pendingId: string;
  requestedByDiscordId: string;
}) {
  cleanupExpiredPendingManualProposals();

  const pending = pendingManualProposals.get(params.pendingId);

  if (!pending) return { status: "missing" as const };

  if (pending.requestedByDiscordId !== params.requestedByDiscordId) {
    return { status: "forbidden" as const };
  }

  pendingManualProposals.delete(params.pendingId);

  return { status: "discarded" as const };
}

export function buildManualProposalPreviewEmbed(params: {
  pendingId: string;
  proposerDiscordId: string;
  idea: ManualProposalIdea;
}) {
  const preview = buildProposalEmbed({
    id: `preview:${params.pendingId.slice(0, 8)}`,
    action: params.idea.action,
    symbol: params.idea.symbol,
    amount: params.idea.amount,
    proposerDiscordId: params.proposerDiscordId,
    reasoning: params.idea.reasoning,
    analysis: params.idea.analysis,
    closesAt: getProposalClosesAt(),
    status: "OPEN",
    counts: emptyVoteCounts(),
  });

  return EmbedBuilder.from(preview).setFooter({
    text: "תצוגה מקדימה - ההצעה תפורסם רק אחרי אישור.",
  });
}

export function buildManualProposalApprovalButtons(
  pendingId: string,
  disabled = false,
) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`manual-proposal:${pendingId}:approve`)
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),

    new ButtonBuilder()
      .setCustomId(`manual-proposal:${pendingId}:discard`)
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

export function buildManualProposalView(params: {
  id: string;
  proposerDiscordId: string;
  idea: ManualProposalIdea;
  closesAt: Date;
}): ProposalView {
  return {
    id: params.id,
    action: params.idea.action,
    symbol: params.idea.symbol,
    amount: params.idea.amount,
    proposerDiscordId: params.proposerDiscordId,
    reasoning: params.idea.reasoning,
    analysis: params.idea.analysis,
    closesAt: params.closesAt,
    status: "OPEN",
    counts: emptyVoteCounts(),
  };
}

async function resolveProposalAmount(
  parsed: z.infer<typeof manualProposalSchema>,
): Promise<
  | { status: "created"; amount: number }
  | { status: "missing_amount" }
  | { status: "missing_price" }
> {
  if (parsed.shareQuantity !== null) {
    try {
      const quote = await getPriceQuote(parsed.symbol);

      return {
        status: "created",
        amount: roundCurrency(parsed.shareQuantity * quote.price),
      };
    } catch {
      if (parsed.amountUsd !== null) {
        return {
          status: "created",
          amount: roundCurrency(parsed.amountUsd),
        };
      }

      return { status: "missing_price" };
    }
  }

  if (parsed.amountUsd !== null) {
    return {
      status: "created",
      amount: roundCurrency(parsed.amountUsd),
    };
  }

  return { status: "missing_amount" };
}

function cleanupExpiredPendingManualProposals() {
  const now = Date.now();

  for (const [id, pending] of pendingManualProposals.entries()) {
    if (now - pending.createdAt > PENDING_MANUAL_PROPOSAL_TTL_MS) {
      pendingManualProposals.delete(id);
    }
  }
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

async function generateManualProposalAnalysis(
  symbol: string,
): Promise<{ status: "created"; analysis: string } | { status: "failed" }> {
  const openai = getOpenAIClient();

  if (!openai) {
    return { status: "failed" };
  }

  const [priceQuote, priceTrend] = await Promise.all([
    getPriceQuote(symbol).catch(() => null),
    getThirtyDayPriceTrend(symbol),
  ]);

  const response = await openai.responses.create({
    model: env.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: [
          "Act like a senior Wall Street equity research analyst.",
          "Write the analysis in Hebrew only.",
          "Explain shortly in simple terms but with professional insights.",
          "Do not use markdown tables.",
          "Keep it concise enough for a Discord embed.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Analyze the stock: ${symbol}.`,
          "",
          priceQuote
            ? `Current price: $${priceQuote.price.toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}.`
            : "Current price: unavailable.",
          priceTrend
            ? `30-day price change: ${formatSignedNumber(priceTrend.absoluteChange)} (${formatSignedPercent(priceTrend.percentChange)}). Start: $${priceTrend.startPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}, end: $${priceTrend.endPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`
            : "30-day price change: unavailable, note that clearly.",
          "",
          "Include:",
          "• Business model and revenue streams",
          "• company and product overview",
          "• Competitive advantages (moat)",
          "• Industry trends",
          "• Financial health (revenue growth, margins, debt)",
          "• Key risks",
          "• describe the stock price change over the last 30 days",
          "",
          "Explain shortly in simple terms but with professional insights.",
        ].join("\n"),
      },
    ],
  });

  if (!response.output_text) {
    return { status: "failed" };
  }

  const analysis = normalizeProposalAnalysis(response.output_text);

  if (!analysis) {
    return { status: "failed" };
  }

  return { status: "created", analysis };
}

function formatSignedNumber(value: number) {
  return value >= 0 ? `+${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatSignedPercent(value: number) {
  return value >= 0
    ? `+${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}
