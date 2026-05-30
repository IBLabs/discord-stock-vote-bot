import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import {
  buildProposalEmbed,
  buildVoteButtons,
  emptyVoteCounts,
  getVoteCounts,
  isVoteValue,
  type ProposalView,
} from "./proposals.js";
import {
  buildPortfolioEmbed,
  getPortfolioSnapshot,
} from "./services/portfolioService.js";
import { startCloseExpiredProposalsWorker } from "./workers/closeExpiredProposals.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Bot is ready as ${readyClient.user.tag}`);
  startCloseExpiredProposalsWorker(readyClient);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ping") {
        await interaction.reply({
          content: "pong",
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

        const closesAt = new Date(Date.now() + 2 * 60 * 1000);
        const proposal = await prisma.proposal.create({
          data: {
            guildId: interaction.guildId ?? env.DISCORD_GUILD_ID,
            proposerDiscordId: interaction.user.id,
            action,
            symbol,
            amount,
            closesAt,
          },
        });

        const proposalView: ProposalView = {
          id: proposal.id,
          action,
          symbol,
          amount,
          proposerDiscordId: interaction.user.id,
          status: "OPEN",
          counts: emptyVoteCounts(),
        };

        const embed = buildProposalEmbed(proposalView);
        const row = buildVoteButtons(proposal.id);

        const proposalsChannel = await client.channels.fetch(
          env.PROPOSALS_CHANNEL_ID,
        );

        if (
          !proposalsChannel ||
          proposalsChannel.type !== ChannelType.GuildText
        ) {
          await interaction.reply({
            content: "Could not find the proposals channel.",
            ephemeral: true,
          });

          return;
        }

        const message = await proposalsChannel.send({
          embeds: [embed],
          components: [row],
        });

        await prisma.proposal.update({
          where: { id: proposal.id },
          data: {
            discordChannelId: message.channelId,
            discordMessageId: message.id,
          },
        });

        await interaction.reply({
          content: `Proposal posted in <#${env.PROPOSALS_CHANNEL_ID}>`,
          ephemeral: true,
        });

        return;
      }

      if (interaction.commandName === "portfolio") {
        if (!interaction.guildId) {
          await interaction.reply({
            content: "This command can only be used in a server.",
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
    }

    if (interaction.isButton()) {
      const [kind, proposalId, voteRaw] = interaction.customId.split(":");

      if (kind !== "vote") return;

      if (!proposalId) {
        await interaction.reply({
          content: "Invalid vote.",
          ephemeral: true,
        });

        return;
      }

      if (!isVoteValue(voteRaw)) {
        await interaction.reply({
          content: "Invalid vote.",
          ephemeral: true,
        });

        return;
      }

      const proposal = await prisma.proposal.findUnique({
        where: { id: proposalId },
      });

      if (!proposal) {
        await interaction.reply({
          content: "Could not find this proposal. The bot may have restarted.",
          ephemeral: true,
        });

        return;
      }

      if (proposal.status !== "OPEN") {
        await interaction.reply({
          content: "Voting is closed for this proposal.",
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
        status: "OPEN",
        counts: await getVoteCounts(proposal.id),
      });

      await interaction.update({
        embeds: [updatedEmbed],
      });

      await interaction.followUp({
        content: `Recorded your vote: **${voteRaw}**`,
        ephemeral: true,
      });

      return;
    }
  } catch (error) {
    console.error("Interaction error:", error);

    if (interaction.isRepliable()) {
      const message = "Something went wrong.";

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: message,
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: message,
          ephemeral: true,
        });
      }
    }
  }
});

await client.login(env.DISCORD_TOKEN);
