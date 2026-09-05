-- Sprints: a fixed period during which one project's team works a chosen set
-- of its issues.
--
-- Almost entirely additive:
--   * one new enum
--   * two new tables
--   * one new nullable column on "issue", with an index
--   * no column dropped, renamed or retyped
--   * no existing row read, rewritten or deleted
--
-- Every existing issue keeps `sprintId` NULL, which is exactly "in the
-- project backlog, in no sprint" — the state every issue was already in
-- before sprints existed. Nothing moves and no view changes for a project
-- that never creates one.

CREATE TYPE "SprintStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED');

CREATE TABLE "sprint" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "SprintStatus" NOT NULL DEFAULT 'PLANNED',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sprint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sprint_projectId_status_idx" ON "sprint"("projectId", "status");
CREATE INDEX "sprint_projectId_startDate_idx" ON "sprint"("projectId", "startDate");

ALTER TABLE "sprint" ADD CONSTRAINT "sprint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sprint" ADD CONSTRAINT "sprint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What a sprint held when it was completed. Written only by `completeSprint`;
-- it is the sprint's permanent record, kept because completing a sprint moves
-- its unfinished work out of it.
CREATE TABLE "sprint_issue_outcome" (
    "id" TEXT NOT NULL,
    "sprintId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sprint_issue_outcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sprint_issue_outcome_sprintId_issueId_key" ON "sprint_issue_outcome"("sprintId", "issueId");
CREATE INDEX "sprint_issue_outcome_issueId_idx" ON "sprint_issue_outcome"("issueId");

ALTER TABLE "sprint_issue_outcome" ADD CONSTRAINT "sprint_issue_outcome_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "sprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sprint_issue_outcome" ADD CONSTRAINT "sprint_issue_outcome_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The issue's current sprint. Nullable, with no default and no backfill: NULL
-- means "in the backlog", which is where every existing issue already is.
-- ON DELETE SET NULL, so deleting a sprint returns its work to the backlog
-- rather than destroying it.
ALTER TABLE "issue" ADD COLUMN "sprintId" TEXT;

CREATE INDEX "issue_sprintId_idx" ON "issue"("sprintId");

ALTER TABLE "issue" ADD CONSTRAINT "issue_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "sprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
