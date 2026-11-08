-- AlterTable
ALTER TABLE "ActionItem" ADD COLUMN "details" JSONB;
ALTER TABLE "ActionItem" ADD COLUMN "effort" TEXT;
ALTER TABLE "ActionItem" ADD COLUMN "priority" REAL;
ALTER TABLE "ActionItem" ADD COLUMN "ruleId" TEXT;

-- CreateIndex
CREATE INDEX "ActionItem_siteId_ruleId_idx" ON "ActionItem"("siteId", "ruleId");
