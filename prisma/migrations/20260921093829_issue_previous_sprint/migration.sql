-- AlterTable
ALTER TABLE "issue" ADD COLUMN     "previousSprintId" TEXT;

-- CreateIndex
CREATE INDEX "issue_previousSprintId_idx" ON "issue"("previousSprintId");
