-- Configurable per-project issue capacity.
--
-- Additive and nullable: every existing project keeps NULL, which means "no
-- limit" and is exactly how Prio behaved before this column existed. No
-- default is set, because any number would impose an invented cap on projects
-- that never had one.
ALTER TABLE "project" ADD COLUMN     "maxIssues" INTEGER;
