-- CreateEnum
CREATE TYPE "TestResult" AS ENUM ('NOT_TESTED', 'PASSED', 'FAILED', 'BLOCKED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TEST_RESULT';

-- AlterTable
ALTER TABLE "issue" ADD COLUMN     "testResult" "TestResult" NOT NULL DEFAULT 'NOT_TESTED',
ADD COLUMN     "testedAt" TIMESTAMP(3),
ADD COLUMN     "testedById" TEXT;

-- CreateIndex
CREATE INDEX "issue_testResult_idx" ON "issue"("testResult");

-- AddForeignKey
ALTER TABLE "issue" ADD CONSTRAINT "issue_testedById_fkey" FOREIGN KEY ("testedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
