-- What somebody is called on one project.
--
-- Additive and nullable: no existing row is read, written or moved, and every
-- membership that already exists reads as NULL — "whatever they are across
-- Prio", which is exactly what it was before this column existed.

-- CreateEnum
CREATE TYPE "ProjectDesignation" AS ENUM ('DEVELOPER', 'QA', 'FULLSTACK');

-- AlterTable
ALTER TABLE "project_member" ADD COLUMN "designation" "ProjectDesignation";
