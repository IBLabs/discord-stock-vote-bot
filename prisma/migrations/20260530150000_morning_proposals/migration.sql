-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN "morningProposalKey" TEXT;
ALTER TABLE "Proposal" ADD COLUMN "reasoning" TEXT;

-- CreateTable
CREATE TABLE "ScheduledJobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobKey" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "error" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledJobRun_jobKey_runKey_key" ON "ScheduledJobRun"("jobKey", "runKey");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_morningProposalKey_key" ON "Proposal"("morningProposalKey");
