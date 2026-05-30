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
      message: `הביצוע דולג: הפעולה ${proposal.action.toUpperCase()} עדיין לא ממומשת.`,
    };
  }

  const symbol = proposal.symbol.toUpperCase();
  const price = await getCurrentPrice(symbol);
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
        message: `הביצוע נכשל: אין מספיק מזומן מדומה. זמין: $${portfolio.cash.toLocaleString()}.`,
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
      message: `בוצעה קנייה מדומה: ${quantity.toFixed(4)} ${symbol} במחיר $${price.toLocaleString()}.`,
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

  const positionViews = await Promise.all(
    positions.map(async (position) => {
      try {
        const currentPrice = await getCurrentPrice(position.symbol);
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
    }),
  );

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
      guildName
        ? `${guildName} תיק השקעות`
        : `תיק השקעות — ${snapshot.guildId}`,
    )
    .setDescription(
      [
        "תיק השקעות מדומה. אין עסקאות אמיתיות. לא ייעוץ פיננסי.",
        "",
        `מזומן: **${formatCurrency(snapshot.cash)}**`,
        `שווי שוק: **${formatCurrency(snapshot.marketValue)}**`,
        `שווי כולל: **${formatCurrency(snapshot.totalValue)}**`,
        `רווח/הפסד מול ההון ההתחלתי: **${formatSignedCurrency(gainLoss)}**`,
      ].join("\n"),
    )
    .addFields(
      {
        name: "פוזיציות",
        value:
          snapshot.positions.length === 0
            ? "אין פוזיציות פתוחות."
            : snapshot.positions
                .map((position) => {
                  const currentPriceText =
                    position.currentPrice === null
                      ? "לא זמין"
                      : formatCurrency(position.currentPrice);
                  const marketValueText =
                    position.marketValue === null
                      ? "לא זמין"
                      : formatCurrency(position.marketValue);
                  const pnlText =
                    position.unrealizedPnl === null
                      ? "לא זמין"
                      : formatSignedCurrency(position.unrealizedPnl);

                  return [
                    `**${position.symbol}**`,
                    `כמות: ${formatShares(position.quantity)} | ממוצע: ${formatCurrency(position.avgPrice)} | כעת: ${currentPriceText}`,
                    `שווי: ${marketValueText} | רווח/הפסד: ${pnlText}`,
                  ].join("\n");
                })
                .join("\n\n"),
      },
      {
        name: "עסקאות אחרונות",
        value:
          snapshot.transactions.length === 0
            ? "אין עדיין עסקאות."
            : snapshot.transactions
                .map((transaction) => {
                  return [
                    `**${transaction.action.toUpperCase()} ${transaction.symbol}**`,
                    `כמות: ${formatShares(transaction.quantity)} | מחיר: ${formatCurrency(transaction.price)} | סכום: ${formatCurrency(transaction.notional)}`,
                  ].join("\n");
                })
                .join("\n\n"),
      },
    );
}
