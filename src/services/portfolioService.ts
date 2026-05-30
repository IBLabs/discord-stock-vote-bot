import { EmbedBuilder } from "discord.js";
import { prisma } from "../db.js";
import { getCurrentPrice } from "./priceService.js";

const STARTING_CASH = 100_000;

export type ExecutionResult =
  | {
      executed: true;
      message: string;
    }
  | {
      executed: false;
      message: string;
    };

export type PortfolioPositionView = {
  symbol: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
};

export type PortfolioTransactionView = {
  id: string;
  action: string;
  symbol: string;
  quantity: number;
  price: number;
  notional: number;
  createdAt: Date;
};

export type PortfolioSnapshot = {
  guildId: string;
  cash: number;
  marketValue: number;
  totalValue: number;
  startingCash: number;
  positions: PortfolioPositionView[];
  transactions: PortfolioTransactionView[];
};

export async function executePassedProposal(proposal: {
  id: string;
  guildId: string;
  action: string;
  symbol: string;
  amount: number;
}): Promise<ExecutionResult> {
  if (proposal.action !== "buy") {
    return {
      executed: false,
      message: `Execution skipped: ${proposal.action.toUpperCase()} is not implemented yet.`,
    };
  }

  const symbol = proposal.symbol.toUpperCase();
  const price = getCurrentPrice(symbol);
  const quantity = proposal.amount / price;

  return prisma.$transaction(async (tx) => {
    const portfolio = await tx.portfolio.upsert({
      where: {
        guildId: proposal.guildId,
      },
      create: {
        guildId: proposal.guildId,
      },
      update: {},
    });

    if (portfolio.cash < proposal.amount) {
      return {
        executed: false as const,
        message: `Execution failed: insufficient fake cash. Available: $${portfolio.cash.toLocaleString()}.`,
      };
    }

    const existingPosition = await tx.position.findUnique({
      where: {
        portfolioId_symbol: {
          portfolioId: portfolio.id,
          symbol,
        },
      },
    });

    const nextQuantity = (existingPosition?.quantity ?? 0) + quantity;
    const nextAvgPrice = existingPosition
      ? (existingPosition.quantity * existingPosition.avgPrice +
          quantity * price) /
        nextQuantity
      : price;

    await tx.portfolio.update({
      where: {
        id: portfolio.id,
      },
      data: {
        cash: portfolio.cash - proposal.amount,
      },
    });

    await tx.position.upsert({
      where: {
        portfolioId_symbol: {
          portfolioId: portfolio.id,
          symbol,
        },
      },
      create: {
        portfolioId: portfolio.id,
        symbol,
        quantity,
        avgPrice: nextAvgPrice,
      },
      update: {
        quantity: nextQuantity,
        avgPrice: nextAvgPrice,
      },
    });

    await tx.transaction.create({
      data: {
        portfolioId: portfolio.id,
        proposalId: proposal.id,
        action: proposal.action,
        symbol,
        quantity,
        price,
        notional: proposal.amount,
      },
    });

    return {
      executed: true as const,
      message: `Executed fake BUY: ${quantity.toFixed(4)} ${symbol} at $${price.toLocaleString()}.`,
    };
  });
}

export async function getPortfolioSnapshot(
  guildId: string,
): Promise<PortfolioSnapshot> {
  const portfolio = await prisma.portfolio.upsert({
    where: {
      guildId,
    },
    create: {
      guildId,
    },
    update: {},
  });

  const positions = await prisma.position.findMany({
    where: {
      portfolioId: portfolio.id,
    },
    orderBy: {
      symbol: "asc",
    },
  });

  const positionViews = positions.map((position) => {
    try {
      const currentPrice = getCurrentPrice(position.symbol);
      const marketValue = position.quantity * currentPrice;

      return {
        symbol: position.symbol,
        quantity: position.quantity,
        avgPrice: position.avgPrice,
        currentPrice,
        marketValue,
        unrealizedPnl: marketValue - position.quantity * position.avgPrice,
      };
    } catch {
      return {
        symbol: position.symbol,
        quantity: position.quantity,
        avgPrice: position.avgPrice,
        currentPrice: null,
        marketValue: null,
        unrealizedPnl: null,
      };
    }
  });

  const marketValue = positionViews.reduce((total, position) => {
    return total + (position.marketValue ?? 0);
  }, 0);

  const transactions = await prisma.transaction.findMany({
    where: {
      portfolioId: portfolio.id,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 5,
  });

  return {
    guildId,
    cash: portfolio.cash,
    marketValue,
    totalValue: portfolio.cash + marketValue,
    startingCash: STARTING_CASH,
    positions: positionViews,
    transactions,
  };
}

function formatCurrency(value: number) {
  return `$${value.toLocaleString()}`;
}

function formatSignedCurrency(value: number) {
  const formatted = formatCurrency(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : formatted;
}

function formatShares(value: number) {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

export function buildPortfolioEmbed(
  snapshot: PortfolioSnapshot,
  guildName?: string,
) {
  const gainLoss = snapshot.totalValue - snapshot.startingCash;

  return new EmbedBuilder()
    .setTitle(
      guildName ? `${guildName} Portfolio` : `Portfolio — ${snapshot.guildId}`,
    )
    .setDescription(
      [
        "Simulated portfolio. No real trades. Not financial advice.",
        "",
        `Cash: **${formatCurrency(snapshot.cash)}**`,
        `Market value: **${formatCurrency(snapshot.marketValue)}**`,
        `Total value: **${formatCurrency(snapshot.totalValue)}**`,
        `P/L vs starting cash: **${formatSignedCurrency(gainLoss)}**`,
      ].join("\n"),
    )
    .addFields(
      {
        name: "Positions",
        value:
          snapshot.positions.length === 0
            ? "No open positions."
            : snapshot.positions
                .map((position) => {
                  const currentPriceText =
                    position.currentPrice === null
                      ? "N/A"
                      : formatCurrency(position.currentPrice);
                  const marketValueText =
                    position.marketValue === null
                      ? "N/A"
                      : formatCurrency(position.marketValue);
                  const pnlText =
                    position.unrealizedPnl === null
                      ? "N/A"
                      : formatSignedCurrency(position.unrealizedPnl);

                  return [
                    `**${position.symbol}**`,
                    `Qty: ${formatShares(position.quantity)} | Avg: ${formatCurrency(position.avgPrice)} | Now: ${currentPriceText}`,
                    `Value: ${marketValueText} | P/L: ${pnlText}`,
                  ].join("\n");
                })
                .join("\n\n"),
      },
      {
        name: "Recent Transactions",
        value:
          snapshot.transactions.length === 0
            ? "No transactions yet."
            : snapshot.transactions
                .map((transaction) => {
                  return [
                    `**${transaction.action.toUpperCase()} ${transaction.symbol}**`,
                    `Qty: ${formatShares(transaction.quantity)} | Price: ${formatCurrency(transaction.price)} | Notional: ${formatCurrency(transaction.notional)}`,
                  ].join("\n");
                })
                .join("\n\n"),
      },
    );
}
