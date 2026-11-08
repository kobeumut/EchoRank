-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "auditId" TEXT,
    "geoScore" INTEGER,
    "seoScore" INTEGER,
    "eeatScore" INTEGER,
    "visibilityRate" INTEGER,
    "citationRate" INTEGER,
    "citedCount" INTEGER NOT NULL DEFAULT 0,
    "mentionedCount" INTEGER NOT NULL DEFAULT 0,
    "totalChecks" INTEGER NOT NULL DEFAULT 0,
    "openActions" INTEGER NOT NULL DEFAULT 0,
    "criticalActions" INTEGER NOT NULL DEFAULT 0,
    "perModel" JSONB,
    "competitors" JSONB,
    "anomalies" JSONB,
    "alertedAt" DATETIME,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetricSnapshot_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReportDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'report',
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "subject" TEXT,
    "periodKey" TEXT,
    "error" TEXT,
    "response" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportDelivery_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReportDelivery_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ScheduledReport" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "job" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'running',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "summary" JSONB,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "JobLock" (
    "job" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ScheduledReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "recipients" JSONB,
    "webhooks" JSONB,
    "alerts" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScheduledReport_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ScheduledReport" ("createdAt", "enabled", "frequency", "id", "lastRunAt", "nextRunAt", "recipients", "siteId", "updatedAt") SELECT "createdAt", "enabled", "frequency", "id", "lastRunAt", "nextRunAt", "recipients", "siteId", "updatedAt" FROM "ScheduledReport";
DROP TABLE "ScheduledReport";
ALTER TABLE "new_ScheduledReport" RENAME TO "ScheduledReport";
CREATE INDEX "ScheduledReport_enabled_nextRunAt_idx" ON "ScheduledReport"("enabled", "nextRunAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "MetricSnapshot_siteId_kind_capturedAt_idx" ON "MetricSnapshot"("siteId", "kind", "capturedAt");

-- CreateIndex
CREATE INDEX "MetricSnapshot_siteId_capturedAt_idx" ON "MetricSnapshot"("siteId", "capturedAt");

-- CreateIndex
CREATE INDEX "ReportDelivery_siteId_createdAt_idx" ON "ReportDelivery"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "ReportDelivery_scheduleId_createdAt_idx" ON "ReportDelivery"("scheduleId", "createdAt");

-- CreateIndex
CREATE INDEX "JobRun_job_startedAt_idx" ON "JobRun"("job", "startedAt");
