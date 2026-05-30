import type { Client } from "discord.js";
import { closeExpiredProposals } from "../services/proposalService.js";

const CLOSE_EXPIRED_PROPOSALS_INTERVAL_MS = 30_000;

let isClosingExpiredProposals = false;

export function startCloseExpiredProposalsWorker(
  client: Client<true>,
  intervalMs = CLOSE_EXPIRED_PROPOSALS_INTERVAL_MS,
) {
  const run = async () => {
    if (isClosingExpiredProposals) return;

    isClosingExpiredProposals = true;

    try {
      await closeExpiredProposals(client);
    } catch (error) {
      console.error("Failed to close expired proposals:", error);
    } finally {
      isClosingExpiredProposals = false;
    }
  };

  void run();

  return setInterval(() => {
    void run();
  }, intervalMs);
}
