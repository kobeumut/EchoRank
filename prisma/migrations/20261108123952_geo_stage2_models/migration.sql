-- CreateTable
CREATE TABLE "AutoGeoSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "ruleId" TEXT,
    "title" TEXT,
    "originalSnippet" TEXT NOT NULL,
    "suggestedSnippet" TEXT NOT NULL,
    "diffMarkdown" TEXT,
    "expectedGain" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fingerprint" TEXT NOT NULL,
    "actionItemId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoGeoSuggestion_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompetitorAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "competitorDomain" TEXT NOT NULL,
    "competitorName" TEXT,
    "shareOfModel" REAL NOT NULL DEFAULT 0,
    "mentionShare" REAL,
    "citedQueriesCount" INTEGER NOT NULL DEFAULT 0,
    "gapQueriesCount" INTEGER NOT NULL DEFAULT 0,
    "topCitedUrls" JSONB,
    "sentimentScore" REAL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "windowDays" INTEGER NOT NULL DEFAULT 30,
    "lastCheckedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorAnalysis_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EntityEnrichment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "entityId" TEXT,
    "entityKey" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "wikidataId" TEXT,
    "wikipediaUrl" TEXT,
    "sameAsLinks" JSONB,
    "matchConfidence" REAL NOT NULL DEFAULT 0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EntityEnrichment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EntityEnrichment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "GraphEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotSimulationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "botName" TEXT NOT NULL,
    "statusCode" INTEGER,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedBy" TEXT,
    "isCsrShell" BOOLEAN NOT NULL DEFAULT false,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "loadTimeMs" INTEGER NOT NULL DEFAULT 0,
    "headers" JSONB,
    "diagnostics" JSONB,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotSimulationRecord_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyntheticQuery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'tr',
    "entityKey" TEXT,
    "entityName" TEXT,
    "difficulty" INTEGER NOT NULL DEFAULT 50,
    "source" TEXT NOT NULL DEFAULT 'template',
    "status" TEXT NOT NULL DEFAULT 'active',
    "fingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SyntheticQuery_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AutoGeoSuggestion_siteId_status_idx" ON "AutoGeoSuggestion"("siteId", "status");

-- CreateIndex
CREATE INDEX "AutoGeoSuggestion_siteId_pageUrl_idx" ON "AutoGeoSuggestion"("siteId", "pageUrl");

-- CreateIndex
CREATE UNIQUE INDEX "AutoGeoSuggestion_siteId_fingerprint_key" ON "AutoGeoSuggestion"("siteId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorAnalysis_siteId_competitorDomain_key" ON "CompetitorAnalysis"("siteId", "competitorDomain");

-- CreateIndex
CREATE UNIQUE INDEX "EntityEnrichment_entityId_key" ON "EntityEnrichment"("entityId");

-- CreateIndex
CREATE INDEX "EntityEnrichment_siteId_isVerified_idx" ON "EntityEnrichment"("siteId", "isVerified");

-- CreateIndex
CREATE UNIQUE INDEX "EntityEnrichment_siteId_entityKey_key" ON "EntityEnrichment"("siteId", "entityKey");

-- CreateIndex
CREATE INDEX "BotSimulationRecord_siteId_checkedAt_idx" ON "BotSimulationRecord"("siteId", "checkedAt");

-- CreateIndex
CREATE INDEX "BotSimulationRecord_siteId_runId_idx" ON "BotSimulationRecord"("siteId", "runId");

-- CreateIndex
CREATE INDEX "SyntheticQuery_siteId_intent_status_idx" ON "SyntheticQuery"("siteId", "intent", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SyntheticQuery_siteId_fingerprint_key" ON "SyntheticQuery"("siteId", "fingerprint");
