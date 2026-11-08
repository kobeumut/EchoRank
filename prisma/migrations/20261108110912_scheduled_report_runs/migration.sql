-- AlterTable
ALTER TABLE "ScheduledReport" ADD COLUMN "claimId" TEXT;
ALTER TABLE "ScheduledReport" ADD COLUMN "claimedAt" DATETIME;
ALTER TABLE "ScheduledReport" ADD COLUMN "webhookUrl" TEXT;

-- CreateTable
CREATE TABLE "ReportRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "auditId" TEXT,
    "crawlSessionId" TEXT,
    "snapshot" JSONB,
    "steps" JSONB,
    "deliveries" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "ReportRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ReportRun_siteId_createdAt_idx" ON "ReportRun"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "ReportRun_scheduleId_status_idx" ON "ReportRun"("scheduleId", "status");
