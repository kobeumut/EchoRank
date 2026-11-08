-- AlterTable
ALTER TABLE "CrawlSession" ADD COLUMN "pagesTotal" INTEGER;
ALTER TABLE "CrawlSession" ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CrawlSession" ADD COLUMN "stage" TEXT;
