-- CreateTable
CREATE TABLE "SubmissionQueueItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'updated',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "contentHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimId" TEXT,
    "lastError" TEXT,
    "submissionId" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubmissionQueueItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SubmissionQueueItem_status_nextAttemptAt_idx" ON "SubmissionQueueItem"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SubmissionQueueItem_siteId_status_idx" ON "SubmissionQueueItem"("siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionQueueItem_siteId_url_channel_key" ON "SubmissionQueueItem"("siteId", "url", "channel");
