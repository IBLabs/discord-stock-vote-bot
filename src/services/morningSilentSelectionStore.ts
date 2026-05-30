import { randomUUID } from "node:crypto";
import type { MorningProposalIdea } from "./morningProposalService.js";

const SILENT_BATCH_TTL_MS = 15 * 60 * 1000;

type SilentMorningProposalBatch = {
  id: string;
  guildId: string;
  channelId: string;
  proposerDiscordId: string;
  requestedByDiscordId: string;
  ideas: MorningProposalIdea[];
  createdAt: number;
  expiresAt: number;
  selectedIndex: number | null;
};

const silentMorningProposalBatches = new Map<
  string,
  SilentMorningProposalBatch
>();

export function createSilentMorningProposalBatch(params: {
  guildId: string;
  channelId: string;
  proposerDiscordId: string;
  requestedByDiscordId: string;
  ideas: MorningProposalIdea[];
}) {
  cleanupExpiredSilentMorningProposalBatches();

  const id = randomUUID();
  const now = Date.now();
  const batch: SilentMorningProposalBatch = {
    id,
    guildId: params.guildId,
    channelId: params.channelId,
    proposerDiscordId: params.proposerDiscordId,
    requestedByDiscordId: params.requestedByDiscordId,
    ideas: params.ideas,
    createdAt: now,
    expiresAt: now + SILENT_BATCH_TTL_MS,
    selectedIndex: null,
  };

  silentMorningProposalBatches.set(id, batch);

  return batch;
}

export function getSilentMorningProposalBatch(batchId: string) {
  cleanupExpiredSilentMorningProposalBatches();

  const batch = silentMorningProposalBatches.get(batchId);

  if (!batch) return undefined;

  if (batch.expiresAt <= Date.now()) {
    silentMorningProposalBatches.delete(batchId);
    return undefined;
  }

  return batch;
}

export function selectSilentMorningProposalBatchIdea(params: {
  batchId: string;
  requestedByDiscordId: string;
  selectedIndex: number;
}) {
  const batch = getSilentMorningProposalBatch(params.batchId);

  if (!batch) return { status: "missing" as const };

  if (batch.requestedByDiscordId !== params.requestedByDiscordId) {
    return { status: "forbidden" as const };
  }

  if (batch.selectedIndex !== null) {
    return { status: "already_selected" as const, batch };
  }

  if (params.selectedIndex < 0 || params.selectedIndex >= batch.ideas.length) {
    return { status: "invalid_index" as const, batch };
  }

  batch.selectedIndex = params.selectedIndex;
  silentMorningProposalBatches.set(batch.id, batch);

  return { status: "selected" as const, batch };
}

function cleanupExpiredSilentMorningProposalBatches() {
  const now = Date.now();

  for (const [batchId, batch] of silentMorningProposalBatches.entries()) {
    if (batch.expiresAt <= now) {
      silentMorningProposalBatches.delete(batchId);
    }
  }
}
