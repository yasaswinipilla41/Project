-- CreateEnum
CREATE TYPE "IssueLinkType" AS ENUM ('BLOCKS', 'IS_BLOCKED_BY', 'RELATES_TO', 'DUPLICATES', 'IS_DUPLICATED_BY');

-- CreateTable
CREATE TABLE "issue_link" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "type" "IssueLinkType" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "commentId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "issue_link_targetId_idx" ON "issue_link"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "issue_link_sourceId_targetId_type_key" ON "issue_link"("sourceId", "targetId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_storageKey_key" ON "attachment"("storageKey");

-- CreateIndex
CREATE INDEX "attachment_issueId_createdAt_idx" ON "attachment"("issueId", "createdAt");

-- CreateIndex
CREATE INDEX "attachment_commentId_idx" ON "attachment"("commentId");

-- CreateIndex
CREATE INDEX "attachment_uploadedById_idx" ON "attachment"("uploadedById");

-- AddForeignKey
ALTER TABLE "issue_link" ADD CONSTRAINT "issue_link_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_link" ADD CONSTRAINT "issue_link_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_link" ADD CONSTRAINT "issue_link_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
