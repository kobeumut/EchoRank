-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "settings" JSONB,
    "targetKeywords" JSONB,
    "integrations" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CrawlSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "maxPages" INTEGER NOT NULL DEFAULT 500,
    "maxDepth" INTEGER NOT NULL DEFAULT 5,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrawlSession_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CrawledPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "crawlSessionId" TEXT,
    "url" TEXT NOT NULL,
    "statusCode" INTEGER,
    "pageType" TEXT,
    "title" TEXT,
    "metaDescription" TEXT,
    "canonical" TEXT,
    "h1" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB,
    "crawledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CrawledPage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrawledPage_crawlSessionId_fkey" FOREIGN KEY ("crawlSessionId") REFERENCES "CrawlSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GraphEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "crawlSessionId" TEXT,
    "key" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "properties" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GraphEntity_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GraphEntity_crawlSessionId_fkey" FOREIGN KEY ("crawlSessionId") REFERENCES "CrawlSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GraphRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "weight" REAL NOT NULL DEFAULT 1,
    "properties" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GraphRelation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GraphRelation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "GraphEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GraphRelation_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "GraphEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GeoAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "crawlSessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "geoScore" INTEGER,
    "seoScore" INTEGER,
    "eeatScore" INTEGER,
    "metrics" JSONB,
    "summary" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "GeoAudit_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GeoAudit_crawlSessionId_fkey" FOREIGN KEY ("crawlSessionId") REFERENCES "CrawlSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LlmVisibilityRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "citationStatus" TEXT NOT NULL,
    "position" INTEGER,
    "excerpt" TEXT,
    "responseMeta" JSONB,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LlmVisibilityRecord_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ActionItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "auditId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "targetUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    CONSTRAINT "ActionItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ActionItem_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "GeoAudit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScheduledReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "recipients" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScheduledReport_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlatformSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "urls" JSONB,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "response" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformSubmission_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Site_url_key" ON "Site"("url");

-- CreateIndex
CREATE INDEX "CrawlSession_siteId_createdAt_idx" ON "CrawlSession"("siteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrawledPage_siteId_url_key" ON "CrawledPage"("siteId", "url");

-- CreateIndex
CREATE INDEX "GraphEntity_siteId_entityType_idx" ON "GraphEntity"("siteId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "GraphEntity_siteId_key_key" ON "GraphEntity"("siteId", "key");

-- CreateIndex
CREATE INDEX "GraphRelation_siteId_idx" ON "GraphRelation"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphRelation_sourceId_targetId_relationType_key" ON "GraphRelation"("sourceId", "targetId", "relationType");

-- CreateIndex
CREATE INDEX "GeoAudit_siteId_createdAt_idx" ON "GeoAudit"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "LlmVisibilityRecord_siteId_model_checkedAt_idx" ON "LlmVisibilityRecord"("siteId", "model", "checkedAt");

-- CreateIndex
CREATE INDEX "ActionItem_siteId_status_idx" ON "ActionItem"("siteId", "status");

-- CreateIndex
CREATE INDEX "ScheduledReport_enabled_nextRunAt_idx" ON "ScheduledReport"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "PlatformSubmission_siteId_createdAt_idx" ON "PlatformSubmission"("siteId", "createdAt");
