-- CreateTable
CREATE TABLE "project_recent" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastVisitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_recent_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateIndex
CREATE INDEX "project_recent_userId_lastVisitedAt_idx" ON "project_recent"("userId", "lastVisitedAt");

-- AddForeignKey
ALTER TABLE "project_recent" ADD CONSTRAINT "project_recent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_recent" ADD CONSTRAINT "project_recent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
