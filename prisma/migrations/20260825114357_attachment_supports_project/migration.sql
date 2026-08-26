-- AlterTable
ALTER TABLE "attachment" ADD COLUMN     "projectId" TEXT,
ALTER COLUMN "issueId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "attachment_projectId_createdAt_idx" ON "attachment"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
