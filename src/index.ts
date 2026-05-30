import { Client, Events, GatewayIntentBits } from "discord.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import {
  buildProposalEmbed,
  emptyVoteCounts,
  getVoteCounts,
  isVoteValue,
  normalizeProposalReasoning,
  type ProposalView,
} from "./proposals.js";
import {
  buildPortfolioEmbed,
  getPortfolioSnapshot,
} from "./services/portfolioService.js";
import { getPriceQuote } from "./services/priceService.js";
import { postProposalToChannel } from "./services/proposalService.js";
import { runMorningProposalWorkflow } from "./services/morningProposalService.js";
import { startMorningProposalWorker } from "./workers/morningProposals.js";
import { startNightProposalWorker } from "./workers/nightProposals.js";
import { startCloseExpiredProposalsWorker } from "./workers/closeExpiredProposals.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Bot is ready as ${readyClient.user.tag}`);
  startCloseExpiredProposalsWorker(readyClient as Client<true>);
  startMorningProposalWorker(readyClient as Client<true>);
  startNightProposalWorker(readyClient as Client<true>);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ping") {
        await interaction.reply({
          content: "פונג",
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "propose") {
        const action = interaction.options.getString("action", true);
        const symbol = interaction.options
          .getString("symbol", true)
          .trim()
          .toUpperCase();
        const amount = interaction.options.getNumber("amount", true);
        const reasoning = normalizeProposalReasoning(
          interaction.options.getString("reasoning"),
        );

        const closesAt = new Date(Date.now() + 2 * 60 * 1000);
        const proposal = await prisma.proposal.create({
          data: {
            guildId: interaction.guildId ?? env.DISCORD_GUILD_ID,
            proposerDiscordId: interaction.user.id,
            action,
            symbol,
            amount,
            reasoning: reasoning ?? null,
            closesAt,
          },
        });

        const proposalView: ProposalView = {
          id: proposal.id,
          action,
          symbol,
          amount,
          proposerDiscordId: interaction.user.id,
          reasoning,
          closesAt,
          status: "OPEN",
          counts: emptyVoteCounts(),
        };

        const posted = await postProposalToChannel(
          client as Client<true>,
          proposalView,
          env.PROPOSALS_CHANNEL_ID,
        );

        await prisma.proposal.update({
          where: { id: proposal.id },
          data: {
            discordChannelId: posted.channelId,
            discordMessageId: posted.messageId,
          },
        });

        await interaction.reply({
          content: `ההצעה פורסמה ב- <#${env.PROPOSALS_CHANNEL_ID}>`,
          ephemeral: true,
        });

        return;
      }

      if (interaction.commandName === "portfolio") {
        if (!interaction.guildId) {
          await interaction.reply({
            content: "אפשר להשתמש בפקודה הזו רק בשרת.",
            ephemeral: true,
          });

          return;
        }

        const snapshot = await getPortfolioSnapshot(interaction.guildId);
        const embed = buildPortfolioEmbed(snapshot, interaction.guild?.name);

        await interaction.reply({
          embeds: [embed],
          ephemeral: true,
        });

        return;
      }

      if (interaction.commandName === "price") {
        const symbol = interaction.options
          .getString("symbol", true)
          .trim()
          .toUpperCase();

        await interaction.deferReply({ ephemeral: true });

        try {
          const quote = await getPriceQuote(symbol);
          const source = quote.source === "finnhub" ? "Finnhub" : "מחיר מדומה";
          const change =
            quote.change === null || quote.percentChange === null
              ? "לא זמין"
              : `${formatSignedCurrency(quote.change)} (${formatSignedPercent(
                  quote.percentChange,
                )})`;

          await interaction.editReply(
            [
              `מחיר עבור **${quote.symbol}**: **${formatCurrency(quote.price)}**`,
              `שינוי יומי: **${change}**`,
              `מקור: **${source}**`,
            ].join("\n"),
          );
        } catch {
          await interaction.editReply(
            `לא הצלחתי למצוא מחיר עבור **${symbol}**.`,
          );
        }

        return;
      }

      if (interaction.commandName === "morning-proposals") {
        if (!interaction.guildId) {
          await interaction.reply({
            content: "אפשר להשתמש בפקודה הזו רק בשרת.",
            ephemeral: true,
          });

          return;
        }

        await interaction.deferReply({ ephemeral: true });

        const result = await runMorningProposalWorkflow({
          client: client as Client<true>,
          guildId: interaction.guildId,
          channelId: env.PROPOSALS_CHANNEL_ID,
          proposerDiscordId: client.user?.id ?? interaction.user.id,
          runKey: `manual:${interaction.id}`,
          proposalLimit: 1,
        });

        if (result.ideas.proposals.length === 0) {
          await interaction.editReply(
            result.ideas.skippedReason
              ? `לא נוצרו הצעות חדשות. ${result.ideas.skippedReason}`
              : "לא נוצרו הצעות חדשות.",
          );

          return;
        }

        const symbols = result.created.map((proposal) => proposal.symbol);

        await interaction.editReply(
          `נוצרו ופורסמו ${result.created.length} הצעות חדשות ב- <#${env.PROPOSALS_CHANNEL_ID}>: ${symbols.join(", ")}`,
        );

        return;
      }
    }

    if (interaction.isButton()) {
      const [kind, proposalId, voteRaw] = interaction.customId.split(":");

      if (kind !== "vote") return;

      if (!proposalId) {
        await interaction.reply({
          content: "הצבעה לא תקינה.",
          ephemeral: true,
        });

        return;
      }

      if (!isVoteValue(voteRaw)) {
        await interaction.reply({
          content: "הצבעה לא תקינה.",
          ephemeral: true,
        });

        return;
      }

      const proposal = await prisma.proposal.findUnique({
        where: { id: proposalId },
      });

      if (!proposal) {
        await interaction.reply({
          content: "לא הצלחתי למצוא את ההצעה הזו. ייתכן שהבוט הופעל מחדש.",
          ephemeral: true,
        });

        return;
      }

      if (proposal.status !== "OPEN") {
        await interaction.reply({
          content: "ההצבעה להצעה הזו כבר נסגרה.",
          ephemeral: true,
        });

        return;
      }

      await prisma.vote.upsert({
        where: {
          proposalId_discordUserId: {
            proposalId,
            discordUserId: interaction.user.id,
          },
        },
        create: {
          proposalId,
          discordUserId: interaction.user.id,
          vote: voteRaw,
        },
        update: {
          vote: voteRaw,
        },
      });

      const updatedEmbed = buildProposalEmbed({
        id: proposal.id,
        action: proposal.action,
        symbol: proposal.symbol,
        amount: proposal.amount,
        proposerDiscordId: proposal.proposerDiscordId,
        reasoning: proposal.reasoning,
        closesAt: proposal.closesAt,
        status: "OPEN",
        counts: await getVoteCounts(proposal.id),
      });

      await interaction.update({
        embeds: [updatedEmbed],
      });

      await interaction.followUp({
        content: `הקול שלך נרשם: **${voteRaw === "yes" ? "בעד" : voteRaw === "no" ? "נגד" : "נמנע"}**`,
        ephemeral: true,
      });

      return;
    }
  } catch (error) {
    console.error("Interaction error:", error);

    if (interaction.isRepliable()) {
      const localizedMessage = "משהו השתבש.";

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: localizedMessage,
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: localizedMessage,
          ephemeral: true,
        });
      }
    }
  }
});

function formatCurrency(value: number) {
  return `$${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

function formatSignedCurrency(value: number) {
  const formatted = formatCurrency(Math.abs(value));
  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}

function formatSignedPercent(value: number) {
  const formatted = `${Math.abs(value).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`;

  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}

await client.login(env.DISCORD_TOKEN);
