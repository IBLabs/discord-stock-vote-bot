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
    .setDescription("Create a fake stock trade proposal")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Buy or sell")
        .setRequired(true)
        .addChoices(
          { name: "Buy", value: "buy" },
          { name: "Sell", value: "sell" },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("symbol")
        .setDescription("Stock symbol, for example AAPL")
        .setRequired(true),
    )
    .addNumberOption((option) =>
      option
        .setName("amount")
        .setDescription("Fake dollar amount, for example 5000")
        .setRequired(true)
        .setMinValue(1),
    )
    .addStringOption((option) =>
      option
        .setName("reasoning")
        .setDescription("Optional short reason for this proposal")
        .setRequired(false)
        .setMaxLength(300),
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
