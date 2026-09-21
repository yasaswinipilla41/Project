-- Effort, and how much of it is left.
--
-- Two nullable columns: every issue that already exists reads as "no estimate",
-- which is what it was. Nothing is read, written or moved by this migration.

-- AlterTable
ALTER TABLE "issue" ADD COLUMN "effortHours" DOUBLE PRECISION;
ALTER TABLE "issue" ADD COLUMN "remainingHours" DOUBLE PRECISION;
