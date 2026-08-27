-- CreateEnum
CREATE TYPE "SharePermission" AS ENUM ('VIEW');

-- CreateTable
CREATE TABLE "issue_sheet_share" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_sheet_share_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_sheet_share_member" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" "SharePermission" NOT NULL DEFAULT 'VIEW',
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_sheet_share_member_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "issue_sheet_share_token_key" ON "issue_sheet_share"("token");

-- CreateIndex
CREATE INDEX "issue_sheet_share_member_userId_idx" ON "issue_sheet_share_member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "issue_sheet_share_member_shareId_userId_key" ON "issue_sheet_share_member"("shareId", "userId");

-- AddForeignKey
ALTER TABLE "issue_sheet_share" ADD CONSTRAINT "issue_sheet_share_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_sheet_share_member" ADD CONSTRAINT "issue_sheet_share_member_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "issue_sheet_share"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_sheet_share_member" ADD CONSTRAINT "issue_sheet_share_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_sheet_share_member" ADD CONSTRAINT "issue_sheet_share_member_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
