-- CreateTable
CREATE TABLE "comment_reaction" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_reaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comment_reaction_commentId_idx" ON "comment_reaction"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "comment_reaction_commentId_userId_emoji_key" ON "comment_reaction"("commentId", "userId", "emoji");

-- AddForeignKey
ALTER TABLE "comment_reaction" ADD CONSTRAINT "comment_reaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_reaction" ADD CONSTRAINT "comment_reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
