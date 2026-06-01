import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import {
  buildProposalEmbed,
  getVoteCounts,
  isVoteValue,
} from "./proposals.js";
import {
  buildPortfolioEmbed,
  getPortfolioSnapshot,
} from "./services/portfolioService.js";
import { getPriceQuote } from "./services/priceService.js";
import { postProposalToChannel } from "./services/proposalService.js";
import { getProposalClosesAt } from "./services/proposalTiming.js";
import {
  buildMorningProposalSelectionButtons,
  buildMorningProposalSelectionEmbed,
  generateMorningProposalIdeas,
  postMorningProposals,
} from "./services/morningProposalService.js";
import {
  createSilentMorningProposalBatch,
  selectSilentMorningProposalBatchIdea,
} from "./services/morningSilentSelectionStore.js";
import {
  buildManualProposalApprovalButtons,
  buildManualProposalPreviewEmbed,
  buildManualProposalView,
  consumePendingManualProposal,
  createPendingManualProposal,
  discardPendingManualProposal,
  generateManualProposalIdea,
} from "./services/manualProposalService.js";
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
        if (!interaction.guildId) {
          await interaction.reply({
            content: "אפשר להשתמש בפקודה הזו רק בשרת.",
            ephemeral: true,
          });

          return;
        }

        if (
          !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
        ) {
          await interaction.reply({
            content: "רק אדמינים יכולים להשתמש בפקודה הזו.",
            ephemeral: true,
          });

          return;
        }

        const text = interaction.options.getString("text", true).trim();

        if (text.length === 0) {
          await interaction.reply({
            content: "צריך להזין טקסט להצעה.",
            ephemeral: true,
          });

          return;
        }

        await interaction.deferReply({ ephemeral: true });

        const generated = await generateManualProposalIdea(text);

        if (generated.status !== "created") {
          const message =
            generated.status === "missing_openai"
              ? "אי אפשר ליצור הצעה כרגע: חסר OPENAI_API_KEY."
              : generated.status === "missing_amount"
                ? "לא הצלחתי להבין מה סכום ההצעה או כמה יחידות לקנות."
                : generated.status === "missing_price"
                  ? `לא הצלחתי למצוא מחיר עבור **${generated.symbol}** כדי להמיר יחידות לסכום.`
                  : "לא הצלחתי להפוך את הטקסט להצעה תקינה.";

          await interaction.editReply(message);

          return;
        }

        const pending = createPendingManualProposal({
          guildId: interaction.guildId,
          channelId: env.PROPOSALS_CHANNEL_ID,
          requestedByDiscordId: interaction.user.id,
          idea: generated.idea,
        });

        await interaction.editReply({
          content: `לאשר פרסום ב- <#${env.PROPOSALS_CHANNEL_ID}>?`,
          embeds: [
            buildManualProposalPreviewEmbed({
              pendingId: pending.id,
              proposerDiscordId: interaction.user.id,
              idea: pending.idea,
            }),
          ],
          components: [buildManualProposalApprovalButtons(pending.id)],
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

        const silent = interaction.options.getBoolean("silent") ?? false;

        if (silent) {
          const ideas = await generateMorningProposalIdeas(interaction.guildId);

          if (ideas.proposals.length === 0) {
            await interaction.editReply(
              ideas.skippedReason
                ? `לא נוצרו הצעות חדשות. ${ideas.skippedReason}`
                : "לא נוצרו הצעות חדשות.",
            );

            return;
          }

          const batch = createSilentMorningProposalBatch({
            guildId: interaction.guildId,
            channelId: env.PROPOSALS_CHANNEL_ID,
            proposerDiscordId: client.user?.id ?? interaction.user.id,
            requestedByDiscordId: interaction.user.id,
            ideas: ideas.proposals,
          });

          await interaction.editReply({
            content: "בחר הצעה אחת לפרסום:",
            embeds: [buildMorningProposalSelectionEmbed(batch.ideas)],
            components: [
              buildMorningProposalSelectionButtons(
                batch.id,
                batch.ideas.length,
              ),
            ],
          });

          return;
        }

        const ideas = await generateMorningProposalIdeas(interaction.guildId);

        if (ideas.proposals.length === 0) {
          await interaction.editReply(
            ideas.skippedReason
              ? `לא נוצרו הצעות חדשות. ${ideas.skippedReason}`
              : "לא נוצרו הצעות חדשות.",
          );

          return;
        }

        const created = await postMorningProposals({
          client: client as Client<true>,
          guildId: interaction.guildId,
          channelId: env.PROPOSALS_CHANNEL_ID,
          proposerDiscordId: client.user?.id ?? interaction.user.id,
          runKey: `manual:${interaction.id}`,
          ideas: ideas.proposals,
          proposalLimit: 1,
        });

        const symbols = created.map((proposal) => proposal.symbol);

        await interaction.editReply(
          `נוצרו ופורסמו ${created.length} הצעות חדשות ב- <#${env.PROPOSALS_CHANNEL_ID}>: ${symbols.join(", ")}`,
        );

        return;
      }
    }

    if (interaction.isButton()) {
      const [kind, first, second] = interaction.customId.split(":");

      if (kind === "manual-proposal") {
        const pendingId = first;
        const decision = second;

        if (!pendingId || (decision !== "approve" && decision !== "discard")) {
          await interaction.reply({
            content: "אישור לא תקין.",
            ephemeral: true,
          });

          return;
        }

        if (decision === "discard") {
          const discardResult = discardPendingManualProposal({
            pendingId,
            requestedByDiscordId: interaction.user.id,
          });

          if (discardResult.status === "forbidden") {
            await interaction.reply({
              content: "רק מי שיצר את התצוגה המקדימה יכול לבטל אותה.",
              ephemeral: true,
            });

            return;
          }

          await interaction.update({
            content:
              discardResult.status === "discarded"
                ? "ההצעה בוטלה."
                : "התצוגה המקדימה הזו פגה או לא קיימת עוד.",
            embeds: [],
            components: [buildManualProposalApprovalButtons(pendingId, true)],
          });

          return;
        }

        const approvalResult = consumePendingManualProposal({
          pendingId,
          requestedByDiscordId: interaction.user.id,
        });

        if (approvalResult.status === "forbidden") {
          await interaction.reply({
            content: "רק מי שיצר את התצוגה המקדימה יכול לאשר אותה.",
            ephemeral: true,
          });

          return;
        }

        if (approvalResult.status === "missing") {
          await interaction.update({
            content: "התצוגה המקדימה הזו פגה או לא קיימת עוד.",
            embeds: [],
            components: [buildManualProposalApprovalButtons(pendingId, true)],
          });

          return;
        }

        await interaction.deferUpdate();

        const closesAt = getProposalClosesAt();
        const proposal = await prisma.proposal.create({
          data: {
            guildId: approvalResult.pending.guildId,
            proposerDiscordId: approvalResult.pending.requestedByDiscordId,
            action: approvalResult.pending.idea.action,
            symbol: approvalResult.pending.idea.symbol,
            amount: approvalResult.pending.idea.amount,
            reasoning: approvalResult.pending.idea.reasoning ?? null,
            closesAt,
          },
        });

        const posted = await postProposalToChannel(
          client as Client<true>,
          buildManualProposalView({
            id: proposal.id,
            proposerDiscordId: proposal.proposerDiscordId,
            idea: approvalResult.pending.idea,
            closesAt,
          }),
          approvalResult.pending.channelId,
        );

        await prisma.proposal.update({
          where: { id: proposal.id },
          data: {
            discordChannelId: posted.channelId,
            discordMessageId: posted.messageId,
          },
        });

        await interaction.editReply({
          content: `ההצעה פורסמה ב- <#${approvalResult.pending.channelId}>`,
          embeds: [],
          components: [buildManualProposalApprovalButtons(pendingId, true)],
        });

        return;
      }

      if (kind === "silent-morning") {
        const batchId = first;
        const selectedIndex = Number(second);

        if (!batchId || Number.isNaN(selectedIndex)) {
          await interaction.reply({
            content: "בחירה לא תקינה.",
            ephemeral: true,
          });

          return;
        }

        const selectionResult = selectSilentMorningProposalBatchIdea({
          batchId,
          requestedByDiscordId: interaction.user.id,
          selectedIndex,
        });

        if (selectionResult.status === "missing") {
          await interaction.reply({
            content: "הבחירה הזו פג תוקף או לא קיימת עוד.",
            ephemeral: true,
          });

          return;
        }

        if (selectionResult.status === "forbidden") {
          await interaction.reply({
            content: "רק מי שביקש את ההצעה יכול לבחור אותה.",
            ephemeral: true,
          });

          return;
        }

        if (
          selectionResult.status === "invalid_index" ||
          selectionResult.status === "already_selected"
        ) {
          await interaction.reply({
            content:
              selectionResult.status === "already_selected"
                ? "ההצעה הזו כבר נבחרה."
                : "בחירה לא תקינה.",
            ephemeral: true,
          });

          return;
        }

        await interaction.deferUpdate();

        const selectedIdea = selectionResult.batch.ideas[selectedIndex];

        if (!selectedIdea) {
          await interaction.editReply({
            content: "בחירה לא תקינה.",
            components: [
              buildMorningProposalSelectionButtons(
                selectionResult.batch.id,
                selectionResult.batch.ideas.length,
                true,
              ),
            ],
          });

          return;
        }

        const created = await postMorningProposals({
          client: client as Client<true>,
          guildId: selectionResult.batch.guildId,
          channelId: selectionResult.batch.channelId,
          proposerDiscordId: selectionResult.batch.proposerDiscordId,
          runKey: selectionResult.batch.id,
          ideas: [selectedIdea],
          proposalLimit: 1,
        });

        await interaction.editReply({
          content:
            created.length > 0
              ? `ההצעה שנבחרה נשלחה ל- <#${selectionResult.batch.channelId}>`
              : "לא הצלחנו לפרסם את ההצעה שנבחרה.",
          embeds: [],
          components: [
            buildMorningProposalSelectionButtons(
              selectionResult.batch.id,
              selectionResult.batch.ideas.length,
              true,
            ),
          ],
        });

        return;
      }

      const [proposalKind, proposalId, voteRaw] = [kind, first, second];

      if (proposalKind !== "vote") return;

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
