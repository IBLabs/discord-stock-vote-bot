import {
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { env } from "./env.js";

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the bot is alive")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("propose")
    .setDescription("Create a proposal preview from free text")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("text")
        .setDescription("Free text proposal, for example: buy 30 units of AAPL")
        .setRequired(true)
        .setMaxLength(1000),
    )
    .addBooleanOption((option) =>
      option
        .setName("analyze")
        .setDescription("Add an AI stock analysis to the proposal")
        .setRequired(false),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("portfolio")
    .setDescription("View the simulated portfolio")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("price")
    .setDescription("Get the current price for a stock symbol")
    .addStringOption((option) =>
      option
        .setName("symbol")
        .setDescription("Stock symbol, for example AAPL")
        .setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("morning-proposals")
    .setDescription("Generate and post morning proposals now")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption((option) =>
      option
        .setName("silent")
        .setDescription("Let me choose one proposal before posting")
        .setRequired(false),
    )
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

async function main() {
  console.log("Registering slash commands...");

  await rest.put(
    Routes.applicationGuildCommands(
      env.DISCORD_CLIENT_ID,
      env.DISCORD_GUILD_ID,
    ),
    { body: commands },
  );

  console.log("Slash commands registered.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
