import { type Client } from "discord.js";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { emptyVoteCounts, normalizeProposalReasoning } from "../proposals.js";
import { getMorningNewsDigest } from "./newsService.js";
import { getOpenAIClient } from "./openaiService.js";
import { getPortfolioSnapshot } from "./portfolioService.js";
import { postProposalToChannel } from "./proposalService.js";

const morningProposalSchema = z.object({
  proposals: z
    .array(
      z.object({
        symbol: z.string().trim().min(1).max(16),
        action: z.literal("buy"),
        amount: z.number().positive(),
        reasoning: z
          .string()
          .trim()
          .min(1)
          .max(400)
          .refine((value) => value.split(/\r?\n/).filter(Boolean).length <= 3, {
            message: "Reasoning must be 3 lines or less.",
          }),
      }),
    )
    .min(1)
    .max(3),
});

export type MorningProposalIdea = z.infer<
  typeof morningProposalSchema
>["proposals"][number];
export type MorningProposalGenerationResult = {
  portfolio: Awaited<ReturnType<typeof getPortfolioSnapshot>>;
  newsDigest: Awaited<ReturnType<typeof getMorningNewsDigest>>;
  proposals: MorningProposalIdea[];
  skippedReason?: string;
};

const morningProposalResponseFormat = {
  type: "json_schema" as const,
  name: "morning_proposals",
  strict: true,
  description:
    "Morning simulated stock proposals with short rationale. Choose 1 to 3 BUY proposals only.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["symbol", "action", "amount", "reasoning"],
          properties: {
            symbol: { type: "string" },
            action: { type: "string", const: "buy" },
            amount: { type: "number" },
            reasoning: { type: "string" },
          },
        },
      },
    },
  },
};

export async function buildMorningProposalContext(guildId: string) {
  const portfolio = await getPortfolioSnapshot(guildId);
  const symbols = portfolio.positions.map((position) => position.symbol);
  const newsDigest = await getMorningNewsDigest(symbols);

  return {
    portfolio,
    newsDigest,
  };
}

export async function generateMorningProposalIdeas(
  guildId: string,
): Promise<MorningProposalGenerationResult> {
  const context = await buildMorningProposalContext(guildId);
  const openai = getOpenAIClient();

  if (!openai) {
    return {
      ...context,
      proposals: [],
      skippedReason: "Missing OPENAI_API_KEY.",
    };
  }

  const response = await openai.responses.create({
    model: env.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content:
          "You create simulated stock proposals for a Discord investment club. Focus on the provided portfolio and recent news. Only return BUY proposals. Keep each reasoning to 3 lines or less. Return only structured output.",
      },
      {
        role: "user",
        content: buildMorningPrompt(context),
      },
    ],
    text: {
      format: morningProposalResponseFormat,
    },
  });

  if (!response.output_text) {
    return {
      ...context,
      proposals: [],
      skippedReason: "The model returned no parsed output.",
    };
  }

  try {
    const parsed = morningProposalSchema.parse(
      JSON.parse(response.output_text),
    );

    return {
      ...context,
      proposals: sanitizeMorningIdeas(parsed.proposals, context.portfolio.cash),
    };
  } catch {
    return {
      ...context,
      proposals: [],
      skippedReason: "The model returned invalid JSON.",
    };
  }
}

export async function runMorningProposalWorkflow(params: {
  client: Client<true>;
  guildId: string;
  channelId: string;
  proposerDiscordId: string;
  runKey: string;
}) {
  const ideas = await generateMorningProposalIdeas(params.guildId);

  if (ideas.proposals.length === 0) {
    return {
      ideas,
      created: [],
    };
  }

  const created = await postMorningProposals({
    client: params.client,
    guildId: params.guildId,
    channelId: params.channelId,
    proposerDiscordId: params.proposerDiscordId,
    runKey: params.runKey,
    ideas: ideas.proposals,
  });

  return {
    ideas,
    created,
  };
}

export async function postMorningProposals(params: {
  client: Client<true>;
  guildId: string;
  channelId: string;
  proposerDiscordId: string;
  runKey: string;
  ideas: MorningProposalIdea[];
}) {
  const created: Array<{ id: string; messageId: string; symbol: string }> = [];

  for (const [index, idea] of params.ideas.slice(0, 3).entries()) {
    const morningProposalKey = `morning-proposals:${params.runKey}:${index}`;

    const existing = await prisma.proposal.findUnique({
      where: { morningProposalKey },
    });

    if (existing?.discordMessageId) {
      continue;
    }

    const proposal = existing
      ? await prisma.proposal.update({
          where: { id: existing.id },
          data: {
            guildId: params.guildId,
            proposerDiscordId: params.proposerDiscordId,
            action: idea.action,
            symbol: idea.symbol,
            amount: idea.amount,
            reasoning: normalizeProposalReasoning(idea.reasoning) ?? null,
            morningProposalKey,
            closesAt: new Date(Date.now() + 2 * 60 * 1000),
          },
        })
      : await prisma.proposal.create({
          data: {
            guildId: params.guildId,
            proposerDiscordId: params.proposerDiscordId,
            action: idea.action,
            symbol: idea.symbol,
            amount: idea.amount,
            reasoning: normalizeProposalReasoning(idea.reasoning) ?? null,
            morningProposalKey,
            closesAt: new Date(Date.now() + 2 * 60 * 1000),
          },
        });

    const posted = await postProposalToChannel(
      params.client,
      {
        id: proposal.id,
        action: proposal.action,
        symbol: proposal.symbol,
        amount: proposal.amount,
        proposerDiscordId: proposal.proposerDiscordId,
        reasoning: proposal.reasoning,
        status: "OPEN",
        counts: emptyVoteCounts(),
      },
      params.channelId,
    );

    await prisma.proposal.update({
      where: { id: proposal.id },
      data: {
        discordChannelId: posted.channelId,
        discordMessageId: posted.messageId,
      },
    });

    created.push({
      id: proposal.id,
      messageId: posted.messageId,
      symbol: proposal.symbol,
    });
  }

  return created;
}

function buildMorningPrompt(
  context: Awaited<ReturnType<typeof buildMorningProposalContext>>,
) {
  const heldPositions =
    context.portfolio.positions.length === 0
      ? "None"
      : context.portfolio.positions
          .map((position) => {
            const current =
              position.currentPrice === null
                ? "N/A"
                : `$${position.currentPrice.toFixed(2)}`;
            const pnl =
              position.unrealizedPnl === null
                ? "N/A"
                : formatSignedUsd(position.unrealizedPnl);

            return `${position.symbol}: qty=${position.quantity.toFixed(4)}, avg=$${position.avgPrice.toFixed(2)}, now=${current}, unrealized=${pnl}`;
          })
          .join("\n");

  const generalNews =
    context.newsDigest.general.length === 0
      ? "None"
      : context.newsDigest.general
          .map((article) => {
            return `- [${article.source}] ${article.headline} :: ${trimText(article.summary ?? "", 180)}`;
          })
          .join("\n");

  const companyNews =
    Object.entries(context.newsDigest.companyNews).length === 0
      ? "None"
      : Object.entries(context.newsDigest.companyNews)
          .map(([symbol, articles]) => {
            return [
              `${symbol}:`,
              ...articles.map(
                (article) =>
                  `- ${article.headline} :: ${trimText(article.summary ?? "", 180)}`,
              ),
            ].join("\n");
          })
          .join("\n\n");

  return [
    "Portfolio snapshot:",
    `- Cash: $${context.portfolio.cash.toLocaleString()}`,
    `- Market value: $${context.portfolio.marketValue.toLocaleString()}`,
    `- Total value: $${context.portfolio.totalValue.toLocaleString()}`,
    `- Starting cash: $${context.portfolio.startingCash.toLocaleString()}`,
    "",
    "Held positions:",
    heldPositions,
    "",
    "Recent general market news:",
    generalNews,
    "",
    "Company news by held symbol:",
    companyNews,
    "",
    "Return JSON with 1 to 3 BUY proposals only.",
    "Each proposal must include symbol, action, amount, and a short reasoning no longer than 3 lines.",
    "Keep the amounts realistic and within the available cash.",
    "Use symbols that are relevant to the news and portfolio. Prefer symbols with clear news catalysts.",
    "Do not include markdown or extra commentary.",
  ].join("\n");
}

function sanitizeMorningIdeas(
  proposals: MorningProposalIdea[],
  availableCash: number,
) {
  let remainingCash = Math.max(0, availableCash);
  const normalized: MorningProposalIdea[] = [];

  for (const proposal of proposals.slice(0, 3)) {
    if (remainingCash <= 0) break;

    const symbol = proposal.symbol.trim().toUpperCase();
    const unclamped = Math.max(100, Math.round(proposal.amount / 100) * 100);
    const amount = Math.min(unclamped, remainingCash);

    if (!symbol || amount <= 0) continue;

    normalized.push({
      ...proposal,
      symbol,
      amount,
      reasoning:
        normalizeProposalReasoning(proposal.reasoning) ?? proposal.reasoning,
    });

    remainingCash -= amount;
  }

  return normalized;
}

function trimText(text: string, maxLength: number) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function formatSignedUsd(value: number) {
  const formatted = `$${Math.abs(value).toLocaleString()}`;
  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}
