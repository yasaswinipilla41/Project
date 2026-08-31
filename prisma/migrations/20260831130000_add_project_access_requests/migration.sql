-- Project access requests: a member asking an administrator to grant somebody
-- access to a project. Prio's membership model is a single binary and only an
-- administrator may change it, so the ask needs somewhere to live between
-- being made and being answered.
--
-- Entirely additive:
--   * one new enum type
--   * one new enum value on an existing type
--   * one new table
--   * one new NULLABLE column on "notification"
--
-- No table is dropped or renamed, no column is removed or retyped, and no
-- existing row is modified. Every existing notification keeps a NULL
-- "projectId", which is exactly what it means: not about a project.

CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TYPE "NotificationType" ADD VALUE 'PROJECT_ACCESS_REQUEST';

CREATE TABLE "project_access_request" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_access_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_access_request_projectId_status_idx" ON "project_access_request"("projectId", "status");
CREATE INDEX "project_access_request_subjectId_idx" ON "project_access_request"("subjectId");
CREATE INDEX "project_access_request_requesterId_idx" ON "project_access_request"("requesterId");

ALTER TABLE "project_access_request" ADD CONSTRAINT "project_access_request_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_access_request" ADD CONSTRAINT "project_access_request_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_access_request" ADD CONSTRAINT "project_access_request_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_access_request" ADD CONSTRAINT "project_access_request_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notification" ADD COLUMN "projectId" TEXT;
ALTER TABLE "notification" ADD CONSTRAINT "notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
